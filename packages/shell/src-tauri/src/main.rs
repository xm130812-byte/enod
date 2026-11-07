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
use tauri::{WebviewUrl, WebviewWindowBuilder};use tauri_plugin_dialog::DialogExt;

struct CoreProcess(Mutex<Option<Child>>);
struct CoreUrl(Mutex<Option<String>>);
struct QuitState(AtomicBool);
#[allow(dead_code)]
struct OverviewState(Mutex<Option<std::time::Instant>>);
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

/// 在 overview 的 on_navigation 回调里直接建窗口会卡死 UI 线程；
/// 先让导航返回，再把动作排到主线程执行。
#[cfg(target_os = "windows")]
fn defer_action<F>(app: &AppHandle, action: F)
where
    F: FnOnce() + Send + 'static,
{
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        let _ = app.run_on_main_thread(action);
    });
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
        let nav = window.navigate(url.parse().expect("core url"));
        debug_log(&format!("open_app_window: navigate={nav:?}"));
        return;
    }
    debug_log("open_app_window: create");
    let parsed: tauri::Url = url.parse().expect("core url");
    let built = WebviewWindowBuilder::new(app, "reader", WebviewUrl::External(parsed.clone()))
        .title("enod")
        .inner_size(1280.0, 860.0)
        .min_inner_size(880.0, 600.0)
        .build();
    match built {
        Ok(window) => {
            debug_log("open_app_window: built");
            if let Err(err) = window.navigate(parsed) {
                debug_log(&format!("open_app_window: navigate error {err}"));
            }
        }
        Err(err) => debug_log(&format!("open_app_window: build error {err}")),
    }
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
    #[cfg(target_os = "windows")]
    if let Some(window) = app.get_webview_window("overview") {
        let _ = window.hide();
    }
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

