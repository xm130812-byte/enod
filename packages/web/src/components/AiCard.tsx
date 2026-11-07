import type { AiEntry } from '../types.ts';
import { Icon } from './Icons.tsx';

const KIND_LABEL: Record<string, string> = {
  explain: '解释',
  verify: '核实',
  background: '补背景',
  counter: '反问',
  summarize: '概括',
  ask: '提问',
};

/** 任务类型的中文标签（侧栏和工具条共用）。 */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

interface AiCardProps {
  entry: AiEntry;
  focused?: boolean;
  onJump: () => void;
  onDelete: () => void;
  onRerun: () => void;
}

/**
 * 侧栏里的一条 AI 产出。刻意不渲染 Markdown：
 * AI 的输出原样保留换行，避免把模型给的半成品结构渲染成正文的一部分。
 */
export function AiCard({ entry, focused = false, onJump, onDelete, onRerun }: AiCardProps) {
  const label = kindLabel(entry.kind);
  const when = entry.created ? entry.created.slice(0, 16).replace('T', ' ') : '';
  return (
    <article className={`ai-item${focused ? ' focused' : ''}`} id={`ai-${entry.id}`}>
      <header className="ai-head">
        <span className="ai-kind">
          <Icon name="sparkle" size={12} /> {label}
        </span>
        {entry.status && entry.status !== 'ok' && <span className="ai-status">{entry.status}</span>}
        <span className="ai-when">{when}</span>
      </header>
      {entry.exact ? (
        <blockquote className="ai-quote" onClick={onJump} title="跳到原文">
          {entry.exact}
        </blockquote>
      ) : null}
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
        {entry.exact ? (
          <button className="btn btn-ghost tiny" onClick={onJump}>
            跳到原文
          </button>
        ) : null}
        <button className="btn btn-ghost tiny" onClick={onRerun} title="用同样的锚点再跑一次">
          重跑
        </button>
        <button className="btn btn-ghost tiny danger" onClick={onDelete}>
          删除
        </button>
        {entry.run?.model ? <span className="ai-model">{entry.run.model}</span> : null}
      </footer>
    </article>
  );
}
