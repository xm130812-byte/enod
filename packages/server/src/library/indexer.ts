import fs from 'node:fs/promises';
import path from 'node:path';
import { relativePosix, shouldSkipDir, shouldSkipFile } from '../core/paths.ts';
import { ulid } from '../core/ulid.ts';
import type { IndexDB } from '../store/db.ts';
import { convertToMarkdown, derivedDocId, kindOf, stripDocExt } from './adapt.ts';
import { parseDocBuffer, parseDerivedDoc } from './parse.ts';

export interface IndexProgress {
  phase: 'idle' | 'walk' | 'index' | 'links' | 'done';
  done: number;
  total: number;
  current?: string;
}

export interface IndexResult {
  indexed: number;
  updated: number;
  skipped: number;
  removed: number;
  errors: number;
  total: number;
  durationMs: number;
}

export type IndexFileStatus = 'added' | 'updated' | 'unchanged' | 'removed' | 'ignored';

export class LibraryIndexer {
  root: string;
  db: IndexDB;
  onProgress: (p: IndexProgress) => void;
  private scanning = false;

  constructor(root: string, db: IndexDB, onProgress: (p: IndexProgress) => void = () => {}) {
    this.root = root;
    this.db = db;
    this.onProgress = onProgress;
  }

  isScanning(): boolean {
    return this.scanning;
  }

  /** 递归列出所有可索引的文档绝对路径（.md 与适配格式，见 adapt.ts） */
  async walk(): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (shouldSkipDir(entry.name)) continue;
          await visit(path.join(dir, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        if (shouldSkipFile(entry.name)) continue;
        if (!kindOf(entry.name)) continue;
        out.push(path.join(dir, entry.name));
      }
    };
    await visit(this.root);
    return out;
  }

  async scanAll(): Promise<IndexResult> {
    const started = Date.now();
    this.scanning = true;
    const result: IndexResult = {
      indexed: 0,
      updated: 0,
      skipped: 0,
      removed: 0,
      errors: 0,
      total: 0,
      durationMs: 0,
    };
    try {
      this.onProgress({ phase: 'walk', done: 0, total: 0 });
      const files = await this.walk();
      result.total = files.length;
      let done = 0;
      for (const file of files) {
        done++;
        const rel = relativePosix(this.root, file);
        this.onProgress({ phase: 'index', done, total: files.length, current: rel });
        try {
          const status = await this.indexFile(file);
          if (status === 'added') result.indexed++;
          else if (status === 'updated') result.updated++;
          else if (status === 'unchanged') result.skipped++;
        } catch {
          result.errors++;
        }
      }

      const existing = new Set(files.map((f) => relativePosix(this.root, f)));
      for (const stale of this.db.staleDocs(existing)) {
        this.db.removeDocument(stale.id);
        result.removed++;
      }

      this.onProgress({ phase: 'links', done: 0, total: 0 });
      this.resolveLinks();
      this.db.setMeta('lastIndexedAt', String(Date.now()));
      result.durationMs = Date.now() - started;
      this.onProgress({ phase: 'done', done: files.length, total: files.length });
      return result;
    } finally {
      this.scanning = false;
    }
  }

  async indexFile(absPath: string): Promise<IndexFileStatus> {
    const rel = relativePosix(this.root, absPath);
    const kind = kindOf(rel);
    if (!kind) return 'ignored';
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return 'removed';
    }
    if (!stat.isFile()) return 'ignored';
    const mtime = Math.round(stat.mtimeMs);
    if (this.db.isFresh(rel, mtime, stat.size)) return 'unchanged';

    const buffer = await fs.readFile(absPath);
    const previous = this.db.getDocByPath(rel);

    const parsed =
      kind === 'md'
        ? parseDocBuffer(rel, buffer, mtime, stat.size)
        : parseDerivedDoc(rel, buffer, mtime, stat.size, await convertToMarkdown(buffer, absPath, rel, kind, this.root));
    // md 的身份在 frontmatter 里；非 md 没有地方存，按路径派生，重建索引也不变
    const id = parsed.readerId ?? previous?.id ?? (kind === 'md' ? ulid() : derivedDocId(rel));
    parsed.record.id = id;
    parsed.record.indexedAt = Date.now();

    if (previous && previous.id !== id) this.db.removeDocument(previous.id);
    this.db.upsertDocument(parsed.record);
    this.db.replaceLinks(id, parsed.links.map((l) => ({ dstRaw: l.dstRaw, dstAnchor: l.dstAnchor, kind: 'wiki' })));
    this.db.replaceAnnotations(id, parsed.annotations);

    return previous ? 'updated' : 'added';
  }

  /** 只重算索引中的 reader 元数据（保存后调用，避免整篇重解析两次） */
  async indexBuffer(relPath: string, buffer: Buffer, mtime: number, forcedId: string): Promise<void> {
    const parsed = parseDocBuffer(relPath, buffer, mtime, buffer.length);
    parsed.record.id = forcedId;
    parsed.record.indexedAt = Date.now();
    this.db.upsertDocument(parsed.record);
    this.db.replaceLinks(forcedId, parsed.links.map((l) => ({ dstRaw: l.dstRaw, dstAnchor: l.dstAnchor, kind: 'wiki' })));
    this.db.replaceAnnotations(forcedId, parsed.annotations);
  }

  removeByRelPath(relPath: string): boolean {
    const row = this.db.getDocByPath(relPath);
    if (!row) return false;
    this.db.removeDocument(row.id);
    return true;
  }

  /** 按 PRD 优先级解析 [[链接]]：title → aliases → 文件名 → 相对路径 */
  resolveLinks(): { total: number; resolved: number } {
    const docs = this.db.allDocsForResolve();
    const map = new Map<string, string>();
    const put = (key: string, id: string) => {
      const k = key.normalize('NFC').trim().toLowerCase();
      if (!k) return;
      if (!map.has(k)) map.set(k, id);
    };
    for (const doc of docs) put(doc.title, doc.id);
    for (const doc of docs) for (const alias of doc.aliases) put(alias, doc.id);
    for (const doc of docs) put(stripDocExt(path.posix.basename(doc.relPath)), doc.id);
    for (const doc of docs) {
      put(doc.relPath, doc.id);
      put(stripDocExt(doc.relPath), doc.id);
    }
    return this.db.resolveLinks((raw) => map.get(raw.normalize('NFC').trim().toLowerCase()) ?? null, docs);
  }
}
