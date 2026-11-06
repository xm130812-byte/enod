//! frontmatter 解析与「保字节」局部改写（PRD §4.18）。
//!
//! - 只用 serde_yaml 解析，绝不整体重新序列化用户的 frontmatter；
//! - 写回只替换目标键/块，保留键序、注释、缩进与换行。

pub mod patch;

use crate::encoding::apply_eol;
use chrono::{SecondsFormat, Utc};
use patch::{FrontmatterEditor, Scalar};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use patch::format_scalar;

#[derive(Clone, Debug, Default)]
pub struct DocumentLayout {
    pub text: String,
    pub eol: String,
    pub has_frontmatter: bool,
    pub frontmatter: Option<Value>,
    pub frontmatter_text: String,
    pub body: String,
    pub body_offset: usize,
    pub yaml_start: usize,
    pub closing_fence_start: usize,
    pub yaml_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocStatus {
    #[default]
    Unread,
    Reading,
    Done,
}

impl DocStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            DocStatus::Unread => "unread",
            DocStatus::Reading => "reading",
            DocStatus::Done => "done",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "unread" => Some(DocStatus::Unread),
            "reading" => Some(DocStatus::Reading),
            "done" => Some(DocStatus::Done),
            _ => None,
        }
    }
}

pub const ANNOTATION_COLORS: [&str; 4] = ["yellow", "green", "blue", "pink"];

pub fn is_color(value: &str) -> bool {
    ANNOTATION_COLORS.contains(&value)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
    pub pos: i64,
    pub color: String,
    pub note: String,
    pub created: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SourceInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipped_at: Option<String>,
}

