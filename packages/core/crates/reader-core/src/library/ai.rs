//! AI 落位层：`reader.ai[]` 的读写、任务队列、上下文包。
//!
//! 这里**不调用任何模型**。enod 只负责三件事：
//! 1. 把「要 AI 做什么、做在文章的哪一段」变成一条可重跑的任务；
//! 2. 把任务交给外部 worker（DSH 插件）时，附上已经组装好的上下文；
//! 3. 把 worker 交回来的结果锚定写进 `frontmatter.reader.ai[]`。
//!
//! 模型、提示词、联网都在 worker 侧，见 docs/AI-DIRECTION.md。

use super::{parse, Loaded, LibraryService, SaveInput};
use crate::adapt::kind_of;
use crate::db::{AiJobRow, DocRow};
use crate::encoding::decode_file;
use crate::error::{AppError, AppResult};
use crate::frontmatter::{
    is_ai_kind, parse_layout, read_ai_enabled, read_ai_entries, AiEntry, AiRun, AiSource,
    ReaderPatch,
};
use crate::ulid::new_ulid;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// 任务包里带的提示词版本号，worker 用它决定用哪套提示词。
pub const PROMPT_VERSION: &str = "enod-ai-v1";
/// 单篇文档最多留多少条 AI 产出，超出丢最老的。
const MAX_ENTRIES: usize = 50;
const MAX_OUTPUT_CHARS: usize = 20_000;
const CONTEXT_BUDGET: usize = 4_000;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub kind: Option<String>,
    pub exact: Option<String>,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub pos: Option<f64>,
    pub question: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResultInput {
    pub output: Option<String>,
    pub sources: Option<Vec<AiSource>>,
    pub model: Option<String>,
    pub prompt: Option<String>,
    pub duration_ms: Option<i64>,
    pub ai_id: Option<String>,
}

impl LibraryService {
    /// 读一篇文档的 AI 产出。目前只有 md 支持（非 md 没有 frontmatter）。
    pub async fn ai_entries(&self, row: &DocRow) -> AppResult<Vec<AiEntry>> {
        let kind = kind_of(&row.rel_path).unwrap_or(crate::adapt::DocKind::Md);
        if kind != crate::adapt::DocKind::Md {
            return Ok(Vec::new());
        }
        let abs = self.doc_abs(row)?;
        let buffer = tokio::fs::read(&abs).await?;
        let text = decode_file(&buffer).text;
        let layout = parse_layout(&text);
        Ok(read_ai_entries(&layout.frontmatter))
    }

    async fn ai_enabled_for(&self, row: &DocRow) -> AppResult<bool> {
        let kind = kind_of(&row.rel_path).unwrap_or(crate::adapt::DocKind::Md);
        if kind != crate::adapt::DocKind::Md {
            return Ok(false);
        }
        let abs = self.doc_abs(row)?;
        let buffer = tokio::fs::read(&abs).await?;
        let text = decode_file(&buffer).text;
        Ok(read_ai_enabled(&parse_layout(&text).frontmatter))
    }

