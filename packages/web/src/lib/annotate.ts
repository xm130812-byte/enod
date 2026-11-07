import type { ResolvedAnchor } from './reanchor.ts';

export interface TextSpan {
  node: Text;
  start: number;
  end: number;
}

export interface SelectionInfo {
  exact: string;
  prefix: string;
  suffix: string;
  pos: number;
  rect: { left: number; top: number; width: number; height: number };
}

const SKIP_SELECTOR = 'script,style,button,.code-copy,.ann-toolbar,svg,.katex-mathml,.footnote-backref';

export function collectText(root: HTMLElement): { text: string; spans: TextSpan[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const spans: TextSpan[] = [];
  let text = '';
  let node = walker.nextNode();
  while (node) {
    const t = node as Text;
    if (t.data.length > 0) {
      spans.push({ node: t, start: text.length, end: text.length + t.data.length });
      text += t.data;
    }
    node = walker.nextNode();
  }
  return { text, spans };
}

function unwrapMarks(root: HTMLElement): void {
  const marks = root.querySelectorAll('mark.ann');
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
  // AI 锚点标记（正文右侧的小 ✦）也要拆掉，否则重复渲染会越堆越多；
  // 拆完把相邻文本节点合回去，避免每次重渲染都多切一刀
  const chips = root.querySelectorAll('.ai-chip');
  if (chips.length > 0) {
    for (const chip of chips) chip.remove();
    root.normalize();
  }
}

export interface MarkSpec {
  id: string;
  start: number;
  end: number;
  color: string;
}

/** 在已渲染的文章 DOM 上包裹批注高亮；可重复调用，会先清掉旧的 mark */
export function applyMarks(root: HTMLElement, specs: MarkSpec[]): void {
  unwrapMarks(root);
  if (specs.length === 0) return;
  const { spans } = collectText(root);
  if (spans.length === 0) return;

  const sorted = specs
    .filter((s) => s.end > s.start)
    .slice()
    .sort((a, b) => a.start - b.start);

  for (const span of spans) {
    const local: { start: number; end: number; id: string; color: string }[] = [];
    for (const spec of sorted) {
      if (spec.end <= span.start) continue;
      if (spec.start >= span.end) break;
      const start = Math.max(spec.start, span.start) - span.start;
      const end = Math.min(spec.end, span.end) - span.start;
      if (end > start) local.push({ start, end, id: spec.id, color: spec.color });
    }
    if (local.length === 0) continue;

    const node = span.node;
    const data = node.data;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const range of local) {
      if (range.start > cursor) frag.appendChild(document.createTextNode(data.slice(cursor, range.start)));
      const mark = document.createElement('mark');
      mark.className = `ann ann-${range.color}`;
      mark.dataset.annId = range.id;
      mark.textContent = data.slice(Math.max(cursor, range.start), range.end);
      frag.appendChild(mark);
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < data.length) frag.appendChild(document.createTextNode(data.slice(cursor)));
    node.parentNode?.replaceChild(frag, node);
  }
}

function offsetFor(root: HTMLElement, container: Node, offset: number, spans: TextSpan[], text: string): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const span = spans.find((s) => s.node === container);
    if (span) return Math.min(span.end, span.start + offset);
    return null;
  }
  if (container.nodeType === Node.ELEMENT_NODE && root.contains(container)) {
    const children = (container as Element).childNodes;
    const pivot = children[offset] ?? null;
    if (pivot) {
      for (const span of spans) {
        if (span.node === pivot || pivot.contains(span.node)) return span.start;
      }
      // pivot 是最后一个元素之后的位置
      return text.length;
    }
    return text.length;
  }
  return null;
}

/** 取当前选区（必须落在文章容器内）的批注锚点 */
export function getSelectionInfo(root: HTMLElement): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const { text, spans } = collectText(root);
  const start = offsetFor(root, range.startContainer, range.startOffset, spans, text);
  const end = offsetFor(root, range.endContainer, range.endOffset, spans, text);
  if (start === null || end === null || end <= start) return null;

  const exact = text.slice(start, end);
  if (!exact.trim()) return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  return {
    exact,
    prefix: text.slice(Math.max(0, start - 40), start),
    suffix: text.slice(end, end + 40),
    pos: start,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
}

/** 用于把服务端存储的批注重定位到当前 DOM 文本 */
export function markSpecsFromAnchors(resolved: ResolvedAnchor[], colors: Map<string, string>): MarkSpec[] {
  return resolved.map((r) => ({
    id: r.id,
    start: r.start,
    end: r.end,
    color: colors.get(r.id) ?? 'yellow',
  }));
}

export function flashAnnotation(root: HTMLElement, id: string): void {
  const nodes = root.querySelectorAll<HTMLElement>(`[data-ann-id="${CSS.escape(id)}"]`);
  if (nodes.length === 0) return;
  const first = nodes[0]!;
  first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  for (const node of nodes) {
    node.classList.remove('ann-flash');
    // 强制重排后再加 class，保证动画能重播
    void node.offsetWidth;
    node.classList.add('ann-flash');
    window.setTimeout(() => node.classList.remove('ann-flash'), 1400);
  }
}

/**
 * AI 产出在正文里的落点标记：不包裹原文，只在锚点末尾插一个小 ✦。
 *
 * 为什么不套高亮：批注已经占用了 mark，AI 再套一层会互相打架，
 * 而且「AI 说过话的地方」应该比「我划过的线」更轻。
 * 插入顺序从后往前，避免前一次 splitText 把后面的偏移作废。
 */
export function applyAiChips(root: HTMLElement, resolved: ResolvedAnchor[]): void {
  const items = resolved.filter((r) => r.end > 0).slice().sort((a, b) => b.end - a.end);
  if (items.length === 0) return;
  const { spans } = collectText(root);
  for (const item of items) {
    const span = spans.find((s) => item.end > s.start && item.end <= s.end);
    if (!span) continue;
    const local = item.end - span.start;
    const node = span.node;
    const parent = node.parentNode;
    if (!parent) continue;
    const chip = document.createElement('span');
    chip.className = 'ai-chip';
    chip.dataset.aiId = item.id;
    chip.textContent = '✦';
    chip.title = 'AI 在这里留过言';
    let anchor: Text = node;
    if (local > 0 && local < node.data.length) {
      anchor = node.splitText(local);
    } else if (local >= node.data.length) {
      anchor = node;
      parent.insertBefore(chip, anchor.nextSibling);
      continue;
    }
    parent.insertBefore(chip, anchor);
  }
}

/** 让某个 AI 锚点闪一下（从侧栏跳回正文时用）。 */
export function flashAi(root: HTMLElement, aiId: string): void {
  const chip = root.querySelector<HTMLElement>(`.ai-chip[data-ai-id="${CSS.escape(aiId)}"]`);
  if (!chip) return;
  chip.scrollIntoView({ block: 'center', behavior: 'smooth' });
  chip.classList.remove('ai-flash');
  void chip.offsetWidth;
  chip.classList.add('ai-flash');
  window.setTimeout(() => chip.classList.remove('ai-flash'), 1400);
}
