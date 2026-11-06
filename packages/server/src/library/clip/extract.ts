/**
 * 网页正文提取：fetch → Readability → 绝对化链接 → Turndown → 干净 Markdown。
 *
 * 图片先替换为 `mr-image://<n>` 占位符，由 LibraryService 下载到
 * `assets/<docId>/` 后再换回本地路径；下载失败则保留原始 https 地址。
 */
import { Readability } from '@mozilla/readability';
import iconv from 'iconv-lite';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { isPrivateHost, normalizeClipUrl, resolveUrl } from './url.ts';

export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 25_000;

export interface FetchOptions {
  allowPrivate?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface FetchedPage {
  html: string;
  finalUrl: string;
  contentType: string;
}

export interface ArticleImage {
  index: number;
  url: string;
  alt: string;
}

export interface ExtractedArticle {
  title: string;
  site: string;
  author: string;
  published: string;
  canonicalUrl: string;
  excerpt: string;
  markdown: string;
  images: ArticleImage[];
  warnings: string[];
}

export interface ImageDownload {
  data: Buffer;
  mime: string;
  ext: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 md-reader/0.1';

const OMIT_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'canvas',
  'nav',
  'aside',
  'footer',
];

/* ------------------------------------------------------------------ fetch */

export async function fetchPage(input: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const normalized = normalizeClipUrl(input, opts.allowPrivate === true);
  if (!normalized) {
    throw new Error(
      opts.allowPrivate ? '不是有效的网页地址' : '不是有效的网页地址，或指向本机/内网地址',
    );
  }

  let current = normalized.url;
  let response: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    response = await fetch(current.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error(`网页返回 ${response.status}，但没有跳转地址`);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error('网页跳转地址无效');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('只支持 http/https 网页');
      if (!opts.allowPrivate && isPrivateHost(next.hostname)) throw new Error('拒绝访问本机/内网地址');
      current = next;
      response = null;
      continue;
    }
    break;
  }

  if (!response) throw new Error('网页跳转次数过多');
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`网页返回 HTTP ${response.status}`);
  }

  const finalUrl = response.url || current.href;
  if (!opts.allowPrivate && isPrivateHost(new URL(finalUrl).hostname)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('拒绝访问本机/内网地址');
  }

  const contentType = response.headers.get('content-type') ?? '';
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  const looksHtml = mime === 'text/html' || mime === 'application/xhtml+xml' || mime === '';
  if (!looksHtml) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`这个地址不是网页（${mime || '未知类型'}）`);
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  const max = opts.maxBytes ?? MAX_PAGE_BYTES;
  if (declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new Error('网页体积过大，已停止抓取');
  }

  const raw = await readLimited(response, max);
  if (raw.length === 0) throw new Error('网页内容为空');
  const html = decodeHtml(raw, contentType);
  if (!html.includes('<') && !html.includes('>')) throw new Error('网页内容不是 HTML');
  return { html, finalUrl, contentType };
}

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('网页体积过大，已停止抓取');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function normalizeCharset(label: string | undefined): string | null {
  if (!label) return null;
  const value = label.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!value) return null;
  if (value === 'gb2312' || value === 'gbk' || value === 'gb18030') return 'gb18030';
  if (value === 'utf8' || value === 'utf-8') return 'utf8';
  if (value === 'utf-16' || value === 'utf-16le' || value === 'utf16le') return 'utf16le';
  if (value === 'big5' || value === 'big5-hkscs') return 'big5';
  return iconv.encodingExists(value) ? value : null;
}

export function decodeHtml(buffer: Buffer, contentType = ''): string {
  const head = buffer.subarray(0, 4096).toString('latin1');
  const fromHeader = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([^"'\s/>]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^"';\s]+)/i.exec(head)?.[1];
  const encoding = normalizeCharset(fromHeader) ?? normalizeCharset(fromMeta) ?? 'utf8';
  let text: string;
  try {
    text = iconv.decode(buffer, encoding);
  } catch {
    text = buffer.toString('utf8');
  }
  return text.replace(/^\uFEFF/, '');
}

/* ------------------------------------------------------------------ extract */

interface ReadabilityArticle {
  title?: string;
  content?: string;
  textContent?: string;
  excerpt?: string;
  byline?: string;
  siteName?: string;
  publishedTime?: string;
  lang?: string;
}

function firstMeta(document: any, selectors: string[]): string {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const value = el?.getAttribute('content') ?? el?.getAttribute('href') ?? el?.getAttribute('datetime');
    if (value && value.trim()) return value.trim();
  }
  return '';
}

function collapse(text: string): string {
  return text.replace(/[\s\u00a0\u3000]+/g, ' ').trim();
}

function absolutize(raw: string, base: string): string {
  if (!raw) return '';
  return resolveUrl(raw, base) ?? '';
}

export function cleanTitle(raw: string, site: string, pageUrl: string): string {
  let title = collapse(raw).replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '');
  const siteKey = collapse(site).toLowerCase();
  const host = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return '';
    }
  })();

  for (const sep of [' - ', ' | ', ' — ', ' – ', ' _ ', ' · ']) {
    const idx = title.lastIndexOf(sep);
    if (idx <= 0) continue;
    const suffix = title.slice(idx + sep.length).trim();
    const suffixKey = suffix.toLowerCase();
    if (suffixKey === siteKey || suffixKey === host || (siteKey && suffixKey.includes(siteKey))) {
      title = title.slice(0, idx).trim();
      break;
    }
  }
  return title.slice(0, 180) || '未命名剪藏';
}

