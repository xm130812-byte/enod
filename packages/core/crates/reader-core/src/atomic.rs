//! 原子写：同目录临时文件 → fsync → rename；断电只留 `.tmp`，不留半截正文。

use chrono::{SecondsFormat, Utc};
use rand::Rng;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn tmp_name(base: &str) -> String {
    let rand: u64 = rand::rng().random();
    format!(".{}.{}.{:08x}.tmp", base, std::process::id(), rand as u32)
}

fn write_blocking(path: &Path, data: &[u8], retries: usize) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let base = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..=retries {
        let tmp = parent.join(tmp_name(&base));
        let result = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(parent)?;
            {
                let mut f = std::fs::File::create(&tmp)?;
                f.write_all(data)?;
                f.sync_all()?;
            }
            std::fs::rename(&tmp, path)?;
            // 目录也 fsync，确保 rename 落盘（PRD §4.8）
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
            Ok(())
        })();
        match result {
            Ok(()) => return Ok(()),
            Err(err) => {
                let _ = std::fs::remove_file(&tmp);
                last_err = Some(err);
                let retryable = last_err
                    .as_ref()
                    .map(|e| {
                        matches!(
                            e.kind(),
                            std::io::ErrorKind::PermissionDenied
                                | std::io::ErrorKind::WouldBlock
                                | std::io::ErrorKind::Other
                        )
                    })
                    .unwrap_or(false);
                if !retryable || attempt == retries {
                    break;
                }
                std::thread::sleep(Duration::from_millis(80 * (attempt as u64 + 1)));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("atomic write failed")))
}

pub async fn atomic_write_file(path: &Path, data: &[u8], retries: usize) -> std::io::Result<()> {
    let path = path.to_path_buf();
    let data = data.to_vec();
    tokio::task::spawn_blocking(move || write_blocking(&path, &data, retries))
        .await
        .map_err(|e| std::io::Error::other(format!("join: {e}")))?
}

pub fn timestamp_slug() -> String {
    Utc::now()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .replace([':', '.'], "-")
}

/// 写回前留快照：versions/<docId>/<ts>.md，最多保留 keep 版。
pub async fn save_version(
    versions_root: &Path,
    doc_id: &str,
    content: &[u8],
    keep: usize,
) -> std::io::Result<PathBuf> {
    let dir = versions_root.join(doc_id);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.md", timestamp_slug()));
    std::fs::write(&file, content)?;
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.ends_with(".md"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    if names.len() > keep {
        for name in &names[..names.len() - keep] {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
    Ok(file)
}

pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}
