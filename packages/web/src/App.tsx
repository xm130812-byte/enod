import { useCallback, useEffect, useState } from 'react';
import { ToastProvider, useToast } from './hooks/useToast.tsx';
import { LibraryProvider, useLibrary } from './hooks/useLibrary.tsx';
import { ShelfPage } from './components/ShelfPage.tsx';
import { ReaderPage } from './components/ReaderPage.tsx';
import { SearchOverlay } from './components/SearchOverlay.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { NewDocDialog } from './components/DocDialogs.tsx';
import { SimpleLayout } from './components/SimpleLayout.tsx';
import { ClipDialog } from './components/ClipDialog.tsx';
import type { AppConfig, ClipResult, DocPayload } from './types.ts';
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
    root.dataset.accent = config.accent;
    root.dataset.density = config.density;
    root.style.setProperty('--reader-font-size', `${config.fontSize}px`);
    root.style.setProperty('--reader-line-height', String(config.lineHeight));
    root.style.setProperty('--reader-measure', `${config.measureCh}ch`);
    return () => media.removeEventListener('change', apply);
  }, [config]);
}

/**
 * 被宿主页面（DSH 右栏）嵌进来时的桥。
 *
 * 只认 `?embed=1` 的页面，且只回给宿主：报当前在哪一篇，接宿主给的「跳到这一篇」。
 * 出去的消息带 `source: 'enod'`，进来的必须是 `source: 'dsh'` 且指向本站。
 */
function useEmbedBridge(): void {
  useEffect(() => {
    if (window.parent === window) return;
    if (new URLSearchParams(window.location.search).get('embed') !== '1') return;

    const origin = window.location.origin;
    const post = (message: Record<string, unknown>) => {
      try {
        window.parent.postMessage({ source: 'enod', ...message }, '*');
      } catch {
        /* 宿主已经关了 */
      }
    };

    post({ type: 'enod:ready', href: window.location.href });
    // 宿主那边的监听可能比首帧晚一步，再报一次，代价可以忽略
    const again = window.setTimeout(() => post({ type: 'enod:ready', href: window.location.href }), 1200);

    const onHash = () => post({ type: 'enod:navigate', href: window.location.href });
    window.addEventListener('hashchange', onHash);

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; href?: string } | null;
      if (!data || data.source !== 'dsh' || data.type !== 'enod:open') return;
      if (typeof data.href !== 'string' || !data.href.startsWith(origin)) return;
      if (window.location.href === data.href) return;
      window.location.href = data.href;
    };
    window.addEventListener('message', onMessage);

    return () => {
      window.clearTimeout(again);
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('message', onMessage);
    };
  }, []);
}

function Shell() {
  const { info, config, loading, error, refresh } = useLibrary();
  const { toast } = useToast();
  const route = useRoute();
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [clipOpen, setClipOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [appMode, setAppMode] = useState<'simple' | 'complex'>(() => {
    try {
      // 移动端没有横向空间，直接进入「万卷」单栏书架；桌面保持「一页」。
      if (window.innerWidth <= 768) return 'complex';
      return localStorage.getItem('mr.app.mode') === 'complex' ? 'complex' : 'simple';
    } catch {
      return 'simple';
    }
  });

  // null = 首次加载（走视图自己的 view-in）；active = 正在切换；idle = 切换结束
  const [swap, setSwap] = useState<'active' | 'idle' | null>(null);

  const switchMode = useCallback((mode: 'simple' | 'complex') => {
    setSwap('active');
    setAppMode(mode);
    try {
      localStorage.setItem('mr.app.mode', mode);
    } catch {
      /* ignore */
    }
  }, []);

  // 托盘概览通过 ?view= / ?focus= / ?settings= / ?new= 唤起主界面
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    if (view === 'simple' || view === 'complex') switchMode(view);
    // 被 DSH 右栏嵌进来时（?embed=1）：去掉品牌栏，默认进阅读器
    if (params.get('embed') === '1') {
      document.documentElement.dataset.embed = '1';
      switchMode('complex');
    }
    if (params.get('focus') === 'search') setSearchOpen(true);
    if (params.get('settings') === '1') setSettingsOpen(true);
    if (params.get('new') === '1') setNewDocOpen(true);
    if (['view', 'focus', 'settings', 'new'].some((k) => params.has(k))) {
      const url = new URL(window.location.href);
      for (const key of ['view', 'focus', 'settings', 'new']) url.searchParams.delete(key);
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  }, [switchMode]);

  useEffect(() => {
    if (swap !== 'active') return;
    const timer = window.setTimeout(() => setSwap('idle'), 320);
    return () => window.clearTimeout(timer);
  }, [swap]);

  useTheme(config);
  useEmbedBridge();

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
    const dropEnabled = appMode === 'simple' || route.view === 'shelf';
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (event: DragEvent) => {
      if (!dropEnabled || !hasFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragOver(true);
    };
    const onOver = (event: DragEvent) => {
      if (!dropEnabled || !hasFiles(event)) return;
      event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragOver(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!dropEnabled || !hasFiles(event)) return;
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
  }, [appMode, route.view, importFiles, toast]);

  const backToShelf = useCallback(() => {
    window.location.hash = '#/';
  }, []);

  const handleClipped = useCallback(
    (result: ClipResult) => {
      void refresh();
      openDoc(result.doc.id);
    },
    [openDoc, refresh],
  );

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
    <div className="app" data-swap={swap ?? undefined}>
      {appMode === 'simple' ? (
        <SimpleLayout
          docId={route.view === 'doc' ? route.id : null}
          onOpenDoc={openDoc}
          onSwitchMode={() => switchMode('complex')}
          onNewDoc={() => setNewDocOpen(true)}
          onOpenClip={() => setClipOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
        />
      ) : route.view === 'doc' ? (
        <ReaderPage
          key={route.id}
          docId={route.id}
          onBack={backToShelf}
          onOpenDoc={openDoc}
          onSwitchMode={() => switchMode('simple')}
          onOpenSearch={() => setSearchOpen(true)}
        />
      ) : (
        <ShelfPage
          onOpenDoc={openDoc}
          onNewDoc={() => setNewDocOpen(true)}
          onOpenClip={() => setClipOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSwitchMode={() => switchMode('simple')}
        />
      )}

      {!info && !loading && (
        <div className="offline">
          <Icon name="alert" size={26} />
          <div>
            <strong>连接不上守护进程</strong>
            <p>{error ?? '请确认 enod 正在运行。'}</p>
          </div>
          <button className="btn btn-ghost" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      )}

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} onOpenDoc={openDoc} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ClipDialog
        open={clipOpen}
        onClose={() => setClipOpen(false)}
        onOpenDoc={openDoc}
        onClipped={handleClipped}
      />
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
