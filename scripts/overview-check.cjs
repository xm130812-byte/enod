const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const ctx = b.contexts()[0];
  const pages = ctx.pages();
  console.log('pages:', pages.map((p) => p.url()).join(' | '));
  const p = pages.find((x) => x.url().includes('/tray.html'));
  if (!p) throw new Error('overview page not found');
  await p.waitForSelector('.stats', { timeout: 15000 });
  await p.waitForTimeout(1200);
  console.log('size:', await p.evaluate(() => [innerWidth, innerHeight].join('x')));
  console.log('text:', ((await p.locator('body').innerText()) || '').replace(/\n/g, ' | ').slice(0, 400));
  await p.screenshot({ path: '/mnt/d/something/md-reader/docs/screenshots/tray-overview-windows.png' });  await b.close();
})();
