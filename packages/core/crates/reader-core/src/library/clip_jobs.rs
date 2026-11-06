//! 剪藏任务队列：进程内 job 表 + 30 分钟 GC + 最多 50 条（PRD §4.14）。

use super::{dto_from_row, sanitize_dir, sanitize_segment, unique_path, LibraryService, SaveInput};
use crate::adapt::kind_of;
use crate::clip::extract::extract_article;
use crate::clip::fetch::fetch_page;
use crate::clip::url::{clip_key, normalize_clip_url, safe_hostname};
use crate::clip::{localize_images, ImageNameMode, LocalizeOptions};
use crate::error::{AppError, AppResult};
use crate::frontmatter::{build_frontmatter, BuildFrontmatter, SourceInfo};
use crate::hash::hash_buffer;
use crate::ulid::new_ulid;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipJob {
    pub job_id: String,
    pub url: String,
    pub status: String,
    pub progress: f64,
    pub message: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

impl LibraryService {
    fn prune_clip_jobs(&self) {
        let mut jobs = self
            .clip_jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let now = chrono::Utc::now().timestamp_millis();
        jobs.retain(|_, job| now - job.updated_at < 30 * 60_000);
        if jobs.len() > 50 {
            let mut by_age: Vec<(String, i64)> = jobs
                .iter()
                .map(|(id, job)| (id.clone(), job.updated_at))
                .collect();
            by_age.sort_by_key(|(_, at)| *at);
            for (id, _) in by_age.into_iter().take(jobs.len().saturating_sub(50)) {
                jobs.remove(&id);
            }
        }
    }

    fn update_job(
        self: &Arc<Self>,
        job_id: &str,
        status: &str,
        progress: f64,
        message: &str,
    ) {
        let mut jobs = self
            .clip_jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = status.to_string();
            job.progress = progress.clamp(0.0, 1.0);
            job.message = message.to_string();
            job.updated_at = chrono::Utc::now().timestamp_millis();
            let payload = json!({
                "jobId": job.job_id,
                "status": job.status,
                "progress": job.progress,
                "message": job.message,
                "at": job.updated_at,
            });
            drop(jobs);
            self.hub.broadcast("clip-progress", payload);
        }
    }

    fn finish_job(&self, job_id: &str, status: &str, progress: f64, message: &str, result: Value) {
        let mut jobs = self
            .clip_jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = status.to_string();
            job.progress = progress;
            job.message = message.to_string();
            job.updated_at = chrono::Utc::now().timestamp_millis();
            job.result = Some(result);
            let payload = json!({
                "jobId": job.job_id,
                "status": job.status,
                "progress": job.progress,
                "message": job.message,
                "at": job.updated_at,
            });
            drop(jobs);
            self.hub.broadcast("clip-progress", payload);
        }
    }

    fn fail_job(&self, job_id: &str, code: &str, message: &str) {
        let mut jobs = self
            .clip_jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = "error".into();
            job.progress = 1.0;
            job.message = message.to_string();
            job.updated_at = chrono::Utc::now().timestamp_millis();
            job.error = Some(json!({ "code": code, "message": message }));
            let payload = json!({
                "jobId": job.job_id,
                "status": job.status,
                "progress": job.progress,
                "message": job.message,
                "at": job.updated_at,
            });
            drop(jobs);
            self.hub.broadcast("clip-progress", payload);
        }
    }

    pub async fn start_clip(self: &Arc<Self>, url: String, mode: String) -> AppResult<Value> {
        if self.root_path().is_none() {
            return Err(AppError::new(409, "no-library", "还没有挂载书库"));
        }
        if !matches!(mode.as_str(), "ask" | "skip" | "new" | "overwrite") {
            return Err(AppError::bad_request("未知的剪藏模式"));
        }
        let allow_private = std::env::var("READER_CLIP_ALLOW_PRIVATE").as_deref() == Ok("1");
        if normalize_clip_url(&url, allow_private).is_none() {
            return Err(AppError::bad_request(
                "请输入有效的网页地址（http/https，不支持本机/内网）",
            ));
        }
        self.prune_clip_jobs();
        let job_id = new_ulid();
        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut jobs = self
                .clip_jobs
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            jobs.insert(
                job_id.clone(),
                ClipJob {
                    job_id: job_id.clone(),
                    url: url.clone(),
                    status: "queued".into(),
                    progress: 0.0,
                    message: "已加入队列".into(),
                    created_at: now,
                    updated_at: now,
                    result: None,
                    error: None,
                },
            );
        }
        let service = self.clone();
        let job = job_id.clone();
        tokio::spawn(async move {
            service.run_clip(job, url, mode, allow_private).await;
        });
        Ok(json!({ "jobId": job_id, "status": "queued" }))
    }

    async fn run_clip(self: Arc<Self>, job_id: String, url: String, mode: String, allow_private: bool) {
        self.update_job(&job_id, "fetching", 0.04, "正在抓取网页…");
        let page = match fetch_page(&url, allow_private).await {
            Ok(page) => page,
            Err(err) => {
                self.fail_job(&job_id, "clip-failed", &err);
                return;
            }
        };
        self.update_job(&job_id, "extracting", 0.24, "正在提取正文…");
        let article = match extract_article(&page.html, &page.final_url) {
            Ok(article) => article,
            Err(err) => {
                self.fail_job(&job_id, "clip-failed", &err);
                return;
            }
        };
        let canonical = {
            let key = clip_key(&article.canonical_url, true);
            if key.is_empty() {
                page.final_url.clone()
            } else {
                key
            }
        };
        let duplicate = self.find_clip_duplicate(&canonical).await;

        if let Some((dup_id, dup_title, _)) = &duplicate {
            if mode != "new" && mode != "overwrite" {
                self.update_job(
                    &job_id,
                    "duplicate",
                    1.0,
                    &format!("已经剪藏过「{dup_title}」"),
                );
                if let Ok(Some(row)) = self.db.get_doc(dup_id).await {
                    self.finish_job(
                        &job_id,
                        "duplicate",
                        1.0,
                        "发现重复文档",
                        json!({
                            "doc": dto_from_row(&row),
                            "title": dup_title,
                            "url": canonical,
                            "site": article.site,
                            "imageCount": 0,
                            "warnings": article.warnings,
                            "duplicate": { "id": dup_id, "title": dup_title, "relPath": row.rel_path },
                            "skipped": mode == "skip",
                        }),
                    );
                }
                return;
            }
        }

        if let Some((dup_id, dup_title, dup_rel)) = &duplicate {
            if mode == "overwrite" {
                self.update_job(&job_id, "images", 0.45, "正在保存图片…");
                let doc_id = dup_id.clone();
                let localized = localize_images(LocalizeOptions {
                    markdown: &article.markdown,
                    base_url: &page.final_url,
                    referer: &page.final_url,
                    referer_from_image_host: false,
                    doc_id: &doc_id,
                    root: &self.root_path().unwrap_or_default(),
                    allow_private,
                    max_images: 30,
                    name_mode: ImageNameMode::ContentHash,
                })
                .await;
                let mut warnings = article.warnings.clone();
                warnings.extend(localized.warnings.clone());
                if dup_title != &article.title {
                    warnings.push("已保留原文档标题，避免破坏已有的 [[链接]]。".into());
                }
                self.update_job(&job_id, "saving", 0.92, "正在覆盖正文…");
                match self
                    .save_doc(
                        &doc_id,
                        SaveInput {
                            body: Some(localized.markdown),
                            ..Default::default()
                        },
                    )
                    .await
                {
                    Ok(_) => {
                        self.hub.broadcast(
                            "doc-changed",
                            json!({ "id": doc_id, "origin": "clip-overwrite" }),
                        );
                        if let Ok(Some(row)) = self.db.get_doc(&doc_id).await {
                            self.finish_job(
                                &job_id,
                                "done",
                                1.0,
                                "剪藏完成",
                                json!({
                                    "doc": dto_from_row(&row),
                                    "title": dup_title,
                                    "url": canonical,
                                    "site": article.site,
                                    "imageCount": localized.localized,
                                    "warnings": warnings,
                                    "duplicate": { "id": dup_id, "title": dup_title, "relPath": dup_rel },
                                    "overwritten": true,
                                }),
                            );
                        }
                    }
                    Err(err) => self.fail_job(&job_id, &err.code, &err.message),
                }
                return;
            }
        }

        let id = new_ulid();
        self.update_job(&job_id, "images", 0.4, "正在保存图片…");
        let root = match self.root_path() {
            Some(root) => root,
            None => {
                self.fail_job(&job_id, "no-library", "还没有挂载书库");
                return;
            }
        };
        let localized = localize_images(LocalizeOptions {
            markdown: &article.markdown,
            base_url: &page.final_url,
            referer: &page.final_url,
            referer_from_image_host: false,
            doc_id: &id,
            root: &root,
            allow_private,
            max_images: 30,
            name_mode: ImageNameMode::ContentHash,
        })
        .await;
        let mut warnings = article.warnings.clone();
        warnings.extend(localized.warnings.clone());

        self.update_job(&job_id, "saving", 0.93, "正在写入收件箱…");
        let dir = root.join(sanitize_dir("Inbox"));
        let _ = tokio::fs::create_dir_all(&dir).await;
        let base_name = sanitize_segment(&article.title);
        let base_name = if base_name.is_empty() {
            "未命名剪藏".to_string()
        } else {
            base_name
        };
        let file = unique_path(&dir, &base_name, ".md");
        let site = {
            let s = if article.site.is_empty() {
                safe_hostname(&page.final_url)
            } else {
                article.site.clone()
            };
            s.chars().take(80).collect::<String>()
        };
        let fm = build_frontmatter(BuildFrontmatter {
            title: &article.title,
            id: &id,
            status: None,
            tags: None,
            aliases: None,
            created: Some(crate::frontmatter::iso_now()),
            source: Some(SourceInfo {
                url: Some(canonical.clone()),
                site: Some(site.clone()),
                author: Some(article.author.chars().take(120).collect()),
                published: Some(article.published.chars().take(60).collect()),
                clipped_at: Some(crate::frontmatter::iso_now()),
            }),
        });
        let text = format!("{fm}{}", localized.markdown);
        if let Err(err) = crate::atomic::atomic_write_file(&file, text.as_bytes(), 1).await {
            self.fail_job(&job_id, "clip-failed", &format!("写入收件箱失败：{err}"));
            return;
        }
        if let Some(indexer) = self.indexer() {
            let _ = indexer.index_file(&file).await;
            let _ = indexer.resolve_links().await;
        }
        let rel_path = crate::paths::relative_posix(&root, &file);
        self.hub.broadcast(
            "doc-changed",
            json!({ "id": id, "relPath": rel_path, "created": true, "origin": "clip" }),
        );
        if let Ok(Some(row)) = self.db.get_doc(&id).await {
            self.finish_job(
                &job_id,
                "done",
                1.0,
                "已保存到收件箱",
                json!({
                    "doc": dto_from_row(&row),
                    "title": article.title,
                    "url": canonical,
                    "site": site,
                    "imageCount": localized.localized,
                    "warnings": warnings,
                }),
            );
        }
    }

    async fn find_clip_duplicate(&self, canonical: &str) -> Option<(String, String, String)> {
        if canonical.is_empty() {
            return None;
        }
        let key = clip_key(canonical, true);
        let rows = self.db.docs_with_sources().await.ok()?;
        for (id, rel_path, title, source_url) in rows {
            if clip_key(&source_url, true) == key {
                return Some((id, title, rel_path));
            }
        }
        None
    }

    pub async fn clip_job(&self, job_id: &str) -> AppResult<Value> {
        self.prune_clip_jobs();
        let jobs = self
            .clip_jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let job = jobs
            .get(job_id)
            .ok_or_else(|| AppError::not_found("剪藏任务不存在或已过期"))?;
        Ok(serde_json::to_value(job)?)
    }

    /// 剪藏结果用于测试：解析指定 URL（不落盘）。
    pub async fn extract_preview(&self, url: &str, allow_private: bool) -> AppResult<Value> {
        let page = fetch_page(url, allow_private)
            .await
            .map_err(|e| AppError::bad_request(e))?;
        let article = extract_article(&page.html, &page.final_url)
            .map_err(|e| AppError::bad_request(e))?;
        Ok(json!({
            "title": article.title,
            "site": article.site,
            "markdown": article.markdown,
            "images": article.images.len(),
            "warnings": article.warnings,
            "hash": hash_buffer(article.markdown.as_bytes()),
            "kind": kind_of("x.md").map(|k| k.as_str()),
        }))
    }
}
