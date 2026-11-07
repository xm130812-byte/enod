//! md-reader-core 守护进程入口：随机粘性端口、单实例、静态托管与浏览器唤起。

use reader_core::config::{
    clear_run_info, new_instance_id, pid_alive, read_run_info, write_run_info, ConfigStore, RunInfo,
};
use reader_core::db::Db;
use reader_core::http::sse::EventHub;
use reader_core::http::{build_router, AppState};
use reader_core::library::{mark_started, LibraryService};
use reader_core::paths::{app_data_dir, data_paths, ensure_data_dirs};
use reader_core::version::VERSION;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn arg_value(args: &[String], name: &str) -> Option<String> {
    if let Some(idx) = args.iter().position(|a| a == name) {
        return args.get(idx + 1).cloned();
    }
    args.iter()
        .find(|a| a.starts_with(&format!("{name}=")))
        .map(|a| a[name.len() + 1..].to_string())
}

fn log(message: &str) {
    let now = chrono::Local::now().format("%H:%M:%S");
    println!("{now} {message}");
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let data_dir = arg_value(&args, "--data-dir")
        .map(PathBuf::from)
        .unwrap_or_else(app_data_dir);
    let paths = data_paths(data_dir);
    ensure_data_dirs(&paths)?;

    let no_open = args.iter().any(|a| a == "--no-open")
        || std::env::var("READER_NO_OPEN").map(|v| v == "1").unwrap_or(false);
    let config = Arc::new(ConfigStore::load(paths.clone()));
    let previous = read_run_info(&paths);

    if let Some(prev) = &previous {
        if prev.pid != std::process::id() && pid_alive(prev.pid) {
            if probe_health(prev.port, &prev.instance_id).await {
                log(&format!("md-reader 已在运行：{}", prev.url));
                if !no_open {
                    open_browser(&prev.url);
                }
                return Ok(());
            }
        }
    }

    let db = Db::open(paths.db_file.clone())?;
    let hub = EventHub::new();
    let service = LibraryService::new(paths.clone(), config.clone(), db.clone(), hub.clone());
    service.init().await?;
    log(&format!(
        "书库：{}",
        service.root_string().unwrap_or_else(|| "(未挂载)".into())
    ));

    let instance_id = new_instance_id();
    let desired_port = arg_value(&args, "--port")
        .or_else(|| std::env::var("READER_PORT").ok())
        .and_then(|v| v.parse::<u16>().ok())
        .or_else(|| previous.as_ref().map(|p| p.port))
        .unwrap_or(0);
    let host = arg_value(&args, "--host").unwrap_or_else(|| "127.0.0.1".into());
    let loopback = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
    let token = if loopback {
        arg_value(&args, "--token").or_else(|| std::env::var("READER_TOKEN").ok())
    } else {
        let token = arg_value(&args, "--token")
            .or_else(|| std::env::var("READER_TOKEN").ok())
            .unwrap_or_else(random_token);
        let _ = std::fs::write(&paths.token_file, &token);
        Some(token)
    };
    let listener = bind_with_fallback(&host, desired_port).await?;
    let port = listener.local_addr()?.port();

    let web_dist = resolve_web_dist();
    mark_started();
    let state = AppState {
        service: service.clone(),
        config: config.clone(),
        db,
        hub: hub.clone(),
        version: VERSION.to_string(),
        instance_id: instance_id.clone(),
        port,
        started_at: Instant::now(),
        started_at_ms: chrono::Utc::now().timestamp_millis(),
        web_dist: web_dist.clone(),
        dev: std::env::var("NODE_ENV").map(|v| v != "production").unwrap_or(true),
        token: token.clone(),
        read_only: !loopback,
    };
    let app = build_router(state);

    let url = format!("http://127.0.0.1:{port}");
    write_run_info(
        &paths,
        &RunInfo {
            pid: std::process::id(),
            port,
            instance_id: instance_id.clone(),
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            url: url.clone(),
            library_root: service.root_string(),
            version: VERSION.to_string(),
        },
    )?;

    log(&format!("md-reader {VERSION} 就绪：{url}"));
    if !loopback {
        if let Some(token) = &token {
            let display_host = if host == "0.0.0.0" {
                local_ip().unwrap_or_else(|| host.clone())
            } else {
                host.clone()
            };
            log(&format!(
                "移动端只读入口：http://{display_host}:{port}/?t={token}"
            ));
        }
    }
    log(&format!("数据目录：{}", paths.root.to_string_lossy()));
    if web_dist.is_none() {
        log("未找到 web/dist —— 请用 pnpm dev 或先 pnpm build");
    }
    if !no_open {
        open_browser(&url);
    }

    let shutdown = shutdown_signal();
    let server = axum::serve(listener, app).with_graceful_shutdown(shutdown);
    if let Err(err) = server.await {
        eprintln!("[serve] {err}");
    }
    clear_run_info(&paths, &instance_id);
    service.shutdown();
    Ok(())
}

fn random_token() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn local_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

async fn probe_health(port: u16, instance_id: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(900))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let url = format!("http://127.0.0.1:{port}/api/v1/health");
    match client.get(url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let text = resp.text().await.unwrap_or_default();
            let body: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            body.get("instanceId").and_then(|v| v.as_str()) == Some(instance_id)
        }
        _ => false,
    }
}

async fn bind_with_fallback(
    host: &str,
    desired: u16,
) -> Result<tokio::net::TcpListener, Box<dyn std::error::Error>> {
    match tokio::net::TcpListener::bind((host, desired)).await {
        Ok(listener) => Ok(listener),
        Err(err) if desired != 0 && err.kind() == std::io::ErrorKind::AddrInUse => {
            Ok(tokio::net::TcpListener::bind((host, 0)).await?)
        }
        Err(err) => Err(Box::new(err)),
    }
}

fn resolve_web_dist() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::var("READER_WEB_DIST") {
        candidates.push(PathBuf::from(dir));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("web"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../web/dist"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("packages/web/dist"));
        candidates.push(cwd.join("web/dist"));
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("index.html").is_file())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .args(["-a", "Google Chrome", url])
            .spawn()
            .or_else(|_| std::process::Command::new("open").arg(url).spawn());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // PRD：界面只承诺 Chromium；优先用 Chrome/Chromium 的 --app 窗口。
        if let Some(bin) = find_in_path(&[
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ]) {
            let _ = std::process::Command::new(bin)
                .arg(format!("--app={url}"))
                .arg("--new-window")
                .spawn();
            return;
        }
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

fn find_in_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    log("收到退出信号，正在退出…");
}
