#!/usr/bin/env node
/**
 * 下载并解压固定版本的 UPX（Windows x64）。
 *
 * 只用于 `pnpm package` 的 exe 压缩步骤；UPX 二进制不提交进仓库。
 * 用法：pnpm upx:fetch
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '4.2.4';
const url = `https://github.com/upx/upx/releases/download/v${version}/upx-${version}-win64.zip`;
const sha256 = '22e9ef20e4c72aad85e32c71cbc9c086436c179456382aa75c0c24868456a671';
const toolsDir = path.join(root, 'tools');
const upxDir = path.join(toolsDir, 'upx');
const zipPath = path.join(toolsDir, `upx-${version}-win64.zip`);

function log(message) {
  console.log(`[upx] ${message}`);
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('当前脚本只下载 Windows x64 版 UPX；其他平台请用系统包管理器安装并设置 UPX_BIN');
  }
  await fsp.mkdir(upxDir, { recursive: true });

  const existing = path.join(upxDir, `upx-${version}-win64`, 'upx.exe');
  if (fs.existsSync(existing)) {
    log(`已存在：${existing}`);
    return;
  }

  log(`下载 ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(buf).digest('hex');
  if (hash !== sha256) throw new Error(`SHA256 不匹配：${hash}`);
  await fsp.writeFile(zipPath, buf);
  log(`校验通过（${(buf.length / 1024 / 1024).toFixed(1)} MB），解压`);

  execFileSync('tar', ['-xf', zipPath, '-C', upxDir], { stdio: 'inherit' });
  if (!fs.existsSync(existing)) {
    throw new Error(`解压后没找到 ${existing}，请手动解压 ${zipPath} 到 ${upxDir}`);
  }
  log(`完成：${existing}`);
}

main().catch((error) => {
  console.error(`[upx] ${error.message}`);
  process.exitCode = 1;
});