/// 壳直接写 config.json 时 core 内存不会刷新；用 PATCH 让 core 同步。
fn sync_mode_to_core(app: &AppHandle, mode: OpenMode) {
    let Some(url) = core_url(app) else {
        return;
    };
    let Some(port) = url.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else {
        return;
    };
    let body = format!(r#"{{"shell":{{"openMode":"{}"}}}}"#, mode.as_str());
    let request = format!(
        "PATCH /api/v1/config HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nX-Reader-Client: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    use std::io::{Read, Write};
    let mut stream = match std::net::TcpStream::connect(("127.0.0.1", port)) {
        Ok(stream) => stream,
        Err(err) => {
            debug_log(&format!("sync_mode connect failed: {err}"));
            return;
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(request.as_bytes()).is_err() {
        return;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    debug_log(&format!(
        "sync_mode {mode:?}: {}",
        response.lines().next().unwrap_or("no response")
    ));
}

fn set_mode(app: &AppHandle, mode: OpenMode) {
    if mode == OpenMode::Window && !cfg!(target_os = "windows") {
        return;
    }
    if let Err(err) = prefs::save_open_mode(mode) {
        debug_log(&format!("set_mode {mode:?} save failed: {err}"));
        eprintln!("[shell] 保存打开方式失败：{err}");
        return;
    }
    debug_log(&format!(
        "set_mode {mode:?} saved, readback={:?}",
        prefs::load_open_mode()
    ));
    sync_mode_to_core(app, mode);
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
            #[cfg(target_os = "windows")]
            {
                if let Some(overview) = app.get_webview_window("overview") {
                    let _ = overview.hide();
                }
                if let Some(url) = core_url(app) {
                    if app.get_webview_window("reader").is_some() {
                        open_app_window(app, &url);
                    } else {
                        open_main(app);
                    }
                } else {
                    open_main(app);
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                open_main(app);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn overview_url(app: &AppHandle) -> Option<String> {
    core_url(app).map(|u| format!("{u}/tray.html?v=2"))
}

#[cfg(target_os = "windows")]
fn position_overview(app: &AppHandle, window: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size();
        let pos = monitor.position();
        let w = (360.0 * scale) as i32;
        let h = (620.0 * scale) as i32;
        let x = pos.x + size.width as i32 - w - (12.0 * scale) as i32;
        let y = pos.y + size.height as i32 - h - (52.0 * scale) as i32;
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

#[cfg(target_os = "windows")]
fn open_with_query(app: &AppHandle, query: &str) {
    let Some(base) = core_url(app) else {
        return;
    };
    let link = format!("{base}/{}", query.trim_start_matches('/'));
    if prefs::load_open_mode() == OpenMode::Window {
        open_main(app);
        if let Some(window) = app.get_webview_window("reader") {
            let _ = window.navigate(link.parse().expect("query url"));
            let _ = window.set_focus();
        }
    } else {
        if let Some(window) = app.get_webview_window("overview") {
            let _ = window.hide();
        }
        open_browser(app, &link);
    }
}

#[cfg(target_os = "windows")]
fn show_overview(app: &AppHandle) {
    let Some(url) = overview_url(app) else {
        return;
    };
    if let Some(window) = app.get_webview_window("overview") {
        position_overview(app, &window);
        *app.state::<OverviewState>().0.lock().unwrap() = None;
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let parsed = url.parse().expect("overview url");
    let nav_app = app.clone();
    let built = WebviewWindowBuilder::new(app, "overview", WebviewUrl::External(parsed))
        .title("enod 概览")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(360.0, 620.0)
        .visible(false)
        .on_navigation(move |target| {
            debug_log(&format!("overview nav: {}", target.as_str()));
            let path = target.path();
            if path == "/__shell/open" {
                let app = nav_app.clone();
                defer_action(&nav_app, move || open_main(&app));
                return false;
            }
            if let Some(mode) = path.strip_prefix("/__shell/mode/") {
                let target_mode = match mode {
                    "window" => Some(OpenMode::Window),
                    "browser" => Some(OpenMode::Browser),
                    _ => None,
                };
                if let Some(target_mode) = target_mode {
                    let app = nav_app.clone();
                    defer_action(&nav_app, move || set_mode(&app, target_mode));
                }
                return false;
            }
            if let Some(view) = path.strip_prefix("/__shell/view/") {
                if view == "simple" || view == "complex" {
                    let query = format!("?view={view}");
                    let app = nav_app.clone();
                    defer_action(&nav_app, move || open_with_query(&app, &query));
                }
                return false;
            }
            if path == "/__shell/search" {
                let app = nav_app.clone();
                defer_action(&nav_app, move || open_with_query(&app, "?focus=search"));
                return false;
            }
            if path == "/__shell/new" {
                let app = nav_app.clone();
                defer_action(&nav_app, move || open_with_query(&app, "?new=1"));
                return false;
            }
            if path == "/__shell/settings" {
                let app = nav_app.clone();
                defer_action(&nav_app, move || open_with_query(&app, "?settings=1"));
                return false;
            }
            if path == "/__shell/quit" {
                request_quit(&nav_app);
                return false;
            }
            if let Some(id) = path.strip_prefix("/__shell/doc/") {
                let id = id.to_string();
                let app = nav_app.clone();
                defer_action(&nav_app, move || {
                    if let Some(base) = core_url(&app) {
                        let link = format!("{base}/#/doc/{id}");
                        if prefs::load_open_mode() == OpenMode::Window {
                            open_main(&app);
                            if let Some(window) = app.get_webview_window("reader") {
                                let _ = window.navigate(link.parse().expect("doc url"));
                                let _ = window.set_focus();
                            }
                        } else {
                            if let Some(window) = app.get_webview_window("overview") {
                                let _ = window.hide();
                            }
                            open_browser(&app, &link);
                        }
                    }
                });
                return false;
            }
            true
        })
        .build();
    if let Ok(window) = built {
        let handle = window.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::Focused(false) => {
                *handle.state::<OverviewState>().0.lock().unwrap() = Some(std::time::Instant::now());
                let _ = handle.hide();
            }
            WindowEvent::CloseRequested { .. } => {
                debug_log("overview close requested");
            }
            _ => {}
        });
        position_overview(app, &window);
        *app.state::<OverviewState>().0.lock().unwrap() = None;
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "windows")]
fn toggle_overview(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("overview") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
        // 点击托盘时窗口会先因失焦隐藏；350ms 内的“再次点击”视为收起，不重新弹出。
        let hidden_at = *app.state::<OverviewState>().0.lock().unwrap();
        if let Some(at) = hidden_at {
            if at.elapsed() < Duration::from_millis(350) {
                *app.state::<OverviewState>().0.lock().unwrap() = None;
                return;
            }
        }
    }
    show_overview(app);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开界面", true, None::<&str>)?;
    let overview = MenuItem::with_id(app, "overview", "概览", cfg!(target_os = "windows"), None::<&str>)?;
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
        &[
            &open,
            &overview,
            &sep1,
            &window_item,
            &browser_item,
            &sep2,
            &autostart,
            &quit,
        ],
    )?;
    app.manage(TrayModeItems {
        window: window_item,
        browser: browser_item,
    });
    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
    TrayIconBuilder::new()
        .icon(tray_icon)
        .tooltip(format!(
            "enod · 默认打开方式：{}",
            prefs::load_open_mode().label()
        ))
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => open_main(app),
            "overview" => {
                #[cfg(target_os = "windows")]
                toggle_overview(app);
            }
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
                let app = tray.app_handle();
                #[cfg(target_os = "windows")]
                {
                    toggle_overview(app);
                    return;
                }
                #[cfg(not(target_os = "windows"))]
                {
                    open_main(app);
                }
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
        .manage(OverviewState(Mutex::new(None)))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                debug_log(&format!("close requested: {}", window.label()));
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            match spawn_core(&handle) {
                Ok(url) => {
                    *handle.state::<CoreUrl>().0.lock().unwrap() = Some(url.clone());
                    build_tray(&handle)?;
                    open_main(&handle);
                    #[cfg(target_os = "windows")]
                    if std::env::var("MD_READER_SHOW_OVERVIEW").is_ok() {
                        show_overview(&handle);
                    }
                }
                Err(err) => {
                    handle
                        .dialog()
                        .message(err.clone())
                        .title("enod 启动失败")
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