function readMetadata(document: any, pageUrl: string) {
  const ogTitle = firstMeta(document, [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    'meta[name="title"]',
  ]);
  const site = firstMeta(document, [
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
    'meta[name="apple-mobile-web-app-title"]',
  ]);
  const author = firstMeta(document, [
    'meta[name="author"]',
    'meta[property="article:author"]',
    'meta[name="twitter:creator"]',
    'meta[property="og:article:author"]',
  ]);
  const published = firstMeta(document, [
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[itemprop="datePublished"]',
    'time[datetime]',
  ]);
  const description = firstMeta(document, [
    'meta[property="og:description"]',
    'meta[name="description"]',
    'meta[name="twitter:description"]',
  ]);
  const canonicalRaw = firstMeta(document, ['link[rel="canonical"]', 'meta[property="og:url"]']);
  const canonical = absolutize(canonicalRaw, pageUrl) || pageUrl;
  const docTitle = collapse(document.querySelector('title')?.textContent ?? '');
  const h1 = collapse(document.querySelector('h1')?.textContent ?? '');
  const host = (() => {
    try {
      return new URL(pageUrl).hostname.replace(/^www\./i, '');
    } catch {
      return '';
    }
  })();

  return {
    titleRaw: ogTitle || docTitle || h1,
    siteRaw: site || host,
    author: collapse(author).slice(0, 200),
    published: collapse(published).slice(0, 60),
    description: collapse(description).slice(0, 400),
    canonical,
  };
}

function fallbackContent(document: any): string {
  const candidates = ['article', 'main', '[role="main"]', '.article', '.post', '.content', 'body'];
  for (const selector of candidates) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const text = collapse(el.textContent ?? '');
    if (text.length >= 120) return el.innerHTML;
  }
  return document.body?.innerHTML ?? '';
}

