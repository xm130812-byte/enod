import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { ConfigStore } from '../core/config.ts';
import { HttpError, isHttpError } from './errors.ts';
import type { EventHub } from './sse.ts';
import type { LibraryService } from '../library/service.ts';

export interface ServerContext {
  service: LibraryService;
  config: ConfigStore;
  hub: EventHub;
  version: string;
  instanceId: string;
  port: number;
  startedAt: number;
  webDist: string | null;
  dev: boolean;
}

interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  query: URLSearchParams;
}

type Handler = (ctx: RouteCtx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY = 32 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function route(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const regex = new RegExp(
    '^' +
      pattern.replace(/:([A-Za-z0-9_]+)/g, (_m, key: string) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, regex, keys, handler };
}

async function readBody(req: IncomingMessage): Promise<{ body: unknown; raw: Buffer | null }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too-large', '请求体过大');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks);
  const contentType = String(req.headers['content-type'] ?? '');
  if (raw.length === 0) return { body: null, raw };
  if (contentType.includes('application/json')) {
    try {
      return { body: JSON.parse(raw.toString('utf8')), raw };
    } catch {
      throw new HttpError(400, 'invalid-json', 'JSON 解析失败');
    }
  }
  return { body: null, raw };
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  const accept = String(req.headers['accept-encoding'] ?? '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (payload.length > 1024 && accept.includes('gzip')) {
    const gz = zlib.gzipSync(payload);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function sendError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (isHttpError(err)) {
    sendJson(req, res, err.status, {
      error: { code: err.code, message: err.message, detail: err.detail ?? null },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error('[error]', message);
  sendJson(req, res, 500, { error: { code: 'internal', message, detail: null } });
}

function parseCookies(): void {
  /* 回环模式不用 Cookie（PRD §4.3） */
}

export function createServer(ctx: ServerContext): http.Server {
  const routes: Route[] = [
    route('GET', '/api/v1/health', () => ({
      ok: true,
      version: ctx.version,
      instanceId: ctx.instanceId,
      port: ctx.port,
      pid: process.pid,
      startedAt: ctx.startedAt,
      uptime: Math.round(process.uptime()),
      libraryRoot: ctx.service.root,
      platform: process.platform,
    })),

    route('GET', '/api/v1/library', () => ({
      root: ctx.service.root,
      stats: ctx.service.stats(),
      dirs: ctx.service.directoryTree().dirs,
      config: ctx.config.get(),
    })),

    route('POST', '/api/v1/library/open', async ({ body }) => {
      const input = body as { path?: string };
      if (!input?.path || typeof input.path !== 'string') {
        throw new HttpError(400, 'bad-request', '需要 path');
      }
      await ctx.service.mount(input.path);
      return { ok: true, root: ctx.service.root };
    }),

    route('GET', '/api/v1/library/stats', () => ctx.service.stats()),

    route('POST', '/api/v1/library/rescan', async () => {
      const result = await ctx.service.rescan('manual');
      return { ok: true, result };
    }),

    route('GET', '/api/v1/library/dirs', () => ctx.service.directoryTree()),

    route('GET', '/api/v1/config', () => ctx.config.get()),

    route('PATCH', '/api/v1/config', async ({ body }) => {
      const patch = (body ?? {}) as Record<string, unknown>;
      return ctx.service.updateConfig(patch);
    }),

    route('GET', '/api/v1/docs', ({ query }) => {
      const status = query.get('status');
      const tag = query.get('tag');
      const sort = (query.get('sort') ?? 'recent') as 'recent' | 'added' | 'words' | 'title';
      return ctx.service.listDocs({
        status: status === 'all' || !status ? 'all' : (status as 'unread' | 'reading' | 'done'),
        tag,
        sort,
        q: query.get('q'),
        limit: query.get('limit') ? Number(query.get('limit')) : undefined,
        offset: query.get('offset') ? Number(query.get('offset')) : undefined,
      });
    }),

    route('GET', '/api/v1/docs/:id', ({ params }) => ctx.service.getDoc(params.id!)),

    route('POST', '/api/v1/docs', async ({ body }) => {
      const input = (body ?? {}) as { dir?: string; title?: string; content?: string; tags?: string[] };
      return ctx.service.createDoc(input);
    }),

    route('PATCH', '/api/v1/docs/:id', async ({ params, body }) => {
      const input = (body ?? {}) as {
        body?: string;
        content?: string;
        baseHash?: string;
        title?: string;
        tags?: string[];
        reader?: { status?: 'unread' | 'reading' | 'done'; progress?: number };
      };
      return ctx.service.saveDoc(params.id!, {
        body: input.body ?? input.content,
        baseHash: input.baseHash,
        title: input.title,
        tags: input.tags,
        reader: input.reader,
      });
    }),

    route('POST', '/api/v1/docs/:id/status', async ({ params, body }) => {
      const input = (body ?? {}) as { status?: 'unread' | 'reading' | 'done' };
      if (!input.status) throw new HttpError(400, 'bad-request', '需要 status');
      return ctx.service.setStatus(params.id!, input.status);
    }),

    route('POST', '/api/v1/docs/:id/move', async ({ params, body }) => {
      const input = (body ?? {}) as { targetDir?: string; newName?: string; updateLinks?: boolean };
      return ctx.service.moveDoc(params.id!, input);
    }),

    route('DELETE', '/api/v1/docs/:id', ({ params }) => ctx.service.deleteDoc(params.id!)),

    route('POST', '/api/v1/docs/:id/annotations', async ({ params, body }) => {
      const input = (body ?? {}) as {
        exact?: string;
        prefix?: string;
        suffix?: string;
        pos?: number;
        color?: string;
        note?: string;
        baseHash?: string;
      };
      if (typeof input.exact !== 'string') throw new HttpError(400, 'bad-request', '需要 exact');
      return ctx.service.addAnnotation(params.id!, {
        exact: input.exact,
        prefix: input.prefix,
        suffix: input.suffix,
        pos: input.pos,
        color: input.color,
        note: input.note,
        baseHash: input.baseHash,
      });
    }),

    route('PATCH', '/api/v1/docs/:id/annotations/:aid', async ({ params, body }) => {
      const input = (body ?? {}) as { note?: string; color?: string };
      return ctx.service.updateAnnotation(params.id!, params.aid!, input);
    }),

    route('DELETE', '/api/v1/docs/:id/annotations/:aid', ({ params }) =>
      ctx.service.deleteAnnotation(params.id!, params.aid!),
    ),

    route('GET', '/api/v1/docs/:id/backlinks', async ({ params }) => {
      const doc = await ctx.service.getDoc(params.id!);
      return doc.backlinks;
    }),

    route('GET', '/api/v1/docs/:id/links', async ({ params }) => {
      const doc = await ctx.service.getDoc(params.id!);
      return doc.links;
    }),

    route('GET', '/api/v1/docs/:id/mentions', async ({ params }) =>
      ctx.service.unlinkedMentions(params.id!, 20),
    ),

    route('GET', '/api/v1/search', async ({ query }) => {
      const q = query.get('q') ?? '';
      const limit = Math.min(Number(query.get('limit') ?? 30) || 30, 100);
      return ctx.service.searchWithSnippets(q, limit);
    }),

    route('GET', '/api/v1/tags', () => {
      const tags = ctx.service.db.tagCounts();
      return tags;
    }),

    route('GET', '/api/v1/preview', async ({ query }) => {
      const target = query.get('target') ?? '';
      return (await ctx.service.preview(target)) ?? { notFound: true };
    }),

    route('POST', '/api/v1/assets', async ({ req, query, body }) => {
      const docId = query.get('docId');
      if (!docId) throw new HttpError(400, 'bad-request', '需要 docId');
      const raw = (body as Buffer | null) ?? null;
      if (!raw) throw new HttpError(400, 'bad-request', '需要图片二进制');
      const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
      const filename = query.get('name') ?? 'image';
      return ctx.service.uploadAsset(docId, filename, raw, mime);
    }),

    route('GET', '/api/v1/files', async ({ req, res, query }) => {
      const relPath = query.get('path') ?? '';
      if (!relPath) throw new HttpError(400, 'bad-request', '需要 path');
      const { abs, mime } = ctx.service.resolveAsset(relPath);
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || !stat.isFile()) throw new HttpError(404, 'not-found', '文件不存在');
      const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return '__handled__';
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      });
      await pipeline(fs.createReadStream(abs), res);
      return '__handled__';
    }),

    route('POST', '/api/v1/clip', () => {
      throw new HttpError(501, 'not-implemented', '剪藏（P1）尚未实现');
    }),
  ];

  const devOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/api/v1/events') {
      handleSse(req, res);
      return true;
    }

    const routeMatch = routes
      .map((r) => ({ r, m: r.regex.exec(url.pathname) }))
      .find((x) => x.m && x.r.method === (req.method ?? 'GET'));

    if (!routeMatch || !routeMatch.m) {
      if (url.pathname.startsWith('/api/')) {
        sendJson(req, res, 404, { error: { code: 'not-found', message: `未知接口 ${url.pathname}` } });
        return true;
      }
      return false;
    }

    const params: Record<string, string> = {};
    routeMatch.r.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(routeMatch.m![i + 1]!);
    });

    const { body, raw } = await readBody(req);
    const result = await routeMatch.r.handler({
      req,
      res,
      url,
      params,
      body: body ?? raw,
      query: url.searchParams,
    });
    if (result === '__handled__') return true;
    sendJson(req, res, 200, result ?? { ok: true });
    return true;
  }

  function handleSse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    ctx.hub.add(res);
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        instanceId: ctx.instanceId,
        root: ctx.service.root,
        stats: ctx.service.stats(),
        at: Date.now(),
      })}\n\n`,
    );
    req.on('close', () => ctx.hub.remove(res));
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!ctx.webDist || !fs.existsSync(ctx.webDist)) {
      const html = `<!doctype html><meta charset="utf-8"><title>md-reader</title>
