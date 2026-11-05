import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { SearchResult } from '../types.ts';
import { Icon } from './Icons.tsx';

interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
  onOpenDoc: (id: string) => void;
}

export function SearchOverlay({ open, onClose, onOpenDoc }: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .search(q, 30)
        .then((hits) => {
          setResults(hits);
          setActive(0);
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const total = useMemo(() => results.length, [results]);

  if (!open) return null;

  const choose = (index: number) => {
    const hit = results[index];
    if (!hit) return;
    onOpenDoc(hit.id);
    onClose();
  };

  return (
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="全局搜索">
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、正文、标签、批注备注…"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, Math.max(0, total - 1)));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter') choose(active);
            }}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="palette-results" ref={listRef}>
          {loading && <p className="palette-hint">搜索中…</p>}
          {!loading && query && results.length === 0 && <p className="palette-hint">没有找到「{query}」</p>}
          {!query && (
            <div className="palette-hint">
              <p>输入关键词开始搜索。支持中文分词，范围包括标题、正文、标签与批注备注。</p>
              <p className="muted">↑ ↓ 选择 · Enter 打开 · Esc 关闭</p>
            </div>
          )}
          {results.map((hit, index) => (
            <button
              key={hit.id}
              data-index={index}
              className={`palette-item ${index === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              <div className="palette-item-head">
                <span className={`status-dot status-${hit.status}`} />
                <span className="palette-title">{hit.title}</span>
                <span className="palette-path">{hit.relPath}</span>
              </div>
              <p className="palette-snippet">
                <Highlighted text={hit.snippet} start={hit.matchStart} end={hit.matchEnd} />
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Highlighted({ text, start, end }: { text: string; start: number; end: number }) {
  if (!text) return null;
  if (end <= start || start < 0 || end > text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}
