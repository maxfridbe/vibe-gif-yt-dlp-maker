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

            let assets = app.asset_resolver();
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("failed to adopt listener");
                server::start_server(listener, assets).await;
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = _event {
                for u in urls {
                    let s = u.to_string();
                    log::info!("RunEvent::Opened received url: {}", s);
                    server::set_shared_url(s);
                }
            }
        });
}

#[cfg(target_os = "android")]
static ANDROID_VM: std::sync::OnceLock<jni::JavaVM> = std::sync::OnceLock::new();

#[cfg(target_os = "android")]
static ANDROID_ACTIVITY: std::sync::Mutex<Option<jni::objects::GlobalRef>> = std::sync::Mutex::new(None);

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_com_maxfridbe_youtubegifmaker_MainActivity_nativeRegisterActivity(
    env: jni::JNIEnv,
    _: jni::objects::JClass,
    activity: jni::objects::JObject,
) {
    if let Ok(vm) = env.get_java_vm() {
        let _ = ANDROID_VM.set(vm);
    }
    if let Ok(global) = env.new_global_ref(activity) {
        if let Ok(mut lock) = ANDROID_ACTIVITY.lock() {
            *lock = Some(global);
        }
    }
}

#[cfg(target_os = "android")]
pub fn share_file_android(path: &str, mime: &str, title: &str) -> bool {
    let Some(vm) = ANDROID_VM.get() else {
        return false;
    };
    let Ok(mut env) = vm.attach_current_thread() else {
        return false;
    };
    let act_opt = ANDROID_ACTIVITY.lock().ok().and_then(|g| g.clone());
    let Some(act) = act_opt else {
        return false;
    };
    let Ok(j_path) = env.new_string(path) else {
        return false;
    };
    let Ok(j_mime) = env.new_string(mime) else {
        return false;
    };
    let Ok(j_title) = env.new_string(title) else {
        return false;
    };
    let j_path_obj: jni::objects::JObject = j_path.into();
    let j_mime_obj: jni::objects::JObject = j_mime.into();
    let j_title_obj: jni::objects::JObject = j_title.into();
    match env.call_method(
        &act,
        "shareFileInternal",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Z",
        &[
            jni::objects::JValue::Object(&j_path_obj),
            jni::objects::JValue::Object(&j_mime_obj),
            jni::objects::JValue::Object(&j_title_obj),
        ],
    ) {
        Ok(val) => val.z().unwrap_or(false),
        Err(e) => {
            log::warn!("shareFileInternal JNI call failed: {}", e);
            let _ = env.exception_clear();
            false
        }
    }
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_com_maxfridbe_youtubegifmaker_MainActivity_nativeSetSharedUrl(
    mut env: jni::JNIEnv,
    _: jni::objects::JClass,
    url: jni::objects::JString,
) {
    if let Ok(url_str) = env.get_string(&url) {
        let s = url_str.to_string_lossy().to_string();
        server::set_shared_url(s);
    }
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_com_maxfridbe_youtubegifmaker_Rust_setSharedUrl(
    mut env: jni::JNIEnv,
    _: jni::objects::JClass,
    url: jni::objects::JString,
) {
    if let Ok(url_str) = env.get_string(&url) {
        let s = url_str.to_string_lossy().to_string();
        server::set_shared_url(s);
    }
}
