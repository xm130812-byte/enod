#!/usr/bin/env node
/**
 * 双跑契约测试（PRD §4.11）：
 * 同一份书库副本，分别启动 Node 与 Rust 内核，顺序重放 fixtures，
 * 比对 status 与关键字段；忽略时间戳、端口、随机 id、mtime。
 *
 * 用法：node scripts/contract.mjs [--only name]
 *   MD_READER_CORE  Rust 二进制路径（默认 ~/target/debug/md-reader-core）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const fixturesDir = path.join(repoRoot, 'packages/core/tests/contract');
const sampleLibrary = path.join(repoRoot, 'sample-library');
const rustBin =
  process.env.MD_READER_CORE ||
  path.join(os.homedir(), 'target', 'debug', 'md-reader-core');

const only = (() => {
  const idx = process.argv.indexOf('--only');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

function log(msg) {
  console.log(msg);
}

async function waitFile(file, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting ${file}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function startServer(kind, dataDir, libraryRoot) {
  const env = {
    ...process.env,
    READER_ROOT: libraryRoot,
    READER_NO_OPEN: '1',
    READER_CLIP_ALLOW_PRIVATE: '1',
  };
  let child;
  if (kind === 'node') {
    child = spawn('node', ['packages/server/src/index.ts', '--data-dir', dataDir, '--port', '0'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(rustBin, ['--data-dir', dataDir, '--port', '0', '--no-open'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  let stderr = '';
  child.stderr.on('data', (b) => (stderr += b.toString()));
  child.stdout.on('data', () => {});
  const run = await waitFile(path.join(dataDir, 'run.json'), 20000).catch((err) => {
    throw new Error(`${kind} 启动失败: ${err.message}\n${stderr}`);
  });
  return { kind, child, port: run.port, base: `http://127.0.0.1:${run.port}`, stderr: () => stderr };
}

async function waitIndexed(server) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${server.base}/api/v1/library/stats`);
      if (res.ok) {
        const stats = await res.json();
        if (!stats.scanning && stats.total > 0) return;
      }
    } catch {
      /* not ready */
    }
    if (Date.now() - started > 40000) throw new Error(`${server.kind} 索引超时`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function request(server, fixture, vars) {
  let reqPath = await substituteString(fixture.request.path, server, vars);
  let body;
  if (fixture.request.body !== undefined) {
    body = await substituteValue(fixture.request.body, server, vars);
  }
  const headers = { 'X-Reader-Client': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${server.base}${reqPath}`, {
    method: fixture.request.method || 'GET',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function substituteString(str, server, vars) {
  let out = str;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(value));
  }
  const docRe = /\{\{doc:([^}]+)\}\}/g;
  let match;
  while ((match = docRe.exec(out))) {
    const relPath = match[1];
    const res = await fetch(`${server.base}/api/v1/docs?status=all&limit=20000`);
    const docs = await res.json();
    const doc = docs.find((d) => d.relPath === relPath);
    if (!doc) throw new Error(`找不到文档 ${relPath}`);
    out = out.replace(match[0], doc.id);
  }
  return out;
}

async function substituteValue(value, server, vars) {
  if (typeof value === 'string') return substituteString(value, server, vars);
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await substituteValue(item, server, vars));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await substituteValue(v, server, vars);
    return out;
  }
  return value;
}

function evalPath(root, expr) {
  let nodes = [root];
  const tokenRe = /(\.[A-Za-z0-9_]+|\[(\d+|\*)\])/g;
  let m;
  while ((m = tokenRe.exec(expr))) {
    const token = m[0];
    if (token.startsWith('.')) {
      const key = token.slice(1);
      nodes = nodes.map((n) => (n == null ? undefined : n[key])).filter((v) => v !== undefined);
    } else if (token === '[*]') {
      nodes = nodes.flatMap((n) => (Array.isArray(n) ? n : []));
    } else {
      const idx = Number(m[2]);
      nodes = nodes.map((n) => (Array.isArray(n) ? n[idx] : undefined)).filter((v) => v !== undefined);
    }
  }
  return nodes;
}

function canonical(value, sortValues) {
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v, sortValues));
    if (sortValues) items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return items;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key], sortValues);
    return out;
  }
  return value;
}

function compareFixture(fixture, nodeRes, rustRes, failures) {
  if (nodeRes.status !== rustRes.status) {
    failures.push(`status: node=${nodeRes.status} rust=${rustRes.status}`);
    return;
  }
  const paths = fixture.compare || [];
  for (const expr of paths) {
    const a = canonical(evalPath(nodeRes.json, expr), fixture.sortValues);
    const b = canonical(evalPath(rustRes.json, expr), fixture.sortValues);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      failures.push(
        `${expr}\n      node: ${JSON.stringify(a).slice(0, 400)}\n      rust: ${JSON.stringify(b).slice(0, 400)}`,
      );
    }
  }
}

async function main() {
  const fixtureFiles = (await fs.readdir(fixturesDir))
    .filter((f) => f.endsWith('.json'))
    .sort();
  const fixtures = [];
  for (const file of fixtureFiles) {
    const fixture = JSON.parse(await fs.readFile(path.join(fixturesDir, file), 'utf8'));
    if (only && fixture.name !== only) continue;
    fixtures.push(fixture);
  }
  if (fixtures.length === 0) {
    console.error('没有匹配的 fixture');
    process.exit(2);
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mdreader-contract-'));
  const nodeLib = path.join(work, 'node-library');
  const rustLib = path.join(work, 'rust-library');
  await fs.cp(sampleLibrary, nodeLib, { recursive: true });
  await fs.cp(sampleLibrary, rustLib, { recursive: true });
  const nodeData = path.join(work, 'node-data');
  const rustData = path.join(work, 'rust-data');
  await fs.mkdir(nodeData, { recursive: true });
  await fs.mkdir(rustData, { recursive: true });

  const nodeServer = await startServer('node', nodeData, nodeLib);
  const rustServer = await startServer('rust', rustData, rustLib);
  log(`node ${nodeServer.base} | rust ${rustServer.base}`);
  try {
    await Promise.all([waitIndexed(nodeServer), waitIndexed(rustServer)]);
    const vars = { node: {}, rust: {} };
    let failed = 0;
    for (const fixture of fixtures) {
      const nodeRes = await request(nodeServer, fixture, vars.node);
      const rustRes = await request(rustServer, fixture, vars.rust);
      const failures = [];
      compareFixture(fixture, nodeRes, rustRes, failures);
      if (fixture.capture) {
        for (const [key, expr] of Object.entries(fixture.capture)) {
          const nodeValue = evalPath(nodeRes.json, expr)[0];
          const rustValue = evalPath(rustRes.json, expr)[0];
          vars.node[key] = nodeValue;
          vars.rust[key] = rustValue;
        }
      }
      if (failures.length === 0) {
        log(`  ok   ${fixture.name}`);
      } else {
        failed++;
        log(`  FAIL ${fixture.name}`);
        for (const f of failures) log(`      ${f}`);
      }
    }
    log(`\n${fixtures.length - failed}/${fixtures.length} passed`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    for (const server of [nodeServer, rustServer]) {
      server.child.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 300));
    if (process.env.KEEP_CONTRACT_TMP !== '1') {
      await fs.rm(work, { recursive: true, force: true });
    } else {
      log(`临时目录保留：${work}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
