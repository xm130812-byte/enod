const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  if (!p) throw new Error('overview not found');
  await p.click('a[href="/__shell/view/simple"]');
  await new Promise((r) => setTimeout(r, 1500));
  const pages = b.contexts()[0].pages();
  console.log('pages:', pages.map((x) => x.url()).join(' | '));
  const reader = pages.find((x) => !x.url().includes('/tray.html'));
  if (reader) {
    console.log(await reader.evaluate(() => ({
      url: location.href,
      mode: localStorage.getItem('mr.app.mode'),
      bodyClass: document.body.className,
    })));
  }
  await b.close();
})();
