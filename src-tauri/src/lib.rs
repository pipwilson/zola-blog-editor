use tauri_plugin_store::StoreExt;

// Expose a command so the frontend can ask if we're in Tauri
// (lets the same HTML work in a browser too, gracefully degrading)
#[tauri::command]
fn is_tauri() -> bool {
    true
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![is_tauri])
        .setup(|app| {
            // Pre-create the store so it's ready on first launch
            let _ = app.store("config.json");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
