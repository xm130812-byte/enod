//! md-reader Tauri 壳：拉起 Rust 内核，Windows 内嵌 WebView2，macOS/Linux 调 Chrome。
//! 托盘负责打开方式（应用窗口 / Chrome 标签页）与退出；概览在 P1 接入。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod prefs;

use prefs::OpenMode;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent, Wry};
#[cfg(target_os = "windows")]
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

struct CoreProcess(Mutex<Option<Child>>);
struct CoreUrl(Mutex<Option<String>>);
struct QuitState(AtomicBool);
struct TrayModeItems {
    window: CheckMenuItem<Wry>,
    browser: CheckMenuItem<Wry>,
}

fn debug_log(msg: &str) {
    if std::env::var("MD_READER_SHELL_DEBUG").is_err() {
        return;
    }
    use std::io::Write;
    let path = std::env::temp_dir().join("md-reader-shell.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

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
    // Windows：core 是 console 子系统，必须显式隐藏，否则会弹黑框。
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
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
    if cfg!(target_os = "windows") {
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(key) {
                out.push(
                    PathBuf::from(base)
                        .join("Google")
                        .join("Chrome")
                        .join("Application")
                        .join("chrome.exe"),
                );
            }
        }
    } else if cfg!(target_os = "macos") {
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
    out.into_iter().filter(|p| p.is_file()).collect()
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

fn open_browser(app: &AppHandle, url: &str) {
    if let Some(bin) = chrome_candidates().into_iter().next() {
        let _ = Command::new(bin).arg("--new-tab").arg(url).spawn();
        return;
    }
    // 没有 Chrome 时退回默认浏览器；不阻塞启动。
    if open_url(url).is_err() {
        app.dialog()
            .message("没有找到 Chrome / Chromium，也没有可用的默认浏览器。")
            .title("无法打开界面")
            .blocking_show();
    }
}

fn open_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
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

#[cfg(target_os = "windows")]
fn open_app_window(app: &AppHandle, url: &str) {
    debug_log("open_app_window");
    if let Some(window) = app.get_webview_window("reader") {
        debug_log("open_app_window: existing");
        let unmin = window.unminimize();
        let shown = window.show();
        let focused = window.set_focus();
        debug_log(&format!(
            "open_app_window: unminimize={unmin:?} show={shown:?} focus={focused:?}"
        ));
        let _ = window.navigate(url.parse().expect("core url"));
        return;
    }
    debug_log("open_app_window: create");
    let parsed = url.parse().expect("core url");
    let _ = WebviewWindowBuilder::new(app, "reader", WebviewUrl::External(parsed))
        .title("md-reader")
        .inner_size(1280.0, 860.0)
        .min_inner_size(880.0, 600.0)
        .build();
}

fn core_url(app: &AppHandle) -> Option<String> {
    app.state::<CoreUrl>()
        .0
        .lock()
        .unwrap()
        .clone()
        .filter(|u| !u.ends_with(":0"))
}

fn open_main(app: &AppHandle) {
    let Some(url) = core_url(app) else { return };
    let _mode = prefs::load_open_mode();
    debug_log(&format!("open_main mode={_mode:?} url={url}"));
    #[cfg(target_os = "windows")]
    {
        if _mode == OpenMode::Window {
            open_app_window(app, &url);
            return;
        }
    }
    open_browser(app, &url);
}

fn stop_core(app: &AppHandle) {
    if let Some(mut child) = app.state::<CoreProcess>().0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn request_quit(app: &AppHandle) {
    app.state::<QuitState>().0.store(true, Ordering::SeqCst);
    stop_core(app);
    app.exit(0);
}

fn set_mode(app: &AppHandle, mode: OpenMode) {
    if mode == OpenMode::Window && !cfg!(target_os = "windows") {
        return;
    }
    if let Err(err) = prefs::save_open_mode(mode) {
        eprintln!("[shell] 保存打开方式失败：{err}");
        return;
    }
    let items = app.state::<TrayModeItems>();
    let _ = items.window.set_checked(mode == OpenMode::Window);
    let _ = items.browser.set_checked(mode == OpenMode::Browser);
    match mode {
        OpenMode::Browser => {
            if let Some(url) = core_url(app) {
                open_browser(app, &url);
            }
            if let Some(window) = app.get_webview_window("reader") {
                let _ = window.hide();
            }
        }
        OpenMode::Window => {
            if let Some(window) = app.get_webview_window("reader") {
                let _ = window.show();
                let _ = window.set_focus();
            } else {
                open_main(app);
            }
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开界面", true, None::<&str>)?;
    let window_item = CheckMenuItem::with_id(
        app,
        "mode_window",
        "默认：应用窗口",
        cfg!(target_os = "windows"),
        prefs::load_open_mode() == OpenMode::Window,
        None::<&str>,
    )?;
    let browser_item = CheckMenuItem::with_id(
        app,
        "mode_browser",
        "默认：Chrome 标签页",
        true,
        prefs::load_open_mode() == OpenMode::Browser,
        None::<&str>,
    )?;
    let autostart = MenuItem::with_id(app, "autostart", "开机自启", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[&open, &sep1, &window_item, &browser_item, &sep2, &autostart, &quit],
    )?;
    app.manage(TrayModeItems {
        window: window_item,
        browser: browser_item,
    });
    TrayIconBuilder::new()
        .tooltip(format!(
            "md-reader · 默认打开方式：{}",
            prefs::load_open_mode().label()
        ))
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_main(app),
            "mode_window" => set_mode(app, OpenMode::Window),
            "mode_browser" => set_mode(app, OpenMode::Browser),
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
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            debug_log("single-instance callback");
            open_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreProcess(Mutex::new(None)))
        .manage(CoreUrl(Mutex::new(None)))
        .manage(QuitState(AtomicBool::new(false)))
        .on_window_event(|window, event| {
            if window.label() == "reader" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // 关窗只隐藏到托盘；只有托盘“退出”才真正结束应用。
                    api.prevent_close();
                    debug_log("close requested: hide");
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            match spawn_core(&handle) {
                Ok(url) => {
                    *handle.state::<CoreUrl>().0.lock().unwrap() = Some(url.clone());
                    build_tray(&handle)?;
                    open_main(&handle);
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
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                if !app.state::<QuitState>().0.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            RunEvent::Exit => stop_core(app),
            _ => {}
        });
}
