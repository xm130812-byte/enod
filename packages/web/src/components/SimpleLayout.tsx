import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DocSummary } from '../types.ts';
import { useLibrary } from '../hooks/useLibrary.tsx';
import { dirOf, formatRelativeTime, formatWords, statusLabel } from '../lib/format.ts';
import { Icon } from './Icons.tsx';
import { Collapse } from './Collapse.tsx';
import { ReaderPage } from './ReaderPage.tsx';
import { TocList } from './Toc.tsx';
import type { TocItem } from './Toc.tsx';

interface FileNode {
  name: string;
  path: string;
  depth: number;
  folders: FileNode[];
  files: DocSummary[];
  count: number;
}

function buildFileTree(dirs: string[], docs: DocSummary[]): FileNode {
  const root: FileNode = { name: '', path: '', depth: 0, folders: [], files: [], count: 0 };
  const map = new Map<string, FileNode>([['', root]]);

  const ensure = (path: string): FileNode => {
    const existing = map.get(path);
    if (existing) return existing;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = ensure(parentPath);
    const node: FileNode = {
      name: path.split('/').pop() ?? path,
      path,
      depth: parent.depth + 1,
      folders: [],
      files: [],
      count: 0,
    };
    parent.folders.push(node);
    map.set(path, node);
    return node;
  };

  for (const dir of dirs) if (dir) ensure(dir);

  for (const doc of docs) {
    const dir = dirOf(doc.relPath);
    const parts = dir.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      node = map.get(parts.slice(0, i + 1).join('/')) ?? ensure(parts.slice(0, i + 1).join('/'));
    }
    node.files.push(doc);
    let cursor: FileNode | null = node;
    while (cursor) {
      cursor.count++;
      if (cursor.path === '') break;
      const idx: number = cursor.path.lastIndexOf('/');
      const parentPath: string = idx === -1 ? '' : cursor.path.slice(0, idx);
      cursor = map.get(parentPath) ?? null;
    }
  }

  const sortNode = (node: FileNode): void => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const folder of node.folders) sortNode(folder);
  };
  sortNode(root);
  return root;
}

function readExpanded(): Set<string> | null {
  try {
    const raw = localStorage.getItem('mr.simple.expanded');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return null;
  }
}

interface SimpleLayoutProps {
  docId: string | null;
  onOpenDoc: (id: string) => void;
  onSwitchMode: () => void;
  onNewDoc: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}

