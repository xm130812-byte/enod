//! 转换金标准回归（PRD §4.3 / §4.20）：Rust 适配层输出与 Node 快照逐字比对。

use reader_core::adapt::{convert_to_markdown, kind_of, DocKind};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Snapshot {
    source: String,
    kind: String,
    title: String,
    #[serde(default)]
    warnings: Vec<String>,
    markdown: String,
}

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn first_diff(a: &str, b: &str) -> String {
    let a_lines: Vec<&str> = a.lines().collect();
    let b_lines: Vec<&str> = b.lines().collect();
    for i in 0..a_lines.len().max(b_lines.len()) {
        let left = a_lines.get(i).copied().unwrap_or("<EOF>");
        let right = b_lines.get(i).copied().unwrap_or("<EOF>");
        if left != right {
            return format!(
                "line {}\n  node: {:?}\n  rust: {:?}",
                i + 1,
                truncate(left, 200),
                truncate(right, 200)
            );
        }
    }
    "no line diff (trailing whitespace?)".into()
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

#[tokio::test]
async fn golden_conversions_match_node() {
    let golden_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/golden");
    let mut entries: Vec<_> = std::fs::read_dir(&golden_dir)
        .expect("golden dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    entries.sort_by_key(|e| e.file_name());

    let root = workspace_root().join("sample-library");
    let mut failures = Vec::new();

    for entry in entries {
        let raw = std::fs::read_to_string(entry.path()).expect("read snapshot");
        let snapshot: Snapshot = serde_json::from_str(&raw).expect("parse snapshot");
        let kind = kind_of(&snapshot.source).expect("kind");
        assert_eq!(kind.as_str(), snapshot.kind);
        if kind == DocKind::Md {
            continue;
        }
        let abs = root.join(&snapshot.source);
        let buffer = std::fs::read(&abs).expect("read source");
        let derived = convert_to_markdown(&buffer, &abs, &snapshot.source, kind, &root).await;
        if derived.title != snapshot.title {
            failures.push(format!(
                "{}: title\n  node: {:?}\n  rust: {:?}",
                snapshot.source, snapshot.title, derived.title
            ));
        }
        if derived.markdown != snapshot.markdown {
            failures.push(format!(
                "{}: markdown mismatch ({} vs {} chars)\n  {}",
                snapshot.source,
                snapshot.markdown.chars().count(),
                derived.markdown.chars().count(),
                first_diff(&snapshot.markdown, &derived.markdown)
            ));
        }
        let _ = &snapshot.warnings;
    }

    if !failures.is_empty() {
        panic!("金标准不匹配：\n{}", failures.join("\n\n"));
    }
}
