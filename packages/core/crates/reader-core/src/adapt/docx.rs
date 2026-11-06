//! DOCX → markdown：解 OOXML，按样式映射标题 / 列表 / 表格，图片抽到 assets/<派生id>/。

use super::{derived_doc_id, DerivedDoc};
use crate::atomic::atomic_write_file;
use crate::hash::hash_buffer;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::Path;

const MAX_DOCX_CHARS: usize = 800_000;

pub async fn convert(buffer: &[u8], rel_path: &str, root: &Path) -> DerivedDoc {
    let mut warnings = Vec::new();
    let mut archive = match zip::ZipArchive::new(Cursor::new(buffer.to_vec())) {
        Ok(a) => a,
        Err(err) => {
            return DerivedDoc {
                title: String::new(),
                markdown: format!("*[无法解析 docx：{err}]*\n"),
                warnings: vec![format!("docx 解析失败：{err}")],
                scan_links_in_code: false,
                binary: true,
            }
        }
    };

    let document_xml = read_zip_entry(&mut archive, "word/document.xml").unwrap_or_default();
    let rels_xml =
        read_zip_entry(&mut archive, "word/_rels/document.xml.rels").unwrap_or_default();
    let relationships = parse_relationships(&rels_xml);

    let doc_id = derived_doc_id(rel_path);
    let asset_dir = root.join("assets").join(&doc_id);
    let mut images: HashMap<String, String> = HashMap::new();

    let referenced: Vec<String> = relationships
        .iter()
        .filter(|(_, target)| target.starts_with("media/"))
        .map(|(rid, _)| rid.clone())
        .collect();
    for rid in referenced {
        let target = &relationships[&rid];
        let zip_name = format!("word/{target}");
        if let Some(bytes) = read_zip_entry_bytes(&mut archive, &zip_name) {
            let ext = media_ext(&zip_name);
            let name = format!("{}{}", &hash_buffer(&bytes)[..16], ext);
            if !asset_dir.join(&name).exists() {
                let _ = tokio::fs::create_dir_all(&asset_dir).await;
                let _ = atomic_write_file(&asset_dir.join(&name), &bytes, 1).await;
            }
            images.insert(rid, format!("assets/{doc_id}/{name}"));
        }
    }

    let (mut markdown, _tables) = document_to_markdown(&document_xml, &images);
    markdown = markdown.trim_end().to_string();
    if !images.is_empty() {
        warnings.insert(0, format!("图片已提取到 assets/（{} 张）。", images.len()));
    }
    if markdown.chars().count() > MAX_DOCX_CHARS {
        markdown = markdown.chars().take(MAX_DOCX_CHARS).collect();
        warnings.push(format!(
            "正文超过 {} 万字，只显示前 {} 万字。",
            MAX_DOCX_CHARS / 10000,
            MAX_DOCX_CHARS / 10000
        ));
    }

    DerivedDoc {
        title: String::new(),
        markdown,
        warnings,
        scan_links_in_code: false,
        binary: true,
    }
}

fn read_zip_entry<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Option<String> {
    let bytes = read_zip_entry_bytes(archive, name)?;
    Some(String::from_utf8_lossy(&bytes).to_string())
}

fn read_zip_entry_bytes<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Option<Vec<u8>> {
    let mut file = archive.by_name(name).ok()?;
    let mut out = Vec::new();
    file.read_to_end(&mut out).ok()?;
    Some(out)
}

fn media_ext(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        ".jpg"
    } else if lower.ends_with(".gif") {
        ".gif"
    } else if lower.ends_with(".webp") {
        ".webp"
    } else if lower.ends_with(".bmp") {
        ".bmp"
    } else if lower.ends_with(".tiff") {
        ".tiff"
    } else if lower.ends_with(".emf") {
        ".emf"
    } else {
        ".png"
    }
}