function cleanup(root: any): void {
  for (const selector of [...OMIT_TAGS, '[aria-hidden="true"]', '[hidden]']) {
    for (const node of [...root.querySelectorAll(selector)]) node.remove();
  }
  for (const el of root.querySelectorAll('*')) {
    const tag = String(el.tagName).toUpperCase();
    el.removeAttribute('style');
    el.removeAttribute('onclick');
    if (tag === 'CODE' && String(el.getAttribute('class') ?? '').includes('language-')) {
      // 保留语言 class，Turndown 的 GFM 规则靠它生成 ```ts 围栏。
    } else {
      el.removeAttribute('class');
    }
    if (!['A', 'IMG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag)) el.removeAttribute('id');
    if (tag === 'IMG') {
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      el.removeAttribute('loading');
      el.removeAttribute('decoding');
    }
  }
}

function pickSrcset(value: string | null): string {
  if (!value) return '';
  let best = '';
  let bestWeight = -1;
  for (const part of value.split(',')) {
    const [rawUrl, ...descriptors] = part.trim().split(/\s+/);
    if (!rawUrl) continue;
    let weight = 1;
    for (const desc of descriptors) {
      if (desc.endsWith('w')) weight = Number(desc.slice(0, -1)) || 1;
      else if (desc.endsWith('x')) weight = (Number(desc.slice(0, -1)) || 1) * 1000;
    }
    if (weight > bestWeight) {
      bestWeight = weight;
      best = rawUrl;
    }
  }
  return best;
}

function imageUrl(img: any, base: string): string | null {
  const width = Number(img.getAttribute('width') ?? 0);
  const height = Number(img.getAttribute('height') ?? 0);
  if ((width > 0 && width <= 2) || (height > 0 && height <= 2)) return null;

  const candidates = [
    img.getAttribute('data-src'),
    img.getAttribute('data-original'),
    img.getAttribute('data-lazy-src'),
    img.getAttribute('data-actualsrc'),
    img.getAttribute('data-url'),
    img.getAttribute('src'),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const value = raw.trim();
    if (/^data:image\/gif;base64,R0lGOD/i.test(value)) continue;
    const resolved = absolutize(value, base);
    if (resolved) return resolved;
  }
  return absolutize(pickSrcset(img.getAttribute('data-srcset') ?? img.getAttribute('srcset')), base);
}

export function extractArticle(html: string, pageUrl: string): ExtractedArticle {
  const warnings: string[] = [];
  const metaDoc = parseHTML(html).document;
  const meta = readMetadata(metaDoc, pageUrl);
  const title = cleanTitle(meta.titleRaw, meta.siteRaw, pageUrl);

  let article: ReadabilityArticle | null = null;
  try {
    const document = parseHTML(html).document;
    const reader = new Readability(document as never, { charThreshold: 120, keepClasses: true });
    article = reader.parse() as ReadabilityArticle | null;
  } catch (err) {
    warnings.push(`Readability 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }

  let contentHtml = article?.content ?? '';
  if (collapse(article?.textContent ?? '').length < 80) {
    const fallbackDoc = parseHTML(html).document;
    cleanup(fallbackDoc.body);
    contentHtml = fallbackContent(fallbackDoc);
    if (contentHtml) warnings.push('Readability 未提取到足够正文，已回退到 article/main/body。');
  }
  if (!contentHtml) throw new Error('无法从页面中提取正文');

  const fragment = parseHTML(`<!doctype html><html><body>${contentHtml}</body></html>`).document;
  const body = fragment.body;
  cleanup(body);

  for (const anchor of [...body.querySelectorAll('a[href]')]) {
    const href = anchor.getAttribute('href') ?? '';
    if (/^(javascript|vbscript|data|mailto|tel):/i.test(href.trim())) {
      anchor.removeAttribute('href');
      continue;
    }
    if (href.startsWith('#')) {
      anchor.setAttribute('href', `${pageUrl}${href}`);
      continue;
    }
    const absolute = absolutize(href, pageUrl);
    if (absolute) anchor.setAttribute('href', absolute);
    else anchor.removeAttribute('href');
    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
  }

  const images: ArticleImage[] = [];
  const seenImages = new Set<string>();
  for (const img of [...body.querySelectorAll('img')]) {
    const url = imageUrl(img, pageUrl);
    if (!url) {
      img.remove();
      continue;
    }
    let index = seenImages.has(url) ? images.findIndex((item) => item.url === url) : -1;
    if (index === -1) {
      index = images.length;
      images.push({ index, url, alt: collapse(img.getAttribute('alt') ?? '') });
      seenImages.add(url);
    }
    img.setAttribute('src', `mr-image://${index}`);
    img.setAttribute('alt', images[index]!.alt);
  }

  const markdown = cleanMarkdown(htmlToMarkdown(body.innerHTML), title);
  if (collapse(markdown).length < 30) throw new Error('正文提取结果过短，可能是登录页或空白页');

  return {
    title,
    site: meta.siteRaw,
    author: meta.author || collapse(article?.byline ?? ''),
    published: meta.published || collapse(article?.publishedTime ?? ''),
    canonicalUrl: meta.canonical || pageUrl,
    excerpt: collapse(article?.excerpt ?? '') || meta.description,
    markdown,
    images,
    warnings,
  };
}

function makeTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  service.use(gfm);
  service.remove(['script', 'style', 'noscript', 'template']);
  return service;
}

const turndown = makeTurndown();

/** html 片段 → markdown（docx 等本地文档复用同一套 turndown 规则） */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export function cleanMarkdown(raw: string, title = ''): string {
  let text = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const normalize = (value: string) =>
    value
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  if (title) {
    const wanted = normalize(title);
    for (let i = 0; i < 3; i++) {
      const match = /^(#{1,2})\s+(.+)\n+/.exec(text);
      if (!match) break;
      if (normalize(match[2]!) !== wanted) break;
      text = text.slice(match[0].length).trimStart();
    }
  }
  return text ? `${text}\n` : '';
}

/* ------------------------------------------------------------------ images */

export async function downloadImage(
  url: string,
  referer: string,
  opts: FetchOptions & { maxBytes?: number } = {},
): Promise<ImageDownload> {
  const normalized = normalizeClipUrl(url, opts.allowPrivate === true);
  if (!normalized) throw new Error('图片地址无效');
  const response = await fetch(normalized.url.href, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
      Referer: referer,
    },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`图片 HTTP ${response.status}`);
  }
  if (!opts.allowPrivate && isPrivateHost(new URL(response.url).hostname)) {
    await response.body?.cancel().catch(() => {});
    throw new Error('图片指向内网地址');
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new Error('图片过大');
  }
  const data = await readLimited(response, max);
  if (data.length === 0) throw new Error('图片为空');

  const mime = contentType.startsWith('image/') ? contentType : sniffImageMime(data);
  const ext = imageExt(mime) ?? imageExtFromUrl(normalized.url.href);
  if (!mime || !ext) throw new Error('不是可识别的图片');
  if (mime === 'image/svg+xml') throw new Error('跳过 SVG 图片');
  return { data, mime, ext };
}

export function sniffImageMime(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') return 'image/avif';
  return '';
}

function imageExt(mime: string): string | null {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/avif':
      return '.avif';
    default:
      return null;
  }
}

function imageExtFromUrl(url: string): string | null {
  try {
    const ext = new URL(url).pathname.toLowerCase().match(/\.(png|jpe?g|gif|webp|avif)$/)?.[0];
    if (!ext) return null;
    return ext === '.jpeg' ? '.jpg' : ext;
  } catch {
    return null;
  }
}
