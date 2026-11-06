//! 文件内容指纹（sha1）；`assets` 文件名依赖该规则。

use sha1::{Digest, Sha1};

fn hex(bytes: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(D[(b >> 4) as usize] as char);
        out.push(D[(b & 0xf) as usize] as char);
    }
    out
}

pub fn hash_buffer(data: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(data);
    hex(&hasher.finalize())
}

pub fn hash_text(text: &str) -> String {
    hash_buffer(text.as_bytes())
}

pub fn short_hash(data: &[u8]) -> String {
    hash_buffer(data)[..16].to_string()
}
