import type { CSSProperties } from 'react';
import type { Annotation } from '../types.ts';
import { formatRelativeTime } from '../lib/format.ts';
import { FloatCard } from './FloatCard.tsx';

/** 浮框默认尺寸：横向长方形，够放一段长备注。 */
export { FLOAT_CARD_DEFAULT as ANN_CARD_DEFAULT, FLOAT_CARD_MIN as ANN_CARD_MIN, FLOAT_CARD_MAX as ANN_CARD_MAX } from './FloatCard.tsx';

interface AnnCardProps {
  annotation: Annotation;
  /** 定位 / 尺寸；钉住时只给宽高。 */
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
 * 批注浮框：外壳行为（拖 / 钉 / 改大小 / 滚轮）全在 FloatCard 里，
 * 这里只提供内容：色点、原文、备注。
 */
export function AnnCard({ annotation, style, pinned = false, onPin, onClose, onEnter, onLeave, onResize, onDragStart, onMove }: AnnCardProps) {
  return (
    <FloatCard
      style={style}
      pinned={pinned}
      ariaLabel="批注内容"
      header={
        <>
          <span className={`ann-color dot-${annotation.color}`} />
          <span className="ann-card-label">批注</span>
          {annotation.created ? <span className="ann-card-time">{formatRelativeTime(Date.parse(annotation.created))}</span> : null}
        </>
      }
      onPin={onPin}
      onClose={onClose}
      onEnter={onEnter}
      onLeave={onLeave}
      onResize={onResize}
      onDragStart={onDragStart}
      onMove={onMove}
    >
      <p className="ann-card-exact">{annotation.exact}</p>
      {annotation.note?.trim() ? (
        <div className="ann-card-note">{annotation.note}</div>
      ) : (
        <p className="ann-card-empty">还没有备注。点一下高亮就能写。</p>
      )}
    </FloatCard>
  );
}
