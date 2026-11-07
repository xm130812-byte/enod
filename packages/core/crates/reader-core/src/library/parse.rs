//! 单文件解析：md 走 frontmatter，非 md 走适配层派生正文。

use crate::adapt::{derived_doc_id, DocKind, DerivedDoc};
use crate::db::DocRecord;
use crate::encoding::{decode_file, FileEncoding};
use crate::frontmatter::{
    parse_layout, read_ai_enabled, read_aliases, read_created, read_reader_meta, read_source,
    read_tags, read_title, AiEntry, Annotation, DocStatus, DocumentLayout, SourceInfo,
};
use crate::hash::hash_buffer;
use crate::markdown::{
    count_words, excerpt_of, extract_headings, extract_wiki_links, HeadingRef,
};
use crate::tokenizer::{fts_bigram_string, fts_token_string};
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Clone, Debug)]
pub struct ParsedDocFile {
    pub rel_path: String,
    pub buffer: Vec<u8>,
    pub mtime: i64,
    pub size: i64,
    pub hash: String,
    pub encoding: FileEncoding,
    pub eol: String,
    pub layout: DocumentLayout,
    pub frontmatter: Option<Value>,
    pub body: String,
    pub title: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub status: DocStatus,
    pub progress: f64,
    pub annotations: Vec<Annotation>,
    pub ai: Vec<AiEntry>,
    pub ai_enabled: bool,
    pub reader_id: Option<String>,
    pub created: Option<String>,
    pub source: Option<SourceInfo>,
    pub words: usize,
    pub excerpt: String,
    pub headings: Vec<HeadingRef>,
    pub links: Vec<(String, Option<String>)>,
    pub record: DocRecord,
}

fn fence_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s{0,3}(`{3,}|~{3,})").unwrap())
}

/// 去掉围栏代码块，避免把示例里的 [[链接]] 当成真链接。
pub fn strip_fenced_code(body: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut fence: Option<char> = None;
    for raw in body.split('\n') {
        let line = raw.trim_end_matches('\r');
        if let Some(caps) = fence_line_re().captures(line) {
            let marker = caps
                .get(1)
                .and_then(|m| m.as_str().chars().next())
                .unwrap_or('`');
            match fence {
                None => {
                    fence = Some(marker);
                    out.push("");
                    continue;
                }
                Some(ch) if ch == marker => {
                    fence = None;
                    out.push("");
                    continue;
                }
                _ => {}
            }
        }
        out.push(if fence.is_none() { line } else { "" });
    }
    out.join("\n")
}

fn base_name(rel_path: &str) -> &str {
    rel_path.rsplit('/').next().unwrap_or(rel_path)
}

fn title_fallback(rel_path: &str) -> String {
    let name = base_name(rel_path);
    let lower = name.to_lowercase();
    if lower.ends_with(".md") {
        name[..name.len() - 3].to_string()
    } else {
        name.to_string()
    }
}

fn collect_links(body: &str) -> Vec<(String, Option<String>)> {
    let mut seen = std::collections::HashSet::new();
    let mut links = Vec::new();
    for r in extract_wiki_links(body) {
        let key = format!("{}\u{0}{}", r.target, r.anchor.clone().unwrap_or_default());
        if seen.insert(key) {
            links.push((r.target, r.anchor));
        }
    }
    links
}

