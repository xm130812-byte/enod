//! 正文派生物：标题、[[链接]]、摘要、字数（不落盘）。

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;

#[derive(Clone, Debug)]
pub struct WikiLinkRef {
    pub raw: String,
    pub target: String,
    pub anchor: Option<String>,
    pub display: Option<String>,
    pub index: usize,
}

fn wiki_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\[([^\[\]\n|#]{1,200}?)(?:#([^\[\]\n|]{1,120}?))?(?:\|([^\[\]\n|]{1,200}?))?\]\]")
            .unwrap()
    })
}

pub fn extract_wiki_links(body: &str) -> Vec<WikiLinkRef> {
    let mut out = Vec::new();
    for caps in wiki_re().captures_iter(body) {
        let target = caps.get(1).map(|m| m.as_str().trim()).unwrap_or("");
        if target.is_empty() {
            continue;
        }
        out.push(WikiLinkRef {
            raw: caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string(),
            target: target.to_string(),
            anchor: caps
                .get(2)
                .map(|m| m.as_str().trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            display: caps
                .get(3)
                .map(|m| m.as_str().trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            index: caps.get(0).map(|m| m.start()).unwrap_or(0),
        });
    }
    out
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingRef {
    pub level: u8,
    pub text: String,
    pub slug: String,
    pub line: usize,
}

fn slug_clean_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[`*_~\[\](){}<>]").unwrap())
}

fn slug_bad_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^\p{L}\p{N}\s-]").unwrap())
}

fn slug_space_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").unwrap())
}

fn slug_dash_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"-+").unwrap())
}

fn tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<[^>]*>").unwrap())
}

pub fn slugify_heading(text: &str) -> String {
    let lower = text.trim().to_lowercase();
    let no_tags = tag_re().replace_all(&lower, "");
    let no_marks = slug_clean_re().replace_all(&no_tags, "");
    let no_other = slug_bad_re().replace_all(&no_marks, "");
    let dashed = slug_space_re().replace_all(&no_other, "-");
    let collapsed = slug_dash_re().replace_all(&dashed, "-");
    let trimmed = collapsed.trim_matches('-');
    if trimmed.is_empty() {
        "section".into()
    } else {
        trimmed.to_string()
    }
}

fn heading_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*#*\s*$").unwrap())
}

fn fence_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s{0,3}(`{3,}|~{3,})").unwrap())
}

pub fn extract_headings(body: &str) -> Vec<HeadingRef> {    let mut out = Vec::new();
    let mut used: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut in_fence = false;
    let mut fence_marker = '\0';
    for (i, raw) in body.split('\n').enumerate() {
        let line = raw.trim_end_matches('\r');
        if let Some(caps) = fence_re().captures(line) {
            let marker = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let ch = marker.chars().next().unwrap_or('`');
            if !in_fence {
                in_fence = true;
                fence_marker = ch;
            } else if ch == fence_marker {
                in_fence = false;
            }
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(caps) = heading_re().captures(line) else {
            continue;
        };
        let level = caps.get(1).map(|m| m.as_str().len()).unwrap_or(0) as u8;
        let text = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
        let mut slug = slugify_heading(text);
        let seen = *used.get(&slug).unwrap_or(&0);
        used.insert(slug.clone(), seen + 1);
        if seen > 0 {
            slug = format!("{slug}-{}", seen + 1);
        }
        out.push(HeadingRef {
            level,
            text: text.to_string(),
            slug,
            line: i,
        });
    }
    out
}

fn code_block_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"```[\s\S]*?```").unwrap())
}

fn tilde_block_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"~~~[\s\S]*?~~~").unwrap())
}

fn image_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"!\[[^\]]*\]\([^)]*\)").unwrap())
}

fn link_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[([^\]]*)\]\([^)]*\)").unwrap())
}

fn plain_wiki_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\[\[([^\[\]|#]*)(?:#[^\[\]|]*)?(?:\|([^\[\]]*))?\]\]").unwrap()
    })
}

fn head_prefix_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s{0,3}#{1,6}\s+").unwrap())
}

