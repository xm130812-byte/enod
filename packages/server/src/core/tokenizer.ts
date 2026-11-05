/**
 * 中文检索的分词与 FTS 查询构造。
 * 索引时把正文用 Intl.Segmenter 切成词、空格拼接；同时存 CJK bigram 兜底。
 */
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

function isUsefulToken(token: string): boolean {
  if (!token) return false;
  return /[\p{L}\p{N}]/u.test(token);
}

export function segmentWords(text: string): string[] {
  const out: string[] = [];
  for (const seg of segmenter.segment(normalize(text))) {
    if (!seg.isWordLike) continue;
    const token = seg.segment.trim();
    if (isUsefulToken(token)) out.push(token);
  }
  return out;
}

/** CJK 字符 bigram；非 CJK 连续串不生成 */
export function cjkBigrams(text: string): string[] {
  const out: string[] = [];
  const runs = normalize(text).match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of runs) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

export function dedupe(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

/** 写入 FTS 的正文 token 串（去重后空格拼接） */
export function ftsTokenString(text: string): string {
  return dedupe(segmentWords(text)).join(' ');
}

export function ftsBigramString(text: string): string {
  return dedupe(cjkBigrams(text)).join(' ');
}

function escapeToken(token: string): string {
  return token.replace(/"/g, '""');
}

/** 查询词 → FTS5 MATCH 表达式（词之间 AND） */
export function buildMatchQuery(query: string): string | null {
  const words = dedupe(segmentWords(query)).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  return words.map((w) => `"${escapeToken(w)}"`).join(' AND ');
}

/** bigram 兜底查询（针对 bigrams 列） */
export function buildBigramQuery(query: string): string | null {
  const grams = dedupe(cjkBigrams(query));
  if (grams.length === 0) return null;
  return grams.map((g) => `"${escapeToken(g)}"`).join(' AND ');
}

export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}
