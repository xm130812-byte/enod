import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { ConfigStore } from '../src/core/config.ts';
import { dataPaths } from '../src/core/paths.ts';
import { IndexDB } from '../src/store/db.ts';
import { EventHub } from '../src/http/sse.ts';
import { LibraryService } from '../src/library/service.ts';
import {
  cleanMarkdown,
  cleanTitle,
  decodeHtml,
  extractArticle,
  sniffImageMime,
} from '../src/library/clip/extract.ts';
import { clipKey, isPrivateHost, normalizeClipUrl, parseClipUrl } from '../src/library/clip/url.ts';

const ARTICLE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>深入浅出 Markdown - 示例站</title>
  <meta property="og:site_name" content="示例站">
  <meta name="author" content="张三">
  <meta property="article:published_time" content="2026-01-02T08:00:00+08:00">
  <meta name="description" content="一篇关于 Markdown 的示例文章。">
  <link rel="canonical" href="https://example.com/posts/markdown?utm_source=feed">
</head>
<body>
  <nav>导航菜单</nav>
  <article>
    <h1>深入浅出 Markdown</h1>
    <p>这是第一段足够长的正文，用来测试 Readability 是否能够正常提取。它包含<strong>粗体</strong>、<a href="/about">相对链接</a>以及图片。</p>
    <p><img data-src="/images/cover.png" alt="封面">第二段继续补充内容，让正文长度超过阈值，避免被当成空页面。Lorem ipsum dolor sit amet.</p>
    <h2>代码</h2>
    <pre><code class="language-ts hljs">const answer: number = 42;</code></pre>
    <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
  </article>
  <footer>页脚</footer>
  <script>alert('xss')</script>
</body>
</html>`;

test('剪藏 URL 规范化与内网拦截', () => {
  const noScheme = normalizeClipUrl('example.com/a?utm_source=x#top');
  assert.equal(noScheme?.href, 'https://example.com/a?utm_source=x');
  assert.equal(noScheme?.key, 'https://example.com/a');
  assert.equal(clipKey('https://example.com/a/'), 'https://example.com/a');
  assert.equal(clipKey('https://example.com/a?utm_medium=x&id=1'), 'https://example.com/a?id=1');
  assert.equal(parseClipUrl('javascript:alert(1)'), null);
  assert.equal(parseClipUrl('file:///C:/a.html'), null);
  assert.equal(parseClipUrl('http://user:pass@example.com/'), null);
  assert.equal(parseClipUrl('127.0.0.1:8080'), null);
  assert.ok(parseClipUrl('127.0.0.1:8080', true));

  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('10.2.3.4'), true);
  assert.equal(isPrivateHost('172.20.0.1'), true);
  assert.equal(isPrivateHost('192.168.1.2'), true);
  assert.equal(isPrivateHost('169.254.169.254'), true);
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('fd00::1'), true);
  assert.equal(isPrivateHost('example.com'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
});

test('网页字符集探测：GBK 与 UTF-8', () => {
  const gbk = iconv.encode(
    '<html><head><meta charset="gbk"><title>中文标题</title></head><body>正文</body></html>',
    'gb18030',
  );
  assert.match(decodeHtml(gbk, 'text/html'), /中文标题/);

  const utf8 = Buffer.from('<html><head><meta charset="utf-8"><title>你好</title></head></html>', 'utf8');
  assert.match(decodeHtml(utf8, 'text/html; charset=utf-8'), /你好/);
});

test('Readability + Turndown：正文、链接、图片占位符与代码语言', () => {
  const article = extractArticle(ARTICLE, 'https://example.com/posts/markdown?utm_source=feed');
  assert.equal(article.title, '深入浅出 Markdown');
  assert.equal(article.site, '示例站');
  assert.equal(article.author, '张三');
  assert.match(article.published, /^2026-01-02/);
  assert.ok(article.canonicalUrl.includes('example.com/posts/markdown'));

  assert.ok(!article.markdown.includes('导航菜单'), 'nav 应被移除');
  assert.ok(!article.markdown.includes('页脚'), 'footer 应被移除');
  assert.ok(!article.markdown.includes('alert'), 'script 应被移除');
  assert.ok(!article.markdown.startsWith('# 深入浅出 Markdown'), '与标题重复的 H1 应移除');
  assert.ok(article.markdown.includes('[相对链接](https://example.com/about)'));
  assert.ok(article.markdown.includes('![封面](mr-image://0)'));
  assert.ok(article.markdown.includes('```ts'), '代码围栏应保留语言');
  assert.match(article.markdown, /\|\s*A\s*\|\s*B\s*\|/, '表格应转成 GFM');
  assert.equal(article.images.length, 1);
  assert.equal(article.images[0]!.url, 'https://example.com/images/cover.png');
});

