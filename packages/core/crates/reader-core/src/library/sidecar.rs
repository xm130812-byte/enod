//! 非 md 的元数据 sidecar：`<完整文件名>.reader.json`，跟着文件走（PRD §5.3）。

use crate::atomic::atomic_write_file;
use crate::frontmatter::{Annotation, DocStatus};
use crate::hash::hash_buffer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sidecar {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub progress: f64,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
}

impl Sidecar {
    pub fn status(&self) -> DocStatus {
        DocStatus::parse(&self.status).unwrap_or(DocStatus::Unread)
    }
    pub fn progress_clamped(&self) -> f64 {
        self.progress.clamp(0.0, 1.0)
    }
}

pub fn sidecar_path(source_abs: &Path) -> PathBuf {
    let name = source_abs
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    source_abs.with_file_name(format!("{name}.reader.json"))
}

pub fn read_sidecar(source_abs: &Path) -> Sidecar {
    let path = sidecar_path(source_abs);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Sidecar::default();
    };
    serde_json::from_str::<Sidecar>(&raw).unwrap_or_default()
}

pub async fn write_sidecar(source_abs: &Path, sidecar: &Sidecar) -> std::io::Result<()> {
    let path = sidecar_path(source_abs);
    let payload = serde_json::to_string_pretty(sidecar).unwrap_or_else(|_| "{}".into());
    atomic_write_file(&path, payload.as_bytes(), 1).await
}

/// 把 sidecar 里属于「本应用」的键合并进新值，其余键原样保留（命名空间隔离）。
pub fn merge_sidecar(source_abs: &Path, patch: Sidecar) -> Sidecar {
    let mut current = read_sidecar(source_abs);
    if patch.id.is_some() {
        current.id = patch.id;
    }
    if !patch.status.is_empty() {
        current.status = patch.status;
    }
    if patch.progress > 0.0 || current.progress == 0.0 {
        current.progress = patch.progress.clamp(0.0, 1.0);
    }
    if !patch.annotations.is_empty() {
        current.annotations = patch.annotations;
    }
    current.updated = Some(crate::frontmatter::iso_now());
    current
}

/// sidecar 里可能被人手改过；id 校验失败就退回派生 id。
pub fn sidecar_id_or(source_abs: &Path, rel_path: &str) -> String {
    let sidecar = read_sidecar(source_abs);
    if let Some(id) = sidecar.id {
        if id.len() >= 8 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return id;
        }
    }
    super::parse::derived_id_for(rel_path)
}

pub fn hash_of_sidecar(sidecar: &Sidecar) -> String {
    let raw = serde_json::to_string(sidecar).unwrap_or_default();
    hash_buffer(raw.as_bytes())
}

pub fn annotations_to_json(annotations: &[Annotation]) -> Value {
    serde_json::to_value(annotations).unwrap_or(Value::Array(vec![]))
}
