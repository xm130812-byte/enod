#!/usr/bin/env node
/**
 * M1.5 打包验证 · 第一步：Node SEA 单文件 sidecar。
 *
 * 产出 dist/sea/md-reader.exe（内置守护进程 + yaml + iconv-lite）与 dist/sea/web/（前端静态资源）。
 * 不含托盘/安装包 —— 那一步需要 Rust + MSVC（见 docs/PACKAGING.md）。
 *
 * 用法：node scripts/package-sea.mjs
 */
import { build } from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'sea');
const nodeExe = process.execPath;
const postjectCli = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(message) {
  console.log(`[sea] ${message}`);
}

async function main() {
  log('清理 dist/sea');
  await fsp.rm(out, { recursive: true, force: true });
  await fsp.mkdir(out, { recursive: true });

  log('esbuild 打包服务端');
  await build({
    entryPoints: [path.join(root, 'packages/server/src/index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: path.join(out, 'server.cjs'),
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: '/* md-reader sidecar — bundled by esbuild */' },
  });

  const seaConfig = {
    main: path.join(out, 'server.cjs'),
    output: path.join(out, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets: {},
  };
  const configPath = path.join(out, 'sea-config.json');
  await fsp.writeFile(configPath, JSON.stringify(seaConfig, null, 2));

  log('生成 SEA blob');
  execFileSync(nodeExe, ['--experimental-sea-config', configPath], { cwd: root, stdio: 'inherit' });

  const exe = path.join(out, 'md-reader.exe');
  log('复制 node 并注入 blob');
  await fsp.copyFile(nodeExe, exe);
  execFileSync(nodeExe, [postjectCli, exe, 'NODE_SEA_BLOB', path.join(out, 'sea-prep.blob'), '--sentinel-fuse', fuse], {
    cwd: root,
    stdio: 'inherit',
  });

  log('复制前端静态资源');
  await fsp.cp(path.join(root, 'packages/web/dist'), path.join(out, 'web'), { recursive: true });

  const launcher = [
    '@echo off',
    'cd /d "%~dp0"',
    'start "" "%~dp0md-reader.exe"',
    '',
  ].join('\r\n');
  await fsp.writeFile(path.join(out, 'md-reader.cmd'), launcher, 'utf8');

  const size = (await fsp.stat(exe)).size;
  log(`完成：${exe}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  log(`前端：${path.join(out, 'web')}`);
  log('试运行：dist\\sea\\md-reader.exe --no-open --port 0 --data-dir <临时目录>');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
