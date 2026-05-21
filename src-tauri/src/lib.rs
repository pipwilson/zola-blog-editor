use tauri_plugin_store::StoreExt;

#[tauri::command]
fn is_tauri() -> bool {
    true
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> serde_json::Value {
    let Ok(store) = app.store("config.json") else {
        return serde_json::json!({});
    };
    let get_str = |key: &str| -> String {
        store.get(key)
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default()
    };
    // support both "postsPath" (old JS key) and "posts_path" (serde snake_case)
    let posts_path = {
        let v = get_str("postsPath");
        if v.is_empty() { get_str("posts_path") } else { v }
    };
    serde_json::json!({
        "token":     get_str("token"),
        "repo":      get_str("repo"),
        "branch":    get_str("branch"),
        "postsPath": posts_path,
    })
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
    store.set("token",     token);
    store.set("repo",      repo);
    store.set("branch",    branch);
    store.set("postsPath", posts_path);
    store.save().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![is_tauri, load_config, save_config])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
