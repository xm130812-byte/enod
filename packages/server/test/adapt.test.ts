import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { convertToMarkdown, derivedDocId, htmlTablesToMarkdown, isEditable, kindOf, stripDocExt } from '../src/library/adapt.ts';

test('格式识别与扩展名剥离', () => {
  assert.equal(kindOf('a/b.md'), 'md');
  assert.equal(kindOf('a/b.html'), 'html');
  assert.equal(kindOf('a/b.HTM'), 'html');
  assert.equal(kindOf('a/b.txt'), 'txt');
  assert.equal(kindOf('a/b.png'), null);
  assert.equal(kindOf('没有扩展名'), null);

  assert.equal(isEditable('md'), true);
  assert.equal(isEditable('txt'), false);
  assert.equal(isEditable('html'), false);

  assert.equal(stripDocExt('读书笔记.md'), '读书笔记');
  assert.equal(stripDocExt('页面.html'), '页面');
  assert.equal(stripDocExt('a.b.txt'), 'a.b');
  assert.equal(stripDocExt('文件名没有扩展名'), '文件名没有扩展名');
});

test('非 md 文档的 id 由路径派生且稳定', () => {
  const a = derivedDocId('web/a.html');
  assert.equal(a, derivedDocId('web/a.html'));
  assert.notEqual(a, derivedDocId('web/b.html'));
  assert.equal(a.length, 26, '与 ULID 等长，便于复用同一套 id 处理');
});

test('纯文本：空行分段、单换行保留为硬换行、代码围栏内不动', async () => {
  const body = '第一行\n第二行\n\n新段落\n```\n代码行\n```\n';
  const buf = Buffer.from(body, 'utf8');
  const out = await convertToMarkdown(buf, '/tmp/x.txt', 'x.txt', 'txt', '/tmp');
  const lines = out.markdown.split('\n');
  assert.equal(lines[0], '第一行  ');
  assert.equal(lines[1], '第二行  ');
  assert.equal(lines[2], '');
  assert.equal(lines[3], '新段落  ');
  assert.equal(lines[4], '```');
  assert.equal(lines[5], '代码行', '围栏内不追加尾随空格');
});

test('纯文本：GB18030 + CRLF 正常解码', async () => {
  const text = '中文标题\r\n\r\n第二段内容\r\n';
  const buf = iconv.encode(text, 'gb18030');
  const out = await convertToMarkdown(buf, '/tmp/g.txt', 'g.txt', 'txt', '/tmp');
  assert.match(out.markdown, /中文标题/);
  assert.ok(!out.markdown.includes('\r'), 'CRLF 统一成 LF');
});

test('纯文本：超长正文被截断并给出警告', async () => {
  const buf = Buffer.from('字'.repeat(500_010), 'utf8');
  const out = await convertToMarkdown(buf, '/tmp/big.txt', 'big.txt', 'txt', '/tmp');
  assert.ok(out.markdown.length < 500_100);
  assert.ok(out.warnings.some((w) => w.includes('只显示前')));
});

test('SQL：整篇包进 sql 围栏，并要求扫描围栏内的双链', async () => {
  const sql = '-- 见 [[本地优先]]\nCREATE TABLE t (id INTEGER);\n';
  const out = await convertToMarkdown(Buffer.from(sql, 'utf8'), '/tmp/a.sql', 'a.sql', 'sql', '/tmp');
  assert.ok(out.markdown.startsWith('```sql\n'));
  assert.ok(out.markdown.trimEnd().endsWith('```'));
  assert.ok(out.markdown.includes('[[本地优先]]'));
  assert.equal(out.scanLinksInCode, true, '代码型文档要跳过 stripFencedCode 才能扫到注释里的链接');
});

test('SQL：内容本身含 ``` 时自动加长围栏', async () => {
  const sql = 'SELECT "```" AS s;\n';
  const out = await convertToMarkdown(Buffer.from(sql, 'utf8'), '/tmp/b.sql', 'b.sql', 'sql', '/tmp');
  assert.ok(out.markdown.startsWith('````sql\n'), '围栏要长过内容里最长的反引号序列');
});

test('docx 表格：mammoth 的 <td><p> 结构转成 GFM 表格', () => {
  const html = '<table><tr><td><p>季度</p></td><td><p>耗时</p></td></tr>' +
    '<tr><td><p>Q1</p></td><td><p>38.2s</p></td></tr></table>';
  const md = htmlTablesToMarkdown(html);
  assert.match(md, /\| 季度 \| 耗时 \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| Q1 \| 38\.2s \|/);
});

test('docx 表格：单元格里的竖线被转义，链接保留', () => {
  const html = '<table><tr><td>a|b</td><td><a href="https://x.test">链接</a></td></tr></table>';
  const md = htmlTablesToMarkdown(html);
  assert.match(md, /a\\\|b/);
  assert.match(md, /\[链接\]\(https:\/\/x\.test\)/);
});

test('HTML：本地文件转换出标题与正文，图片走库内相对路径', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-adapt-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwH6ZQAAAABJRU5ErkJggg==',
    'base64',
  );
  await fs.writeFile(path.join(dir, 'pic.png'), png);
  const html = `<!doctype html><html><head><title>示例页 - 站点</title></head><body><article>
    <h1>示例页</h1>
    <p>这是一段足够长的正文，用来让 Readability 判定为文章主体，而不是导航或广告区块。</p>
    <p><img src="pic.png" alt="配图"> 第二段继续补充一些内容，确保正文长度超过阈值。</p>
  </article></body></html>`;
  const file = path.join(dir, 'page.html');
  await fs.writeFile(file, html, 'utf8');

  const out = await convertToMarkdown(Buffer.from(html, 'utf8'), file, 'page.html', 'html', dir);
  // 没有 og:site_name 时，"示例页 - 站点" 的后缀不会被剥掉，这是预期行为
  assert.match(out.title, /^示例页/);
  assert.ok(out.markdown.includes('示例页'));
  // 库内的本地图片直接按库内相对路径引用，交给 /api/v1/files 提供
  assert.match(out.markdown, /!\[配图\]\(pic\.png\)/);
  assert.ok(await fs.readFile(path.join(dir, 'pic.png')).then(() => true), '原图片文件保持不变');

  await fs.rm(dir, { recursive: true, force: true });
});
