//! 全量 / 增量索引：walk → 逐文件 stat → parse → upsert → resolveLinks。

use crate::adapt::{convert_to_markdown, derived_doc_id, kind_of, DocKind};
use crate::db::{DocRecord, Db};
use crate::error::{AppError, AppResult};
use crate::hash::hash_buffer;
use crate::http::sse::EventHub;
use crate::library::parse::{parse_doc_buffer, parse_derived_doc};
use crate::library::sidecar::{read_sidecar, sidecar_path};
use crate::paths::{relative_posix, should_skip_dir, should_skip_file, to_posix_path};
use crate::ulid::new_ulid;
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub indexed: i64,
    pub updated: i64,
    pub skipped: i64,
    pub removed: i64,
    pub errors: i64,
    pub total: i64,
    pub duration_ms: i64,
}

impl Default for IndexResult {
    fn default() -> Self {
        Self {
            indexed: 0,
            updated: 0,
            skipped: 0,
            removed: 0,
            errors: 0,
            total: 0,
            duration_ms: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgress {
    pub phase: String,
    pub done: i64,
    pub total: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexFileStatus {
    Added,
    Updated,
    Unchanged,
    Removed,
    Ignored,
}

pub struct LibraryIndexer {
    pub root: PathBuf,
    pub db: Arc<Db>,
    pub hub: EventHub,
    scanning: AtomicBool,
    last_progress_at: AtomicI64,
}

impl LibraryIndexer {
    pub fn new(root: PathBuf, db: Arc<Db>, hub: EventHub) -> Arc<Self> {
        Arc::new(Self {
            root,
            db,
            hub,
            scanning: AtomicBool::new(false),
            last_progress_at: AtomicI64::new(0),
        })
    }

    pub fn is_scanning(&self) -> bool {
        self.scanning.load(Ordering::Relaxed)
    }

    fn progress(&self, phase: &str, done: i64, total: i64, current: Option<String>) {
        if phase == "index" {
            let now = chrono::Utc::now().timestamp_millis();
            let last = self.last_progress_at.load(Ordering::Relaxed);
            if now - last < 120 {
                return;
            }
            self.last_progress_at.store(now, Ordering::Relaxed);
        }
        self.hub.broadcast(
            "index-progress",
            serde_json::to_value(IndexProgress {
                phase: phase.to_string(),
                done,
                total,
                current,
            })
            .unwrap_or(json!({})),
        );
    }

    /// 递归列出所有可索引的文档绝对路径。
    pub async fn walk(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(rd) => rd,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let Ok(file_type) = entry.file_type().await else {
                    continue;
                };
                if file_type.is_symlink() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if file_type.is_dir() {
                    if should_skip_dir(&name) {
                        continue;
                    }
                    stack.push(entry.path());
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                if should_skip_file(&name) {
                    continue;
                }
                if name.ends_with(".reader.json") {
                    continue;
                }
                if kind_of(&name).is_none() {
                    continue;
                }
                out.push(entry.path());
            }
        }
        out.sort();
        out
    }

    pub async fn scan_all(&self) -> AppResult<IndexResult> {
        let started = std::time::Instant::now();
        self.scanning.store(true, Ordering::Relaxed);
        let mut result = IndexResult::default();
        let outcome = async {
            self.progress("walk", 0, 0, None);
            let files = self.walk().await;
            result.total = files.len() as i64;
            let mut done = 0i64;
            for file in &files {
                done += 1;
                let rel = relative_posix(&self.root, file);
                self.progress("index", done, files.len() as i64, Some(rel));
                match self.index_file(file).await {
                    Ok(IndexFileStatus::Added) => result.indexed += 1,
                    Ok(IndexFileStatus::Updated) => result.updated += 1,
                    Ok(IndexFileStatus::Unchanged) => result.skipped += 1,
                    Ok(_) => {}
                    Err(_) => result.errors += 1,
                }
            }

            let existing: HashSet<String> = files
                .iter()
                .map(|f| relative_posix(&self.root, f))
                .collect();
            for (id, _rel) in self.db.stale_docs(existing).await? {
                self.db.remove_document(&id).await?;
                result.removed += 1;
            }

            self.progress("links", 0, 0, None);
            self.resolve_links().await?;
            self.db
                .set_meta("lastIndexedAt", &chrono::Utc::now().timestamp_millis().to_string())
                .await?;
            self.progress("done", files.len() as i64, files.len() as i64, None);
            Ok::<(), AppError>(())
        }
        .await;
        self.scanning.store(false, Ordering::Relaxed);
        outcome?;
        result.duration_ms = started.elapsed().as_millis() as i64;
        Ok(result)
    }

    pub async fn index_file(&self, abs_path: &Path) -> AppResult<IndexFileStatus> {
        let rel = relative_posix(&self.root, abs_path);
        let Some(kind) = kind_of(&rel) else {
            return Ok(IndexFileStatus::Ignored);
        };
        let stat = match tokio::fs::metadata(abs_path).await {
            Ok(s) => s,
            Err(_) => return Ok(IndexFileStatus::Removed),
        };
        if !stat.is_file() {
            return Ok(IndexFileStatus::Ignored);
        }
        let mtime = stat
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let size = stat.len() as i64;
        if self.db.is_fresh(&rel, mtime, size).await? {
            return Ok(IndexFileStatus::Unchanged);
        }

        let buffer = tokio::fs::read(abs_path).await?;
        let previous = self.db.get_doc_by_path(&rel).await?;

        let mut parsed = match kind {
            DocKind::Md => parse_doc_buffer(&rel, &buffer, mtime, size),
            other => {
                let derived =
                    convert_to_markdown(&buffer, abs_path, &rel, other, &self.root).await;
                parse_derived_doc(&rel, &buffer, mtime, size, &derived, other)
            }
        };

        let id = if kind == DocKind::Md {
            parsed.reader_id.clone().unwrap_or_else(|| {
                previous
                    .as_ref()
                    .map(|p| p.id.clone())
                    .unwrap_or_else(new_ulid)
            })
        } else {
            let sidecar = read_sidecar(abs_path);
            let preferred = sidecar
                .id
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| derived_doc_id(&rel));
            // 身份写在 sidecar（如果还没有，就等到用户第一次改状态/批注时落盘）
            preferred
        };

        parsed.record.id = id.clone();
        parsed.record.indexed_at = chrono::Utc::now().timestamp_millis();
        parsed.record.meta_path = if kind == DocKind::Md {
            None
        } else {
            Some(format!("{}.reader.json", rel))
        };

        if kind != DocKind::Md {
            let sidecar = read_sidecar(abs_path);
            parsed.record.status = sidecar.status();
            parsed.record.progress = sidecar.progress_clamped();
            parsed.record.ann_count = sidecar.annotations.len() as i64;
            parsed.annotations = sidecar.annotations.clone();
            if !sidecar.tags.is_empty() {
                parsed.record.tags = sidecar.tags.clone();
                parsed.record.tags_tokens =
                    crate::tokenizer::fts_token_string(&sidecar.tags.join(" "));
            }
            let notes = sidecar
                .annotations
                .iter()
                .map(|a| format!("{} {}", a.note, a.exact))
                .collect::<Vec<_>>()
                .join(" \n ");
            parsed.record.notes_tokens = crate::tokenizer::fts_token_string(&notes);
        }

        if let Some(prev) = &previous {
            if prev.id != id {
                self.db.remove_document(&prev.id).await?;
            }
        }
        self.db.upsert_document(parsed.record.clone()).await?;
        self.db
            .replace_links(
                &id,
                parsed
                    .links
                    .iter()
                    .map(|(raw, anchor)| (raw.clone(), anchor.clone(), "wiki".to_string()))
                    .collect(),
            )
            .await?;
        self.db
            .replace_annotations(
                &id,
                parsed
                    .annotations
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

        Ok(if previous.is_some() {
            IndexFileStatus::Updated
        } else {
            IndexFileStatus::Added
        })
    }

    /// 保存后只重算索引行的 reader 元数据。
    pub async fn index_buffer(&self, rel_path: &str, buffer: &[u8], mtime: i64, forced_id: &str) -> AppResult<()> {
        let parsed = parse_doc_buffer(rel_path, buffer, mtime, buffer.len() as i64);
        let mut record: DocRecord = parsed.record;
        record.id = forced_id.to_string();
        record.indexed_at = chrono::Utc::now().timestamp_millis();
        self.db.upsert_document(record).await?;
        self.db
            .replace_links(
                forced_id,
                parsed
                    .links
                    .iter()
                    .map(|(raw, anchor)| (raw.clone(), anchor.clone(), "wiki".to_string()))
                    .collect(),
            )
            .await?;
        self.db
            .replace_annotations(
                forced_id,
                parsed
                    .annotations
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
        Ok(())
    }

    pub async fn remove_by_rel_path(&self, rel_path: &str) -> AppResult<bool> {
        let Some(row) = self.db.get_doc_by_path(rel_path).await? else {
            return Ok(false);
        };
        self.db.remove_document(&row.id).await?;
        Ok(true)
    }

    /// 按 PRD 优先级解析 [[链接]]：title → aliases → 文件名 → 相对路径。
    pub async fn resolve_links(&self) -> AppResult<(i64, i64)> {
        let docs = self.db.all_docs_for_resolve().await?;
        let mut map: HashMap<String, String> = HashMap::new();
        let mut put = |key: &str, id: &str| {
            let k = normalize_key(key);
            if k.is_empty() {
                return;
            }
            map.entry(k).or_insert_with(|| id.to_string());
        };
        for doc in &docs {
            put(&doc.title, &doc.id);
        }
        for doc in &docs {
            for alias in &doc.aliases {
                put(alias, &doc.id);
            }
        }
        for doc in &docs {
            let name = doc.rel_path.rsplit('/').next().unwrap_or(&doc.rel_path);
            put(&crate::adapt::strip_doc_ext(name), &doc.id);
        }
        for doc in &docs {
            put(&doc.rel_path, &doc.id);
            put(&crate::adapt::strip_doc_ext(&doc.rel_path), &doc.id);
        }

        let raws = self.db.distinct_link_targets().await?;
        let mut targets = HashMap::new();
        for raw in raws {
            let key = normalize_key(&raw);
            targets.insert(raw, map.get(&key).cloned());
        }
        self.db.apply_link_targets(targets).await
    }

    pub async fn sidecar_rel_path(&self, abs_path: &Path) -> String {
        to_posix_path(&sidecar_path(abs_path))
    }

    pub fn hash_bytes(buffer: &[u8]) -> String {
        hash_buffer(buffer)
    }
}

pub fn normalize_key(text: &str) -> String {
    text.nfc().collect::<String>().trim().to_lowercase()
}
