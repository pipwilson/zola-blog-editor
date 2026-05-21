use serde::{Deserialize, Serialize};
use tauri_plugin_store::StoreExt;

#[derive(Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub token: String,
    pub repo: String,
    pub branch: String,
    pub posts_path: String,
}

#[tauri::command]
fn is_tauri() -> bool {
    true
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> AppConfig {
    let Ok(store) = app.store("config.json") else {
        return AppConfig::default();
    };
    AppConfig {
        token: store.get("token")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        repo: store.get("repo")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        branch: store.get("branch")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        posts_path: store.get("posts_path")
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
    }
}

#[tauri::command]
fn save_config(
    app: tauri::AppHandle,
    token: String,
    repo: String,
    branch: String,
    posts_path: String,
) -> Result<(), String> {
    let store = app.store("config.json").map_err(|e| e.to_string())?;
    store.set("token", token);
    store.set("repo", repo);
    store.set("branch", branch);
    store.set("posts_path", posts_path);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![is_tauri, load_config, save_config])
        .setup(|app| {
            let _ = app.store("config.json");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
