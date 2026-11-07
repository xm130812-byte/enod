const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9223');
  const p = b.contexts()[0].pages().find((x) => x.url().includes('/tray.html'));
  p.on('console', (m) => console.log('console:', m.type(), m.text()));
  p.on('pageerror', (e) => console.log('pageerror:', e.message));
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  console.log('body:', (await p.locator('body').innerText()).replace(/\n/g, ' | ').slice(0, 300));
  console.log('err:', await p.locator('#err').innerText());
  await b.close();
})();
