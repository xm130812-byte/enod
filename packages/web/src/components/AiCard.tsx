import type { AiEntry } from '../types.ts';
import { AiMarkdown } from './AiMarkdown.tsx';
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
  /** 把这条 AI 产出写成这一段的批注（有同锚点的批注就追加）。 */
  onToNote?: () => void;
  resolveWiki?: (target: string, anchor?: string) => { href: string } | null;
  onNavigateWiki?: (href: string, anchor: string | null) => void;
}

/**
 * 侧栏里的一条 AI 产出。正文按 Markdown 渲染（模型给的结构不该白写），
 * 但走的是 AI 专用的净化 + 卡片排版，不套正文那套（无图片、无 Shiki）。
 */
export function AiCard({
  entry,
  focused = false,
  onJump,
  onDelete,
  onRerun,
  onToNote,
  resolveWiki,
  onNavigateWiki,
}: AiCardProps) {
  const label = kindLabel(entry.kind);
  const when = entry.created ? entry.created.slice(0, 16).replace('T', ' ') : '';
  return (
    <article className={`ai-item${focused ? ' focused' : ''}`} id={`ai-${entry.id}`} data-flip-key={entry.id}>
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
        <button className="btn btn-ghost tiny" onClick={onRerun} title="用同样的锚点再跑一次">
          重跑
        </button>
        {onToNote && entry.exact ? (
          <button className="btn btn-ghost tiny" onClick={onToNote} title="把这段分析写成这一段的批注">
            <Icon name="note" size={12} /> 记到批注
          </button>
        ) : null}
        <button className="btn btn-ghost tiny danger" onClick={onDelete}>
          删除
        </button>
        {entry.run?.model ? <span className="ai-model">{entry.run.model}</span> : null}
      </footer>
    </article>
  );
}
