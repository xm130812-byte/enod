/**
 * Typora-like "Live Preview" for CodeMirror 6.
 *
 * The editor keeps editing plain Markdown; this extension only *decorates*
 * the visible part of the document:
 *
 * - Syntax markers (`#`, `**`, `*`, `~~`, backticks, link/image brackets and
 *   URLs) are hidden while the cursor / selection is outside the syntax node,
 *   and revealed as raw source while editing it.
 * - The text itself is styled through the app-provided classes
 *   `cm-lp-h1` … `cm-lp-h6`, `cm-lp-em`, `cm-lp-strong`, `cm-lp-code`,
 *   `cm-lp-strike`, `cm-lp-link`, `cm-lp-wikilink`, `cm-lp-wikilink-broken`
 *   and `cm-lp-quote`.
 * - Images become inline `<img class="cm-lp-img">` widgets, task list items
 *   become clickable checkboxes and wiki links become clickable-looking text.
 *
 * Wiki links carry `data-lp-wikilink` (the page name, without `#anchor`),
 * `data-href` (when `resolveWiki` found the target) and `data-heading`
 * attributes so that click handling can live elsewhere; this extension never
 * dispatches navigation itself. The `#anchor` part is stripped before calling
 * `resolveWiki`, so a resolver only has to know about page names.
 *
 * Only the visible ranges are processed, and everything is rebuilt on
 * `docChanged`, `selectionSet` and `viewportChanged`.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, PluginValue, ViewUpdate } from "@codemirror/view";

export interface LivePreviewOptions {
  /** Map a markdown image src (e.g. "assets/xxx/a.png") to a browser URL. */
  imageUrl?: (src: string) => string;
  /** Map a [[wiki target]] to an href, or null when the target does not exist. */
  resolveWiki?: (target: string) => { href: string } | null;
}

/** The parse tree type, without importing @lezer/common directly. */
type SyntaxTree = ReturnType<typeof syntaxTree>;
/** A stable syntax node, derived from the tree API. */
type SyntaxNode = ReturnType<SyntaxTree["resolveInner"]>;

/* -------------------------------------------------------------------------- */
/* Patterns                                                                   */
/* -------------------------------------------------------------------------- */

/** Lines longer than this are not scanned by the regex fallbacks (perf). */
const MAX_SCAN_LINE = 20_000;

/** `- [ ] item` / `1. [x] item` (the checkbox itself is captured as `[x]`). */
const TASK_RE = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\](?=[ \t]|$)/;

/** `[[target]]`, `[[target|display]]`, `[[target#heading]]`. */
const WIKI_RE = /\[\[([^[\]\n]{1,500})\]\]/g;

/** GFM strikethrough, only used when the parser does not produce the node. */
const STRIKE_RE = /~~([^~\n]+)~~/g;

/** Markdown image syntax, used both anchored and globally. */
const IMAGE_BODY = String.raw`!\[([^\[\]]*)\]\(\s*(?:<([^<>\n]*)>|([^()\s]*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)`;
const IMAGE_AT_RE = new RegExp(`^${IMAGE_BODY}`);
const IMAGE_GLOBAL_RE = new RegExp(IMAGE_BODY, "g");

/* -------------------------------------------------------------------------- */
/* Widgets                                                                    */
/* -------------------------------------------------------------------------- */

/** Inline image replacing `![alt](src)` while the image is not being edited. */
class ImageWidget extends WidgetType {
  readonly src: string;
  readonly alt: string;
  readonly map: ((src: string) => string) | undefined;

  constructor(src: string, alt: string, map: ((src: string) => string) | undefined) {
    super();
    this.src = src;
    this.alt = alt;
    this.map = map;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof ImageWidget && other.src === this.src && other.alt === this.alt;
  }

