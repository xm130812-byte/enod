#!/usr/bin/env node
/**
 * M9 编辑流程验收：txt / sql 原编码原 EOL 写回；docx 批注落 sidecar。
 * 用法：node scripts/edit-flow.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repo = path.resolve(import.meta.dirname, '..');
const bin = process.env.MD_READER_CORE || path.join(os.homedir(), 'target', 'debug', 'md-reader-core');

async function waitFile(file, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      if (Date.now() - start > timeout) throw new Error(`timeout ${file}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function req(base, pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'X-Reader-Client': '1', 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mdreader-edit-'));
const lib = path.join(work, 'lib');
const data = path.join(work, 'data');
await fs.cp(path.join(repo, 'sample-library'), lib, { recursive: true });
await fs.mkdir(data);
const child = spawn(bin, ['--data-dir', data, '--port', '0', '--no-open'], {
  env: { ...process.env, READER_ROOT: lib, READER_NO_OPEN: '1' },
  stdio: 'ignore',
});
const run = await waitFile(path.join(data, 'run.json'));
const base = `http://127.0.0.1:${run.port}`;
for (let i = 0; i < 200; i++) {
  const stats = (await req(base, '/api/v1/library/stats')).body;
  if (!stats.scanning && stats.total > 0) break;
  await new Promise((r) => setTimeout(r, 150));
}

let failed = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${msg}`);
  if (!ok) failed++;
};

try {
  const docs = (await req(base, '/api/v1/docs?status=all&limit=5000')).body;
  const byPath = (p) => docs.find((d) => d.relPath === p);

  // txt：GB18030 + CRLF
  const txtRow = byPath('notes/GBK编码测试.txt');
  check(Boolean(txtRow), 'txt 出现在书库');
  const txtDoc = (await req(base, `/api/v1/docs/${txtRow.id}`)).body;
  check(txtDoc.body.includes('\r\n'), 'txt 正文保留 CRLF');
  check(txtDoc.encoding === 'gb18030', `txt 编码探测 = ${txtDoc.encoding}`);
  const txtPath = path.join(lib, txtRow.relPath);
  const before = await fs.readFile(txtPath);
  const appended = `${txtDoc.body}追加一行\r\n`;
  const saved = await req(base, `/api/v1/docs/${txtRow.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: appended, baseHash: txtDoc.rawHash }),
  });
  check(saved.status === 200, 'txt 保存返回 200');
  const after = await fs.readFile(txtPath);
  check(after.length > before.length, 'txt 文件已写回');
  const gbkTail = Buffer.from([0xd7, 0xb7, 0xbc, 0xd3]); // “追加” 的 GB18030
  check(after.includes(gbkTail), 'txt 仍按 GB18030 编码（不是 UTF-8）');
  check(after.includes(Buffer.from('\r\n', 'ascii')), 'txt 仍保留 CRLF');
  check(!after.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'txt 没有被加 BOM/改写');

  // sql：不应出现 frontmatter
  const sqlRow = byPath('tech/schema.sql');
  const sqlDoc = (await req(base, `/api/v1/docs/${sqlRow.id}`)).body;
  check(sqlDoc.body.includes('CREATE TABLE'), 'sql 正文是原始 SQL');
  const sqlPath = path.join(lib, sqlRow.relPath);
  const sqlSaved = await req(base, `/api/v1/docs/${sqlRow.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: `${sqlDoc.body}\n-- 编辑测试\n`, baseHash: sqlDoc.rawHash }),
  });
  check(sqlSaved.status === 200, 'sql 保存返回 200');
  const sqlAfter = (await fs.readFile(sqlPath)).toString('utf8');
  check(sqlAfter.includes('-- 编辑测试'), 'sql 写回成功');
  check(!sqlAfter.startsWith('---'), 'sql 没有被写入 frontmatter');

  // docx：批注写 sidecar
  const docxRow = byPath('docs/2026-Q3-季度回顾.docx');
  const ann = await req(base, `/api/v1/docs/${docxRow.id}/annotations`, {
    method: 'POST',
    body: JSON.stringify({ exact: '2026 年第三季度回顾', note: 'sidecar 测试', color: 'green' }),
  });
  check(ann.status === 200 && ann.body?.count === 1, 'docx 批注创建成功');
  const sidecar = path.join(lib, `${docxRow.relPath.replace(/\//g, path.sep)}.reader.json`);
  const sidecarExists = await fs.stat(sidecar).then(() => true).catch(() => false);
  check(sidecarExists, 'docx sidecar 已生成');
  if (sidecarExists) {
    const sc = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    check(sc.annotations?.[0]?.note === 'sidecar 测试', 'sidecar 记录批注');
    check(sc.id === docxRow.id, 'sidecar 记录稳定 id');
  }
  const docxDoc = (await req(base, `/api/v1/docs/${docxRow.id}`)).body;
  check(docxDoc.annotations.length === 1, 'docx 重新打开带出批注');

  // docx 只读正文
  const patchDocx = await req(base, `/api/v1/docs/${docxRow.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body: '改正文' }),
  });
  check(patchDocx.status === 405, 'docx 正文编辑被拒绝（405）');

  // compat 端点
  const compatTxt = (await req(base, `/api/v1/docs/${txtRow.id}/compat`)).body;
  check(compatTxt.editable === true, 'compat: txt editable');
  const compatDocx = (await req(base, `/api/v1/docs/${docxRow.id}/compat`)).body;
  check(compatDocx.editable === false && compatDocx.canConvertToMd === true, 'compat: docx 只读可转 md');
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (process.env.KEEP_EDIT_TMP !== '1') await fs.rm(work, { recursive: true, force: true });
  else console.log(`临时目录：${work}`);
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
if (failed) process.exitCode = 1;
