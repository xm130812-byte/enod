//! ULID —— 文档身份，不依赖路径。26 字符 Crockford Base32，字典序即时间序。

use std::sync::Mutex;
use ulid::{Generator, Ulid};

static GENERATOR: Mutex<Option<Generator>> = Mutex::new(None);

/// 生成一个 ULID；同一毫秒内单调递增（与 v3 语义一致）。
pub fn new_ulid() -> String {
    let mut guard = GENERATOR.lock().unwrap_or_else(|e| e.into_inner());
    let gen = guard.get_or_insert_with(Generator::new);
    match gen.generate() {
        Ok(u) => u.to_string(),
        Err(_) => Ulid::generate().to_string(),
    }
}

pub fn is_ulid(value: &str) -> bool {
    if value.len() != 26 {
        return false;
    }
    // Crockford Base32：不含 I L O U
    value
        .chars()
        .all(|c| "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ulid_is_26_and_monotonic() {
        let a = new_ulid();
        let b = new_ulid();
        assert_eq!(a.len(), 26);
        assert!(is_ulid(&a));
        assert!(a < b);
    }
}
