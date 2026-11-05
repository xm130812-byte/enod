import { Icon } from './Icons.tsx';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

interface TocProps {
  items: TocItem[];
  activeId: string | null;
  onJump: (id: string) => void;
}

export function Toc({ items, activeId, onJump }: TocProps) {
  if (items.length === 0) {
    return (
      <aside className="toc">
        <p className="toc-title">目录</p>
        <p className="muted small">这篇文档还没有标题。</p>
      </aside>
    );
  }
  return (
    <aside className="toc">
      <p className="toc-title">
        <Icon name="list" size={14} /> 目录
      </p>
      <nav>
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
    </aside>
  );
}
