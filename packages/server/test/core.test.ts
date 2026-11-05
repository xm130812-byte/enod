import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { decodeFile, encodeFile, detectEncoding, detectEol, applyEol } from '../src/core/encoding.ts';
import {
  applyDocumentEdits,
  buildFrontmatter,
  FrontmatterEditor,
  parseLayout,
  readReaderMeta,
  readTags,
} from '../src/core/frontmatter.ts';
import { extractHeadings, extractWikiLinks, countWords, stripMarkdown } from '../src/core/markdown.ts';
import { buildMatchQuery, cjkBigrams, ftsTokenString, segmentWords } from '../src/core/tokenizer.ts';
import { ulid } from '../src/core/ulid.ts';
import { IndexDB } from '../src/store/db.ts';
import { LibraryIndexer } from '../src/library/indexer.ts';
import { parseDocBuffer } from '../src/library/parse.ts';

const SAMPLE = `---
title: 论持久战
tags: [历史, 战略]
# 作者自己写的注释
reader:
  id: 01JABC3XYZ
  status: reading   # 正在读
  annotations: []
---
正文第一行
第二行
`;

test('ULID 格式与单调递增', () => {
  const a = ulid(1700000000000);
  const b = ulid(1700000000000);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(a.length, 26);
  assert.ok(b > a, '同一毫秒内应递增');
});

test('parseLayout 正确切出 frontmatter 与正文', () => {
  const layout = parseLayout(SAMPLE);
  assert.equal(layout.hasFrontmatter, true);
  assert.equal(layout.frontmatter?.title, '论持久战');
  assert.deepEqual(readTags(layout.frontmatter), ['历史', '战略']);
  assert.equal(layout.body, '正文第一行\n第二行\n');
  assert.equal(layout.text.slice(layout.bodyOffset), layout.body);
  assert.equal(readReaderMeta(layout.frontmatter, 'x').id, '01JABC3XYZ');
});

test('没有 frontmatter 的文件不会被误判', () => {
  const layout = parseLayout('# 标题\n\n正文');
  assert.equal(layout.hasFrontmatter, false);
  assert.equal(layout.body, '# 标题\n\n正文');
  assert.equal(layout.bodyOffset, 0);
});