test('标题清理与 Markdown 清理', () => {
  assert.equal(cleanTitle('深入浅出 Markdown - 示例站', '示例站', 'https://example.com/a'), '深入浅出 Markdown');
  assert.equal(cleanTitle('标题 | 示例站', '示例站', 'https://example.com/a'), '标题');
  assert.equal(cleanTitle('不同站点 - 别的站', '示例站', 'https://example.com/a'), '不同站点 - 别的站');
  assert.equal(
    cleanMarkdown('# 标题\n\n正文第一段\n\n\n\n正文第二段\n', '标题'),
    '正文第一段\n\n正文第二段\n',
  );
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
});

test('剪藏服务：写入 Inbox、图片本地化、去重与覆盖', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwH6ZQAAAABJRU5ErkJggg==',
    'base64',
  );
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/images/cover.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      res.end(png);
      return;
    }
    const port = (server.address() as { port: number }).port;
    const html = ARTICLE.replace(
      'https://example.com/posts/markdown?utm_source=feed',
      `http://127.0.0.1:${port}/posts/markdown?utm_source=feed`,
    )
      .replace('https://example.com/posts/markdown', `http://127.0.0.1:${port}/posts/markdown`)
      .replace('/about', `http://127.0.0.1:${port}/about`)
      .replace('/images/cover.png', `http://127.0.0.1:${port}/images/cover.png`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-clip-lib-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-reader-clip-data-'));
  const paths = dataPaths(dataDir);
  const config = new ConfigStore(paths);
  config.save({ libraryRoot: root });
  const db = new IndexDB(paths.dbFile);
  const hub = new EventHub();
  const service = new LibraryService(paths, config, db, hub);

  try {
    await service.init();
    const url = `http://127.0.0.1:${port}/posts/markdown`;
    const phases: string[] = [];
    const first = await service.clip({ url, allowPrivate: true }, (progress) => phases.push(progress.phase));
    assert.equal(first.doc.relPath, 'Inbox/深入浅出 Markdown.md');
    assert.equal(first.imageCount, 1);
    assert.ok(phases.includes('fetching') && phases.includes('saving'));

    const file = path.join(root, 'Inbox', '深入浅出 Markdown.md');
    const saved = await fs.readFile(file, 'utf8');
    assert.match(saved, /source:\n  url: "http:\/\/127\.0\.0\.1:/);
    assert.match(saved, /site: 示例站/);
    assert.match(saved, new RegExp(`assets/${first.doc.id}/[a-f0-9]{16}\\.png`));
    assert.ok(!saved.includes('mr-image://'), '占位符应全部替换');
    assert.ok(!saved.includes('导航菜单'));
    assert.ok(saved.includes('```ts'));

    const assetDir = path.join(root, 'assets', first.doc.id);
    const assets = await fs.readdir(assetDir);
    assert.equal(assets.length, 1);
    assert.deepEqual(await fs.readFile(path.join(assetDir, assets[0]!)), png);

    const again = await service.clip({ url, allowPrivate: true });
    assert.equal(again.duplicate?.id, first.doc.id);
    assert.equal(service.listDocs({}).length, 1);

    const skipped = await service.clip({ url, mode: 'skip', allowPrivate: true });
    assert.equal(skipped.skipped, true);

    const copy = await service.clip({ url, mode: 'new', allowPrivate: true });
    assert.notEqual(copy.doc.id, first.doc.id);
    assert.equal(service.listDocs({}).length, 2);

    const overwritten = await service.clip({ url, mode: 'overwrite', allowPrivate: true });
    assert.equal(overwritten.overwritten, true);
    assert.equal(overwritten.doc.id, first.doc.id);
    assert.equal(service.listDocs({}).length, 2);

    // 再抓一次不应产生新的图片目录或重复文件
    assert.ok(hits >= 4);
  } finally {
    await service.shutdown();
    hub.closeAll();
    server.close();
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
