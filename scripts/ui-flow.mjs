#!/usr/bin/env node
/**
 * 端到端 UI 流程验证：编辑 → 自动保存 → 退出 → 划线批注 → 状态切换。
 * 需要先启动服务端与带 --remote-debugging-port 的 Chrome。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.READER_BASE || 'http://127.0.0.1:37123';
const DEVTOOLS = process.env.DEVTOOLS || 'http://127.0.0.1:9222';
const LIB = process.env.READER_LIB || 'D:\\something\\md-reader\\sample-library';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

async function api(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Reader-Client': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const created = await api('POST', '/api/v1/docs', {
  dir: 'Inbox',
  title: 'UI 流程测试',
  content: 'UI 流程测试\n\n它不完美，但够用了。\n',
});
console.log('created doc', created.id, created.relPath);

async function newTab(target) {
  const res = await fetch(`${DEVTOOLS}/json/new?${encodeURIComponent(target)}`, { method: 'PUT' });
  return res.json();
}

const tab = await newTab('about:blank');
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const exceptions = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    exceptions.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text));
  return out.result?.value;
}

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${BASE}/#/doc/${created.id}` });
await sleep(2200);
// 复杂视图承载状态选择、侧栏等完整功能
await evaluate(`localStorage.setItem('mr.app.mode','complex'); location.reload(); 'reload'`);
await sleep(2400);

// 1. 进入编辑
await evaluate(`document.querySelector('.reader-actions .btn-ghost').click(); 'edit'`);
await sleep(900);
const inEdit = await evaluate(`!!document.querySelector('.cm-content')`);
check('点击「编辑」进入编辑态', inEdit);

// 2. 输入并等待自动保存
await evaluate(`document.querySelector('.cm-content').focus()`);
await send('Input.insertText', { text: '编辑测试追加。\n' });
await sleep(2200);
const saved = await api('GET', `/api/v1/docs/${created.id}`);
check('自动保存把新内容写回磁盘', saved.body.includes('编辑测试追加。'), `body 长度 ${saved.body.length}`);
const saveState = await evaluate(`document.querySelector('.save-state')?.textContent ?? ''`);
check('保存状态可见', saveState.length > 0, `save-state=${saveState}`);

// 3. Esc 退出编辑
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(800);
const backToRead = await evaluate(`!!document.querySelector('.article') && !document.querySelector('.cm-content')`);
check('Esc 退出编辑回到阅读态', backToRead);

// 4. 选中文字 → 工具条 → 绿色高亮
const selected = await evaluate(`(() => {
  const p = [...document.querySelectorAll('.article p')].find((el) => el.textContent.includes('它不完美'));
  if (!p) return null;
  const node = p.firstChild;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, Math.min(7, node.length));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  return range.toString();
})()`);
check('选中正文文本', typeof selected === 'string' && selected.startsWith('它不完美'), `selected=${selected}`);
await sleep(400);
const hasToolbar = await evaluate(`!!document.querySelector('.ann-toolbar')`);
check('出现选区工具条', hasToolbar);

await evaluate(`document.querySelector('.ann-toolbar .color-dot.dot-green')?.click(); 'ok'`);
await sleep(1200);
const annotated = await api('GET', `/api/v1/docs/${created.id}`);
check('批注写回 frontmatter', annotated.annotations.length === 1, `count=${annotated.annotations.length}`);
check('批注内容正确', annotated.annotations[0]?.exact === selected, annotated.annotations[0]?.exact ?? '');
const markCount = await evaluate(`document.querySelectorAll('.article mark.ann').length`);
check('正文出现高亮', markCount > 0, `marks=${markCount}`);

// 5. 切换状态（下拉）
await evaluate(`(() => {
  const sel = document.querySelector('.status-select');
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'done');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value;
})()`);
await sleep(900);
const afterStatus = await api('GET', `/api/v1/docs/${created.id}`);
check('状态下拉写回文件', afterStatus.status === 'done', `status=${afterStatus.status}`);

// 6. 磁盘文件 frontmatter 检查
const raw = await fs.readFile(path.join(LIB, created.relPath.split('/').join(path.sep)), 'utf8');
check('磁盘文件含 reader.annotations', raw.includes('reader:') && raw.includes('annotations:'));
check('磁盘文件保留正文', raw.includes('编辑测试追加。'));

// 7. 搜索能命中新内容
const search = await api('GET', `/api/v1/search?q=${encodeURIComponent('编辑测试追加')}`);
check('全文检索命中新内容', search.some((r) => r.id === created.id), `hits=${search.length}`);

// 8. 外部修改 → 自动保存冲突 → 载入磁盘版本
await evaluate(`document.querySelector('.reader-actions .btn-ghost').click(); 'edit'`);
await sleep(800);
await evaluate(`document.querySelector('.cm-content').focus()`);
await send('Input.insertText', { text: '本地未保存的改动\n' });
await sleep(300);
await api('PATCH', `/api/v1/docs/${created.id}`, { body: '外部修改覆盖了这段。\n' });
await sleep(2400);
const conflictShown = await evaluate(
  `!!document.querySelector('.modal') && document.body.innerText.includes('保存冲突')`,
);
check('外部修改后保存触发冲突对话框', conflictShown);

const loadedDisk = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.includes('载入磁盘版本'));
  if (!btn) return false;
  btn.click();
  return true;
})()`);
check('冲突对话框提供「载入磁盘版本」', loadedDisk);
await sleep(1400);
const afterLoad = await api('GET', `/api/v1/docs/${created.id}`);
check('载入磁盘版本后正文为磁盘内容', afterLoad.body.includes('外部修改覆盖了这段'), afterLoad.body.slice(0, 20));

const errors = exceptions.filter(Boolean);
check('控制台无未捕获异常', errors.length === 0, errors.join(' | '));

// 9. 简单视图：左侧文件树 + 中间文章 + 目录浮层，无状态导航
await evaluate(`localStorage.setItem('mr.app.mode','simple'); location.reload(); 'reload'`);
await sleep(2400);
const simple = await evaluate(`JSON.stringify({
  simple: !!document.querySelector('.simple'),
  tree: !!document.querySelector('.simple-tree'),
  article: !!document.querySelector('.article'),
  statusSelect: !!document.querySelector('.status-select'),
})`);
const simpleState = JSON.parse(simple);
check('简单视图渲染（文件树 + 文章）', simpleState.simple && simpleState.tree && simpleState.article);
check('简单视图没有状态导航', simpleState.statusSelect === false);

// 用有多级标题的样例文档验证「左侧目录」切换
await evaluate(`location.hash = '#/doc/01M6PEGRCN1EKDDN8MCEYVHY88'; 'nav'`);
await sleep(1900);
await evaluate(`[...document.querySelectorAll('.simple-tabs button')].find((b) => b.textContent.includes('目录'))?.click(); 'toc'`);
await sleep(600);
const tocCount = await evaluate(`document.querySelectorAll('.simple-toc .toc-item').length`);
check('左侧「目录」tab 展示标题', tocCount >= 5, `items=${tocCount}`);
const scrollBefore = await evaluate(`document.querySelector('.reader-scroll')?.scrollTop ?? 0`);
await evaluate(`document.querySelectorAll('.simple-toc .toc-item')[4]?.click(); 'jump'`);
await sleep(1000);
const scrollAfter = await evaluate(`document.querySelector('.reader-scroll')?.scrollTop ?? 0`);
check('点击目录项可跳转', scrollAfter > scrollBefore, `${scrollBefore} -> ${scrollAfter}`);
await evaluate(`[...document.querySelectorAll('.simple-tabs button')].find((b) => b.textContent.includes('文件夹'))?.click(); 'files'`);
await sleep(400);
check('可切回「文件夹」tab', (await evaluate(`!!document.querySelector('.simple-folder')`)) === true);

// 清理
await api('DELETE', `/api/v1/docs/${created.id}`);
try {
  await fetch(`${DEVTOOLS}/json/close/${tab.id}`);
} catch {
  /* ignore */
}
ws.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
