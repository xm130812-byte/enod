#!/usr/bin/env node
/**
 * 分词召回基线（PRD §9 / M7.5）：同一批查询分别打 Node 与 Rust，
 * 计算 Rust 对 Node 结果的召回率（低于 95% 不合并）。
 *
 * 用法：node scripts/recall.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sampleLibrary = path.join(repoRoot, 'sample-library');
const rustBin = process.env.MD_READER_CORE || path.join(os.homedir(), 'target', 'debug', 'md-reader-core');

async function waitFile(file, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error(`timeout ${file}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function start(kind, dataDir, lib) {
  const env = { ...process.env, READER_ROOT: lib, READER_NO_OPEN: '1' };
  const child =
    kind === 'node'
      ? spawn('node', ['packages/server/src/index.ts', '--data-dir', dataDir, '--port', '0'], {
          cwd: repoRoot,
          env,
          stdio: 'ignore',
        })
      : spawn(rustBin, ['--data-dir', dataDir, '--port', '0', '--no-open'], {
          cwd: repoRoot,
          env,
          stdio: 'ignore',
        });
  const run = await waitFile(path.join(dataDir, 'run.json'), 20000);
  return { child, base: `http://127.0.0.1:${run.port}` };
}

async function waitIndexed(base) {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${base}/api/v1/library/stats`);
      const stats = await res.json();
      if (!stats.scanning && stats.total > 0) return;
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('index timeout');
}

async function search(base, q) {
  const res = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(q)}&limit=20`);
  if (!res.ok) return [];
  const rows = await res.json();
  return rows.map((r) => r.id);
}

async function main() {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mdreader-recall-'));
  const nodeLib = path.join(work, 'node-lib');
  const rustLib = path.join(work, 'rust-lib');
  await fs.cp(sampleLibrary, nodeLib, { recursive: true });
  await fs.cp(sampleLibrary, rustLib, { recursive: true });
  const nodeData = path.join(work, 'node-data');
  const rustData = path.join(work, 'rust-data');
  await fs.mkdir(nodeData);
  await fs.mkdir(rustData);

  const node = await start('node', nodeData, nodeLib);
  const rust = await start('rust', rustData, rustLib);
  try {
    await Promise.all([waitIndexed(node.base), waitIndexed(rust.base)]);
    const docs = await (await fetch(`${node.base}/api/v1/docs?status=all&limit=5000`)).json();
    const queries = new Set();
    for (const d of docs) {
      if (d.title) queries.add(d.title);
      for (const t of d.tags ?? []) queries.add(t);
    }
    for (const q of [
      '持久战', 'SQLite', '分词', '索引', '设计', '阅读', '批注', '本地优先',
      'FTS5', 'WAL', '剪藏', '重构', '书单', '春夜', '零原生模块', '持久化',
      '中文检索', '数据库', '写作', '一页',
    ]) {
      queries.add(q);
    }
    let total = 0;
    let hit = 0;
    const failures = [];
    for (const q of queries) {
      const a = await search(node.base, q);
      const b = await search(rust.base, q);
      if (a.length === 0) continue;
      const bset = new Set(b);
      const common = a.filter((id) => bset.has(id)).length;
      const recall = common / a.length;
      total += 1;
      hit += recall;
      if (recall < 0.95) failures.push({ q, recall: Number(recall.toFixed(3)), node: a.length, rust: b.length });
    }
    const avg = total ? hit / total : 0;
    console.log(`queries=${total} averageRecall=${(avg * 100).toFixed(2)}%`);
    if (failures.length) {
      console.log('低于 95% 的查询：');
      for (const f of failures) console.log(`  ${f.q}: recall=${f.recall} node=${f.node} rust=${f.rust}`);
    }
    if (avg < 0.95) process.exitCode = 1;
  } finally {
    node.child.kill('SIGTERM');
    rust.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (process.env.KEEP_RECALL_TMP !== '1') await fs.rm(work, { recursive: true, force: true });
    else console.log(`临时目录：${work}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
