//! 网页正文提取：readability + htmd + 干净 Markdown（移植自 v3 clip/extract.ts）。

use super::url::{resolve_url, safe_hostname};
use htmd::options::{BulletListMarker, Options};
use regex::Regex;
use scraper::{Html, Selector};
use std::sync::OnceLock;
use url::Url;

#[derive(Clone, Debug, Default)]
pub struct Article {
    pub title: String,
    pub site: String,
    pub author: String,
    pub published: String,
    pub canonical_url: String,
    pub excerpt: String,
    pub markdown: String,
    pub images: Vec<String>,
    pub warnings: Vec<String>,
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn meta_content(doc: &Html, selector: &str) -> String {
    let Ok(sel) = Selector::parse(selector) else {
        return String::new();
    };
    doc.select(&sel)
        .next()
        .and_then(|el| {
            el.value()
                .attr("content")
                .or_else(|| el.value().attr("href"))
                .or_else(|| el.value().attr("datetime"))
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_default()
}

fn first_of(doc: &Html, selectors: &[&str]) -> String {
    for sel in selectors {
        let value = meta_content(doc, sel);
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

fn text_of(doc: &Html, selector: &str) -> String {
    let Ok(sel) = Selector::parse(selector) else {
        return String::new();
    };
    doc.select(&sel)
        .next()
        .map(|el| collapse(&el.text().collect::<Vec<_>>().join(" ")))
        .unwrap_or_default()
}

pub fn clean_title(raw: &str, site: &str, page_url: &str) -> String {
    let mut title = collapse(raw);
    title = title
        .trim_matches(|c: char| c.is_whitespace() || "\"'“”‘’".contains(c))
        .to_string();
    let site_key = collapse(site).to_lowercase();
    let host = safe_hostname(page_url).to_lowercase();

    for sep in [" - ", " | ", " — ", " – ", " _ ", " · "] {
        if let Some(idx) = title.rfind(sep) {
            if idx == 0 {
                continue;
            }
            let suffix = title[idx + sep.len()..].trim();
            let suffix_key = suffix.to_lowercase();
            if suffix_key == site_key
                || suffix_key == host
                || (!site_key.is_empty() && suffix_key.contains(&site_key))
            {
                title = title[..idx].trim().to_string();
                break;
            }
        }
    }
    let title: String = title.chars().take(180).collect();
    if title.is_empty() {
        "未命名剪藏".into()
    } else {
        title
    }
}

pub fn clean_markdown(raw: &str, title: &str) -> String {
    let mut text = raw
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    text = text
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '\u{0000}' | '\u{200b}'..='\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{feff}'
            )
        })
        .collect();
    text = text.replace('\u{a0}', " ");
    text = text
        .lines()
        .map(|line| line.trim_end_matches([' ', '\t']))
        .collect::<Vec<_>>()
        .join("\n");
    while text.contains("\n\n\n") {
        text = text.replace("\n\n\n", "\n\n");
    }
    text = text.trim().to_string();

    if !title.is_empty() {
        let wanted = normalize_title(title);
        let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
        let mut seen_heading = false;
        let mut remove_at: Option<usize> = None;
        for (i, line) in lines.iter().enumerate() {
            let Some(rest) = line.strip_prefix('#') else {
                continue;
            };
            let level = rest.chars().take_while(|c| *c == '#').count() + 1;
            let heading = rest.trim_start_matches('#').trim();
            if !seen_heading {
                let cleaned = Regex::new(r"^\d+\\?[.、]\s*")
                    .map(|re| re.replace(heading, "").into_owned())
                    .unwrap_or_else(|_| heading.to_string());
                let heading_norm = normalize_title(&cleaned);
                let overlapping = !heading_norm.is_empty()
                    && (wanted.contains(&heading_norm) || heading_norm.contains(&wanted));
                if level <= 2 && (normalize_title(heading) == wanted || overlapping) {
                    remove_at = Some(i);
                    break;
                }
                seen_heading = true;
            }
        }
        if let Some(i) = remove_at {
            lines.remove(i);
            if lines.get(i).map(|l| l.trim().is_empty()).unwrap_or(false) {
                lines.remove(i);
            }
            text = lines.join("\n").trim_start().to_string();
        }
    }
    if text.is_empty() {
        String::new()
    } else {
        format!("{text}\n")
    }
}

fn is_noise_container(class_id: &str) -> bool {
    let s = class_id.to_lowercase();
    [
        "toc",
        "share",
        "comment",
        "recommend",
        "related",
        "sidebar",
        "footer",
        "header",
        "nav",
        "popup",
        "coin",
        "banner",
        "toolbar",
        "copyright",
    ]
    .iter()
    .any(|key| s.contains(key))
}

fn element_text_len(el: &scraper::ElementRef<'_>) -> usize {
    collapse(&el.text().collect::<Vec<_>>().join(" "))
        .chars()
        .count()
}

/// 选择正文容器：段落文本多、链接密度低、容器名不噪。
fn pick_content(doc: &Html) -> String {
    #[derive(Clone)]
    struct Candidate {
        score: f64,
        text_len: usize,
        html: String,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    for selector in ["article", "main", "div", "section"] {
        let Ok(sel) = Selector::parse(selector) else {
            continue;
        };
        for el in doc.select(&sel) {
            let text_len = element_text_len(&el);
            if text_len < 200 {
                continue;
            }
            let class_id = format!(
                "{} {}",
                el.value().attr("class").unwrap_or(""),
                el.value().attr("id").unwrap_or("")
            );
            if is_noise_container(&class_id) {
                continue;
            }
            let total_text = el.text().collect::<Vec<_>>().join(" ");
            let link_text: String = el
                .select(&Selector::parse("a").unwrap())
                .flat_map(|a| a.text())
                .collect::<Vec<_>>()
                .join(" ");
            let link_len = collapse(&link_text).chars().count();
            let density = (link_len as f64 / text_len as f64).min(0.95);
            let paragraph_text: usize = el
                .select(&Selector::parse("p").unwrap())
                .map(|p| element_text_len(&p))
                .sum();
            let heading_text: usize = el
                .select(&Selector::parse("h1,h2,h3").unwrap())
                .map(|h| element_text_len(&h))
                .sum();
            let _ = total_text;
            let score = (paragraph_text as f64 + 0.5 * heading_text as f64) * (1.0 - density);
            if std::env::var("READER_DEBUG_EXTRACT").is_ok() {
                eprintln!(
                    "{selector} class={class_id:?} text={text_len} p={paragraph_text} h={heading_text} density={density:.3} score={score:.1}"
                );
            }
            candidates.push(Candidate {
                score,
                text_len,
                html: el.inner_html(),
            });
        }
    }
    let best_score = candidates
        .iter()
        .map(|c| c.score)
        .fold(0.0f64, f64::max);
    if best_score > 0.0 {
        // 外层的 #app 与正文容器段落分几乎相同；在近分候选里取文本最少（最具体）的那个
        let threshold = best_score * 0.99;
        if let Some(best) = candidates
            .iter()
            .filter(|c| c.score >= threshold)
            .min_by_key(|c| c.text_len)
        {
            return best.html.clone();
        }
    }
    doc.select(&Selector::parse("body").unwrap())
        .next()
        .map(|el| el.inner_html())
        .unwrap_or_default()
}

fn strip_noise(html: &str) -> String {
    let mut out = html.to_string();
    for tag in [
        "script", "style", "noscript", "template", "iframe", "object", "embed", "form", "input",
        "button", "select", "textarea", "svg", "canvas", "nav", "aside", "footer",
    ] {
        if let Ok(paired) = Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>")) {
            out = paired.replace_all(&out, "").into_owned();
        }
        if let Ok(single) = Regex::new(&format!(r"(?is)<{tag}\b[^>]*/?>")) {
            out = single.replace_all(&out, "").into_owned();
        }
    }
    if let Ok(comments) = Regex::new(r"(?s)<!--.*?-->") {
        out = comments.replace_all(&out, "").into_owned();
    }
    // Readability 会把正文里的 h1 降为 h2，避免与页面标题重复
    if let Ok(h1_open) = Regex::new(r"(?i)<h1(\s|>)") {
        out = h1_open.replace_all(&out, "<h2$1").into_owned();
    }
    if let Ok(h1_close) = Regex::new(r"(?i)</h1>") {
        out = h1_close.replace_all(&out, "</h2>").into_owned();
    }
    out
}

fn unescape_url_parens(markdown: &str) -> String {
    markdown.replace("\\(", "(").replace("\\)", ")")
}

fn normalize_title(value: &str) -> String {    value
        .chars()
        .filter(|c| !"*_`~".contains(*c))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn image_link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"!\[([^\]]*)\]\(([^)\s]+)\)").unwrap()
    })
}

