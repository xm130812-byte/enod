#!/usr/bin/env node
/** 打开页面、执行一段 JS、打印结果。开发期排查用。
 * 用法：node scripts/eval.mjs <url> "<js>" [waitMs]
 */
const [url, expression, waitMs = '2000'] = process.argv.slice(2);
if (!url || !expression) {
  console.error('usage: node scripts/eval.mjs <url> "<js>" [waitMs]');
  process.exit(1);
}

const DEVTOOLS = process.env.DEVTOOLS || 'http://127.0.0.1:9222';

async function newTab(target) {
  const res = await fetch(`${DEVTOOLS}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`new tab failed: ${res.status}`);
  return res.json();
}

const tab = await newTab('about:blank');

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const events = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, Number(waitMs)));
const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(result.result?.value ?? result.exceptionDetails ?? null, null, 2));

const errors = events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text);
if (errors.length) console.log('EXCEPTIONS\n' + errors.join('\n'));
ws.close();
try {
  await fetch(`${DEVTOOLS}/json/close/${tab.id}`);
} catch {
  /* ignore */
}
process.exit(0);
