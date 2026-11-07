//! 路由处理：资源分组对齐 PRD §7 / v3 §6。

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use super::AppState;
use crate::db::ListOptions;
use crate::error::{AppError, AppResult};
use crate::frontmatter::DocStatus;
use crate::library::annotations::{AddAnnotationInput, AnnotationPatch};
use crate::library::{CreateDocInput, MoveInput, SaveInput};
use crate::frontmatter::ReaderPatch;

type Q = Query<HashMap<String, String>>;

fn json_ok(value: Value) -> AppResult<Response> {
    Ok(Json(value).into_response())
}

fn query_i64(q: &HashMap<String, String>, key: &str) -> Option<i64> {
    q.get(key).and_then(|v| v.trim().parse::<i64>().ok())
}

async fn body_json(body: Option<Json<Value>>) -> Value {
    body.map(|Json(v)| v).unwrap_or(Value::Null)
}

fn obj(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn str_field(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn str_list(map: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    map.get(key).and_then(|v| v.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    })
}

/* ------------------------------------------------------------------ health / library */

pub async fn health(State(state): State<AppState>) -> AppResult<Response> {
    let uptime = state.started_at.elapsed().as_secs();
    json_ok(json!({
        "ok": true,
        "version": state.version,
        "instanceId": state.instance_id,
        "port": state.port,
        "pid": std::process::id(),
        "startedAt": state.started_at_ms,
        "uptime": uptime,
        "libraryRoot": state.service.root_string(),
        "platform": crate::config::platform_name(),
        "readOnly": state.read_only,
    }))
}

pub async fn library(State(state): State<AppState>) -> AppResult<Response> {
    let stats = state.service.stats_async().await?;
    let dirs = state.service.directory_tree();
    json_ok(json!({
        "root": state.service.root_string(),
        "stats": stats.to_json(),
        "dirs": dirs.get("dirs").cloned().unwrap_or(json!([])),
        "config": state.config.get(),
    }))
}

pub async fn library_stats(State(state): State<AppState>) -> AppResult<Response> {
    let stats = state.service.stats_async().await?;
    json_ok(stats.to_json())
}

pub async fn library_open(
    State(state): State<AppState>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let map = obj(&body);
    let Some(path) = str_field(&map, "path") else {
        return Err(AppError::bad_request("需要 path"));
    };
    if path.trim().is_empty() {
        return Err(AppError::bad_request("需要 path"));
    }
    state.service.mount(PathBuf::from(path), false, false).await?;
    json_ok(json!({ "ok": true, "root": state.service.root_string() }))
}

pub async fn library_rescan(State(state): State<AppState>) -> AppResult<Response> {
    let result = state.service.rescan("manual").await?;
    json_ok(json!({ "ok": true, "result": result }))
}

pub async fn library_dirs(State(state): State<AppState>) -> AppResult<Response> {
    json_ok(state.service.directory_tree())
}

/* ------------------------------------------------------------------ config */

pub async fn get_config(State(state): State<AppState>) -> AppResult<Response> {
    json_ok(state.config.get())
}

pub async fn patch_config(
    State(state): State<AppState>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let patch = obj(&body);
    let next = state.service.update_config(&patch).await?;
    json_ok(next)
}

/* ------------------------------------------------------------------ docs */

pub async fn list_docs(State(state): State<AppState>, Query(q): Q) -> AppResult<Response> {
    let status = match q.get("status").map(|s| s.as_str()) {
        Some("unread") => Some(DocStatus::Unread),
        Some("reading") => Some(DocStatus::Reading),
        Some("done") => Some(DocStatus::Done),
        _ => None,
    };    let options = ListOptions {
        status,
        tag: q.get("tag").filter(|s| !s.is_empty()).cloned(),
        sort: q.get("sort").cloned().unwrap_or_else(|| "recent".into()),
        q: q.get("q").filter(|s| !s.is_empty()).cloned(),
        limit: query_i64(&q, "limit"),
        offset: query_i64(&q, "offset"),
    };
    let docs = state.service.list_docs(options).await?;
    json_ok(serde_json::to_value(docs)?)
}

pub async fn get_doc(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    let doc = state.service.get_doc(&id).await?;
    json_ok(serde_json::to_value(doc)?)
}

pub async fn create_doc(
    State(state): State<AppState>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let map = obj(&body);
    let input = CreateDocInput {
        dir: str_field(&map, "dir"),
        title: str_field(&map, "title"),
        content: str_field(&map, "content"),
        tags: str_list(&map, "tags"),
    };
    let doc = state.service.create_doc(input).await?;
    json_ok(serde_json::to_value(doc)?)
}

pub async fn patch_doc(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let map = obj(&body);
    let reader = map.get("reader").and_then(|v| v.as_object()).map(|r| {
        let mut patch = ReaderPatch::default();
        if let Some(status) = r.get("status").and_then(|v| v.as_str()) {
            patch.status = DocStatus::parse(status);
        }
        if let Some(progress) = r.get("progress").and_then(|v| v.as_f64()) {
            patch.progress = Some(progress);
        }
        patch
    });
    let input = SaveInput {
        body: str_field(&map, "body").or_else(|| str_field(&map, "content")),
        base_hash: str_field(&map, "baseHash"),
        title: str_field(&map, "title"),
        tags: str_list(&map, "tags"),
        reader,
    };
    let result = state.service.save_doc(&id, input).await?;
    json_ok(serde_json::to_value(result)?)
}

pub async fn set_doc_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let map = obj(&body);
    let Some(status) = str_field(&map, "status") else {
        return Err(AppError::bad_request("需要 status"));
    };
    let result = state.service.set_status(&id, &status).await?;
    json_ok(result)
}

