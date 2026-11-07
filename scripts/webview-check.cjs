const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const path = require('node:path');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const ctx = b.contexts()[0];
  const pages = ctx.pages();
  const p = pages[0] || (await ctx.newPage());
  const origin = new URL(p.url()).origin;
  await p.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.shelf, .simple-view', { timeout: 20000 });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.shelf, .simple-view', { timeout: 20000 });

  const title = await p.title();
  const body = ((await p.locator('body').innerText()) || '').slice(0, 200);
  console.log('title:', title);
  console.log('body:', body.replace(/\n/g, ' | '));
  await p.setViewportSize({ width: 1280, height: 860 });
  await p.screenshot({ path: path.join(__dirname, '..', 'docs', 'screenshots', 'v4-windows-installed.png') });
  await b.close();
})();
