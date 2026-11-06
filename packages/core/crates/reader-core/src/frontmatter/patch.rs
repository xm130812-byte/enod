//! frontmatter 行级编辑器：只改动目标键所在的行，其余字节原样保留。

use crate::frontmatter::DocumentLayout;
use regex::Regex;
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq)]
pub enum Scalar {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

const RESERVED: [&str; 13] = [
    "true", "false", "null", "yes", "no", "on", "off", "~", "True", "False", "Null", "Yes", "No",
];

fn plain_safe_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^[A-Za-z0-9_\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}][A-Za-z0-9_\-. \x{3400}-\x{4dbf}\x{4e00}-\x{9fff}/]*$").unwrap()
    })
}

fn number_like_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$").unwrap())
}

fn key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(\s*)([A-Za-z0-9_$.\-\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}/]+)\s*:").unwrap()
    })
}

fn item_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\s*)-\s+(.*)$").unwrap())
}

/// YAML 标量序列化：能不加引号就不加；引号内的转义与 v3 一致。
pub fn format_scalar(value: &Scalar) -> String {
    match value {
        Scalar::Null => "null".into(),
        Scalar::Bool(b) => {
            if *b {
                "true".into()
            } else {
                "false".into()
            }
        }
        Scalar::Num(n) => {
            if !n.is_finite() {
                return "null".into();
            }
            if n.fract() == 0.0 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                n.to_string()
            }
        }
        Scalar::Str(s) => {
            if s.is_empty() {
                return "\"\"".into();
            }
            let has_edge_space = s.starts_with(char::is_whitespace) || s.ends_with(char::is_whitespace);
            if plain_safe_re().is_match(s)
                && !RESERVED.contains(&s.as_str())
                && !number_like_re().is_match(s)
                && !has_edge_space
            {
                return s.clone();
            }
            let escaped = s
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
                .replace('\t', "\\t");
            format!("\"{escaped}\"")
        }
    }
}

fn split_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|line| line.trim_end_matches('\r').to_string())
        .collect()
}

fn indent_of(line: &str) -> usize {
    line.chars().take_while(|c| c.is_whitespace()).count()
}

fn is_blank_or_comment(line: &str) -> bool {
    let t = line.trim();
    t.is_empty() || t.starts_with('#')
}

/// 拆出 `key: value  # comment` 的前导空白与注释。
fn split_value_and_comment(rest: &str) -> (String, String) {
    let chars: Vec<char> = rest.chars().collect();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_double {
            if ch == '\\' {
                i += 1;
            } else if ch == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if in_single {
            if ch == '\'' {
                if i + 1 < chars.len() && chars[i + 1] == '\'' {
                    i += 1;
                } else {
                    in_single = false;
                }
            }
            i += 1;
            continue;
        }
        match ch {
            '"' => in_double = true,
            '\'' => in_single = true,
            '#' if i > 0 && chars[i - 1].is_whitespace() => {
                let byte_idx = chars[..i].iter().map(|c| c.len_utf8()).sum::<usize>();
                return (String::new(), rest[byte_idx..].to_string());
            }
            _ => {}
        }
        i += 1;
    }
    let lead_len = rest.len() - rest.trim_start().len();
    (rest[..lead_len].to_string(), String::new())
}

#[derive(Clone, Copy, Debug)]
pub struct KeyLine {
    pub index: usize,
    pub indent: usize,
}

pub struct FrontmatterEditor {
    pub lines: Vec<String>,
    pub eol: String,
}

impl FrontmatterEditor {
    pub fn new(frontmatter_text: &str, eol: &str) -> Self {
        let mut lines = split_lines(frontmatter_text);
        if lines.last().map(|s| s.is_empty()).unwrap_or(false) {
            lines.pop();
        }
        Self {
            lines,
            eol: eol.to_string(),
        }
    }

    pub fn from_layout(layout: &DocumentLayout) -> Self {
        Self::new(&layout.frontmatter_text, &layout.eol)
    }

    /// 某个键行所管辖的块结束位置（不含）。
    fn block_end(&self, index: usize) -> usize {
        let base_indent = indent_of(&self.lines[index]);
        for i in (index + 1)..self.lines.len() {
            let line = &self.lines[i];
            if is_blank_or_comment(line) {
                continue;
            }
            let indent = indent_of(line);
            // 与键同缩进的 `- item` 属于该键的列表块，不能当作块结束
            if item_re().is_match(line) && indent >= base_indent {
                continue;
            }
            if indent <= base_indent {
                return i;
            }
        }
        self.lines.len()
    }

