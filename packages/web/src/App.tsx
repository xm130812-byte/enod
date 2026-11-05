import { useCallback, useEffect, useState } from 'react';
import { ToastProvider, useToast } from './hooks/useToast.tsx';
import { LibraryProvider, useLibrary } from './hooks/useLibrary.tsx';
import { ShelfPage } from './components/ShelfPage.tsx';
import { ReaderPage } from './components/ReaderPage.tsx';
import { SearchOverlay } from './components/SearchOverlay.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { NewDocDialog } from './components/DocDialogs.tsx';
import type { AppConfig, DocPayload } from './types.ts';
import { api } from './api.ts';
import { Icon } from './components/Icons.tsx';

type Route = { view: 'shelf' } | { view: 'doc'; id: string };

function parseRoute(): Route {
  const hash = window.location.hash;
  const match = /^#\/doc\/([^?]+)/.exec(hash);
  if (match) return { view: 'doc', id: decodeURIComponent(match[1]!) };
  return { view: 'shelf' };
}

export function App() {
  return (
    <ToastProvider>
      <LibraryProvider>
        <Shell />
      </LibraryProvider>
    </ToastProvider>
  );
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute());
  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

function useTheme(config: AppConfig | null): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!config) {
      root.dataset.theme = 'light';
      return;
    }
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme = config.theme === 'system' ? (media.matches ? 'dark' : 'light') : config.theme;
      root.dataset.theme = theme;
    };
    apply();
    media.addEventListener('change', apply);
    root.dataset.font = config.fontFamily;
    root.style.setProperty('--reader-font-size', `${config.fontSize}px`);
    root.style.setProperty('--reader-line-height', String(config.lineHeight));
    root.style.setProperty('--reader-measure', `${config.measureCh}ch`);
    return () => media.removeEventListener('change', apply);
  }, [config]);
}

function Shell() {
  const { info, config, loading, error, refresh } = useLibrary();
  const { toast } = useToast();
  const route = useRoute();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  useTheme(config);

  const openDoc = useCallback((id: string) => {
    if (window.location.hash === `#/doc/${id}`) return;
    window.location.hash = `#/doc/${id}`;
  }, []);

  const importFiles = useCallback(
    async (files: File[]) => {
      let last: DocPayload | null = null;
      for (const file of files) {
        try {
          const text = await file.text();
          const doc = await api.createDoc({
            dir: 'Inbox',
            title: file.name.replace(/\.md$/i, ''),
            content: stripFrontmatter(text),
          });
          last = doc;
          toast(`已导入「${doc.title}」`, 'success');
        } catch (err) {
          toast(err instanceof Error ? err.message : `导入 ${file.name} 失败`, 'error');
        }
      }
      if (last) {
        await refresh();
        openDoc(last.id);
      }
    },
    [openDoc, refresh, toast],
  );

  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (event: DragEvent) => {
      if (route.view !== 'shelf' || !hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragOver(true);
    };
    const onOver = (event: DragEvent) => {
      if (route.view !== 'shelf' || !hasFiles(event)) return;
      event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };
    const onDrop = (event: DragEvent) => {
      if (route.view !== 'shelf' || !hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) => /\.md$/i.test(file.name));
      if (files.length === 0) {
        toast('只支持拖入 .md 文件', 'error');
        return;
      }
      void importFiles(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [route.view, importFiles, toast]);

  const backToShelf = useCallback(() => {
    window.location.hash = '#/';
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (key === 'n') {
        event.preventDefault();
        setNewDocOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (error && !info && !loading) toast(error, 'error');
  }, [error, info, loading, toast]);

  return (
    <div className="app">
      {route.view === 'doc' ? (
        <ReaderPage key={route.id} docId={route.id} onBack={backToShelf} onOpenDoc={openDoc} />
      ) : (
        <ShelfPage
          onOpenDoc={openDoc}
          onNewDoc={() => setNewDocOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {!info && !loading && (
        <div className="offline">
          <Icon name="alert" size={26} />
          <div>
            <strong>连接不上守护进程</strong>
            <p>{error ?? '请确认 md-reader 正在运行。'}</p>
          </div>
          <button className="btn btn-ghost" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} onOpenDoc={openDoc} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <NewDocDialog
        open={newDocOpen}
        dirs={info?.dirs ?? ['Inbox']}
        onClose={() => setNewDocOpen(false)}
        onCreated={(doc) => {
          void refresh();
          openDoc(doc.id);
        }}
      />

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-card">
            <Icon name="book" size={26} />
            <strong>松开即可导入到 Inbox</strong>
            <span>支持 .md 文件；frontmatter 会重新生成，正文保持原样</span>
          </div>
        </div>
      )}
    </div>
  );
}

function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}
