use if_addrs::{get_if_addrs, IfAddr};
use std::{
    net::{Ipv4Addr, SocketAddrV4},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{State, WebviewWindow};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const VIEW_HTML: &[u8] = include_bytes!("../lan_view/index.html");
const VIEW_CSS: &[u8] = include_bytes!("../lan_view/view.css");
const VIEW_JS: &[u8] = include_bytes!("../lan_view/view.js");
const LOGO_PNG: &[u8] = include_bytes!("../../src/assets/sitzungsbuddy-logo-original.png");
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
pub struct LanViewManager {
    active: Mutex<Option<ActiveLanView>>,
}

struct ActiveLanView {
    url: String,
    shutdown: Arc<AtomicBool>,
    worker: JoinHandle<()>,
    snapshot: Arc<RwLock<Vec<u8>>>,
}

impl LanViewManager {
    fn start(&self) -> Result<String, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "LAN-Freigabe konnte nicht gestartet werden.".to_string())?;

        if let Some(existing) = active.as_ref() {
            return Ok(existing.url.clone());
        }

        let lan_ip = select_lan_address()?;
        let server = Server::http(SocketAddrV4::new(lan_ip, 0))
            .map_err(|error| format!("LAN-Freigabe konnte nicht gestartet werden: {error}"))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| "LAN-Port konnte nicht ermittelt werden.".to_string())?
            .port();

        let mut token_bytes = [0u8; 32];
        getrandom::fill(&mut token_bytes)
            .map_err(|_| "Zugangslink konnte nicht sicher erzeugt werden.".to_string())?;
        let token = token_bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let url = format!("http://{lan_ip}:{port}/{token}/");
        let shutdown = Arc::new(AtomicBool::new(false));
        let snapshot = Arc::new(RwLock::new(b"{}".to_vec()));
        let worker_shutdown = Arc::clone(&shutdown);
        let worker_snapshot = Arc::clone(&snapshot);

        let worker = thread::Builder::new()
            .name("sitzungsbuddy-lan-view".to_string())
            .spawn(move || {
                while !worker_shutdown.load(Ordering::Acquire) {
                    match server.recv_timeout(Duration::from_millis(200)) {
                        Ok(Some(request)) => {
                            if worker_shutdown.load(Ordering::Acquire) {
                                let _ = request.respond(Response::empty(StatusCode(404)));
                                break;
                            }
                            serve_request(request, &token, &worker_snapshot);
                        }
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
            })
            .map_err(|_| "LAN-Freigabe konnte nicht gestartet werden.".to_string())?;

        *active = Some(ActiveLanView {
            url: url.clone(),
            shutdown,
            worker,
            snapshot,
        });
        Ok(url)
    }

    pub fn stop(&self) -> Result<(), String> {
        let running = self
            .active
            .lock()
            .map_err(|_| "LAN-Freigabe konnte nicht beendet werden.".to_string())?
            .take();

        if let Some(running) = running {
            running.shutdown.store(true, Ordering::Release);
        }

        Ok(())
    }

    fn update(&self, snapshot: serde_json::Value) -> Result<(), String> {
        let bytes = serde_json::to_vec(&snapshot)
            .map_err(|_| "LAN-Daten konnten nicht verarbeitet werden.".to_string())?;
        if bytes.len() > MAX_SNAPSHOT_BYTES {
            return Err("Agenda ist für die LAN-Ansicht zu groß.".to_string());
        }

        let active = self
            .active
            .lock()
            .map_err(|_| "LAN-Freigabe ist nicht verfügbar.".to_string())?;
        let running = active
            .as_ref()
            .ok_or_else(|| "LAN-Freigabe ist nicht aktiv.".to_string())?;
        if running.worker.is_finished() {
            return Err(
                "LAN-Dienst wurde unerwartet beendet. Bitte Freigabe neu starten.".to_string(),
            );
        }
        *running
            .snapshot
            .write()
            .map_err(|_| "LAN-Daten konnten nicht aktualisiert werden.".to_string())? = bytes;
        Ok(())
    }

    fn copy_link(&self) -> Result<(), String> {
        let url = self
            .active
            .lock()
            .map_err(|_| "LAN-Link ist nicht verfügbar.".to_string())?
            .as_ref()
            .ok_or_else(|| "LAN-Freigabe ist nicht aktiv.".to_string())?
            .url
            .clone();
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|_| "Zwischenablage konnte nicht geöffnet werden.".to_string())?;
        clipboard
            .set_text(url)
            .map_err(|_| "LAN-Link konnte nicht kopiert werden.".to_string())
    }
}

