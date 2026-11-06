import path from 'node:path';
import { decodeFile } from '../core/encoding.ts';
import type { FileEncoding } from '../core/encoding.ts';
import { hashBuffer } from '../core/hash.ts';
import {
  parseLayout,
  readAliases,
  readCreated,
  readReaderMeta,
  readSource,
  readTags,
  readTitle,
} from '../core/frontmatter.ts';
import type { Annotation, DocumentLayout, DocStatus, SourceInfo } from '../core/frontmatter.ts';
import {
  countWords,
  excerptOf,
  extractHeadings,
  extractWikiLinks,
} from '../core/markdown.ts';
import type { HeadingRef } from '../core/markdown.ts';
import { ftsBigramString, ftsTokenString } from '../core/tokenizer.ts';
import type { DocRecord } from '../store/db.ts';

export interface ParsedDocFile {
  relPath: string;
  buffer: Buffer;
  mtime: number;
  size: number;
  hash: string;
  encoding: FileEncoding;
  eol: '\n' | '\r\n';
  layout: DocumentLayout;
  frontmatter: Record<string, unknown> | null;
  body: string;
  title: string;
  tags: string[];
  aliases: string[];
  status: DocStatus;
  progress: number;
  annotations: Annotation[];
  /** frontmatter 里的 reader.id，可能为空 */
  readerId: string | null;
  created: string | null;
  source: SourceInfo | null;
  words: number;
  excerpt: string;
  headings: HeadingRef[];
  links: { dstRaw: string; dstAnchor: string | null }[];
  record: DocRecord;
}

/** 去掉围栏代码块，避免把示例里的 [[链接]] 当成真链接 */
export function stripFencedCode(body: string): string {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const marker = m[1]![0]!;
      if (fence === null) {
        fence = marker;
        out.push('');
        continue;
      }
      if (fence === marker) {
        fence = null;
        out.push('');
        continue;
      }
    }
    out.push(fence === null ? line : '');
  }
  return out.join('\n');
}

export function parseDocBuffer(relPath: string, buffer: Buffer, mtime: number, size: number): ParsedDocFile {
  const { text, encoding, eol } = decodeFile(buffer);
  const layout = parseLayout(text);
  const fm = layout.frontmatter;
  const headings = extractHeadings(layout.body);
  const titleFromFm = readTitle(fm);
  const title =
    titleFromFm ??
    headings[0]?.text ??
    path.basename(relPath).replace(/\.md$/i, '') ??
    relPath;
  const tags = readTags(fm);
  const aliases = readAliases(fm);
  const meta = readReaderMeta(fm, '');
  const readerId = meta.id && meta.id !== '' ? meta.id : null;
  const created = readCreated(fm);
  const source = readSource(fm);
  const words = countWords(layout.body);
  const excerpt = excerptOf(layout.body);
  const hash = hashBuffer(buffer);

  const bodyForLinks = stripFencedCode(layout.body);
  const seen = new Set<string>();
  const links: { dstRaw: string; dstAnchor: string | null }[] = [];
  for (const ref of extractWikiLinks(bodyForLinks)) {
    const key = `${ref.target}\u0000${ref.anchor ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ dstRaw: ref.target, dstAnchor: ref.anchor });
  }

  const notesTokens = ftsTokenString(
    meta.annotations.map((a) => `${a.note} ${a.exact}`).join(' \n '),
  );

  const record: DocRecord = {
    id: readerId ?? '',
    relPath,
    mtime,
    size,
    hash,
    title,
    tags,
    aliases,
    status: meta.status,
    progress: meta.progress,
    words,
    excerpt,
    sourceUrl: source?.url ?? null,
    encoding,
    eol,
    created,
    indexedAt: Date.now(),
    annCount: meta.annotations.length,
    titleTokens: ftsTokenString(`${title} ${aliases.join(' ')}`),
    bodyTokens: ftsTokenString(layout.body),
    tagsTokens: ftsTokenString(tags.join(' ')),
    notesTokens,
    bigrams: ftsBigramString(`${title} ${layout.body}`),
  };

  return {
    relPath,
    buffer,
    mtime,
    size,
    hash,
    encoding,
    eol,
    layout,
    frontmatter: fm,
    body: layout.body,
    title,
    tags,
    aliases,
    status: meta.status,
    progress: meta.progress,
    annotations: meta.annotations,
    readerId,
    created,
    source,
    words,
    excerpt,
    headings,
    links,
    record,
  };
}

/**
 * 非 markdown 文件：原文件只读，正文来自格式适配层转换出来的 markdown。
 * 没有 frontmatter，所以状态 / 标签 / 批注一律取默认值；hash 仍然按原始字节算，
 * 这样外部改动能被增量索引发现。
 */
export function parseDerivedDoc(
  relPath: string,
  buffer: Buffer,
  mtime: number,
  size: number,
  derived: { title: string; markdown: string; scanLinksInCode?: boolean; binary?: boolean },
): ParsedDocFile {
  // 二进制格式没有"文本编码"这回事，探测出来只会是乱猜（docx 会被判成 GB18030）
  const { encoding, eol } = derived.binary ? { encoding: 'utf8' as FileEncoding, eol: '\n' as const } : decodeFile(buffer);
  const body = derived.markdown;
  const headings = extractHeadings(body);
  const title =
    (derived.title || '').trim() ||
    headings[0]?.text ||
    path.basename(relPath).replace(/\.[^.]+$/, '') ||
    relPath;
  const hash = hashBuffer(buffer);
  // 代码型文档整篇在围栏里，stripMarkdown 会把内容也算作代码而记 0 字，这里先去掉围栏行
  const words = countWords(derived.scanLinksInCode ? body.replace(/^```[\w-]*$/gm, '') : body);
  const excerpt = excerptOf(body);

  const seen = new Set<string>();
  const links: { dstRaw: string; dstAnchor: string | null }[] = [];
  // 代码型文档（sql）整篇都在围栏里，注释是双链唯一的落脚点，不能 strip
  const linkSource = derived.scanLinksInCode ? body : stripFencedCode(body);
  for (const ref of extractWikiLinks(linkSource)) {
    const key = `${ref.target}\u0000${ref.anchor ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ dstRaw: ref.target, dstAnchor: ref.anchor });
  }

  const layout: DocumentLayout = {
    text: body,
    eol,
    hasFrontmatter: false,
    frontmatter: null,
    frontmatterText: '',
    body,
    bodyOffset: 0,
    yamlStart: 0,
    closingFenceStart: 0,
  };

  const record: DocRecord = {
    id: '',
    relPath,
    mtime,
    size,
    hash,
    title,
    tags: [],
    aliases: [],
    status: 'unread',
    progress: 0,
    words,
    excerpt,
    sourceUrl: null,
    encoding,
    eol,
    created: null,
    indexedAt: Date.now(),
    annCount: 0,
    titleTokens: ftsTokenString(title),
    bodyTokens: ftsTokenString(body),
    tagsTokens: '',
    notesTokens: '',
    bigrams: ftsBigramString(`${title} ${body}`),
  };

  return {
    relPath,
    buffer,
    mtime,
    size,
    hash,
    encoding,
    eol,
    layout,
    frontmatter: null,
    body,
    title,
    tags: [],
    aliases: [],
    status: 'unread',
    progress: 0,
    annotations: [],
    readerId: null,
    created: null,
    source: null,
    words,
    excerpt,
    headings,
    links,
    record,
  };
}
