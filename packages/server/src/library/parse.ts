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
