const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  const target = '#' + (process.argv[2] || 'modeChrome').replace(/^#/, '');
  await p.click(target);
  await new Promise((r) => setTimeout(r, 1200));
  console.log('pages:', b.contexts()[0].pages().map((x) => x.url()).join(' | '));
  console.log('mode text:', await p.locator('#mode').innerText());
  await b.close();
})();
