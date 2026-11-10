//! HTTP 层（axum）：路由、安全中间件、SSE 与静态托管。

pub mod routes;
pub mod security;
pub mod sse;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Request};
use axum::http::{header, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use crate::config::ConfigStore;
use crate::db::Db;
use crate::library::LibraryService;

#[derive(Clone)]
pub struct AppState {
    pub service: Arc<LibraryService>,
    pub config: Arc<ConfigStore>,
    pub db: Arc<Db>,
    pub hub: sse::EventHub,
    pub version: String,
    pub instance_id: String,
    pub port: u16,
    pub started_at: Instant,
    pub started_at_ms: i64,
    pub web_dist: Option<PathBuf>,
    pub dev: bool,
    /// 非回环绑定时强制 Bearer / Cookie token（PRD §3.3）
    pub token: Option<String>,
    /// LAN 入口只读：所有变更请求 403（PRD §3.3）
    pub read_only: bool,
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health", get(routes::health))
        .route("/api/v1/library", get(routes::library))
        .route("/api/v1/library/open", post(routes::library_open))
        .route("/api/v1/library/stats", get(routes::library_stats))
        .route("/api/v1/library/rescan", post(routes::library_rescan))
        .route("/api/v1/library/dirs", get(routes::library_dirs))
        .route(
            "/api/v1/config",
            get(routes::get_config).patch(routes::patch_config),
        )
        .route(
            "/api/v1/docs",
            get(routes::list_docs).post(routes::create_doc),
        )
        .route(
            "/api/v1/docs/{id}",
            get(routes::get_doc)
                .patch(routes::patch_doc)
                .delete(routes::delete_doc),
        )
        .route("/api/v1/docs/{id}/status", post(routes::set_doc_status))
        .route("/api/v1/docs/{id}/move", post(routes::move_doc))
        .route(
            "/api/v1/docs/{id}/annotations",
            post(routes::add_annotation),
        )
        .route(
            "/api/v1/docs/{id}/annotations/{aid}",
            patch(routes::update_annotation).delete(routes::delete_annotation),
        )
        .route("/api/v1/docs/{id}/backlinks", get(routes::doc_backlinks))
        .route("/api/v1/docs/{id}/links", get(routes::doc_links))
        .route("/api/v1/docs/{id}/mentions", get(routes::doc_mentions))
        .route("/api/v1/docs/{id}/compat", get(routes::doc_compat))
        .route("/api/v1/docs/{id}/convert", post(routes::doc_convert))
        .route("/api/v1/docs/{id}/export", get(routes::doc_export))
        .route("/api/v1/docs/{id}/open", post(routes::doc_open))
        .route("/api/v1/search", get(routes::search))
        .route("/api/v1/tags", get(routes::tags))
        .route("/api/v1/preview", get(routes::preview))
        .route("/api/v1/assets", post(routes::upload_asset))
        .route("/api/v1/files", get(routes::get_file))
        .route("/api/v1/clip", post(routes::clip))
        .route("/api/v1/clip/{jobId}", get(routes::clip_status))
        .route("/api/v1/docs/{id}/ai", get(routes::list_ai))
        .route("/api/v1/docs/{id}/ai/{aiId}", delete(routes::delete_ai))
        .route(
            "/api/v1/ai/jobs",
            get(routes::ai_job_list).post(routes::ai_job_create),
        )
        .route("/api/v1/ai/jobs/claim", post(routes::ai_job_claim))
        .route("/api/v1/ai/jobs/{jobId}", get(routes::ai_job_get))
        .route(
            "/api/v1/ai/jobs/{jobId}/complete",
            post(routes::ai_job_complete),
        )
        .route("/api/v1/ai/jobs/{jobId}/fail", post(routes::ai_job_fail))
        .route(
            "/api/v1/ai/jobs/{jobId}/cancel",
            post(routes::ai_job_cancel),
        )
        .route("/api/v1/embed/beacon", post(routes::embed_beacon))
        .route("/api/v1/embed/open", post(routes::embed_open))
        .route("/api/v1/embed/state", get(routes::embed_state))
        .route("/api/v1/events", get(routes::events))
        .fallback(routes::fallback)
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        .layer(middleware::from_fn(gzip_middleware))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security::security_middleware,
        ))
        .with_state(state)
}

async fn gzip_middleware(req: Request, next: Next) -> Response {
    let wants_gzip = req
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("gzip"))
        .unwrap_or(false);
    let response = next.run(req).await;
    if !wants_gzip {
        return response;
    }
    if response.headers().contains_key(header::CONTENT_ENCODING) {
        return response;
    }
    let is_json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("application/json"))
        .unwrap_or(false);
    if !is_json {
        return response;
    }
    let (parts, body) = response.into_parts();
    let bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(b) => b,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if bytes.len() <= 1024 {
        return Response::from_parts(parts, Body::from(bytes));
    }
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    if encoder.write_all(&bytes).is_err() {
        return Response::from_parts(parts, Body::from(bytes));
    }
    let Ok(compressed) = encoder.finish() else {
        return Response::from_parts(parts, Body::from(bytes));
    };
    let mut response = Response::from_parts(parts, Body::from(compressed));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_ENCODING,
        HeaderValue::from_static("gzip"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    response
}
