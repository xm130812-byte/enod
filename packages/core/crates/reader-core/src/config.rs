//! config.json / run.json：字段名、默认值与 v3 逐字对齐；未知字段原样保留。

use crate::paths::{default_library_dir, DataPaths};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const THEMES: [&str; 4] = ["light", "dark", "sepia", "system"];
pub const ACCENTS: [&str; 6] = ["blue", "teal", "green", "red", "amber", "graphite"];
pub const FONT_FAMILIES: [&str; 3] = ["serif", "sans", "mono"];

pub fn default_config_map() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("libraryRoot".into(), Value::Null);
    m.insert("theme".into(), Value::String("system".into()));
    m.insert("accent".into(), Value::String("blue".into()));
    m.insert("density".into(), Value::String("comfortable".into()));
    m.insert("readerLayout".into(), Value::String("document".into()));
    m.insert("fontSize".into(), Value::from(18));
    m.insert("lineHeight".into(), Value::from(1.75));
    m.insert("measureCh".into(), Value::from(68));
    m.insert("fontFamily".into(), Value::String("sans".into()));
    m.insert("autosave".into(), Value::Bool(true));
    m.insert("versionKeep".into(), Value::from(20));
    m.insert("syncProgress".into(), Value::Bool(false));
    m.insert("showLineNumbers".into(), Value::Bool(false));
    m.insert("lastDocId".into(), Value::Null);
    m
}

fn clamp(value: Option<&Value>, min: f64, max: f64, fallback: f64) -> Value {
    let n = match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    let n = n.filter(|v| v.is_finite()).unwrap_or(fallback);
    let clamped = n.min(max).max(min);
    if (clamped.fract()).abs() < f64::EPSILON {
        Value::from(clamped as i64)
    } else {
        serde_json::Number::from_f64(clamped)
            .map(Value::Number)
            .unwrap_or_else(|| Value::from(fallback))
    }
}

/// 对已知字段做类型纠偏，未知字段原样保留。
pub fn sanitize_config(map: &mut Map<String, Value>) {
    let theme = map
        .get("theme")
        .and_then(|v| v.as_str())
        .filter(|s| THEMES.contains(s))
        .unwrap_or("system")
        .to_string();
    map.insert("theme".into(), Value::String(theme));

    let accent = map
        .get("accent")
        .and_then(|v| v.as_str())
        .filter(|s| ACCENTS.contains(s))
        .unwrap_or("blue")
        .to_string();
    map.insert("accent".into(), Value::String(accent));

    let family = map
        .get("fontFamily")
        .and_then(|v| v.as_str())
        .filter(|s| FONT_FAMILIES.contains(s))
        .unwrap_or("sans")
        .to_string();
    map.insert("fontFamily".into(), Value::String(family));

    let density = if map.get("density").and_then(|v| v.as_str()) == Some("compact") {
        "compact"
    } else {
        "comfortable"
    };
    map.insert("density".into(), Value::String(density.into()));

    let layout = if map.get("readerLayout").and_then(|v| v.as_str()) == Some("focus") {
        "focus"
    } else {
        "document"
    };
    map.insert("readerLayout".into(), Value::String(layout.into()));

    let root = map
        .get("libraryRoot")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(Value::String)
        .unwrap_or(Value::Null);
    map.insert("libraryRoot".into(), root);

    map.insert(
        "fontSize".into(),
        clamp(map.get("fontSize"), 13.0, 32.0, 18.0),
    );
    map.insert(
        "lineHeight".into(),
        clamp(map.get("lineHeight"), 1.2, 2.6, 1.75),
    );
    map.insert(
        "measureCh".into(),
        clamp(map.get("measureCh"), 40.0, 120.0, 68.0),
    );
    map.insert(
        "versionKeep".into(),
        clamp(map.get("versionKeep"), 1.0, 200.0, 20.0),
    );

    let autosave = map
        .get("autosave")
        .map(|v| v != &Value::Bool(false))
        .unwrap_or(true);
    map.insert("autosave".into(), Value::Bool(autosave));
    let sync = map.get("syncProgress").and_then(|v| v.as_bool()) == Some(true);
    map.insert("syncProgress".into(), Value::Bool(sync));
    let lines = map
        .get("showLineNumbers")
        .and_then(|v| v.as_bool())
        == Some(true);
    map.insert("showLineNumbers".into(), Value::Bool(lines));

    let last = map
        .get("lastDocId")
        .and_then(|v| v.as_str())
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null);
    map.insert("lastDocId".into(), last);
}

