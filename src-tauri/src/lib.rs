use tauri::Manager;
mod server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Find a free port
            let port = get_port::tcp::get_port().unwrap_or(8765);
            
            // Start local Axum server
            tauri::async_runtime::spawn(async move {
                server::start_server(port).await;
            });

            // Point main window to the local server
            if let Some(window) = app.get_webview_window("main") {
                let url = format!("http://127.0.0.1:{}", port);
                window.navigate(url.parse().unwrap());
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
