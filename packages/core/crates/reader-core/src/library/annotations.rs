//! 批注：md 写 frontmatter，非 md 写 sidecar（PRD §5.3 / §6.3）。

use super::{file_mtime, parse, LibraryService};
use crate::adapt::kind_of;
use crate::db::DocRow;
use crate::encoding::decode_file;
use crate::error::{AppError, AppResult};
use crate::frontmatter::{is_color, parse_layout, read_reader_meta, Annotation, DocStatus};
use crate::ulid::new_ulid;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Debug, Default)]
pub struct AddAnnotationInput {
    pub exact: String,
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    pub pos: Option<f64>,
    pub color: Option<String>,
    pub note: Option<String>,
    pub base_hash: Option<String>,
}

impl LibraryService {
    pub(crate) async fn doc_annotations(&self, row: &DocRow) -> AppResult<Vec<Annotation>> {
        let abs = self.doc_abs(row)?;
        let kind = kind_of(&row.rel_path).unwrap_or(crate::adapt::DocKind::Md);
        if kind == crate::adapt::DocKind::Md {
            let buffer = tokio::fs::read(&abs).await?;
            let text = decode_file(&buffer).text;
            let layout = parse_layout(&text);
            Ok(read_reader_meta(&layout.frontmatter, "").annotations)
        } else {
            Ok(super::sidecar::read_sidecar(&abs).annotations)
        }
    }

