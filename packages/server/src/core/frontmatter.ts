/**
 * frontmatter —— 解析与「保字节」局部改写。
 *
 * 设计要点（PRD §3.2）：
 * - 只用 `yaml` 解析，绝不整体重新序列化用户的 frontmatter；
 * - 写回时只替换 `reader:` 下的目标行/块，保留键序、注释、缩进与换行；
 * - 正文与 frontmatter 的字节边界精确记录，正文替换不触碰 frontmatter。
 */
import { parse as parseYaml } from 'yaml';

export interface DocumentLayout {
  text: string;
  eol: '\n' | '\r\n';
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown> | null;
  /** 两条 `---` 之间的 YAML 文本 */
  frontmatterText: string;
  body: string;
  /** 正文在 text 中的起始字符位置 */
  bodyOffset: number;
  /** YAML 文本在 text 中的起始位置（开栅栏行之后） */
  yamlStart: number;
  /** 闭合栅栏行的起始位置 */
  closingFenceStart: number;
  yamlError?: string;
}

export type AnnotationColor = 'yellow' | 'green' | 'blue' | 'pink';
export const ANNOTATION_COLORS: readonly AnnotationColor[] = ['yellow', 'green', 'blue', 'pink'];
export type DocStatus = 'unread' | 'reading' | 'done';
export const DOC_STATUSES: readonly DocStatus[] = ['unread', 'reading', 'done'];

export interface Annotation {
  id: string;
  exact: string;
  prefix: string;
  suffix: string;
  pos: number;
  color: AnnotationColor;
  note: string;
  created: string;
}

export interface SourceInfo {
  url?: string;
  site?: string;
  author?: string;
  published?: string;
  clipped_at?: string;
}

export interface ReaderMeta {
  id: string;
  status: DocStatus;
  progress: number;
  annotations: Annotation[];
}

export function isStatus(value: unknown): value is DocStatus {
  return value === 'unread' || value === 'reading' || value === 'done';
}

export function isColor(value: unknown): value is AnnotationColor {
  return value === 'yellow' || value === 'green' || value === 'blue' || value === 'pink';
}

const FENCE = /^---\s*$/;
const CLOSING = /^(---|\.\.\.)\s*$/;

export function detectEolOf(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r\n' : '\n';
}

function lineStartAfter(text: string, index: number): number {
  const nl = text.indexOf('\n', index);
  return nl === -1 ? text.length : nl + 1;
}

/** 解析整个文件：frontmatter / 正文 / 边界 */
export function parseLayout(text: string): DocumentLayout {
  const eol = detectEolOf(text);
  const firstLineEnd = lineStartAfter(text, 0);
  const firstLine = text.slice(0, firstLineEnd).replace(/\r?\n$/, '');

  if (!FENCE.test(firstLine.trimEnd())) {
    return {
      text,
      eol,
      hasFrontmatter: false,
      frontmatter: null,
      frontmatterText: '',
      body: text,
      bodyOffset: 0,
      yamlStart: 0,
      closingFenceStart: 0,
    };
  }

  let cursor = firstLineEnd;
  let closingStart = -1;
  let closingEnd = text.length;
  while (cursor <= text.length) {
    const next = lineStartAfter(text, cursor);
    const line = text.slice(cursor, next).replace(/\r?\n$/, '');
    if (CLOSING.test(line.trimEnd())) {
      closingStart = cursor;
      closingEnd = next;
      break;
    }
    if (next === cursor) break;
    cursor = next;
  }

  if (closingStart === -1) {
    // 只有开栅栏、没有闭合：视为没有 frontmatter，正文即全文
    return {
      text,
      eol,
      hasFrontmatter: false,
      frontmatter: null,
      frontmatterText: '',
      body: text,
      bodyOffset: 0,
      yamlStart: 0,
      closingFenceStart: 0,
    };
  }

  const frontmatterText = text.slice(firstLineEnd, closingStart);
  let frontmatter: Record<string, unknown> | null = null;
  let yamlError: string | undefined;
  try {
    const parsed = parseYaml(frontmatterText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    } else if (parsed !== null && parsed !== undefined) {
      yamlError = 'frontmatter 不是映射（mapping）';
    }
  } catch (err) {
    yamlError = err instanceof Error ? err.message : String(err);
  }

  return {
    text,
    eol,
    hasFrontmatter: true,
    frontmatter,
    frontmatterText,
    body: text.slice(closingEnd),
    bodyOffset: closingEnd,
    yamlStart: firstLineEnd,
    closingFenceStart: closingStart,
    yamlError,
  };
}