  override toDOM(_view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-img-wrap";

    let url = this.src;
    if (this.map) {
      try {
        url = this.map(this.src) || this.src;
      } catch {
        url = this.src;
      }
    }

    if (!url) {
      wrap.append(this.broken());
      return wrap;
    }

    const img = document.createElement("img");
    img.className = "cm-lp-img";
    img.alt = this.alt;
    img.loading = "lazy";
    img.draggable = false;
    img.addEventListener("error", () => {
      // Broken image (or a URL the browser refuses to load): show alt text.
      wrap.replaceChildren(this.broken());
    });
    img.src = url;
    wrap.append(img);
    return wrap;
  }

  /** Fallback element shown when the image cannot be loaded. */
  private broken(): HTMLElement {
    const fallback = document.createElement("span");
    fallback.className = "cm-lp-img-alt";
    fallback.textContent = this.alt.trim() || this.src || "image";
    return fallback;
  }

  // Let a click place the cursor inside the image syntax so it can be edited;
  // ignore everything else (drag/drop, typing, …).
  override ignoreEvent(event: Event): boolean {
    return event.type !== "mousedown" && event.type !== "pointerdown";
  }
}

/** Checkbox replacing the `[ ]` / `[x]` of a task list item. */
class TaskWidget extends WidgetType {
  readonly pos: number;
  readonly checked: boolean;

  constructor(pos: number, checked: boolean) {
    super();
    this.pos = pos;
    this.checked = checked;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof TaskWidget && other.pos === this.pos && other.checked === this.checked;
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-checked", this.checked ? "true" : "false");
    box.setAttribute("contenteditable", "false");
    // Keep the editor from moving the caret when the box is pressed.
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    box.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleTask(view, this.pos);
    });
    return box;
  }

  // The widget handles its own clicks; the editor should ignore all events.
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Toggle `[ ]` ↔ `[x]` at the given absolute document position. */
function toggleTask(view: EditorView, pos: number): void {
  const { state } = view;
  if (pos < 0 || pos + 3 > state.doc.length) return;
  const text = state.doc.sliceString(pos, pos + 3);
  if (text.length !== 3 || text.charAt(0) !== "[" || text.charAt(2) !== "]") return;
  const checked = text.charAt(1) !== " ";
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: checked ? " " : "x" },
    userEvent: "input.livePreview.toggleTask",
  });
}

/* -------------------------------------------------------------------------- */
/* Decoration building                                                        */
/* -------------------------------------------------------------------------- */

interface BuildContext {
  readonly state: EditorState;
  readonly options: LivePreviewOptions;
  readonly tree: SyntaxTree;
  readonly ranges: Range<Decoration>[];
  readonly lineClasses: Map<number, Set<string>>;
  readonly hidden: Set<string>;
  readonly imageLines: Set<number>;
  readonly widgetRanges: Set<string>;
  readonly scannedLines: Set<number>;
  readonly strikeLines: Set<number>;
}

/** True when any selection range touches `[from, to]` (inclusive). */
function touches(state: EditorState, from: number, to: number): boolean {
  const ranges = state.selection.ranges;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range) continue;
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

/** Direct children of a node with the given name. */
function directChildren(node: SyntaxNode, name: string): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  let child: SyntaxNode | null = node.firstChild;
  while (child) {
    if (child.name === name) found.push(child);
    child = child.nextSibling;
  }
  return found;
}

/** Does the node contain a descendant with the given name (bounded depth)? */
function hasDescendant(node: SyntaxNode, name: string, depth = 4): boolean {
  let child: SyntaxNode | null = node.firstChild;
  while (child) {
    if (child.name === name) return true;
    if (depth > 0 && hasDescendant(child, name, depth - 1)) return true;
    child = child.nextSibling;
  }
  return false;
}

/**
 * Is the position inside a region where markdown syntax is literal (code
 * spans/blocks, HTML blocks) or inside a link destination? The regex fallbacks
 * skip those.
 */
