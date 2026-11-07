//! SQLite 索引库：单连接 + 专用线程（actor），所有查询经 mpsc 投递（PRD §4.9）。

use crate::error::{AppError, AppResult};
use crate::frontmatter::DocStatus;
use crate::tokenizer::{build_bigram_query, build_char_query, build_match_query};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;

type Job = Box<dyn FnOnce(&mut Connection) + Send>;

pub struct Db {
    tx: Sender<Job>,
    pub file: PathBuf,
}

impl Db {
    pub fn open(file: PathBuf) -> AppResult<Arc<Self>> {
        let (tx, rx) = channel::<Job>();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let thread_file = file.clone();
        std::thread::Builder::new()
            .name("reader-db".into())
            .spawn(move || {
                let opened = Connection::open(&thread_file).map_err(|e| e.to_string()).and_then(|mut conn| {
                    init_connection(&mut conn).map_err(|e| e.to_string())?;
                    migrate(&conn).map_err(|e| e.to_string())?;
                    Ok(conn)
                });
                match opened {
                    Ok(mut conn) => {
                        let _ = ready_tx.send(Ok(()));
                        while let Ok(job) = rx.recv() {
                            job(&mut conn);
                        }
                    }
                    Err(err) => {
                        let _ = ready_tx.send(Err(err));
                    }
                }
            })
            .map_err(|e| AppError::internal(format!("启动 DB 线程失败: {e}")))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Arc::new(Self { tx, file })),
            Ok(Err(err)) => Err(AppError::internal(format!("打开索引库失败: {err}"))),
            Err(_) => Err(AppError::internal("索引库线程未就绪")),
        }
    }

    pub async fn call<T, F>(&self, f: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(Box::new(move |conn| {
                let _ = tx.send(f(conn));
            }))
            .map_err(|_| AppError::internal("索引库线程已退出"))?;
        let result = rx
            .await
            .map_err(|_| AppError::internal("索引库查询被取消"))?;
        result.map_err(AppError::from)
    }
}