    fn find_in_range(&self, key: &str, from: usize, to: usize, min_indent: usize) -> Option<KeyLine> {
        for i in from..to.min(self.lines.len()) {
            let line = &self.lines[i];
            if is_blank_or_comment(line) {
                continue;
            }
            let indent = indent_of(line);
            if indent < min_indent {
                continue;
            }
            if item_re().is_match(line) {
                continue;
            }
            let Some(caps) = key_re().captures(line) else {
                continue;
            };
            if caps.get(2).map(|m| m.as_str()) == Some(key) {
                return Some(KeyLine { index: i, indent });
            }
        }
        None
    }

    pub fn find_key(&self, path: &[&str]) -> Option<KeyLine> {
        if path.is_empty() {
            return None;
        }
        let mut current: Option<KeyLine> = None;
        for key in path {
            let from = current.map(|c| c.index + 1).unwrap_or(0);
            let to = current.map(|c| self.block_end(c.index)).unwrap_or(self.lines.len());
            let min_indent = current
                .map(|c| indent_of(&self.lines[c.index]) + 1)
                .unwrap_or(0);
            let hit = self.find_in_range(key, from, to, min_indent)?;
            current = Some(hit);
        }
        current
    }

    fn child_indent(&self, parent_index: usize) -> usize {
        let parent_indent = indent_of(&self.lines[parent_index]);
        let end = self.block_end(parent_index);
        for i in (parent_index + 1)..end {
            let line = &self.lines[i];
            if is_blank_or_comment(line) {
                continue;
            }
            if item_re().is_match(line) {
                continue;
            }
            return indent_of(line);
        }
        parent_indent + 2
    }

    fn ensure_parent(&mut self, path: &[&str]) -> Option<KeyLine> {
        if path.is_empty() {
            return None;
        }
        let mut parent: Option<KeyLine> = None;
        for key in path {
            let from = parent.map(|p| p.index + 1).unwrap_or(0);
            let to = parent.map(|p| self.block_end(p.index)).unwrap_or(self.lines.len());
            let min_indent = parent.map(|p| p.indent + 1).unwrap_or(0);
            match self.find_in_range(key, from, to, min_indent) {
                Some(hit) => parent = Some(hit),
                None => {
                    let indent = match parent {
                        Some(p) => self.child_indent(p.index),
                        None => 0,
                    };
                    let insert_at = match parent {
                        Some(p) => self.block_end(p.index),
                        None => self.lines.len(),
                    };
                    self.lines.insert(insert_at, format!("{}{}:", " ".repeat(indent), key));
                    parent = Some(KeyLine {
                        index: insert_at,
                        indent,
                    });
                }
            }
        }
        parent
    }

    /// 设置标量，例如 ['reader','status']。
    pub fn set_scalar(&mut self, path: &[&str], value: Scalar) {
        if path.is_empty() {
            return;
        }
        let key = path[path.len() - 1];
        let formatted = format_scalar(&value);
        if let Some(hit) = self.find_key(path) {
            let line = self.lines[hit.index].clone();
            if item_re().is_match(&line) {
                return;
            }
            let Some(colon) = line.find(':') else { return };
            let key_part = &line[..=colon];
            let rest = &line[colon + 1..];
            let (lead, comment) = split_value_and_comment(rest);
            let sep = if lead.is_empty() { " " } else { lead.as_str() };
            let tail = if comment.is_empty() {
                String::new()
            } else {
                format!(" {comment}")
            };
            self.lines[hit.index] = format!("{key_part}{sep}{formatted}{tail}");
            return;
        }
        let parent_path = &path[..path.len() - 1];
        match self.ensure_parent(parent_path) {
            None => self.lines.push(format!("{key}: {formatted}")),
            Some(parent) => {
                let indent = self.child_indent(parent.index);
                let insert_at = self.block_end(parent.index);
                self.lines
                    .insert(insert_at, format!("{}{key}: {formatted}", " ".repeat(indent)));
            }
        }
    }

    /// 删除键（含其子块）。
    pub fn remove(&mut self, path: &[&str]) {
        let Some(hit) = self.find_key(path) else { return };
        let end = self.block_end(hit.index);
        self.lines.drain(hit.index..end);
    }

