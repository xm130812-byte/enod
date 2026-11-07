import type { CSSProperties } from 'react';
import type { AiEntry } from '../types.ts';
import { FloatCard } from './FloatCard.tsx';
import { AiMarkdown } from './AiMarkdown.tsx';
import { kindLabel } from './AiCard.tsx';
import { Icon } from './Icons.tsx';

interface AiFloatCardProps {
  entry: AiEntry;
  style: CSSProperties;
  pinned?: boolean;
  onPin?: () => void;
  onDragStart?: () => void;
  onMove?: (x: number, y: number) => void;
  onResize?: (size: { w: number; h: number }) => void;
  onClose: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
  onJump: () => void;
  onRerun: () => void;
  onDelete: () => void;
  onOpenPanel: () => void;
  resolveWiki?: (target: string, anchor?: string) => { href: string } | null;
  onNavigateWiki?: (href: string, anchor: string | null) => void;
}

/**
 * AI 产出的浮框：和批注浮框**同一套外壳**（可拖、可钉、可改大小），
 * 内容换成一个徽标 + 原文 + 分析 + 来源 + 操作。
 */
export function AiFloatCard({
  entry,
  style,
  pinned = false,
  onPin,
  onDragStart,
  onMove,
  onResize,
  onClose,
  onEnter,
  onLeave,
  onJump,
  onRerun,
  onDelete,
  onOpenPanel,
  resolveWiki,
  onNavigateWiki,
}: AiFloatCardProps) {
  const when = entry.created ? entry.created.slice(0, 16).replace('T', ' ') : '';
  return (
    <FloatCard
      style={style}
      pinned={pinned}
      variant="ai-card"
      ariaLabel="AI 产出"
      header={
        <>
          <span className="ai-kind">
            <Icon name="sparkle" size={12} /> {kindLabel(entry.kind)}
          </span>
          {entry.status && entry.status !== 'ok' ? <span className="ai-status">{entry.status}</span> : null}
          <span className="ann-card-time">{when}</span>
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
      {entry.exact ? <blockquote className="ai-quote">{entry.exact}</blockquote> : null}
      <AiMarkdown text={entry.output} resolveWiki={resolveWiki} onNavigateWiki={onNavigateWiki} />
      {entry.sources.length > 0 && (
        <div className="ai-sources">
          {entry.sources.map((source, index) => (
            <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer">
              {source.title || source.url}
            </a>
          ))}
        </div>
      )}
      <footer className="ai-foot">
        {entry.exact ? (
          <button className="btn btn-ghost tiny" onClick={onJump}>
            跳到原文
          </button>
        ) : null}
        <button className="btn btn-ghost tiny" onClick={onRerun}>
          重跑
        </button>
        <button className="btn btn-ghost tiny" onClick={onOpenPanel}>
          侧栏
        </button>
        <button className="btn btn-ghost tiny danger" onClick={onDelete}>
          删除
        </button>
        {entry.run?.model ? <span className="ai-model">{entry.run.model}</span> : null}
      </footer>
    </FloatCard>
  );
}
