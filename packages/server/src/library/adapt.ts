/**
 * 文档格式适配层（M5 延伸）。
 *
 * 书库里的文件只有一个"标准形态"：markdown 正文。凡是能被转成 markdown 的格式，
 * 后面整条链路（FTS 索引、[[双链]]、目录、阅读器渲染、搜索高亮）都自动复用。
 *
 * 当前的真相源仍然是磁盘上的原文件：
 * - `.md` 天然就是标准形态，直接解析；
 * - 其余格式在这里转换成 markdown，只用于"读"和"搜"，不回写原文件（只读）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as mammoth from 'mammoth';
import { atomicWriteFile } from '../core/atomic.ts';
import { decodeFile } from '../core/encoding.ts';
import { hashBuffer } from '../core/hash.ts';
import { decodeHtml, downloadImage, extractArticle, htmlToMarkdown as fragmentToMarkdown, sniffImageMime } from './clip/extract.ts';

export type DocKind = 'md' | 'txt' | 'sql' | 'html' | 'docx';

/** 单个文档最多本地化多少张图片，避免一次索引把网络拖垮 */
const MAX_LOCAL_IMAGES = 30;

/** 纯文本超过这个长度就只取前一段，避免一次性渲染卡死 */
const MAX_TXT_CHARS = 500_000;

/** SQL 超过这么多行只显示前一段，代码高亮是逐行的，太长会卡 */
const MAX_SQL_LINES = 2_000;

/** docx 转出来的正文上限 */
const MAX_DOCX_CHARS = 800_000;

const EXT_KIND: Record<string, DocKind> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
};

/** 当前参与索引的扩展名（按格式逐个放开，见 docs/FORMATS.md） */
export const INDEX_EXTS = Object.keys(EXT_KIND);

export function kindOf(relPath: string): DocKind | null {
  return EXT_KIND[path.posix.extname(relPath).toLowerCase()] ?? null;
}

/** 能否在阅读器里直接编辑（只有原生 markdown 可以） */
export function isEditable(kind: DocKind | null): boolean {
  return kind === 'md';
}

/** 不认识主文件名里的扩展名时，解析 [[链接]] 要剥掉的后缀 */
export function stripDocExt(name: string): string {
  const ext = path.posix.extname(name).toLowerCase();
  if (ext && EXT_KIND[ext]) return name.slice(0, -ext.length);
  return name;
}

/**
 * 非 md 文档没有 frontmatter 可以存 reader.id，而 index.db 只是可重建的缓存。
 * 用相对路径哈希生成确定性 id，重建索引后身份也不变（md 仍然用 frontmatter 里的 ULID）。
 */
export function derivedDocId(relPath: string): string {
  const digest = createHash('sha1').update(relPath.normalize('NFC')).digest('hex').toUpperCase();
  return `01D${digest.slice(0, 23)}`;
}

export interface DerivedDoc {
  title: string;
  markdown: string;
  warnings: string[];
  /** 代码型文档（sql）整篇在围栏里，扫双链时要跳过 stripFencedCode */
  scanLinksInCode?: boolean;
  /** 二进制格式（docx）：不做编码探测，顶栏也不该显示编码徽标 */
  binary?: boolean;
}

/** 转换结果按"内容哈希"缓存：同一份文件在索引、阅读、搜索摘要之间只转一次 */
const CACHE_LIMIT = 24;
const cache = new Map<string, DerivedDoc>();

function remember(key: string, value: DerivedDoc): DerivedDoc {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return value;
}

