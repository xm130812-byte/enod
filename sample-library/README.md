---
title: 测试夹具说明
tags: [说明]
---

# 测试夹具说明

**这个目录不是书库，只是转换金标准的测试夹具。**

正式书库在 `D:\note`。这里的文件被 `packages/core/crates/reader-core/tests/golden.rs` 逐字节比对，改动会让金标准测试失败 —— 除非你同步更新 `packages/core/tests/golden/*.json`。

保留的文件与它们覆盖的格式：

| 文件 | 格式 | 用途 |
| --- | --- | --- |
| `docs/2026-Q3-季度回顾.docx` | docx | Word 转换、图片抽取 |
| `web/super-agent.html` | html | 网页正文抽取、图片下载 |
| `tech/schema.sql` | sql | SQL 转 Markdown |
| `notes/GBK编码测试.txt` | txt | GBK 编码嗅探 |
| `notes/纯文本示例.txt` | txt | UTF-8 纯文本 |
| `temp/README.txt` | txt | 段落切分 |

`assets/` 下的两个目录分别被 docx 与 html 夹具引用，跟着夹具一起留下。

金标准测试只比对 docx / html / sql / txt，`.md` 一律跳过，所以这个目录里不需要 md 夹具。
