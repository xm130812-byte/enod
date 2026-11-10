import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';

/**
 * 行 hover 信息卡，参数对齐 DSH 的工作区悬浮卡：
 *  · 列表里第一张卡要等 800ms 才出现，避免扫过时乱闪；
 *  · 一旦这个列表已经亮过卡，移到相邻行就立即换卡（不再等）；
 *  · 指针离开两秒后，共享等待重置。
 */

const OPEN_DELAY = 800;
const RESET_GRACE = 320;
const CARD_WIDTH = 288;
const GAP = 10;

export type HoverCardData = {
  title: string;
  path?: string;
  meta?: string[];
};

let shown = false;
let resetTimer: number | undefined;

function markShown(): void {
  shown = true;
  window.clearTimeout(resetTimer);
}

function scheduleReset(): void {
  window.clearTimeout(resetTimer);
  resetTimer = window.setTimeout(() => {
    shown = false;
  }, RESET_GRACE);
}

export function useHoverCard(data: HoverCardData | null) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const anchor = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    window.clearTimeout(openTimer.current);
    openTimer.current = undefined;
    setPos(null);
  }, []);

  const place = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const estimated = 132;
    let left: number;
    let top: number;
    if (rect.right + GAP + CARD_WIDTH <= window.innerWidth) {
      left = rect.right + GAP;
      top = rect.top + rect.height / 2 - estimated / 2;
    } else {
      // 整行铺满时贴不到右边，就落在行下方（空间不够改落上方）
      left = Math.min(Math.max(8, rect.left + 16), window.innerWidth - CARD_WIDTH - 8);
      top = rect.bottom + 6;
      if (top + estimated > window.innerHeight) top = Math.max(8, rect.top - estimated - 6);
    }
    setPos({
      left: Math.max(8, left),
      top: Math.min(Math.max(8, top), Math.max(8, window.innerHeight - estimated)),
    });
  }, []);

  const show = useCallback(() => {
    if (!data) return;
    if (shown) {
      markShown();
      place();
      return;
    }
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => {
      markShown();
      place();
    }, OPEN_DELAY);
  }, [data, place]);

  const hide = useCallback(() => {
    close();
    scheduleReset();
  }, [close]);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
    },
    [],
  );

  // 内容卡在打开时换了行（例如列表重排），跟着重测一次
  useEffect(() => {
    if (!pos) return;
    const onScroll = () => setPos(null);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [pos]);

  const hoverProps = {
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      anchor.current = event.currentTarget;
      show();
    },
    onMouseLeave: hide,
    onBlur: hide,
  };

  const card =
    pos && data
      ? createPortal(
          <div className="hover-card" style={{ left: pos.left, top: pos.top, width: CARD_WIDTH }} role="tooltip">
            <div className="hover-card-title">{data.title}</div>
            {data.path && <div className="hover-card-path">{data.path}</div>}
            {data.meta && data.meta.length > 0 && (
              <div className="hover-card-meta">
                {data.meta.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return { hoverProps, card };
}