fn init_connection(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn table_columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

fn fts_columns(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA table_info(docs_fts)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

/// v3 → v4：只允许 ADD COLUMN；FTS 不能 ALTER，只能 DROP 后重建再灌数据。
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(include_str!("schema.sql"))?;

    let docs_cols = table_columns(conn, "docs")?;
    if !docs_cols.iter().any(|c| c == "kind") {
        conn.execute_batch("ALTER TABLE docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'md';")?;
    }
    if !docs_cols.iter().any(|c| c == "meta_path") {
        conn.execute_batch("ALTER TABLE docs ADD COLUMN meta_path TEXT;")?;
    }
    // v3 旧库没有 kind 列，必须先补列再建索引（schema.sql 里不能提前建）
    conn.execute_batch("CREATE INDEX IF NOT EXISTS docs_kind ON docs(kind);")?;

    let expected = [
        "doc_id",
        "rel_path",
        "title_tokens",
        "body_tokens",
        "tags_tokens",
        "notes_tokens",
        "bigrams",
    ];
    let actual = fts_columns(conn)?;
    if actual != expected {
        conn.execute_batch(
            "DROP TABLE IF EXISTS docs_fts;
             CREATE VIRTUAL TABLE docs_fts USING fts5(
               doc_id UNINDEXED, rel_path, title_tokens, body_tokens,
               tags_tokens, notes_tokens, bigrams, tokenize = 'unicode61'
             );",
        )?;
    }

    conn.pragma_update(None, "user_version", 2)?;
    Ok(())
}

/* ------------------------------------------------------------------ 类型 */

#[derive(Clone, Debug)]
pub struct DocRecord {
    pub id: String,
    pub rel_path: String,
    pub kind: String,
    pub meta_path: Option<String>,
    pub mtime: i64,
    pub size: i64,
    pub hash: String,
    pub title: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub status: DocStatus,
    pub progress: f64,
    pub words: i64,
    pub excerpt: String,
    pub source_url: Option<String>,
    pub encoding: String,
    pub eol: String,
    pub created: Option<String>,
    pub indexed_at: i64,
    pub ann_count: i64,
    pub title_tokens: String,
    pub body_tokens: String,
    pub tags_tokens: String,
    pub notes_tokens: String,
    pub bigrams: String,
}

#[derive(Clone, Debug)]
pub struct DocRow {
    pub id: String,
    pub rel_path: String,
    pub kind: String,
    pub meta_path: Option<String>,
    pub mtime: i64,
    pub size: i64,
    pub hash: String,
    pub title: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub status: DocStatus,
    pub progress: f64,
    pub words: i64,
    pub excerpt: String,
    pub source_url: Option<String>,
    pub encoding: String,
    pub eol: String,
    pub created: Option<String>,
    pub indexed_at: i64,
    pub ann_count: i64,
    pub title_tokens: String,
    pub body_tokens: String,
    pub tags_tokens: String,
    pub notes_tokens: String,
    pub bigrams: String,
}

fn parse_json_list(raw: &str) -> Vec<String> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn row_to_doc(row: &Row<'_>) -> rusqlite::Result<DocRow> {
    let status: String = row.get("status")?;
    Ok(DocRow {
        id: row.get("id")?,
        rel_path: row.get("rel_path")?,
        kind: row.get("kind")?,
        meta_path: row.get("meta_path")?,
        mtime: row.get("mtime")?,
        size: row.get("size")?,
        hash: row.get("hash")?,
        title: row.get("title")?,
        tags: parse_json_list(&row.get::<_, String>("tags")?),
        aliases: parse_json_list(&row.get::<_, String>("aliases")?),
        status: DocStatus::parse(&status).unwrap_or(DocStatus::Unread),
        progress: row.get("progress")?,
        words: row.get("words")?,
        excerpt: row.get("excerpt")?,
        source_url: row.get("source_url")?,
        encoding: row.get("encoding")?,
        eol: row.get("eol")?,
        created: row.get("created")?,
        indexed_at: row.get("indexed_at")?,
        ann_count: row.get("ann_count")?,
        title_tokens: String::new(),
        body_tokens: String::new(),
        tags_tokens: String::new(),
        notes_tokens: String::new(),
        bigrams: String::new(),
    })
}

#[derive(Clone, Debug, Default)]
pub struct ListOptions {
    pub status: Option<DocStatus>,
    pub tag: Option<String>,
    pub sort: String,
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct LinkRow {
    pub src_id: String,
    pub dst_id: Option<String>,
    pub dst_raw: String,
    pub dst_anchor: Option<String>,
    pub kind: String,
}

#[derive(Clone, Debug)]
pub struct DocStats {
    pub total: i64,
    pub words: i64,
    pub tags: i64,
    pub by_status: HashMap<String, i64>,
    pub indexed_at: Option<i64>,
}

/* ------------------------------------------------------------------ 查询实现 */

impl Db {
    pub async fn get_meta(&self, key: &str) -> AppResult<Option<String>> {
        let key = key.to_string();
        self.call(move |conn| {
            conn.query_row("SELECT value FROM meta WHERE key = ?1", [&key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
        })
        .await
    }

    pub async fn set_meta(&self, key: &str, value: &str) -> AppResult<()> {
        let key = key.to_string();
        let value = value.to_string();
        self.call(move |conn| {
            conn.execute(
                "INSERT INTO meta(key, value) VALUES(?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn get_doc(&self, id: &str) -> AppResult<Option<DocRow>> {
        let id = id.to_string();
        self.call(move |conn| {
            conn.query_row("SELECT * FROM docs WHERE id = ?1", [&id], row_to_doc)
                .optional()
        })
        .await
    }

    pub async fn get_doc_by_path(&self, rel_path: &str) -> AppResult<Option<DocRow>> {
        let rel_path = rel_path.to_string();
        self.call(move |conn| {
            conn.query_row(
                "SELECT * FROM docs WHERE rel_path = ?1",
                [&rel_path],
                row_to_doc,
            )
            .optional()
        })
        .await
    }

    /// 同一 reader.id 出现在两个文件时，给后来者派生稳定 id。
    pub async fn resolve_id(&self, preferred: &str, rel_path: &str) -> AppResult<String> {
        let preferred = preferred.to_string();
        let rel_path = rel_path.to_string();
        self.call(move |conn| {
            let existing = conn
                .query_row("SELECT rel_path FROM docs WHERE id = ?1", [&preferred], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?;
            match existing {
                Some(path) if path != rel_path => {
                    Ok(format!("{preferred}-{}", base64url_8(&rel_path)))
                }
                _ => Ok(preferred),
            }
        })
        .await
    }

    pub async fn upsert_document(&self, doc: DocRecord) -> AppResult<()> {
        self.call(move |conn| {
            conn.execute(
                "INSERT INTO docs (id, rel_path, kind, meta_path, mtime, size, hash, title, tags, aliases,
                                   status, progress, words, excerpt, source_url, encoding, eol, created,
                                   indexed_at, ann_count)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
                 ON CONFLICT(id) DO UPDATE SET
                   rel_path = excluded.rel_path, kind = excluded.kind, meta_path = excluded.meta_path,
                   mtime = excluded.mtime, size = excluded.size, hash = excluded.hash,
                   title = excluded.title, tags = excluded.tags, aliases = excluded.aliases,
                   status = excluded.status, progress = excluded.progress, words = excluded.words,
                   excerpt = excluded.excerpt, source_url = excluded.source_url,
                   encoding = excluded.encoding, eol = excluded.eol, created = excluded.created,
                   indexed_at = excluded.indexed_at, ann_count = excluded.ann_count",
                params![
                    doc.id,
                    doc.rel_path,
                    doc.kind,
                    doc.meta_path,
                    doc.mtime,
                    doc.size,
                    doc.hash,
                    doc.title,
                    serde_json::to_string(&doc.tags).unwrap_or_else(|_| "[]".into()),
                    serde_json::to_string(&doc.aliases).unwrap_or_else(|_| "[]".into()),
                    doc.status.as_str(),
                    doc.progress,
                    doc.words,
                    doc.excerpt,
                    doc.source_url,
                    doc.encoding,
                    doc.eol,
                    doc.created,
                    doc.indexed_at,
                    doc.ann_count,
                ],
            )?;
            conn.execute("DELETE FROM docs_fts WHERE doc_id = ?1", [&doc.id])?;
            conn.execute(
                "INSERT INTO docs_fts (doc_id, rel_path, title_tokens, body_tokens, tags_tokens, notes_tokens, bigrams)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![
                    doc.id,
                    doc.rel_path,
                    doc.title_tokens,
                    doc.body_tokens,
                    doc.tags_tokens,
                    doc.notes_tokens,
                    doc.bigrams
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn remove_document(&self, id: &str) -> AppResult<()> {
        let id = id.to_string();
        self.call(move |conn| {
            conn.execute("DELETE FROM docs WHERE id = ?1", [&id])?;
            conn.execute("DELETE FROM docs_fts WHERE doc_id = ?1", [&id])?;
            conn.execute("DELETE FROM links WHERE src_id = ?1", [&id])?;
            conn.execute("UPDATE links SET dst_id = NULL WHERE dst_id = ?1", [&id])?;
            conn.execute("DELETE FROM annotations_mirror WHERE doc_id = ?1", [&id])?;
            Ok(())
        })
        .await
    }

    pub async fn update_reader_meta(
        &self,
        id: &str,
        status: Option<DocStatus>,
        progress: Option<f64>,
        ann_count: Option<i64>,
    ) -> AppResult<()> {
        let id = id.to_string();
        self.call(move |conn| {
            let mut sets: Vec<&str> = Vec::new();
            let mut values: Vec<SqlValue> = Vec::new();
            if let Some(status) = status {
                sets.push("status = ?");
                values.push(SqlValue::Text(status.as_str().into()));
            }
            if let Some(progress) = progress {
                sets.push("progress = ?");
                values.push(SqlValue::Real(progress.clamp(0.0, 1.0)));
            }
            if let Some(count) = ann_count {
                sets.push("ann_count = ?");
                values.push(SqlValue::Integer(count));
            }
            if sets.is_empty() {
                return Ok(());
            }
            values.push(SqlValue::Text(id));
            let sql = format!("UPDATE docs SET {} WHERE id = ?", sets.join(", "));
            conn.execute(&sql, params_from_iter(values))?;
            Ok(())
        })
        .await
    }

    pub async fn update_indexed_meta(
        &self,
        id: &str,
        title: Option<&str>,
        tags: Option<&[String]>,
        excerpt: Option<&str>,
        mtime: Option<i64>,
        size: Option<i64>,
        hash: Option<&str>,
    ) -> AppResult<()> {
        let id = id.to_string();
        let title = title.map(|s| s.to_string());
        let tags = tags.map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".into()));
        let excerpt = excerpt.map(|s| s.to_string());
        let hash = hash.map(|s| s.to_string());
        self.call(move |conn| {
            let mut sets: Vec<&str> = Vec::new();
            let mut values: Vec<SqlValue> = Vec::new();
            if let Some(v) = title {
                sets.push("title = ?");
                values.push(SqlValue::Text(v));
            }
            if let Some(v) = tags {
                sets.push("tags = ?");
                values.push(SqlValue::Text(v));
            }
            if let Some(v) = excerpt {
                sets.push("excerpt = ?");
                values.push(SqlValue::Text(v));
            }
            if let Some(v) = mtime {
                sets.push("mtime = ?");
                values.push(SqlValue::Integer(v));
            }
            if let Some(v) = size {
                sets.push("size = ?");
                values.push(SqlValue::Integer(v));
            }
            if let Some(v) = hash {
                sets.push("hash = ?");
                values.push(SqlValue::Text(v));
            }
            if sets.is_empty() {
                return Ok(());
            }
            values.push(SqlValue::Text(id));
            let sql = format!("UPDATE docs SET {} WHERE id = ?", sets.join(", "));
            conn.execute(&sql, params_from_iter(values))?;
            Ok(())
        })
        .await
    }

    pub async fn list_docs(&self, options: ListOptions) -> AppResult<Vec<DocRow>> {
        let fts_ids = match &options.q {
            Some(q) if !q.trim().is_empty() => {
                let hits = self.search(q, 1000, 0).await?;
                Some(hits.into_iter().map(|(d, _)| d.id).collect::<Vec<_>>())
            }
            _ => None,
        };
        self.call(move |conn| {
            let mut where_parts: Vec<String> = Vec::new();
            let mut values: Vec<SqlValue> = Vec::new();
            if let Some(status) = options.status {
                where_parts.push("status = ?".into());
                values.push(SqlValue::Text(status.as_str().into()));
            }
            if let Some(tag) = &options.tag {
                where_parts.push("tags LIKE ?".into());
                values.push(SqlValue::Text(format!(
                    "%\"{}\"%",
                    tag.replace('"', "\\\"")
                )));
            }
            if let Some(ids) = &fts_ids {
                if ids.is_empty() {
                    return Ok(Vec::new());
                }
                let placeholders = vec!["?"; ids.len()].join(",");
                where_parts.push(format!("id IN ({placeholders})"));
                for id in ids {
                    values.push(SqlValue::Text(id.clone()));
                }
            }
            let order = match options.sort.as_str() {
                "title" => "title COLLATE NOCASE ASC",
                "words" => "words DESC",
                "added" => "indexed_at DESC",
                _ => "mtime DESC",
            };
            let limit = options.limit.unwrap_or(5000).clamp(1, 20000);
            let offset = options.offset.unwrap_or(0).max(0);
            let where_sql = if where_parts.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", where_parts.join(" AND "))
            };
            let sql = format!(
                "SELECT * FROM docs {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
            );
            values.push(SqlValue::Integer(limit));
            values.push(SqlValue::Integer(offset));
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<DocRow> = stmt
                .query_map(params_from_iter(values), row_to_doc)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .await
    }

    pub async fn search_ids(&self, query: &str, limit: i64) -> AppResult<Vec<String>> {
        Ok(self
            .search(query, limit, 0)
            .await?
            .into_iter()
            .map(|(d, _)| d.id)
            .collect())
    }

    pub async fn search(
        &self,
        query: &str,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<(DocRow, f64)>> {
        let limit = limit.clamp(1, 200);
        let offset = offset.max(0);
        let Some(match_query) = build_match_query(query) else {
            return Ok(Vec::new());
        };
        let bigram = build_bigram_query(query);
        let rows = self
            .call(move |conn| search_rows(conn, &match_query, limit, offset))
            .await?;
        // bigram 兜底：不仅在主查询为空时使用，而是把补充结果追加在后面，
        // 解决 jieba 与 Intl.Segmenter 切分差异导致的漏召回（PRD §4.17）。
        let extra = match bigram {
            Some(q) if rows.len() < limit as usize => {
                self.call(move |conn| search_rows(conn, &q, limit, 0))
                    .await?
            }
            _ => Vec::new(),
        };
        let mut seen: HashSet<String> = rows.iter().map(|(id, _)| id.clone()).collect();
        let mut merged = rows;
        for (id, rank) in extra {
            if merged.len() >= limit as usize {
                break;
            }
            if seen.insert(id.clone()) {
                merged.push((id, rank));
            }
        }
        if merged.len() < limit as usize {
            if let Some(char_query) = build_char_query(query) {
                let more = self
                    .call(move |conn| search_rows(conn, &char_query, limit, 0))
                    .await?;
                for (id, rank) in more {
                    if merged.len() >= limit as usize {
                        break;
                    }
                    if seen.insert(id.clone()) {
                        merged.push((id, rank));
                    }
                }
            }
        }
        let mut out = Vec::new();
        for (id, rank) in merged {
            if let Some(doc) = self.get_doc(&id).await? {
                out.push((doc, rank));
            }
        }
        Ok(out)
    }

    pub async fn stats(&self) -> AppResult<DocStats> {
        let rows = self
            .call(|conn| {
                let total: i64 = conn.query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))?;
                let words: i64 =
                    conn.query_row("SELECT COALESCE(SUM(words),0) FROM docs", [], |r| r.get(0))?;
                let mut stmt = conn.prepare("SELECT tags, status FROM docs")?;
                let mapped = stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?;
                let mut tag_set = HashSet::new();
                let mut by_status: HashMap<String, i64> = HashMap::new();
                for item in mapped {
                    let (tags, status) = item?;
                    for t in parse_json_list(&tags) {
                        tag_set.insert(t);
                    }
                    *by_status.entry(status).or_insert(0) += 1;
                }
                Ok((total, words, tag_set.len() as i64, by_status))
            })
            .await?;
        let indexed_at = self
            .get_meta("lastIndexedAt")
            .await?
            .and_then(|v| v.parse::<i64>().ok());
        Ok(DocStats {
            total: rows.0,
            words: rows.1,
            tags: rows.2,
            by_status: rows.3,
            indexed_at,
        })
    }

    pub async fn tag_counts(&self) -> AppResult<Vec<(String, i64)>> {
        let rows = self
            .call(|conn| {
                let mut stmt = conn.prepare("SELECT tags FROM docs")?;
                let mapped = stmt.query_map([], |r| r.get::<_, String>(0))?;
                let mut counts: HashMap<String, i64> = HashMap::new();
                for item in mapped {
                    for tag in parse_json_list(&item?) {
                        *counts.entry(tag).or_insert(0) += 1;
                    }
                }
                Ok(counts.into_iter().collect::<Vec<_>>())
            })
            .await?;
        let mut rows = rows;
        rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(rows)
    }

    /* -------------------------------------------------------------- links */

    pub async fn replace_links(&self, src_id: &str, links: Vec<(String, Option<String>, String)>) -> AppResult<()> {
        let src_id = src_id.to_string();
        self.call(move |conn| {
            conn.execute("DELETE FROM links WHERE src_id = ?1", [&src_id])?;
            let mut stmt = conn.prepare(
                "INSERT INTO links (src_id, dst_id, dst_raw, dst_anchor, kind) VALUES (?1, NULL, ?2, ?3, ?4)",
            )?;
            for (dst_raw, anchor, kind) in links {
                stmt.execute(params![src_id, dst_raw, anchor, kind])?;
            }
            Ok(())
        })
        .await
    }

    pub async fn distinct_link_targets(&self) -> AppResult<Vec<String>> {
        self.call(|conn| {
            let mut stmt = conn.prepare("SELECT DISTINCT dst_raw FROM links")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect()
        })
        .await
    }

    /// 按解析结果批量更新 dst_id；返回 (total, resolved)。
    pub async fn apply_link_targets(
        &self,
        targets: HashMap<String, Option<String>>,
    ) -> AppResult<(i64, i64)> {
        self.call(move |conn| {
            let tx = conn.transaction()?;
            let mut total = 0i64;
            let mut resolved = 0i64;
            {
                let mut stmt = tx.prepare("UPDATE links SET dst_id = ?1 WHERE dst_raw = ?2")?;
                for (raw, id) in &targets {
                    let changes = stmt.execute(params![id, raw])? as i64;
                    total += changes;
                    if id.is_some() {
                        resolved += changes;
                    }
                }
            }
            tx.commit()?;
            Ok((total, resolved))
        })
        .await
    }

    pub async fn backlinks_for(&self, doc_id: &str) -> AppResult<Vec<BacklinkRow>> {
        let doc_id = doc_id.to_string();
        self.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT l.src_id AS srcId, d.title AS srcTitle, d.rel_path AS relPath, l.dst_anchor AS anchor
                 FROM links l JOIN docs d ON d.id = l.src_id
                 WHERE l.dst_id = ?1 ORDER BY d.title COLLATE NOCASE",
            )?;
            let rows = stmt.query_map([&doc_id], |r| {
                Ok(BacklinkRow {
                    src_id: r.get("srcId")?,
                    src_title: r.get("srcTitle")?,
                    rel_path: r.get("relPath")?,
                    anchor: r.get("anchor")?,
                })
            })?;
            rows.collect()
        })
        .await
    }

    pub async fn outlinks_for(&self, doc_id: &str) -> AppResult<Vec<OutlinkRow>> {
        let doc_id = doc_id.to_string();
        self.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT l.dst_id AS dstId, l.dst_raw AS dstRaw, d.title AS dstTitle, l.dst_anchor AS anchor
                 FROM links l LEFT JOIN docs d ON d.id = l.dst_id
                 WHERE l.src_id = ?1 ORDER BY l.dst_raw",
            )?;
            let rows = stmt.query_map([&doc_id], |r| {
                Ok(OutlinkRow {
                    dst_id: r.get("dstId")?,
                    dst_raw: r.get("dstRaw")?,
                    dst_title: r.get("dstTitle")?,
                    anchor: r.get("anchor")?,
                })
            })?;
            rows.collect()
        })
        .await
    }

    pub async fn broken_links(&self, limit: i64) -> AppResult<Vec<BrokenLinkRow>> {
        self.call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT l.src_id AS srcId, d.title AS srcTitle, l.dst_raw AS dstRaw, l.dst_anchor AS anchor
                 FROM links l JOIN docs d ON d.id = l.src_id
                 WHERE l.dst_id IS NULL ORDER BY d.title LIMIT ?1",
            )?;
            let rows = stmt.query_map([limit], |r| {
                Ok(BrokenLinkRow {
                    src_id: r.get("srcId")?,
                    src_title: r.get("srcTitle")?,
                    dst_raw: r.get("dstRaw")?,
                    anchor: r.get("anchor")?,
                })
            })?;
            rows.collect()
        })
        .await
    }

    pub async fn mention_candidates(
        &self,
        title: &str,
        exclude_id: &str,
        limit: i64,
    ) -> AppResult<Vec<DocRow>> {
        let hits = self.search(title, limit + 5, 0).await?;
        let mut out = Vec::new();
        let exclude = exclude_id.to_string();
        for (doc, _) in hits {
            if doc.id == exclude_id {
                continue;
            }
            let id = doc.id.clone();
            let exclude = exclude.clone();
            let linked = self
                .call(move |conn| {
                    conn.query_row(
                        "SELECT 1 FROM links WHERE src_id = ?1 AND dst_id = ?2 LIMIT 1",
                        params![id, exclude],
                        |_| Ok(()),
                    )
                    .optional()
                })
                .await?;
            if linked.is_some() {
                continue;
            }
            out.push(doc);
            if out.len() as i64 >= limit {
                break;
            }
        }
        Ok(out)
    }

    /* -------------------------------------------------------------- annotations */

    pub async fn replace_annotations(
        &self,
        doc_id: &str,
        annotations: Vec<(String, String, String, String, String)>,
    ) -> AppResult<()> {
        let doc_id = doc_id.to_string();
        self.call(move |conn| {
            conn.execute("DELETE FROM annotations_mirror WHERE doc_id = ?1", [&doc_id])?;
            let mut stmt = conn.prepare(
                "INSERT INTO annotations_mirror (id, doc_id, exact, note, color, created) VALUES (?1,?2,?3,?4,?5,?6)",
            )?;
            for (id, exact, note, color, created) in annotations {
                let ts = chrono::DateTime::parse_from_rfc3339(&created)
                    .map(|d| d.timestamp_millis())
                    .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
                stmt.execute(params![id, doc_id, exact, note, color, ts])?;
            }
            Ok(())
        })
        .await
    }

    pub async fn clear_docs(&self) -> AppResult<()> {
        self.call(|conn| {
            conn.execute_batch(
                "DELETE FROM docs; DELETE FROM docs_fts; DELETE FROM links; DELETE FROM annotations_mirror;",
            )
        })
        .await
    }

    pub async fn is_fresh(&self, rel_path: &str, mtime: i64, size: i64) -> AppResult<bool> {
        let rel_path = rel_path.to_string();
        self.call(move |conn| {
            let row = conn
                .query_row(
                    "SELECT mtime, size FROM docs WHERE rel_path = ?1",
                    [&rel_path],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
                )
                .optional()?;
            Ok(matches!(row, Some((m, s)) if m == mtime && s == size))
        })
        .await
    }

    pub async fn all_docs_for_resolve(&self) -> AppResult<Vec<DocRow>> {
        self.call(|conn| {
            let mut stmt = conn.prepare("SELECT * FROM docs")?;
            let rows = stmt.query_map([], row_to_doc)?;
            rows.collect()
        })
        .await
    }

    pub async fn docs_with_sources(&self) -> AppResult<Vec<(String, String, String, String)>> {
        self.call(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, rel_path, title, source_url FROM docs
                 WHERE source_url IS NOT NULL AND source_url <> ''",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?;
            rows.collect()
        })
        .await
    }

    pub async fn stale_docs(&self, existing: HashSet<String>) -> AppResult<Vec<(String, String)>> {
        self.call(move |conn| {
            let mut stmt = conn.prepare("SELECT id, rel_path FROM docs")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut out = Vec::new();
            for row in rows {
                let (id, rel) = row?;
                if !existing.contains(&rel) {
                    out.push((id, rel));
                }
            }
            Ok(out)
        })
        .await
    }

    pub async fn update_rel_path(&self, id: &str, rel_path: &str) -> AppResult<()> {
        let id = id.to_string();
        let rel_path = rel_path.to_string();
        self.call(move |conn| {
            conn.execute(
                "UPDATE docs SET rel_path = ?1 WHERE id = ?2",
                params![rel_path, id],
            )?;
            Ok(())
        })
        .await
    }

    /* -------------------------------------------------------------- AI 任务 */

    pub async fn ai_job_insert(&self, job: AiJobRow) -> AppResult<()> {
        self.call(move |conn| {
            conn.execute(
                "INSERT INTO ai_jobs(id, doc_id, kind, status, request, created_at, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    job.id,
                    job.doc_id,
                    job.kind,
                    job.status,
                    job.request,
                    job.created_at,
                    job.updated_at
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub async fn ai_job_get(&self, id: &str) -> AppResult<Option<AiJobRow>> {
        let id = id.to_string();
        self.call(move |conn| {
            conn.query_row("SELECT * FROM ai_jobs WHERE id = ?1", [&id], row_to_ai_job)
                .optional()
        })
        .await
    }

    /// 领取一条排队任务。DB 只有一个线程，读+改写天然是原子的。
    pub async fn ai_job_claim(&self, worker: &str) -> AppResult<Option<AiJobRow>> {
        let worker = worker.to_string();
        self.call(move |conn| {
            let picked = {
                let mut stmt = conn.prepare(
                    "SELECT * FROM ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1",
                )?;
                stmt.query_row([], row_to_ai_job).optional()?
            };
            let Some(mut job) = picked else {
                return Ok(None);
            };
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "UPDATE ai_jobs
                    SET status = 'running', worker = ?1, attempts = attempts + 1,
                        claimed_at = ?2, updated_at = ?2
                  WHERE id = ?3",
                params![worker, now, job.id],
            )?;
            job.status = "running".into();
            job.worker = Some(worker);
            job.attempts += 1;
            job.claimed_at = Some(now);
            job.updated_at = now;
            Ok(Some(job))
        })
        .await
    }

    pub async fn ai_job_finish(
        &self,
        id: &str,
        status: &str,
        result: Option<String>,
        error: Option<String>,
        ai_id: Option<String>,
    ) -> AppResult<()> {
        let id = id.to_string();
        let status = status.to_string();
        self.call(move |conn| {
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "UPDATE ai_jobs
                    SET status = ?1, result = COALESCE(?2, result), error = ?3,
                        ai_id = COALESCE(?4, ai_id), updated_at = ?5, finished_at = ?5
                  WHERE id = ?6",
                params![status, result, error, ai_id, now, id],
            )?;
            Ok(())
        })
        .await
    }

    /// 把超时未交回的 running 任务放回队列，避免 worker 崩了任务卡死。
    pub async fn ai_job_requeue_stale(&self, stale_ms: i64) -> AppResult<usize> {
        self.call(move |conn| {
            let now = chrono::Utc::now().timestamp_millis();
            let cutoff = now - stale_ms;
            let n = conn.execute(
                "UPDATE ai_jobs SET status = 'queued', worker = NULL, updated_at = ?1
                  WHERE status = 'running' AND updated_at < ?2",
                params![now, cutoff],
            )?;
            Ok(n)
        })
        .await
    }

    pub async fn ai_job_cancel(&self, id: &str) -> AppResult<bool> {
        let id = id.to_string();
        self.call(move |conn| {
            let now = chrono::Utc::now().timestamp_millis();
            let n = conn.execute(
                "UPDATE ai_jobs SET status = 'canceled', updated_at = ?1, finished_at = ?1
                  WHERE id = ?2 AND status IN ('queued', 'running')",
                params![now, id],
            )?;
            Ok(n > 0)
        })
        .await
    }

    pub async fn ai_jobs_list(
        &self,
        status: Option<String>,
        doc_id: Option<String>,
        limit: i64,
    ) -> AppResult<Vec<AiJobRow>> {
        self.call(move |conn| {
            let mut sql = String::from("SELECT * FROM ai_jobs WHERE 1 = 1");
            if status.is_some() {
                sql.push_str(" AND status = ?1");
            }
            if doc_id.is_some() {
                sql.push_str(if status.is_some() {
                    " AND doc_id = ?2"
                } else {
                    " AND doc_id = ?1"
                });
            }
            sql.push_str(" ORDER BY created_at DESC LIMIT ");
            sql.push_str(&limit.clamp(1, 500).to_string());
            let mut stmt = conn.prepare(&sql)?;
            let mut out = Vec::new();
            match (status, doc_id) {
                (Some(s), Some(d)) => {
                    let rows = stmt.query_map(params![s, d], row_to_ai_job)?;
                    for r in rows {
                        out.push(r?);
                    }
                }
                (Some(s), None) => {
                    let rows = stmt.query_map(params![s], row_to_ai_job)?;
                    for r in rows {
                        out.push(r?);
                    }
                }
                (None, Some(d)) => {
                    let rows = stmt.query_map(params![d], row_to_ai_job)?;
                    for r in rows {
                        out.push(r?);
                    }
                }
                (None, None) => {
                    let rows = stmt.query_map([], row_to_ai_job)?;
                    for r in rows {
                        out.push(r?);
                    }
                }
            }
            Ok(out)
        })
        .await
    }

    /// 清掉早就结束的任务记录（保留 7 天足够排查）。
    pub async fn ai_jobs_purge(&self, older_than_ms: i64) -> AppResult<usize> {
        self.call(move |conn| {
            let cutoff = chrono::Utc::now().timestamp_millis() - older_than_ms;
            let n = conn.execute(
                "DELETE FROM ai_jobs
                  WHERE status IN ('done', 'error', 'canceled') AND updated_at < ?1",
                params![cutoff],
            )?;
            Ok(n)
        })
        .await
    }
}

#[derive(Clone, Debug, Default)]
pub struct AiJobRow {
    pub id: String,
    pub doc_id: String,
    pub kind: String,
    pub status: String,
    pub request: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub worker: Option<String>,
    pub attempts: i64,
    pub ai_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub claimed_at: Option<i64>,
    pub finished_at: Option<i64>,
}

fn row_to_ai_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiJobRow> {
    Ok(AiJobRow {
        id: row.get("id")?,
        doc_id: row.get("doc_id")?,
        kind: row.get("kind")?,
        status: row.get("status")?,
        request: row.get("request")?,
        result: row.get("result")?,
        error: row.get("error")?,
        worker: row.get("worker")?,
        attempts: row.get("attempts")?,
        ai_id: row.get("ai_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        claimed_at: row.get("claimed_at")?,
        finished_at: row.get("finished_at")?,
    })
}

#[derive(Clone, Debug)]
pub struct BacklinkRow {
    pub src_id: String,
    pub src_title: String,
    pub rel_path: String,
    pub anchor: Option<String>,
}

#[derive(Clone, Debug)]
pub struct OutlinkRow {
    pub dst_id: Option<String>,
    pub dst_raw: String,
    pub dst_title: Option<String>,
    pub anchor: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BrokenLinkRow {
    pub src_id: String,
    pub src_title: String,
    pub dst_raw: String,
    pub anchor: Option<String>,
}

fn search_rows(
    conn: &Connection,
    match_query: &str,
    limit: i64,
    offset: i64,
) -> rusqlite::Result<Vec<(String, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT doc_id, bm25(docs_fts, 0.0, 0.0, 8.0, 1.0, 4.0, 2.0, 0.5) AS rank
         FROM docs_fts WHERE docs_fts MATCH ?1 ORDER BY rank LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![match_query, limit, offset], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v3 旧库没有 kind/meta_path，迁移必须先 ALTER 再建 docs_kind 索引。
    #[test]
    fn migrates_v3_database_without_kind() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE docs (
               id TEXT PRIMARY KEY, rel_path TEXT UNIQUE NOT NULL, mtime INTEGER NOT NULL,
               size INTEGER NOT NULL, hash TEXT NOT NULL, title TEXT NOT NULL,
               tags TEXT NOT NULL DEFAULT '[]', aliases TEXT NOT NULL DEFAULT '[]',
               status TEXT NOT NULL DEFAULT 'unread', progress REAL NOT NULL DEFAULT 0,
               words INTEGER NOT NULL DEFAULT 0, excerpt TEXT NOT NULL DEFAULT '',
               source_url TEXT, encoding TEXT NOT NULL DEFAULT 'utf8',
               eol TEXT NOT NULL DEFAULT '\\n', created TEXT,
               indexed_at INTEGER NOT NULL, ann_count INTEGER NOT NULL DEFAULT 0
             );
             CREATE VIRTUAL TABLE docs_fts USING fts5(
               doc_id UNINDEXED, rel_path, title_tokens, body_tokens,
               tags_tokens, notes_tokens, bigrams, tokenize = 'unicode61'
             );
             PRAGMA user_version = 1;",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let cols = table_columns(&conn, "docs").unwrap();
        assert!(cols.iter().any(|c| c == "kind"));
        assert!(cols.iter().any(|c| c == "meta_path"));
        let index_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='docs_kind'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(index_exists, 1);
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }
}

fn base64url_8(input: &str) -> String {    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bytes = input.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 0x3f) as usize] as char);
        }
        if out.len() >= 8 {
            break;
        }
    }
    out.chars().take(8).collect()
}
