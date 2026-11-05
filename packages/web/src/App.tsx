import { useCallback, useEffect, useState } from 'react';
import { ToastProvider, useToast } from './hooks/useToast.tsx';
import { LibraryProvider, useLibrary } from './hooks/useLibrary.tsx';
import { ShelfPage } from './components/ShelfPage.tsx';
import { ReaderPage } from './components/ReaderPage.tsx';
import { SearchOverlay } from './components/SearchOverlay.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { NewDocDialog } from './components/DocDialogs.tsx';
import type { AppConfig } from './types.ts';
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

  useTheme(config);

  const openDoc = useCallback((id: string) => {
    if (window.location.hash === `#/doc/${id}`) return;
    window.location.hash = `#/doc/${id}`;
  }, []);

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
    </div>
  );
}
