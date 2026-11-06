import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const apiPort = Number(process.env.READER_PORT ?? 37123);

/**
 * KaTeX 自带 woff2 / woff / ttf 三套字体，一共 1.05MB；
 * 只承诺 Chrome 的前提下 woff2 就够了，砍掉另外两套省约 800KB。
 * 先改 CSS，再按 CSS 实际引用删除文件 —— 改写失败时不会误删。
 */
function woff2OnlyFonts(): Plugin {
  return {
    name: 'md-reader:woff2-only-fonts',
    apply: 'build',
    closeBundle() {
      const assetsDir = path.resolve(rootDir, 'dist', 'assets');
      if (!fs.existsSync(assetsDir)) return;

      const cssFiles = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.css'));
      for (const name of cssFiles) {
        const file = path.join(assetsDir, name);
        const css = fs.readFileSync(file, 'utf8');
        const next = css.replace(
          /src:url\((\/assets\/KaTeX_[^)]+\.woff2)\) format\("woff2"\),url\([^)]+\) format\("woff"\),url\([^)]+\) format\("truetype"\)/g,
          'src:url($1) format("woff2")',
        );
        if (next !== css) fs.writeFileSync(file, next);
      }

      const referenced = new Set<string>();
      for (const name of cssFiles) {
        const css = fs.readFileSync(path.join(assetsDir, name), 'utf8');
        for (const match of css.matchAll(/\/assets\/([^)"'\s]+)/g)) referenced.add(match[1]!);
      }

      let removed = 0;
      for (const name of fs.readdirSync(assetsDir)) {
        if (!/\.(woff|ttf)$/i.test(name)) continue;
        if (referenced.has(name)) continue;
        fs.rmSync(path.join(assetsDir, name));
        removed++;
      }
      if (removed > 0) console.log(`[build] 删掉 ${removed} 个非 woff2 字体文件`);
    },
  };
}

export default defineConfig({
  root: rootDir,
  plugins: [react(), woff2OnlyFonts()],
  server: {
    port: 5173,
    strictPort: true,
    // 编辑器/工具写入的临时文件会触发 Windows 上的 EBUSY，直接忽略
    watch: {
      ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/~*'],
    },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 发布包不带 sourcemap（约省 16MB）；配合 Shiki 按需打包，web 从 27.8MB 降到 3MB 上下。
    // 排查线上问题时用 SOURCE_MAP=1 pnpm build 重新生成。
    sourcemap: process.env.SOURCE_MAP === '1',
    chunkSizeWarningLimit: 1600,
  },
});
