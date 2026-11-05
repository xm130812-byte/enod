import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { buildBigramQuery, buildMatchQuery } from '../core/tokenizer.ts';
import type { DocStatus } from '../core/frontmatter.ts';

export interface DocRecord {
  id: string;
  relPath: string;
  mtime: number;
  size: number;
  hash: string;
  title: string;
  tags: string[];
  aliases: string[];
  status: DocStatus;
  progress: number;
  words: number;
  excerpt: string;
  sourceUrl: string | null;
  encoding: string;
  eol: string;
  created: string | null;
  indexedAt: number;
  annCount: number;
  titleTokens: string;
  bodyTokens: string;
  tagsTokens: string;
  notesTokens: string;
  bigrams: string;
}

export interface DocSummary {
  id: string;
  relPath: string;
  title: string;
  tags: string[];
  aliases: string[];
  status: DocStatus;
  progress: number;
  words: number;
  excerpt: string;
  sourceUrl: string | null;
  mtime: number;
  size: number;
  annCount: number;
  created: string | null;
}

export interface StoredDocRow {
  id: string;
  rel_path: string;
  mtime: number;
  size: number;
  hash: string;
  title: string;
  tags: string;
  aliases: string;
  status: string;
  progress: number;
  words: number;
  excerpt: string;
  source_url: string | null;
  encoding: string;
  eol: string;
  created: string | null;
  indexed_at: number;
  ann_count: number;
}

export type SortKey = 'recent' | 'added' | 'words' | 'title';

export interface ListOptions {
  status?: DocStatus | 'all';
  tag?: string | null;
  sort?: SortKey;
  q?: string | null;
  limit?: number;
  offset?: number;
}

export interface LinkRow {
  src_id: string;
  dst_id: string | null;
  dst_raw: string;
  dst_anchor: string | null;
  kind: string;
}

export interface SearchHit {
  doc: DocSummary;
  rank: number;
}

const SCHEMA_VERSION = 1;

