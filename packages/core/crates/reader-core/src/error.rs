//! 统一错误类型：`AppError` → `{error:{code,message,detail}}` + 状态码（PRD §4.15）。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::fmt;

#[derive(Debug, Clone)]
pub struct AppError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub detail: Option<Value>,
}

impl AppError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, "bad-request", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, "not-found", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, "conflict", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(403, "forbidden", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(500, "internal", message)
    }

    pub fn body(&self) -> Value {
        json!({
            "error": {
                "code": self.code,
                "message": self.message,
                "detail": self.detail.clone().unwrap_or(Value::Null),
            }
        })
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}: {}", self.status, self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self.body())).into_response()
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::internal(format!("sqlite: {err}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::internal(format!("json: {err}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        AppError::internal(format!("io: {err}"))
    }
}

impl From<serde_yaml::Error> for AppError {
    fn from(err: serde_yaml::Error) -> Self {
        AppError::internal(format!("yaml: {err}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
