//! HTML → markdown：readability 提取正文 + htmd 转换；库内图片改回相对路径。

use super::{derived_doc_id, DerivedDoc};
use crate::clip::extract::extract_article;
use crate::clip::{localize_images, ImageNameMode, LocalizeOptions};
use crate::encoding::decode_file;
use std::path::Path;
use url::Url;

pub async fn convert(buffer: &[u8], rel_path: &str, abs_path: &Path, root: &Path) -> DerivedDoc {
    let mut warnings = Vec::new();
    let decoded = decode_file(buffer);
    // 协议相对地址在 file:// 基准下会丢主机名，提取前统一补成 https://
    let html = decoded
        .text
        .replace("=\"//", "=\"https://")
        .replace("='//", "='https://");

    let base = Url::from_file_path(abs_path)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| "file:///".to_string());
    let doc_id = derived_doc_id(rel_path);
    let fallback_title = strip_html_ext(rel_path);

    match extract_article(&html, &base) {
        Ok(article) => {
            let host = Url::parse(&base)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()));
            let referer = match &host {
                Some(host) if !host.is_empty() => format!("https://{host}/"),
                _ => base.clone(),
            };
            let localized = localize_images(LocalizeOptions {
                markdown: &article.markdown,
                base_url: &base,
                referer: &referer,
                referer_from_image_host: true,
                doc_id: &doc_id,
                root,
                allow_private: true,
                max_images: 30,
                name_mode: ImageNameMode::UrlHash,
            })
            .await;
            let mut all_warnings = article.warnings;
            if localized.localized > 0 {
                all_warnings.insert(
                    0,
                    format!("图片已本地化到 assets/（{} 张）。", localized.localized),
                );
            }
            all_warnings.extend(localized.warnings);
            let title = if article.title.trim().is_empty() || article.title == "未命名剪藏" {
                fallback_title
            } else {
                article.title
            };
            DerivedDoc {
                title,
                markdown: localized.markdown,
                warnings: all_warnings,
                scan_links_in_code: false,
                binary: false,
            }
        }
        Err(err) => {
            warnings.push(format!("正文提取失败：{err}"));
            let markdown = htmd::convert(&html).unwrap_or_else(|_| html.clone());
            DerivedDoc {
                title: fallback_title,
                markdown,
                warnings,
                scan_links_in_code: false,
                binary: false,
            }
        }
    }
}

fn strip_html_ext(rel_path: &str) -> String {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let lower = name.to_lowercase();
    for ext in [".html", ".htm"] {
        if lower.ends_with(ext) {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    name.to_string()
}
