#!/usr/bin/env node
/**
 * 冷启动索引与搜索基准：生成 N 篇中文文档，起一个独立守护进程，测全量索引与检索延迟。
 * 用法：node scripts/bench.mjs [N]
 * 只写 .devdata/bench-*，不影响你的书库。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const count = Number(process.argv[2] ?? 3000);
const benchRoot = path.join(root, '.devdata', 'bench-lib');
const benchData = path.join(root, '.devdata', 'bench-data');
const serverEntry = path.join(root, 'packages/server/src/index.ts');

const SENTENCES = [
  '我们常说，决定战争胜负的是人不是物，这是历史唯物主义的观点。',
  '中文检索的难点在于分词边界：unicode61 不认识中文词。',
  '索引是一次性的成本，增量更新才是日常开销。',
  '持久战的关键在相持阶段，产品也一样。',
  '本地优先意味着断网仍然可读，数据不会被困在服务端。',
  '批注必须能落回原文，否则划线就失去了意义。',
  'Markdown 文件就是数据库，frontmatter 里放着元数据。',
  '双向链接让文档之间形成网络，而不是一堆孤岛。',
  '原子写保证断电之后不会留下半截文件。',
  '搜索的响应时间决定了你会不会真的去用它。',
  '重构之前先测量，结构更清晰不是性能证据。',
  '组织能力是稀缺品，比装备清单重要得多。',
  '版本快照放在应用数据目录，不参与同步。',
  '渲染一篇五万字的文章，不该让人等超过一百五十毫秒。',
  '标签是轻量的分类，目录是重的分类，两者都要有。',
  '文件监听要能处理编辑器保存时的临时文件。',
];

function makeBody(index) {
  const parts = [];
  const paragraphs = 4 + (index % 4);
  for (let p = 0; p < paragraphs; p++) {
    const pick = (index * 7 + p * 3) % SENTENCES.length;
    parts.push(SENTENCES[pick] + SENTENCES[(pick + 5) % SENTENCES.length] + SENTENCES[(pick + 9) % SENTENCES.length]);
  }
  return parts.join('\n\n');
}

async function generate() {
  await fs.rm(benchRoot, { recursive: true, force: true });
  const dirCount = 30;
  for (let d = 0; d < dirCount; d++) {
    await fs.mkdir(path.join(benchRoot, `topic-${String(d).padStart(2, '0')}`), { recursive: true });
  }
  const started = Date.now();
  const writes = [];
  for (let i = 0; i < count; i++) {
    const dir = `topic-${String(i % dirCount).padStart(2, '0')}`;
    const title = `测试文档 ${String(i + 1).padStart(4, '0')} · ${['持久战', '索引', '检索', '重构', '本地优先'][i % 5]}`;
    const content = `---
title: ${title}
tags: [${['历史', '工程', '产品', '搜索'][i % 4]}, 批量]
reader:
  id: 01M6BENCH${String(i).padStart(16, '0')}
  status: ${['unread', 'reading', 'done'][i % 3]}
  progress: ${((i % 10) / 10).toFixed(1)}
  annotations: []
---

# ${title}

${makeBody(i)}

## 小结

${SENTENCES[(i * 3) % SENTENCES.length]}
`;
    writes.push(fs.writeFile(path.join(benchRoot, dir, `${String(i + 1).padStart(4, '0')}.md`), content, 'utf8'));
    if (writes.length >= 200) {
      await Promise.all(writes.splice(0));
    }
  }
  await Promise.all(writes);
  return Date.now() - started;
}

async function readRun(portFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(portFile, 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('server did not start');
}

async function main() {
  console.log(`生成 ${count} 篇文档…`);
  const genMs = await generate();
  console.log(`生成完成：${genMs}ms`);

  await fs.rm(benchData, { recursive: true, force: true });
  await fs.mkdir(benchData, { recursive: true });
  const child = spawn(process.execPath, [serverEntry, '--no-open', '--port', '0', '--data-dir', benchData], {
    env: { ...process.env, READER_ROOT: benchRoot, READER_DATA_DIR: benchData, NODE_NO_WARNINGS: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    const run = await readRun(path.join(benchData, 'run.json'), 20000);
    const base = `http://127.0.0.1:${run.port}/api/v1`;
    const started = Date.now();
    let lib = null;
    while (Date.now() - started < 120000) {
      lib = await (await fetch(`${base}/library`)).json();
      if (!lib.stats.scanning && lib.stats.total === count) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(`冷启动索引：${lib.stats.lastScan?.durationMs ?? '?'}ms（${lib.stats.total} 篇，${((Date.now() - started) / 1000).toFixed(1)}s 含等待）`);

    const queries = ['持久战', '中文检索', '索引', '本地优先', '重构 测量', 'SQLite', '组织能力', '批注', 'Markdown', '搜索响应'];
    const timings = [];
    for (let round = 0; round < 4; round++) {
      for (const q of queries) {
        const t0 = performance.now();
        const hits = await (await fetch(`${base}/search?q=${encodeURIComponent(q)}&limit=20`)).json();
        timings.push(performance.now() - t0);
        if (round === 0) console.log(`  ${q}: ${hits.length} 条`);
      }
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.floor(timings.length * 0.5)];
    const p95 = timings[Math.floor(timings.length * 0.95)];
    console.log(`搜索 ${timings.length} 次：p50 ${p50.toFixed(1)}ms，p95 ${p95.toFixed(1)}ms`);

    const docsT0 = performance.now();
    const docs = await (await fetch(`${base}/docs`)).json();
    console.log(`/docs 列表：${docs.length} 篇，${(performance.now() - docsT0).toFixed(0)}ms`);

    const tagStats = await (await fetch(`${base}/tags`)).json();
    console.log(`标签：${tagStats.length} 个`);
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    if (!child.killed) child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
