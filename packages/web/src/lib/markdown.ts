/**
 * Markdown rendering pipeline for the reader view.
 *
 * CommonMark + GFM (tables, strikethrough) + task lists + footnotes + KaTeX
 * math + `[[wiki links]]`.  This module is intentionally free of DOM access
 * and CSS imports so it can be unit tested under plain Node as well as bundled
 * by Vite.
 */
import MarkdownIt from 'markdown-it';
import type {
  RendererRule,
  StateBlock,
  StateInline,
  Token,
} from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import katex from 'katex';

export interface WikiResolution {
  href: string; // e.g. "#/doc/01JABC..." or "#/doc/01JABC...#heading-slug"
}

export interface RenderOptions {
  /** Return null when the wiki target does not exist (render as broken link). */
  resolveWiki?: (target: string, anchor?: string) => WikiResolution | null;
}

interface RenderEnv {
  __slugs?: Map<string, number>;
  __resolveWiki?: RenderOptions['resolveWiki'];
}

/**
 * Slug for a heading; stable for CJK, keeps existing latin/digits, strips
 * punctuation.  Uniqueness (`-2`, `-3`, ...) is applied per rendered document
 * by {@link renderMarkdown}; this function is deterministic for one heading.
 */
export function slugifyHeading(text: string): string {
  const base = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return base || 'section';
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
});

