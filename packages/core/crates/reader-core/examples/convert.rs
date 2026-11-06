//! 调试用：把单个文件转换成 markdown 并打印（不启动服务）。
//! cargo run -p reader-core --example convert -- <rel-path>

use reader_core::adapt::{convert_to_markdown, kind_of};
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let rel = std::env::args().nth(1).expect("usage: convert <rel-path>");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../sample-library");
    let abs = root.join(&rel);
    let buffer = std::fs::read(&abs).expect("read source");
    let kind = kind_of(&rel).expect("kind");
    let derived = convert_to_markdown(&buffer, &abs, &rel, kind, &root).await;
    println!("TITLE: {}", derived.title);
    println!("WARNINGS: {:?}", derived.warnings);
    println!("---MARKDOWN---");
    print!("{}", derived.markdown);
}