    pub async fn add_annotation(
        self: &Arc<Self>,
        doc_id: &str,
        input: AddAnnotationInput,
    ) -> AppResult<Value> {
        let lock = self.doc_lock(doc_id);
        let _guard = lock.lock().await;
        let row = self.require_doc(doc_id).await?;
        let exact = input.exact.trim();
        if exact.is_empty() {
            return Err(AppError::bad_request("批注内容为空"));
        }
        if exact.chars().count() > 5000 {
            return Err(AppError::bad_request("批注内容过长"));
        }
        let mut annotations = self.doc_annotations(&row).await?;
        let annotation = Annotation {
            id: new_ulid(),
            exact: exact.to_string(),
            prefix: input.prefix.unwrap_or_default().chars().take(200).collect(),
            suffix: input.suffix.unwrap_or_default().chars().take(200).collect(),
            pos: input
                .pos
                .filter(|p| p.is_finite())
                .map(|p| p.max(0.0).round() as i64)
                .unwrap_or(0),
            color: input
                .color
                .filter(|c| is_color(c))
                .unwrap_or_else(|| "yellow".into()),
            note: input.note.unwrap_or_default().chars().take(5000).collect(),
            created: crate::frontmatter::iso_now(),
        };
        annotations.push(annotation.clone());
        let result = self
            .save_doc_locked(
                doc_id,
                super::SaveInput {
                    base_hash: input.base_hash,
                    reader: Some(crate::frontmatter::ReaderPatch {
                        annotations: Some(annotations.clone()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await?;
        Ok(json!({
            "annotation": annotation,
            "hash": result.hash,
            "count": annotations.len(),
        }))
    }

    pub async fn update_annotation(
        self: &Arc<Self>,
        doc_id: &str,
        annotation_id: &str,
        patch: AnnotationPatch,
    ) -> AppResult<Value> {
        let lock = self.doc_lock(doc_id);
        let _guard = lock.lock().await;
        let row = self.require_doc(doc_id).await?;
        let mut annotations = self.doc_annotations(&row).await?;
        let mut found: Option<Annotation> = None;
        for a in annotations.iter_mut() {
            if a.id == annotation_id {
                if let Some(note) = &patch.note {
                    a.note = note.chars().take(5000).collect();
                }
                if let Some(color) = &patch.color {
                    if is_color(color) {
                        a.color = color.clone();
                    }
                }
                found = Some(a.clone());
            }
        }
        let Some(annotation) = found else {
            return Err(AppError::not_found("批注不存在"));
        };
        let result = self
            .save_doc_locked(
                doc_id,
                super::SaveInput {
                    reader: Some(crate::frontmatter::ReaderPatch {
                        annotations: Some(annotations.clone()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await?;
        Ok(json!({
            "annotation": annotation,
            "hash": result.hash,
            "count": annotations.len(),
        }))
    }

    pub async fn delete_annotation(
        self: &Arc<Self>,
        doc_id: &str,
        annotation_id: &str,
    ) -> AppResult<Value> {
        let lock = self.doc_lock(doc_id);
        let _guard = lock.lock().await;
        let row = self.require_doc(doc_id).await?;
        let annotations = self.doc_annotations(&row).await?;
        let filtered: Vec<_> = annotations
            .iter()
            .filter(|a| a.id != annotation_id)
            .cloned()
            .collect();
        if filtered.len() == annotations.len() {
            return Err(AppError::not_found("批注不存在"));
        }
        let result = self
            .save_doc_locked(
                doc_id,
                super::SaveInput {
                    reader: Some(crate::frontmatter::ReaderPatch {
                        annotations: Some(filtered.clone()),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await?;
        Ok(json!({ "hash": result.hash, "count": filtered.len() }))
    }

    pub async fn set_status(self: &Arc<Self>, doc_id: &str, status: &str) -> AppResult<Value> {
        let Some(status) = DocStatus::parse(status) else {
            return Err(AppError::bad_request("非法状态"));
        };
        let result = self
            .save_doc(
                doc_id,
                super::SaveInput {
                    reader: Some(crate::frontmatter::ReaderPatch {
                        status: Some(status),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .await?;
        Ok(json!({
            "hash": result.hash,
            "mtime": result.mtime,
            "encoding": result.encoding,
            "reencoded": result.reencoded,
        }))
    }

    /// docx / html → md 副本（§6.2.3 的第二条替代路径）。
    pub async fn convert_to_md_copy(self: &Arc<Self>, doc_id: &str) -> AppResult<Value> {
        let row = self.require_doc(doc_id).await?;
        let kind = kind_of(&row.rel_path).unwrap_or(crate::adapt::DocKind::Md);
        if !kind.can_convert_to_md() {
            return Err(AppError::bad_request("这个格式不需要转换"));
        }
        let root = self
            .root_path()
            .ok_or_else(|| AppError::new(409, "no-library", "还没有挂载书库"))?;
        let abs = self.doc_abs(&row)?;
        let buffer = tokio::fs::read(&abs).await?;
        let derived = crate::adapt::convert_to_markdown(&buffer, &abs, &row.rel_path, kind, &root).await;
        let dir = abs.parent().unwrap_or(&root);
        let stem = abs
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名".into());
        let target = super::unique_path(dir, &stem, ".md");
        let id = new_ulid();
        let fm = crate::frontmatter::build_frontmatter(crate::frontmatter::BuildFrontmatter {
            title: &row.title,
            id: &id,
            status: None,
            tags: None,
            aliases: None,
            created: Some(crate::frontmatter::iso_now()),
            source: None,
        });
        let text = format!("{fm}{}", derived.markdown);
        crate::atomic::atomic_write_file(&target, text.as_bytes(), 1).await?;
        if let Some(indexer) = self.indexer() {
            let _ = indexer.index_file(&target).await;
            let _ = indexer.resolve_links().await;
        }
        let new_rel = crate::paths::relative_posix(&root, &target);
        self.hub.broadcast(
            "doc-changed",
            json!({ "id": id, "relPath": new_rel, "created": true, "origin": "convert" }),
        );
        Ok(json!({ "id": id, "relPath": new_rel }))
    }

    /// 导出 markdown 文本（浏览器下载）。
    pub async fn export_markdown(&self, doc_id: &str) -> AppResult<String> {
        let doc = self.get_doc(doc_id).await?;
        Ok(doc.body)
    }

    pub async fn compat(&self, doc_id: &str) -> AppResult<Value> {
        let row = self.require_doc(doc_id).await?;
        let kind = kind_of(&row.rel_path).unwrap_or(crate::adapt::DocKind::Md);
        Ok(json!({
            "editable": kind.is_editable(),
            "annotatable": kind.is_annotatable(),
            "canConvertToMd": kind.can_convert_to_md(),
        }))
    }

    pub fn _touch_mtime() -> impl std::future::Future<Output = i64> {
        file_mtime(std::path::Path::new("."))
    }
}

#[derive(Clone, Debug, Default)]
pub struct AnnotationPatch {
    pub note: Option<String>,
    pub color: Option<String>,
}

// 让 parse 模块的导入不被误删（供后续 M9 使用）
#[allow(unused_imports)]
use parse as _parse_mod;
