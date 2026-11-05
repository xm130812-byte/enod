import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DocSummary } from '../types.ts';
import { dirOf, formatRelativeTime, formatWords } from '../lib/format.ts';
import { Icon } from './Icons.tsx';

interface FolderNode {
  name: string;
  path: string;
  depth: number;
  children: FolderNode[];
  count: number;
  directCount: number;
}

function buildTree(dirs: string[], docs: DocSummary[]): FolderNode {
  const root: FolderNode = { name: '全部文档', path: '', depth: 0, children: [], count: 0, directCount: 0 };
  const map = new Map<string, FolderNode>([['', root]]);

  const ensure = (path: string): FolderNode => {
    const existing = map.get(path);
    if (existing) return existing;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = ensure(parentPath);
    const node: FolderNode = {
      name: path.split('/').pop() ?? path,
      path,
      depth: parent.depth + 1,
      children: [],
      count: 0,
      directCount: 0,
    };
    parent.children.push(node);
    map.set(path, node);
    return node;
  };

  for (const dir of dirs) {
    if (dir) ensure(dir);
  }

  for (const doc of docs) {
    const parts = dirOf(doc.relPath).split('/').filter(Boolean);
    let current = root;
    current.count++;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let node = map.get(path);
      if (!node) node = ensure(path);
      node.count++;
      current = node;
    }
    current.directCount++;
  }

  const sortNodes = (node: FolderNode): void => {
    node.children.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const child of node.children) sortNodes(child);
  };
  sortNodes(root);
  return root;
}

interface FolderExplorerProps {
  docs: DocSummary[];
  dirs: string[];
  onOpenDoc: (id: string) => void;
}

function readStoredSet(key: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : null;
  } catch {
    return null;
  }
}

export function FolderExplorer({ docs, dirs, onOpenDoc }: FolderExplorerProps) {
  const tree = useMemo(() => buildTree(dirs, docs), [dirs, docs]);
  const [selected, setSelected] = useState<string>(() => {
    try {
      return localStorage.getItem('mr.shelf.folder') ?? '';
    } catch {
      return '';
    }
  });
  const [expanded, setExpanded] = useState<Set<string>>(() => readStoredSet('mr.shelf.expanded') ?? new Set(['']));
  const initialized = useRef(false);

  // 首次有目录时，默认展开两级；之后以用户的展开状态为准
  useEffect(() => {
    if (initialized.current || tree.children.length === 0) return;
    initialized.current = true;
    if (readStoredSet('mr.shelf.expanded')) return;
    setExpanded(new Set(collectPaths(tree, 2)));
  }, [tree]);

  useEffect(() => {
    try {
      localStorage.setItem('mr.shelf.folder', selected);
      localStorage.setItem('mr.shelf.expanded', JSON.stringify([...expanded]));
    } catch {
      /* ignore */
    }
  }, [selected, expanded]);

  // 打开时让选中的文件夹在树里可见
  useEffect(() => {
    if (!selected) return;
    const parts = selected.split('/').filter(Boolean);
    const paths = [''];
    for (let i = 1; i < parts.length; i++) paths.push(parts.slice(0, i).join('/'));
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const path of paths) next.add(path);
      return next;
    });
  }, [selected]);

  // 文件夹被删除 / 重命名后回到根目录
  useEffect(() => {
    if (dirs.length === 0) return;
    if (selected && !findNode(tree, selected)) setSelected('');
  }, [tree, selected, dirs.length]);

  const folderDocs = useMemo(() => {
    if (!selected) return docs;
    return docs.filter((doc) => {
      const dir = dirOf(doc.relPath);
      return dir === selected || dir.startsWith(`${selected}/`);
    });
  }, [docs, selected]);

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectFolder = (path: string): void => {
    setSelected(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add('');
      const parts = path.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
      next.add(path);
      return next;
    });
  };

  const renderNode = (node: FolderNode, depth: number): ReactNode => {
    const isRoot = node.path === '';
    const hasChildren = node.children.length > 0;
    const isOpen = expanded.has(node.path);
    return (
      <div key={node.path || '__root'}>
        <div
          className={`folder-row ${selected === node.path ? 'active' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => selectFolder(node.path)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              selectFolder(node.path);
            }
          }}
        >
          {hasChildren ? (
            <button
              className="folder-caret"
              onClick={(event) => {
                event.stopPropagation();
                toggle(node.path);
              }}
              aria-label={isOpen ? '折叠' : '展开'}
            >
              <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          ) : (
            <span className="folder-caret" />
          )}
          <Icon name={isRoot ? 'book' : 'folder'} size={14} className="folder-icon" />
          <span className="folder-name">{node.name}</span>
          {node.count > 0 && <span className="folder-count">{node.count}</span>}
        </div>
        {hasChildren && isOpen && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  const label = selected === '' ? '全部文档' : selected;
  const selectedNode = findNode(tree, selected);

  return (
    <div className="explorer">
      <aside className="folder-pane">
        <div className="folder-pane-head">文件夹</div>
        <div className="folder-tree">{renderNode(tree, 0)}</div>
      </aside>

      <section className="file-pane">
        <header className="file-head">
          <div className="file-head-title">
            <strong>{label}</strong>
            <span className="file-head-count">{folderDocs.length} 篇</span>
          </div>
          <span className="muted small">
            {selectedNode?.directCount ? `本层 ${selectedNode.directCount} 篇 · ` : ''}含子文件夹
          </span>
        </header>

        <div className="file-scroll">
          {folderDocs.length === 0 ? (
            <p className="muted pad">这个文件夹里还没有匹配的文档。</p>
          ) : (
            folderDocs.map((doc) => {
              const relative = selected ? doc.relPath.slice(selected.length + 1) : doc.relPath;
              return (
                <button key={doc.id} className="file-row" onClick={() => onOpenDoc(doc.id)} title={doc.relPath}>
                  <span className={`status-dot status-${doc.status}`} />
                  <span className="file-title">{doc.title}</span>
                  <span className="file-path">{relative}</span>
                  <span className="file-tags">
                    {doc.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className="tag">
                        #{tag}
                      </span>
                    ))}
                  </span>
                  <span className="file-meta">
                    {formatWords(doc.words)} · {formatRelativeTime(doc.mtime)}
                    {doc.annCount > 0 && ` · ${doc.annCount} 批注`}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function findNode(node: FolderNode, path: string): FolderNode | null {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

function collectPaths(node: FolderNode, maxDepth: number, out: string[] = []): string[] {
  if (node.depth > maxDepth) return out;
  out.push(node.path);
  for (const child of node.children) collectPaths(child, maxDepth, out);
  return out;
}
