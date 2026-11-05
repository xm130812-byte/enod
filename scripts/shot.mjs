#!/usr/bin/env node
/**
 * 用 CDP 给页面拍截图并收集控制台错误。
 * 需要一个已启动的 Chrome：--headless=new --remote-debugging-port=9222
 *
 * 用法：node scripts/shot.mjs <url> <out.png> [宽] [高] [等待毫秒]
 */
import fs from 'node:fs/promises';

const [url, outFile, w = '1440', h = '940', waitMs = '1800', preScript = '', extraWait = '0'] = process.argv.slice(2);
if (!url || !outFile) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [w] [h] [waitMs]');
  process.exit(1);
}

const DEVTOOLS = process.env.DEVTOOLS || 'http://127.0.0.1:9222';

async function newTab(target) {
  const res = await fetch(`${DEVTOOLS}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`new tab failed: ${res.status}`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        events,
        close: () => ws.close(),
      });
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
}

const tab = await newTab('about:blank');
const cdp = await connect(tab.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: Number(w),
  height: Number(h),
  deviceScaleFactor: 1,
  mobile: false,
});
await cdp.send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, Number(waitMs)));

if (preScript) {
  const pre = await cdp.send('Runtime.evaluate', { expression: preScript, awaitPromise: true, returnByValue: true });
  if (pre.exceptionDetails) console.log('PRE ERROR ' + JSON.stringify(pre.exceptionDetails));
  else console.log('PRE ' + JSON.stringify(pre.result?.value ?? null));
  await new Promise((r) => setTimeout(r, Number(extraWait) || 900));
}

const evaluation = await cdp.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    rootText: (document.getElementById('root')?.innerText || '').slice(0, 600),
    rootChildren: document.getElementById('root')?.children.length ?? 0,
    cards: document.querySelectorAll('.doc-card').length,
    articles: document.querySelectorAll('.article').length,
    bodyClass: document.body.className,
    theme: document.documentElement.dataset.theme,
  })`,
  returnByValue: true,
});
console.log('PAGE ' + evaluation.result.value);

const errors = [];
for (const event of cdp.events) {
  if (event.method === 'Runtime.exceptionThrown') {
    errors.push(event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text);
  }
  if (event.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(event.params.type)) {
    errors.push(event.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
    errors.push(event.params.entry.text);
  }
}
console.log(errors.length ? 'ERRORS\n' + errors.join('\n---\n') : 'ERRORS none');

const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await fs.writeFile(outFile, Buffer.from(shot.data, 'base64'));
console.log('saved ' + outFile);

// 关闭标签页
try {
  await fetch(`${DEVTOOLS}/json/close/${tab.id}`);
} catch {
  /* ignore */
}
cdp.close();
process.exit(0);
