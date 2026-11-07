-- md-reader 索引库（v4 目标态，见 PRD §4.16）
CREATE TABLE IF NOT EXISTS docs (
  id           TEXT PRIMARY KEY,
  rel_path     TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'md',
  meta_path    TEXT,
  mtime        INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  title        TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  aliases      TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'unread',
  progress     REAL NOT NULL DEFAULT 0,
  words        INTEGER NOT NULL DEFAULT 0,
  excerpt      TEXT NOT NULL DEFAULT '',
  source_url   TEXT,
  encoding     TEXT NOT NULL DEFAULT 'utf8',
  eol          TEXT NOT NULL DEFAULT '\n',
  created      TEXT,
  indexed_at   INTEGER NOT NULL,
  ann_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS docs_status ON docs(status);
CREATE INDEX IF NOT EXISTS docs_mtime ON docs(mtime);
-- docs_kind 在 migrate() 补完 kind 列之后再建，兼容 v3 旧库

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  doc_id UNINDEXED, rel_path, title_tokens, body_tokens,
  tags_tokens, notes_tokens, bigrams, tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS links (
  src_id TEXT NOT NULL, dst_id TEXT, dst_raw TEXT NOT NULL,
  dst_anchor TEXT, kind TEXT NOT NULL DEFAULT 'wiki'
);
CREATE INDEX IF NOT EXISTS links_src ON links(src_id);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst_id);

CREATE TABLE IF NOT EXISTS annotations_mirror (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, exact TEXT NOT NULL,
  note TEXT, color TEXT, created INTEGER
);
CREATE INDEX IF NOT EXISTS ann_doc ON annotations_mirror(doc_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- AI 任务队列：enod 只做落位与调度，模型执行在外部 worker（DSH 插件）
CREATE TABLE IF NOT EXISTS ai_jobs (
  id          TEXT PRIMARY KEY,
  doc_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  request     TEXT NOT NULL DEFAULT '{}',
  result      TEXT,
  error       TEXT,
  worker      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  ai_id       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  claimed_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS ai_jobs_status ON ai_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS ai_jobs_doc ON ai_jobs(doc_id, created_at);
