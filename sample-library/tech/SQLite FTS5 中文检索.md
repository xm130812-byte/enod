---
title: SQLite FTS5 中文检索
tags: [工程, 搜索]
aliases: [FTS5, 中文检索]
created: 2026-10-22T15:00:00+08:00
reader:
  id: 01M6PEGRCN1EKDDN8MCEYVHY8A
  status: reading
  progress: 0.35
  annotations: []
---
e
# SQLite FTS5 中文检索

FTS5 自带的 `unicode61` 分词器不认识中文词边界：它会把一整串汉字当成一个 token，于是搜「持久战」搜不到「论持久战」里的那三个字。

## 两条路

1. **换分词器**：需要编译 C 扩展（违反 [[为什么零原生模块]] 的铁律）。
2. **写入前自己分词**：把正文切成词、空格拼接，`unicode61` 只负责切空格。

我们选第二条。

## 写入

```ts
const seg = new Intl.Segmenter('zh', { granularity: 'word' });
const tokens = [...seg.segment(text)]
  .filter((s) => s.isWordLike)
  .map((s) => s.segment.toLowerCase());

db.prepare('INSERT INTO docs_fts(body_tokens) VALUES (?)').run(tokens.join(' '));
```

## 查询

查询串同样分词，再用 `AND` 连接：

```
MATCH '"中文" AND "检索"'
```

单个词的召回有时不够，于是再加一列 **CJK bigram** 做兜底：

```
中文检索 → 中文 文检 检索
```

`bigrams` 列用 `AND` 匹配，能兜住分词器把词切错的情况。代价是索引体积变大，大约 +35%。

## 实测

在 3000 篇中文文档上：

| 指标 | 结果 |
|---|---|
| 首次索引 | 21s |
| 增量索引（单篇） | 40ms |
| 搜索 P95 | 18ms |
| 索引体积 | 42MB |

## 一个坑

`bm25()` 的列权重必须和 FTS 表列顺序一一对应，顺序写错不会报错，只会让排序莫名其妙。

```sql
SELECT doc_id, bm25(docs_fts, 0.0, 0.0, 8.0, 1.0, 4.0, 2.0, 0.5) AS rank
FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT 20;
```

## 相关

[[本地优先]]、[[书库导读]]。
