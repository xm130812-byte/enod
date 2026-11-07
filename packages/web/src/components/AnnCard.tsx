import { useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Annotation } from '../types.ts';
import { formatRelativeTime } from '../lib/format.ts';
import { Icon } from './Icons.tsx';

/** 浮框默认尺寸：横向长方形，够放一段长备注。 */
export const ANN_CARD_DEFAULT = { w: 560, h: 320 };
export const ANN_CARD_MIN = { w: 320, h: 150 };
export const ANN_CARD_MAX = { w: 820, h: 560 };

interface AnnCardProps {
  annotation: Annotation;
  /** 定位 / 尺寸；钉在停靠栏里时只给宽高。 */
  style: CSSProperties;
  pinned?: boolean;
  onPin?: () => void;
  onDragStart?: () => void;
  /** 拖标题栏时实时回调新的视口坐标。 */
  onMove?: (x: number, y: number) => void;
  onClose: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  /** 拖右下角时实时回调新尺寸。 */
  onResize?: (size: { w: number; h: number }) => void;
}

/**
 * 批注浮框：悬浮预览与钉住常驻共用同一个组件。
 *
 * - 正文区可滚动，长备注（比如 DeepSeek 拓展）不会把卡片撑爆；
 * - 右下角可拖动改大小，尺寸由调用方统一保存；
 * - 悬浮态下鼠标移进卡片不关闭，靠外部的 enter/leave 计时器控制。
 */
export function AnnCard({
  annotation,
  style,
  pinned = false,
  onPin,
  onClose,
  onEnter,
  onLeave,
  onResize,
  onDragStart,
  onMove,
}: AnnCardProps) {
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const move = useRef<{ px: number; py: number; left: number; top: number } | null>(null);

  // 滚轮：正文还能滚时让它滚；已经滚到头就把事件拦下来。
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
      w: box?.width ?? ANN_CARD_DEFAULT.w,
      h: box?.height ?? ANN_CARD_DEFAULT.h,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const w = Math.round(Math.min(ANN_CARD_MAX.w, Math.max(ANN_CARD_MIN.w, start.w + (event.clientX - start.x))));
    const h = Math.round(Math.min(ANN_CARD_MAX.h, Math.max(ANN_CARD_MIN.h, start.h + (event.clientY - start.y))));
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
      className={`ann-card ${pinned ? 'pinned' : ''}`}
      ref={cardRef}
      style={style}
      role="dialog"
      aria-label="批注内容"
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
        <span className={`ann-color dot-${annotation.color}`} />
        <span className="ann-card-label">批注</span>
        {annotation.created ? (
          <span className="ann-card-time">{formatRelativeTime(Date.parse(annotation.created))}</span>
        ) : null}
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
        <p className="ann-card-exact">{annotation.exact}</p>
        {annotation.note?.trim() ? (
          <div className="ann-card-note">{annotation.note}</div>
        ) : (
          <p className="ann-card-empty">还没有备注。点一下高亮就能写。</p>
        )}
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