/** 非 markdown 文件 → markdown。root 用于把库内本地图片改写成库内相对路径。 */
export async function convertToMarkdown(
  buffer: Buffer,
  absPath: string,
  relPath: string,
  kind: DocKind,
  root: string,
): Promise<DerivedDoc> {
  const key = `${kind}:${hashBuffer(buffer)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (kind === 'html') return remember(key, await htmlToMarkdown(buffer, relPath, absPath, root));
  if (kind === 'sql') return remember(key, sqlToMarkdown(buffer));
  if (kind === 'docx') return remember(key, await docxToMarkdown(buffer, relPath, root));
  if (kind === 'txt') {
    const { text } = decodeFile(buffer);
    const warnings: string[] = [];
    let source = text;
    if (source.length > MAX_TXT_CHARS) {
      // 日志、导出数据这类超长 txt 一次性渲染会卡死，先截断再提示
      source = source.slice(0, MAX_TXT_CHARS);
      warnings.push(`正文超过 ${MAX_TXT_CHARS / 10000} 万字，这里只显示前 ${MAX_TXT_CHARS / 10000} 万字。`);
    }
    return remember(key, {
      title: '',
      markdown: textToMarkdown(source),
      warnings,
    });
  }
  throw new Error(`暂不支持 .${kind} 格式`);
}

/**
 * 纯文本 → markdown：空行分段，单换行保留成硬换行（两个空格）。
 * 这样 80 列硬折行的 txt 不会被 markdown 挤成一个长段落；
 * 代码围栏里的行不动，避免往代码内容里塞尾随空格。
 */
function textToMarkdown(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const char = marker[1]![0]!;
      if (fence === null) {
        fence = char;
        out.push(line);
        continue;
      }
      if (fence === char) {
        fence = null;
        out.push(line);
        continue;
      }
    }
    if (fence !== null || line.trim() === '' || line.endsWith('  ')) {
      out.push(line);
      continue;
    }
    out.push(`${line}  `);
  }
  return out.join('\n');
}

async function htmlToMarkdown(
  buffer: Buffer,
  relPath: string,
  absPath: string,
  root: string,
): Promise<DerivedDoc> {
  const raw = decodeHtml(buffer, 'text/html');
  // 本地 html 没有 http 基准，协议相对地址（//i0.hdslb.com/x.png）会被解析成 file:// 而被丢弃，
  // 提取前统一补成 https://（协议相对地址本来也只在网络协议下才有意义）。
  const html = raw.replace(/(\s(?:src|href|data-src|data-original)=["'])\/\//gi, '$1https://');
  // 本地文件用 file:// 作为解析基准，相对链接才不会丢；之后再把库内路径改回相对
  const base = pathToFileURL(absPath).href;
  const article = extractArticle(html, base);

  const rootUrl = pathToFileURL(path.resolve(root) + path.sep).href;
  // 协议相对地址（//i0.hdslb.com/x.png）在 file:// 基准下会被解析成 file://i0.hdslb.com/x.png，
  // 这里把"带主机名的 file://"还原成 https://，否则整站图片都会被判成库外文件。
  const fixProtocolRelative = (url: string): string => {
    if (!url.startsWith('file://')) return url;
    try {
      const parsed = new URL(url);
      if (!parsed.hostname) return url;
      return `https://${parsed.hostname}${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  };
  const toLibraryPath = (url: string): string | null => {
    if (!url.startsWith(rootUrl)) return null;
    try {
      return decodeURIComponent(url.slice(rootUrl.length)).replace(/\\/g, '/');
    } catch {
      return null;
    }
  };

  // 图片：占位符 mr-image://N → 真实地址。
  // 远程图片下载到 assets/<派生id>/（和剪藏同一套规则），保证断网也能读；失败则退回远程地址。
  const docId = derivedDocId(relPath);
  const assetDir = path.join(root, 'assets', docId);
  const sources = new Map<number, string>();
  for (const image of article.images) sources.set(image.index, fixProtocolRelative(image.url));

  const warnings = [...article.warnings];
  let local = 0;
  let remote = 0;
  let broken = 0;

  const savings = new Map<number, string>();
  const existing = await fs.readdir(assetDir).catch(() => [] as string[]);
  const pending: { index: number; url: string }[] = [];

  for (const [index, url] of sources) {
    if (!url) continue;
    const rel = toLibraryPath(url);
    if (rel) {
      savings.set(index, rel);
      local++;
      continue;
    }
    if (/^https?:/i.test(url)) pending.push({ index, url });
  }

  const toDownload = pending.slice(0, MAX_LOCAL_IMAGES);
  for (const item of pending.slice(MAX_LOCAL_IMAGES)) {
    savings.set(item.index, item.url);
    remote++;
  }
  if (pending.length > MAX_LOCAL_IMAGES) {
    warnings.push(`图片超过 ${MAX_LOCAL_IMAGES} 张，其余保留远程地址。`);
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = toDownload[cursor++];
      if (!item) return;
      const key = createHash('sha1').update(item.url).digest('hex').slice(0, 16);
      const cached = existing.find((name) => name.startsWith(key));
      if (cached) {
        savings.set(item.index, `assets/${docId}/${cached}`);
        local++;
        continue;
      }
      try {
        const host = new URL(item.url).hostname;
        const download = await downloadImage(item.url, `https://${host}/`);
        const name = `${key}${download.ext}`;
        await fs.mkdir(assetDir, { recursive: true });
        await atomicWriteFile(path.join(assetDir, name), download.data, { retries: 1 });
        existing.push(name);
        savings.set(item.index, `assets/${docId}/${name}`);
        local++;
      } catch {
        // 下载失败就保留远程地址，联网时仍然能看
        savings.set(item.index, item.url);
        remote++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, toDownload.length) }, () => worker()));

  let markdown = article.markdown.replace(/!\[([^\]]*)\]\(mr-image:\/\/(\d+)\)/g, (match, alt: string, raw: string) => {
    const index = Number(raw);
    const target = savings.get(index);
    if (!target) {
      broken++;
      return `*[图片](${alt || '未能提取'})*`;
    }
    return `![${alt}](${target})`;
  });

  // 正文里的链接同样把库内 file:// 地址改回相对路径
  markdown = markdown.replace(/\]\((file:\/\/[^)\s]+)\)/g, (match, url: string) => {
    const fixed = fixProtocolRelative(url);
    if (fixed !== url) return `](${fixed})`;
    const rel = toLibraryPath(url);
    return rel ? `](${rel})` : match;
  });

  if (remote > 0) warnings.push(`${remote} 张图片仍是远程地址，断网时不显示。`);
  if (broken > 0) warnings.push(`${broken} 张图片无法解析，已用文字占位。`);
  if (local > 0) warnings.unshift(`图片已本地化到 assets/（${local} 张）。`);

  return {
    title: article.title || path.posix.basename(relPath).replace(/\.html?$/i, ''),
    markdown,
    warnings,
  };
}

