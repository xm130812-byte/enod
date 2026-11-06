//! 剪藏：抓取 → 提取 → 图片本地化 → 落盘（PRD §6.5 / v3 M5）。

pub mod extract;
pub mod fetch;
pub mod url;

use crate::atomic::atomic_write_file;
use crate::hash::hash_buffer;
use percent_encoding::percent_decode_str;
use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;
use ::url::Url;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ImageNameMode {
    /// 用 URL 哈希命名（本地 html 派生图片，与 v3 一致）
    UrlHash,
    /// 用内容哈希命名（剪藏图片，与 v3 一致）
    ContentHash,
}

pub struct LocalizeOptions<'a> {
    pub markdown: &'a str,
    pub base_url: &'a str,
    pub referer: &'a str,
    /// 是否用图片自身 host 作为 Referer（本地 html 的防盗链场景）
    pub referer_from_image_host: bool,
    pub doc_id: &'a str,
    pub root: &'a Path,
    pub allow_private: bool,
    pub max_images: usize,
    pub name_mode: ImageNameMode,
}

pub struct LocalizeResult {
    pub markdown: String,
    pub localized: usize,
    pub remote: usize,
    pub broken: usize,
    pub warnings: Vec<String>,
}

fn image_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"!\[([^\]]*)\]\(([^)\s]+)\)").unwrap())
}

/// 把 markdown 里的图片改写到 `assets/<docId>/`；库内 file:// 转相对路径。
pub async fn localize_images(opts: LocalizeOptions<'_>) -> LocalizeResult {
    let mut out = opts.markdown.to_string();
    let mut warnings = Vec::new();
    let mut localized = 0usize;
    let mut remote = 0usize;
    let mut broken = 0usize;

    let root_url = Url::from_directory_path(opts.root)
        .map(|u| u.to_string())
        .unwrap_or_default();
    let base = Url::parse(opts.base_url).ok();
    let asset_dir = opts.root.join("assets").join(opts.doc_id);

    let urls: Vec<String> = image_re()
        .captures_iter(opts.markdown)
        .filter_map(|c| c.get(2).map(|m| m.as_str().to_string()))
        .collect();
    let mut unique: Vec<String> = Vec::new();
    for url in urls {
        if !unique.contains(&url) {
            unique.push(url);
        }
    }

    let mut replacements: Vec<(String, String)> = Vec::new();
    let mut download_count = 0usize;
    for raw in unique {
        let resolved = if raw.starts_with("http://")
            || raw.starts_with("https://")
            || raw.starts_with("file:")
        {
            raw.clone()
        } else if let Some(base) = &base {
            base.join(&raw).map(|u| u.to_string()).unwrap_or(raw.clone())
        } else {
            raw.clone()
        };

        if let Some(rest) = resolved.strip_prefix(root_url.as_str()) {
            let decoded = percent_decode_str(rest)
                .decode_utf8_lossy()
                .replace('\\', "/");
            replacements.push((raw.clone(), decoded));
            continue;
        }
        if let Ok(parsed) = Url::parse(&resolved) {
            if parsed.scheme() == "file" {
                if let Some(host) = parsed.host_str() {
                    if !host.is_empty() {
                        // file://i0.hdslb.com/x.png → https://i0.hdslb.com/x.png
                        replacements.push((
                            raw.clone(),
                            format!("https://{host}{}", parsed.path()),
                        ));
                        continue;
                    }
                }
                replacements.push((raw.clone(), resolved.clone()));
                continue;
            }
        }
        if !(resolved.starts_with("http://") || resolved.starts_with("https://")) {
            continue;
        }
        if download_count >= opts.max_images {
            warnings.push(format!(
                "图片超过 {} 张，其余保留远程地址。",
                opts.max_images
            ));
            remote += 1;
            continue;
        }
        download_count += 1;
        let referer = if opts.referer_from_image_host {
            Url::parse(&resolved)
                .ok()
                .and_then(|u| u.host_str().map(|h| format!("https://{h}/")))
                .unwrap_or_else(|| opts.referer.to_string())
        } else {
            opts.referer.to_string()
        };
        match fetch::download_image(&resolved, &referer, opts.allow_private).await {
            Ok(download) => {
                let name = match opts.name_mode {
                    ImageNameMode::UrlHash => {
                        format!("{}{}", &hash_buffer(resolved.as_bytes())[..16], download.ext)
                    }
                    ImageNameMode::ContentHash => {
                        format!("{}{}", &hash_buffer(&download.data)[..16], download.ext)
                    }
                };
                let abs = asset_dir.join(&name);
                if !abs.exists() {
                    let _ = tokio::fs::create_dir_all(&asset_dir).await;
                    if atomic_write_file(&abs, &download.data, 1).await.is_err() {
                        broken += 1;
                        replacements.push((raw.clone(), resolved.clone()));
                        continue;
                    }
                }
                replacements.push((
                    raw.clone(),
                    format!("assets/{}/{}", opts.doc_id, name),
                ));
                localized += 1;
            }
            Err(err) => {
                warnings.push(format!("图片未能本地化：{err}"));
                remote += 1;
                replacements.push((raw.clone(), resolved.clone()));
            }
        }
    }

    for (from, to) in &replacements {
        out = out.replace(&format!("]({from})"), &format!("]({to})"));
    }

    if remote > 0 && opts.name_mode == ImageNameMode::UrlHash {
        warnings.push(format!("{remote} 张图片仍是远程地址，断网时不显示。"));
    }
    if broken > 0 {
        warnings.push(format!("{broken} 张图片无法解析，已用文字占位。"));
    }

    LocalizeResult {
        markdown: out,
        localized,
        remote,
        broken,
        warnings,
    }
}
