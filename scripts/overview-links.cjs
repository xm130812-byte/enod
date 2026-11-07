const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  console.log(await p.evaluate(() => ({
    win: document.querySelector('#modeWin').href,
    chrome: document.querySelector('#modeChrome').href,
    simple: document.querySelector('.seg a[href="/__shell/view/simple"]')?.href,
    body: document.body.innerText.slice(-120),
  })));
  await b.close();
})();
