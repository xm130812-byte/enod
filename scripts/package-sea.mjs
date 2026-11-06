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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// OUT_NAME 可指定子目录：常规 22MB 包放 dist/sea，给受管机器准备的未压缩包放 dist/portable
const out = path.join(root, 'dist', process.env.OUT_NAME || 'sea');
const nodeExe = process.execPath;
const postjectCli = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const rebrand = process.env.REBRAND === '1';

function log(message) {
  console.log(`[sea] ${message}`);
}

/** 找 UPX：显式 UPX_BIN > tools/upx/**\/upx.exe；NO_UPX=1 可跳过压缩 */
function findUpx() {
  if (process.env.NO_UPX === '1') return null;
  if (process.env.UPX_BIN) return fs.existsSync(process.env.UPX_BIN) ? process.env.UPX_BIN : null;
  const base = path.join(root, 'tools', 'upx');
  if (!fs.existsSync(base)) return null;
  const stack = [base];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === 'upx.exe') return full;
    }
  }
  return null;
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
    minify: true,
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

  // 清理打包中间产物，发布目录只留 exe / web / 启动器
  for (const name of ['server.cjs', 'sea-prep.blob', 'sea-config.json']) {
    await fsp.rm(path.join(out, name), { force: true });
  }

  const rawSize = (await fsp.stat(exe)).size;
  let finalSize = rawSize;

  if (rebrand) {
    // 受管环境用：把 PE 里的 Node.js 版本信息与图标换成自己的。
    // 重写资源段后 UPX 无法再压缩，所以这条路径固定输出未压缩 exe。
    log('改写 PE 版本信息与图标（REBRAND=1）');
    execFileSync(
      nodeExe,
      [
        path.join(root, 'scripts', 'rebrand-exe.mjs'),
        exe,
        exe,
        path.join(root, 'scripts', 'brand', 'md-reader.ico'),
      ],
      { cwd: root, stdio: 'inherit' },
    );
    log('已跳过 UPX（改写资源后无法再压缩）');
  }

  const upx = rebrand ? null : findUpx();
  if (upx) {
    log('UPX 压缩 exe（LZMA，约 90MB → 23MB）');
    try {
      execFileSync(upx, ['--lzma', '--best', exe], { cwd: root, stdio: 'inherit' });
      finalSize = (await fsp.stat(exe)).size;
    } catch (error) {
      log(`UPX 压缩失败，保留未压缩 exe：${error.message}`);
    }
  } else if (!rebrand) {
    log('未找到 UPX，跳过压缩（pnpm upx:fetch 可下载；NO_UPX=1 可显式跳过）');
  }

  const webSize = (await fsp.readdir(path.join(out, 'web'), { recursive: true }))
    .map((rel) => {
      try {
        return fs.statSync(path.join(out, 'web', rel)).size;
      } catch {
        return 0;
      }
    })
    .reduce((a, b) => a + b, 0);

  log(`完成：${exe}`);
  log(`  exe：${(finalSize / 1024 / 1024).toFixed(1)} MB（压缩前 ${(rawSize / 1024 / 1024).toFixed(1)} MB）`);
  log(`  web：${(webSize / 1024 / 1024).toFixed(1)} MB`);
  log(`  合计：${((finalSize + webSize) / 1024 / 1024).toFixed(1)} MB`);
  log(`前端：${path.join(out, 'web')}`);
  log(`试运行：${path.relative(root, exe)} --no-open --port 0 --data-dir <临时目录>`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
