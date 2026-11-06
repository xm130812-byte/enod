//! reader-core —— md-reader 的内核库：索引、书库、格式转换与 HTTP API。

pub mod adapt;
pub mod atomic;
pub mod clip;
pub mod config;
pub mod db;
pub mod encoding;
pub mod error;
pub mod frontmatter;
pub mod hash;
pub mod http;
pub mod indexer;
pub mod library;
pub mod markdown;
pub mod paths;
pub mod tokenizer;
pub mod ulid;
pub mod version;
pub mod watcher;

pub const APP_NAME: &str = "md-reader";
