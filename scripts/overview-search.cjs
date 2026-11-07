const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  await p.click('a[href="/__shell/search"]');
  await new Promise((r) => setTimeout(r, 1500));
  const reader = b.contexts()[0].pages().find((x) => !x.url().includes('/tray.html'));
  console.log('pages:', b.contexts()[0].pages().map((x) => x.url()).join(' | '));
  if (reader) {
    await reader.waitForSelector('.palette', { timeout: 10000 });
    console.log('search overlay:', await reader.locator('.palette').getAttribute('aria-label'));
    console.log('url:', await reader.evaluate(() => location.href));
  }
  await b.close();
})();
