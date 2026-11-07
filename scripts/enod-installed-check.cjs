const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => !x.url().includes('/tray.html'));
  await p.waitForSelector('.shelf, .simple-view, .reader', { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(1000);
  console.log('title:', await p.title(), 'url:', p.url());
  await p.screenshot({ path: '/mnt/d/something/md-reader/docs/screenshots/v4-enod-installed.png' });
  await b.close();
})();