pub fn parse_doc_buffer(rel_path: &str, buffer: &[u8], mtime: i64, size: i64) -> ParsedDocFile {
    let decoded = decode_file(buffer);
    let layout = parse_layout(&decoded.text);
    let headings = extract_headings(&layout.body);
    let body = layout.body.clone();
    let title = read_title(&layout.frontmatter)
        .or_else(|| headings.first().map(|h| h.text.clone()))
        .unwrap_or_else(|| title_fallback(rel_path));
    let tags = read_tags(&layout.frontmatter);
    let aliases = read_aliases(&layout.frontmatter);
    let meta = read_reader_meta(&layout.frontmatter, "");
    let ai_enabled = read_ai_enabled(&layout.frontmatter);
    let reader_id = if meta.id.is_empty() { None } else { Some(meta.id.clone()) };
    let created = read_created(&layout.frontmatter);
    let source = read_source(&layout.frontmatter);
    let words = count_words(&layout.body);
    let excerpt = excerpt_of(&layout.body, 140);
    let hash = hash_buffer(buffer);

    let links = collect_links(&strip_fenced_code(&layout.body));
    let notes = meta
        .annotations
        .iter()
        .map(|a| format!("{} {}", a.note, a.exact))
        .collect::<Vec<_>>()
        .join(" \n ");
    let now = chrono::Utc::now().timestamp_millis();

    let record = DocRecord {
        id: reader_id.clone().unwrap_or_default(),
        rel_path: rel_path.to_string(),
        kind: "md".into(),
        meta_path: None,
        mtime,
        size,
        hash: hash.clone(),
        title: title.clone(),
        tags: tags.clone(),
        aliases: aliases.clone(),
        status: meta.status,
        progress: meta.progress,
        words: words as i64,
        excerpt: excerpt.clone(),
        source_url: source.as_ref().and_then(|s| s.url.clone()),
        encoding: decoded.encoding.as_str().into(),
        eol: decoded.eol.clone(),
        created: created.clone(),
        indexed_at: now,
        ann_count: meta.annotations.len() as i64,
        title_tokens: fts_token_string(&format!("{} {}", title, aliases.join(" "))),
        body_tokens: fts_token_string(&layout.body),
        tags_tokens: fts_token_string(&tags.join(" ")),
        notes_tokens: fts_token_string(&notes),
        bigrams: fts_bigram_string(&format!("{} {}", title, layout.body)),
    };

    ParsedDocFile {
        rel_path: rel_path.to_string(),
        buffer: buffer.to_vec(),
        mtime,
        size,
        hash,
        encoding: decoded.encoding,
        eol: decoded.eol,
        frontmatter: layout.frontmatter.clone(),
        body,
        layout,
        title,
        tags,
        aliases,
        status: meta.status,
        progress: meta.progress,
        annotations: meta.annotations,
        ai: meta.ai,
        ai_enabled,
        reader_id,
        created,
        source,
        words,
        excerpt,
        headings,
        links,
        record,
    }
}

fn fence_only_lines_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)^```[\w-]*$").unwrap())
}

pub fn parse_derived_doc(
    rel_path: &str,
    buffer: &[u8],
    mtime: i64,
    size: i64,
    derived: &DerivedDoc,
    kind: DocKind,
) -> ParsedDocFile {
    let (encoding, eol) = if derived.binary {
        (FileEncoding::Utf8, "\n".to_string())
    } else {
        let d = decode_file(buffer);
        (d.encoding, d.eol)
    };
    let body = derived.markdown.clone();
    let headings = extract_headings(&body);
    let title = {
        let t = derived.title.trim();
        if !t.is_empty() {
            t.to_string()
        } else if let Some(h) = headings.first() {
            h.text.clone()
        } else {
            let name = base_name(rel_path);
            match name.rsplit_once('.') {
                Some((stem, _)) => stem.to_string(),
                None => name.to_string(),
            }
        }
    };
    let hash = hash_buffer(buffer);
    let words_source = if derived.scan_links_in_code {
        fence_only_lines_re().replace_all(&body, "").into_owned()
    } else {
        body.clone()
    };
    let words = count_words(&words_source);
    let excerpt = excerpt_of(&body, 140);
    let link_source = if derived.scan_links_in_code {
        body.clone()
    } else {
        strip_fenced_code(&body)
    };
    let links = collect_links(&link_source);
    let now = chrono::Utc::now().timestamp_millis();

    let layout = DocumentLayout {
        text: body.clone(),
        eol: eol.clone(),
        has_frontmatter: false,
        frontmatter: None,
        frontmatter_text: String::new(),
        body: body.clone(),
        body_offset: 0,
        yaml_start: 0,
        closing_fence_start: 0,
        yaml_error: None,
    };

    let record = DocRecord {
        id: String::new(),
        rel_path: rel_path.to_string(),
        kind: kind.as_str().into(),
        meta_path: None,
        mtime,
        size,
        hash: hash.clone(),
        title: title.clone(),
        tags: vec![],
        aliases: vec![],
        status: DocStatus::Unread,
        progress: 0.0,
        words: words as i64,
        excerpt: excerpt.clone(),
        source_url: None,
        encoding: encoding.as_str().into(),
        eol: eol.clone(),
        created: None,
        indexed_at: now,
        ann_count: 0,
        title_tokens: fts_token_string(&title),
        body_tokens: fts_token_string(&body),
        tags_tokens: String::new(),
        notes_tokens: String::new(),
        bigrams: fts_bigram_string(&format!("{title} {body}")),
    };

    ParsedDocFile {
        rel_path: rel_path.to_string(),
        buffer: buffer.to_vec(),
        mtime,
        size,
        hash,
        encoding,
        eol,
        layout,
        frontmatter: None,
        body,
        title,
        tags: vec![],
        aliases: vec![],
        status: DocStatus::Unread,
        progress: 0.0,
        annotations: vec![],
        ai: Vec::new(),
        ai_enabled: false,
        reader_id: None,
        created: None,
        source: None,
        words,
        excerpt,
        headings,
        links,
        record,
    }
}

pub fn derived_id_for(rel_path: &str) -> String {
    derived_doc_id(rel_path)
}