pub async fn move_doc(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let map = obj(&body);
    let input = MoveInput {
        target_dir: str_field(&map, "targetDir"),
        new_name: str_field(&map, "newName"),
        update_links: map.get("updateLinks").and_then(|v| v.as_bool()),
    };
    let doc = state.service.move_doc(&id, input).await?;
    json_ok(serde_json::to_value(doc)?)
}

pub async fn delete_doc(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    let result = state.service.delete_doc(&id).await?;
    json_ok(result)
}

pub async fn doc_backlinks(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let doc = state.service.get_doc(&id).await?;
    json_ok(serde_json::to_value(doc.backlinks)?)
}

pub async fn doc_links(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    let doc = state.service.get_doc(&id).await?;
    json_ok(serde_json::to_value(doc.links)?)
}

pub async fn doc_mentions(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let mentions = state.service.unlinked_mentions(&id, 20).await?;
    json_ok(serde_json::to_value(mentions)?)
}

pub async fn doc_compat(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    json_ok(state.service.compat(&id).await?)
}

/// 用系统关联程序打开原文件（docx → Word，html → 浏览器）。
pub async fn doc_open(State(state): State<AppState>, Path(id): Path<String>) -> AppResult<Response> {
    let row = state.service.require_doc(&id).await?;
    let abs = state.service.doc_abs(&row)?;
    let path = abs.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    let spawned = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "start", "", &path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&path).spawn();
    spawned.map_err(|e| AppError::internal(format!("无法调起系统程序：{e}")))?;
    json_ok(json!({ "ok": true }))
}

pub async fn doc_convert(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    json_ok(state.service.convert_to_md_copy(&id).await?)
}

pub async fn doc_export(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let row = state.service.require_doc(&id).await?;
    let markdown = state.service.export_markdown(&id).await?;
    let filename = format!(
        "{}.md",
        crate::adapt::strip_doc_ext(
            row.rel_path.rsplit('/').next().unwrap_or(&row.rel_path)
        )
    );
    let encoded = format!("attachment; filename*=UTF-8''{}", percent_encode(&filename));
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/markdown; charset=utf-8".to_string()),
            (header::CONTENT_DISPOSITION, encoded),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        markdown,
    )
        .into_response())
}

/* ------------------------------------------------------------------ annotations */

pub async fn add_annotation(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let map = obj(&body);
    let Some(exact) = str_field(&map, "exact") else {
        return Err(AppError::bad_request("需要 exact"));
    };
    let input = AddAnnotationInput {
        exact,
        prefix: str_field(&map, "prefix"),
        suffix: str_field(&map, "suffix"),
        pos: map.get("pos").and_then(|v| v.as_f64()),
        color: str_field(&map, "color"),
        note: str_field(&map, "note"),
        base_hash: str_field(&map, "baseHash"),
    };
    json_ok(state.service.add_annotation(&id, input).await?)
}

