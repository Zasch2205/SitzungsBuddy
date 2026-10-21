use base64::{engine::general_purpose, Engine as _};
use std::{fs, path::Path, sync::{LazyLock, Mutex}};
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg(target_os = "macos")]
use std::process::{Child, Command};

#[cfg(target_os = "macos")]
static CAFFEINATE_PROCESS: LazyLock<Mutex<Option<Child>>> = LazyLock::new(|| Mutex::new(None));

fn enable_sleep_blocker() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut process_guard = CAFFEINATE_PROCESS
            .lock()
            .map_err(|_| "Sleep-Blocker konnte nicht aktiviert werden.".to_string())?;

        if process_guard.is_some() {
            return Ok(());
        }

        let child = Command::new("caffeinate")
            .args(["-dims"])
            .spawn()
            .map_err(|_| "Sleep-Blocker konnte nicht gestartet werden.".to_string())?;

        *process_guard = Some(child);
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        };

        let result = unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)
        };

        if result == 0 {
            return Err("Sleep-Blocker konnte nicht aktiviert werden.".to_string());
        }

        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(())
    }
}

fn disable_sleep_blocker() {
    #[cfg(target_os = "macos")]
    {
        if let Ok(mut process_guard) = CAFFEINATE_PROCESS.lock() {
            if let Some(mut child) = process_guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};

        let _ = unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    }
}

fn close_beamer_windows(app_handle: &tauri::AppHandle) {
    for label in ["audience-view", "mirror-view"] {
        if let Some(window) = app_handle.get_webview_window(label) {
            let _ = window.close();
        }
    }
}

#[tauri::command]
fn save_pdf_file(path: String, base64_data: String) -> Result<(), String> {
    let target_path = Path::new(&path);
    let has_pdf_extension = target_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));

    if !has_pdf_extension {
        return Err("Bitte eine PDF-Datei als Ziel wählen.".to_string());
    }

    let pdf_bytes = general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|_| "PDF-Daten konnten nicht verarbeitet werden.".to_string())?;

    fs::write(target_path, pdf_bytes).map_err(|_| "PDF konnte nicht gespeichert werden.".to_string())
}

#[tauri::command]
fn set_on_air_mode(enabled: bool) -> Result<(), String> {
    if enabled {
        enable_sleep_blocker()
    } else {
        disable_sleep_blocker();
        Ok(())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                disable_sleep_blocker();
                close_beamer_windows(&window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![save_pdf_file, set_on_air_mode])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            disable_sleep_blocker();
            close_beamer_windows(app_handle);
        }
    });
}
