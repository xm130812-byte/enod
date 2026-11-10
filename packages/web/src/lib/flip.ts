import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * 行动画（对齐 DSH 的 AnimatedRows）。
 *
 * 只在「成员或顺序变了」的那一次提交里播动画，其余时刻不动：
 *  · 新增的行淡入 + 轻抬；
 *  · 已有但换了位置的行用 FLIP 从旧位置滑过去；
 *  · 被移除的行留下一份不可交互的幽灵副本在原位淡出，
 *    不延迟 React 卸载，也不撑大滚动容器；
 *  · 首帧、减少动态效果、以及滚动引起的可见区变化都不播。
 *
 * 用法：给容器挂 ref，给每个行元素加 data-flip-key，然后
 *   useRowFlip(ref, 行 id 拼接串, 重置键)；
 * 签名（signature）只用来决定"要不要测量"，真正的位置差来自 getBoundingClientRect。
 */

const EASE_MOVE = 'cubic-bezier(0.4, 0, 0.2, 1)';
const EASE_ENTER = 'cubic-bezier(0.2, 0, 0, 1)';
const DUR_MOVE = 260;
const DUR_ENTER = 220;
const DUR_LEAVE = 200;

type Snap = Map<string, { node: HTMLElement; rect: DOMRect }>;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function nearestScroller(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

function snapshot(root: HTMLElement): Snap {
  const out: Snap = new Map();
  for (const node of root.querySelectorAll<HTMLElement>('[data-flip-key]')) {
    const key = node.dataset.flipKey;
    if (!key) continue;
    out.set(key, { node, rect: node.getBoundingClientRect() });
  }
  return out;
}

/** 复制一份离屏幽灵，淡出后就地销毁。 */
function ghost(node: HTMLElement, rect: DOMRect): void {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.removeAttribute('data-flip-key');
  copy.removeAttribute('data-flip-hover');
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('tabindex', '-1');
  copy.style.cssText += `
    position: fixed;
    left: ${rect.left}px;
    top: ${rect.top}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    margin: 0;
    pointer-events: none;
    z-index: 0;
    contain: layout paint;
  `;
  document.body.appendChild(copy);
  const anim = copy.animate(
    [
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: 'translateY(-4px)' },
    ],
    { duration: DUR_LEAVE, easing: EASE_MOVE, fill: 'both' },
  );
  const dispose = () => copy.remove();
  anim.addEventListener('finish', dispose);
  anim.addEventListener('cancel', dispose);
}

export function useRowFlip(
  ref: RefObject<HTMLElement | null>,
  signature: string,
  resetKey?: string,
): void {
  const prev = useRef<Snap>(new Map());
  const first = useRef(true);
  const reset = useRef(resetKey);
  const scroll = useRef<number | null>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;

    const scroller = nearestScroller(root);
    const top = scroller?.scrollTop ?? null;
    const scrolled = scroll.current !== null && top !== null && Math.abs(top - scroll.current) > 1;
    scroll.current = top;

    const next = snapshot(root);

    if (first.current || reset.current !== resetKey || scrolled || prefersReducedMotion()) {
      first.current = false;
      reset.current = resetKey;
      prev.current = next;
      return;
    }

    // 新增
    for (const [key, item] of next) {
      if (prev.current.has(key)) continue;
      item.node.animate(
        [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: DUR_ENTER, easing: EASE_ENTER },
      );
    }

    // 位移
    for (const [key, item] of next) {
      const before = prev.current.get(key);
      if (!before) continue;
      const dx = before.rect.left - item.rect.left;
      const dy = before.rect.top - item.rect.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      item.node.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: DUR_MOVE, easing: EASE_MOVE },
      );
    }

    // 移除：幽灵淡出
    for (const [key, item] of prev.current) {
      if (next.has(key)) continue;
      ghost(item.node, item.rect);
    }

    prev.current = next;
  }, [ref, signature, resetKey]);
}