md.use(footnote);
// Reader view: checkboxes must not be interactive.  `label: true` wraps the
// item text in a <label> and the plugin adds task-list-item / contains-task-list
// classes for styling.
md.use(taskLists, { enabled: false, label: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExternalHref(href: string): boolean {
  return /^(?:https?:)?\/\//i.test(href.trim());
}

/** Reject dangerous schemes for hrefs that do not go through markdown-it validation. */
function isSafeHref(href: string): boolean {
  const compact = href.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return (
    !compact.startsWith('javascript:') &&
    !compact.startsWith('vbscript:') &&
    !compact.startsWith('data:')
  );
}

/** Plain text of an inline token, used only for heading slugs. */
function inlinePlainText(token: Token | undefined): string {
  if (!token) return '';
  const children = token.children;
  if (!children) return token.content;

  let out = '';
  for (const child of children as Array<Token | null>) {
    if (!child) continue;
    switch (child.type) {
      case 'text':
      case 'code_inline':
      case 'image':
        out += child.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        out += ' ';
        break;
      case 'html_inline':
        out += child.content.replace(/<[^>]*>/g, '');
        break;
      default:
        break;
    }
  }
  return out;
}

function uniqueHeadingSlug(text: string, env: RenderEnv): string {
  const base = slugifyHeading(text);
  if (!env.__slugs) env.__slugs = new Map<string, number>();
  const count = (env.__slugs.get(base) ?? 0) + 1;
  env.__slugs.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
}

function renderMath(expr: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(expr, {
      throwOnError: false,
      displayMode,
      strict: 'ignore',
    });
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return md.utils.escapeHtml(value);
}

// ---------------------------------------------------------------------------
// Wiki links  [[target]] / [[target|display]] / [[target#heading]]
// ---------------------------------------------------------------------------

const wikiInline = (state: StateInline, silent: boolean): boolean => {
  const start = state.pos;
  const src = state.src;
  if (
    src.charCodeAt(start) !== 0x5b /* [ */ ||
    src.charCodeAt(start + 1) !== 0x5b /* [ */
  ) {
    return false;
  }

  const max = state.posMax;
  let end = start + 2;
  while (end < max) {
    const code = src.charCodeAt(end);
    if (code === 0x0a /* \n */ || code === 0x0d /* \r */) return false;
    if (code === 0x5d /* ] */ && src.charCodeAt(end + 1) === 0x5d /* ] */) {
      break;
    }
    end++;
  }
  if (end >= max) return false;

  const inner = src.slice(start + 2, end);
  if (inner === '') return false;

  const pipe = inner.indexOf('|');
  const targetPart = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const displayPart = pipe === -1 ? null : inner.slice(pipe + 1);

  // The target may contain CJK and spaces, but not `|`, `]` or newlines.
  if (
    targetPart === '' ||
    targetPart.includes('|') ||
    targetPart.includes(']') ||
    /[\r\n]/.test(targetPart)
  ) {
    return false;
  }

  const hash = targetPart.indexOf('#');
  const target = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim();
  const rawAnchor = hash === -1 ? '' : targetPart.slice(hash + 1).trim();
  const anchor = rawAnchor === '' ? undefined : rawAnchor;
  if (target === '') return false;

  const display = (displayPart ?? '').trim() || target;

  if (silent) {
    state.pos = end + 2;
    return true;
  }

  let resolution: WikiResolution | null = null;
  const resolver = (state.env as RenderEnv | undefined)?.__resolveWiki;
  if (typeof resolver === 'function') {
    try {
      resolution = resolver(target, anchor);
    } catch {
      resolution = null;
    }
  }

  const resolvedHref =
    resolution &&
    typeof resolution.href === 'string' &&
    resolution.href !== '' &&
    isSafeHref(resolution.href)
      ? resolution.href
      : null;

  if (resolvedHref !== null) {
    const open = state.push('link_open', 'a', 1);
    open.attrs = [
      ['class', 'wiki-link'],
      ['href', resolvedHref],
      ['data-wiki-target', target],
    ];
    if (anchor !== undefined) {
      open.attrs.push(['data-wiki-anchor', anchor]);
    }
    open.meta = { wiki: true };

    const text = state.push('text', '', 0);
    text.content = display;
    state.push('link_close', 'a', -1);
  } else {
    const attrs = [
      'class="wiki-link wiki-broken"',
      `data-wiki-target="${escapeHtml(target)}"`,
    ];
    if (anchor !== undefined) {
      attrs.push(`data-wiki-anchor="${escapeHtml(anchor)}"`);
    }
    attrs.push('title="链接目标不存在"');
    const html = `<a ${attrs.join(' ')}>${escapeHtml(display)}</a>`;
    const token = state.push('html_inline', '', 0);
    token.content = html;
  }

  state.pos = end + 2;
  return true;
};

md.inline.ruler.before('link', 'wiki_link', wikiInline);

// ---------------------------------------------------------------------------
// Math  $...$  /  $$...$$
// ---------------------------------------------------------------------------

function isMathSpace(code: number): boolean {
  return (
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x0b ||
    code === 0x0c
  );
}

const mathInline: (state: StateInline, silent: boolean) => boolean = (
  state,
  silent,
) => {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x24 /* $ */) return false;

  const max = state.posMax;
  if (start + 1 >= max) return false;

  const next = src.charCodeAt(start + 1);
  if (next === 0x24 /* $$ */) {
    // Display math (`$$...$$`) is a block construct; mid-paragraph `$$` is
    // literal so a stray pair is not half-parsed as `$...$`.
    if (!silent) state.pending += '$$';
    state.pos = start + 2;
    return true;
  }
  if (isMathSpace(next)) return false;
  // `$5`, `$10` are currency, not math.
  if (next >= 0x30 && next <= 0x39) return false;

  let end = start + 1;
  while (end < max) {
    const code = src.charCodeAt(end);
    if (code === 0x0a || code === 0x0d) return false;
    if (code === 0x24) {
      let backslashes = 0;
      let k = end - 1;
      while (k > start && src.charCodeAt(k) === 0x5c /* \ */) {
        backslashes++;
        k--;
      }
      if (backslashes % 2 === 0) break;
    }
    end++;
  }
  if (end >= max) return false;
  if (end === start + 1) return false;

  const expr = src.slice(start + 1, end);
  if (expr.trim() === '') return false;
  if (/^\s/.test(expr) || /\s$/.test(expr)) return false;

  if (!silent) {
    const token = state.push('math_inline', 'span', 0);
    token.content = expr;
    token.markup = '$';
  }
  state.pos = end + 1;
  return true;
};

md.inline.ruler.before('link', 'math_inline', mathInline);

const mathBlock = (
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean => {
  const src = state.src;
  const blockStart = state.bMarks[startLine] ?? 0;
  const start = blockStart + (state.tShift[startLine] ?? 0);
  const firstLineEnd = state.eMarks[startLine] ?? start;

  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false;
  if (src.charCodeAt(start) !== 0x24 || src.charCodeAt(start + 1) !== 0x24) {
    return false;
  }
  if (start + 2 > firstLineEnd) return false;
  if (start > blockStart && src.charCodeAt(start - 1) === 0x5c /* \ */) {
    return false;
  }

  let content = '';
  let nextLine = -1;

  const firstRest = src.slice(start + 2, firstLineEnd);
  const sameLineClose = firstRest.indexOf('$$');
  if (sameLineClose !== -1) {
    // A block that opens and closes on one line (`$$x$$`).
    if (firstRest.slice(sameLineClose + 2).trim() !== '') return false;
    content = src.slice(start + 2, start + 2 + sameLineClose);
    nextLine = startLine + 1;
  } else {
    let closeLine = -1;
    let closePos = -1;
    for (let line = startLine + 1; line < endLine; line++) {
      const lineStart = (state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0);
      const lineEnd = state.eMarks[line] ?? lineStart;
      const lineText = src.slice(lineStart, lineEnd);
      const close = lineText.indexOf('$$');
      if (close === -1) continue;
      if (lineText.slice(close + 2).trim() !== '') return false;
      closeLine = line;
      closePos = lineStart + close;
      break;
    }
    if (closeLine === -1) return false;

    // Build the expression line by line from the *adjusted* line marks so
    // container prefixes (`> `, list indentation) never leak into the TeX.
    const parts: string[] = [src.slice(start + 2, firstLineEnd)];
    for (let line = startLine + 1; line <= closeLine; line++) {
      const lineStart = (state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0);
      const segEnd = line === closeLine
        ? closePos
        : (state.eMarks[line] ?? lineStart);
      parts.push(src.slice(lineStart, segEnd));
    }
    content = parts.join('\n');
    nextLine = closeLine + 1;
  }

  if (nextLine === -1) return false;

  const expr = content.trim();
  if (expr === '') return false;
  if (silent) return true;

  const token = state.push('math_block', 'div', 0);
  token.block = true;
  token.content = expr;
  token.markup = '$$';
  token.map = [startLine, nextLine];
  state.line = nextLine;
  return true;
};

md.block.ruler.before('fence', 'math_block', mathBlock, {
  alt: ['paragraph', 'reference', 'blockquote', 'list'],
});

md.renderer.rules.math_inline = (tokens, idx) => {
  const token = tokens[idx];
  if (!token) return '';
  const html = renderMath(token.content, false);
  if (html === null) {
    return `<span class="math math-inline">${escapeHtml(token.content)}</span>`;
  }
  return `<span class="math math-inline">${html}</span>`;
};

md.renderer.rules.math_block = (tokens, idx) => {
  const token = tokens[idx];
  if (!token) return '';
  const html = renderMath(token.content, true);
  if (html === null) {
    return `<div class="math math-block">${escapeHtml(token.content)}</div>\n`;
  }
  return `<div class="math math-block">${html}</div>\n`;
};

// ---------------------------------------------------------------------------
// Headings: stable, deduped ids
// ---------------------------------------------------------------------------

const defaultHeadingOpen: RendererRule = (tokens, idx, options, env, self) =>
  self.renderToken(tokens, idx, options);

md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token && !token.attrGet('id')) {
    const text = inlinePlainText(tokens[idx + 1]);
    token.attrSet('id', uniqueHeadingSlug(text, env as RenderEnv));
  }
  return defaultHeadingOpen(tokens, idx, options, env, self);
};

