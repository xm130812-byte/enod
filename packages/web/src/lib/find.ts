/**
 * 文内查找：在已渲染的文章 DOM 上高亮命中，并提供当前项滚动。
 * 与批注 mark 可以嵌套；关闭时只清理自己的 mark，不动批注。
 */
const SKIP_SELECTOR = 'script,style,button,textarea,.code-copy,.katex-mathml';

function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    if ((node as Text).data.length > 0) nodes.push(node as Text);
    node = walker.nextNode();
  }
  return nodes;
}

export function clearFindMatches(root: HTMLElement): void {
  const marks = [...root.querySelectorAll('mark.find-hit')];
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

export function highlightFindMatches(
  root: HTMLElement,
  rawQuery: string,
  activeIndex: number,
): HTMLElement[] {
  clearFindMatches(root);
  const query = rawQuery.trim();
  if (!query) return [];

  const needle = query.toLowerCase();
  const nodes = collectTextNodes(root);
  const marks: HTMLElement[] = [];

  for (const node of nodes) {
    const text = node.data;
    const lower = text.toLowerCase();
    let index = lower.indexOf(needle);
    if (index === -1) continue;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    while (index !== -1) {
      if (index > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
      const mark = document.createElement('mark');
      mark.className = 'find-hit';
      mark.textContent = text.slice(index, index + query.length);
      fragment.appendChild(mark);
      marks.push(mark);
      cursor = index + query.length;
      index = lower.indexOf(needle, cursor);
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  }

  if (marks.length > 0) {
    const safeIndex = Math.min(Math.max(activeIndex, 0), marks.length - 1);
    const active = marks[safeIndex]!;
    active.classList.add('active');
    active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  return marks;
}
