use base64::{engine::general_purpose, Engine as _};
use std::{fs, path::Path};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_pdf_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
