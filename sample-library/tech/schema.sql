-- ============================================================
-- md-reader 的索引表结构
-- 设计取舍见 [[为什么零原生模块]] 与 [[本地优先]]
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  rel_path    TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'unread',
  words       INTEGER NOT NULL DEFAULT 0,
  indexed_at  INTEGER NOT NULL
);

-- 全文索引：正文先分词再拼接，CJK 用 bigram 兜底
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  doc_id UNINDEXED,
  title_tokens,
  body_tokens,
  bigrams,
  tokenize = 'unicode61'
);

-- 双链：dst_id 为空表示断链
CREATE TABLE IF NOT EXISTS links (
  src_id     TEXT NOT NULL,
  dst_id     TEXT,
  dst_raw    TEXT NOT NULL,
  dst_anchor TEXT,
  kind       TEXT NOT NULL DEFAULT 'wiki'
);

INSERT INTO docs (id, rel_path, title, status, words, indexed_at)
VALUES ('01M6PEGRCN1EKDDN8MCEYVHY88', 'essays/本地优先.md', '本地优先', 'reading', 323, 1793900000);

SELECT d.title, d.words, COUNT(l.dst_id) AS outlinks
FROM docs d
LEFT JOIN links l ON l.src_id = d.id
GROUP BY d.id
ORDER BY d.indexed_at DESC
LIMIT 20;
