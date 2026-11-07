import type { AiEntry } from '../types.ts';
import { kindLabel } from './AiCard.tsx';
import { Icon } from './Icons.tsx';

interface AiPopoverProps {
  entry: AiEntry;
  left: number;
  top: number;
  onEnter: () => void;
  onLeave: () => void;
  onOpenPanel: () => void;
  onDelete: () => void;
}

const WIDTH = 430;
const MAX_HEIGHT = 340;

/**
 * 正文里点/悬停 AI 锚点时冒出来的小浮层。
 *
 * 刻意比批注浮框轻：不拖、不钉、不存尺寸 —— 它只是「这段 AI 说了什么」的快速回看，
 * 真要细读就点「侧栏」，那边有完整卡片和重跑按钮。
 */
export function AiPopover({ entry, left, top, onEnter, onLeave, onOpenPanel, onDelete }: AiPopoverProps) {
  const style = {
    left: Math.max(12, Math.min(left, window.innerWidth - WIDTH - 12)),
    top,
    width: WIDTH,
    maxHeight: MAX_HEIGHT,
  } as const;
  return (
    <div className="ai-pop" style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <header className="ai-head">
        <span className="ai-kind">
          <Icon name="sparkle" size={12} /> {kindLabel(entry.kind)}
        </span>
        {entry.status && entry.status !== 'ok' ? <span className="ai-status">{entry.status}</span> : null}
        <span className="ai-when">{entry.created ? entry.created.slice(0, 16).replace('T', ' ') : ''}</span>
      </header>
      {entry.exact ? <blockquote className="ai-quote">{entry.exact}</blockquote> : null}
      <div className="ai-output">{entry.output}</div>
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
        <button className="btn btn-ghost tiny" onClick={onOpenPanel}>
          侧栏打开
        </button>
        <button className="btn btn-ghost tiny danger" onClick={onDelete}>
          删除
        </button>
        {entry.run?.model ? <span className="ai-model">{entry.run.model}</span> : null}
      </footer>
    </div>
  );
}