    async fn write_ai_entries(
        self: &Arc<Self>,
        doc_id: &str,
        entries: Vec<AiEntry>,
    ) -> AppResult<Value> {
        let entries = if entries.len() > MAX_ENTRIES {
            entries[entries.len() - MAX_ENTRIES..].to_vec()
        } else {
            entries
        };
        let result = self
            .save_doc(
                doc_id,
                SaveInput {
                    reader: Some(ReaderPatch {
                        ai: Some(entries.clone()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await?;
        Ok(json!({
            "hash": result.hash,
            "count": entries.len(),
            "ai": entries,
        }))
    }

    /* ------------------------------------------------------------ 产出条目 */

    pub async fn delete_ai_entry(self: &Arc<Self>, doc_id: &str, ai_id: &str) -> AppResult<Value> {
        let row = self.require_doc(doc_id).await?;
        let entries = self.ai_entries(&row).await?;
        let kept: Vec<AiEntry> = entries.iter().filter(|e| e.id != ai_id).cloned().collect();
        if kept.len() == entries.len() {
            return Err(AppError::not_found("这条 AI 产出不存在"));
        }
        self.write_ai_entries(doc_id, kept).await
    }

    /* -------------------------------------------------------------- 任务队列 */

    pub async fn enqueue_ai_job(self: &Arc<Self>, doc_id: &str, req: AiRequest) -> AppResult<Value> {
        if self.root_path().is_none() {
            return Err(AppError::new(409, "no-library", "还没有挂载书库"));
        }
        let row = self.require_doc(doc_id).await?;
        let kind = req.kind.unwrap_or_else(|| "explain".into());
        if !is_ai_kind(&kind) {
            return Err(AppError::bad_request("未知的 AI 任务类型"));
        }
        if !self.ai_enabled_for(&row).await? {
            return Err(AppError::bad_request("这篇文档关掉了 AI（reader.ai: false）"));
        }
        let exact = req.exact.unwrap_or_default().chars().take(5000).collect::<String>();
        if exact.trim().is_empty() && kind != "summarize" {
            return Err(AppError::bad_request("缺少要提问的原文片段"));
        }
        let request = json!({
            "exact": exact,
            "prefix": req.prefix.unwrap_or_default().chars().take(200).collect::<String>(),
            "suffix": req.suffix.unwrap_or_default().chars().take(200).collect::<String>(),
            "pos": req.pos.filter(|p| p.is_finite()).map(|p| p.max(0.0).round() as i64).unwrap_or(0),
            "question": req.question.unwrap_or_default().chars().take(2000).collect::<String>(),
        });
        // 同一文档、同一片段、同一类型还在排队时不要重复入队
        let pending = self.db.ai_jobs_list(None, Some(doc_id.to_string()), 50).await?;
        for job in &pending {
            if matches!(job.status.as_str(), "queued" | "running") && job.kind == kind {
                let same: Value = serde_json::from_str(&job.request).unwrap_or(Value::Null);
                if same.get("exact").and_then(|v| v.as_str())
                    == request.get("exact").and_then(|v| v.as_str())
                {
                    return Ok(json!({ "jobId": job.id, "status": job.status, "deduped": true }));
                }
            }
        }
        let id = new_ulid();
        let now = chrono::Utc::now().timestamp_millis();
        self.db
            .ai_job_insert(AiJobRow {
                id: id.clone(),
                doc_id: doc_id.to_string(),
                kind: kind.clone(),
                status: "queued".into(),
                request: request.to_string(),
                result: None,
                error: None,
                worker: None,
                attempts: 0,
                ai_id: None,
                created_at: now,
                updated_at: now,
                claimed_at: None,
                finished_at: None,
            })
            .await?;
        self.hub.broadcast(
            "ai-job",
            json!({ "jobId": id, "docId": doc_id, "kind": kind, "status": "queued" }),
        );
        Ok(json!({ "jobId": id, "status": "queued", "kind": kind }))
    }

    /// worker 来领活：拿走一条排队的任务，附带已经组装好的上下文包。
    pub async fn claim_ai_job(self: &Arc<Self>, worker: &str) -> AppResult<Option<Value>> {
        let worker = if worker.trim().is_empty() {
            "anonymous"
        } else {
            worker.trim()
        };
        // worker 崩了留下的 running 任务，5 分钟后重新放回队列
        let _ = self.db.ai_job_requeue_stale(5 * 60_000).await;
        let Some(job) = self.db.ai_job_claim(worker).await? else {
            return Ok(None);
        };
        let package = self.build_job_package(&job).await?;
        self.hub.broadcast(
            "ai-job",
            json!({ "jobId": job.id, "status": "running", "worker": worker }),
        );
        Ok(Some(package))
    }

    async fn build_job_package(&self, job: &AiJobRow) -> AppResult<Value> {
        let row = self.require_doc(&job.doc_id).await?;
        let loaded: Loaded = self.load_doc(&row).await?;
        let request: Value = serde_json::from_str(&job.request).unwrap_or(Value::Null);
        let exact = request.get("exact").and_then(|v| v.as_str()).unwrap_or("");
        let pos = request.get("pos").and_then(|v| v.as_i64()).unwrap_or(0);
        let question = request.get("question").and_then(|v| v.as_str()).unwrap_or("");
        let (heading, text) = package_context(&loaded.body, exact, pos, CONTEXT_BUDGET);
        Ok(json!({
            "jobId": job.id,
            "docId": row.id,
            "docTitle": row.title,
            "relPath": row.rel_path,
            "kind": job.kind,
            "attempts": job.attempts,
            "promptVersion": PROMPT_VERSION,
            "instructions": instructions_for(&job.kind),
            "anchor": {
                "exact": exact,
                "prefix": request.get("prefix").and_then(|v| v.as_str()).unwrap_or(""),
                "suffix": request.get("suffix").and_then(|v| v.as_str()).unwrap_or(""),
                "pos": pos,
            },
            "question": question,
            "section": { "heading": heading, "text": text },
            "doc": {
                "title": row.title,
                "relPath": row.rel_path,
                "tags": row.tags,
                "sourceUrl": row.source_url,
                "words": row.words,
            },
        }))
    }

    /// worker 交回结果：写进 `reader.ai[]`，任务标记 done。
    pub async fn complete_ai_job(
        self: &Arc<Self>,
        job_id: &str,
        input: AiResultInput,
    ) -> AppResult<Value> {
        let job = self
            .db
            .ai_job_get(job_id)
            .await?
            .ok_or_else(|| AppError::not_found("AI 任务不存在"))?;
        if matches!(job.status.as_str(), "done" | "canceled") {
            return Err(AppError::conflict("这条任务已经结束了"));
        }
        let output = input
            .output
            .unwrap_or_default()
            .trim()
            .chars()
            .take(MAX_OUTPUT_CHARS)
            .collect::<String>();
        if output.is_empty() {
            return Err(AppError::bad_request("结果内容为空"));
        }
        let row = self.require_doc(&job.doc_id).await?;
        let request: Value = serde_json::from_str(&job.request).unwrap_or(Value::Null);
        let mut entries = self.ai_entries(&row).await?;

        let ai_id = input
            .ai_id
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(new_ulid);
        let sources = input
            .sources
            .unwrap_or_default()
            .into_iter()
            .take(8)
            .filter(|s| !s.url.trim().is_empty())
            .map(|s| AiSource {
                title: s.title.chars().take(200).collect(),
                url: s.url.chars().take(500).collect(),
            })
            .collect::<Vec<_>>();
        let entry = AiEntry {
            id: ai_id.clone(),
            kind: job.kind.clone(),
            exact: request.get("exact").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            prefix: request.get("prefix").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            suffix: request.get("suffix").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            pos: request.get("pos").and_then(|v| v.as_i64()).unwrap_or(0),
            output,
            sources,
            status: "ok".into(),
            created: crate::frontmatter::iso_now(),
            run: Some(AiRun {
                model: input.model.unwrap_or_default().chars().take(80).collect(),
                prompt: input
                    .prompt
                    .unwrap_or_else(|| PROMPT_VERSION.to_string())
                    .chars()
                    .take(40)
                    .collect(),
                started: job
                    .claimed_at
                    .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms))
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_else(crate::frontmatter::iso_now),
                ms: input.duration_ms.unwrap_or(0).max(0),
                job: job.id.clone(),
            }),
        };
        // 同一个 job 重交时覆盖而不是重复追加
        entries.retain(|e| e.id != ai_id);
        entries.push(entry.clone());
        self.write_ai_entries(&job.doc_id, entries).await?;

        let result = json!({ "aiId": ai_id, "kind": job.kind });
        self.db
            .ai_job_finish(&job.id, "done", Some(result.to_string()), None, Some(ai_id.clone()))
            .await?;
        self.hub.broadcast(
            "ai-result",
            json!({ "jobId": job.id, "docId": job.doc_id, "aiId": ai_id, "kind": job.kind }),
        );
        self.hub.broadcast(
            "doc-changed",
            json!({ "id": job.doc_id, "origin": "ai" }),
        );
        Ok(json!({ "jobId": job.id, "aiId": ai_id, "status": "done", "ai": entry }))
    }

    pub async fn fail_ai_job(self: &Arc<Self>, job_id: &str, message: &str) -> AppResult<Value> {
        let job = self
            .db
            .ai_job_get(job_id)
            .await?
            .ok_or_else(|| AppError::not_found("AI 任务不存在"))?;
        let error = json!({ "message": message.chars().take(2000).collect::<String>() });
        self.db
            .ai_job_finish(&job.id, "error", None, Some(error.to_string()), None)
            .await?;
        self.hub.broadcast(
            "ai-job",
            json!({ "jobId": job.id, "docId": job.doc_id, "status": "error", "message": message }),
        );
        Ok(json!({ "jobId": job.id, "status": "error" }))
    }

    pub async fn cancel_ai_job(self: &Arc<Self>, job_id: &str) -> AppResult<Value> {
        let ok = self.db.ai_job_cancel(job_id).await?;
        if !ok {
            return Err(AppError::not_found("没有可取消的任务"));
        }
        self.hub
            .broadcast("ai-job", json!({ "jobId": job_id, "status": "canceled" }));
        Ok(json!({ "jobId": job_id, "status": "canceled" }))
    }

    pub async fn ai_job_status(&self, job_id: &str) -> AppResult<Value> {
        let job = self
            .db
            .ai_job_get(job_id)
            .await?
            .ok_or_else(|| AppError::not_found("AI 任务不存在"))?;
        Ok(job_to_json(&job))
    }

    pub async fn list_ai_jobs(&self, status: Option<String>, doc_id: Option<String>) -> AppResult<Value> {
        let jobs = self.db.ai_jobs_list(status, doc_id, 100).await?;
        Ok(json!({
            "items": jobs.iter().map(job_to_json).collect::<Vec<_>>(),
            "pending": jobs.iter().filter(|j| j.status == "queued").count(),
            "running": jobs.iter().filter(|j| j.status == "running").count(),
        }))
    }
}

fn job_to_json(job: &AiJobRow) -> Value {
    let request: Value = serde_json::from_str(&job.request).unwrap_or(Value::Null);
    json!({
        "jobId": job.id,
        "docId": job.doc_id,
        "kind": job.kind,
        "status": job.status,
        "attempts": job.attempts,
        "worker": job.worker,
        "aiId": job.ai_id,
        "request": request,
        "result": job.result.as_ref().and_then(|s| serde_json::from_str::<Value>(s).ok()),
        "error": job.error.as_ref().and_then(|s| serde_json::from_str::<Value>(s).ok()),
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
        "claimedAt": job.claimed_at,
        "finishedAt": job.finished_at,
    })
}

fn instructions_for(kind: &str) -> &'static str {
    match kind {
        "explain" => "解释选中这段话在讲什么、为什么这么讲；不超过 200 字，必要时补一个具体例子。",
        "verify" => "核查这段话里的事实性断言：哪些站得住、哪些存疑、哪些明显过时。列出你检查了来源。",
        "background" => "补这段内容缺的背景：概念来源、历史脉络、谁提出过类似观点。优先给可点击的来源。",
        "counter" => "找出最强的反对意见：这段话哪里可能错、有哪些反例或不同流派。不要为了平衡而编造。",
        "summarize" => "用 5 条以内的要点概括这篇文档，每条一句话，按重要性排序。",
        _ => "回答读者针对这段原文提出的问题，答案要能直接放回原文旁边。",
    }
}

/* ------------------------------------------------------------------ 上下文 */

fn byte_at_char(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map(|(i, _)| i)
        .unwrap_or(text.len())
}

fn clamp_chars(text: &str, max_chars: usize) -> &str {
    match text.char_indices().nth(max_chars) {
        Some((i, _)) => &text[..i],
        None => text,
    }
}

fn heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return None;
    }
    let level = trimmed.chars().take_while(|c| *c == '#').count();
    if level == 0 || level > 6 {
        return None;
    }
    if trimmed.chars().nth(level).map(|c| c == ' ' || c == '\t') == Some(true) {
        Some(level)
    } else {
        None
    }
}