function parseTags(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function toSummary(row: StoredDocRow): DocSummary {
  return {
    id: row.id,
    relPath: row.rel_path,
    title: row.title,
    tags: parseTags(row.tags),
    aliases: parseTags(row.aliases),
    status: (row.status === 'reading' || row.status === 'done' ? row.status : 'unread') as DocStatus,
    progress: row.progress,
    words: row.words,
    excerpt: row.excerpt,
    sourceUrl: row.source_url,
    mtime: row.mtime,
    size: row.size,
    annCount: row.ann_count,
    created: row.created,
  };
}

export class IndexDB {
  db: DatabaseSync;
  file: string;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const version = row?.user_version ?? 0;
    if (version >= SCHEMA_VERSION) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        rel_path TEXT UNIQUE NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        title TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        aliases TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'unread',
        progress REAL NOT NULL DEFAULT 0,
        words INTEGER NOT NULL DEFAULT 0,
        excerpt TEXT NOT NULL DEFAULT '',
        source_url TEXT,
        encoding TEXT NOT NULL DEFAULT 'utf8',
        eol TEXT NOT NULL DEFAULT '\\n',
        created TEXT,
        indexed_at INTEGER NOT NULL,
        ann_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS docs_status ON docs(status);
      CREATE INDEX IF NOT EXISTS docs_mtime ON docs(mtime);

      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        doc_id UNINDEXED,
        rel_path,
        title_tokens,
        body_tokens,
        tags_tokens,
        notes_tokens,
        bigrams,
        tokenize = 'unicode61'
      );

      CREATE TABLE IF NOT EXISTS links (
        src_id TEXT NOT NULL,
        dst_id TEXT,
        dst_raw TEXT NOT NULL,
        dst_anchor TEXT,
        kind TEXT NOT NULL DEFAULT 'wiki'
      );
      CREATE INDEX IF NOT EXISTS links_src ON links(src_id);
      CREATE INDEX IF NOT EXISTS links_dst ON links(dst_id);

      CREATE TABLE IF NOT EXISTS annotations_mirror (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        exact TEXT NOT NULL,
        note TEXT,
        color TEXT,
        created INTEGER
      );
      CREATE INDEX IF NOT EXISTS ann_doc ON annotations_mirror(doc_id);

      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------ meta */

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /* ------------------------------------------------------------ docs */

  getDoc(id: string): StoredDocRow | null {
    return (this.db.prepare('SELECT * FROM docs WHERE id = ?').get(id) as StoredDocRow | undefined) ?? null;
  }

  getDocByPath(relPath: string): StoredDocRow | null {
    return (this.db.prepare('SELECT * FROM docs WHERE rel_path = ?').get(relPath) as StoredDocRow | undefined) ?? null;
  }

  getSummary(id: string): DocSummary | null {
    const row = this.getDoc(id);
    return row ? toSummary(row) : null;
  }

  /** 同一 reader.id 出现在两个文件时，给后来者派生稳定 id，避免覆盖 */
  resolveId(preferred: string, relPath: string): string {
    const existing = this.getDoc(preferred);
    if (!existing || existing.rel_path === relPath) return preferred;
    return `${preferred}-${Buffer.from(relPath).toString('base64url').slice(0, 8)}`;
  }

  upsertDocument(doc: DocRecord): void {
    this.db
      .prepare(
        `INSERT INTO docs (id, rel_path, mtime, size, hash, title, tags, aliases, status, progress,
                           words, excerpt, source_url, encoding, eol, created, indexed_at, ann_count)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           rel_path = excluded.rel_path, mtime = excluded.mtime, size = excluded.size,
           hash = excluded.hash, title = excluded.title, tags = excluded.tags,
           aliases = excluded.aliases, status = excluded.status, progress = excluded.progress,
           words = excluded.words, excerpt = excluded.excerpt, source_url = excluded.source_url,
           encoding = excluded.encoding, eol = excluded.eol, created = excluded.created,
           indexed_at = excluded.indexed_at, ann_count = excluded.ann_count`,
      )
      .run(
        doc.id,
        doc.relPath,
        doc.mtime,
        doc.size,
        doc.hash,
        doc.title,
        JSON.stringify(doc.tags),
        JSON.stringify(doc.aliases),
        doc.status,
        doc.progress,
        doc.words,
        doc.excerpt,
        doc.sourceUrl,
        doc.encoding,
        doc.eol,
        doc.created,
        doc.indexedAt,
        doc.annCount,
      );

    this.db.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(doc.id);
    this.db
      .prepare(
        `INSERT INTO docs_fts (doc_id, rel_path, title_tokens, body_tokens, tags_tokens, notes_tokens, bigrams)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        doc.id,
        doc.relPath,
        doc.titleTokens,
        doc.bodyTokens,
        doc.tagsTokens,
        doc.notesTokens,
        doc.bigrams,
      );
  }

  removeDocument(id: string): void {
    this.db.prepare('DELETE FROM docs WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(id);
    this.db.prepare('DELETE FROM links WHERE src_id = ?').run(id);
    this.db.prepare('UPDATE links SET dst_id = NULL WHERE dst_id = ?').run(id);
    this.db.prepare('DELETE FROM annotations_mirror WHERE doc_id = ?').run(id);
  }

  /** 仅更新 reader 元数据，避免整篇重新解析（保存状态/进度时用） */
  updateReaderMeta(id: string, patch: { status?: DocStatus; progress?: number; annCount?: number }): void {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      params.push(patch.status);
    }
    if (patch.progress !== undefined) {
      sets.push('progress = ?');
      params.push(Math.min(1, Math.max(0, patch.progress)));
    }
    if (patch.annCount !== undefined) {
      sets.push('ann_count = ?');
      params.push(patch.annCount);
    }
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE docs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** 文档内容变了（title/tags/annotations），刷新对应行 */
  updateIndexedMeta(
    id: string,
    patch: {
      title?: string;
      tags?: string[];
      status?: DocStatus;
      progress?: number;
      annCount?: number;
      mtime?: number;
      size?: number;
      hash?: string;
      excerpt?: string;
    },
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const push = (col: string, value: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.tags !== undefined) push('tags', JSON.stringify(patch.tags));
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.progress !== undefined) push('progress', Math.min(1, Math.max(0, patch.progress)));
    if (patch.annCount !== undefined) push('ann_count', patch.annCount);
    if (patch.mtime !== undefined) push('mtime', patch.mtime);
    if (patch.size !== undefined) push('size', patch.size);
    if (patch.hash !== undefined) push('hash', patch.hash);
    if (patch.excerpt !== undefined) push('excerpt', patch.excerpt);
    if (sets.length === 0) return;
    params.push(id);
    this.db.prepare(`UPDATE docs SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  listDocs(options: ListOptions = {}): DocSummary[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.status && options.status !== 'all') {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.tag) {
      where.push('tags LIKE ?');
      params.push(`%"${options.tag.replace(/"/g, '\\"')}"%`);
    }
    if (options.q && options.q.trim()) {
      const fts = this.searchIds(options.q, 1000);
      if (fts.length === 0) return [];
      where.push(`id IN (${fts.map(() => '?').join(',')})`);
      params.push(...fts);
    }
    const sort = options.sort ?? 'recent';
    const orderBy =
      sort === 'title'
        ? 'title COLLATE NOCASE ASC'
        : sort === 'words'
          ? 'words DESC'
          : sort === 'added'
            ? 'indexed_at DESC'
            : 'mtime DESC';
    const limit = Math.min(Math.max(options.limit ?? 5000, 1), 20000);
    const offset = Math.max(options.offset ?? 0, 0);
    const sql = `SELECT * FROM docs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as unknown as StoredDocRow[];
    return rows.map(toSummary);
  }

  /** 只返回命中 id（用于 /docs?q= 过滤） */
  searchIds(query: string, limit = 200): string[] {
    return this.search(query, { limit }).map((h) => h.doc.id);
  }

  search(query: string, opts: { limit?: number; offset?: number } = {}): SearchHit[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const match = buildMatchQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT doc_id, bm25(docs_fts, 0.0, 0.0, 8.0, 1.0, 4.0, 2.0, 0.5) AS rank
         FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`,
      )
      .all(match, limit, offset) as { doc_id: string; rank: number }[];

    if (rows.length > 0) return this.attachDocs(rows);

    const bigram = buildBigramQuery(query);
    if (!bigram) return [];
    const fallback = this.db
      .prepare(
        `SELECT doc_id, bm25(docs_fts, 0.0, 0.0, 8.0, 1.0, 4.0, 2.0, 0.5) AS rank
         FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?`,
      )
      .all(bigram, limit, offset) as { doc_id: string; rank: number }[];
    return this.attachDocs(fallback);
  }

  private attachDocs(rows: { doc_id: string; rank: number }[]): SearchHit[] {
    const out: SearchHit[] = [];
    for (const row of rows) {
      const doc = this.getDoc(row.doc_id);
      if (!doc) continue;
      out.push({ doc: toSummary(doc), rank: row.rank });
    }
    return out;
  }

  stats(): {
    total: number;
    words: number;
    tags: number;
    byStatus: Record<DocStatus | 'total', number>;
    indexedAt: number | null;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n;
    const words = (this.db.prepare('SELECT COALESCE(SUM(words),0) AS n FROM docs').get() as { n: number }).n;
    const tagRows = this.db.prepare('SELECT tags FROM docs').all() as { tags: string }[];
    const tagSet = new Set<string>();
    for (const row of tagRows) for (const t of parseTags(row.tags)) tagSet.add(t);
    const byStatus = { unread: 0, reading: 0, done: 0, total };
    const statusRows = this.db.prepare('SELECT status, COUNT(*) AS n FROM docs GROUP BY status').all() as {
      status: string;
      n: number;
    }[];
    for (const row of statusRows) {
      if (row.status === 'unread' || row.status === 'reading' || row.status === 'done') {
        byStatus[row.status] = row.n;
      }
    }
    const indexedAt = Number(this.getMeta('lastIndexedAt') ?? 0) || null;
    return { total, words, tags: tagSet.size, byStatus, indexedAt };
  }

  tagCounts(): { tag: string; count: number }[] {
    const rows = this.db.prepare('SELECT tags FROM docs').all() as { tags: string }[];
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of parseTags(row.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'));
  }

  /* ------------------------------------------------------------ links */

  replaceLinks(srcId: string, links: { dstRaw: string; dstAnchor: string | null; kind: string }[]): void {
    this.db.prepare('DELETE FROM links WHERE src_id = ?').run(srcId);
    const stmt = this.db.prepare(
      'INSERT INTO links (src_id, dst_id, dst_raw, dst_anchor, kind) VALUES (?, NULL, ?, ?, ?)',
    );
    for (const link of links) stmt.run(srcId, link.dstRaw, link.dstAnchor, link.kind);
  }

  /** 用 title/alias/文件名/相对路径的映射解析所有链接（映射由调用方按优先级构建） */
  resolveLinks(
    resolver: (raw: string) => string | null,
    _docs: { id: string; relPath: string; title: string; aliases: string[] }[],
  ): { total: number; resolved: number } {
    const rows = this.db.prepare('SELECT DISTINCT dst_raw FROM links').all() as { dst_raw: string }[];
    const cache = new Map<string, string | null>();

    const update = this.db.prepare('UPDATE links SET dst_id = ? WHERE dst_raw = ?');
    let resolved = 0;
    let total = 0;
    for (const row of rows) {
      const key = row.dst_raw.normalize('NFC').trim().toLowerCase();
      let id = cache.get(key);
      if (id === undefined) {
        id = resolver(row.dst_raw);
        cache.set(key, id);
      }
      const changes = update.run(id, row.dst_raw).changes;
      total += Number(changes);
      if (id) resolved += Number(changes);
    }
    return { total, resolved };
  }

  backlinksFor(docId: string): { srcId: string; srcTitle: string; relPath: string; anchor: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT l.src_id AS srcId, d.title AS srcTitle, d.rel_path AS relPath, l.dst_anchor AS anchor
         FROM links l JOIN docs d ON d.id = l.src_id
         WHERE l.dst_id = ? ORDER BY d.title COLLATE NOCASE`,
      )
      .all(docId) as { srcId: string; srcTitle: string; relPath: string; anchor: string | null }[];
    return rows;
  }

  outlinksFor(docId: string): { dstId: string | null; dstRaw: string; dstTitle: string | null; anchor: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT l.dst_id AS dstId, l.dst_raw AS dstRaw, d.title AS dstTitle, l.dst_anchor AS anchor
         FROM links l LEFT JOIN docs d ON d.id = l.dst_id
         WHERE l.src_id = ? ORDER BY l.dst_raw`,
      )
      .all(docId) as { dstId: string | null; dstRaw: string; dstTitle: string | null; anchor: string | null }[];
    return rows;
  }

  /** 指向不存在文档的链接 */
  brokenLinks(limit = 200): { srcId: string; srcTitle: string; dstRaw: string; anchor: string | null }[] {
    return this.db
      .prepare(
        `SELECT l.src_id AS srcId, d.title AS srcTitle, l.dst_raw AS dstRaw, l.dst_anchor AS anchor
         FROM links l JOIN docs d ON d.id = l.src_id
         WHERE l.dst_id IS NULL ORDER BY d.title LIMIT ?`,
      )
      .all(limit) as { srcId: string; srcTitle: string; dstRaw: string; anchor: string | null }[];
  }

  /** 给「Unlinked Mentions」用：全文命中某标题但没有链接的文档 */
  mentionCandidates(title: string, excludeId: string, limit = 20): { doc: DocSummary; snippet: string }[] {
    const hits = this.search(title, { limit: limit + 5 });
    const out: { doc: DocSummary; snippet: string }[] = [];
    for (const hit of hits) {
      if (hit.doc.id === excludeId) continue;
      const has = this.db
        .prepare('SELECT 1 AS x FROM links WHERE src_id = ? AND dst_id = ? LIMIT 1')
        .get(hit.doc.id, excludeId);
      if (has) continue;
      out.push({ doc: hit.doc, snippet: hit.doc.excerpt });
      if (out.length >= limit) break;
    }
    return out;
  }

  /* ------------------------------------------------------------ annotations */

  replaceAnnotations(
    docId: string,
    annotations: { id: string; exact: string; note: string; color: string; created: string }[],
  ): void {
    this.db.prepare('DELETE FROM annotations_mirror WHERE doc_id = ?').run(docId);
    const stmt = this.db.prepare(
      'INSERT INTO annotations_mirror (id, doc_id, exact, note, color, created) VALUES (?,?,?,?,?,?)',
    );
    for (const a of annotations) {
      const ts = Date.parse(a.created) || Date.now();
      stmt.run(a.id, docId, a.exact, a.note, a.color, ts);
    }
  }

  /** 全量重扫前清空索引（保留 meta） */
  clearDocs(): void {
    this.db.exec('DELETE FROM docs; DELETE FROM docs_fts; DELETE FROM links; DELETE FROM annotations_mirror;');
  }

  /** 相对路径是否已有索引且未变 */
  isFresh(relPath: string, mtime: number, size: number): boolean {
    const row = this.db.prepare('SELECT mtime, size FROM docs WHERE rel_path = ?').get(relPath) as
      | { mtime: number; size: number }
      | undefined;
    return !!row && row.mtime === mtime && row.size === size;
  }

  allDocsForResolve(): { id: string; relPath: string; title: string; aliases: string[] }[] {
    const rows = this.db.prepare('SELECT id, rel_path, title, aliases FROM docs').all() as {
      id: string;
      rel_path: string;
      title: string;
      aliases: string;
    }[];
    return rows.map((r) => ({ id: r.id, relPath: r.rel_path, title: r.title, aliases: parseTags(r.aliases) }));
  }

  /** 已索引但磁盘上已不存在的文件（增量删除用） */
  staleDocs(existingRelPaths: Set<string>): { id: string; relPath: string }[] {
    const rows = this.db.prepare('SELECT id, rel_path FROM docs').all() as { id: string; rel_path: string }[];
    return rows.filter((r) => !existingRelPaths.has(r.rel_path)).map((r) => ({ id: r.id, relPath: r.rel_path }));
  }
}

export function dbPathFromDataDir(dataDir: string): string {
  return path.join(dataDir, 'index.db');
}
