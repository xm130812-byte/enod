import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const apiPort = Number(process.env.READER_PORT ?? 37123);

export default defineConfig({
  root: rootDir,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
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
    // 发布包不带 sourcemap（约省 16MB）；配合 Shiki 按需打包，web 从 27.8MB 降到 4.2MB。
    // 排查线上问题时用 SOURCE_MAP=1 pnpm build 重新生成。
    sourcemap: process.env.SOURCE_MAP === '1',
    chunkSizeWarningLimit: 1600,
  },
});
