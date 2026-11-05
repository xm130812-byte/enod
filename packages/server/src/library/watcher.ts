import fs from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';
import { relativePosix, shouldSkipDir, shouldSkipFile } from '../core/paths.ts';
import type { LibraryIndexer } from './indexer.ts';

export interface WatchChange {
  relPath: string;
  id: string | null;
  kind: 'changed' | 'removed';
}

export interface WatcherOptions {
  debounceMs?: number;
  onChange: (change: WatchChange) => void;
  onBatchResolved?: () => void;
  onFullRescan?: (reason: string) => void;
}

/**
 * fs.watch({recursive:true}) 增量监听。
 * Windows 的 ReadDirectoryChangesW 会溢出，overflow 时退化为全量重扫。
 */
export class LibraryWatcher {
  root: string;
  indexer: LibraryIndexer;
  opts: WatcherOptions;
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private debounceMs: number;

  constructor(root: string, indexer: LibraryIndexer, opts: WatcherOptions) {
    this.root = root;
    this.indexer = indexer;
    this.opts = opts;
    this.debounceMs = opts.debounceMs ?? 280;
  }

  start(): void {
    if (this.watcher) return;
    this.stopped = false;
    try {
      this.watcher = fs.watch(this.root, { recursive: true, persistent: true }, (event, filename) => {
        if (!filename) {
          this.requestFullScan('watch-overflow');
          return;
        }
        const rel = String(filename).split(path.sep).join('/');
        this.schedule(rel);
      });
      this.watcher.on('error', () => {
        this.requestFullScan('watch-error');
      });
    } catch {
      this.requestFullScan('watch-failed');
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private schedule(rel: string): void {
    if (this.stopped) return;
    this.pending.add(rel);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private requestFullScan(reason: string): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending.clear();
      this.opts.onFullRescan?.(reason);
    }, 600);
  }

  private isIgnored(rel: string): boolean {
    const parts = rel.split('/').filter(Boolean);
    if (parts.length === 0) return false;
    for (const part of parts.slice(0, -1)) {
      if (shouldSkipDir(part)) return true;
    }
    const name = parts[parts.length - 1]!;
    return shouldSkipFile(name);
  }

  private async flush(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    const batch = [...this.pending];
    this.pending.clear();
    let touched = false;
    try {
      for (const rel of batch) {
        if (!rel || this.isIgnored(rel)) continue;
        if (!/\.md$/i.test(rel)) {
          // 目录重命名/新增目录：直接全量重扫（低频、可靠）
          if (!path.extname(rel)) {
            this.opts.onFullRescan?.('dir-change');
            continue;
          }
          continue;
        }
        const abs = path.join(this.root, ...rel.split('/'));
        let exists = true;
        try {
          const stat = await fs.promises.stat(abs);
          exists = stat.isFile();
        } catch {
          exists = false;
        }

        if (!exists) {
          const removed = this.indexer.removeByRelPath(relativePosix(this.root, abs));
          if (removed) {
            touched = true;
            this.opts.onChange({ relPath: rel, id: null, kind: 'removed' });
          }
          continue;
        }

        try {
          const status = await this.indexer.indexFile(abs);
          if (status === 'added' || status === 'updated') {
            touched = true;
            const row = this.indexer.db.getDocByPath(rel);
            this.opts.onChange({ relPath: rel, id: row?.id ?? null, kind: 'changed' });
          }
        } catch {
          /* 文件正在被写入时读取失败，等下一轮 */
        }
      }

      if (touched) {
        this.indexer.resolveLinks();
        this.opts.onBatchResolved?.();
      }
    } finally {
      this.running = false;
      if (this.pending.size > 0) this.schedule('');
    }
  }
}
