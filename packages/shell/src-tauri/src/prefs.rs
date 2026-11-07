//! 壳的偏好：打开方式（应用窗口 / Chrome 标签页）与数据目录。
//! 存在 core 的 config.json 的 `shell` 扩展字段里，core 会原样保留未知键。

use serde_json::Value;
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    Window,
    Browser,
}

impl OpenMode {
    pub fn as_str(self) -> &'static str {
        match self {
            OpenMode::Window => "window",
            OpenMode::Browser => "browser",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "window" => Some(OpenMode::Window),
            "browser" => Some(OpenMode::Browser),
            _ => None,
        }
    }

    /// Windows 默认内嵌窗口；macOS/Linux 只有 Chrome 标签页。
    pub fn platform_default() -> Self {
        if cfg!(target_os = "windows") {
            OpenMode::Window
        } else {
            OpenMode::Browser
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            OpenMode::Window => "应用窗口",
            OpenMode::Browser => "Chrome 标签页",
        }
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 与 reader-core 的 app_data_dir 保持同一套规则。
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("READER_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(target_os = "windows") {
        let appdata = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Roaming"));
        return appdata.join("md-reader");
    }
    if cfg!(target_os = "macos") {
        return home_dir()
            .join("Library")
            .join("Application Support")
            .join("md-reader");
    }
    let legacy = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".config"))
        .join("md-reader");
    if legacy.exists() {
        return legacy;
    }
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local").join("share"))
        .join("md-reader")
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

pub fn load_open_mode() -> OpenMode {
    let raw = match std::fs::read_to_string(config_path()) {
        Ok(raw) => raw,
        Err(_) => return OpenMode::platform_default(),
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return OpenMode::platform_default();
    };
    value
        .get("shell")
        .and_then(|v| v.get("openMode"))
        .and_then(|v| v.as_str())
        .and_then(OpenMode::parse)
        .unwrap_or_else(OpenMode::platform_default)
}

pub fn save_open_mode(mode: OpenMode) -> Result<(), String> {
    let path = config_path();
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let mut shell = root
        .get("shell")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    shell.insert("openMode".into(), Value::String(mode.as_str().into()));
    root.insert("shell".into(), Value::Object(shell));
    let payload = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("序列化 config 失败：{e}"))?;
    let dir = path.parent().ok_or("config 路径无效")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let tmp = dir.join(format!(".config.{}.tmp", std::process::id()));
    std::fs::write(&tmp, payload).map_err(|e| format!("写 config 失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换 config 失败：{e}"))?;
    Ok(())
}