/* ------------------------------------------------------------------ SQL */

/**
 * SQL → 一个 ```sql 围栏。代码块自带 Shiki 高亮、行号与复制；
 * 目录为空（除非正文里有注释形式的小节标题），但注释里的 [[双链]] 会被扫描。
 */
function sqlToMarkdown(buffer: Buffer): DerivedDoc {
  const { text } = decodeFile(buffer);
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const warnings: string[] = [];
  let body = normalized;
  if (normalized.split('\n').length > MAX_SQL_LINES) {
    body = normalized.split('\n').slice(0, MAX_SQL_LINES).join('\n');
    warnings.push(`SQL 超过 ${MAX_SQL_LINES} 行，这里只显示前 ${MAX_SQL_LINES} 行。`);
  }
  // 代码里本身含有 ``` 时用更长的围栏，避免提前闭合
  let fence = '```';
  while (body.includes(fence)) fence += '`';
  return {
    title: '',
    markdown: `${fence}sql\n${body.replace(/\n+$/, '')}\n${fence}\n`,
    warnings,
    scanLinksInCode: true,
  };
}

/* ----------------------------------------------------------------- DOCX */

const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/emf': '.emf',
  'image/wmf': '.wmf',
};

/**
 * mammoth 输出的是 <table><tbody><tr><td><p>…</p></td>…，既没有 <thead>/<th>，
 * 单元格里还套着块级 <p>，turndown 的 GFM 表格规则会直接放弃、原样保留 HTML。
 * 这里自己把表格渲染成 GFM 表格：首行当表头。
 */