    /// 替换为对象列表，例如 reader.annotations。
    pub fn set_list(&mut self, path: &[&str], items: &[Vec<(&str, Scalar)>]) {
        if path.is_empty() {
            return;
        }
        let key = path[path.len() - 1];
        if let Some(hit) = self.find_key(path) {
            let parent = if path.len() > 1 {
                self.find_key(&path[..path.len() - 1])
            } else {
                None
            };
            let indent = parent.map(|p| self.child_indent(p.index)).unwrap_or(0);
            let end = self.block_end(hit.index);
            if items.is_empty() {
                let prefix = format!("{}{}:", " ".repeat(indent), key);
                self.lines
                    .splice(hit.index..end, [format!("{prefix} []")]);
            } else {
                let generated = render_list(key, indent, items);
                self.lines.splice(hit.index..end, generated);
            }
            return;
        }
        let parent = self.ensure_parent(&path[..path.len() - 1]);
        let indent = parent.map(|p| self.child_indent(p.index)).unwrap_or(0);
        let insert_at = parent.map(|p| self.block_end(p.index)).unwrap_or(self.lines.len());
        if items.is_empty() {
            self.lines
                .insert(insert_at, format!("{}{key}: []", " ".repeat(indent)));
        } else {
            let generated = render_list(key, indent, items);
            for (offset, line) in generated.into_iter().enumerate() {
                self.lines.insert(insert_at + offset, line);
            }
        }
    }

    /// 写成内联数组：`tags: [a, b]`（同时清掉旧的块风格列表）。
    pub fn set_flow_list(&mut self, path: &[&str], values: &[String]) {
        if path.is_empty() {
            return;
        }
        let key = path[path.len() - 1];
        let formatted = format!(
            "[{}]",
            values
                .iter()
                .map(|v| format_scalar(&Scalar::Str(v.clone())))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let Some(hit) = self.find_key(path) else {
            let parent = self.ensure_parent(&path[..path.len() - 1]);
            let indent = parent.map(|p| self.child_indent(p.index)).unwrap_or(0);
            let insert_at = parent.map(|p| self.block_end(p.index)).unwrap_or(self.lines.len());
            self.lines
                .insert(insert_at, format!("{}{key}: {formatted}", " ".repeat(indent)));
            return;
        };
        let line = self.lines[hit.index].clone();
        let Some(colon) = line.find(':') else { return };
        let key_part = line[..=colon].trim_end();
        self.lines[hit.index] = format!("{key_part} {formatted}");
        let end = self.block_end(hit.index);
        if end > hit.index + 1 {
            self.lines.drain(hit.index + 1..end);
        }
    }

    pub fn render(&self) -> String {
        if self.lines.is_empty() {
            return String::new();
        }
        format!("{}{}", self.lines.join(&self.eol), self.eol)
    }
}

fn render_list(key: &str, indent: usize, items: &[Vec<(&str, Scalar)>]) -> Vec<String> {
    let pad = " ".repeat(indent);
    let mut out = vec![format!("{pad}{key}:")];
    let item_pad = " ".repeat(indent + 2);
    let key_pad = " ".repeat(indent + 4);
    for item in items {
        if item.is_empty() {
            out.push(format!("{item_pad}- {{}}"));
            continue;
        }
        for (idx, (k, v)) in item.iter().enumerate() {
            let prefix = if idx == 0 {
                format!("{item_pad}- ")
            } else {
                key_pad.clone()
            };
            out.push(format!("{prefix}{k}: {}", format_scalar(v)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_formatting() {
        assert_eq!(format_scalar(&Scalar::Str("hello".into())), "hello");
        assert_eq!(format_scalar(&Scalar::Str("true".into())), "\"true\"");
        assert_eq!(format_scalar(&Scalar::Str("42".into())), "\"42\"");
        assert_eq!(
            format_scalar(&Scalar::Str("a: b".into())),
            "\"a: b\""
        );
        assert_eq!(format_scalar(&Scalar::Num(0.5)), "0.5");
        assert_eq!(format_scalar(&Scalar::Num(1.0)), "1");
    }

    #[test]
    fn editor_only_touches_target_lines() {
        let text = "# a\ntitle: x\ntags:\n  - one\n  - two\nreader:\n  status: unread\n  note: keep\n";
        let mut ed = FrontmatterEditor::new(text, "\n");
        ed.set_flow_list(&["tags"], &["a".into(), "b".into()]);
        ed.set_scalar(&["reader", "status"], Scalar::Str("done".into()));
        let out = ed.render();
        assert!(out.contains("# a\ntitle: x"));
        assert!(out.contains("tags: [a, b]"));
        assert!(out.contains("  status: done"));
        assert!(out.contains("  note: keep"));
    }
}