fn parse_relationships(xml: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == "Relationship" {
                    let mut id = None;
                    let mut target = None;
                    for attr in e.attributes().flatten() {
                        match attr.key.local_name().as_ref() {
                            "Id" => id = Some(attr.value.to_string()),
                            "Target" => target = Some(attr.value.to_string()),
                            _ => {}
                        }
                    }
                    if let (Some(id), Some(target)) = (id, target) {
                        out.insert(id, target);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    out
}

struct TableState {
    rows: Vec<Vec<String>>,
    current_row: Vec<String>,
    cell: String,
}

fn render_table(rows: &[Vec<String>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let width = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    if width == 0 {
        return String::new();
    }
    let cell = |s: &str| s.replace('|', "\\|").trim().to_string();
    let header = &rows[0];
    let mut lines = Vec::new();
    let header_cells: Vec<String> = (0..width)
        .map(|i| cell(header.get(i).map(|s| s.as_str()).unwrap_or("")))
        .collect();
    lines.push(format!("| {} |", header_cells.join(" | ")));
    lines.push(format!(
        "| {} |",
        (0..width).map(|_| "---").collect::<Vec<_>>().join(" | ")
    ));
    for row in &rows[1..] {
        let cells: Vec<String> = (0..width)
            .map(|i| cell(row.get(i).map(|s| s.as_str()).unwrap_or("")))
            .collect();
        lines.push(format!("| {} |", cells.join(" | ")));
    }
    format!("{}\n\n\n", lines.join("\n"))
}

fn document_to_markdown(xml: &str, images: &HashMap<String, String>) -> (String, usize) {
    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    let mut paragraph = String::new();
    let mut heading_level: Option<u8> = None;
    let mut in_text = false;
    let mut is_list = false;
    let mut run_bold = false;
    let mut run_italic = false;
    let mut table: Option<TableState> = None;
    let mut in_cell = false;
    let mut table_count = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let local = e.local_name().as_ref().to_string();
                match local.as_str() {
                    "r" => {
                        run_bold = false;
                        run_italic = false;
                    }
                    "p" => {
                        paragraph.clear();
                        heading_level = None;
                        is_list = false;
                    }
                    "pStyle" => apply_style(&e, &mut heading_level, &mut is_list),
                    "outlineLvl" => apply_outline(&e, &mut heading_level),
                    "numPr" => is_list = true,
                    "b" => run_bold = toggle_prop(&e),
                    "i" => run_italic = toggle_prop(&e),
                    "t" => in_text = true,
                    "br" => paragraph.push('\n'),
                    "tab" => paragraph.push('\t'),
                    "tbl" => {
                        table = Some(TableState {
                            rows: Vec::new(),
                            current_row: Vec::new(),
                            cell: String::new(),
                        })
                    }
                    "tr" => {
                        if let Some(t) = table.as_mut() {
                            t.current_row.clear();
                        }
                    }
                    "tc" => {
                        in_cell = true;
                        if let Some(t) = table.as_mut() {
                            t.cell.clear();
                        }
                    }
                    "blip" => append_image(&e, images, &mut paragraph),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let local = e.local_name().as_ref().to_string();
                match local.as_str() {
                    "pStyle" => apply_style(&e, &mut heading_level, &mut is_list),
                    "outlineLvl" => apply_outline(&e, &mut heading_level),
                    "br" => paragraph.push('\n'),
                    "tab" => paragraph.push('\t'),
                    "numPr" => is_list = true,
                    "b" => run_bold = toggle_prop(&e),
                    "i" => run_italic = toggle_prop(&e),
                    "blip" => append_image(&e, images, &mut paragraph),
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if in_text {
                    let text = quick_xml::escape::unescape(e.as_ref())
                        .map(|c| c.into_owned())
                        .unwrap_or_else(|_| e.as_ref().to_string());
                    if in_cell {
                        if let Some(t) = table.as_mut() {
                            t.cell.push_str(&text);
                        }
                    } else if run_bold && run_italic {
                        paragraph.push_str(&wrap_md(&text, "***"));
                    } else if run_bold {
                        paragraph.push_str(&wrap_md(&text, "**"));
                    } else if run_italic {
                        paragraph.push_str(&wrap_md(&text, "*"));
                    } else {
                        paragraph.push_str(&text);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let local = e.local_name().as_ref().to_string();
                match local.as_str() {
                    "t" => in_text = false,
                    "p" => {
                        let text = paragraph.trim().to_string();
                        if !text.is_empty() {
                            if in_cell {
                                if let Some(t) = table.as_mut() {
                                    if !t.cell.is_empty() {
                                        t.cell.push(' ');
                                    }
                                    t.cell.push_str(&text);
                                }
                            } else if let Some(level) = heading_level {
                                if out.ends_with('\n') && !out.ends_with("\n\n") {
                                    out.push('\n');
                                }
                                out.push_str(&format!(
                                    "{} {}\n\n",
                                    "#".repeat(level as usize),
                                    text
                                ));
                            } else if is_list {
                                out.push_str(&format!("-   {text}\n"));
                            } else {
                                out.push_str(&format!("{text}\n\n"));
                            }
                        }
                        paragraph.clear();
                        heading_level = None;
                        is_list = false;
                    }
                    "tc" => {
                        in_cell = false;
                        if let Some(t) = table.as_mut() {
                            let cell = t.cell.trim().to_string();
                            t.current_row.push(cell);
                            t.cell.clear();
                        }
                    }
                    "tr" => {
                        if let Some(t) = table.as_mut() {
                            if !t.current_row.is_empty() {
                                t.rows.push(std::mem::take(&mut t.current_row));
                            }
                        }
                    }
                    "tbl" => {
                        if let Some(t) = table.take() {
                            if !t.rows.is_empty() {
                                out.push('\n');
                                out.push_str(&render_table(&t.rows));
                                table_count += 1;
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    (out, table_count)
}

fn apply_style(e: &BytesStart<'_>, heading: &mut Option<u8>, is_list: &mut bool) {
    if let Some(val) = attr_value(e, "val") {
        *heading = heading_from_style(&val);
        if val.to_lowercase().contains("list") {
            *is_list = true;
        }
    }
}

fn apply_outline(e: &BytesStart<'_>, heading: &mut Option<u8>) {
    if let Some(val) = attr_value(e, "val") {
        if let Ok(level) = val.parse::<u8>() {
            *heading = Some((level + 1).min(6));
        }
    }
}

fn append_image(e: &BytesStart<'_>, images: &HashMap<String, String>, out: &mut String) {
    if let Some(rid) = attr_value(e, "embed") {
        if let Some(src) = images.get(&rid) {
            out.push_str(&format!("![]({src})"));
        }
    }
}

fn wrap_md(text: &str, marker: &str) -> String {
    let trimmed_start = text.trim_start();
    let lead = &text[..text.len() - trimmed_start.len()];
    let trimmed = trimmed_start.trim_end();
    let trail = &trimmed_start[trimmed.len()..];
    if trimmed.is_empty() {
        return text.to_string();
    }
    format!("{lead}{marker}{trimmed}{marker}{trail}")
}

fn toggle_prop(e: &BytesStart<'_>) -> bool {
    match attr_value(e, "val") {
        None => true,
        Some(v) => matches!(v.to_lowercase().as_str(), "1" | "true" | "on"),
    }
}

fn heading_from_style(style: &str) -> Option<u8> {
    let lower = style.to_lowercase();
    let digits: String = lower.chars().filter(|c| c.is_ascii_digit()).collect();
    if lower.starts_with("heading") || lower.starts_with("标题") || lower.starts_with("title") {
        if let Ok(n) = digits.parse::<u8>() {
            return Some(n.clamp(1, 6));
        }
    }
    None
}

fn attr_value(e: &BytesStart<'_>, name: &str) -> Option<String> {
    for attr in e.attributes().flatten() {
        if attr.key.local_name().as_ref() == name {
            return Some(attr.value.to_string());
        }
    }
    None
}