export function htmlTablesToMarkdown(html: string): string {
  if (!html.includes('<table')) return html;
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (match, inner: string) => {
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rows.length === 0) return match;
    const grid = rows.map((row) =>
      [...row[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => cellText(cell[1]!)),
    );
    const header = grid[0]!;
    if (header.length === 0) return match;
    const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
    const separator = `| ${header.map(() => '---').join(' | ')} |`;
    return ['', line(header), separator, ...grid.slice(1).map(line), ''].join('\n');
  });
}

/** 单元格内联内容：保留链接与粗斜体，其余标签剥掉 */
function cellText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => `[${plain(text)}](${href})`)
    .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>|<b\b[^>]*>([\s\S]*?)<\/b>/gi, (_m, a: string, b: string) => `**${plain(a ?? b)}**`)
    .replace(/<em\b[^>]*>([\s\S]*?)<\/em>|<i\b[^>]*>([\s\S]*?)<\/i>/gi, (_m, a: string, b: string) => `*${plain(a ?? b)}*`)
    .replace(/<\/?p\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|');
}

function plain(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Word → mammoth（纯 JS，不需要 Office）→ HTML → markdown。
 * 标题样式会映射成 # / ## / ###（所以 docx 是有目录的），表格/列表/粗斜体一并保留；
 * 图片从 docx 包里抽出来落到 assets/<派生id>/。
 */
async function docxToMarkdown(buffer: Buffer, relPath: string, root: string): Promise<DerivedDoc> {
  const docId = derivedDocId(relPath);
  const assetDir = path.join(root, 'assets', docId);
  const collected: { data: Buffer; ext: string }[] = [];

  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const data = await image.read();
        const mime = (image.contentType || '').toLowerCase() || sniffImageMime(data);
        const ext = IMAGE_EXT[mime] ?? '.png';
        const index = collected.length;
        collected.push({ data, ext });
        // 占位符先记索引，转成 markdown 之后再替换成真实路径
        return { src: `mr-docx://${index}` };
      }),
    },
  );

  const warnings = result.messages
    .filter((m) => m.type === 'warning' || m.type === 'error')
    .slice(0, 5)
    .map((m) => m.message);

  // turndown 会把 mammoth 的表格原样保留成 HTML，这里在 markdown 上把表格块转成 GFM
  let markdown = htmlTablesToMarkdown(fragmentToMarkdown(result.value));

  if (collected.length > 0) {
    await fs.mkdir(assetDir, { recursive: true });
    const names = await Promise.all(
      collected.map(async (image) => {
        const name = `${hashBuffer(image.data).slice(0, 16)}${image.ext}`;
        await atomicWriteFile(path.join(assetDir, name), image.data, { retries: 1 });
        return name;
      }),
    );
    markdown = markdown.replace(/!\[([^\]]*)\]\(mr-docx:\/\/(\d+)\)/g, (match, alt: string, raw: string) => {
      const name = names[Number(raw)];
      return name ? `![${alt}](assets/${docId}/${name})` : match;
    });
    warnings.unshift(`图片已提取到 assets/（${names.length} 张）。`);
  }

  if (markdown.length > MAX_DOCX_CHARS) {
    markdown = markdown.slice(0, MAX_DOCX_CHARS);
    warnings.push(`正文超过 ${MAX_DOCX_CHARS / 10000} 万字，只显示前 ${MAX_DOCX_CHARS / 10000} 万字。`);
  }

  return { title: '', markdown, warnings, binary: true };
}
