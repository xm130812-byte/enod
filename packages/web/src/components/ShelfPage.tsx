import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocStatus, DocSummary } from '../types.ts';
import { useLibrary } from '../hooks/useLibrary.tsx';
import { useToast } from '../hooks/useToast.tsx';
import { api } from '../api.ts';
import { basename, dirOf, formatPercent, formatRelativeTime, formatWords, statusLabel } from '../lib/format.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';
import { FolderExplorer } from './FolderExplorer.tsx';
import { AiLibraryDialog } from './AiLibraryDialog.tsx';

type StatusFilter = 'all' | DocStatus | 'inbox';
type SortKey = 'recent' | 'added' | 'words' | 'title';
type ViewMode = 'explorer' | 'grid' | 'list' | 'tags';

interface ShelfPageProps {
  onOpenDoc: (id: string) => void;
  onNewDoc: () => void;
  onOpenClip: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onSwitchMode: () => void;
}

const STATUS_TABS: { key: StatusFilter; label: string; icon: IconName }[] = [
  { key: 'all', label: '全部', icon: 'book' },
  { key: 'unread', label: '未读', icon: 'book' },
  { key: 'reading', label: '在读', icon: 'book' },
  { key: 'done', label: '已读', icon: 'check' },
  { key: 'inbox', label: '收件箱', icon: 'inbox' },
];

const VIEW_MODES: readonly ViewMode[] = ['explorer', 'grid', 'list', 'tags'];
const SORT_KEYS: readonly SortKey[] = ['recent', 'added', 'words', 'title'];
const STATUS_KEYS: readonly StatusFilter[] = ['all', 'unread', 'reading', 'done', 'inbox'];

function readPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    if (value && (allowed as readonly string[]).includes(value)) return value as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

function matchesFilter(doc: DocSummary, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'inbox') return dirOf(doc.relPath).toLowerCase().startsWith('inbox');
  return doc.status === filter;
}

function matchesQuery(doc: DocSummary, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    doc.title.toLowerCase().includes(q) ||
    doc.aliases.some((a) => a.toLowerCase().includes(q)) ||
    doc.tags.some((t) => t.toLowerCase().includes(q)) ||
    doc.excerpt.toLowerCase().includes(q) ||
    doc.relPath.toLowerCase().includes(q)
  );
}

function sortDocs(docs: DocSummary[], sort: SortKey): DocSummary[] {
  const list = docs.slice();
  if (sort === 'title') return list.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  if (sort === 'words') return list.sort((a, b) => b.words - a.words);
  if (sort === 'added') {
    return list.sort((a, b) => {
      const am = a.created ? Date.parse(a.created) || 0 : a.mtime;
      const bm = b.created ? Date.parse(b.created) || 0 : b.mtime;
      return bm - am;
    });
  }
  return list.sort((a, b) => b.mtime - a.mtime);
}

