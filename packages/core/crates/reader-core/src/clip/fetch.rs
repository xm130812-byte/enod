//! 网页抓取与图片下载：逐跳重定向校验 + 私网拦截（PRD §4.6）。

use super::url::{is_private_host, normalize_clip_url};
use encoding_rs::{Encoding, GB18030, UTF_16BE, UTF_16LE, UTF_8};
use regex::Regex;
use std::sync::OnceLock;
use std::time::Duration;

pub const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
pub const FETCH_TIMEOUT_MS: u64 = 25_000;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 md-reader/0.1";

#[derive(Clone, Debug)]
pub struct FetchedPage {
    pub html: String,
    pub final_url: String,
    pub content_type: String,
}

#[derive(Clone, Debug)]
pub struct ImageDownload {
    pub data: Vec<u8>,
    pub mime: String,
    pub ext: String,
}

fn client(timeout_ms: u64, redirect: bool) -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .redirect(if redirect {
            reqwest::redirect::Policy::limited(5)
        } else {
            reqwest::redirect::Policy::none()
        })
        .user_agent(USER_AGENT)
        .build()
}

pub async fn fetch_page(input: &str, allow_private: bool) -> Result<FetchedPage, String> {
    let normalized = normalize_clip_url(input, allow_private)
        .ok_or_else(|| "不是有效的网页地址，或指向本机/内网地址".to_string())?;
    let http = client(FETCH_TIMEOUT_MS, false).map_err(|e| e.to_string())?;
    let mut current = normalized;
    let mut response = None;
    for _ in 0..6 {
        let resp = http
            .get(current.as_str())
            .header(
                "Accept",
                "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
            )
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6")
            .send()
            .await
            .map_err(|e| format!("抓取失败：{e}"))?;
        if resp.status().is_redirection() {
            let location = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());
            let Some(location) = location else {
                return Err(format!(
                    "网页返回 {}，但没有跳转地址",
                    resp.status().as_u16()
                ));
            };
            let next = current
                .join(&location)
                .map_err(|_| "网页跳转地址无效".to_string())?;
            if next.scheme() != "http" && next.scheme() != "https" {
                return Err("只支持 http/https 网页".into());
            }
            if !allow_private && is_private_host(next.host_str().unwrap_or("")) {
                return Err("拒绝访问本机/内网地址".into());
            }
            current = next;
            continue;
        }
        response = Some(resp);
        break;
    }
    let response = response.ok_or_else(|| "网页跳转次数过多".to_string())?;
    if !response.status().is_success() {
        return Err(format!("网页返回 HTTP {}", response.status().as_u16()));
    }
    let final_url = response.url().to_string();
    if !allow_private && is_private_host(response.url().host_str().unwrap_or("")) {
        return Err("拒绝访问本机/内网地址".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let looks_html = mime.is_empty() || mime == "text/html" || mime == "application/xhtml+xml";
    if !looks_html {
        return Err(format!("这个地址不是网页（{}）", if mime.is_empty() { "未知类型" } else { &mime }));
    }
    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if declared > MAX_PAGE_BYTES {
        return Err("网页体积过大，已停止抓取".into());
    }
    let raw = response
        .bytes()
        .await
        .map_err(|e| format!("读取网页失败：{e}"))?;
    if raw.is_empty() {
        return Err("网页内容为空".into());
    }
    if raw.len() > MAX_PAGE_BYTES {
        return Err("网页体积过大，已停止抓取".into());
    }
    let html = decode_html(&raw, &content_type);
    if !html.contains('<') && !html.contains('>') {
        return Err("网页内容不是 HTML".into());
    }
    Ok(FetchedPage {
        html,
        final_url,
        content_type,
    })
}

fn charset_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)charset\s*=\s*["']?([^;"'\s]+)"#).unwrap())
}

fn meta_charset_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)"#).unwrap())
}

