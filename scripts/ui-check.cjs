#!/usr/bin/env node
/**
 * 浏览器 UI 冒烟（Playwright，可选依赖）：
 *  - 桌面 1280x900：书架 → md 阅读 → 编辑自动保存；txt 原样渲染 + 编辑
 *  - 移动 390x844：单栏书架 / 阅读页，侧栏隐藏
 *  - 收集 console error / pageerror
 *
 * 用法：
 *   PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright node scripts/ui-check.cjs
 *   CDP_URL=http://127.0.0.1:9222 ...（复用已有 Chrome）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');

const playwrightPath = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(playwrightPath);

const repo = path.resolve(__dirname, '..');
const bin = process.env.READER_BIN || path.join(os.homedir(), 'target', 'debug', 'md-reader-core');
const shots = path.join(repo, 'docs', 'screenshots');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

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

async function api(base, pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { 'X-Reader-Client': '1', 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

(async () => {
  await fs.mkdir(shots, { recursive: true });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mdreader-ui-'));
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
    const stats = await api(base, '/api/v1/library/stats');
    if (!stats.scanning && stats.total > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const docs = await api(base, '/api/v1/docs?status=all&limit=5000');
  const byPath = (p) => docs.find((d) => d.relPath === p);
  const md = byPath('tech/SQLite FTS5 中文检索.md');
  const txt = byPath('notes/纯文本示例.txt');
  const docx = byPath('docs/2026-Q3-季度回顾.docx');

  const cdp = process.env.CDP_URL;
  const browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch({ headless: true });
  const errors = [];

  try {
    const ctx = cdp ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try {
        localStorage.setItem('mr.app.mode', 'complex');
      } catch {
        /* ignore */
      }
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    page.on('console', (msg) => {
      // 409 是冲突流程的预期响应，会以资源错误形式出现在控制台
      if (msg.type() === 'error' && !msg.text().includes('409 (Conflict)')) errors.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shelf', { timeout: 15000 });
    check('桌面书架渲染', true);
    await page.screenshot({ path: path.join(shots, 'v4-shelf-desktop.png') });

    await page.goto(`${base}/#/doc/${md.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.article', { timeout: 15000 });
    const heading = ((await page.locator('.article h1, .article h2').first().textContent()) || '').trim();
    check('md 阅读页渲染', heading.includes('SQLite'), heading);
    await page.screenshot({ path: path.join(shots, 'v4-reader-desktop.png') });

    await page.getByTitle('编辑（E）').click();
    await page.waitForSelector('.cm-editor', { timeout: 15000 });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nUI smoke appended\n');
    await page.waitForFunction(
      () => (document.querySelector('.save-state') || {}).textContent?.includes('已保存'),
      null,
      { timeout: 15000 },
    );
    const saved = await api(base, `/api/v1/docs/${md.id}`);
    check('md 自动保存写回', saved.body.includes('UI smoke appended'));
    check('编辑器未重建', (await page.locator('.cm-editor').count()) === 1);
    await page.keyboard.press('Escape');

    // 冲突：外部改盘 → 保存 409 → 三栏 diff3
    const current = await api(base, `/api/v1/docs/${md.id}`);
    await api(base, `/api/v1/docs/${md.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: `${current.body}\n磁盘外部改动\n`, baseHash: current.rawHash }),
    });
    await page.getByTitle('编辑（E）').click();
    await page.waitForSelector('.cm-editor', { timeout: 15000 });
    await page.locator('.cm-content').click();
    await page.keyboard.type('冲突测试');
    await page.keyboard.press('Control+s');
    await page.getByRole('button', { name: '逐行合并' }).click({ timeout: 15000 });
    await page.waitForSelector('.merge3 .cm-mergeView', { timeout: 15000 });
    const mergeEditors = await page.locator('.merge3 .cm-editor').count();
    check('diff3 三栏渲染', mergeEditors >= 2, `${mergeEditors} editors`);
    await page.screenshot({ path: path.join(shots, 'v4-diff3.png') });
    await page.getByLabel('关闭').click();
    await page.keyboard.press('Escape');

    await page.goto(`${base}/#/doc/${txt.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('pre.txt-view', { timeout: 15000 });
    check('txt 以原始文本渲染', true);
    await page.getByTitle('编辑（E）').click();
    await page.waitForSelector('.cm-editor', { timeout: 15000 });
    check('txt 可进入编辑', true);
    await page.screenshot({ path: path.join(shots, 'v4-txt-edit.png') });
    await page.keyboard.press('Escape');

    await page.goto(`${base}/#/doc/${docx.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.article', { timeout: 15000 });
    const badge = ((await page.locator('.encoding-badge').filter({ hasText: 'DOCX' }).first().textContent()) || '').trim();
    check('docx 只读徽标', badge.includes('只读'), badge);
    check('docx 不显示编辑按钮', (await page.getByTitle('编辑（E）').count()) === 0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shelf', { timeout: 15000 });
    await page.screenshot({ path: path.join(shots, 'v4-shelf-mobile.png') });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('移动端无横向溢出', overflow <= 1, `${overflow}px`);
    await page.goto(`${base}/#/doc/${md.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.article', { timeout: 15000 });
    const panelDisplay = await page.evaluate(() => {
      const el = document.querySelector('.side-panel');
      return el ? getComputedStyle(el).display : 'missing';
    });
    check('移动端隐藏侧栏', panelDisplay === 'none', panelDisplay);
    await page.screenshot({ path: path.join(shots, 'v4-reader-mobile.png') });
    await page.close();
    if (!cdp) await ctx.close();

    if (errors.length) {
      console.log('浏览器错误：');
      for (const e of errors) console.log('  ' + e);
    }
    check('控制台零错误', errors.length === 0, `${errors.length} errors`);
  } finally {
    await browser.close();
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (process.env.KEEP_UI_TMP !== '1') await fs.rm(work, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
