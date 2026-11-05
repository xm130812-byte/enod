/** 从正文里读出来的链接 / 标题 / 摘要等派生信息（不落盘） */

export interface WikiLinkRef {
  raw: string;
  target: string;
  anchor: string | null;
  display: string | null;
  index: number;
}

const WIKI_RE = /\[\[([^[\]\n|#]{1,200}?)(?:#([^[\]\n|]{1,120}?))?(?:\|([^[\]\n|]{1,200}?))?\]\]/g;

export function extractWikiLinks(body: string): WikiLinkRef[] {
  const out: WikiLinkRef[] = [];
  let m: RegExpExecArray | null;
  WIKI_RE.lastIndex = 0;
  while ((m = WIKI_RE.exec(body))) {
    const target = (m[1] ?? '').trim();
    if (!target) continue;
    out.push({
      raw: m[0],
      target,
      anchor: m[2] ? m[2].trim() : null,
      display: m[3] ? m[3].trim() : null,
      index: m.index,
    });
  }
  return out;
}

export interface HeadingRef {
  level: number;
  text: string;
  slug: string;
  line: number;
}

export function slugifyHeading(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~[\](){}<>]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'section';
}

export function extractHeadings(body: string): HeadingRef[] {
  const out: HeadingRef[] = [];
  const used = new Map<string, number>();
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2]!.trim();
    let slug = slugifyHeading(text);
    const seen = used.get(slug) ?? 0;
    used.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen + 1}`;
    out.push({ level: m[1]!.length, text, slug, line: i });
  }
  return out;
}

/** 粗略去掉行内/块级 Markdown 标记，用于摘要与纯文本定位 */
export function stripMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^[\]|#]*)(?:#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g, (_m, target: string, display?: string) => display || target)
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/^\s*---+\s*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

export function excerptOf(body: string, max = 140): string {
  const plain = stripMarkdown(body).replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  return plain.slice(0, max).trimEnd() + '…';
}

/** 混合中英文的字数：CJK 按字计，拉丁按词计 */
export function countWords(body: string): number {
  const plain = stripMarkdown(body);
  const cjk = plain.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ?? 0;
  const latin = plain.replace(/[\u3400-\u4dbf\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*/g)?.length ?? 0;
  return cjk + latin;
}