test('FrontmatterEditor 只改目标行，保留注释与键序', () => {
  const layout = parseLayout(SAMPLE);
  const editor = FrontmatterEditor.fromLayout(layout);
  editor.setScalar(['reader', 'status'], 'done');
  const yaml = editor.render();
  assert.match(yaml, /title: 论持久战/);
  assert.match(yaml, /# 作者自己写的注释/);
  assert.match(yaml, /status: done/);
  assert.match(yaml, /# 正在读/);
  assert.match(yaml, /id: 01JABC3XYZ/);
  const reparsed = parseLayout(`---\n${yaml}---\n`);
  assert.equal(readReaderMeta(reparsed.frontmatter, 'x').status, 'done');
});

test('FrontmatterEditor 写批注列表并可回读（含引号/换行/中文）', () => {
  const layout = parseLayout(SAMPLE);
  const editor = FrontmatterEditor.fromLayout(layout);
  const annotations = [
    {
      id: '01JANN1',
      exact: '决定战争胜负的是人不是物',
      prefix: '我们常说，',
      suffix: '，这是历史唯物主义。',
      pos: 12840,
      color: 'yellow',
      note: '和第四节呼应。含 "引号" 和\n换行',
      created: '2026-11-06T01:02:00+08:00',
    },
    {
      id: '01JANN2',
      exact: '第二处',
      prefix: '',
      suffix: '',
      pos: 20,
      color: 'blue',
      note: '',
      created: '2026-11-06T01:03:00+08:00',
    },
  ];
  editor.setList(['reader', 'annotations'], annotations);
  const yaml = editor.render();
  const reparsed = parseLayout(`---\n${yaml}---\n`);
  const meta = readReaderMeta(reparsed.frontmatter, 'x');
  assert.equal(meta.annotations.length, 2);
  assert.equal(meta.annotations[0]!.exact, '决定战争胜负的是人不是物');
  assert.equal(meta.annotations[0]!.note, '和第四节呼应。含 "引号" 和\n换行');
  assert.equal(meta.annotations[0]!.pos, 12840);
  assert.equal(meta.annotations[1]!.color, 'blue');
});

test('FrontmatterEditor 清空批注写内联数组', () => {
  const layout = parseLayout(SAMPLE);
  const editor = FrontmatterEditor.fromLayout(layout);
  editor.setList(['reader', 'annotations'], []);
  const yaml = editor.render();
  assert.match(yaml, /annotations: \[\]/);
});

test('缺少 reader 块时会自动补全到 frontmatter 末尾', () => {
  const text = '---\ntitle: 测试\n---\n正文';
  const layout = parseLayout(text);
  const editor = FrontmatterEditor.fromLayout(layout);
  editor.setScalar(['reader', 'status'], 'reading');
  editor.setScalar(['reader', 'id'], '01JTEST');
  const yaml = editor.render();
  const reparsed = parseLayout(`---\n${yaml}---\n`);
  assert.equal(readReaderMeta(reparsed.frontmatter, 'x').status, 'reading');
  assert.equal(readReaderMeta(reparsed.frontmatter, 'x').id, '01JTEST');
});

test('applyDocumentEdits 换正文不会动 frontmatter 的其它行', () => {
  const layout = parseLayout(SAMPLE);
  const out = applyDocumentEdits(layout, { body: '新的正文\n第二段\n' });
  assert.match(out, /title: 论持久战/);
  assert.match(out, /# 作者自己写的注释/);
  assert.ok(out.endsWith('新的正文\n第二段\n'));
  assert.ok(out.includes('id: 01JABC3XYZ'));
});

test('applyDocumentEdits 同时改状态与正文', () => {
  const layout = parseLayout(SAMPLE);
  const out = applyDocumentEdits(layout, { body: 'x', reader: { status: 'done', progress: 0.42 } });
  const reparsed = parseLayout(out);
  const meta = readReaderMeta(reparsed.frontmatter, 'x');
  assert.equal(meta.status, 'done');
  assert.equal(meta.progress, 0.42);
  assert.equal(reparsed.body, 'x');
});

test('没有 frontmatter 的文件保存时自动补 frontmatter', () => {
  const layout = parseLayout('# 旧文章\n\n内容\n');
  const out = applyDocumentEdits(layout, { body: '# 旧文章\n\n新内容\n', reader: { id: '01JNEW' } });
  const reparsed = parseLayout(out);
  assert.equal(reparsed.hasFrontmatter, true);
  assert.equal(readReaderMeta(reparsed.frontmatter, 'x').id, '01JNEW');
  assert.equal(reparsed.body, '# 旧文章\n\n新内容\n');
});

test('GB18030 + CRLF 读入写出字节保真', () => {
  const text = '# 标题\r\n\r\n这是 GBK 中文，包含标点。\r\n第二行\r\n';
  const buffer = iconv.encode(text, 'gb18030');
  const decoded = decodeFile(buffer);
  assert.equal(decoded.encoding, 'gb18030');
  assert.equal(decoded.eol, '\r\n');
  assert.equal(decoded.text, text);
  const encoded = encodeFile(decoded.text, decoded.encoding);
  assert.deepEqual(encoded, buffer);
});

test('UTF-8 BOM 与 UTF-16LE 保留 BOM', () => {
  const text = '你好\n世界\n';
  const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  assert.equal(detectEncoding(bom8), 'utf8-bom');
  assert.deepEqual(encodeFile(decodeFile(bom8).text, 'utf8-bom'), bom8);

  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(text, 'utf16-le')]);
  const decoded16 = decodeFile(u16);
  assert.equal(decoded16.encoding, 'utf16le');
  assert.equal(decoded16.text, text);
  assert.deepEqual(encodeFile(decoded16.text, 'utf16le'), u16);
});

test('EOL 检测与统一', () => {
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
  assert.equal(detectEol('a\nb\r\n'), '\n');
  assert.equal(applyEol('a\nb\r\nc', '\r\n'), 'a\r\nb\r\nc');
});

test('wiki 链接解析（显示文本 / 锚点 / 空目标）', () => {
  const links = extractWikiLinks('前 [[论持久战|持久战]] 中 [[战略#第三节]] 后 [[ ]] [[a|b|c]]');
  assert.equal(links.length, 2);
  assert.equal(links[0]!.target, '论持久战');
  assert.equal(links[0]!.display, '持久战');
  assert.equal(links[1]!.target, '战略');
  assert.equal(links[1]!.anchor, '第三节');
});

test('标题提取与 slug', () => {
  const headings = extractHeadings('# 一\n\n```\n# 代码里的假标题\n```\n\n## 中文标题\n## 中文标题\n');
  assert.equal(headings.length, 3);
  assert.equal(headings[0]!.text, '一');
  assert.ok(!headings.some((h) => h.text === '代码里的假标题'), '围栏内不是标题');
  assert.equal(headings[1]!.slug, '中文标题');
  assert.equal(headings[2]!.slug, '中文标题-2', '重复标题要加后缀');
});

test('中文字数与摘要', () => {
  assert.equal(countWords('中文四字 test two'), 6);
  assert.ok(stripMarkdown('**粗** 和 [链接](http://a)').includes('粗'));
});

test('分词与 FTS 查询构造', () => {
  const tokens = segmentWords('中文分词与 FTS5 检索');
  assert.ok(tokens.includes('中文'));
  assert.ok(ftsTokenString('中文分词').length > 0);
  const match = buildMatchQuery('中文 分词');
  assert.ok(match?.includes('"中文"'));
  assert.ok(cjkBigrams('中文分词').includes('文分'));
});

test('索引器：扫描、中文检索、反链、断链', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-test-'));
  const dbFile = path.join(root, 'index.db');
  const docsDir = path.join(root, 'books');
  await fs.mkdir(docsDir, { recursive: true });

  const idA = ulid();
  const idB = ulid();
  await fs.writeFile(
    path.join(docsDir, 'a.md'),
    `---\ntitle: 论持久战\ntags: [历史]\nreader:\n  id: ${idA}\n  status: reading\n  annotations: []\n---\n\n决定战争胜负的是人不是物。\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(docsDir, 'b.md'),
    `---\ntitle: 读书笔记\nreader:\n  id: ${idB}\n---\n\n我读了 [[论持久战]]，也链接了 [[不存在的文档]]。\n`,
    'utf8',
  );

  const db = new IndexDB(dbFile);
  const indexer = new LibraryIndexer(path.join(root), db);
  const result = await indexer.scanAll();
  assert.equal(result.total, 2);
  assert.equal(result.indexed, 2);

  const hits = db.search('持久战');
  assert.ok(hits.some((h) => h.doc.title === '论持久战'), '中文标题应能命中');

  const bodyHits = db.search('战争胜负');
  assert.ok(bodyHits.some((h) => h.doc.id === idA), '中文正文应能命中');

  const backlinks = db.backlinksFor(idA);
  assert.equal(backlinks.length, 1);
  assert.equal(backlinks[0]!.srcTitle, '读书笔记');

  const broken = db.brokenLinks();
  assert.equal(broken.length, 1);
  assert.equal(broken[0]!.dstRaw, '不存在的文档');

  const stats = db.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus.reading, 1);

  const parsed = parseDocBuffer('books/a.md', await fs.readFile(path.join(docsDir, 'a.md')), Date.now(), 10);
  assert.equal(parsed.title, '论持久战');
  assert.equal(parsed.links.length, 0);

  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('buildFrontmatter 生成可解析的最小 frontmatter', () => {
  const text = buildFrontmatter({ title: '新文章', id: '01JNEWDOC', tags: ['a'] });
  const layout = parseLayout(text);
  assert.equal(layout.hasFrontmatter, true);
  assert.equal(layout.frontmatter?.title, '新文章');
  assert.equal(readReaderMeta(layout.frontmatter, 'x').id, '01JNEWDOC');
});