// ---------------------------------------------------------------------------
// Code blocks: keep markdown-it structure, add reader hooks, no highlighting
// ---------------------------------------------------------------------------

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  if (!token) return '';

  const info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
  const lang = info === '' ? '' : (info.split(/\s+/)[0] ?? '');
  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  const dataLang = lang ? ` data-lang="${escapeHtml(lang)}"` : '';

  return `<pre class="code-block"${dataLang}><code${langClass}>${escapeHtml(
    token.content,
  )}</code></pre>\n`;
};

const defaultCodeBlock: RendererRule = (tokens, idx, options, env, self) =>
  self.renderToken(tokens, idx, options);

md.renderer.rules.code_block = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) token.attrSet('class', 'code-block');
  return defaultCodeBlock(tokens, idx, options, env, self);
};

// ---------------------------------------------------------------------------
// Images: lazy loading + styling class, src left relative
// ---------------------------------------------------------------------------

// Snapshot markdown-it's own image rule: it fills the alt attribute from the
// inline children before rendering the token.
const defaultImage = md.renderer.rules.image as RendererRule;

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    token.attrSet('loading', 'lazy');
    const existing = token.attrGet('class');
    token.attrSet('class', existing ? `${existing} md-image` : 'md-image');
  }
  return defaultImage(tokens, idx, options, env, self);
};

// ---------------------------------------------------------------------------
// Links: external links open in a new tab; hash/internal links untouched
// ---------------------------------------------------------------------------

const defaultLinkOpen: RendererRule = (tokens, idx, options, env, self) =>
  self.renderToken(tokens, idx, options);

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    const href = token.attrGet('href') ?? '';
    if (isExternalHref(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// ---------------------------------------------------------------------------
// Tables: horizontal scroll wrapper
// ---------------------------------------------------------------------------

const defaultTableOpen: RendererRule = (tokens, idx, options, env, self) =>
  self.renderToken(tokens, idx, options);

const defaultTableClose: RendererRule = (tokens, idx, options, env, self) =>
  self.renderToken(tokens, idx, options);

md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
  `<div class="table-wrap">\n${defaultTableOpen(tokens, idx, options, env, self)}`;

md.renderer.rules.table_close = (tokens, idx, options, env, self) =>
  `${defaultTableClose(tokens, idx, options, env, self)}</div>\n`;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Render markdown (CommonMark + GFM tables/strikethrough/task lists + footnotes + $math$ + [[wiki links]]). */
export function renderMarkdown(src: string, options: RenderOptions = {}): string {
  const env: RenderEnv = {
    __slugs: new Map<string, number>(),
    __resolveWiki: options.resolveWiki,
  };
  return md.render(src, env);
}
