//! 书库服务：文档 CRUD、搜索、预览、配置与索引编排（移植自 v3 service.ts）。

pub mod ai;
pub mod annotations;
pub mod assets;
pub mod clip_jobs;
pub mod parse;
pub mod sidecar;

use crate::adapt::{convert_to_markdown, kind_of, strip_doc_ext, DocKind};
use crate::atomic::{atomic_write_file, save_version};
use crate::config::ConfigStore;
use crate::db::{Db, DocRow, ListOptions};
use crate::encoding::{decode_file, encode_file, FileEncoding};
use crate::error::{AppError, AppResult};
use crate::frontmatter::{
    apply_document_edits, build_frontmatter, parse_layout, read_reader_meta, AiEntry, Annotation,
    BuildFrontmatter, DocStatus, DocumentEdits, ReaderPatch, SourceInfo,
};
use crate::hash::hash_buffer;
use crate::http::sse::EventHub;
use crate::indexer::{IndexResult, LibraryIndexer};
use crate::markdown::{extract_headings, js_len, HeadingRef};
use crate::paths::{
    data_paths, ensure_data_dirs, is_inside_root, relative_posix, resolve_in_root, DataPaths,
};
use crate::ulid::new_ulid;
use crate::watcher::{self, WatchEvent, WatcherHandle};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::mpsc::unbounded_channel;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocDTO {
    pub id: String,
    pub rel_path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub status: DocStatus,
    pub progress: f64,
    pub words: i64,
    pub excerpt: String,
    pub source_url: Option<String>,
    pub mtime: i64,
    pub size: i64,
    pub ann_count: i64,
    pub created: Option<String>,
    pub kind: String,
    pub editable: bool,
}

