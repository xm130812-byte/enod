//! 中文检索分词：jieba-rs + CJK bigram 兜底。

use jieba_rs::Jieba;
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

fn jieba() -> &'static Jieba {
    static JIEBA: OnceLock<Jieba> = OnceLock::new();
    JIEBA.get_or_init(Jieba::new)
}

pub fn normalize(text: &str) -> String {
    text.nfc().collect::<String>().to_lowercase()
}

fn useful_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\p{L}\p{N}]").unwrap())
}

fn is_useful_token(token: &str) -> bool {
    !token.is_empty() && useful_re().is_match(token)
}

pub fn segment_words(text: &str) -> Vec<String> {
    let normalized = normalize(text);
    let mut out = Vec::new();
    for token in jieba().cut(&normalized, false) {
        let token = token.word.trim();
        if is_useful_token(token) {
            out.push(token.to_string());
        }
    }
    out
}

fn cjk_run_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}\x{f900}-\x{faff}]+").unwrap())
}

pub fn cjk_bigrams(text: &str) -> Vec<String> {
    let normalized = normalize(text);
    let mut out = Vec::new();
    for m in cjk_run_re().find_iter(&normalized) {
        let run: Vec<char> = m.as_str().chars().collect();
        if run.len() == 1 {
            out.push(run[0].to_string());
            continue;
        }
        for i in 0..run.len() - 1 {
            out.push(format!("{}{}", run[i], run[i + 1]));
        }
        // 单字也入库：Intl.Segmenter 会把 OOV 词切成单字，兜底查询需要能命中
        for ch in &run {
            out.push(ch.to_string());
        }
    }
    out
}

/// 单字兜底查询：`"重" AND "构"`（对齐 Intl.Segmenter 对 OOV 词的切分行为）。
pub fn build_char_query(query: &str) -> Option<String> {
    let normalized = normalize(query);
    let mut chars: Vec<String> = Vec::new();
    for m in cjk_run_re().find_iter(&normalized) {
        for ch in m.as_str().chars() {
            if !chars.iter().any(|c| c == &ch.to_string()) {
                chars.push(ch.to_string());
            }
        }
    }
    if chars.len() < 2 || chars.len() > 8 {
        return None;
    }
    Some(
        chars
            .iter()
            .map(|c| format!("\"{}\"", escape_token(c)))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

pub fn dedupe(tokens: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(tokens.len());
    for t in tokens {
        if seen.insert(t.clone()) {
            out.push(t);
        }
    }
    out
}

pub fn fts_token_string(text: &str) -> String {
    dedupe(segment_words(text)).join(" ")
}

pub fn fts_bigram_string(text: &str) -> String {
    dedupe(cjk_bigrams(text)).join(" ")
}

fn escape_token(token: &str) -> String {
    token.replace('"', "\"\"")
}

pub fn build_match_query(query: &str) -> Option<String> {
    let words: Vec<String> = dedupe(segment_words(query))
        .into_iter()
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return None;
    }
    Some(
        words
            .iter()
            .map(|w| format!("\"{}\"", escape_token(w)))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

pub fn build_bigram_query(query: &str) -> Option<String> {
    let grams = dedupe(cjk_bigrams(query));
    if grams.is_empty() {
        return None;
    }
    Some(
        grams
            .iter()
            .map(|g| format!("\"{}\"", escape_token(g)))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

pub fn has_cjk(text: &str) -> bool {
    cjk_run_re().is_match(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bigrams_and_query() {
        assert_eq!(
            cjk_bigrams("中文检索"),
            vec!["中文", "文检", "检索", "中", "文", "检", "索"]
        );
        let q = build_match_query("中文 检索").unwrap();
        assert!(q.contains("AND"));
        let cq = build_char_query("中文检索").unwrap();
        assert_eq!(cq, "\"中\" AND \"文\" AND \"检\" AND \"索\"");
    }
}
