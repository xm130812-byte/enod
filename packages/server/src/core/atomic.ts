import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 原子写：同目录临时文件 → fsync → rename。
 * 断电只会留下 .tmp，不会留下半截正文。
 */
export async function atomicWriteFile(
  filePath: string,
  data: Buffer | string,
  options: { retries?: number } = {},
): Promise<void> {
  const retries = options.retries ?? 2;
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (!code || !RETRYABLE.has(code) || attempt === retries) break;
      await sleep(80 * (attempt + 1));
    }
  }
  throw lastError;
}

/** 写回前留快照：versions/<docId>/<ts>.md，最多保留 keep 版 */
export async function saveVersion(
  versionsRoot: string,
  docId: string,
  content: Buffer,
  keep = 20,
): Promise<string> {
  const dir = path.join(versionsRoot, docId);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}.md`);
  await fs.writeFile(file, content);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const sorted = entries.filter((n) => n.endsWith('.md')).sort();
  if (sorted.length > keep) {
    for (const name of sorted.slice(0, sorted.length - keep)) {
      await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }
  return file;
}

/** 递归确保目录存在 */
export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
