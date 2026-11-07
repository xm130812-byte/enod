import { useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Icon } from './Icons.tsx';

/**
 * 浮框外壳：批注与 AI 产出共用同一套动作 —— 拖标题栏移动、右下角改大小、钉住、关闭。
 *
 * 之前 AI 是一个自绘的小浮层（不拖不钉），和批注两套手感；
 * 现在统一由这个壳提供行为，两个变体只负责各自的内容与配色。
 */

/** 默认尺寸：横向长方形，够放一段长备注 / 一段分析。 */
export const FLOAT_CARD_DEFAULT = { w: 560, h: 320 };
export const FLOAT_CARD_MIN = { w: 320, h: 150 };
export const FLOAT_CARD_MAX = { w: 820, h: 560 };

interface FloatCardProps {
  /** 定位 / 尺寸；钉住时只给宽高。 */
  style: CSSProperties;
  pinned?: boolean;
  /** 变体类名，例如 ai-card；壳自己的类名保持 ann-card 不动，样式零漂移。 */
  variant?: string;
  /** 头部左侧内容：色点/徽标 + 标题 + 时间。 */
  header: ReactNode;
  children: ReactNode;
  ariaLabel: string;
  onClose: () => void;
  onPin?: () => void;
  onDragStart?: () => void;
  /** 拖标题栏时实时回调新的视口坐标。 */
  onMove?: (x: number, y: number) => void;
  /** 拖右下角时实时回调新尺寸。 */
  onResize?: (size: { w: number; h: number }) => void;
  onEnter?: () => void;
  onLeave?: () => void;
}

export function FloatCard({
  style,
  pinned = false,
  variant,
  header,
  children,
  ariaLabel,
  onClose,
  onPin,
  onDragStart,
  onMove,
  onResize,
  onEnter,
  onLeave,
}: FloatCardProps) {
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const move = useRef<{ px: number; py: number; left: number; top: number } | null>(null);

  // 滚轮：正文还能滚时让它滚；已经滚到头就把事件拦下来，别让页面跟着滚（那样会关掉卡片）。
  // 用原生非 passive 监听，React 的 onWheel 在 root 上是 passive，preventDefault 无效。
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onWheel = (event: WheelEvent) => {
      const canScroll = body.scrollHeight > body.clientHeight + 1;
      const atTop = body.scrollTop <= 0;
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
      if (!canScroll || (event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    body.addEventListener('wheel', onWheel, { passive: false });
    return () => body.removeEventListener('wheel', onWheel);
  }, []);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const box = (event.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      w: box?.width ?? FLOAT_CARD_DEFAULT.w,
      h: box?.height ?? FLOAT_CARD_DEFAULT.h,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const w = Math.round(Math.min(FLOAT_CARD_MAX.w, Math.max(FLOAT_CARD_MIN.w, start.w + (event.clientX - start.x))));
    const h = Math.round(Math.min(FLOAT_CARD_MAX.h, Math.max(FLOAT_CARD_MIN.h, start.h + (event.clientY - start.y))));
    onResize?.({ w, h });
  };

  const endResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 已释放 */
    }
  };

  // 拖标题栏移动整张卡；位置夹在视口内
  const startMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const el = cardRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    move.current = { px: event.clientX, py: event.clientY, left: box.left, top: box.top };
    onDragStart?.();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = move.current;
    if (!start) return;
    const x = Math.round(Math.min(window.innerWidth - 80, Math.max(4, start.left + (event.clientX - start.px))));
    const y = Math.round(Math.min(window.innerHeight - 48, Math.max(4, start.top + (event.clientY - start.py))));
    onMove?.(x, y);
  };

  const endMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!move.current) return;
    move.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 已释放 */
    }
  };

  return (
    <div
      className={`ann-card ${pinned ? 'pinned' : ''} ${variant ?? ''}`}
      ref={cardRef}
      style={style}
      role="dialog"
      aria-label={ariaLabel}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className="ann-card-head"
        title="拖动可移动位置"
        onPointerDown={startMove}
        onPointerMove={moveMove}
        onPointerUp={endMove}
        onPointerCancel={endMove}
      >
        {header}
        {onPin && (
          <button
            className={`icon-btn ann-card-btn ${pinned ? 'active' : ''}`}
            onClick={onPin}
            title={pinned ? '取消钉住' : '钉住（最多 3 个，钉住后可继续浏览文章）'}
            aria-label={pinned ? '取消钉住' : '钉住'}
          >
            <Icon name="pin" size={13} />
          </button>
        )}
        <button className="icon-btn ann-card-btn" onClick={onClose} title="关闭" aria-label="关闭">
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ann-card-body" ref={bodyRef}>
        {children}
      </div>

      <div
        className="ann-card-resize"
        title="拖动调整大小"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </div>
  );
}
