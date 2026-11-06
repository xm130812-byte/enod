#!/usr/bin/env node
/**
 * 生成转换金标准快照（PRD §4.3 / §4.20）：
 * 用 Node 版适配层对 sample-library 里的非 md 文件产出 markdown，写入
 * packages/core/tests/golden/<kind>-<slug>.json，供 Rust 侧逐字比对。
 *
 * 用法：node scripts/golden.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { convertToMarkdown, kindOf } from '../packages/server/src/library/adapt.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sampleLibrary = path.join(repoRoot, 'sample-library');
const outDir = path.join(repoRoot, 'packages/core/tests/golden');

async function walk(dir, out = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'assets' || entry.name === 'node_modules') continue;
      await walk(abs, out);
    } else {
      out.push(abs);
    }
  }
  return out;
}

function slugify(rel) {
  return rel
    .replace(/[\\/]/g, '-')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-');
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  // 在临时副本上转换，避免 Node 版把图片写进 sample-library
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mdreader-golden-'));
  const lib = path.join(work, 'lib');
  await fs.cp(sampleLibrary, lib, { recursive: true });

  const files = await walk(lib);
  const docs = [];
  for (const abs of files) {
    const rel = path.relative(lib, abs).split(path.sep).join('/');
    const kind = kindOf(rel);
    if (!kind || kind === 'md') continue;
    docs.push({ abs, rel, kind });
  }
  docs.sort((a, b) => a.rel.localeCompare(b.rel));
  console.log(`converting ${docs.length} files`);

  for (const doc of docs) {
    const buffer = await fs.readFile(doc.abs);
    const derived = await convertToMarkdown(buffer, doc.abs, doc.rel, doc.kind, lib);
    const snapshot = {
      source: doc.rel,
      kind: doc.kind,
      title: derived.title,
      warnings: derived.warnings,
      markdown: derived.markdown,
    };
    const name = `${doc.kind}-${slugify(doc.rel)}.json`;
    await fs.writeFile(path.join(outDir, name), JSON.stringify(snapshot, null, 2), 'utf8');
    console.log(`  ${name} (${derived.markdown.length} chars)`);
  }
  await fs.rm(work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
