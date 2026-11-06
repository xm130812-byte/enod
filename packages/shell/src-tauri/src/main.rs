//! md-reader Tauri 壳：拉起 Rust 内核，Windows 内嵌 WebView2，macOS/Linux 调 Chrome。
//! 只负责托盘 / 单实例 / 自启 / 更新检查；不做任何界面逻辑（PRD §3.2）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};
#[cfg(target_os = "windows")]
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

struct CoreProcess(Mutex<Option<Child>>);
struct CoreUrl(Mutex<Option<String>>);

fn core_binary_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["md-reader-core", "md-reader-core.exe"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        for name in ["md-reader-core", "md-reader-core.exe"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("找不到 md-reader-core（应与壳一起安装）".into())
}

fn spawn_core(app: &AppHandle) -> Result<String, String> {
    let bin = core_binary_path(app)?;
    let mut command = Command::new(&bin);
    command.arg("--no-open");
    // 打包后 web 资源在 resource_dir/web；本地开发退回 core 自己的探测。
    if let Ok(resource_dir) = app.path().resource_dir() {
        let web = resource_dir.join("web");
        if web.join("index.html").is_file() {
            command.env("READER_WEB_DIST", &web);
        }
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("启动内核失败：{e}"))?;
    let stdout = child.stdout.take().ok_or("内核没有 stdout")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line.clone()).is_err() {
                eprintln!("[core] {line}");
                continue;
            }
        }
    });
    let url = {
        let deadline = std::time::Instant::now() + Duration::from_secs(25);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break None;
            }
            match rx.recv_timeout(remaining) {
                Ok(line) => {
                    if std::env::var("MD_READER_SHELL_DEBUG").is_ok() {
                        eprintln!("[core] {line:?}");
                    }
                    if let Some(url) = extract_url(&line) {
                        break Some(url);
                    }
                }
                Err(_) => break None,
            }
        }
    }
    .ok_or("内核启动超时（25s）")?;
    *app.state::<CoreProcess>().0.lock().unwrap() = Some(child);
    Ok(url)
}

fn extract_url(line: &str) -> Option<String> {
    const PREFIX: &str = "http://127.0.0.1:";
    let idx = line.find(PREFIX)?;
    let after = &line[idx + PREFIX.len()..];
    let port: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    if port.is_empty() {
        return None;
    }
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}"))
}

fn chrome_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(target_os = "macos") {
        out.push(PathBuf::from(
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ));
        if let Some(home) = std::env::var_os("HOME") {
            out.push(
                PathBuf::from(home)
                    .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            );
        }
    } else {
        for name in [
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ] {
            if let Ok(path) = which(name) {
                out.push(path);
            }
        }
    }
    out
}

fn which(name: &str) -> Result<PathBuf, ()> {
    let path = std::env::var_os("PATH").ok_or(())?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

fn open_in_chrome(app: &AppHandle, url: &str) {
    let chrome = chrome_candidates().into_iter().next();
    match chrome {
        Some(bin) => {
            let _ = Command::new(bin)
                .arg(format!("--app={url}"))
                .arg("--new-window")
                .spawn();
        }
        None => {
            app.dialog()
                .message("md-reader 的界面只承诺 Chromium 内核。请先安装 Chrome 或 Chromium，再重新打开。")
                .title("需要 Chrome / Chromium")
                .blocking_show();
            let _ = open_url("https://www.google.com/chrome/");
        }
    }
}

fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd").args(["/C", "start", "", url]).spawn().map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(url).spawn().map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(url).spawn().map(|_| ())
    }
}

fn open_ui(app: &AppHandle) {
    let url = app
        .state::<CoreUrl>()
        .0
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "http://127.0.0.1:0".into());

    #[cfg(target_os = "windows")]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(url.parse().expect("core url"));
            let _ = window.set_focus();
            return;
        }
        let parsed = url.parse().expect("core url");
        let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
            .title("md-reader")
            .inner_size(1280.0, 860.0)
            .min_inner_size(880.0, 600.0)
            .build();
    }
    #[cfg(not(target_os = "windows"))]
    {
        open_in_chrome(app, &url);
    }
}

fn stop_core(app: &AppHandle) {
    if let Some(mut child) = app.state::<CoreProcess>().0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            open_ui(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreProcess(Mutex::new(None)))
        .manage(CoreUrl(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            match spawn_core(&handle) {
                Ok(url) => {
                    *handle.state::<CoreUrl>().0.lock().unwrap() = Some(url.clone());
                    build_tray(&handle)?;
                    open_ui(&handle);
                }
                Err(err) => {
                    handle
                        .dialog()
                        .message(err.clone())
                        .title("md-reader 启动失败")
                        .blocking_show();
                    return Err(err.into());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building md-reader shell")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_core(app);
            }
        });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开书库", true, None::<&str>)?;
    let reopen = MenuItem::with_id(app, "reopen", "重新打开界面", true, None::<&str>)?;
    let autostart = MenuItem::with_id(app, "autostart", "开机自启", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &reopen, &autostart, &quit])?;
    TrayIconBuilder::new()
        .tooltip("md-reader")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" | "reopen" => open_ui(app),
            "autostart" => {
                use tauri_plugin_autostart::ManagerExt;
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let _ = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
            }
            "quit" => {
                stop_core(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
