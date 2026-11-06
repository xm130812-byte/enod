//! 三平台数据目录与库内 POSIX 路径规则（PRD §4.10）。

use std::path::{Component, Path, PathBuf};

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 应用数据目录：所有「不进书库」的东西都在这里。
///
/// Linux 上 v3 用的是 `~/.config/md-reader`，PRD v4 写的是 `~/.local/share/md-reader`。
/// 为了「老书库零迁移」，这里优先沿用已存在的 v3 目录；不存在才用 XDG_DATA_HOME。
pub fn app_data_dir() -> PathBuf {
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

pub fn default_library_dir() -> PathBuf {
    home_dir().join("Documents").join("md-reader")
}

#[derive(Clone, Debug)]
pub struct DataPaths {
    pub root: PathBuf,
    pub config_file: PathBuf,
    pub run_file: PathBuf,
    pub token_file: PathBuf,
    pub db_file: PathBuf,
    pub versions_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub drafts_dir: PathBuf,
}

pub fn data_paths(root: PathBuf) -> DataPaths {
    DataPaths {
        config_file: root.join("config.json"),
        run_file: root.join("run.json"),
        token_file: root.join("token"),
        db_file: root.join("index.db"),
        versions_dir: root.join("versions"),
        logs_dir: root.join("logs"),
        drafts_dir: root.join("drafts"),
        root,
    }
}

pub fn ensure_data_dirs(paths: &DataPaths) -> std::io::Result<()> {
    for dir in [
        &paths.root,
        &paths.versions_dir,
        &paths.logs_dir,
        &paths.drafts_dir,
    ] {
        std::fs::create_dir_all(dir)?;
    }
    Ok(())
}

pub fn to_posix_path(p: &Path) -> String {
    p.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            Component::ParentDir => Some("..".into()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 相对 POSIX 路径 → 本机绝对路径（词法归一，不解析符号链接）。
pub fn resolve_in_root(root: &Path, rel_posix: &str) -> PathBuf {
    let cleaned = rel_posix.trim_start_matches(['/', '\\']);
    let mut out = lexical_normalize(root);
    for part in cleaned.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            out.pop();
        } else {
            out.push(part);
        }
    }
    out
}

pub fn is_inside_root(root: &Path, abs: &Path) -> bool {
    let root = lexical_normalize(root);
    let abs = lexical_normalize(abs);
    abs == root || abs.starts_with(&root)
}

pub fn relative_posix(root: &Path, abs: &Path) -> String {
    let root = lexical_normalize(root);
    let abs = lexical_normalize(abs);
    match abs.strip_prefix(&root) {
        Ok(rel) => to_posix_path(rel),
        Err(_) => to_posix_path(&abs),
    }
}

pub fn should_skip_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        "node_modules" | "__pycache__" | "venv" | "$RECYCLE.BIN" | "System Volume Information"
    )
}

pub fn should_skip_file(name: &str) -> bool {
    if name.starts_with('.') || name.starts_with("~$") || name.starts_with(".~") {
        return true;
    }
    let lower = name.to_lowercase();
    for ext in [".tmp", ".crdownload", ".download", ".part", ".swp", ".bak"] {
        if lower.ends_with(ext) {
            return true;
        }
    }
    matches!(name, "Thumbs.db" | "desktop.ini" | ".DS_Store")
}
