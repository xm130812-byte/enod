//! 安全中间件：Origin / X-Reader-Client / Content-Type 校验（PRD §4.15）。

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use std::collections::HashSet;

use super::AppState;
use crate::error::AppError;

pub fn allowed_origins(port: u16) -> HashSet<String> {
    [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        "http://localhost:5173".to_string(),
        "http://127.0.0.1:5173".to_string(),
    ]
    .into_iter()
    .collect()
}

/// 内嵌宿主的来源：本机任意端口，或 DSH 桌面壳的自定义 scheme（`dsh-app://app`）。
/// 只给 /api/v1/embed 这类只读接口用。
fn is_embed_origin(origin: &str) -> bool {
    if origin.starts_with("dsh-app://") {
        return true;
    }
    let rest = match origin.strip_prefix("http://") {
        Some(rest) => rest,
        None => return false,
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    let host = authority
        .rsplit_once(':')
        .map(|(host, _port)| host)
        .unwrap_or(authority);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

pub async fn security_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let mut set_cookie = false;
    if let Some(token) = &state.token {
        match check_token(&state, &req, token) {
            Ok(from_query) => set_cookie = from_query,
            Err(err) => return axum::response::IntoResponse::into_response(err),
        }
    }
    let mut response = match check(&state, &req) {
        Ok(()) => next.run(req).await,
        Err(err) => axum::response::IntoResponse::into_response(err),
    };    if set_cookie {
        if let Some(token) = &state.token {
            let cookie = format!("reader_token={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000");
            if let Ok(value) = cookie.parse() {
                response.headers_mut().append(axum::http::header::SET_COOKIE, value);
            }
        }
    }
    response
}

fn check_token(state: &AppState, req: &Request, token: &str) -> Result<bool, AppError> {
    let headers = req.headers();
    if let Some(auth) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if auth.strip_prefix("Bearer ").map(|v| v.trim()) == Some(token) {
            return Ok(false);
        }
    }
    let query = req.uri().query().unwrap_or("");
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if key == "t" && value == token {
            return Ok(true);
        }
    }
    if let Some(cookie) = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
    {
        for part in cookie.split(';') {
            let part = part.trim();
            if let Some(value) = part.strip_prefix("reader_token=") {
                if value == token {
                    return Ok(false);
                }
            }
        }
    }
    let _ = state;
    Err(AppError::new(401, "unauthorized", "需要有效的访问 token"))
}

fn check(state: &AppState, req: &Request) -> Result<(), AppError> {
    let headers = req.headers();
    if state.read_only
        && req.method() != axum::http::Method::GET
        && req.method() != axum::http::Method::HEAD
    {
        return Err(AppError::new(
            403,
            "read-only",
            "移动端只读模式，不支持写操作",
        ));
    }
    if let Some(origin) = headers.get(axum::http::header::ORIGIN) {
        let origin = origin.to_str().unwrap_or("");
        // 内嵌面板和内核不同源（可能是 DSH 桌面壳的 dsh-app://app），只对 /api/v1/embed 放行
        let embed = req.uri().path().starts_with("/api/v1/embed");
        if !(embed && is_embed_origin(origin)) && !allowed_origins(state.port).contains(origin) {
            return Err(AppError::new(
                403,
                "bad-origin",
                format!("Origin 不被允许: {origin}"),
            ));
        }
    }
    if req.method() == axum::http::Method::OPTIONS {
        return Err(AppError::new(403, "preflight-denied", "不接受跨源预检"));
    }
    // 内嵌接口只用于本机面板，跨源 POST 走不了自定义头（会触发预检），
    // 所以这两条校验对它豁免；它本身只接受本机 href、只存内存。
    let embed = req.uri().path().starts_with("/api/v1/embed");
    if req.method() != axum::http::Method::GET && req.method() != axum::http::Method::HEAD && !embed {
        if headers
            .get("x-reader-client")
            .and_then(|v| v.to_str().ok())
            != Some("1")
        {
            return Err(AppError::new(
                403,
                "missing-client-header",
                "缺少 X-Reader-Client",
            ));
        }
        let ct = headers
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let has_body = headers
            .get(axum::http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .map(|n| n > 0)
            .unwrap_or(false)
            || headers.contains_key(axum::http::header::TRANSFER_ENCODING);
        let allowed_body_type = ct.contains("application/json") || ct.starts_with("image/");
        if has_body && !allowed_body_type {
            return Err(AppError::new(
                415,
                "unsupported-media-type",
                "只接受 application/json 或 image/*",
            ));
        }
    }
    Ok(())
}
