mod server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Bind before creating the window so the server is already accepting
            // connections when the webview makes its first request.
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("failed to bind port");
            listener.set_nonblocking(true).expect("failed to set non-blocking");
            let port = listener.local_addr().expect("failed to get local addr").port();

            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("failed to adopt listener");
                server::start_server(listener).await;
            });

            // Open the main window directly on the local server instead of loading the
            // bundled assets and navigating away afterwards (unreliable on WebView2).
            let url = format!("http://127.0.0.1:{}", port).parse().unwrap();
            let builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url));
            #[cfg(desktop)]
            let builder = builder.title("YouTube GIF Maker").inner_size(800.0, 600.0).resizable(true);
            builder.build()?;

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