function isInLiteral(tree: SyntaxTree, pos: number): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  for (let depth = 0; node && depth < 16; depth++) {
    const name = node.name;
    if (
      name === "InlineCode" ||
      name === "FencedCode" ||
      name === "CodeBlock" ||
      name === "CodeText" ||
      name === "CodeInfo" ||
      name === "HTMLBlock" ||
      name === "URL" ||
      name === "LinkTitle"
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

function addLineClass(ctx: BuildContext, lineStart: number, cls: string): void {
  let classes = ctx.lineClasses.get(lineStart);
  if (!classes) {
    classes = new Set<string>();
    ctx.lineClasses.set(lineStart, classes);
  }
  classes.add(cls);
}

function addMark(ctx: BuildContext, from: number, to: number, cls: string, attributes?: Record<string, string>): void {
  if (to <= from) return;
  const max = ctx.state.doc.length;
  const start = Math.max(0, Math.min(from, max));
  const end = Math.max(start, Math.min(to, max));
  if (end <= start) return;
  ctx.ranges.push(
    attributes
      ? Decoration.mark({ class: cls, attributes }).range(start, end)
      : Decoration.mark({ class: cls }).range(start, end),
  );
}

/** Hide a range of source text (never hides line breaks). */
function addHide(ctx: BuildContext, from: number, to: number): void {
  if (to <= from) return;
  const max = ctx.state.doc.length;
  const start = Math.max(0, Math.min(from, max));
  const end = Math.max(start, Math.min(to, max));
  if (end <= start) return;
  if (ctx.state.doc.sliceString(start, end).includes("\n")) return;
  const key = `${start}:${end}`;
  if (ctx.hidden.has(key)) return;
  ctx.hidden.add(key);
  ctx.ranges.push(Decoration.replace({}).range(start, end));
}

/** Replace a range with a widget (deduplicated by position). */
function addWidgetRange(
  ctx: BuildContext,
  from: number,
  to: number,
  widget: WidgetType,
  seen: Set<string>,
): void {
  if (to <= from) return;
  const max = ctx.state.doc.length;
  const start = Math.max(0, Math.min(from, max));
  const end = Math.max(start, Math.min(to, max));
  if (end <= start) return;
  const key = `${start}:${end}`;
  if (seen.has(key)) return;
  seen.add(key);
  ctx.ranges.push(Decoration.replace({ widget }).range(start, end));
}

function headingLevel(name: string): number {
  if (name.startsWith("ATXHeading")) {
    const level = Number(name.slice("ATXHeading".length));
    return Number.isInteger(level) && level >= 1 && level <= 6 ? level : 0;
  }
  if (name === "SetextHeading1") return 1;
  if (name === "SetextHeading2") return 2;
  return 0;
}

function handleHeading(ctx: BuildContext, node: SyntaxNode, level: number): void {
  const line = ctx.state.doc.lineAt(node.from);
  addLineClass(ctx, line.from, `cm-lp-h${level}`);
  if (!node.name.startsWith("ATXHeading")) return; // Setext underlines are left alone.
  if (touches(ctx.state, node.from, node.to)) return;
  for (const mark of directChildren(node, "HeaderMark")) {
    // The mark only covers the `#`s; also hide the spaces that follow them so
    // the heading text is not left with a leading gap.
    addHide(ctx, mark.from, skipSpaces(ctx.state, mark.to));
  }
}

/** End of the run of spaces/tabs starting at `pos` (stays inside the line). */
function skipSpaces(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(Math.min(pos, state.doc.length));
  const offset = pos - line.from;
  const text = line.text;
  let i = offset;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch !== " " && ch !== "\t") break;
    i++;
  }
  return line.from + i;
}

/** `Emphasis`, `StrongEmphasis`, `Strikethrough` and `InlineCode`. */
function handleMarked(ctx: BuildContext, node: SyntaxNode, markName: string, cls: string): void {
  const marks = directChildren(node, markName);
  if (marks.length >= 2) {
    const open = marks[0];
    const close = marks[marks.length - 1];
    if (open && close && close.from > open.to) addMark(ctx, open.to, close.from, cls);
  }
  if (touches(ctx.state, node.from, node.to)) return;
  for (const mark of marks) addHide(ctx, mark.from, mark.to);
}