pub fn extract_article(html: &str, page_url: &str) -> Result<Article, String> {
    let warnings = Vec::new();
    let doc = Html::parse_document(html);

    let og_title = first_of(
        &doc,
        &[
            r#"meta[property="og:title"]"#,
            r#"meta[name="twitter:title"]"#,
            r#"meta[name="title"]"#,
        ],
    );
    let site = first_of(
        &doc,
        &[
            r#"meta[property="og:site_name"]"#,
            r#"meta[name="application-name"]"#,
            r#"meta[name="apple-mobile-web-app-title"]"#,
        ],
    );
    let author = first_of(
        &doc,
        &[
            r#"meta[name="author"]"#,
            r#"meta[property="article:author"]"#,
            r#"meta[name="twitter:creator"]"#,
        ],
    );
    let published = first_of(
        &doc,
        &[
            r#"meta[property="article:published_time"]"#,
            r#"meta[name="date"]"#,
            r#"meta[name="pubdate"]"#,
            r#"meta[itemprop="datePublished"]"#,
            "time[datetime]",
        ],
    );
    let description = first_of(
        &doc,
        &[
            r#"meta[property="og:description"]"#,
            r#"meta[name="description"]"#,
            r#"meta[name="twitter:description"]"#,
        ],
    );
    let canonical_raw = first_of(&doc, &[r#"link[rel="canonical"]"#, r#"meta[property="og:url"]"#]);
    let canonical = resolve_url(&canonical_raw, page_url).unwrap_or_else(|| page_url.to_string());
    let doc_title = text_of(&doc, "title");
    let h1 = text_of(&doc, "h1");
    let host = safe_hostname(page_url);

    let site_name = if site.trim().is_empty() {
        host.clone()
    } else {
        site.trim().to_string()
    };
    let title = clean_title(
        if !og_title.is_empty() {
            &og_title
        } else if !doc_title.is_empty() {
            &doc_title
        } else {
            &h1
        },
        &site_name,
        page_url,
    );

    let base = Url::parse(page_url).or_else(|_| Url::parse("https://example.invalid/"));
    let _ = base;

    // 正文容器：按段落文本量与链接密度评分（PRD §4.3 的 readability 对位实现）
    let content_html = pick_content(&doc);
    if content_html.trim().is_empty() {
        return Err("无法从页面中提取正文".into());
    }
    let content_html = strip_noise(&content_html);

    let markdown = htmd::HtmlToMarkdown::builder()
        .options(Options {
            bullet_list_marker: BulletListMarker::Dash,
            ..Options::default()
        })
        .build()
        .convert(&content_html)
        .unwrap_or_else(|_| content_html.clone());
    let mut markdown = markdown.replace('\u{a0}', " ");
    markdown = unescape_url_parens(&markdown);
    markdown = clean_markdown(&markdown, &title);
    if collapse(&markdown).chars().count() < 30 {
        return Err("正文提取结果过短，可能是登录页或空白页".into());
    }

    let images: Vec<String> = image_link_re()
        .captures_iter(&markdown)
        .filter_map(|c| c.get(2).map(|m| m.as_str().to_string()))
        .filter(|u| u.starts_with("http://") || u.starts_with("https://") || u.starts_with("file:"))
        .collect();

    Ok(Article {
        title,
        site: site_name,
        author: collapse(&author).chars().take(200).collect(),
        published: collapse(&published).chars().take(60).collect(),
        canonical_url: canonical,
        excerpt: collapse(&description).chars().take(400).collect(),
        markdown,
        images,
        warnings,
    })
}