/* ------------------------------------------------------------------ 值格式化 */

export type ScalarValue = string | number | boolean | null | undefined;

const PLAIN_SAFE = /^[A-Za-z0-9_\u3400-\u4dbf\u4e00-\u9fff][A-Za-z0-9_\-. \u3400-\u4dbf\u4e00-\u9fff/]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~', 'True', 'False', 'Null', 'Yes', 'No', 'On', 'Off']);
const NUMBER_LIKE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function formatScalar(value: ScalarValue): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const s = value;
  if (s === '') return '""';
  if (PLAIN_SAFE.test(s) && !RESERVED.has(s) && !NUMBER_LIKE.test(s) && !/^\s|\s$/.test(s)) {
    return s;
  }
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** 拆出 `key: value  # comment` 中的值与前导/尾随空白及注释 */
function splitValueAndComment(rest: string): { lead: string; value: string; comment: string } {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (inDouble) {
      if (ch === '\\') i++;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (rest[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#' && i > 0 && /\s/.test(rest[i - 1]!)) {
      return { lead: '', value: rest.slice(0, i), comment: rest.slice(i) };
    }
  }
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(rest)!;
  return { lead: m[1]!, value: m[2]!, comment: '' };
}

interface KeyLine {
  index: number;
  indent: number;
  key: string;
}

const KEY_RE = /^(\s*)([A-Za-z0-9_$.\-\u3400-\u4dbf\u4e00-\u9fff/]+)\s*:/;
const ITEM_RE = /^(\s*)-\s+(.*)$/;

function indentOf(line: string): number {
  const m = /^\s*/.exec(line)!;
  return m[0].length;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** 解析出 YAML 文本中每个键的位置（用于校验与调试） */
export function listTopLevelKeys(frontmatterText: string): string[] {
  const out: string[] = [];
  for (const line of frontmatterText.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_$.\-]+)\s*:/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * 局部编辑 frontmatter 的 YAML 文本。
 * 所有写入都尽量只改目标行，其余字节原样保留。
 */
export class FrontmatterEditor {
  lines: string[];
  eol: string;

  constructor(frontmatterText: string, eol: string = '\n') {
    this.eol = eol;
    this.lines = frontmatterText.split(/\r?\n/);
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }

  static fromLayout(layout: DocumentLayout): FrontmatterEditor {
    return new FrontmatterEditor(layout.frontmatterText, layout.eol);
  }

  /** 某个键行所管辖的块结束位置（不含） */
  private blockEnd(index: number): number {
    const baseIndent = indentOf(this.lines[index] ?? '');
    for (let i = index + 1; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      if (isBlankOrComment(line)) continue;
      const indent = indentOf(line);
      // 与键同缩进的 `- item` 属于该键的列表块，不能当作块结束
      if (ITEM_RE.test(line) && indent >= baseIndent) continue;
      if (indent <= baseIndent) return i;
    }
    return this.lines.length;
  }

  private findInRange(key: string, from: number, to: number, minIndent: number): KeyLine | null {
    for (let i = from; i < to; i++) {
      const line = this.lines[i]!;
      if (isBlankOrComment(line)) continue;
      const indent = indentOf(line);
      if (indent < minIndent) continue;
      if (ITEM_RE.test(line)) continue;
      const m = KEY_RE.exec(line);
      if (!m) continue;
      if (m[2] === key) return { index: i, indent, key };
    }
    return null;
  }

  /** 查找嵌套键，如 ['reader','status'] */
  findKey(path: string[]): KeyLine | null {
    if (path.length === 0) return null;
    let current: KeyLine | null = null;
    for (let depth = 0; depth < path.length; depth++) {
      const key = path[depth]!;
      const from = current ? current.index + 1 : 0;
      const to = current ? this.blockEnd(current.index) : this.lines.length;
      const minIndent = current ? indentOf(this.lines[current.index]!) + 1 : 0;
      const hit = this.findInRange(key, from, to, minIndent);
      if (!hit) return null;
      current = hit;
    }
    return current;
  }

  /** 子键缩进：取已有兄弟键缩进，否则父缩进 + 2 */
  private childIndent(parentIndex: number): number {
    const parentIndent = indentOf(this.lines[parentIndex]!);
    const end = this.blockEnd(parentIndex);
    for (let i = parentIndex + 1; i < end; i++) {
      const line = this.lines[i]!;
      if (isBlankOrComment(line)) continue;
      if (ITEM_RE.test(line)) continue;
      return indentOf(line);
    }
    return parentIndent + 2;
  }

  /**
   * 确保父级键存在，返回父级 KeyLine（用于插入子项）。
   * path 为空时返回 null，表示顶层。
   */
  private ensureParent(path: string[]): KeyLine | null {
    if (path.length === 0) return null;
    let parent: KeyLine | null = null;
    for (const key of path) {
      const from = parent ? parent.index + 1 : 0;
      const to = parent ? this.blockEnd(parent.index) : this.lines.length;
      const minIndent = parent ? parent.indent + 1 : 0;
      const hit = this.findInRange(key, from, to, minIndent);
      if (hit) {
        parent = hit;
        continue;
      }
      const indent: number = parent ? this.childIndent(parent.index) : 0;
      const insertAt: number = parent ? this.blockEnd(parent.index) : this.lines.length;
      this.lines.splice(insertAt, 0, `${' '.repeat(indent)}${key}:`);
      parent = { index: insertAt, indent, key };
    }
    return parent;
  }

  /** 设置标量。数组路径，如 ['reader','status'] */
  setScalar(path: string[], value: ScalarValue): void {
    if (path.length === 0) return;
    const key = path[path.length - 1]!;
    const hit = this.findKey(path);
    const formatted = formatScalar(value);
    if (hit) {
      const line = this.lines[hit.index]!;
      const colon = line.indexOf(':');
      const keyPart = line.slice(0, colon + 1);
      const rest = line.slice(colon + 1);
      if (ITEM_RE.test(line)) return; // 不支持直接改列表项
      const { lead, comment } = splitValueAndComment(rest);
      const sep = lead.length > 0 ? lead : ' ';
      this.lines[hit.index] = `${keyPart}${sep}${formatted}${comment ? ' ' + comment : ''}`;
      return;
    }
    const parentPath = path.slice(0, -1);
    const parent = this.ensureParent(parentPath);
    if (parent === null) {
      this.lines.push(`${key}: ${formatted}`);
      return;
    }
    const indent = this.childIndent(parent.index);
    const insertAt = this.blockEnd(parent.index);
    this.lines.splice(insertAt, 0, `${' '.repeat(indent)}${key}: ${formatted}`);
  }

  /** 删除键（含其子块） */
  remove(path: string[]): void {
    const hit = this.findKey(path);
    if (!hit) return;
    const end = this.blockEnd(hit.index);
    this.lines.splice(hit.index, end - hit.index);
  }

  /** 替换为对象列表，如 reader.annotations */
  setList(path: string[], items: Record<string, ScalarValue>[]): void {
    if (path.length === 0) return;
    const key = path[path.length - 1]!;
    const hit = this.findKey(path);

    if (hit) {
      const parent = path.length > 1 ? this.findKey(path.slice(0, -1)) : null;
      const indent = parent ? this.childIndent(parent.index) : 0;
      const end = this.blockEnd(hit.index);
      if (items.length === 0) {
        const prefix = `${' '.repeat(indent)}${key}:`;
        this.lines.splice(hit.index, end - hit.index, `${prefix} []`);
        return;
      }
      const generated = this.renderList(key, indent, items);
      this.lines.splice(hit.index, end - hit.index, ...generated);
      return;
    }

    const parent = this.ensureParent(path.slice(0, -1));
    const indent = parent ? this.childIndent(parent.index) : 0;
    const insertAt = parent ? this.blockEnd(parent.index) : this.lines.length;
    if (items.length === 0) {
      this.lines.splice(insertAt, 0, `${' '.repeat(indent)}${key}: []`);
      return;
    }
    this.lines.splice(insertAt, 0, ...this.renderList(key, indent, items));
  }

  private renderList(key: string, indent: number, items: Record<string, ScalarValue>[]): string[] {
    const pad = ' '.repeat(indent);
    const out: string[] = [`${pad}${key}:`];
    const itemPad = ' '.repeat(indent + 2);
    const keyPad = ' '.repeat(indent + 4);
    for (const item of items) {
      const entries = Object.entries(item);
      if (entries.length === 0) {
        out.push(`${itemPad}- {}`);
        continue;
      }
      entries.forEach(([k, v], idx) => {
        const prefix = idx === 0 ? `${itemPad}- ` : keyPad;
        out.push(`${prefix}${k}: ${formatScalar(v)}`);
      });
    }
    return out;
  }

  /** 写成内联数组：`tags: [a, b]`（同时清掉旧的块风格列表） */
  setFlowList(path: string[], values: string[]): void {
    if (path.length === 0) return;
    const key = path[path.length - 1]!;
    const formatted = `[${values.map((v) => formatScalar(v)).join(', ')}]`;
    const hit = this.findKey(path);
    if (!hit) {
      const parent = this.ensureParent(path.slice(0, -1));
      const indent = parent ? this.childIndent(parent.index) : 0;
      const insertAt = parent ? this.blockEnd(parent.index) : this.lines.length;
      this.lines.splice(insertAt, 0, `${' '.repeat(indent)}${key}: ${formatted}`);
      return;
    }
    const line = this.lines[hit.index]!;
    const colon = line.indexOf(':');
    const keyPart = line.slice(0, colon + 1).replace(/\s+$/, '');
    this.lines[hit.index] = `${keyPart} ${formatted}`;
    const end = this.blockEnd(hit.index);
    if (end > hit.index + 1) this.lines.splice(hit.index + 1, end - hit.index - 1);
  }

  render(): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.eol) + this.eol;
  }
}

