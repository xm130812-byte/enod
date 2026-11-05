/**
 * md-reader 守护进程入口。
 * - 随机端口、首次分配后粘性复用（run.json）
 * - 单实例：检测到活着的实例就只唤起浏览器
 * - 托管 web/dist；开发期前端由 Vite 提供
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { appDataDir, dataPaths, ensureDataDirs } from './core/paths.ts';
import {
  clearRunInfo,
  ConfigStore,
  newInstanceId,
  pidAlive,
  readRunInfo,
  writeRunInfo,
} from './core/config.ts';
import type { RunInfo } from './core/config.ts';
import { VERSION } from './core/version.ts';
import { IndexDB } from './store/db.ts';
import { EventHub } from './http/sse.ts';
import { LibraryService } from './library/service.ts';
import { createServer } from './http/server.ts';
import { openBrowser } from './core/browser.ts';

const argv = process.argv.slice(2);

function argValue(name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1] ?? null;
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  return null;
}

function log(message: string): void {
  const time = new Date().toISOString().slice(11, 19);
  console.log(`${time} ${message}`);
}

const dataDir = argValue('--data-dir') ?? appDataDir();
const paths = dataPaths(dataDir);
ensureDataDirs(paths);

const noOpen = argv.includes('--no-open') || process.env.READER_NO_OPEN === '1';
const config = new ConfigStore(paths);
const previous = readRunInfo(paths);

async function probeHealth(port: number): Promise<{ instanceId?: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: AbortSignal.timeout(900),
    });
    if (!res.ok) return null;
    return (await res.json()) as { instanceId?: string };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (previous && previous.pid !== process.pid && pidAlive(previous.pid)) {
    const health = await probeHealth(previous.port);
    if (health?.instanceId === previous.instanceId) {
      log(`md-reader 已在运行：${previous.url}`);
      if (!noOpen) openBrowser(previous.url);
      return;
    }
  }

  const instanceId = newInstanceId();
  const db = new IndexDB(paths.dbFile);
  const hub = new EventHub();
  const service = new LibraryService(paths, config, db, hub);
  await service.init();
  log(`书库：${service.root ?? '(未挂载)'}`);

  const here = (() => {
    try {
      return path.dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();
  const execDir = path.dirname(process.execPath);
  const packaged = !/^node(\.exe)?$/i.test(path.basename(process.execPath));
  const webDist = process.env.READER_WEB_DIST
    ? path.resolve(process.env.READER_WEB_DIST)
    : packaged
      ? path.join(execDir, 'web')
      : path.resolve(here, '../../web/dist');
  const hasDist = fs.existsSync(path.join(webDist, 'index.html'));

  const desiredPort = Number(argValue('--port') ?? process.env.READER_PORT ?? previous?.port ?? 0) || 0;
  const ctx = {
    service,
    config,
    hub,
    version: VERSION,
    instanceId,
    port: desiredPort,
    startedAt: Date.now(),
    webDist: hasDist ? webDist : null,
    dev: process.env.NODE_ENV !== 'production',
  };

  const server = createServer(ctx);
  const port = await listenWithFallback(server, desiredPort);
  ctx.port = port;

  const url = `http://127.0.0.1:${port}`;
  const info: RunInfo = {
    pid: process.pid,
    port,
    instanceId,
    startedAt: new Date().toISOString(),
    url,
    libraryRoot: service.root,
    version: VERSION,
  };
  writeRunInfo(paths, info);

  log(`md-reader ${VERSION} 就绪：${url}`);
  log(`数据目录：${paths.root}`);
  if (!hasDist) log('未找到 web/dist —— 请用 pnpm dev 或先 pnpm build');

  if (!noOpen) openBrowser(url);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在退出…`);
    clearRunInfo(paths, instanceId);
    hub.closeAll();
    server.close();
    void service.shutdown().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function listenWithFallback(server: Server, desiredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowRandom: boolean): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && allowRandom) {
          tryListen(0, false);
          return;
        }
        reject(err);
      };
      const onListening = (): void => {
        server.off('error', onError);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    tryListen(desiredPort, desiredPort !== 0);
  });
}

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error('[unhandledRejection]', message);
  void logToFile(message);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  void logToFile(err.stack ?? err.message);
});

async function logToFile(message: string): Promise<void> {
  try {
    await fsp.mkdir(paths.logsDir, { recursive: true });
    await fsp.appendFile(
      path.join(paths.logsDir, 'error.log'),
      `${new Date().toISOString()} ${message}\n`,
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
