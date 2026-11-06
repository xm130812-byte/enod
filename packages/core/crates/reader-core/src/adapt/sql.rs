//! SQL → 一个 ```sql 围栏；注释里的 [[双链]] 仍会被扫描。

use super::DerivedDoc;
use crate::encoding::decode_file;

const MAX_SQL_LINES: usize = 2_000;

pub fn convert(buffer: &[u8]) -> DerivedDoc {
    let decoded = decode_file(buffer);
    let normalized = decoded
        .text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut warnings = Vec::new();
    let mut body = normalized.clone();
    if normalized.split('\n').count() > MAX_SQL_LINES {
        body = normalized
            .split('\n')
            .take(MAX_SQL_LINES)
            .collect::<Vec<_>>()
            .join("\n");
        warnings.push(format!(
            "SQL 超过 {MAX_SQL_LINES} 行，这里只显示前 {MAX_SQL_LINES} 行。"
        ));
    }
    let mut fence = "```".to_string();
    while body.contains(&fence) {
        fence.push('`');
    }
    let markdown = format!(
        "{fence}sql\n{}\n{fence}\n",
        body.trim_end_matches('\n')
    );
    DerivedDoc {
        title: String::new(),
        markdown,
        warnings,
        scan_links_in_code: true,
        binary: false,
    }
}