/* ------------------------------------------------------------------ 文档级工具 */

export interface ReaderPatch {
  status?: DocStatus;
  progress?: number;
  annotations?: Annotation[];
  id?: string;
}

/** 用编辑后的 frontmatter 文本重组整个文件 */
export function replaceFrontmatter(layout: DocumentLayout, yamlText: string, text: string = layout.text): string {
  return text.slice(0, layout.yamlStart) + yamlText + text.slice(layout.closingFenceStart);
}

/** 生成一条全新的 frontmatter（仅用于新建文档） */
export function buildFrontmatter(fields: {
  title: string;
  id: string;
  status?: DocStatus;
  tags?: string[];
  aliases?: string[];
  created?: string;
  source?: SourceInfo;
}): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${formatScalar(fields.title)}`);
  lines.push(`tags: [${(fields.tags ?? []).map((t) => formatScalar(t)).join(', ')}]`);
  if (fields.aliases && fields.aliases.length > 0) {
    lines.push(`aliases: [${fields.aliases.map((t) => formatScalar(t)).join(', ')}]`);
  }
  lines.push(`created: ${fields.created ?? new Date().toISOString()}`);
  if (fields.source) {
    lines.push('source:');
    for (const [k, v] of Object.entries(fields.source)) {
      if (v === undefined || v === null || v === '') continue;
      lines.push(`  ${k}: ${formatScalar(v)}`);
    }
  }
  lines.push('reader:');
  lines.push(`  id: ${fields.id}`);
  lines.push(`  status: ${fields.status ?? 'unread'}`);
  lines.push('  progress: 0');
  lines.push('  annotations: []');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/** 读取 reader 元数据并做兼容/纠偏 */
export function readReaderMeta(frontmatter: Record<string, unknown> | null, fallbackId: string): ReaderMeta {
  const reader = (frontmatter?.reader ?? {}) as Record<string, unknown>;
  const rawId = typeof reader.id === 'string' && reader.id.trim() ? reader.id.trim() : fallbackId;
  const status = isStatus(reader.status) ? reader.status : 'unread';
  const progressRaw = typeof reader.progress === 'number' ? reader.progress : Number(reader.progress ?? 0);
  const progress = Number.isFinite(progressRaw) ? Math.min(1, Math.max(0, progressRaw)) : 0;
  const rawAnnotations = Array.isArray(reader.annotations) ? reader.annotations : [];
  const annotations: Annotation[] = [];
  for (const raw of rawAnnotations) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.exact !== 'string' || a.exact.length === 0) continue;
    annotations.push({
      id: typeof a.id === 'string' && a.id ? a.id : `ann-${annotations.length + 1}`,
      exact: a.exact,
      prefix: typeof a.prefix === 'string' ? a.prefix : '',
      suffix: typeof a.suffix === 'string' ? a.suffix : '',
      pos: typeof a.pos === 'number' && Number.isFinite(a.pos) ? a.pos : 0,
      color: isColor(a.color) ? a.color : 'yellow',
      note: typeof a.note === 'string' ? a.note : '',
      created: typeof a.created === 'string' ? a.created : '',
    });
  }
  return { id: rawId, status, progress, annotations };
}

export function readTags(frontmatter: Record<string, unknown> | null): string[] {
  const raw = frontmatter?.tags;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== 'string') return;
    for (const part of v.split(/[,，]/)) {
      const t = part.trim().replace(/^#/, '');
      if (t && !out.includes(t)) out.push(t);
    }
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  return out;
}

export function readAliases(frontmatter: Record<string, unknown> | null): string[] {
  const raw = frontmatter?.aliases ?? frontmatter?.alias;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else push(raw);
  return out;
}

export function readTitle(frontmatter: Record<string, unknown> | null): string | null {
  const t = frontmatter?.title;
  if (typeof t === 'string' && t.trim()) return t.trim();
  return null;
}

export function readCreated(frontmatter: Record<string, unknown> | null): string | null {
  const c = frontmatter?.created ?? frontmatter?.date;
  if (typeof c === 'string' && c.trim()) return c.trim();
  if (c instanceof Date) return c.toISOString();
  return null;
}

export function readSource(frontmatter: Record<string, unknown> | null): SourceInfo | null {
  const raw = frontmatter?.source;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const pick = (k: string): string | undefined => (typeof s[k] === 'string' ? (s[k] as string) : undefined);
  const info: SourceInfo = {
    url: pick('url'),
    site: pick('site'),
    author: pick('author'),
    published: pick('published'),
    clipped_at: pick('clipped_at'),
  };
  return Object.values(info).some((v) => v) ? info : null;
}

/**
 * 在一次保存中同时应用：正文替换 + reader 字段补丁。
 * 不改变原 frontmatter 的其余部分。
 */
export function applyDocumentEdits(
  layout: DocumentLayout,
  edits: { body?: string; reader?: ReaderPatch; title?: string; tags?: string[] },
): string {
  let current = layout;

  if (!current.hasFrontmatter) {
    const fm = buildFrontmatter({
      title: edits.title ?? '未命名',
      id: edits.reader?.id ?? 'unknown',
      status: edits.reader?.status,
    });
    const text = applyEolText(fm, current.eol) + current.body;
    current = parseLayout(text);
  }

  const yamlEditor = FrontmatterEditor.fromLayout(current);

  if (edits.title !== undefined) yamlEditor.setScalar(['title'], edits.title);
  if (edits.tags !== undefined) yamlEditor.setFlowList(['tags'], edits.tags);

  if (edits.reader) {
    if (edits.reader.id) yamlEditor.setScalar(['reader', 'id'], edits.reader.id);
    if (edits.reader.status) yamlEditor.setScalar(['reader', 'status'], edits.reader.status);
    if (typeof edits.reader.progress === 'number') {
      yamlEditor.setScalar(['reader', 'progress'], roundProgress(edits.reader.progress));
    }
    if (edits.reader.annotations) {
      yamlEditor.setList(
        ['reader', 'annotations'],
        edits.reader.annotations.map((a) => ({
          id: a.id,
          exact: a.exact,
          prefix: a.prefix,
          suffix: a.suffix,
          pos: a.pos,
          color: a.color,
          note: a.note,
          created: a.created,
        })),
      );
    }
  }

  const head = current.text.slice(0, current.yamlStart);
  const closing = current.text.slice(current.closingFenceStart, current.bodyOffset);
  const body = edits.body !== undefined ? applyEolText(edits.body, current.eol) : current.body;
  return head + yamlEditor.render() + closing + body;
}

function applyEolText(text: string, eol: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}

function roundProgress(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
}

