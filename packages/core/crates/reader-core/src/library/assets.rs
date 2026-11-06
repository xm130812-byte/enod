//! 图片资产：粘贴上传落到 assets/<docId>/，派生图片落到 assets/<派生id>/。

use super::{slice_chars, LibraryService};
use crate::atomic::atomic_write_file;
use crate::error::{AppError, AppResult};
use crate::hash::hash_buffer;
use crate::paths::{is_inside_root, resolve_in_root};
use serde_json::{json, Value};
use std::path::PathBuf;

const IMAGE_TYPES: [(&str, &str); 8] = [
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".avif", "image/avif"),
    (".svg", "image/svg+xml"),
    (".bmp", "image/bmp"),
];

fn mime_for_ext(ext: &str) -> Option<&'static str> {
    IMAGE_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, m)| *m)
}

fn pick_image_ext(filename: &str, mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => return Some(".png"),
        "image/jpeg" | "image/jpg" => return Some(".jpg"),
        "image/gif" => return Some(".gif"),
        "image/webp" => return Some(".webp"),
        "image/avif" => return Some(".avif"),
        "image/svg+xml" => return Some(".svg"),
        "image/bmp" => return Some(".bmp"),
        _ => {}
    }
    let ext = filename
        .rsplit_once('.')
        .map(|(_, e)| format!(".{}", e.to_lowercase()))?;
    IMAGE_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(e, _)| *e)
}

impl LibraryService {
    pub async fn upload_asset(
        &self,
        doc_id: &str,
        filename: &str,
        data: &[u8],
        mime: &str,
    ) -> AppResult<Value> {
        let root = self
            .root_path()
            .ok_or_else(|| AppError::new(409, "no-library", "还没有挂载书库"))?;
        self.require_doc(doc_id).await?;
        let ext = pick_image_ext(filename, mime)
            .ok_or_else(|| AppError::new(415, "unsupported-media", "只支持图片"))?;
        if data.len() > 20 * 1024 * 1024 {
            return Err(AppError::new(413, "too-large", "图片不能超过 20MB"));
        }
        let dir = root.join("assets").join(doc_id);
        tokio::fs::create_dir_all(&dir).await?;
        let name = format!("{}{}", &hash_buffer(data)[..16], ext);
        let abs = dir.join(&name);
        if !abs.exists() {
            atomic_write_file(&abs, data, 1).await?;
        }
        let rel_path = format!("assets/{doc_id}/{name}");
        Ok(json!({
            "relPath": rel_path,
            "url": format!("/api/v1/files?path={}", percent_encode(&rel_path)),
            "size": data.len(),
        }))
    }

    pub fn resolve_asset(&self, rel_path: &str) -> AppResult<(PathBuf, &'static str)> {
        let root = self
            .root_path()
            .ok_or_else(|| AppError::new(409, "no-library", "还没有挂载书库"))?;
        let abs = resolve_in_root(&root, rel_path);
        if !is_inside_root(&root, &abs) {
            return Err(AppError::bad_request("路径越界"));
        }
        let ext = abs
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_default();
        let mime = mime_for_ext(&ext)
            .ok_or_else(|| AppError::new(403, "forbidden-type", "只允许访问图片"))?;
        Ok((abs, mime))
    }

    pub fn asset_snippet(&self, body: &str) -> String {
        slice_chars(body, 0, 80)
    }
}

fn percent_encode(input: &str) -> String {
    let mut out = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b'/' => out.push_str("%2F"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
