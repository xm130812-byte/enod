import { Icon } from './Icons.tsx';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

interface TocListProps {
  items: TocItem[];
  activeId: string | null;
  onJump: (id: string) => void;
  emptyText?: string;
}

/** 目录条目本身，被三栏阅读器与简单视图左栏共用，保证样式一致 */
export function TocList({ items, activeId, onJump, emptyText = '这篇文档还没有标题。' }: TocListProps) {
  if (items.length === 0) {
    return <p className="muted small toc-empty">{emptyText}</p>;
  }
  return (
    <nav className="toc-list">
      {items.map((item) => (
        <button
          key={item.id}
          className={`toc-item level-${item.level} ${activeId === item.id ? 'active' : ''}`}
          onClick={() => onJump(item.id)}
          title={item.text}
        >
          {item.text}
        </button>
      ))}
    </nav>
  );
}

interface TocProps {
  items: TocItem[];
  activeId: string | null;
  onJump: (id: string) => void;
}

/** 复杂视图的三栏目录列 */
export function Toc({ items, activeId, onJump }: TocProps) {
  return (
    <aside className="toc">
      <p className="toc-title">
        <Icon name="list" size={14} /> 目录
      </p>
      <TocList items={items} activeId={activeId} onJump={onJump} />
    </aside>
  );
}
