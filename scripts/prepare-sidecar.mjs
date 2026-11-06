#!/usr/bin/env node
/**
 * 把 Rust 内核复制成 Tauri sidecar（名字必须带 target triple）。
 *
 * 用法：
 *   node scripts/prepare-sidecar.mjs <triple>
 *   node scripts/prepare-sidecar.mjs x86_64-unknown-linux-gnu
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const triple = process.argv[2];
if (!triple) {
  console.error('usage: node scripts/prepare-sidecar.mjs <target-triple>');
  process.exit(2);
}

const repo = path.resolve(import.meta.dirname, '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const candidates = [
  path.join(repo, 'packages/core/target/release', `md-reader-core${exe}`),
  path.join(repo, 'packages/core/target', triple, 'release', `md-reader-core${exe}`),
  // 本机 ~/.cargo/config.toml 把 target-dir 指到 ~/target
  path.join(os.homedir(), 'target', 'release', `md-reader-core${exe}`),
];
let source = null;
for (const candidate of candidates) {
  if (await fs.stat(candidate).then((s) => s.isFile()).catch(() => false)) {
    source = candidate;
    break;
  }
}
if (!source) {
  console.error(`找不到内核产物，先执行：cargo build --release -p reader-cli --manifest-path packages/core/Cargo.toml`);
  process.exit(1);
}

const outDir = path.join(repo, 'packages/shell/src-tauri/binaries');
await fs.mkdir(outDir, { recursive: true });
const target = path.join(outDir, `md-reader-core-${triple}${exe}`);
await fs.copyFile(source, target);
await fs.chmod(target, 0o755).catch(() => {});
const size = (await fs.stat(target)).size;
console.log(`sidecar: ${path.relative(repo, target)} (${(size / 1024 / 1024).toFixed(2)} MiB)`);
