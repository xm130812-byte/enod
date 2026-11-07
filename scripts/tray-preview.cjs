const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const url = process.argv[2];
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 360, height: 480 });
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.stats', { timeout: 15000 });
  await p.waitForTimeout(1500);
  console.log('text:', ((await p.locator('body').innerText()) || '').replace(/\n/g, ' | ').slice(0, 500));
  await p.screenshot({ path: process.env.SHOT || '/tmp/tray-preview.png' });
  await p.close();
  await b.close();
})();