pub struct ConfigStore {
    pub paths: DataPaths,
    state: Mutex<Map<String, Value>>,
}

impl ConfigStore {
    pub fn load(paths: DataPaths) -> Self {
        let mut map = default_config_map();
        if let Ok(raw) = std::fs::read_to_string(&paths.config_file) {
            if let Ok(Value::Object(parsed)) = serde_json::from_str::<Value>(&raw) {
                // 未知字段原样保留（PRD §4.10）
                for (k, v) in parsed {
                    map.insert(k, v);
                }
            }
        }
        sanitize_config(&mut map);
        Self {
            paths,
            state: Mutex::new(map),
        }
    }

    pub fn get(&self) -> Value {
        Value::Object(self.state.lock().unwrap_or_else(|e| e.into_inner()).clone())
    }

    pub fn get_str(&self, key: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    pub fn get_f64(&self, key: &str) -> Option<f64> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .and_then(|v| v.as_f64())
    }

    pub fn get_i64(&self, key: &str) -> Option<i64> {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .and_then(|v| v.as_i64())
            .or_else(|| self.get_f64(key).map(|f| f as i64))
    }

    pub fn save(&self, patch: &Map<String, Value>) -> Value {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        for (k, v) in patch {
            guard.insert(k.clone(), v.clone());
        }
        sanitize_config(&mut guard);
        let next = guard.clone();
        drop(guard);
        self.write(&next);
        Value::Object(next)
    }

    fn write(&self, map: &Map<String, Value>) {
        if let Some(dir) = self.paths.config_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = self
            .paths
            .config_file
            .with_extension(format!("json.{}.tmp", std::process::id()));
        let payload = serde_json::to_string_pretty(&Value::Object(map.clone()))
            .unwrap_or_else(|_| "{}".into());
        if let Ok(mut f) = std::fs::File::create(&tmp) {
            let _ = f.write_all(payload.as_bytes());
            let _ = f.sync_all();
        }
        let _ = std::fs::rename(&tmp, &self.paths.config_file);
    }

    /// 环境变量优先，供开发/测试使用。
    pub fn resolve_library_root(&self) -> Option<PathBuf> {
        if let Ok(env_root) = std::env::var("READER_ROOT") {
            let trimmed = env_root.trim();
            if !trimmed.is_empty() {
                return Some(PathBuf::from(trimmed));
            }
        }
        self.get_str("libraryRoot")
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
    }

    pub fn ensure_default_library(&self) -> PathBuf {
        let dir = self
            .get_str("libraryRoot")
            .map(PathBuf::from)
            .unwrap_or_else(default_library_dir);
        let _ = std::fs::create_dir_all(dir.join("Inbox"));
        let _ = std::fs::create_dir_all(dir.join("assets"));
        dir
    }
}

/* ------------------------------------------------------------------ run.json */

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub pid: u32,
    pub port: u16,
    pub instance_id: String,
    pub started_at: String,
    pub url: String,
    pub library_root: Option<String>,
    pub version: String,
}

pub fn read_run_info(paths: &DataPaths) -> Option<RunInfo> {
    let raw = std::fs::read_to_string(&paths.run_file).ok()?;
    let info: RunInfo = serde_json::from_str(&raw).ok()?;
    if info.instance_id.is_empty() {
        return None;
    }
    Some(info)
}

pub fn write_run_info(paths: &DataPaths, info: &RunInfo) -> std::io::Result<()> {
    std::fs::create_dir_all(&paths.root)?;
    let tmp = paths
        .run_file
        .with_extension(format!("json.{}.tmp", std::process::id()));
    let payload = serde_json::to_string_pretty(info).unwrap_or_else(|_| "{}".into());
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(payload.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &paths.run_file)
}

pub fn clear_run_info(paths: &DataPaths, instance_id: &str) {
    if let Some(current) = read_run_info(paths) {
        if current.instance_id != instance_id {
            return;
        }
    }
    let _ = std::fs::remove_file(&paths.run_file);
}

pub fn new_instance_id() -> String {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// 进程是否还活着（用于单实例检测）。
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        return Path::new(&format!("/proc/{pid}")).exists();
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("tasklist");
        cmd.args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(CREATE_NO_WINDOW);
        let out = cmd.output();
        out.map(|o| {
            let s = String::from_utf8_lossy(&o.stdout);
            s.contains(&pid.to_string()) && !s.contains("No tasks")
        })
        .unwrap_or(false)
    }
}

/// Node 的 process.platform 口径，保证 health 返回一致。
pub fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
