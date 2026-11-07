import { useEffect, useRef } from 'react';
import { Icon } from './Icons.tsx';
import { ColumnResizer } from './ColumnResizer.tsx';

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
  collapsed?: boolean;
  /** 列宽（px）。未传时用 CSS 默认值。 */
  width?: number;
  onResize?: (width: number) => void;
  onResetWidth?: () => void;
  /** 收起目录（收起后由调用方显示展开把手）。 */
  onCollapse?: () => void;
}

/**
 * 复杂视图的三栏目录列：可收起、右边缘可拖拽调宽。
 *
 * 内容放在内层 .toc-scroll 里滚动，拖拽条留在 aside 上——
 * 否则 absolute 子元素会跟着目录内容一起滚走。
 */
export function Toc({ items, activeId, onJump, collapsed = false, width, onResize, onResetWidth, onCollapse }: TocProps) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = ref.current as (HTMLElement & { inert?: boolean }) | null;
    if (node) node.inert = collapsed;
  }, [collapsed]);

  return (
    <aside
      className={`toc ${collapsed ? 'collapsed' : ''}`}
      ref={ref}
      aria-hidden={collapsed}
      style={!collapsed && width ? { width: `${width}px` } : undefined}
    >
      <div className="toc-scroll">
        <p className="toc-title">
          <Icon name="list" size={14} /> 目录
          {onCollapse && (
            <button className="icon-btn toc-collapse" onClick={onCollapse} title="收起目录" aria-label="收起目录">
              <Icon name="chevrons-left" size={13} />
            </button>
          )}
        </p>
        <TocList items={items} activeId={activeId} onJump={onJump} />
      </div>
      {!collapsed && onResize && width ? (
        <ColumnResizer
          width={width}
          min={160}
          max={420}
          side="left"
          onChange={onResize}
          onReset={onResetWidth}
          label="目录宽度"
        />
      ) : null}
    </aside>
  );
}
