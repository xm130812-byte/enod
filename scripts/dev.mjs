#!/usr/bin/env node
/**
 * 开发模式：守护进程（固定 37123）+ Vite（5173，带 /api 代理）。
 * 生产形态由守护进程托管 web/dist，不使用本脚本。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = '37123';
const env = {
  ...process.env,
  READER_PORT: port,
  READER_ROOT: process.env.READER_ROOT || path.join(root, 'sample-library'),
  READER_DATA_DIR: process.env.READER_DATA_DIR || path.join(root, '.devdata'),
  NODE_NO_WARNINGS: '1',
};

const children = [];
let shuttingDown = false;

function start(label, args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`[dev] ${label} exited (${code ?? 'signal'})`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGINT');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('server', [path.join(root, 'packages/server/src/index.ts'), '--no-open', '--port', port]);
start('vite', [path.join(root, 'packages/web/node_modules/vite/bin/vite.js'), '--config', path.join(root, 'packages/web/vite.config.ts')]);

console.log('[dev] 服务端 http://127.0.0.1:' + port + '  ·  前端 http://localhost:5173');