export function ShelfPage({
  onOpenDoc,
  onNewDoc,
  onOpenClip,
  onOpenSearch,
  onOpenSettings,
  onSwitchMode,
}: ShelfPageProps) {
  const { docs, tags, info, loading, error, refresh, refreshDocs, progress, config } = useLibrary();
  const { toast } = useToast();
  const density = config?.density ?? 'comfortable';
  const [status, setStatus] = useState<StatusFilter>(() =>
    readPreference('mr.shelf.status', STATUS_KEYS, 'all'),
  );
  const [sort, setSort] = useState<SortKey>(() => readPreference('mr.shelf.sort', SORT_KEYS, 'recent'));
  const [view, setView] = useState<ViewMode>(() => readPreference('mr.shelf.view', VIEW_MODES, 'explorer'));
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [tagQuery, setTagQuery] = useState('');
  const [bulkMode, setBulkMode] = useState(false);
  /** 「问书库」弹窗 */
  const [askOpen, setAskOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagInput, setTagInput] = useState('');
  const [tagOpen, setTagOpen] = useState(false);

  // 记住书架布局与筛选，进入文章再返回不会重置
  useEffect(() => {
    try {
      localStorage.setItem('mr.shelf.view', view);
      localStorage.setItem('mr.shelf.sort', sort);
      localStorage.setItem('mr.shelf.status', status);
    } catch {
      /* ignore */
    }
  }, [view, sort, status]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: docs.length, unread: 0, reading: 0, done: 0, inbox: 0 };
    for (const doc of docs) {
      map[doc.status] = (map[doc.status] ?? 0) + 1;
      if (dirOf(doc.relPath).toLowerCase().startsWith('inbox')) map.inbox = (map.inbox ?? 0) + 1;
    }
    return map;
  }, [docs]);

  const visible = useMemo(() => {
    const filtered = docs.filter(
      (doc) => matchesFilter(doc, status) && matchesQuery(doc, query) && (!activeTag || doc.tags.includes(activeTag)),
    );
    return sortDocs(filtered, sort);
  }, [docs, status, query, activeTag, sort]);

  const filteredTags = useMemo(
    () => tags.filter((t) => !tagQuery || t.tag.toLowerCase().includes(tagQuery.toLowerCase())),
    [tags, tagQuery],
  );

  const scanText = progress
    ? progress.phase === 'walk'
      ? '正在扫描目录…'
      : progress.phase === 'index'
        ? `正在索引 ${progress.done}/${progress.total}`
        : progress.phase === 'links'
          ? '正在解析双向链接…'
          : '索引完成'
    : null;

  const toggleBulk = () => {
    setBulkMode((prev) => {
      if (!prev && view !== 'grid' && view !== 'list') setView('grid');
      return !prev;
    });
    setSelected(new Set());
    setTagOpen(false);
    setTagInput('');
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkStatus = async (nextStatus: DocStatus) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    let ok = 0;
    for (const id of ids) {
      try {
        await api.setStatus(id, nextStatus);
        ok++;
      } catch {
        /* 单篇失败不阻塞其余 */
      }
    }
    toast(`已标为「${statusLabel(nextStatus)}」：${ok}/${ids.length}`, ok === ids.length ? 'success' : 'error');
    setSelected(new Set());
    await refreshDocs();
  };

  const bulkTag = async () => {
    const tag = tagInput.trim().replace(/^#/, '');
    if (!tag || selected.size === 0) return;
    let ok = 0;
    for (const id of selected) {
      const doc = docs.find((item) => item.id === id);
      if (!doc) continue;
      const nextTags = [...new Set([...doc.tags, tag])];
      try {
        await api.saveDoc(id, { tags: nextTags });
        ok++;
      } catch {
        /* ignore */
      }
    }
    toast(`已给 ${ok} 篇加上 #${tag}`, ok > 0 ? 'success' : 'error');
    setTagInput('');
    setTagOpen(false);
    setSelected(new Set());
    await refreshDocs();
  };

  return (
    <div className="shelf">
      <header className="shelf-head">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="book" size={20} />
          </span>
          <div className="brand-text">
            <strong>enod</strong>
            <span className="brand-sub">
              万卷 · {info?.root ? basename(info.root) : '未挂载'} · {info?.stats.total ?? docs.length} 篇 ·{' '}
              {formatWords(info?.stats.words ?? 0)}
            </span>
          </div>
        </div>

        {/* 常用操作统一靠左，顺序与一页侧栏底部一致：新建 → 剪藏 → 切换 → 设置 */}
        <div className="head-actions">
          <button className="btn btn-primary" onClick={onNewDoc} title="新建文档（Ctrl+N）">
            <Icon name="plus" size={16} />
            新建
          </button>
          <button className="btn btn-ghost small" onClick={onOpenClip} title="剪藏网页到 Inbox">
            <Icon name="clip" size={14} />
            剪藏
          </button>
          <button className="btn btn-ghost small" onClick={() => setAskOpen(true)} title="问书库：跨文档提问，答案落成新笔记">
            <Icon name="sparkle" size={14} />
            问书库
          </button>
          <button className="btn btn-ghost small" onClick={onSwitchMode} title="切换到一页（左侧文件树 + 中间文章）">
            <Icon name="portal" size={14} className="flip-x" />
            一页
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="设置">
            <Icon name="settings" size={18} />
          </button>
        </div>

        <button className="search-trigger" onClick={onOpenSearch} title="全局搜索（Ctrl+K）">
          <Icon name="search" size={17} />
          <span>搜索标题、正文、批注…</span>
          <kbd>Ctrl K</kbd>
        </button>
      </header>

      <div className="shelf-toolbar">
        <nav className="tabs" aria-label="状态筛选">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.key}
              className={`tab ${status === tab.key ? 'active' : ''}`}
              onClick={() => setStatus(tab.key)}
            >
              {tab.label}
              <span className="tab-count">{counts[tab.key] ?? 0}</span>
            </button>
          ))}
        </nav>

        <div className="toolbar-right">
          <label className="inline-search">
            <Icon name="search" size={15} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选当前列表"
              spellCheck={false}
            />
            {query && (
              <button className="icon-btn tiny" onClick={() => setQuery('')} aria-label="清除">
                <Icon name="close" size={13} />
              </button>
            )}
          </label>

          <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="排序">
            <option value="recent">最近打开</option>
            <option value="added">导入时间</option>
            <option value="words">字数</option>
            <option value="title">标题</option>
          </select>

          <button className={`btn btn-ghost small ${bulkMode ? 'active' : ''}`} onClick={toggleBulk} title="批量选择">
            <Icon name="check" size={14} />
            批量
          </button>

          <div className="view-toggle" role="group" aria-label="视图">
            <button className={view === 'explorer' ? 'active' : ''} onClick={() => setView('explorer')} title="文件夹">
              <Icon name="folder" size={16} />
            </button>
            <button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} title="书架">
              <Icon name="grid" size={16} />
            </button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="列表">
              <Icon name="list" size={16} />
            </button>
            <button className={view === 'tags' ? 'active' : ''} onClick={() => setView('tags')} title="标签">
              <Icon name="tag" size={16} />
            </button>
          </div>
        </div>
      </div>

      {bulkMode && (
        <div className="bulk-bar">
          <span className="bulk-count">{selected.size} 篇已选</span>
          <button className="btn btn-ghost small" onClick={() => setSelected(new Set(visible.map((doc) => doc.id)))}>
            全选当前
          </button>
          <button className="btn btn-ghost small" onClick={() => setSelected(new Set())}>
            清空
          </button>
          <span className="bulk-sep" />
          <button className="btn btn-ghost small" disabled={selected.size === 0} onClick={() => void bulkStatus('reading')}>
            标为在读
          </button>
          <button className="btn btn-ghost small" disabled={selected.size === 0} onClick={() => void bulkStatus('done')}>
            标为已读
          </button>
          <button className="btn btn-ghost small" disabled={selected.size === 0} onClick={() => void bulkStatus('unread')}>
            标为未读
          </button>
          {tagOpen ? (
            <span className="bulk-tag-input">
              <input
                autoFocus
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="标签名"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void bulkTag();
                  if (e.key === 'Escape') setTagOpen(false);
                }}
              />
              <button className="btn btn-primary small" onClick={() => void bulkTag()}>
                加上
              </button>
            </span>
          ) : (
            <button className="btn btn-ghost small" disabled={selected.size === 0} onClick={() => setTagOpen(true)}>
              加标签…
            </button>
          )}
          <span className="bulk-sep" />
          <button className="btn btn-ghost small" onClick={toggleBulk}>
            退出批量
          </button>
        </div>
      )}

      {activeTag && (
        <div className="active-filter">
          <span>
            标签：<strong>#{activeTag}</strong>
          </span>
          <button className="chip-clear" onClick={() => setActiveTag(null)}>
            <Icon name="close" size={13} /> 清除
          </button>
        </div>
      )}

      {scanText && (
        <div className="scan-banner">
          <span className="scan-dot" />
          {scanText}
          {progress && progress.total > 0 && (
            <span className="scan-bar">
              <i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="error-banner">
          <Icon name="alert" size={16} />
          <span>{error}</span>
          <button className="btn btn-ghost small" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}

      {askOpen && (
        <AiLibraryDialog
          onClose={() => setAskOpen(false)}
          onSubmit={async (question, budgetChars) => {
            try {
              const res = await api.createAiJob({ kind: 'library', question, budgetChars });
              toast(res.deduped ? '这个问题已经在队列里了' : '已入队，等 DSH 侧领走', 'success');
              return true;
            } catch (err) {
              toast(err instanceof Error ? err.message : '入队失败', 'error');
              return false;
            }
          }}
        />
      )}

      {loading && docs.length === 0 ? (
        <ShelfSkeleton />
      ) : docs.length === 0 ? (
        <EmptyLibrary onNewDoc={onNewDoc} onOpenSettings={onOpenSettings} hasRoot={Boolean(info?.root)} />
      ) : view === 'tags' ? (
        <div className="shelf-scroll">
          <div className="tag-panel">
            <div className="tag-panel-head">
              <h2>全部标签</h2>
              <label className="inline-search">
                <Icon name="search" size={15} />
                <input value={tagQuery} onChange={(e) => setTagQuery(e.target.value)} placeholder="筛选标签" />
              </label>
            </div>
            <div className="tag-cloud">
              {filteredTags.map(({ tag, count }) => (
                <button
                  key={tag}
                  className={`tag-card ${activeTag === tag ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTag(tag);
                    setStatus('all');
                    setView('grid');
                  }}
                >
                  <span className="tag-name">#{tag}</span>
                  <span className="tag-count">{count} 篇</span>
                </button>
              ))}
              {filteredTags.length === 0 && <p className="muted">还没有标签。在文档 frontmatter 里写 `tags: [历史]` 就会出现在这里。</p>}
            </div>
          </div>
        </div>
      ) : view === 'explorer' ? (
        <FolderExplorer docs={visible} dirs={info?.dirs ?? []} onOpenDoc={onOpenDoc} />
      ) : view === 'list' ? (
        <div className="shelf-scroll">
          <div className="doc-list">
            <div className="list-head" aria-hidden="true">
              <span />
              <span />
              <span>标题</span>
              <span>路径</span>
              <span>标签</span>
              <span>字数</span>
              <span>更新</span>
            </div>
            {visible.map((doc) => (
              <ListRow
                key={doc.id}
                doc={doc}
                bulkMode={bulkMode}
                selected={selected.has(doc.id)}
                onClick={() => (bulkMode ? toggleSelect(doc.id) : onOpenDoc(doc.id))}
              />
            ))}
            {visible.length === 0 && <p className="muted pad">没有匹配的文档。</p>}
          </div>
        </div>
      ) : (
        <VirtualDocGrid
          docs={visible}
          onOpenDoc={onOpenDoc}
          bulkMode={bulkMode}
          selected={selected}
          onToggle={toggleSelect}
          density={density}
        />
      )}
    </div>
  );
}

function ShelfSkeleton() {
  return (
    <div className="shelf-scroll">
      <div className="doc-grid skeleton-grid">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="doc-card skeleton">
            <div className="sk-line short" />
            <div className="sk-line" />
            <div className="sk-line" />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyLibrary({
  onNewDoc,
  onOpenSettings,
  hasRoot,
}: {
  onNewDoc: () => void;
  onOpenSettings: () => void;
  hasRoot: boolean;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Icon name="book" size={40} />
      </div>
      <h2>{hasRoot ? '书库还是空的' : '还没有挂载书库'}</h2>
      <p>
        {hasRoot
          ? '把已有的 .md 文件放进书库目录，或者先写一篇。'
          : '选择一个存放 Markdown 的目录，md-reader 会建立索引。'}
      </p>
      <div className="empty-actions">
        <button className="btn btn-primary" onClick={onNewDoc}>
          <Icon name="plus" size={16} />
          新建第一篇
        </button>
        <button className="btn btn-ghost" onClick={onOpenSettings}>
          设置书库路径
        </button>
      </div>
    </div>
  );
}

function DocCard({
  doc,
  onClick,
  bulkMode,
  selected,
}: {
  doc: DocSummary;
  onClick: () => void;
  bulkMode: boolean;
  selected: boolean;
}) {
  return (
    <button
      className={`doc-card ${bulkMode ? 'selectable' : ''} ${selected ? 'selected' : ''}`}
      onClick={onClick}
      title={doc.title}
    >
      <div className="card-top">
        <span className={`status-pill status-${doc.status}`}>
          <span className="status-dot" />
          {statusLabel(doc.status)}
        </span>
        <span className="card-top-right">
          {bulkMode && (
            <span className={`select-mark ${selected ? 'on' : ''}`}>
              {selected && <Icon name="check" size={11} />}
            </span>
          )}
          <span className="card-time">{formatRelativeTime(doc.mtime)}</span>
        </span>
      </div>
      <h3 className="card-title">{doc.title}</h3>
      <p className="card-excerpt">{doc.excerpt || '（空文档）'}</p>
      <div className="card-foot">
        <div className="card-tags">
          {doc.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="tag">
              #{tag}
            </span>
          ))}
          {doc.tags.length > 3 && <span className="tag more">+{doc.tags.length - 3}</span>}
        </div>
        <span className="card-meta">
          {formatWords(doc.words)}
          {doc.annCount > 0 && (
            <span className="ann-count">
              <Icon name="note" size={12} />
              {doc.annCount}
            </span>
          )}
          {(doc.aiCount ?? 0) > 0 && (
            <span className="ann-count ai-count" title="AI 产出">
              <Icon name="sparkle" size={12} />
              {doc.aiCount}
            </span>
          )}
        </span>
      </div>
      {doc.progress > 0 && doc.progress < 1 && (
        <span className="card-progress" aria-hidden="true">
          <i style={{ width: formatPercent(doc.progress) }} />
        </span>
      )}
      {doc.progress >= 1 && <span className="card-done" aria-hidden="true" />}
    </button>
  );
}

function ListRow({
  doc,
  onClick,
  bulkMode,
  selected,
}: {
  doc: DocSummary;
  onClick: () => void;
  bulkMode: boolean;
  selected: boolean;
}) {
  return (
    <button className={`list-row ${selected ? 'selected' : ''}`} onClick={onClick}>
      <span className={`select-mark ${bulkMode ? 'visible' : ''} ${selected ? 'on' : ''}`}>
        {selected && bulkMode && <Icon name="check" size={11} />}
      </span>
      <span className={`status-dot status-${doc.status}`} />
      <span className="list-title">{doc.title}</span>
      <span className="list-path">{doc.relPath}</span>
      <span className="list-tags">
        {doc.tags.slice(0, 2).map((t) => (
          <span key={t} className="tag">
            #{t}
          </span>
        ))}
      </span>
      <span className="list-words">{formatWords(doc.words)}</span>
      <span className="list-time">{formatRelativeTime(doc.mtime)}</span>
    </button>
  );
}

function VirtualDocGrid({
  docs,
  onOpenDoc,
  bulkMode,
  selected,
  onToggle,
  density,
}: {
  docs: DocSummary[];
  onOpenDoc: (id: string) => void;
  bulkMode: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  density: 'comfortable' | 'compact';
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ cols: 3, viewport: 800, scrollTop: 0 });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const cols = Math.max(1, Math.min(6, Math.floor((el.clientWidth - 8) / 296)));
      setLayout((prev) => ({ ...prev, cols, viewport: el.clientHeight }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const onScroll = () => setLayout((prev) => ({ ...prev, scrollTop: el.scrollTop }));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  const rowHeight = density === 'compact' ? 202 : 228;
  const gap = 18;
  const totalRows = Math.ceil(docs.length / layout.cols);
  const startRow = Math.max(0, Math.floor(layout.scrollTop / rowHeight) - 2);
  const endRow = Math.min(totalRows, Math.ceil((layout.scrollTop + layout.viewport) / rowHeight) + 2);
  const slice = docs.slice(startRow * layout.cols, endRow * layout.cols);
  const paddingTop = startRow * rowHeight;
  const paddingBottom = Math.max(0, (totalRows - endRow) * rowHeight) + 32;

  return (
    <div className="shelf-scroll" ref={scrollRef}>
      <div
        className="doc-grid"
        style={{
          gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
          gap: `${gap}px`,
          paddingTop,
          paddingBottom,
        }}
      >
        {slice.map((doc) => (
          <DocCard
            key={doc.id}
            doc={doc}
            bulkMode={bulkMode}
            selected={selected.has(doc.id)}
            onClick={() => (bulkMode ? onToggle(doc.id) : onOpenDoc(doc.id))}
          />
        ))}
      </div>
      {docs.length === 0 && <p className="muted pad">没有匹配的文档。</p>}
    </div>
  );
}