impl SourceInfo {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        if let Some(v) = &self.url {
            m.insert("url".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.site {
            m.insert("site".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.author {
            m.insert("author".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.published {
            m.insert("published".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.clipped_at {
            m.insert("clipped_at".into(), Value::String(v.clone()));
        }
        Value::Object(m)
    }
}

#[derive(Clone, Debug, Default)]
pub struct ReaderMeta {
    pub id: String,
    pub status: DocStatus,
    pub progress: f64,
    pub annotations: Vec<Annotation>,
}

fn line_start_after(text: &str, index: usize) -> usize {
    match text[index..].find('\n') {
        Some(pos) => index + pos + 1,
        None => text.len(),
    }
}

fn strip_line_ending(line: &str) -> &str {
    line.trim_end_matches('\n').trim_end_matches('\r')
}

/// 解析整个文件：frontmatter / 正文 / 边界。
pub fn parse_layout(text: &str) -> DocumentLayout {
    let eol = crate::encoding::detect_eol(text);
    let first_line_end = line_start_after(text, 0);
    let first_line = strip_line_ending(&text[..first_line_end]);
    let fence_line = first_line.trim_end();

    let no_frontmatter = |text: &str, eol: &str| DocumentLayout {
        text: text.to_string(),
        eol: eol.to_string(),
        has_frontmatter: false,
        frontmatter: None,
        frontmatter_text: String::new(),
        body: text.to_string(),
        body_offset: 0,
        yaml_start: 0,
        closing_fence_start: 0,
        yaml_error: None,
    };

    if fence_line != "---" {
        return no_frontmatter(text, &eol);
    }

    let mut cursor = first_line_end;
    let mut closing_start: Option<usize> = None;
    let mut closing_end = text.len();
    while cursor <= text.len() {
        let next = line_start_after(text, cursor);
        let line = strip_line_ending(&text[cursor..next]);
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            closing_start = Some(cursor);
            closing_end = next;
            break;
        }
        if next == cursor {
            break;
        }
        cursor = next;
    }

    let Some(closing_start) = closing_start else {
        // 只有开栅栏、没有闭合：视为没有 frontmatter
        return no_frontmatter(text, &eol);
    };

    let frontmatter_text = &text[first_line_end..closing_start];
    let mut frontmatter: Option<Value> = None;
    let mut yaml_error: Option<String> = None;
    match serde_yaml::from_str::<serde_yaml::Value>(frontmatter_text) {
        Ok(v) => match yaml_to_json(v) {
            Value::Null => {}
            Value::Object(map) => frontmatter = Some(Value::Object(map)),
            _ => yaml_error = Some("frontmatter 不是映射（mapping）".into()),
        },
        Err(err) => yaml_error = Some(err.to_string()),
    }

    DocumentLayout {
        text: text.to_string(),
        eol,
        has_frontmatter: true,
        frontmatter,
        frontmatter_text: frontmatter_text.to_string(),
        body: text[closing_end..].to_string(),
        body_offset: closing_end,
        yaml_start: first_line_end,
        closing_fence_start: closing_start,
        yaml_error,
    }
}

pub fn yaml_to_json(value: serde_yaml::Value) -> Value {
    match value {
        serde_yaml::Value::Null => Value::Null,
        serde_yaml::Value::Bool(b) => Value::Bool(b),
        serde_yaml::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(u) = n.as_u64() {
                Value::from(u)
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            }
        }
        serde_yaml::Value::String(s) => Value::String(s),
        serde_yaml::Value::Sequence(seq) => {
            Value::Array(seq.into_iter().map(yaml_to_json).collect())
        }
        serde_yaml::Value::Mapping(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                let key = match k {
                    serde_yaml::Value::String(s) => s,
                    other => serde_yaml::to_string(&other)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                };
                out.insert(key, yaml_to_json(v));
            }
            Value::Object(out)
        }
        serde_yaml::Value::Tagged(tagged) => yaml_to_json(tagged.value),
    }
}

/* ------------------------------------------------------------------ 值读取 */

fn as_object(value: &Option<Value>) -> Option<&Map<String, Value>> {
    value.as_ref().and_then(|v| v.as_object())
}

pub fn read_reader_meta(frontmatter: &Option<Value>, fallback_id: &str) -> ReaderMeta {
    let reader = as_object(frontmatter)
        .and_then(|m| m.get("reader"))
        .and_then(|v| v.as_object());
    let raw_id = reader
        .and_then(|r| r.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_id)
        .to_string();
    let status = reader
        .and_then(|r| r.get("status"))
        .and_then(|v| v.as_str())
        .and_then(DocStatus::parse)
        .unwrap_or(DocStatus::Unread);
    let progress = reader
        .and_then(|r| r.get("progress"))
        .map(|v| match v {
            Value::Number(n) => n.as_f64().unwrap_or(0.0),
            Value::String(s) => s.trim().parse::<f64>().unwrap_or(0.0),
            Value::Bool(b) => {
                if *b { 1.0 } else { 0.0 }
            }
            _ => 0.0,
        })
        .filter(|f| f.is_finite())
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);

    let mut annotations = Vec::new();
    if let Some(items) = reader
        .and_then(|r| r.get("annotations"))
        .and_then(|v| v.as_array())
    {
        for raw in items {
            let Some(obj) = raw.as_object() else { continue };
            let Some(exact) = obj.get("exact").and_then(|v| v.as_str()) else {
                continue;
            };
            if exact.is_empty() {
                continue;
            }
            let id = obj
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("ann-{}", annotations.len() + 1));
            let color = obj
                .get("color")
                .and_then(|v| v.as_str())
                .filter(|s| is_color(s))
                .unwrap_or("yellow")
                .to_string();
            annotations.push(Annotation {
                id,
                exact: exact.to_string(),
                prefix: obj
                    .get("prefix")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                suffix: obj
                    .get("suffix")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                pos: obj
                    .get("pos")
                    .and_then(|v| v.as_f64())
                    .filter(|f| f.is_finite())
                    .map(|f| f as i64)
                    .unwrap_or(0),
                color,
                note: obj
                    .get("note")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                created: obj
                    .get("created")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }

    ReaderMeta {
        id: raw_id,
        status,
        progress,
        annotations,
    }
}

pub fn read_tags(frontmatter: &Option<Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: &Value| {
        if let Value::String(s) = v {
            for part in s.split([',', '，']) {
                let t = part.trim().trim_start_matches('#');
                if !t.is_empty() && !out.iter().any(|x| x == t) {
                    out.push(t.to_string());
                }
            }
        }
    };
    match as_object(frontmatter).and_then(|m| m.get("tags")) {
        Some(Value::Array(items)) => items.iter().for_each(&mut push),
        Some(v) => push(v),
        None => {}
    }
    out
}

pub fn read_aliases(frontmatter: &Option<Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |v: &Value| {
        if let Value::String(s) = v {
            let t = s.trim();
            if !t.is_empty() && !out.iter().any(|x| x == t) {
                out.push(t.to_string());
            }
        }
    };
    let map = as_object(frontmatter);
    let raw = map
        .and_then(|m| m.get("aliases"))
        .or_else(|| map.and_then(|m| m.get("alias")));
    match raw {
        Some(Value::Array(items)) => items.iter().for_each(&mut push),
        Some(v) => push(v),
        None => {}
    }
    out
}

pub fn read_title(frontmatter: &Option<Value>) -> Option<String> {
    as_object(frontmatter)
        .and_then(|m| m.get("title"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

pub fn read_created(frontmatter: &Option<Value>) -> Option<String> {
    let map = as_object(frontmatter)?;
    let raw = map.get("created").or_else(|| map.get("date"))?;
    match raw {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        _ => None,
    }
}

pub fn read_source(frontmatter: &Option<Value>) -> Option<SourceInfo> {
    let raw = as_object(frontmatter)?.get("source")?.as_object()?;
    let pick = |k: &str| {
        raw.get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
    };
    let info = SourceInfo {
        url: pick("url"),
        site: pick("site"),
        author: pick("author"),
        published: pick("published"),
        clipped_at: pick("clipped_at"),
    };
    if info.url.is_none()
        && info.site.is_none()
        && info.author.is_none()
        && info.published.is_none()
        && info.clipped_at.is_none()
    {
        return None;
    }
    Some(info)
}

/* ------------------------------------------------------------------ 写回 */

pub fn iso_now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 生成一条全新的 frontmatter（仅用于新建文档 / 剪藏）。
pub fn build_frontmatter(fields: BuildFrontmatter<'_>) -> String {
    let mut lines: Vec<String> = vec!["---".into()];
    lines.push(format!("title: {}", format_scalar(&Scalar::Str(fields.title.into()))));
    let tags = fields
        .tags
        .unwrap_or(&[])
        .iter()
        .map(|t| format_scalar(&Scalar::Str(t.clone())))
        .collect::<Vec<_>>()
        .join(", ");
    lines.push(format!("tags: [{tags}]"));
    if let Some(aliases) = fields.aliases {
        if !aliases.is_empty() {
            let list = aliases
                .iter()
                .map(|t| format_scalar(&Scalar::Str(t.clone())))
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("aliases: [{list}]"));
        }
    }
    lines.push(format!(
        "created: {}",
        fields.created.unwrap_or_else(|| iso_now())
    ));
    if let Some(source) = fields.source {
        lines.push("source:".into());
        let pairs = [
            ("url", &source.url),
            ("site", &source.site),
            ("author", &source.author),
            ("published", &source.published),
            ("clipped_at", &source.clipped_at),
        ];
        for (k, v) in pairs {
            if let Some(v) = v {
                if !v.is_empty() {
                    lines.push(format!("  {k}: {}", format_scalar(&Scalar::Str(v.clone()))));
                }
            }
        }
    }
    lines.push("reader:".into());
    lines.push(format!("  id: {}", fields.id));
    lines.push(format!("  status: {}", fields.status.unwrap_or("unread")));
    lines.push("  progress: 0".into());
    lines.push("  annotations: []".into());
    lines.push("---".into());
    lines.push(String::new());
    lines.join("\n")
}

pub struct BuildFrontmatter<'a> {
    pub title: &'a str,
    pub id: &'a str,
    pub status: Option<&'a str>,
    pub tags: Option<&'a [String]>,
    pub aliases: Option<&'a [String]>,
    pub created: Option<String>,
    pub source: Option<SourceInfo>,
}

#[derive(Clone, Debug, Default)]
pub struct ReaderPatch {
    pub id: Option<String>,
    pub status: Option<DocStatus>,
    pub progress: Option<f64>,
    pub annotations: Option<Vec<Annotation>>,
}

#[derive(Clone, Debug, Default)]
pub struct DocumentEdits {
    pub body: Option<String>,
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub reader: Option<ReaderPatch>,
}

/// 在一次保存中同时应用：正文替换 + reader 字段补丁。
pub fn apply_document_edits(layout: &DocumentLayout, edits: &DocumentEdits) -> String {
    let mut current = layout.clone();

    if !current.has_frontmatter {
        let fm = build_frontmatter(BuildFrontmatter {
            title: edits.title.as_deref().unwrap_or("未命名"),
            id: edits
                .reader
                .as_ref()
                .and_then(|r| r.id.as_deref())
                .unwrap_or("unknown"),
            status: edits
                .reader
                .as_ref()
                .and_then(|r| r.status)
                .map(|s| s.as_str()),
            tags: None,
            aliases: None,
            created: None,
            source: None,
        });
        let text = apply_eol(&fm, &current.eol) + &current.body;
        current = parse_layout(&text);
    }

    let mut editor = FrontmatterEditor::from_layout(&current);

    if let Some(title) = &edits.title {
        editor.set_scalar(&["title"], Scalar::Str(title.clone()));
    }
    if let Some(tags) = &edits.tags {
        editor.set_flow_list(&["tags"], tags);
    }

    if let Some(reader) = &edits.reader {
        if let Some(id) = &reader.id {
            if !id.is_empty() {
                editor.set_scalar(&["reader", "id"], Scalar::Str(id.clone()));
            }
        }
        if let Some(status) = reader.status {
            editor.set_scalar(&["reader", "status"], Scalar::Str(status.as_str().into()));
        }
        if let Some(progress) = reader.progress {
            editor.set_scalar(
                &["reader", "progress"],
                Scalar::Num(round_progress(progress)),
            );
        }
        if let Some(annotations) = &reader.annotations {
            let items: Vec<Vec<(&str, Scalar)>> = annotations
                .iter()
                .map(|a| {
                    vec![
                        ("id", Scalar::Str(a.id.clone())),
                        ("exact", Scalar::Str(a.exact.clone())),
                        ("prefix", Scalar::Str(a.prefix.clone())),
                        ("suffix", Scalar::Str(a.suffix.clone())),
                        ("pos", Scalar::Num(a.pos as f64)),
                        ("color", Scalar::Str(a.color.clone())),
                        ("note", Scalar::Str(a.note.clone())),
                        ("created", Scalar::Str(a.created.clone())),
                    ]
                })
                .collect();
            editor.set_list(&["reader", "annotations"], &items);
        }
    }

    let head = &current.text[..current.yaml_start];
    let closing = &current.text[current.closing_fence_start..current.body_offset];
    let body = match &edits.body {
        Some(b) => apply_eol(b, &current.eol),
        None => current.body.clone(),
    };
    format!("{head}{}{closing}{body}", editor.render())
}

fn round_progress(v: f64) -> f64 {
    (v.clamp(0.0, 1.0) * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\ntitle: Hello\ntags: [a, b]\nreader:\n  id: 01ABC\n  status: reading\n  progress: 0.2\n  annotations: []\n---\nBody text\n";

    #[test]
    fn parses_layout_and_meta() {
        let layout = parse_layout(SAMPLE);
        assert!(layout.has_frontmatter);
        assert_eq!(layout.body, "Body text\n");
        let meta = read_reader_meta(&layout.frontmatter, "");
        assert_eq!(meta.id, "01ABC");
        assert_eq!(meta.status, DocStatus::Reading);
        assert_eq!(read_tags(&layout.frontmatter), vec!["a", "b"]);
    }

    #[test]
    fn patch_keeps_comments_and_key_order() {
        let text = "---\n# top comment\ntitle: Hello\ntags: [a, b]\nreader:\n  id: 01ABC\n  status: reading\n---\nBody\n";
        let layout = parse_layout(text);
        let out = apply_document_edits(
            &layout,
            &DocumentEdits {
                body: Some("New body\n".into()),
                reader: Some(ReaderPatch {
                    status: Some(DocStatus::Done),
                    progress: Some(0.5),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert!(out.contains("# top comment\ntitle: Hello"));
        assert!(out.contains("  status: done"));
        assert!(out.contains("  progress: 0.5"));
        assert!(out.ends_with("New body\n"));
    }

    #[test]
    fn inserts_frontmatter_when_missing() {
        let layout = parse_layout("Hello\n");
        let out = apply_document_edits(
            &layout,
            &DocumentEdits {
                title: Some("T".into()),
                reader: Some(ReaderPatch {
                    id: Some("01ID".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert!(out.starts_with("---\ntitle: T\n"));
        assert!(out.contains("  id: 01ID"));
        assert!(out.ends_with("Hello\n"));
    }
}
