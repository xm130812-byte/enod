import { useCallback, useRef } from 'react';

interface ColumnResizerProps {
  /** 当前列宽（px）。 */
  width: number;
  min: number;
  max: number;
  /** left：列在左侧，向右拖变宽；right：列在右侧，向左拖变宽。 */
  side: 'left' | 'right';
  onChange: (width: number) => void;
  /** 双击恢复默认宽度。 */
  onReset?: () => void;
  label?: string;
}

/**
 * 列的拖拽调整条。绝对定位在列的边界上，拖动时实时回调宽度。
 *
 * 用 pointer capture 而不是 window 监听：指针移出列甚至窗口也不会断，
 * 松手（pointerup / pointercancel）时自动结束。
 */
export function ColumnResizer({ width, min, max, side, onChange, onReset, label }: ColumnResizerProps) {
  const start = useRef<{ x: number; w: number } | null>(null);

  const clamp = useCallback((value: number) => Math.round(Math.min(max, Math.max(min, value))), [min, max]);

  return (
    <div
      className={`col-resizer col-resizer-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? '调整列宽'}
      title={label ? `${label}（双击恢复默认）` : '拖动调整宽度，双击恢复默认'}
      onPointerDown={(event) => {
        event.preventDefault();
        start.current = { x: event.clientX, w: width };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add('col-resizing');
      }}
      onPointerMove={(event) => {
        const anchor = start.current;
        if (!anchor) return;
        const dx = event.clientX - anchor.x;
        onChange(clamp(side === 'left' ? anchor.w + dx : anchor.w - dx));
      }}
      onPointerUp={(event) => {
        if (!start.current) return;
        start.current = null;
        document.body.classList.remove('col-resizing');
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          /* 指针已释放 */
        }
      }}
      onPointerCancel={() => {
        start.current = null;
        document.body.classList.remove('col-resizing');
      }}
      onDoubleClick={() => onReset?.()}
    />
  );
}