export function SimpleLayout({
  docId,
  onOpenDoc,
  onSwitchMode,
  onNewDoc,
  onOpenSettings,
  onOpenSearch,
}: SimpleLayoutProps) {
  const { docs, info, loading } = useLibrary();
  const tree = useMemo(() => buildFileTree(info?.dirs ?? [], docs), [info?.dirs, docs]);
  const [expanded, setExpanded] = useState<Set<string>>(() => readExpanded() ?? new Set(['']));
  const [sideTab, setSideTab] = useState<'files' | 'toc'>(() => {
    try {
      return localStorage.getItem('mr.simple.side') === 'toc' ? 'toc' : 'files';
    } catch {
      return 'files';
    }
  });
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mr.simple.collapsed') === '1';
    } catch {
      return false;
    }
  });
  const initialized = useRef(false);
  const sideRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const side = sideRef.current as (HTMLElement & { inert?: boolean }) | null;
    const rail = railRef.current as (HTMLElement & { inert?: boolean }) | null;
    if (side) side.inert = collapsed;
    if (rail) rail.inert = !collapsed;
  }, [collapsed]);

  useEffect(() => {
    try {
      localStorage.setItem('mr.simple.side', sideTab);
    } catch {
      /* ignore */
    }
  }, [sideTab]);

  useEffect(() => {
    try {
      localStorage.setItem('mr.simple.collapsed', collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'b') return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      setCollapsed((value) => !value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    setTocItems([]);
    setActiveHeading(null);
  }, [docId]);

  useEffect(() => {
    if (initialized.current || tree.folders.length === 0) return;
    initialized.current = true;
    if (readExpanded()) return;
    setExpanded(new Set(['', ...collectFolders(tree, 1)]));
  }, [tree]);

  useEffect(() => {
    try {
      localStorage.setItem('mr.simple.expanded', JSON.stringify([...expanded]));
    } catch {
      /* ignore */
    }
  }, [expanded]);

  // 打开文档时自动展开它所在的文件夹
  useEffect(() => {
    const doc = docs.find((item) => item.id === docId);
    if (!doc) return;
    const parts = dirOf(doc.relPath).split('/').filter(Boolean);
    const paths = [''];
    for (let i = 1; i <= parts.length; i++) paths.push(parts.slice(0, i).join('/'));
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of paths) next.add(path);
      return next;
    });
  }, [docId, docs]);

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderFolder = (node: FileNode): ReactNode => {
    const isOpen = expanded.has(node.path);
    return (
      <div key={node.path}>
        <div
          className={`simple-folder ${isOpen ? 'open' : ''}`}
          style={{ paddingLeft: 8 + (node.depth - 1) * 14 }}
          onClick={() => toggle(node.path)}
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggle(node.path);
            }
          }}
        >
          <span className="simple-caret">
            <Icon name="chevron-right" size={12} />
          </span>
          <Icon name="folder" size={14} className="folder-icon" />
          <span className="simple-folder-name">{node.name}</span>
          <span className="simple-count">{node.count}</span>
        </div>
        <Collapse open={isOpen}>
          {node.folders.map(renderFolder)}
          {node.files.map((doc) => (
            <button
              key={doc.id}
              className={`simple-file ${doc.id === docId ? 'active' : ''}`}
              style={{ paddingLeft: 8 + node.depth * 14 }}
              onClick={() => onOpenDoc(doc.id)}
              title={`${doc.title} · ${statusLabel(doc.status)}`}
            >
              <span className={`status-dot status-${doc.status}`} />
              <span className="simple-file-title">{doc.title}</span>
              <span className="simple-file-meta">{formatWords(doc.words)}</span>
            </button>
          ))}
        </Collapse>
      </div>
    );
  };

  const recent = docs.slice(0, 5);

  const jumpToHeading = (slug: string): void => {
    const root = document.querySelector('.simple-main');
    if (!root) return;
    const byId = root.querySelector<HTMLElement>(`.article [id="${CSS.escape(slug)}"]`);
    const target =
      byId ??
      [...root.querySelectorAll<HTMLElement>('.article h1, .article h2, .article h3')].find(
        (heading) => (heading.textContent ?? '').trim() === slug,
      );
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <div className={`simple ${collapsed ? 'side-collapsed' : ''}`}>
      <aside className="simple-side" ref={sideRef}>
        <div className="simple-side-inner">
          <div className="simple-head">
            <div className="brand">
              <span className="brand-mark">
                <Icon name="book" size={15} />
              </span>
              <div className="brand-text">
                <strong>md-reader</strong>
                <span className="brand-sub">
                  一页 · {docs.length} 篇 · {formatWords(info?.stats.words ?? 0)}
                </span>
              </div>
            </div>
            <button
              className="icon-btn side-collapse"
              onClick={() => setCollapsed(true)}
              title="收起侧边栏（Ctrl+B）"
              aria-label="收起侧边栏"
            >
              <Icon name="chevrons-left" size={15} />
            </button>
          </div>

          <button className="side-search" onClick={onOpenSearch} title="搜索书库（Ctrl+K）">
            <Icon name="search" size={14} />
            <span>搜索</span>
            <kbd>Ctrl K</kbd>
          </button>

          <div className="simple-tabs" role="tablist" data-active={sideTab}>
            <button
              role="tab"
              aria-selected={sideTab === 'files'}
              className={sideTab === 'files' ? 'active' : ''}
              onClick={() => setSideTab('files')}
            >
              文件夹
              <span className="seg-count">{docs.length}</span>
            </button>
            <button
              role="tab"
              aria-selected={sideTab === 'toc'}
              className={sideTab === 'toc' ? 'active' : ''}
              onClick={() => setSideTab('toc')}
            >
              目录
              <span className="seg-count">{docId ? tocItems.length : 0}</span>
            </button>
          </div>

          {sideTab === 'files' ? (
            <div className="simple-tree">
              {loading && docs.length === 0 ? (
                <p className="muted small pad">加载中…</p>
              ) : (
                <>
                  {tree.files.length > 0 && (
                    <div className="simple-root-files">
                      {tree.files.map((doc) => (
                        <button
                          key={doc.id}
                          className={`simple-file ${doc.id === docId ? 'active' : ''}`}
                          style={{ paddingLeft: 30 }}
                          onClick={() => onOpenDoc(doc.id)}
                        >
                          <span className={`status-dot status-${doc.status}`} />
                          <span className="simple-file-title">{doc.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {tree.folders.map(renderFolder)}
                </>
              )}
            </div>
          ) : (
            <div className="simple-tree simple-toc">
              {!docId ? (
                <p className="muted small toc-empty">选择一篇文章后显示目录</p>
              ) : (
                <TocList
                  items={tocItems}
                  activeId={activeHeading}
                  onJump={jumpToHeading}
                  emptyText="这篇文档还没有标题"
                />
              )}
            </div>
          )}

          <div className="simple-foot">
            <button className="btn btn-primary small new-doc" onClick={onNewDoc} title="新建文档（Ctrl+N）">
              <Icon name="plus" size={13} />
              新建
            </button>
            <span className="simple-foot-stats">{formatWords(info?.stats.words ?? 0)}</span>
            <button
              className="icon-btn"
              onClick={onSwitchMode}
              title="切换到万卷（书架 + 三栏）"
              aria-label="切换到万卷"
            >
              <Icon name="layout" size={15} />
            </button>
            <button className="icon-btn" onClick={onOpenSettings} title="设置" aria-label="设置">
              <Icon name="settings" size={15} />
            </button>
          </div>
        </div>
      </aside>

      <aside className="side-rail" ref={railRef} aria-hidden={!collapsed}>
        <button
          className="rail-brand"
          onClick={() => setCollapsed(false)}
          title="展开侧边栏（Ctrl+B）"
          aria-label="展开侧边栏"
        >
          <Icon name="book" size={14} />
        </button>
        <button
          className="icon-btn rail-btn"
          onClick={() => setCollapsed(false)}
          title="展开侧边栏（Ctrl+B）"
          aria-label="展开侧边栏"
        >
          <Icon name="chevrons-right" size={15} />
        </button>
        <div className="rail-sep" />
        <button className="icon-btn rail-btn" onClick={onOpenSearch} title="搜索（Ctrl+K）" aria-label="搜索">
          <Icon name="search" size={15} />
        </button>
        <button className="icon-btn rail-btn" onClick={onNewDoc} title="新建（Ctrl+N）" aria-label="新建">
          <Icon name="plus" size={16} />
        </button>
        <span className="rail-spacer" />
        <button
          className="icon-btn rail-btn"
          onClick={onSwitchMode}
          title="切换到万卷"
          aria-label="切换到万卷"
        >
          <Icon name="layout" size={15} />
        </button>
        <button className="icon-btn rail-btn" onClick={onOpenSettings} title="设置" aria-label="设置">
          <Icon name="settings" size={15} />
        </button>
      </aside>

      <main className="simple-main">
        {docId ? (
          <ReaderPage
            key={docId}
            docId={docId}
            simple
            onTocChange={setTocItems}
            onActiveChange={setActiveHeading}
            onOpenSearch={onOpenSearch}
            onBack={() => {
              window.location.hash = '#/';
            }}
            onOpenDoc={onOpenDoc}
          />
        ) : (
          <div className="simple-empty">
            <Icon name="book" size={32} />
            <h2>选择一篇文章</h2>
            <p className="muted">从左侧文件夹里选一篇，内容会显示在这里。</p>
            {recent.length > 0 && (
              <div className="simple-recent">
                <span className="muted small">最近更新</span>
                {recent.map((doc) => (
                  <button key={doc.id} className="simple-recent-item" onClick={() => onOpenDoc(doc.id)}>
                    <span className={`status-dot status-${doc.status}`} />
                    <span className="simple-recent-title">{doc.title}</span>
                    <span className="muted small">{formatRelativeTime(doc.mtime)}</span>
                  </button>
                ))}
              </div>
            )}
            <button className="btn btn-ghost small" onClick={onSwitchMode}>
              打开万卷
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function collectFolders(node: FileNode, maxDepth: number, out: string[] = []): string[] {
  for (const folder of node.folders) {
    if (folder.depth <= maxDepth) out.push(folder.path);
    collectFolders(folder, maxDepth, out);
  }
  return out;
}
