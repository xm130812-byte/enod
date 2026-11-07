const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  console.log(await p.evaluate(() => ({
    label: document.querySelector('#mode').textContent,
    win: document.querySelector('#modeWin').className,
    chrome: document.querySelector('#modeChrome').className,
  })));
  await b.close();
})();
