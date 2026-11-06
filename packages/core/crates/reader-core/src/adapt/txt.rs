//! 纯文本 → markdown：空行分段，单换行保留成硬换行（两个空格）。

use super::DerivedDoc;
use crate::encoding::decode_file;

const MAX_TXT_CHARS: usize = 500_000;

pub fn convert(buffer: &[u8]) -> DerivedDoc {
    let decoded = decode_file(buffer);
    let mut warnings = Vec::new();
    let mut source = decoded.text;
    if source.chars().count() > MAX_TXT_CHARS {
        source = source.chars().take(MAX_TXT_CHARS).collect();
        warnings.push(format!(
            "正文超过 {} 万字，这里只显示前 {} 万字。",
            MAX_TXT_CHARS / 10000,
            MAX_TXT_CHARS / 10000
        ));
    }
    DerivedDoc {
        title: String::new(),
        markdown: text_to_markdown(&source),
        warnings,
        scan_links_in_code: false,
        binary: false,
    }
}

fn is_fence(line: &str) -> Option<char> {
    let trimmed = line.trim_start();
    let indent = line.len() - trimmed.len();
    if indent > 3 {
        return None;
    }
    let mut chars = trimmed.chars();
    let first = chars.next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let count = trimmed.chars().take_while(|c| *c == first).count();
    if count >= 3 {
        Some(first)
    } else {
        None
    }
}

pub fn text_to_markdown(text: &str) -> String {
    let normalized = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut out: Vec<String> = Vec::new();
    let mut fence: Option<char> = None;
    for line in normalized.split('\n') {
        if let Some(ch) = is_fence(line) {
            match fence {
                None => {
                    fence = Some(ch);
                    out.push(line.to_string());
                    continue;
                }
                Some(marker) if marker == ch => {
                    fence = None;
                    out.push(line.to_string());
                    continue;
                }
                _ => {}
            }
        }
        if fence.is_some() || line.trim().is_empty() || line.ends_with("  ") {
            out.push(line.to_string());
        } else {
            out.push(format!("{line}  "));
        }
    }
    out.join("\n")
}