<body style="font-family:system-ui;padding:40px;line-height:1.7">
<h1>前端尚未构建</h1>
<p>开发模式：<code>pnpm dev</code>，然后打开 <code>http://localhost:5173</code>。</p>
<p>或者先构建：<code>pnpm build</code>，再访问本页面。</p>
<p>API 已经就绪：<a href="/api/v1/health">/api/v1/health</a></p>
</body>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP });
      res.end(html);
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const rootAbs = path.resolve(ctx.webDist);
    let filePath = path.resolve(rootAbs, '.' + pathname);
    if (!filePath.startsWith(rootAbs)) {
      sendJson(req, res, 403, { error: { code: 'forbidden', message: '路径越界' } });
      return;
    }

    let stat = await fsp.stat(filePath).catch(() => null);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fsp.stat(filePath).catch(() => null);
    }
    if (!stat?.isFile()) {
      if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
        filePath = path.join(rootAbs, 'index.html');
        stat = await fsp.stat(filePath).catch(() => null);
      }
      if (!stat?.isFile()) {
        sendJson(req, res, 404, { error: { code: 'not-found', message: 'Not found' } });
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const isIndex = path.basename(filePath) === 'index.html';
    const etag = `"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (isIndex) {
      headers['Cache-Control'] = 'no-cache';
      headers['Content-Security-Policy'] = CSP;
    } else {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
      headers.ETag = etag;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return;
      }
    }
    res.writeHead(200, headers);
    await pipeline(fs.createReadStream(filePath), res);
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.port}`);
    const finish = () => {
      if (url.pathname.startsWith('/api/') && !url.pathname.includes('/events')) {
        const ms = Date.now() - started;
        if (ms > 40 || res.statusCode >= 400) {
          console.log(`[http] ${req.method} ${url.pathname} ${res.statusCode} ${ms}ms`);
        }
      }
    };
    res.on('finish', finish);
    parseCookies();

    void (async () => {
      try {
        const origin = req.headers.origin;
        if (origin) {
          const allowed = new Set([
            `http://127.0.0.1:${ctx.port}`,
            `http://localhost:${ctx.port}`,
            ...devOrigins,
          ]);
          if (!allowed.has(origin)) throw new HttpError(403, 'bad-origin', `Origin 不被允许: ${origin}`);
        }
        if (req.method === 'OPTIONS') throw new HttpError(403, 'preflight-denied', '不接受跨源预检');
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          if (req.headers['x-reader-client'] !== '1') {
            throw new HttpError(403, 'missing-client-header', '缺少 X-Reader-Client');
          }
          const ct = String(req.headers['content-type'] ?? '');
          const hasBody =
            Number(req.headers['content-length'] ?? 0) > 0 || Boolean(req.headers['transfer-encoding']);
          const allowedBodyType = ct.includes('application/json') || ct.startsWith('image/');
          if (hasBody && !allowedBodyType) {
            throw new HttpError(415, 'unsupported-media-type', '只接受 application/json 或 image/*');
          }
        }

        if (url.pathname.startsWith('/api/')) {
          const handled = await handleApi(req, res, url);
          if (handled) return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          throw new HttpError(405, 'method-not-allowed', 'Method not allowed');
        }
        await serveStatic(req, res, url);
      } catch (err) {
        sendError(req, res, err);
      }
    })();
  });
}