pub(crate) fn dto_from_row(row: &DocRow) -> DocDTO {    let kind = kind_of(&row.rel_path).unwrap_or(DocKind::Md);
    DocDTO {
        id: row.id.clone(),
        rel_path: row.rel_path.clone(),
        title: row.title.clone(),
        tags: row.tags.clone(),
        aliases: row.aliases.clone(),
        status: row.status,
        progress: row.progress,
        words: row.words,
        excerpt: row.excerpt.clone(),
        source_url: row.source_url.clone(),
        mtime: row.mtime,
        size: row.size,
        ann_count: row.ann_count,
        created: row.created.clone(),
        kind: kind.as_str().to_string(),
        editable: kind.is_editable(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutLinkDTO {
    pub dst_id: Option<String>,
    pub dst_raw: String,
    pub dst_title: Option<String>,
    pub anchor: Option<String>,
    pub broken: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkDTO {
    pub src_id: String,
    pub src_title: String,
    pub rel_path: String,
    pub anchor: Option<String>,
    pub context: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPayload {
    #[serde(flatten)]
    pub doc: DocDTO,
    pub body: String,
    pub raw_hash: String,
    pub encoding: String,
    pub eol: String,
    pub annotations: Vec<Annotation>,
    /// AI 落进文档的产出（reader.ai[]）；用户旁注仍在 annotations 里。
    pub ai: Vec<AiEntry>,
    pub ai_enabled: bool,
    pub links: Vec<OutLinkDTO>,
    pub backlinks: Vec<BacklinkDTO>,
    pub headings: Vec<HeadingRef>,
    pub source: Option<SourceInfo>,
    pub frontmatter: Option<Value>,
    pub has_frontmatter: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SaveInput {
    pub body: Option<String>,
    pub base_hash: Option<String>,
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub reader: Option<ReaderPatch>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub hash: String,
    pub mtime: i64,
    pub encoding: String,
    pub reencoded: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub rel_path: String,
    pub status: DocStatus,
    pub tags: Vec<String>,
    pub progress: f64,
    pub snippet: String,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkedMention {
    pub id: String,
    pub title: String,
    pub rel_path: String,
    pub status: DocStatus,
    pub snippet: String,
}

#[derive(Clone, Debug)]
pub struct LibraryStats {
    pub root: Option<String>,
    pub total: i64,
    pub words: i64,
    pub tags: i64,
    pub by_status: HashMap<String, i64>,
    pub indexed_at: Option<i64>,
    pub scanning: bool,
    pub last_scan: Option<IndexResult>,
}

impl LibraryStats {
    pub fn to_json(&self) -> Value {
        let mut by = Map::new();
        for key in ["unread", "reading", "done"] {
            by.insert(key.into(), json!(self.by_status.get(key).copied().unwrap_or(0)));
        }
        by.insert("total".into(), json!(self.total));
        json!({
            "root": self.root,
            "total": self.total,
            "words": self.words,
            "tags": self.tags,
            "byStatus": by,
            "indexedAt": self.indexed_at,
            "scanning": self.scanning,
            "lastScan": self.last_scan,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Loaded {
    pub body: String,
    pub raw_hash: String,
    pub encoding: FileEncoding,
    pub eol: String,
    pub annotations: Vec<Annotation>,
    pub ai: Vec<AiEntry>,
    pub ai_enabled: bool,
    pub headings: Vec<HeadingRef>,
    pub frontmatter: Option<Value>,
    pub has_frontmatter: bool,
    pub source: Option<SourceInfo>,
}

pub struct LibraryService {
    pub paths: DataPaths,
    pub config: Arc<ConfigStore>,
    pub db: Arc<Db>,
    pub hub: EventHub,
    pub root: RwLock<Option<PathBuf>>,
    pub(crate) indexer: Mutex<Option<Arc<LibraryIndexer>>>,
    pub(crate) watcher: Mutex<Option<WatcherHandle>>,
    last_scan: Mutex<Option<IndexResult>>,
    scan_guard: tokio::sync::Mutex<()>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub(crate) clip_jobs: Mutex<HashMap<String, clip_jobs::ClipJob>>,
}

impl LibraryService {
    pub fn new(paths: DataPaths, config: Arc<ConfigStore>, db: Arc<Db>, hub: EventHub) -> Arc<Self> {
        Arc::new(Self {
            paths,
            config,
            db,
            hub,
            root: RwLock::new(None),
            indexer: Mutex::new(None),
            watcher: Mutex::new(None),
            last_scan: Mutex::new(None),
            scan_guard: tokio::sync::Mutex::new(()),
            locks: Mutex::new(HashMap::new()),
            clip_jobs: Mutex::new(HashMap::new()),
        })
    }

    pub fn root_path(&self) -> Option<PathBuf> {
        self.root.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn root_string(&self) -> Option<String> {
        self.root_path().map(|p| p.to_string_lossy().to_string())
    }

    fn indexer(&self) -> Option<Arc<LibraryIndexer>> {
        self.indexer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub async fn init(self: &Arc<Self>) -> AppResult<()> {
        ensure_data_dirs(&self.paths).map_err(|e| AppError::internal(format!("创建数据目录失败: {e}")))?;
        let stored = self.config.resolve_library_root();
        let created_default = stored.is_none();
        let root = match stored {
            Some(root) => root,
            None => self.config.ensure_default_library(),
        };
        if created_default {
            let mut patch = Map::new();
            patch.insert(
                "libraryRoot".into(),
                Value::String(root.to_string_lossy().to_string()),
            );
            self.config.save(&patch);
        }
        self.mount(root, true, created_default).await
    }

    pub async fn mount(self: &Arc<Self>, root: PathBuf, initial: bool, seed: bool) -> AppResult<()> {
        let meta = tokio::fs::metadata(&root).await.ok();
        if !meta.map(|m| m.is_dir()).unwrap_or(false) {
            return Err(AppError::bad_request("书库路径不存在或不是目录").with_detail(json!({
                "path": root.to_string_lossy()
            })));
        }
        let resolved = root.canonicalize().unwrap_or(root);
        if self.root_path().as_deref() == Some(resolved.as_path()) {
            let _ = self.rescan("remount").await;
            return Ok(());
        }

        self.stop_watcher();
        *self.root.write().unwrap_or_else(|e| e.into_inner()) = Some(resolved.clone());
        let mut patch = Map::new();
        patch.insert(
            "libraryRoot".into(),
            Value::String(resolved.to_string_lossy().to_string()),
        );
        self.config.save(&patch);
        self.db.clear_docs().await?;
        self.db
            .set_meta("libraryRoot", &resolved.to_string_lossy())
            .await?;

        let indexer = LibraryIndexer::new(resolved.clone(), self.db.clone(), self.hub.clone());
        *self.indexer.lock().unwrap_or_else(|e| e.into_inner()) = Some(indexer);
        self.start_watcher(resolved.clone());

        self.hub.broadcast(
            "library-changed",
            json!({ "root": resolved.to_string_lossy() }),
        );
        if seed {
            let _ = self.seed_welcome_doc().await;
        }
        let service = self.clone();
        let reason = if initial { "initial" } else { "mount" };
        tokio::spawn(async move {
            let _ = service.rescan(reason).await;
        });
        Ok(())
    }

    fn start_watcher(self: &Arc<Self>, root: PathBuf) {
        let (tx, mut rx) = unbounded_channel::<WatchEvent>();
        match watcher::start(root.clone(), tx) {
            Ok(handle) => {
                *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
                let service = self.clone();
                tokio::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            WatchEvent::Rescan(reason) => {
                                let _ = service.rescan(&reason).await;
                            }
                            WatchEvent::Paths(paths) => {
                                service.handle_watch_batch(paths).await;
                            }
                        }
                    }
                });
            }
            Err(err) => {
                eprintln!("[watch] 启动失败：{err}");
                let service = self.clone();
                tokio::spawn(async move {
                    let _ = service.rescan("watch-failed").await;
                });
            }
        }
    }

    fn stop_watcher(&self) {
        if let Some(handle) = self.watcher.lock().unwrap_or_else(|e| e.into_inner()).take() {
            handle.stop();
        }
        *self.indexer.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    async fn handle_watch_batch(self: &Arc<Self>, paths: Vec<PathBuf>) {
        let (Some(root), Some(indexer)) = (self.root_path(), self.indexer()) else {
            return;
        };
        let mut touched = false;
        for abs in paths {
            let abs = abs;
            let rel = relative_posix(&root, &abs);
            if rel.is_empty() || is_ignored_rel(&rel) {
                continue;
            }
            let kind = kind_of(&rel);
            if kind.is_none() {
                if abs.extension().is_none() {
                    let _ = self.rescan("dir-change").await;
                }
                continue;
            }
            let exists = tokio::fs::metadata(&abs)
                .await
                .map(|m| m.is_file())
                .unwrap_or(false);
            if !exists {
                if let Ok(true) = indexer.remove_by_rel_path(&rel).await {
                    touched = true;
                    self.hub.broadcast(
                        "doc-changed",
                        json!({ "id": null, "relPath": rel, "kind": "removed", "origin": "watcher" }),
                    );
                }
                continue;
            }
            match indexer.index_file(&abs).await {
                Ok(crate::indexer::IndexFileStatus::Added)
                | Ok(crate::indexer::IndexFileStatus::Updated) => {
                    touched = true;
                    let id = self
                        .db
                        .get_doc_by_path(&rel)
                        .await
                        .ok()
                        .flatten()
                        .map(|r| r.id);
                    self.hub.broadcast(
                        "doc-changed",
                        json!({ "id": id, "relPath": rel, "kind": "changed", "origin": "watcher" }),
                    );
                }
                _ => {}
            }
        }
        if touched {
            if let Some(indexer) = self.indexer() {
                let _ = indexer.resolve_links().await;
            }
            self.hub.broadcast("links-changed", json!({ "at": now_ms() }));
        }
    }

    async fn seed_welcome_doc(&self) -> AppResult<()> {
        let Some(root) = self.root_path() else {
            return Ok(());
        };
        let mut has_markdown = false;
        if let Ok(mut entries) = tokio::fs::read_dir(&root).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if entry.file_name().to_string_lossy().to_lowercase().ends_with(".md") {
                    has_markdown = true;
                    break;
                }
            }
        }
        if has_markdown {
            return Ok(());
        }
        let id = new_ulid();
        let text = build_frontmatter(BuildFrontmatter {
            title: "欢迎使用 md-reader",
            id: &id,
            status: None,
            tags: None,
            aliases: None,
            created: Some(crate::frontmatter::iso_now()),
            source: None,
        });
        let body = [
            "这是你的第一篇文章。按 `E` 进入编辑，写点什么，然后按 `Ctrl+S` 保存。",
            "",
            "## 能做什么",
            "",
            "- 书架：未读 / 在读 / 已读，标签，搜索",
            "- 阅读：排版、目录、沉浸模式、代码高亮、公式",
            "- 写作：Live Preview，所见即所得的 Markdown 源码",
            "- 批注：选中文字 → 划色 → 写旁注，存进文件 frontmatter",
            "- 双链：`[[欢迎使用 md-reader]]` 这样的链接",
            "",
            "> 文件就是数据库。所有元数据都写在这篇 `.md` 里。",
            "",
        ]
        .join("\n");
        let dir = root.join("Inbox");
        let _ = tokio::fs::create_dir_all(&dir).await;
        let file = dir.join("欢迎使用 md-reader.md");
        atomic_write_file(&file, format!("{text}{body}").as_bytes(), 1).await?;
        Ok(())
    }

    pub async fn rescan(self: &Arc<Self>, reason: &str) -> AppResult<IndexResult> {
        let _guard = self.scan_guard.lock().await;
        let indexer = self
            .indexer()
            .ok_or_else(|| AppError::new(409, "no-library", "还没有挂载书库"))?;
        let result = indexer.scan_all().await?;
        *self.last_scan.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        let mut payload = serde_json::to_value(&result).unwrap_or_else(|_| json!({}));
        if let Value::Object(map) = &mut payload {
            map.insert("reason".into(), Value::String(reason.to_string()));
        }
        self.hub.broadcast("index-done", payload);
        Ok(result)
    }

    pub fn is_scanning(&self) -> bool {
        self.scan_guard.try_lock().is_err()
            || self
                .indexer()
                .map(|i| i.is_scanning())
                .unwrap_or(false)
    }

    pub fn stats(&self) -> LibraryStats {
        LibraryStats {
            root: self.root_string(),
            total: 0,
            words: 0,
            tags: 0,
            by_status: HashMap::new(),
            indexed_at: None,
            scanning: self.is_scanning(),
            last_scan: self
                .last_scan
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        }
    }

    pub async fn stats_async(&self) -> AppResult<LibraryStats> {
        let s = self.db.stats().await?;
        Ok(LibraryStats {
            root: self.root_string(),
            total: s.total,
            words: s.words,
            tags: s.tags,
            by_status: s.by_status,
            indexed_at: s.indexed_at,
            scanning: self.is_scanning(),
            last_scan: self
                .last_scan
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
        })
    }

    pub async fn require_doc(&self, id: &str) -> AppResult<DocRow> {
        self.db
            .get_doc(id)
            .await?
            .ok_or_else(|| AppError::not_found("文档不存在"))
    }

    pub fn doc_abs(&self, row: &DocRow) -> AppResult<PathBuf> {
        let root = self
            .root_path()
            .ok_or_else(|| AppError::new(409, "no-library", "还没有挂载书库"))?;
        let abs = resolve_in_root(&root, &row.rel_path);
        if !is_inside_root(&root, &abs) {
            return Err(AppError::bad_request("文档路径越界"));
        }
        Ok(abs)
    }

    async fn read_source(&self, row: &DocRow) -> AppResult<(PathBuf, Vec<u8>)> {
        let abs = self.doc_abs(row)?;
        match tokio::fs::read(&abs).await {
            Ok(buf) => Ok((abs, buf)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                self.db.remove_document(&row.id).await?;
                Err(AppError::not_found("文件已被删除"))
            }
            Err(err) => Err(AppError::from(err)),
        }
    }

    pub async fn load_doc(&self, row: &DocRow) -> AppResult<Loaded> {
        let (abs, buffer) = self.read_source(row).await?;
        let stat = tokio::fs::metadata(&abs).await.ok();
        let mtime = stat
            .as_ref()
            .and_then(|s| s.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(row.mtime);
        let size = stat.map(|s| s.len() as i64).unwrap_or(row.size);
        let kind = kind_of(&row.rel_path).unwrap_or(DocKind::Md);

        let loaded = match kind {
            DocKind::Md => {
                let parsed = parse::parse_doc_buffer(&row.rel_path, &buffer, mtime, size);
                Loaded {
                    body: parsed.body,
                    raw_hash: parsed.hash,
                    encoding: parsed.encoding,
                    eol: parsed.eol,
                    annotations: parsed.annotations,
                    ai: parsed.ai,
                    ai_enabled: parsed.ai_enabled,
                    headings: parsed.headings,
                    frontmatter: parsed.frontmatter,
                    has_frontmatter: parsed.layout.has_frontmatter,
                    source: parsed.source,
                }
            }
            DocKind::Txt | DocKind::Sql => {
                let decoded = decode_file(&buffer);
                let headings = if kind == DocKind::Txt {
                    extract_headings(&decoded.text)
                } else {
                    Vec::new()
                };
                let sidecar = sidecar::read_sidecar(&abs);
                Loaded {
                    body: decoded.text.clone(),
                    raw_hash: hash_buffer(&buffer),
                    encoding: decoded.encoding,
                    eol: decoded.eol,
                    annotations: sidecar.annotations,
                    ai: Vec::new(),
                    ai_enabled: false,
                    headings,
                    frontmatter: None,
                    has_frontmatter: false,
                    source: None,
                }
            }
            DocKind::Html | DocKind::Docx => {
                let derived =
                    convert_to_markdown(&buffer, &abs, &row.rel_path, kind, &self.root_path().unwrap_or_default())
                        .await;
                let parsed =
                    parse::parse_derived_doc(&row.rel_path, &buffer, mtime, size, &derived, kind);
                let sidecar = sidecar::read_sidecar(&abs);
                Loaded {
                    body: parsed.body,
                    raw_hash: parsed.hash,
                    encoding: parsed.encoding,
                    eol: parsed.eol,
                    annotations: sidecar.annotations,
                    ai: Vec::new(),
                    ai_enabled: false,
                    headings: parsed.headings,
                    frontmatter: None,
                    has_frontmatter: false,
                    source: None,
                }
            }
        };

        // 磁盘变了就地自愈（PRD §4.14）
        if loaded.raw_hash != row.hash {
            if let Some(indexer) = self.indexer() {
                let _ = indexer.index_file(&abs).await;
                let _ = indexer.resolve_links().await;
            }
        }
        Ok(loaded)
    }

    pub async fn get_doc(&self, id: &str) -> AppResult<DocPayload> {
        let row = self.require_doc(id).await?;
        let loaded = self.load_doc(&row).await?;
        let row = self.db.get_doc(id).await?.unwrap_or(row);

        let links = self
            .db
            .outlinks_for(id)
            .await?
            .into_iter()
            .map(|l| OutLinkDTO {
                broken: l.dst_id.is_none(),
                dst_id: l.dst_id,
                dst_raw: l.dst_raw,
                dst_title: l.dst_title,
                anchor: l.anchor,
            })
            .collect();

        let mut backlinks = Vec::new();
        for back in self.db.backlinks_for(id).await? {
            let context = self.backlink_context(&back.src_id, &row.title).await;
            backlinks.push(BacklinkDTO {
                src_id: back.src_id,
                src_title: back.src_title,
                rel_path: back.rel_path,
                anchor: back.anchor,
                context,
            });
        }

        Ok(DocPayload {
            doc: dto_from_row(&row),
            body: loaded.body,
            raw_hash: loaded.raw_hash,
            encoding: loaded.encoding.as_str().to_string(),
            eol: loaded.eol,
            annotations: loaded.annotations,
            ai: loaded.ai,
            ai_enabled: loaded.ai_enabled,
            links,
            backlinks,
            headings: loaded.headings,
            source: loaded.source,
            frontmatter: loaded.frontmatter,
            has_frontmatter: loaded.has_frontmatter,
        })
    }

    async fn backlink_context(&self, src_id: &str, target_title: &str) -> String {
        let Some(root) = self.root_path() else {
            return String::new();
        };
        let Ok(Some(row)) = self.db.get_doc(src_id).await else {
            return String::new();
        };
        let Ok(buffer) = tokio::fs::read(resolve_in_root(&root, &row.rel_path)).await else {
            return String::new();
        };
        let decoded = decode_file(&buffer);
        let layout = parse_layout(&decoded.text);
        let pattern = format!(
            r"\[\[\s*{}(?:[#|][^\]]*)?\]\]",
            regex::escape(target_title)
        );
        let Ok(re) = Regex::new(&format!("(?i){pattern}")) else {
            return String::new();
        };
        let body = layout.body;
        let Some(m) = re.find(&body) else {
            return crate::markdown::excerpt_of(&body, 80);
        };
        let start_char = body[..m.start()].chars().count().saturating_sub(40);
        let end_char = body[..m.end()].chars().count() + 40;
        let snippet = slice_chars(&body, start_char, end_char);
        let mut snippet = snippet;
        if start_char > 0 {
            let boundary = snippet.find(' ');
            if let Some(pos) = boundary {
                if pos < 12 {
                    snippet = snippet[pos + 1..].to_string();
                }
            }
        }
        snippet.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    pub fn list_docs(&self, options: ListOptions) -> impl std::future::Future<Output = AppResult<Vec<DocDTO>>> {
        let db = self.db.clone();
        async move { Ok(db.list_docs(options).await?.iter().map(dto_from_row).collect()) }
    }

    pub async fn search(&self, query: &str, limit: i64) -> AppResult<Vec<SearchResult>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        Ok(self
            .db
            .search(q, limit, 0)
            .await?
            .into_iter()
            .map(|(doc, _)| SearchResult {
                id: doc.id,
                title: doc.title,
                rel_path: doc.rel_path,
                status: doc.status,
                tags: doc.tags,
                progress: doc.progress,
                snippet: doc.excerpt,
                match_start: 0,
                match_end: 0,
            })
            .collect())
    }

    pub async fn search_with_snippets(&self, query: &str, limit: i64) -> AppResult<Vec<SearchResult>> {
        let hits = self.db.search(query, limit, 0).await?;
        let mut out = Vec::new();
        for (doc, _) in hits {
            let base = SearchResult {
                id: doc.id.clone(),
                title: doc.title.clone(),
                rel_path: doc.rel_path.clone(),
                status: doc.status,
                tags: doc.tags.clone(),
                progress: doc.progress,
                snippet: doc.excerpt.clone(),
                match_start: 0,
                match_end: 0,
            };
            let body = match self.search_body(&doc).await {
                Some(body) => body,
                None => {
                    out.push(base);
                    continue;
                }
            };
            let (snippet, start, end) = make_snippet(&body, query, 60);
            out.push(SearchResult {
                snippet,
                match_start: start,
                match_end: end,
                ..base
            });
        }
        Ok(out)
    }

    async fn search_body(&self, row: &DocRow) -> Option<String> {
        let root = self.root_path()?;
        let abs = resolve_in_root(&root, &row.rel_path);
        let buffer = tokio::fs::read(&abs).await.ok()?;
        let kind = kind_of(&row.rel_path).unwrap_or(DocKind::Md);
        Some(match kind {
            DocKind::Md => parse_layout(&decode_file(&buffer).text).body,
            DocKind::Txt | DocKind::Sql => decode_file(&buffer).text,
            _ => {
                convert_to_markdown(&buffer, &abs, &row.rel_path, kind, &root)
                    .await
                    .markdown
            }
        })
    }

    pub fn doc_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub async fn save_doc(self: &Arc<Self>, id: &str, input: SaveInput) -> AppResult<SaveResult> {
        let lock = self.doc_lock(id);
        let _guard = lock.lock().await;
        self.save_doc_locked(id, input).await
    }

    pub async fn save_doc_locked(self: &Arc<Self>, id: &str, input: SaveInput) -> AppResult<SaveResult> {
        let row = self.require_doc(id).await?;
        let kind = kind_of(&row.rel_path).unwrap_or(DocKind::Md);
        if input.body.is_some() && !kind.is_editable() {
            return Err(AppError::new(
                405,
                "read-only",
                "这个格式是只读浏览，不支持编辑",
            ));
        }
        let abs = self.doc_abs(&row)?;
        let old = match tokio::fs::read(&abs).await {
            Ok(buf) => buf,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                self.db.remove_document(id).await?;
                return Err(AppError::not_found("文件已被删除"));
            }
            Err(err) => return Err(AppError::from(err)),
        };
        let current_hash = hash_buffer(&old);

        if let Some(base) = input.base_hash.as_deref() {
            if !base.is_empty() && base != current_hash {
                let decoded = decode_file(&old);
                let body = if kind == DocKind::Md {
                    parse_layout(&decoded.text).body
                } else {
                    decoded.text
                };
                return Err(AppError::conflict("文件已被外部修改，未覆盖磁盘内容").with_detail(json!({
                    "current": {
                        "hash": current_hash,
                        "mtime": row.mtime,
                        "body": body,
                    }
                })));
            }
        }

        let mut out_encoding: FileEncoding;
        let mut reencoded = false;
        let mut wrote_file = false;
        let mut new_hash = current_hash.clone();

        match kind {
            DocKind::Md => {
                let decoded = decode_file(&old);
                let layout = parse_layout(&decoded.text);
                let mut reader = input.reader.clone().unwrap_or_default();
                reader.id = Some(id.to_string());
                let new_text = apply_document_edits(
                    &layout,
                    &DocumentEdits {
                        body: input.body.clone(),
                        title: input.title.clone(),
                        tags: input.tags.clone(),
                        reader: Some(reader),
                    },
                );
                out_encoding = decoded.encoding;
                let mut encoded = encode_file(&new_text, out_encoding);
                if decode_file(&encoded).text.nfc().collect::<String>()
                    != new_text.nfc().collect::<String>()
                {
                    out_encoding = FileEncoding::Utf8;
                    encoded = encode_file(&new_text, FileEncoding::Utf8);
                    reencoded = true;
                }
                let keep = self.config.get_i64("versionKeep").unwrap_or(20).max(0) as usize;
                if keep > 0 {
                    let _ = save_version(&self.paths.versions_dir, id, &old, keep).await;
                }
                atomic_write_file(&abs, &encoded, 2).await?;
                new_hash = hash_buffer(&encoded);
                wrote_file = true;

                if let Some(indexer) = self.indexer() {
                    let mtime = file_mtime(&abs).await;
                    indexer.index_buffer(&row.rel_path, &encoded, mtime, id).await?;
                    let _ = indexer.resolve_links().await;
                }
            }
            DocKind::Txt | DocKind::Sql => {
                let decoded = decode_file(&old);
                out_encoding = decoded.encoding;
                if let Some(body) = &input.body {
                    let new_text = crate::encoding::apply_eol(body, &decoded.eol);
                    let mut encoded = encode_file(&new_text, out_encoding);
                    if decode_file(&encoded).text.nfc().collect::<String>()
                        != new_text.nfc().collect::<String>()
                    {
                        out_encoding = FileEncoding::Utf8;
                        encoded = encode_file(&new_text, FileEncoding::Utf8);
                        reencoded = true;
                    }
                    let keep = self.config.get_i64("versionKeep").unwrap_or(20).max(0) as usize;
                    if keep > 0 {
                        let _ = save_version(&self.paths.versions_dir, id, &old, keep).await;
                    }
                    atomic_write_file(&abs, &encoded, 2).await?;
                    new_hash = hash_buffer(&encoded);
                    wrote_file = true;
                    if let Some(indexer) = self.indexer() {
                        let _ = indexer.index_file(&abs).await;
                        let _ = indexer.resolve_links().await;
                    }
                }
                if let Some(reader) = &input.reader {
                    self.update_sidecar(&abs, &row, reader).await?;
                }
            }
            DocKind::Html | DocKind::Docx => {
                out_encoding = FileEncoding::Utf8;
                if let Some(reader) = &input.reader {
                    self.update_sidecar(&abs, &row, reader).await?;
                }
            }
        }

        let mtime = file_mtime(&abs).await;
        self.hub.broadcast(
            "doc-changed",
            json!({ "id": id, "relPath": row.rel_path, "hash": new_hash, "mtime": mtime, "origin": "save" }),
        );
        let _ = wrote_file;
        Ok(SaveResult {
            hash: new_hash,
            mtime,
            encoding: out_encoding.as_str().to_string(),
            reencoded,
        })
    }

    pub(crate) async fn update_sidecar(&self, abs: &Path, row: &DocRow, reader: &ReaderPatch) -> AppResult<()> {
        let mut sc = sidecar::read_sidecar(abs);
        sc.id = Some(row.id.clone());
        if let Some(status) = reader.status {
            sc.status = status.as_str().to_string();
        }
        if let Some(progress) = reader.progress {
            sc.progress = (progress.clamp(0.0, 1.0) * 1000.0).round() / 1000.0;
        }
        if let Some(annotations) = &reader.annotations {
            sc.annotations = annotations.clone();
        }
        sc.updated = Some(crate::frontmatter::iso_now());
        sidecar::write_sidecar(abs, &sc).await?;

        let ann_count = if reader.annotations.is_some() {
            Some(sc.annotations.len() as i64)
        } else {
            None
        };
        self.db
            .update_reader_meta(&row.id, reader.status, reader.progress, ann_count)
            .await?;
        if reader.annotations.is_some() {
            self.db
                .replace_annotations(
                    &row.id,
                    sc.annotations
                        .iter()
                        .map(|a| {
                            (
                                a.id.clone(),
                                a.exact.clone(),
                                a.note.clone(),
                                a.color.clone(),
                                a.created.clone(),
                            )
                        })
                        .collect(),
                )
                .await?;
        }
        Ok(())
    }

    pub async fn create_doc(&self, input: CreateDocInput) -> AppResult<DocPayload> {
        let root = self
            .root_path()
            .ok_or_else(|| AppError::new(409, "no-library", "还没有挂载书库"))?;
        let dir_rel = sanitize_dir(input.dir.as_deref().unwrap_or("Inbox"));
        let dir_abs = resolve_in_root(&root, &dir_rel);
        if !is_inside_root(&root, &dir_abs) {
            return Err(AppError::bad_request("目录越界"));
        }
        tokio::fs::create_dir_all(&dir_abs).await?;

        let title = input.title.as_deref().unwrap_or("").trim();
        let title = if title.is_empty() { "未命名" } else { title };
        let base_name = {
            let s = sanitize_segment(title);
            if s.is_empty() { "未命名".to_string() } else { s }
        };
        let file = unique_path(&dir_abs, &base_name, ".md");
        let id = new_ulid();
        let now = crate::frontmatter::iso_now();
        let fm = build_frontmatter(BuildFrontmatter {
            title,
            id: &id,
            status: None,
            tags: input.tags.as_deref(),
            aliases: None,
            created: Some(now),
            source: None,
        });
        let body = input
            .content
            .clone()
            .unwrap_or_else(|| format!("\n# {title}\n\n"));
        atomic_write_file(&file, format!("{fm}{body}").as_bytes(), 1).await?;

        if let Some(indexer) = self.indexer() {
            let _ = indexer.index_file(&file).await;
            let _ = indexer.resolve_links().await;
        }
        self.hub.broadcast(
            "doc-changed",
            json!({ "id": id, "relPath": relative_posix(&root, &file), "created": true, "origin": "create" }),
        );
        self.get_doc(&id).await
    }

    pub async fn move_doc(&self, id: &str, input: MoveInput) -> AppResult<DocPayload> {
        let root = self
            .root_path()
            .ok_or_else(|| AppError::new(409, "no-library", "还没有挂载书库"))?;
        let row = self.require_doc(id).await?;
        let old_abs = self.doc_abs(&row)?;
        let old_dir = {
            let p = Path::new(&row.rel_path);
            p.parent()
                .map(|d| d.to_string_lossy().replace('\\', "/"))
                .filter(|s| !s.is_empty())
                .unwrap_or_default()
        };
        let target_dir_rel = sanitize_dir(input.target_dir.as_deref().unwrap_or(&old_dir));
        let dir_abs = resolve_in_root(&root, &target_dir_rel);
        if !is_inside_root(&root, &dir_abs) {
            return Err(AppError::bad_request("目录越界"));
        }
        tokio::fs::create_dir_all(&dir_abs).await?;

        let old_name = old_abs.file_name().unwrap_or_default().to_string_lossy().to_string();
        let ext = Path::new(&old_name)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_else(|| ".md".into());
        let old_stem = old_name
            .strip_suffix(&ext)
            .unwrap_or(&old_name)
            .to_string();
        let raw_name = input
            .new_name
            .clone()
            .unwrap_or_else(|| old_stem.clone())
            .trim()
            .to_string();
        let base = {
            let s = sanitize_segment(&raw_name);
            if s.is_empty() { old_stem.clone() } else { s }
        };
        let new_abs = dir_abs.join(format!("{base}{ext}"));
        let new_rel = relative_posix(&root, &new_abs);

        if new_abs == old_abs {
            return self.get_doc(id).await;
        }
        if new_abs.exists() {
            return Err(AppError::new(409, "exists", "目标位置已存在同名文件")
                .with_detail(json!({ "relPath": new_rel })));
        }

        let kind = kind_of(&row.rel_path).unwrap_or(DocKind::Md);
        if kind == DocKind::Md {
            self.ensure_reader_id(&row).await?;
        }

        let old_title = row.title.clone();
        let update_links = input.update_links.unwrap_or(true);
        let case_only = new_abs
            .parent()
            .map(|p| p.to_string_lossy().to_lowercase())
            == old_abs.parent().map(|p| p.to_string_lossy().to_lowercase())
            && base.to_lowercase() == old_stem.to_lowercase()
            && base != old_stem;

        if case_only {
            let tmp = old_abs.with_file_name(format!(".{}.rename.tmp", old_name));
            tokio::fs::rename(&old_abs, &tmp).await?;
            tokio::fs::rename(&tmp, &new_abs).await?;
        } else {
            tokio::fs::rename(&old_abs, &new_abs).await?;
        }

        // 非 md 的 sidecar 跟着源文件走
        if kind != DocKind::Md {
            let old_sidecar = sidecar::sidecar_path(&old_abs);
            if old_sidecar.exists() {
                let new_sidecar = sidecar::sidecar_path(&new_abs);
                let _ = tokio::fs::rename(&old_sidecar, &new_sidecar).await;
            }
        }

        self.db.update_rel_path(id, &new_rel).await?;
        if let Some(indexer) = self.indexer() {
            let _ = indexer.index_file(&new_abs).await;
            let _ = indexer.resolve_links().await;
        }

        if update_links && old_title != base {
            let _ = self.update_referring_links(id, &old_title, &base).await;
        }

        self.hub.broadcast(
            "doc-changed",
            json!({ "id": id, "relPath": new_rel, "moved": true, "origin": "move" }),
        );
        self.get_doc(id).await
    }

    async fn ensure_reader_id(&self, row: &DocRow) -> AppResult<()> {
        let abs = self.doc_abs(row)?;
        let buffer = tokio::fs::read(&abs).await?;
        let decoded = decode_file(&buffer);
        let layout = parse_layout(&decoded.text);
        let meta = read_reader_meta(&layout.frontmatter, "");
        if meta.id == row.id {
            return Ok(());
        }
        let new_text = apply_document_edits(
            &layout,
            &DocumentEdits {
                reader: Some(ReaderPatch {
                    id: Some(row.id.clone()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        let encoded = encode_file(&new_text, decoded.encoding);
        let keep = self.config.get_i64("versionKeep").unwrap_or(20).max(0) as usize;
        if keep > 0 {
            let _ = save_version(&self.paths.versions_dir, &row.id, &buffer, keep).await;
        }
        atomic_write_file(&abs, &encoded, 2).await?;
        Ok(())
    }

    async fn update_referring_links(&self, doc_id: &str, old_title: &str, new_title: &str) -> AppResult<()> {
        let refs = self.db.backlinks_for(doc_id).await?;
        let pattern = format!(
            r"\[\[\s*{}(#[^\]|]*)?(\|[^\]]*)?\]\]",
            regex::escape(old_title)
        );
        let Ok(re) = Regex::new(&pattern) else {
            return Ok(());
        };
        for back in refs {
            let Ok(Some(row)) = self.db.get_doc(&back.src_id).await else {
                continue;
            };
            let Ok(abs) = self.doc_abs(&row) else { continue };
            let Ok(buffer) = tokio::fs::read(&abs).await else {
                continue;
            };
            let decoded = decode_file(&buffer);
            let layout = parse_layout(&decoded.text);
            if !re.is_match(&layout.body) {
                continue;
            }
            let new_body = re
                .replace_all(&layout.body, format!("[[{new_title}$1$2]]").as_str())
                .into_owned();
            if new_body == layout.body {
                continue;
            }
            let new_text = apply_document_edits(
                &layout,
                &DocumentEdits {
                    body: Some(new_body),
                    ..Default::default()
                },
            );
            let encoded = encode_file(&new_text, decoded.encoding);
            let keep = self.config.get_i64("versionKeep").unwrap_or(20).max(0) as usize;
            if keep > 0 {
                let _ = save_version(&self.paths.versions_dir, &row.id, &buffer, keep).await;
            }
            atomic_write_file(&abs, &encoded, 2).await?;
            if let Some(indexer) = self.indexer() {
                let _ = indexer
                    .index_buffer(&row.rel_path, &encoded, now_ms(), &row.id)
                    .await;
            }
        }
        Ok(())
    }

    pub async fn delete_doc(&self, id: &str) -> AppResult<Value> {
        let root = self
            .root_path()
            .ok_or_else(|| AppError::new(409, "no-library", "还没有挂载书库"))?;
        let row = self.require_doc(id).await?;
        let abs = self.doc_abs(&row)?;
        let trash_dir = root.join(".trash");
        tokio::fs::create_dir_all(&trash_dir).await?;
        let stamp = crate::atomic::timestamp_slug();
        let file_name = abs.file_name().unwrap_or_default().to_string_lossy().to_string();
        let mut target = trash_dir.join(format!("{stamp}-{file_name}"));
        if target.exists() {
            target = trash_dir.join(format!(
                "{stamp}-{}-{file_name}",
                &id[..id.len().min(6)]
            ));
        }
        tokio::fs::rename(&abs, &target).await?;
        let sidecar = sidecar::sidecar_path(&abs);
        if sidecar.exists() {
            let sc_name = sidecar.file_name().unwrap_or_default().to_string_lossy().to_string();
            let _ = tokio::fs::rename(&sidecar, trash_dir.join(format!("{stamp}-{sc_name}"))).await;
        }
        self.db.remove_document(id).await?;
        if let Some(indexer) = self.indexer() {
            let _ = indexer.resolve_links().await;
        }
        self.hub.broadcast(
            "doc-removed",
            json!({ "id": id, "relPath": row.rel_path, "origin": "delete" }),
        );
        Ok(json!({ "trashedTo": relative_posix(&root, &target) }))
    }

    pub async fn preview(&self, target: &str) -> AppResult<Option<Value>> {
        let needle = target.nfc().collect::<String>().trim().to_lowercase();
        if needle.is_empty() {
            return Ok(None);
        }
        let docs = self.db.all_docs_for_resolve().await?;
        let doc = docs
            .iter()
            .find(|d| d.title.nfc().collect::<String>().to_lowercase() == needle)
            .or_else(|| {
                docs.iter().find(|d| {
                    d.aliases
                        .iter()
                        .any(|a| a.nfc().collect::<String>().to_lowercase() == needle)
                })
            })
            .or_else(|| {
                docs.iter().find(|d| {
                    let name = d.rel_path.rsplit('/').next().unwrap_or(&d.rel_path);
                    strip_doc_ext(name).nfc().collect::<String>().to_lowercase() == needle
                })
            });
        let Some(doc) = doc else {
            return Ok(None);
        };
        let kind = kind_of(&doc.rel_path).unwrap_or(DocKind::Md);
        if kind != DocKind::Md {
            let row = self.db.get_doc(&doc.id).await?;
            return Ok(Some(json!({
                "id": doc.id,
                "title": doc.title,
                "excerpt": row.map(|r| r.excerpt).unwrap_or_default(),
            })));
        }
        let Some(root) = self.root_path() else {
            return Ok(None);
        };
        match tokio::fs::read(resolve_in_root(&root, &doc.rel_path)).await {
            Ok(buffer) => {
                let text = decode_file(&buffer).text;
                let layout = parse_layout(&text);
                Ok(Some(json!({
                    "id": doc.id,
                    "title": doc.title,
                    "excerpt": crate::markdown::excerpt_of(&layout.body, 300),
                })))
            }
            Err(_) => Ok(None),
        }
    }

    pub async fn unlinked_mentions(&self, doc_id: &str, limit: i64) -> AppResult<Vec<UnlinkedMention>> {
        let Some(root) = self.root_path() else {
            return Ok(Vec::new());
        };
        let target = self.require_doc(doc_id).await?;
        let title = target.title.nfc().collect::<String>();
        let title = title.trim();
        if js_len(title) < 2 {
            return Ok(Vec::new());
        }
        let candidates = self
            .db
            .mention_candidates(title, doc_id, limit * 2)
            .await?;
        let mut out = Vec::new();
        for candidate in candidates {
            let Ok(Some(row)) = self.db.get_doc(&candidate.id).await else {
                continue;
            };
            let abs = resolve_in_root(&root, &row.rel_path);
            let Ok(buffer) = tokio::fs::read(&abs).await else {
                continue;
            };
            let kind = kind_of(&row.rel_path).unwrap_or(DocKind::Md);
            let body = match kind {
                DocKind::Md => parse_layout(&decode_file(&buffer).text).body,
                DocKind::Txt | DocKind::Sql => decode_file(&buffer).text,
                _ => convert_to_markdown(&buffer, &abs, &row.rel_path, kind, &root)
                    .await
                    .markdown,
            };
            let Some(idx) = body.find(title) else {
                continue;
            };
            // 跳过已经处在 [[...]] 里的提及
            if let Some(open) = body[..idx].rfind("[[") {
                if let Some(close_rel) = body[open..].find("]]") {
                    if idx < open + close_rel {
                        continue;
                    }
                }
            }
            let start = body[..idx].chars().count().saturating_sub(60);
            let end = body[..idx].chars().count() + title.chars().count() + 60;
            let snippet = slice_chars(&body, start, end);
            let snippet = snippet.split_whitespace().collect::<Vec<_>>().join(" ");
            let prefix = if start > 0 { "…" } else { "" };
            let suffix = if end < body.chars().count() { "…" } else { "" };
            out.push(UnlinkedMention {
                id: row.id,
                title: row.title,
                rel_path: row.rel_path,
                status: row.status,
                snippet: format!("{prefix}{snippet}{suffix}"),
            });
            if out.len() as i64 >= limit {
                break;
            }
        }
        Ok(out)
    }

    pub fn directory_tree(&self) -> Value {
        let Some(root) = self.root_path() else {
            return json!({ "dirs": [] });
        };
        let mut dirs: Vec<String> = vec![String::new()];
        fn visit(root: &Path, dir: &Path, depth: usize, dirs: &mut Vec<String>) {
            if depth > 6 {
                return;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let Ok(ft) = entry.file_type() else { continue };
                if !ft.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "node_modules" || name == "assets" {
                    continue;
                }
                let abs = dir.join(&name);
                dirs.push(relative_posix(root, &abs));
                visit(root, &abs, depth + 1, dirs);
            }
        }
        visit(&root, &root, 0, &mut dirs);
        dirs.sort();
        dirs.dedup();
        json!({ "dirs": dirs })
    }

    pub async fn update_config(self: &Arc<Self>, patch: &Map<String, Value>) -> AppResult<Value> {
        let before_theme = self.config.get_str("theme");
        let next = self.config.save(patch);
        if let Some(root) = patch.get("libraryRoot").and_then(|v| v.as_str()) {
            let target = PathBuf::from(root);
            if self.root_path().as_deref() != Some(target.as_path()) {
                self.mount(target, false, false).await?;
            }
        }
        if patch.contains_key("theme") && before_theme != self.config.get_str("theme") {
            self.hub.broadcast("config-changed", next.clone());
        }
        Ok(next)
    }

    pub fn word_count_of(&self, body: &str) -> usize {
        crate::markdown::count_words(body)
    }

    pub fn shutdown(&self) {
        self.stop_watcher();
    }

    pub fn platform(&self) -> &'static str {
        crate::config::platform_name()
    }

    pub fn uptime_seconds(&self) -> u64 {
        STARTED.get().map(|i| i.elapsed().as_secs()).unwrap_or(0)
    }
}

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

pub fn mark_started() {
    STARTED.get_or_init(std::time::Instant::now);
}

#[derive(Clone, Debug, Default)]
pub struct CreateDocInput {
    pub dir: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default)]
pub struct MoveInput {
    pub target_dir: Option<String>,
    pub new_name: Option<String>,
    pub update_links: Option<bool>,
}

/* ------------------------------------------------------------------ 工具 */

pub fn sanitize_segment(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 {
                '-'
            } else {
                c
            }
        })
        .collect();
    out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    out = out.trim().to_string();
    out = out.trim_end_matches(['.', ' ']).to_string();
    out.chars().take(90).collect()
}

pub fn sanitize_dir(dir: &str) -> String {
    if dir.trim().is_empty() {
        return "Inbox".into();
    }
    let cleaned = dir
        .replace('\\', "/")
        .split('/')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .collect::<Vec<_>>()
        .join("/");
    if cleaned.is_empty() {
        "Inbox".into()
    } else {
        cleaned
    }
}

pub fn unique_path(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{base}{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base} {n}{ext}"));
        n += 1;
        if n > 999 {
            break;
        }
    }
    candidate
}

pub fn make_snippet(text: &str, needle: &str, radius: usize) -> (String, usize, usize) {
    let trimmed = needle.trim();
    if trimmed.is_empty() {
        let snippet = slice_chars(text, 0, radius * 2)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return (snippet, 0, 0);
    }
    let lower = text.to_lowercase();
    let needle_lower = trimmed.to_lowercase();
    let mut byte_idx = lower.find(&needle_lower);
    if byte_idx.is_none() {
        if let Some(first) = trimmed.split_whitespace().next() {
            byte_idx = lower.find(&first.to_lowercase());
        }
        if byte_idx.is_none() {
            byte_idx = Some(0);
        }
    }
    let byte_idx = byte_idx.unwrap_or(0);
    let char_idx = lower[..byte_idx].chars().count();
    let end_char = char_idx + trimmed.chars().count();
    let start = char_idx.saturating_sub(radius);
    let end = (end_char + radius).min(text.chars().count());
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < text.chars().count() { "…" } else { "" };
    let raw = slice_chars(text, start, end);
    let raw_collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let snippet = format!("{prefix}{raw_collapsed}{suffix}");
    let lead_trim = raw.chars().take_while(|c| c.is_whitespace()).count();
    let match_start = char_idx.saturating_sub(start).saturating_sub(lead_trim) + prefix.chars().count();
    let match_end = (match_start + trimmed.chars().count()).min(snippet.chars().count());
    (snippet, match_start, match_end)
}

pub fn slice_chars(text: &str, start: usize, end: usize) -> String {
    text.chars().skip(start).take(end.saturating_sub(start)).collect()
}

fn is_ignored_rel(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return false;
    }
    for part in &parts[..parts.len() - 1] {
        if crate::paths::should_skip_dir(part) {
            return true;
        }
    }
    crate::paths::should_skip_file(parts[parts.len() - 1])
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub async fn file_mtime(path: &Path) -> i64 {
    tokio::fs::metadata(path)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(now_ms)
}

pub fn data_paths_for(dir: PathBuf) -> DataPaths {
    data_paths(dir)
}
