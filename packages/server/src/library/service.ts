import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, saveVersion } from '../core/atomic.ts';
import { decodeFile, encodeFile } from '../core/encoding.ts';
import type { FileEncoding } from '../core/encoding.ts';
import {
  ANNOTATION_COLORS,
  applyDocumentEdits,
  buildFrontmatter,
  isColor,
  isStatus,
  parseLayout,
  readReaderMeta,
} from '../core/frontmatter.ts';
import type { Annotation, DocStatus, SourceInfo } from '../core/frontmatter.ts';
import { hashBuffer } from '../core/hash.ts';
import { countWords, excerptOf, extractHeadings } from '../core/markdown.ts';
import type { HeadingRef } from '../core/markdown.ts';
import type { DataPaths } from '../core/paths.ts';
import { ensureDataDirs, isInsideRoot, relativePosix, resolveInRoot } from '../core/paths.ts';
import { ulid } from '../core/ulid.ts';
import type { AppConfig, ConfigStore } from '../core/config.ts';
import type { DocSummary, IndexDB, SortKey, StoredDocRow } from '../store/db.ts';
import { badRequest, HttpError, notFound } from '../http/errors.ts';
import type { EventHub } from '../http/sse.ts';
import type { IndexResult } from './indexer.ts';
import { LibraryIndexer } from './indexer.ts';
import { parseDocBuffer } from './parse.ts';
import type { ParsedDocFile } from './parse.ts';
import { LibraryWatcher } from './watcher.ts';

