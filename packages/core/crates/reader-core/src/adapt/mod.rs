//! 文档格式适配层：所有被索引的格式最终都变成 markdown 正文（PRD §6.3）。

pub mod docx;
pub mod html;
pub mod sql;
pub mod txt;

use crate::hash::hash_buffer;
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocKind {
    Md,
    Txt,
    Sql,
    Html,
    Docx,
}

impl DocKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            DocKind::Md => "md",
            DocKind::Txt => "txt",
            DocKind::Sql => "sql",
            DocKind::Html => "html",
            DocKind::Docx => "docx",
        }
    }

    pub fn is_editable(&self) -> bool {
        // v4 D5：txt / sql 完全可编辑；docx / html 只读
        matches!(self, DocKind::Md | DocKind::Txt | DocKind::Sql)
    }

    pub fn is_annotatable(&self) -> bool {
        true
    }

    pub fn can_convert_to_md(&self) -> bool {
        matches!(self, DocKind::Docx | DocKind::Html)
    }
}

pub fn kind_of(rel_path: &str) -> Option<DocKind> {
    let ext = rel_path.rsplit_once('.').map(|(_, e)| e.to_lowercase())?;
    match ext.as_str() {
        "md" | "markdown" => Some(DocKind::Md),
        "txt" => Some(DocKind::Txt),
        "sql" => Some(DocKind::Sql),
        "html" | "htm" => Some(DocKind::Html),
        "docx" => Some(DocKind::Docx),
        _ => None,
    }
}

pub fn strip_doc_ext(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((base, ext)) if kind_of(&format!("x.{ext}")).is_some() => base.to_string(),
        _ => name.to_string(),
    }
}

/// 非 md 文档没有 frontmatter 存 id；用相对路径哈希派生确定性 id。
pub fn derived_doc_id(rel_path: &str) -> String {
    let normalized: String = {
        use unicode_normalization::UnicodeNormalization;
        rel_path.nfc().collect()
    };
    let digest = hash_buffer(normalized.as_bytes()).to_uppercase();
    format!("01D{}", &digest[..23])
}

#[derive(Clone, Debug)]
pub struct DerivedDoc {
    pub title: String,
    pub markdown: String,
    pub warnings: Vec<String>,
    /// 代码型文档（sql）整篇在围栏里，扫双链时跳过 strip_fenced_code
    pub scan_links_in_code: bool,
    /// 二进制格式（docx）：不做编码探测
    pub binary: bool,
}

struct Lru {
    map: HashMap<String, DerivedDoc>,
    order: VecDeque<String>,
    limit: usize,
}

impl Lru {
    fn new(limit: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            limit,
        }
    }
    fn get(&mut self, key: &str) -> Option<DerivedDoc> {
        let hit = self.map.get(key).cloned();
        if hit.is_some() {
            self.order.retain(|k| k != key);
            self.order.push_back(key.to_string());
        }
        hit
    }
    fn put(&mut self, key: String, value: DerivedDoc) {
        self.map.insert(key.clone(), value);
        self.order.push_back(key);
        while self.order.len() > self.limit {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
    }
}

fn cache() -> &'static Mutex<Lru> {
    static CACHE: OnceLock<Mutex<Lru>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Lru::new(24)))
}

/// 非 markdown 文件 → markdown。root 用于把库内本地图片改写成相对路径。
pub async fn convert_to_markdown(
    buffer: &[u8],
    abs_path: &Path,
    rel_path: &str,
    kind: DocKind,
    root: &Path,
) -> DerivedDoc {
    let key = format!("{}:{}", kind.as_str(), hash_buffer(buffer));
    if let Some(hit) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return hit;
    }
    let derived = match kind {
        DocKind::Html => html::convert(buffer, rel_path, abs_path, root).await,
        DocKind::Sql => sql::convert(buffer),
        DocKind::Docx => docx::convert(buffer, rel_path, root).await,
        DocKind::Txt => txt::convert(buffer),
        DocKind::Md => DerivedDoc {
            title: String::new(),
            markdown: String::new(),
            warnings: vec![],
            scan_links_in_code: false,
            binary: false,
        },
    };
    cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .put(key, derived.clone());
    derived
}
