use std::process::{Child, Command};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::net::TcpStream;
use std::io::{Read, Write};
use tauri::Manager;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder};
use tauri::menu::{Menu, MenuItem};

fn start_server(server_dir: &std::path::Path) -> Result<Child, String> {
    for attempt in 1..=3 {
        let result = {
            #[cfg(windows)]
            {
                Command::new("node")
                    .args(["server.js", "--no-open"])
                    .current_dir(server_dir)
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .spawn()
            }
            #[cfg(not(windows))]
            {
                Command::new("node")
                    .args(["server.js", "--no-open"])
                    .current_dir(server_dir)
                    .spawn()
            }
        };
        match result {
            Ok(child) => return Ok(child),
            Err(e) if attempt < 3 => {
                eprintln!("Server start attempt {}/3 failed: {}", attempt, e);
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(e) => return Err(format!("Failed to start server after 3 attempts: {}", e)),
        }
    }
    unreachable!()
}

fn server_request(port: u16, method: &str, path: &str) -> Option<String> {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port)).ok()?;
    let timeout = Some(std::time::Duration::from_secs(3));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let request = format!("{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", method, path, port);
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}

fn server_matches_version(port: u16, version: &str) -> bool {
    server_request(port, "GET", "/api/health")
        .map(|response| response.starts_with("HTTP/1.1 200") && response.contains("\"status\":\"ok\"") && response.contains(&format!("\"version\":\"{}\"", version)))
        .unwrap_or(false)
}

fn wait_for_server(port: u16, version: &str, timeout_ms: u64) -> bool {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);
    while start.elapsed() < timeout {
        if server_matches_version(port, version) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    false
}

fn request_server_shutdown(port: u16) -> bool {
    server_request(port, "POST", "/api/system/shutdown")
        .map(|response| response.starts_with("HTTP/1.1 202"))
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server_dir = if cfg!(debug_assertions) {
        std::env::current_dir().unwrap().parent().unwrap().to_path_buf()
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| std::env::current_dir().unwrap())
    };

    let version = env!("CARGO_PKG_VERSION");
    let _server_process = if server_matches_version(3848, version) {
        None
    } else {
        if TcpStream::connect("127.0.0.1:3848").is_ok() {
            panic!("Port 3848 is owned by a different or outdated service. Stop it safely before starting Praetorium.");
        }
        let child = start_server(&server_dir)
            .expect("Failed to start node server. Is Node.js installed?");
        if !wait_for_server(3848, version, 8000) {
            panic!("Praetorium server did not report the packaged version within 8 seconds");
        }
        Some(child)
    };

    tauri::Builder::default()
        .setup(|app| {
            // System tray
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Praetorium", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut builder = TrayIconBuilder::new()
                .tooltip("Praetorium")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            if request_server_shutdown(3848) {
                                app.exit(0);
                            } else if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }

            builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Minimize to tray instead of closing
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
