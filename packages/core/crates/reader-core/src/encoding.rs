//! 编码探测与编解码：BOM → 严格 UTF-8 → UTF-16 启发 → GB18030（顺序与 v3 一致）。

use encoding_rs::{GB18030, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileEncoding {
    #[serde(rename = "utf8")]
    Utf8,
    #[serde(rename = "utf8-bom")]
    Utf8Bom,
    #[serde(rename = "utf16le")]
    Utf16Le,
    #[serde(rename = "utf16be")]
    Utf16Be,
    #[serde(rename = "gb18030")]
    Gb18030,
}

impl FileEncoding {
    pub fn as_str(&self) -> &'static str {
        match self {
            FileEncoding::Utf8 => "utf8",
            FileEncoding::Utf8Bom => "utf8-bom",
            FileEncoding::Utf16Le => "utf16le",
            FileEncoding::Utf16Be => "utf16be",
            FileEncoding::Gb18030 => "gb18030",
        }
    }
}

#[derive(Clone, Debug)]
pub struct DecodedFile {
    pub text: String,
    pub encoding: FileEncoding,
    pub eol: String,
}

fn utf16_looks_plausible(buf: &[u8]) -> Option<FileEncoding> {
    if buf.len() < 4 || buf.len() % 2 != 0 {
        return None;
    }
    let sample = buf.len().min(4096);
    let pairs = sample / 2;
    if pairs == 0 {
        return None;
    }
    let mut even_zeros = 0usize;
    let mut odd_zeros = 0usize;
    let mut i = 0;
    while i < sample {
        if buf[i] == 0 {
            even_zeros += 1;
        }
        if i + 1 < sample && buf[i + 1] == 0 {
            odd_zeros += 1;
        }
        i += 2;
    }
    let odd_ratio = odd_zeros as f64 / pairs as f64;
    let even_ratio = even_zeros as f64 / pairs as f64;
    if odd_ratio > 0.4 && even_ratio < 0.1 {
        return Some(FileEncoding::Utf16Le);
    }
    if even_ratio > 0.4 && odd_ratio < 0.1 {
        return Some(FileEncoding::Utf16Be);
    }
    None
}

pub fn detect_encoding(buf: &[u8]) -> FileEncoding {
    if buf.len() >= 3 && buf[0] == 0xef && buf[1] == 0xbb && buf[2] == 0xbf {
        return FileEncoding::Utf8Bom;
    }
    if buf.len() >= 2 && buf[0] == 0xff && buf[1] == 0xfe {
        return FileEncoding::Utf16Le;
    }
    if buf.len() >= 2 && buf[0] == 0xfe && buf[1] == 0xff {
        return FileEncoding::Utf16Be;
    }
    if std::str::from_utf8(buf).is_ok() {
        return FileEncoding::Utf8;
    }
    if let Some(enc) = utf16_looks_plausible(buf) {
        return enc;
    }
    FileEncoding::Gb18030
}

pub fn detect_eol(text: &str) -> String {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let bytes = text.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf > lf { "\r\n".into() } else { "\n".into() }
}

pub fn decode_file(buf: &[u8]) -> DecodedFile {
    let encoding = detect_encoding(buf);
    let text: String = match encoding {
        FileEncoding::Utf8Bom => UTF_8.decode(&buf[3..]).0.into_owned(),
        FileEncoding::Utf16Le => UTF_16LE.decode(&buf[2..]).0.into_owned(),
        FileEncoding::Utf16Be => UTF_16BE.decode(&buf[2..]).0.into_owned(),
        FileEncoding::Gb18030 => GB18030.decode(buf).0.into_owned(),
        FileEncoding::Utf8 => UTF_8.decode(buf).0.into_owned(),
    };
    // 统一 NFC 只用于比较；文本本身不改写
    let text = text.nfc().collect::<String>();
    let eol = detect_eol(&text);
    DecodedFile {
        text,
        encoding,
        eol,
    }
}

pub fn encode_file(text: &str, encoding: FileEncoding) -> Vec<u8> {
    match encoding {
        FileEncoding::Utf8Bom => {
            let mut out = vec![0xef, 0xbb, 0xbf];
            out.extend_from_slice(&UTF_8.encode(text).0);
            out
        }
        FileEncoding::Utf16Le => {
            let mut out = vec![0xff, 0xfe];
            out.extend_from_slice(&UTF_16LE.encode(text).0);
            out
        }
        FileEncoding::Utf16Be => {
            let mut out = vec![0xfe, 0xff];
            out.extend_from_slice(&UTF_16BE.encode(text).0);
            out
        }
        FileEncoding::Gb18030 => GB18030.encode(text).0.into_owned(),
        FileEncoding::Utf8 => UTF_8.encode(text).0.into_owned(),
    }
}

/// 把文本里的换行统一成文件原本的 EOL。
pub fn apply_eol(text: &str, eol: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    if eol == "\n" {
        normalized
    } else {
        normalized.replace('\n', "\r\n")
    }
}