/// 取锚点所在的「小节」：最近的上级标题 + 该标题下的正文，截到预算内。
pub fn package_context(body: &str, exact: &str, pos: i64, budget: usize) -> (String, String) {
    let offset = if exact.trim().is_empty() {
        byte_at_char(body, pos.max(0) as usize)
    } else {
        body.find(exact)
            .unwrap_or_else(|| byte_at_char(body, pos.max(0) as usize))
    };
    let offset = offset.min(body.len());

    // 找到 offset 之前的最后一个标题行
    let mut section_start = 0usize;
    let mut heading = String::new();
    let mut level = 0usize;
    let mut cursor = 0usize;
    for line in body.split_inclusive('\n') {
        let line_start = cursor;
        cursor += line.len();
        if line_start > offset {
            break;
        }
        if let Some(lv) = heading_level(line) {
            section_start = line_start;
            heading = line.trim_start_matches('#').trim().to_string();
            level = lv;
        }
    }
    // 小节终点：下一个同级或更高级标题
    let mut section_end = body.len();
    let mut cursor = section_start;
    for line in body[section_start..].split_inclusive('\n') {
        let line_start = cursor;
        cursor += line.len();
        if line_start == section_start {
            continue; // 跳过本节自己的标题行
        }
        if let Some(lv) = heading_level(line) {
            if lv <= level.max(1) {
                section_end = line_start;
                break;
            }
        }
    }
    if section_end <= section_start {
        section_end = body.len();
    }

    let mut text = body[section_start..section_end].trim().to_string();
    if text.chars().count() > budget {
        // 围绕锚点取窗口，别把用户看的那句截掉
        let anchor_in_section = offset.saturating_sub(section_start).min(text.len());
        let anchor_chars = body[section_start..section_start + anchor_in_section]
            .chars()
            .count();
        let half = budget / 2;
        let from = anchor_chars.saturating_sub(half);
        let start_byte = byte_at_char(&text, from);
        let slice = &text[start_byte..];
        let out = clamp_chars(slice, budget);
        text = if from > 0 {
            format!("…（前略）{out}")
        } else {
            out.to_string()
        };
    }
    (heading, text)
}

// 让 parse 模块的导入保持被使用（与 annotations.rs 同样的写法）
#[allow(unused_imports)]
use parse as _parse_mod;

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "# 一\n开头\n## 小节 A\n甲甲甲\n目标句子在这里\n乙乙乙\n## 小节 B\n丙丙丙\n";

    #[test]
    fn finds_enclosing_section() {
        let (heading, text) = package_context(DOC, "目标句子在这里", 0, 4000);
        assert_eq!(heading, "小节 A");
        assert!(text.contains("甲甲甲"));
        assert!(text.contains("目标句子在这里"));
        assert!(!text.contains("丙丙丙"));
    }

    #[test]
    fn falls_back_to_pos_when_quote_missing() {
        let (heading, text) = package_context(DOC, "不存在的句子", 0, 4000);
        assert!(heading.is_empty() || heading == "一");
        assert!(!text.is_empty());
    }

    #[test]
    fn truncates_around_anchor() {
        let long = format!("# T\n{}\n锚点\n{}", "前".repeat(500), "后".repeat(500));
        let (_, text) = package_context(&long, "锚点", 0, 200);
        assert!(text.chars().count() <= 210);
        assert!(text.contains("锚点"));
    }
}
