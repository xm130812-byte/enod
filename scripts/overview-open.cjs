const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  if (!p) throw new Error('overview not found');
  console.log('href:', await p.locator('#openMain').getAttribute('href'));
  await p.click('#openMain');
  await new Promise((r) => setTimeout(r, 1500));
  console.log('pages:', b.contexts()[0].pages().map((x) => x.url()).join(' | '));
  await b.close();
})();