pub fn decode_html(buffer: &[u8], content_type: &str) -> String {
    let head = String::from_utf8_lossy(&buffer[..buffer.len().min(4096)]).to_string();
    let header_label = charset_re()
        .captures(content_type)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    let meta_label = meta_charset_re()
        .captures(&head)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    let encoding = header_label
        .as_deref()
        .and_then(encoding_for)
        .or_else(|| meta_label.as_deref().and_then(encoding_for))
        .unwrap_or(UTF_8);
    let (text, _, _) = encoding.decode(buffer);
    text.trim_start_matches('\u{feff}').to_string()
}

fn encoding_for(label: &str) -> Option<&'static Encoding> {
    let value = label
        .trim()
        .trim_matches(['"', '\''])
        .to_lowercase();
    match value.as_str() {
        "gb2312" | "gbk" | "gb18030" => Some(GB18030),
        "utf8" | "utf-8" => Some(UTF_8),
        "utf-16" | "utf-16le" | "utf16le" => Some(UTF_16LE),
        "utf-16be" => Some(UTF_16BE),
        _ => Encoding::for_label(value.as_bytes()),
    }
}

pub async fn download_image(
    url: &str,
    referer: &str,
    allow_private: bool,
) -> Result<ImageDownload, String> {
    let normalized = normalize_clip_url(url, allow_private).ok_or_else(|| "图片地址无效".to_string())?;
    if normalized.scheme() == "file" {
        return Err("本地图片不走下载".into());
    }
    let http = client(15_000, true).map_err(|e| e.to_string())?;
    let response = http
        .get(normalized.as_str())
        .header(
            "Accept",
            "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
        )
        .header("Referer", referer)
        .send()
        .await
        .map_err(|e| format!("图片下载失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("图片 HTTP {}", response.status().as_u16()));
    }
    if !allow_private && is_private_host(response.url().host_str().unwrap_or("")) {
        return Err("图片指向内网地址".into());
    }
    let declared = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if declared > MAX_IMAGE_BYTES {
        return Err("图片过大".into());
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let data = response
        .bytes()
        .await
        .map_err(|e| format!("读取图片失败：{e}"))?
        .to_vec();
    if data.is_empty() {
        return Err("图片为空".into());
    }
    if data.len() > MAX_IMAGE_BYTES {
        return Err("图片过大".into());
    }
    let mime = if content_type.starts_with("image/") {
        content_type
    } else {
        sniff_image_mime(&data)
    };
    if mime.is_empty() {
        return Err("不是可识别的图片".into());
    }
    if mime == "image/svg+xml" {
        return Err("跳过 SVG 图片".into());
    }
    let ext = image_ext(&mime)
        .or_else(|| image_ext_from_url(normalized.as_str()))
        .ok_or_else(|| "不是可识别的图片".to_string())?;
    Ok(ImageDownload { data, mime, ext })
}

pub fn sniff_image_mime(data: &[u8]) -> String {
    if data.len() >= 8 && &data[..8] == b"\x89PNG\r\n\x1a\n" {
        return "image/png".into();
    }
    if data.len() >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
        return "image/jpeg".into();
    }
    if data.len() >= 6 && &data[..6] == b"GIF87a" || data.len() >= 6 && &data[..6] == b"GIF89a" {
        return "image/gif".into();
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return "image/webp".into();
    }
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        return "image/avif".into();
    }
    String::new()
}

pub fn image_ext(mime: &str) -> Option<String> {
    match mime {
        "image/png" => Some(".png".into()),
        "image/jpeg" | "image/jpg" => Some(".jpg".into()),
        "image/gif" => Some(".gif".into()),
        "image/webp" => Some(".webp".into()),
        "image/avif" => Some(".avif".into()),
        _ => None,
    }
}

fn image_ext_from_url(url: &str) -> Option<String> {
    let path = url::Url::parse(url).ok()?.path().to_lowercase();
    for ext in [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"] {
        if path.ends_with(ext) {
            return Some(if ext == ".jpeg" { ".jpg".into() } else { ext.into() });
        }
    }
    None
}
