//! 剪藏 URL 工具：规范化、去重键、内网地址拦截（移植自 v3 clip/url.ts）。

use std::net::IpAddr;
use url::Url;

const TRACKING: [&str; 11] = [
    "utm_", "fbclid", "gclid", "yclid", "mc_cid", "mc_eid", "igshid", "spm", "scm", "share_token",
    "from_source",
];

fn is_tracking(key: &str) -> bool {
    let lower = key.to_lowercase();
    TRACKING.iter().any(|t| {
        if t.ends_with('_') {
            lower.starts_with(t)
        } else {
            lower == *t
        }
    })
}

fn strip_wrapping(input: &str) -> String {
    let mut text = input.trim().to_string();
    while text.starts_with([' ', '"', '\'', '`', '<', '(', '[', '{', '\n', '\t']) {
        text.remove(0);
    }
    while text.ends_with([
        ' ', '"', '\'', '`', '>', ')', ']', '}', ',', '.', ';', '，', '。', '；', '）', '\n', '\t',
    ]) {
        text.pop();
    }
    text
}

pub fn parse_clip_url(input: &str, allow_private: bool) -> Option<Url> {
    let cleaned: String = strip_wrapping(input)
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let candidate = if cleaned.starts_with("//") {
        format!("https:{cleaned}")
    } else if cleaned
        .chars()
        .next()
        .map(|c| c.is_ascii_alphabetic())
        .unwrap_or(false)
        && cleaned.contains(':')
        && cleaned.split(':').next().map(|s| s.len()).unwrap_or(0) <= 12
    {
        cleaned.clone()
    } else {
        format!("https://{cleaned}")
    };
    let url = Url::parse(&candidate).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if url.host_str().unwrap_or("").is_empty() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    if let Some(port) = url.port() {
        if port == 0 {
            return None;
        }
    }
    if !allow_private && is_private_host(url.host_str().unwrap_or("")) {
        return None;
    }
    Some(url)
}

pub fn normalize_clip_url(input: &str, allow_private: bool) -> Option<Url> {
    let mut url = parse_clip_url(input, allow_private)?;
    url.set_fragment(None);
    Some(url)
}

pub fn clip_key(input: &str, allow_private: bool) -> String {
    let Some(mut url) = parse_clip_url(input, allow_private) else {
        return String::new();
    };
    url.set_fragment(None);
    let retained: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !is_tracking(k))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if retained.is_empty() {
        url.set_query(None);
    } else {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in &retained {
            serializer.append_pair(k, v);
        }
        url.set_query(Some(&serializer.finish()));
    }
    let mut key = url.to_string();
    if url.path().len() > 1 {
        if let Some(stripped) = key.strip_suffix('/') {
            key = stripped.to_string();
        }
    }
    key
}

pub fn is_private_host(hostname: &str) -> bool {
    let host = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_lowercase();
    if host.is_empty() {
        return true;
    }
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host == "metadata.google.internal"
    {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            let octets = ip.octets();
            is_private_ipv4(octets[0], octets[1], octets[2], octets[3])
        }
        Ok(IpAddr::V6(ip)) => is_private_ipv6(&ip),
        Err(_) => false,
    }
}

fn is_private_ipv4(a: u8, b: u8, _c: u8, _d: u8) -> bool {
    if a == 0 || a == 10 || a == 127 {
        return true;
    }
    if a == 100 && (64..=127).contains(&b) {
        return true;
    }
    if a == 169 && b == 254 {
        return true;
    }
    if a == 172 && (16..=31).contains(&b) {
        return true;
    }
    if a == 192 && (b == 168 || b == 0) {
        return true;
    }
    if a == 198 && (b == 18 || b == 19) {
        return true;
    }
    a >= 224
}

fn is_private_ipv6(ip: &std::net::Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    let segments = ip.segments();
    if (segments[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    if (segments[0] & 0xfe00) == 0xfc00 {
        return true;
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        let o = v4.octets();
        return is_private_ipv4(o[0], o[1], o[2], o[3]);
    }
    false
}

pub fn resolve_url(raw: &str, base: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() || value.starts_with("data:") || value.starts_with("blob:") {
        return None;
    }
    let base = Url::parse(base).ok()?;
    let resolved = base.join(value).ok()?;
    match resolved.scheme() {
        "http" | "https" | "file" => Some(resolved.to_string()),
        _ => None,
    }
}

pub fn safe_hostname(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_string()))
        .unwrap_or_default()
}
