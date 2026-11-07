const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  const to = process.argv[2] || '/__shell/mode/window';
  await p.evaluate((u) => { location.href = u; }, to);
  await new Promise((r) => setTimeout(r, 1200));
  console.log('navigated to', to);
  await b.close();
})();