function handleLink(ctx: BuildContext, node: SyntaxNode): void {
  const doc = ctx.state.doc;
  const raw = doc.sliceString(node.from, node.to);

  // `[[wiki]]` is parsed as an ordinary link around the *inner* `[wiki]`
  // pair, so check the characters just outside the node. The wiki scanner
  // owns those.
  if (
    node.from > 0 &&
    node.to < doc.length &&
    doc.sliceString(node.from - 1, node.from) === "[" &&
    doc.sliceString(node.to, node.to + 1) === "]"
  ) {
    return;
  }
  // `- [x] item`: the task scanner replaces the checkbox.
  if (/^\[[ xX]\]$/.test(raw)) return;

  const marks = directChildren(node, "LinkMark");
  const editing = touches(ctx.state, node.from, node.to);

  // Style the link text. When the link wraps an image the text range is
  // occupied by the image widget, so only hide the surrounding syntax.
  if (marks.length >= 2 && !hasDescendant(node, "Image")) {
    const open = marks[0];
    const close = marks[1];
    if (open && close && close.from > open.to) addMark(ctx, open.to, close.from, "cm-lp-link");
  }

  if (editing) return;
  for (const mark of marks) addHide(ctx, mark.from, mark.to);
  for (const name of ["URL", "LinkTitle", "LinkLabel"]) {
    for (const child of directChildren(node, name)) addHide(ctx, child.from, child.to);
  }
}

function handleImage(ctx: BuildContext, node: SyntaxNode): void {
  ctx.imageLines.add(ctx.state.doc.lineAt(node.from).from);

  const raw = ctx.state.doc.sliceString(node.from, node.to);
  IMAGE_AT_RE.lastIndex = 0;
  const match = IMAGE_AT_RE.exec(raw);

  let alt = "";
  let src = "";
  if (match) {
    alt = match[1] ?? "";
    src = (match[2] ?? match[3] ?? "").trim();
  } else {
    const open = raw.indexOf("[");
    const close = raw.indexOf("]", open + 1);
    if (open >= 0 && close > open) alt = raw.slice(open + 1, close);
    const url = node.getChild("URL");
    if (url) src = ctx.state.doc.sliceString(url.from, url.to).trim();
  }

  if (touches(ctx.state, node.from, node.to)) return;
  addWidgetRange(
    ctx,
    node.from,
    node.to,
    new ImageWidget(src, alt, ctx.options.imageUrl),
    ctx.widgetRanges,
  );
}

function handleQuoteMark(ctx: BuildContext, node: SyntaxNode): void {
  const line = ctx.state.doc.lineAt(node.from);
  addLineClass(ctx, line.from, "cm-lp-quote");
  if (touches(ctx.state, line.from, line.to)) return;
  addHide(ctx, node.from, node.to);
}