fn select_lan_address() -> Result<Ipv4Addr, String> {
    get_if_addrs()
        .map_err(|_| "Netzwerkadressen konnten nicht gelesen werden.".to_string())?
        .into_iter()
        .filter_map(|interface| {
            let IfAddr::V4(address) = interface.addr else {
                return None;
            };
            if !address.ip.is_private() {
                return None;
            }

            let name = interface.name.to_lowercase();
            let preference = if name.contains("wi-fi") || name.contains("wlan") || name == "en0" {
                3
            } else if name.starts_with("en") || name.contains("ethernet") {
                2
            } else if name.starts_with("utun") || name.starts_with("tun") || name.contains("vpn") {
                0
            } else {
                1
            };
            Some((preference, address.ip))
        })
        .max_by_key(|(preference, _)| *preference)
        .map(|(_, address)| address)
        .ok_or_else(|| {
            "Keine private IPv4-Adresse gefunden. Bitte WLAN oder Firmennetz prüfen.".to_string()
        })
}

fn serve_request(request: Request, token: &str, snapshot: &Arc<RwLock<Vec<u8>>>) {
    let prefix = format!("/{token}/");
    let url = request.url();
    let permitted_path = url == prefix
        || url == format!("{prefix}view.css")
        || url == format!("{prefix}view.js")
        || url == format!("{prefix}logo.png")
        || url == format!("{prefix}state");
    let (status, mime, body): (u16, &str, Vec<u8>) = if !permitted_path {
        (404, "text/plain; charset=utf-8", b"Nicht gefunden".to_vec())
    } else if request.method() != &Method::Get {
        (
            405,
            "text/plain; charset=utf-8",
            b"Nicht verfuegbar".to_vec(),
        )
    } else if url == prefix {
        (200, "text/html; charset=utf-8", VIEW_HTML.to_vec())
    } else if url == format!("{prefix}view.css") {
        (200, "text/css; charset=utf-8", VIEW_CSS.to_vec())
    } else if url == format!("{prefix}view.js") {
        (200, "text/javascript; charset=utf-8", VIEW_JS.to_vec())
    } else if url == format!("{prefix}logo.png") {
        (200, "image/png", LOGO_PNG.to_vec())
    } else {
        (
            200,
            "application/json; charset=utf-8",
            snapshot
                .read()
                .map(|value| value.clone())
                .unwrap_or_default(),
        )
    };

    let mut response = Response::from_data(body).with_status_code(StatusCode(status));
    for (name, value) in [
        ("Content-Type", mime),
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "no-referrer"),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Frame-Options", "DENY"),
        (
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        ),
    ] {
        response.add_header(Header::from_bytes(name, value).expect("fester HTTP-Header"));
    }
    let _ = request.respond(response);
}

fn require_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("LAN-Freigabe ist nur im Hauptfenster verfügbar.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn start_lan_view(
    window: WebviewWindow,
    manager: State<'_, LanViewManager>,
) -> Result<String, String> {
    require_main_window(&window)?;
    manager.start()
}

#[tauri::command]
pub fn stop_lan_view(
    window: WebviewWindow,
    manager: State<'_, LanViewManager>,
) -> Result<(), String> {
    require_main_window(&window)?;
    manager.stop()
}

#[tauri::command]
pub fn update_lan_view(
    window: WebviewWindow,
    manager: State<'_, LanViewManager>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    require_main_window(&window)?;
    manager.update(snapshot)
}

#[tauri::command]
pub fn copy_lan_view_link(
    window: WebviewWindow,
    manager: State<'_, LanViewManager>,
) -> Result<(), String> {
    require_main_window(&window)?;
    manager.copy_link()
}