pub async fn update_annotation(
    State(state): State<AppState>,
    Path((id, aid)): Path<(String, String)>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let map = obj(&body);
    let patch = AnnotationPatch {
        note: str_field(&map, "note"),
        color: str_field(&map, "color"),
    };
    json_ok(state.service.update_annotation(&id, &aid, patch).await?)
}

pub async fn delete_annotation(
    State(state): State<AppState>,
    Path((id, aid)): Path<(String, String)>,
) -> AppResult<Response> {
    json_ok(state.service.delete_annotation(&id, &aid).await?)
}

/* ------------------------------------------------------------------ search / tags / preview */

pub async fn search(State(state): State<AppState>, Query(q): Q) -> AppResult<Response> {
    let query = q.get("q").cloned().unwrap_or_default();
    let limit = query_i64(&q, "limit").unwrap_or(30).clamp(1, 100);
    let results = state.service.search_with_snippets(&query, limit).await?;
    json_ok(serde_json::to_value(results)?)
}

pub async fn tags(State(state): State<AppState>) -> AppResult<Response> {
    let rows = state.db.tag_counts().await?;
    let out: Vec<Value> = rows
        .into_iter()
        .map(|(tag, count)| json!({ "tag": tag, "count": count }))
        .collect();
    json_ok(Value::Array(out))
}

pub async fn preview(State(state): State<AppState>, Query(q): Q) -> AppResult<Response> {
    let target = q.get("target").cloned().unwrap_or_default();
    match state.service.preview(&target).await? {
        Some(v) => json_ok(v),
        None => json_ok(json!({ "notFound": true })),
    }
}

/* ------------------------------------------------------------------ assets / files */

pub async fn upload_asset(
    State(state): State<AppState>,
    Query(q): Q,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    let Some(doc_id) = q.get("docId").cloned() else {
        return Err(AppError::bad_request("需要 docId"));
    };
    if body.is_empty() {
        return Err(AppError::bad_request("需要图片二进制"));
    }
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let filename = q.get("name").cloned().unwrap_or_else(|| "image".into());
    json_ok(
        state
            .service
            .upload_asset(&doc_id, &filename, &body, &mime)
            .await?,
    )
}

pub async fn get_file(
    State(state): State<AppState>,
    Query(q): Q,
    headers: HeaderMap,
) -> AppResult<Response> {
    let Some(rel_path) = q.get("path").cloned().filter(|s| !s.is_empty()) else {
        return Err(AppError::bad_request("需要 path"));
    };
    let (abs, mime) = state.service.resolve_asset(&rel_path)?;
    let stat = tokio::fs::metadata(&abs).await.ok();
    let Some(stat) = stat.filter(|s| s.is_file()) else {
        return Err(AppError::not_found("文件不存在"));
    };
    let etag = format!(
        "\"{:x}-{:x}\"",
        stat.len(),
        stat.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    );
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    let data = tokio::fs::read(&abs).await?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable".into()),
            (header::ETAG, etag),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".into()),
        ],
        data,
    )
        .into_response())
}

/* ------------------------------------------------------------------ clip */

pub async fn clip(
    State(state): State<AppState>,
    body: Option<Json<Value>>,
) -> AppResult<Response> {
    let body = body_json(body).await;
    let map = obj(&body);
    let url = str_field(&map, "url").unwrap_or_default();
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::bad_request("需要 url"));
    }
    if url.chars().count() > 4096 {
        return Err(AppError::bad_request("URL 过长"));
    }
    let mode = str_field(&map, "mode").unwrap_or_else(|| "ask".into());
    let result = state.service.start_clip(url, mode).await?;
    json_ok(result)
}

pub async fn clip_status(
    State(state): State<AppState>,
    Path(job_id): Path<String>,
) -> AppResult<Response> {
    json_ok(state.service.clip_job(&job_id).await?)
}

/* ------------------------------------------------------------------ events */