export interface DocDTO {
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

export interface OutLinkDTO {
  dstId: string | null;
  dstRaw: string;
  dstTitle: string | null;
  anchor: string | null;
  broken: boolean;
}

export interface BacklinkDTO {
  srcId: string;
  srcTitle: string;
  relPath: string;
  anchor: string | null;
  context: string;
}

export interface DocPayload extends DocDTO {
  body: string;
  rawHash: string;
  encoding: FileEncoding;
  eol: '\n' | '\r\n';
  annotations: Annotation[];
  links: OutLinkDTO[];
  backlinks: BacklinkDTO[];
  headings: HeadingRef[];
  source: SourceInfo | null;
  frontmatter: Record<string, unknown> | null;
  hasFrontmatter: boolean;
}

export interface SaveInput {
  body?: string;
  baseHash?: string;
  title?: string;
  tags?: string[];
  reader?: {
    status?: DocStatus;
    progress?: number;
    annotations?: Annotation[];
  };
}

export interface SaveResult {
  hash: string;
  mtime: number;
  encoding: FileEncoding;
  reencoded: boolean;
}

export interface SearchResult {
  id: string;
  title: string;
  relPath: string;
  status: DocStatus;
  tags: string[];
  progress: number;
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

export interface LibraryStats {
  root: string | null;
  total: number;
  words: number;
  tags: number;
  byStatus: Record<string, number>;
  indexedAt: number | null;
  scanning: boolean;
  lastScan: IndexResult | null;
}

function toDTO(row: StoredDocRow | DocSummary): DocDTO {
  if ('rel_path' in row) {
    return {
      id: row.id,
      relPath: row.rel_path,
      title: row.title,
      tags: JSON.parse(row.tags || '[]') as string[],
      aliases: JSON.parse(row.aliases || '[]') as string[],
      status: (isStatus(row.status) ? row.status : 'unread') as DocStatus,
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
  return {
    id: row.id,
    relPath: row.relPath,
    title: row.title,
    tags: row.tags,
    aliases: row.aliases,
    status: row.status,
    progress: row.progress,
    words: row.words,
    excerpt: row.excerpt,
    sourceUrl: row.sourceUrl,
    mtime: row.mtime,
    size: row.size,
    annCount: row.annCount,
    created: row.created,
  };
}

function sanitizeSegment(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 90);
}

function sanitizeDir(dir: string | null | undefined): string {
  if (!dir) return 'Inbox';
  const cleaned = dir
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return cleaned || 'Inbox';
}

function uniquePath(dirAbs: string, baseName: string, ext = '.md'): string {
  let candidate = path.join(dirAbs, `${baseName}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dirAbs, `${baseName} ${n}${ext}`);
    n++;
    if (n > 999) break;
  }
  return candidate;
}

function makeSnippet(text: string, needle: string, radius = 60): { snippet: string; start: number; end: number } {
  const trimmed = needle.trim();
  if (!trimmed) {
    const snippet = text.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
    return { snippet, start: 0, end: 0 };
  }
  const haystack = text.toLowerCase();
  let idx = haystack.indexOf(trimmed.toLowerCase());
  if (idx < 0) {
    // 多词查询：退回第一个词
    const first = trimmed.split(/\s+/)[0] ?? '';
    if (first) idx = haystack.indexOf(first.toLowerCase());
    if (idx < 0) idx = 0;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + trimmed.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const raw = text.slice(start, end).replace(/\s+/g, ' ');
  const leadTrim = raw.match(/^\s*/)?.[0].length ?? 0;
  const snippet = prefix + raw.trim() + suffix;
  const matchStart = Math.max(0, idx - start - leadTrim + prefix.length);
  const matchEnd = Math.min(snippet.length, matchStart + trimmed.length);
  return { snippet, start: matchStart, end: matchEnd };
}

export class LibraryService {
  paths: DataPaths;
  config: ConfigStore;
  db: IndexDB;
  hub: EventHub;
  root: string | null = null;
  indexer: LibraryIndexer | null = null;
  watcher: LibraryWatcher | null = null;
  lastScan: IndexResult | null = null;
  private scanningPromise: Promise<IndexResult> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private lastProgressAt = 0;

  constructor(paths: DataPaths, config: ConfigStore, db: IndexDB, hub: EventHub) {
    this.paths = paths;
    this.config = config;
    this.db = db;
    this.hub = hub;
  }

  get versionKeep(): number {
    return this.config.get().versionKeep;
  }

  async init(): Promise<void> {
    ensureDataDirs(this.paths);
    const stored = this.config.resolveLibraryRoot();
    const root = stored ?? this.config.ensureDefaultLibrary();
    const createdDefault = !stored;
    if (createdDefault) this.config.save({ libraryRoot: root });
    await this.mount(root, { initial: true, seed: createdDefault });
  }

  private broadcastIndexProgress(progress: Parameters<LibraryIndexer['onProgress']>[0]): void {
    const now = Date.now();
    if (progress.phase === 'index' && now - this.lastProgressAt < 120) return;
    this.lastProgressAt = now;
    this.hub.broadcast('index-progress', progress);
  }

  async mount(root: string, opts: { initial?: boolean; seed?: boolean } = {}): Promise<void> {
    const resolved = path.resolve(root);
    let stat: fs.Stats | null = null;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isDirectory()) {
      throw badRequest('书库路径不存在或不是目录', { path: resolved });
    }

    const sameRoot = this.root && path.resolve(this.root) === resolved;
    if (sameRoot) {
      await this.rescan('remount');
      return;
    }

    this.stopWatcher();
    this.root = resolved;
    this.config.save({ libraryRoot: resolved });
    this.db.clearDocs();
    this.db.setMeta('libraryRoot', resolved);

    const indexer = new LibraryIndexer(resolved, this.db, (p) => this.broadcastIndexProgress(p));
    this.indexer = indexer;

    const watcher = new LibraryWatcher(resolved, indexer, {
      onChange: (change) => {
        this.hub.broadcast('doc-changed', {
          id: change.id,
          relPath: change.relPath,
          kind: change.kind,
          origin: 'watcher',
        });
      },
      onBatchResolved: () => {
        this.hub.broadcast('links-changed', { at: Date.now() });
      },
      onFullRescan: (reason) => {
        void this.rescan(reason);
      },
    });
    this.watcher = watcher;
    watcher.start();

    this.hub.broadcast('library-changed', { root: resolved });
    if (opts.seed) {
      await this.seedWelcomeDoc().catch(() => {});
    }
    void this.rescan(opts.initial ? 'initial' : 'mount');
  }

  private stopWatcher(): void {
    this.watcher?.stop();
    this.watcher = null;
    this.indexer = null;
  }

  private async seedWelcomeDoc(): Promise<void> {
    if (!this.root) return;
    const entries = await fsp.readdir(this.root).catch(() => [] as string[]);
    const hasMarkdown = entries.some((name) => /\.md$/i.test(name));
    if (hasMarkdown) return;
    const id = ulid();
    const text = buildFrontmatter({ title: '欢迎使用 md-reader', id, created: new Date().toISOString() });
    const body = [
      '这是你的第一篇文章。按 `E` 进入编辑，写点什么，然后按 `Ctrl+S` 保存。',
      '',
      '## 能做什么',
      '',
      '- 书架：未读 / 在读 / 已读，标签，搜索',
      '- 阅读：排版、目录、沉浸模式、代码高亮、公式',
      '- 写作：Live Preview，所见即所得的 Markdown 源码',
      '- 批注：选中文字 → 划色 → 写旁注，存进文件 frontmatter',
      '- 双链：`[[欢迎使用 md-reader]]` 这样的链接',
      '',
      '> 文件就是数据库。所有元数据都写在这篇 `.md` 里。',
      '',
    ].join('\n');
    const dir = path.join(this.root, 'Inbox');
    await fsp.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, '欢迎使用 md-reader.md'), text + body, { retries: 1 });
  }

  async rescan(reason = 'manual'): Promise<IndexResult> {
    if (!this.indexer) throw new HttpError(409, 'no-library', '还没有挂载书库');
    if (this.scanningPromise) return this.scanningPromise;
    const indexer = this.indexer;
    this.scanningPromise = (async () => {
      const result = await indexer.scanAll();
      this.lastScan = result;
      this.hub.broadcast('index-done', { ...result, reason });
      return result;
    })().finally(() => {
      this.scanningPromise = null;
    });
    return this.scanningPromise;
  }

  isScanning(): boolean {
    return this.scanningPromise !== null || (this.indexer?.isScanning() ?? false);
  }

  stats(): LibraryStats {
    const s = this.db.stats();
    return {
      root: this.root,
      total: s.total,
      words: s.words,
      tags: s.tags,
      byStatus: s.byStatus,
      indexedAt: s.indexedAt,
      scanning: this.isScanning(),
      lastScan: this.lastScan,
    };
  }

  requireDoc(id: string): StoredDocRow {
    const row = this.db.getDoc(id);
    if (!row) throw notFound('文档不存在');
    return row;
  }

  private docAbs(row: StoredDocRow): string {
    if (!this.root) throw new HttpError(409, 'no-library', '还没有挂载书库');
    const abs = resolveInRoot(this.root, row.rel_path);
    if (!isInsideRoot(this.root, abs)) throw badRequest('文档路径越界');
    return abs;
  }

  private async readParsed(row: StoredDocRow): Promise<{ parsed: ParsedDocFile; abs: string }> {
    const abs = this.docAbs(row);
    let buffer: Buffer;
    try {
      buffer = await fsp.readFile(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.db.removeDocument(row.id);
        throw notFound('文件已被删除');
      }
      throw err;
    }
    const stat = await fsp.stat(abs);
    const parsed = parseDocBuffer(row.rel_path, buffer, Math.round(stat.mtimeMs), stat.size);
    return { parsed, abs };
  }

  async getDoc(id: string): Promise<DocPayload> {
    const row = this.requireDoc(id);
    const { parsed } = await this.readParsed(row);

    if (parsed.hash !== row.hash || parsed.record.title !== row.title) {
      parsed.record.id = row.id;
      this.db.upsertDocument(parsed.record);
      this.db.replaceLinks(row.id, parsed.links.map((l) => ({ dstRaw: l.dstRaw, dstAnchor: l.dstAnchor, kind: 'wiki' })));
      this.db.replaceAnnotations(row.id, parsed.annotations);
      this.indexer?.resolveLinks();
    }

    const links: OutLinkDTO[] = this.db.outlinksFor(row.id).map((l) => ({
      dstId: l.dstId,
      dstRaw: l.dstRaw,
      dstTitle: l.dstTitle,
      anchor: l.anchor,
      broken: !l.dstId,
    }));

    const backlinks: BacklinkDTO[] = [];
    for (const back of this.db.backlinksFor(row.id)) {
      backlinks.push({
        srcId: back.srcId,
        srcTitle: back.srcTitle,
        relPath: back.relPath,
        anchor: back.anchor,
        context: await this.backlinkContext(back.srcId, parsed.title),
      });
    }

    return {
      ...toDTO(this.db.getDoc(row.id) ?? row),
      body: parsed.body,
      rawHash: parsed.hash,
      encoding: parsed.encoding,
      eol: parsed.eol,
      annotations: parsed.annotations,
      links,
      backlinks,
      headings: extractHeadings(parsed.body),
      source: parsed.source,
      frontmatter: parsed.frontmatter,
      hasFrontmatter: parsed.layout.hasFrontmatter,
    };
  }

  private async backlinkContext(srcId: string, targetTitle: string): Promise<string> {
    const row = this.db.getDoc(srcId);
    if (!row || !this.root) return '';
    try {
      const buffer = await fsp.readFile(resolveInRoot(this.root, row.rel_path));
      const { text } = decodeFile(buffer);
      const layout = parseLayout(text);
      const re = new RegExp(`\\[\\[\\s*${escapeRegExp(targetTitle)}(?:[#|][^\\]]*)?\\]\\]`, 'i');
      const m = re.exec(layout.body);
      if (!m) return excerptOf(layout.body, 80);
      let start = Math.max(0, m.index - 40);
      const end = Math.min(layout.body.length, m.index + m[0].length + 40);
      if (start > 0) {
        const boundary = layout.body.indexOf(' ', start);
        if (boundary !== -1 && boundary < start + 12) start = boundary + 1;
      }
      return layout.body.slice(start, end).replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  listDocs(opts: {
    status?: DocStatus | 'all';
    tag?: string | null;
    sort?: SortKey;
    q?: string | null;
    limit?: number;
    offset?: number;
  }): DocDTO[] {
    return this.db.listDocs(opts).map(toDTO);
  }

  search(query: string, limit = 20): SearchResult[] {
    const q = query.trim();
    if (!q) return [];
    const hits = this.db.search(q, { limit });
    const out: SearchResult[] = [];
    for (const hit of hits) {
      out.push({
        id: hit.doc.id,
        title: hit.doc.title,
        relPath: hit.doc.relPath,
        status: hit.doc.status,
        tags: hit.doc.tags,
        progress: hit.doc.progress,
        snippet: hit.doc.excerpt,
        matchStart: 0,
        matchEnd: 0,
      });
    }
    return out;
  }

  /** 搜索 + 读文件生成带高亮的片段（单独方法，避免 /docs 列表读盘） */
  async searchWithSnippets(query: string, limit = 20): Promise<SearchResult[]> {
    const rows = this.db.search(query, { limit });
    const out: SearchResult[] = [];
    for (const hit of rows) {
      const row = this.db.getDoc(hit.doc.id);
      if (!row || !this.root) {
        out.push({ ...this.toSearchBase(hit.doc), snippet: hit.doc.excerpt, matchStart: 0, matchEnd: 0 });
        continue;
      }
      try {
        const buffer = await fsp.readFile(resolveInRoot(this.root, row.rel_path));
        const { text } = decodeFile(buffer);
        const layout = parseLayout(text);
        const { snippet, start, end } = makeSnippet(layout.body, query);
        out.push({ ...this.toSearchBase(hit.doc), snippet, matchStart: start, matchEnd: end });
      } catch {
        out.push({ ...this.toSearchBase(hit.doc), snippet: hit.doc.excerpt, matchStart: 0, matchEnd: 0 });
      }
    }
    return out;
  }

  private toSearchBase(doc: DocSummary): Omit<SearchResult, 'snippet' | 'matchStart' | 'matchEnd'> {
    return {
      id: doc.id,
      title: doc.title,
      relPath: doc.relPath,
      status: doc.status,
      tags: doc.tags,
      progress: doc.progress,
    };
  }

  /* -------------------------------------------------------------- 保存 */

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(id, next);
    return next.finally(() => {
      if (this.locks.get(id) === next) this.locks.delete(id);
    });
  }

  async saveDoc(id: string, input: SaveInput): Promise<SaveResult> {
    return this.withLock(id, () => this.saveDocLocked(id, input));
  }

  private async saveDocLocked(id: string, input: SaveInput): Promise<SaveResult> {
    const row = this.requireDoc(id);
    const abs = this.docAbs(row);
    const oldBuffer = await fsp.readFile(abs).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        this.db.removeDocument(id);
        throw notFound('文件已被删除');
      }
      throw err;
    });
    const currentHash = hashBuffer(oldBuffer);

    if (input.baseHash && input.baseHash !== currentHash) {
      const current = decodeFile(oldBuffer);
      throw new HttpError(409, 'conflict', '文件已被外部修改，未覆盖磁盘内容', {
        current: {
          hash: currentHash,
          mtime: row.mtime,
          body: parseLayout(current.text).body,
        },
      });
    }

    const { text, encoding, eol } = decodeFile(oldBuffer);
    const layout = parseLayout(text);
    const readerPatch = {
      ...input.reader,
      id,
    };
    const newText = applyDocumentEdits(layout, {
      body: input.body,
      title: input.title,
      tags: input.tags,
      reader: readerPatch,
    });

    let outEncoding: FileEncoding = encoding;
    let encoded = encodeFile(newText, encoding);
    if (decodeFile(encoded).text.normalize('NFC') !== newText.normalize('NFC')) {
      // 原编码无法表示新内容（例如 GBK 文件里输入了 emoji）→ 升级为 UTF-8
      outEncoding = 'utf8';
      encoded = encodeFile(newText, 'utf8');
    }

    const keep = this.versionKeep;
    if (keep > 0) await saveVersion(this.paths.versionsDir, id, oldBuffer, keep);
    await atomicWriteFile(abs, encoded);
    const stat = await fsp.stat(abs);
    const newHash = hashBuffer(encoded);

    if (this.indexer) {
      await this.indexer.indexBuffer(row.rel_path, encoded, Math.round(stat.mtimeMs), id);
      this.indexer.resolveLinks();
    }

    this.hub.broadcast('doc-changed', {
      id,
      relPath: row.rel_path,
      hash: newHash,
      mtime: Math.round(stat.mtimeMs),
      origin: 'save',
    });

    void eol;
    return { hash: newHash, mtime: Math.round(stat.mtimeMs), encoding: outEncoding, reencoded: outEncoding !== encoding };
  }

  async createDoc(input: { dir?: string; title?: string; content?: string; tags?: string[] }): Promise<DocPayload> {
    if (!this.root) throw new HttpError(409, 'no-library', '还没有挂载书库');
    const dirRel = sanitizeDir(input.dir ?? 'Inbox');
    const dirAbs = resolveInRoot(this.root, dirRel);
    if (!isInsideRoot(this.root, dirAbs)) throw badRequest('目录越界');
    await fsp.mkdir(dirAbs, { recursive: true });

    const title = (input.title ?? '').trim() || '未命名';
    const baseName = sanitizeSegment(title) || '未命名';
    const file = uniquePath(dirAbs, baseName);
    const id = ulid();
    const now = new Date().toISOString();
    const fm = buildFrontmatter({ title, id, created: now, tags: input.tags ?? [] });
    const body = input.content ?? `\n# ${title}\n\n`;
    await atomicWriteFile(file, Buffer.from(fm + body, 'utf8'), { retries: 1 });

    if (this.indexer) {
      await this.indexer.indexFile(file);
      this.indexer.resolveLinks();
    }
    this.hub.broadcast('doc-changed', { id, relPath: relativePosix(this.root, file), created: true, origin: 'create' });
    return this.getDoc(id);
  }

  async moveDoc(
    id: string,
    input: { targetDir?: string; newName?: string; updateLinks?: boolean },
  ): Promise<DocPayload> {
    if (!this.root) throw new HttpError(409, 'no-library', '还没有挂载书库');
    const row = this.requireDoc(id);
    const oldAbs = this.docAbs(row);
    const oldDir = path.posix.dirname(row.rel_path);
    const targetDirRel = sanitizeDir(input.targetDir ?? (oldDir === '.' ? '' : oldDir));
    const dirAbs = resolveInRoot(this.root, targetDirRel);
    if (!isInsideRoot(this.root, dirAbs)) throw badRequest('目录越界');
    await fsp.mkdir(dirAbs, { recursive: true });

    const rawName = (input.newName ?? path.posix.basename(row.rel_path, '.md')).trim();
    const newBase = sanitizeSegment(rawName) || path.posix.basename(row.rel_path, '.md');
    let newAbs = path.join(dirAbs, `${newBase}.md`);
    let newRel = relativePosix(this.root, newAbs);

    if (path.resolve(newAbs) === path.resolve(oldAbs)) {
      return this.getDoc(id);
    }
    if (fs.existsSync(newAbs)) {
      throw new HttpError(409, 'exists', '目标位置已存在同名文件', { relPath: newRel });
    }

    // 先把 reader.id 落到 frontmatter，保证移动后身份不变
    await this.ensureReaderId(row);

    const oldTitle = row.title;
    const updateLinks = input.updateLinks !== false;

    const caseOnly =
      path.dirname(newAbs).toLowerCase() === path.dirname(oldAbs).toLowerCase() &&
      newBase.toLowerCase() === path.basename(oldAbs, '.md').toLowerCase() &&
      newBase !== path.basename(oldAbs, '.md');

    if (caseOnly) {
      const tmp = path.join(path.dirname(oldAbs), `.${path.basename(oldAbs)}.rename.tmp`);
      await fsp.rename(oldAbs, tmp);
      await fsp.rename(tmp, newAbs);
    } else {
      await fsp.rename(oldAbs, newAbs);
    }

    await this.dbSetDocPath(id, newRel);
    if (this.indexer) {
      await this.indexer.indexFile(newAbs);
      this.indexer.resolveLinks();
    }

    if (updateLinks && oldTitle !== newBase) {
      await this.updateReferringLinks(id, oldTitle, newBase).catch(() => {});
    }

    this.hub.broadcast('doc-changed', { id, relPath: newRel, moved: true, origin: 'move' });
    return this.getDoc(id);
  }

  private async dbSetDocPath(id: string, relPath: string): Promise<void> {
    this.db.db.prepare('UPDATE docs SET rel_path = ? WHERE id = ?').run(relPath, id);
  }

  private async ensureReaderId(row: StoredDocRow): Promise<void> {
    const abs = this.docAbs(row);
    const buffer = await fsp.readFile(abs);
    const { text } = decodeFile(buffer);
    const layout = parseLayout(text);
    const meta = readReaderMeta(layout.frontmatter, '');
    if (meta.id === row.id) return;
    const newText = applyDocumentEdits(layout, { reader: { id: row.id } });
    const encoded = encodeFile(newText, decodeFile(buffer).encoding);
    await saveVersion(this.paths.versionsDir, row.id, buffer, this.versionKeep);
    await atomicWriteFile(abs, encoded);
  }

  private async updateReferringLinks(docId: string, oldTitle: string, newTitle: string): Promise<void> {
    const refs = this.db.backlinksFor(docId);
    const re = new RegExp(`\\[\\[\\s*${escapeRegExp(oldTitle)}\\s*(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, 'g');
    for (const ref of refs) {
      const row = this.db.getDoc(ref.srcId);
      if (!row) continue;
      const abs = this.docAbs(row);
      const buffer = await fsp.readFile(abs).catch(() => null);
      if (!buffer) continue;
      const { text, encoding } = decodeFile(buffer);
      const layout = parseLayout(text);
      if (!re.test(layout.body)) {
        re.lastIndex = 0;
        continue;
      }
      re.lastIndex = 0;
      const newBody = layout.body.replace(re, (_m, anchor?: string, display?: string) => {
        return `[[${newTitle}${anchor ?? ''}${display ?? ''}]]`;
      });
      if (newBody === layout.body) continue;
      const newText = applyDocumentEdits(layout, { body: newBody });
      const encoded = encodeFile(newText, encoding);
      await saveVersion(this.paths.versionsDir, row.id, buffer, this.versionKeep);
      await atomicWriteFile(abs, encoded);
      await this.indexer?.indexBuffer(row.rel_path, encoded, Date.now(), row.id);
    }
  }

  async deleteDoc(id: string): Promise<{ trashedTo: string }> {
    if (!this.root) throw new HttpError(409, 'no-library', '还没有挂载书库');
    const row = this.requireDoc(id);
    const abs = this.docAbs(row);
    const trashDir = path.join(this.root, '.trash');
    await fsp.mkdir(trashDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let target = path.join(trashDir, `${stamp}-${path.basename(abs)}`);
    if (fs.existsSync(target)) target = path.join(trashDir, `${stamp}-${id.slice(0, 6)}-${path.basename(abs)}`);
    await fsp.rename(abs, target);
    this.db.removeDocument(id);
    this.indexer?.resolveLinks();
    this.hub.broadcast('doc-removed', { id, relPath: row.rel_path, origin: 'delete' });
    return { trashedTo: relativePosix(this.root, target) };
  }

  /* -------------------------------------------------------------- 批注 */

  async addAnnotation(
    docId: string,
    input: { exact: string; prefix?: string; suffix?: string; pos?: number; color?: string; note?: string; baseHash?: string },
  ): Promise<{ annotation: Annotation; hash: string; count: number }> {
    return this.withLock(docId, async () => {
      const row = this.requireDoc(docId);
      const { parsed } = await this.readParsed(row);
      const exact = input.exact.trim();
      if (!exact) throw badRequest('批注内容为空');
      if (exact.length > 5000) throw badRequest('批注内容过长');
      const annotation: Annotation = {
        id: ulid(),
        exact,
        prefix: (input.prefix ?? '').slice(0, 200),
        suffix: (input.suffix ?? '').slice(0, 200),
        pos: Number.isFinite(input.pos) ? Math.max(0, Math.round(input.pos!)) : 0,
        color: isColor(input.color) ? input.color : ANNOTATION_COLORS[0]!,
        note: (input.note ?? '').slice(0, 5000),
        created: new Date().toISOString(),
      };
      const annotations = [...parsed.annotations, annotation];
      const result = await this.saveDocLocked(docId, { reader: { annotations }, baseHash: input.baseHash });
      return { annotation, hash: result.hash, count: annotations.length };
    });
  }

  async updateAnnotation(
    docId: string,
    annotationId: string,
    patch: { note?: string; color?: string },
  ): Promise<{ annotation: Annotation; hash: string; count: number }> {
    return this.withLock(docId, async () => {
      const row = this.requireDoc(docId);
      const { parsed } = await this.readParsed(row);
      const annotations = parsed.annotations.map((a) =>
        a.id === annotationId
          ? {
              ...a,
              note: patch.note !== undefined ? patch.note.slice(0, 5000) : a.note,
              color: isColor(patch.color) ? patch.color : a.color,
            }
          : a,
      );
      const annotation = annotations.find((a) => a.id === annotationId);
      if (!annotation) throw notFound('批注不存在');
      const result = await this.saveDocLocked(docId, { reader: { annotations } });
      return { annotation, hash: result.hash, count: annotations.length };
    });
  }

  async deleteAnnotation(docId: string, annotationId: string): Promise<{ hash: string; count: number }> {
    return this.withLock(docId, async () => {
      const row = this.requireDoc(docId);
      const { parsed } = await this.readParsed(row);
      const annotations = parsed.annotations.filter((a) => a.id !== annotationId);
      if (annotations.length === parsed.annotations.length) throw notFound('批注不存在');
      const result = await this.saveDocLocked(docId, { reader: { annotations } });
      return { hash: result.hash, count: annotations.length };
    });
  }

  async setStatus(docId: string, status: DocStatus): Promise<SaveResult> {
    if (!isStatus(status)) throw badRequest('非法状态');
    return this.saveDoc(docId, { reader: { status } });
  }

  /* -------------------------------------------------------------- 资源 */

  async uploadAsset(docId: string, filename: string, data: Buffer, mime: string): Promise<{ relPath: string; url: string; size: number }> {
    if (!this.root) throw new HttpError(409, 'no-library', '还没有挂载书库');
    this.requireDoc(docId);
    const ext = pickImageExt(filename, mime);
    if (!ext) throw new HttpError(415, 'unsupported-media', '只支持图片');
    if (data.length > 20 * 1024 * 1024) throw new HttpError(413, 'too-large', '图片不能超过 20MB');
    const dir = path.join(this.root, 'assets', docId);
    await fsp.mkdir(dir, { recursive: true });
    const name = `${hashBuffer(data).slice(0, 16)}${ext}`;
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) await atomicWriteFile(abs, data, { retries: 1 });
    const relPath = `assets/${docId}/${name}`;
    return { relPath, url: `/api/v1/files?path=${encodeURIComponent(relPath)}`, size: data.length };
  }

  resolveAsset(relPath: string): { abs: string; mime: string } {
    if (!this.root) throw new HttpError(409, 'no-library', '还没有挂载书库');
    const abs = resolveInRoot(this.root, relPath);
    if (!isInsideRoot(this.root, abs)) throw badRequest('路径越界');
    const ext = path.extname(abs).toLowerCase();
    const mime = IMAGE_TYPES[ext];
    if (!mime) throw new HttpError(403, 'forbidden-type', '只允许访问图片');
    return { abs, mime };
  }

  async preview(target: string): Promise<{ id: string; title: string; excerpt: string } | null> {
    const needle = target.normalize('NFC').trim().toLowerCase();
    if (!needle) return null;
    const docs = this.db.allDocsForResolve();
    const doc =
      docs.find((d) => d.title.normalize('NFC').toLowerCase() === needle) ??
      docs.find((d) => d.aliases.some((a) => a.normalize('NFC').toLowerCase() === needle)) ??
      docs.find((d) => path.posix.basename(d.relPath, '.md').normalize('NFC').toLowerCase() === needle);
    if (!doc || !this.root) return null;
    try {
      const buffer = await fsp.readFile(resolveInRoot(this.root, doc.relPath));
      const { text } = decodeFile(buffer);
      const layout = parseLayout(text);
      return { id: doc.id, title: doc.title, excerpt: excerptOf(layout.body, 300) };
    } catch {
      return null;
    }
  }

  /** 目录树（用于新建/移动对话框） */
  directoryTree(): { dirs: string[] } {
    if (!this.root) return { dirs: [] };
    const dirs = new Set<string>(['']);
    const visit = (dirAbs: string, depth: number): void => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'assets') continue;
        const abs = path.join(dirAbs, entry.name);
        dirs.add(relativePosix(this.root!, abs));
        visit(abs, depth + 1);
      }
    };
    visit(this.root, 0);
    return { dirs: [...dirs].sort((a, b) => a.localeCompare(b, 'zh')) };
  }

  async updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    const before = this.config.get();
    const next = this.config.save(patch);
    if (patch.libraryRoot && path.resolve(patch.libraryRoot) !== this.root) {
      await this.mount(patch.libraryRoot);
    }
    if (patch.theme !== before.theme) this.hub.broadcast('config-changed', next);
    return next;
  }

  wordCountOf(body: string): number {
    return countWords(body);
  }

  async shutdown(): Promise<void> {
    this.watcher?.stop();
    this.watcher = null;
    this.indexer = null;
    this.db.close();
  }
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function pickImageExt(filename: string, mime: string): string | null {
  const byMime: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/svg+xml': '.svg',
  };
  if (byMime[mime]) return byMime[mime];
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_TYPES[ext] ? ext : null;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