function collectNodes(ctx: BuildContext, from: number, to: number): void {
  ctx.tree.iterate({
    from,
    to,
    enter: (ref) => {
      const name = ref.name;
      const level = headingLevel(name);
      if (level > 0) {
        handleHeading(ctx, ref.node, level);
        return;
      }
      switch (name) {
        case "Image":
          handleImage(ctx, ref.node);
          return false;
        case "Link":
          handleLink(ctx, ref.node);
          return;
        case "Emphasis":
          handleMarked(ctx, ref.node, "EmphasisMark", "cm-lp-em");
          return;
        case "StrongEmphasis":
          handleMarked(ctx, ref.node, "EmphasisMark", "cm-lp-strong");
          return;
        case "Strikethrough":
          ctx.strikeLines.add(ctx.state.doc.lineAt(ref.node.from).from);
          handleMarked(ctx, ref.node, "StrikethroughMark", "cm-lp-strike");
          return;
        case "InlineCode":
          handleMarked(ctx, ref.node, "CodeMark", "cm-lp-code");
          return;
        case "QuoteMark":
          handleQuoteMark(ctx, ref.node);
          return;
        default:
          return;
      }
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Regex fallbacks: task lists, wiki links and images the tree did not cover   */
/* -------------------------------------------------------------------------- */

function scanTask(ctx: BuildContext, lineFrom: number, text: string): void {
  const match = TASK_RE.exec(text);
  if (!match) return;
  const prefix = match[1] ?? "";
  const start = lineFrom + prefix.length;
  const end = start + 3;
  if (end > lineFrom + text.length) return;
  if (!touches(ctx.state, lineFrom, lineFrom + text.length)) {
    if (!isInLiteral(ctx.tree, start)) {
      const checked = (match[2] ?? " ") !== " ";
      addWidgetRange(ctx, start, end, new TaskWidget(start, checked), ctx.widgetRanges);
    }
  }
}

function scanWikiLinks(ctx: BuildContext, lineFrom: number, text: string): void {
  WIKI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_RE.exec(text)) !== null) {
    const raw = match[0];
    const inner = match[1] ?? "";
    if (raw.length < 4) continue;
    if (match.index > 0 && text.charAt(match.index - 1) === "\\") continue;

    const start = lineFrom + match.index;
    const end = start + raw.length;
    if (isInLiteral(ctx.tree, start)) continue;
    if (touches(ctx.state, start, end)) continue;

    const pipe = inner.indexOf("|");
    const targetPart = pipe < 0 ? inner : inner.slice(0, pipe);
    const display = pipe < 0 ? null : inner.slice(pipe + 1);
    const hash = targetPart.indexOf("#");
    const target = (hash < 0 ? targetPart : targetPart.slice(0, hash)).trim();
    const heading = hash < 0 ? "" : targetPart.slice(hash + 1).trim();

    let href: string | null = null;
    let resolved = false;
    if (ctx.options.resolveWiki) {
      resolved = true;
      try {
        const result = ctx.options.resolveWiki(target);
        href = result ? result.href : null;
      } catch {
        href = null;
      }
    }

    let cls = "cm-lp-wikilink";
    if (resolved && !href) cls += " cm-lp-wikilink-broken";

    const attributes: Record<string, string> = { "data-lp-wikilink": target };
    if (href) attributes["data-href"] = href;
    if (heading) attributes["data-heading"] = heading;

    const textStart = start + 2;
    const textEnd = end - 2;
    if (display === null) {
      addMark(ctx, textStart, textEnd, cls, attributes);
      addHide(ctx, start, textStart);
      addHide(ctx, textEnd, end);
    } else {
      const displayStart = textStart + pipe + 1;
      addMark(ctx, displayStart, textEnd, cls, attributes);
      addHide(ctx, start, displayStart);
      addHide(ctx, textEnd, end);
    }
  }
}

function scanImages(ctx: BuildContext, lineFrom: number, text: string): void {
  IMAGE_GLOBAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_GLOBAL_RE.exec(text)) !== null) {
    const raw = match[0];
    if (raw.length < 4) continue;
    const start = lineFrom + match.index;
    if (isInLiteral(ctx.tree, start)) continue;
    if (touches(ctx.state, start, start + raw.length)) continue;
    const alt = match[1] ?? "";
    const src = (match[2] ?? match[3] ?? "").trim();
    addWidgetRange(ctx, start, start + raw.length, new ImageWidget(src, alt, ctx.options.imageUrl), ctx.widgetRanges);
  }
}