pub async fn events(State(state): State<AppState>) -> AppResult<Response> {
    let hub = state.hub.clone();
    let service = state.service.clone();
    let instance_id = state.instance_id.clone();

    let hello = {
        let stats = service.stats_async().await?;
        crate::http::sse::ServerEvent {
            event: "hello".into(),
            data: json!({
                "instanceId": instance_id,
                "root": service.root_string(),
                "stats": stats.to_json(),
                "at": chrono::Utc::now().timestamp_millis(),
            }),
        }
    };

    let stream = futures_util::stream::unfold(
        (hub.subscribe(), Some(hello)),
        |(mut rx, pending)| async move {
            if let Some(ev) = pending {
                return Some((
                    Ok::<_, std::convert::Infallible>(to_sse_event(&ev)),
                    (rx, None),
                ));
            }
            loop {
                match rx.recv().await {
                    Ok(ev) => return Some((Ok(to_sse_event(&ev)), (rx, None))),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => return None,
                }
            }
        },
    );

    let sse = axum::response::sse::Sse::new(stream)
        .keep_alive(
            axum::response::sse::KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("ping"),
        );
    let mut response = sse.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, "no-cache, no-transform".parse().unwrap());
    headers.insert("x-accel-buffering", "no".parse().unwrap());
    Ok(response)
}

fn to_sse_event(ev: &crate::http::sse::ServerEvent) -> axum::response::sse::Event {
    axum::response::sse::Event::default()
        .event(ev.event.clone())
        .data(ev.data.to_string())
}

/* ------------------------------------------------------------------ static */

const CSP: &str = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

fn mime_of(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    match ext.as_str() {
        ".html" => "text/html; charset=utf-8",
        ".js" | ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" | ".map" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".avif" => "image/avif",
        ".ico" => "image/x-icon",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        ".ttf" => "font/ttf",
        ".txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub async fn fallback(State(state): State<AppState>, method: Method, uri: Uri, headers: HeaderMap) -> Response {
    if uri.path().starts_with("/api/") {
        return AppError::new(404, "not-found", format!("未知接口 {}", uri.path())).into_response();
    }
    if method != Method::GET && method != Method::HEAD {
        return AppError::new(405, "method-not-allowed", "Method not allowed").into_response();
    }
    let Some(web_dist) = state.web_dist.clone() else {
        let html = "<!doctype html><meta charset=\"utf-8\"><title>md-reader</title>\n<body style=\"font-family:system-ui;padding:40px;line-height:1.7\">\n<h1>前端尚未构建</h1>\n<p>开发模式：<code>pnpm dev</code>，然后打开 <code>http://localhost:5173</code>。</p>\n<p>或者先构建：<code>pnpm build</code>，再访问本页面。</p>\n<p>API 已经就绪：<a href=\"/api/v1/health\">/api/v1/health</a></p>\n</body>";
        return (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
                (header::CACHE_CONTROL, "no-store".to_string()),
                (header::CONTENT_SECURITY_POLICY, CSP.to_string()),
            ],
            html,
        )
            .into_response();
    };

    let mut pathname = percent_decode(uri.path());
    if pathname.is_empty() || pathname == "/" {
        pathname = "/index.html".into();
    }
    let root = web_dist.canonicalize().unwrap_or(web_dist);
    let mut file_path = root.join(pathname.trim_start_matches('/'));
    if !file_path.starts_with(&root) {
        return AppError::forbidden("路径越界").into_response();
    }
    if file_path.is_dir() {
        file_path = file_path.join("index.html");
    }
    if !file_path.is_file() {
        let accepts_html = headers
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.contains("text/html"))
            .unwrap_or(false);
        if accepts_html {
            file_path = root.join("index.html");
        }
    }
    if !file_path.is_file() {
        return AppError::not_found("Not found").into_response();
    }

    let data = match tokio::fs::read(&file_path).await {
        Ok(d) => d,
        Err(err) => return AppError::from(err).into_response(),
    };
    let is_index = file_path.file_name().map(|n| n == "index.html").unwrap_or(false);
    let mut response = (StatusCode::OK, [(header::CONTENT_TYPE, mime_of(&file_path).to_string())], data).into_response();
    let h = response.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    h.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    if is_index {
        h.insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
        h.insert(header::CONTENT_SECURITY_POLICY, CSP.parse().unwrap());
    } else {
        h.insert(
            header::CACHE_CONTROL,
            "public, max-age=31536000, immutable".parse().unwrap(),
        );
    }
    response
}

fn percent_decode(input: &str) -> String {
    percent_encoding::percent_decode_str(input)
        .decode_utf8_lossy()
        .to_string()
}

fn percent_encode(input: &str) -> String {
    percent_encoding::utf8_percent_encode(input, percent_encoding::NON_ALPHANUMERIC).to_string()
}