fn quote_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s{0,3}>\s?").unwrap())
}

fn task_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*[-*+]\s+\[[ xX]\]\s+").unwrap())
}

fn bullet_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*[-*+]\s+").unwrap())
}

fn ordered_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*\d+\.\s+").unwrap())
}

fn marks_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[*_~`]").unwrap())
}

fn hr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^\s*---+\s*$").unwrap())
}

fn spaces_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[ \t]+").unwrap())
}

/// 粗略去掉行内/块级 Markdown 标记，用于摘要与纯文本定位。
pub fn strip_markdown(body: &str) -> String {
    let mut s = code_block_re().replace_all(body, " ").into_owned();
    s = tilde_block_re().replace_all(&s, " ").into_owned();
    s = image_re().replace_all(&s, " ").into_owned();
    s = link_re().replace_all(&s, "$1").into_owned();
    s = plain_wiki_re()
        .replace_all(&s, |caps: &regex::Captures| {
            let display = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            if display.is_empty() {
                caps.get(1).map(|m| m.as_str()).unwrap_or("").to_string()
            } else {
                display.to_string()
            }
        })
        .into_owned();
    s = tag_re().replace_all(&s, " ").into_owned();
    s = head_prefix_re().replace_all(&s, "").into_owned();
    s = quote_re().replace_all(&s, "").into_owned();
    s = task_re().replace_all(&s, "").into_owned();
    s = bullet_re().replace_all(&s, "").into_owned();
    s = ordered_re().replace_all(&s, "").into_owned();
    s = marks_re().replace_all(&s, "").into_owned();
    s = hr_re().replace_all(&s, " ").into_owned();
    s = s.replace('|', " ");
    s = spaces_re().replace_all(&s, " ").into_owned();
    s
}

/// 按 JS 字符串长度（UTF-16 码元）截断，保证中文/emoji 边界与 v3 一致。
pub fn js_truncate(text: &str, max_units: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in text.chars() {
        let w = ch.len_utf16();
        if units + w > max_units {
            break;
        }
        units += w;
        out.push(ch);
    }
    out
}

pub fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn excerpt_of(body: &str, max: usize) -> String {
    let plain = strip_markdown(body);
    let collapsed = regex::Regex::new(r"\s+")
        .unwrap()
        .replace_all(plain.trim(), " ")
        .into_owned();
    if js_len(&collapsed) <= max {
        return collapsed;
    }
    format!("{}…", js_truncate(&collapsed, max).trim_end())
}

fn cjk_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}]").unwrap())
}

fn latin_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*").unwrap()
    })
}

/// 正文里的第一个标题文本（优先一级标题），用来给没起名的文档兜底。
pub fn first_heading_text(body: &str) -> Option<String> {
    let headings = extract_headings(body);
    let pick = headings
        .iter()
        .find(|heading| heading.level == 1)
        .or_else(|| headings.first())?;
    let text = pick.text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// 混合中英文的字数：CJK 按字计，拉丁按词计。
pub fn count_words(body: &str) -> usize {
    let plain = strip_markdown(body);
    let cjk = cjk_re().find_iter(&plain).count();
    let rest = cjk_re().replace_all(&plain, " ");
    let latin = latin_re().find_iter(&rest).count();
    cjk + latin
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_skip_code_fence() {
        let md = "# One\n\n```\n# not heading\n```\n\n## Two\n";
        let hs = extract_headings(md);
        assert_eq!(hs.len(), 2);
        assert_eq!(hs[0].slug, "one");
        assert_eq!(hs[1].level, 2);
    }

    #[test]
    fn wiki_links_with_anchor_and_display() {
        let links = extract_wiki_links("a [[Target#Sec|显示]] b [[Other]]");
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].target, "Target");
        assert_eq!(links[0].anchor.as_deref(), Some("Sec"));
        assert_eq!(links[0].display.as_deref(), Some("显示"));
        assert_eq!(links[1].target, "Other");
    }

    #[test]
    fn word_count_mixed() {
        assert_eq!(count_words("你好 world"), 3);
    }
}
