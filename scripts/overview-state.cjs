const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  console.log(await p.evaluate(() => ({
    root: document.querySelector('#root').textContent,
    err: document.querySelector('#err').textContent,
    path: document.querySelector('#wsPath').value,
    visible: document.visibilityState,
  })));
  await b.close();
})();