/** GFM strikethrough, for parsers configured without the GFM extension. */
function scanStrike(ctx: BuildContext, lineFrom: number, text: string): void {
  STRIKE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STRIKE_RE.exec(text)) !== null) {
    const raw = match[0];
    if (raw.length < 5) continue;
    const start = lineFrom + match.index;
    const end = start + raw.length;
    if (isInLiteral(ctx.tree, start)) continue;
    addMark(ctx, start + 2, end - 2, "cm-lp-strike");
    if (touches(ctx.state, start, end)) continue;
    addHide(ctx, start, start + 2);
    addHide(ctx, end - 2, end);
  }
}

function scanLine(ctx: BuildContext, lineFrom: number, text: string): void {
  if (ctx.scannedLines.has(lineFrom)) return;
  ctx.scannedLines.add(lineFrom);
  if (text.length === 0 || text.length > MAX_SCAN_LINE) return;

  scanTask(ctx, lineFrom, text);
  scanWikiLinks(ctx, lineFrom, text);
  if (!ctx.imageLines.has(lineFrom)) scanImages(ctx, lineFrom, text);
  if (!ctx.strikeLines.has(lineFrom)) scanStrike(ctx, lineFrom, text);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function buildDecorations(view: EditorView, options: LivePreviewOptions): DecorationSet {
  const state = view.state;
  const doc = state.doc;
  if (doc.length === 0) return Decoration.none;

  const ctx: BuildContext = {
    state,
    options,
    tree: syntaxTree(state),
    ranges: [],
    lineClasses: new Map<number, Set<string>>(),
    hidden: new Set<string>(),
    imageLines: new Set<number>(),
    widgetRanges: new Set<string>(),
    scannedLines: new Set<number>(),
    strikeLines: new Set<number>(),
  };

  for (const visible of view.visibleRanges) {
    if (visible.to < visible.from) continue;
    collectNodes(ctx, visible.from, visible.to);
    const last = Math.min(visible.to, doc.length);
    let line = doc.lineAt(Math.min(visible.from, doc.length));
    for (;;) {
      scanLine(ctx, line.from, line.text);
      if (line.to >= last || line.number >= doc.lines) break;
      line = doc.line(line.number + 1);
    }
  }

  for (const [lineStart, classes] of ctx.lineClasses) {
    if (classes.size === 0) continue;
    ctx.ranges.push(Decoration.line({ class: Array.from(classes).join(" ") }).range(lineStart));
  }

  if (ctx.ranges.length === 0) return Decoration.none;
  return Decoration.set(ctx.ranges, true);
}

class LivePreviewPlugin implements PluginValue {
  decorations: DecorationSet;
  private readonly options: LivePreviewOptions;

  constructor(view: EditorView, options: LivePreviewOptions) {
    this.options = options;
    this.decorations = buildDecorations(view, options);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      this.decorations = buildDecorations(update.view, this.options);
    }
  }
}

/** Minimal sizing rules; the app owns the actual look and feel. */
const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-img-wrap": { display: "inline" },
  ".cm-lp-img": {
    display: "inline-block",
    maxWidth: "100%",
    maxHeight: "24em",
    verticalAlign: "middle",
    borderRadius: "3px",
  },
  ".cm-lp-img-alt": {
    display: "inline-block",
    padding: "0 0.35em",
    fontStyle: "italic",
    opacity: "0.7",
    border: "1px dashed currentColor",
    borderRadius: "3px",
  },
  ".cm-lp-checkbox": {
    margin: "0 0.35em 0 0",
    verticalAlign: "middle",
    cursor: "pointer",
  },
});

/**
 * Create the Live Preview extension.
 *
 * @param options Callbacks used to resolve image sources and wiki links.
 */
export function createLivePreview(options: LivePreviewOptions = {}): Extension {
  const config: LivePreviewOptions = {
    imageUrl: options.imageUrl,
    resolveWiki: options.resolveWiki,
  };
  const plugin = ViewPlugin.define(
    (view: EditorView, options: LivePreviewOptions) => new LivePreviewPlugin(view, options),
    { decorations: (value) => value.decorations },
  );
  return [plugin.of(config), livePreviewTheme];
}
