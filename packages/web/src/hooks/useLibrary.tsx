import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { api } from '../api.ts';
import type { AppConfig, DocSummary, LibraryInfo } from '../types.ts';

export interface TagCount {
  tag: string;
  count: number;
}

export interface ScanProgress {
  phase: 'idle' | 'walk' | 'index' | 'links' | 'done';
  done: number;
  total: number;
  current?: string;
}

interface LibraryContextValue {
  info: LibraryInfo | null;
  config: AppConfig | null;
  docs: DocSummary[];
  tags: TagCount[];
  docsById: Map<string, DocSummary>;
  loading: boolean;
  error: string | null;
  progress: ScanProgress | null;
  refresh: () => Promise<void>;
  refreshDocs: () => Promise<void>;
  applyConfig: (patch: Partial<AppConfig>) => Promise<AppConfig | null>;
  resolveWiki: (target: string, anchor?: string) => { href: string } | null;
  findDoc: (target: string) => DocSummary | null;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

function normalizeKey(text: string): string {
  return text.normalize('NFC').trim().toLowerCase();
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<LibraryInfo | null>(null);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const refreshDocs = useCallback(async () => {
    try {
      const next = await api.docs();
      setDocs(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载文档列表失败');
    }
  }, []);

  const refreshTags = useCallback(async () => {
    try {
      setTags(await api.tags());
    } catch {
      /* 标签失败不阻塞 */
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [library, docList, tagList] = await Promise.all([api.library(), api.docs(), api.tags()]);
      setInfo(library);
      setDocs(docList);
      setTags(tagList);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接守护进程');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshDocs();
      void refreshTags();
      void api.stats().then((stats) => setInfo((prev) => (prev ? { ...prev, stats } : prev))).catch(() => {});
    }, 220);
  }, [refreshDocs, refreshTags]);

  useEffect(() => {
    const es = new EventSource(api.eventsUrl());
    const onChanged = () => scheduleRefresh();
    const onIndexProgress = (ev: MessageEvent<string>) => {
      try {
        setProgress(JSON.parse(ev.data) as ScanProgress);
      } catch {
        /* ignore */
      }
    };
    const onIndexDone = () => {
      setProgress(null);
      scheduleRefresh();
      void api.library().then(setInfo).catch(() => {});
    };
    const onConfig = (ev: MessageEvent<string>) => {
      try {
        const config = JSON.parse(ev.data) as AppConfig;
        setInfo((prev) => (prev ? { ...prev, config } : prev));
      } catch {
        /* ignore */
      }
    };

    es.addEventListener('doc-changed', onChanged);
    es.addEventListener('doc-removed', onChanged);
    es.addEventListener('links-changed', onChanged);
    es.addEventListener('index-progress', onIndexProgress as EventListener);
    es.addEventListener('index-done', onIndexDone);
    es.addEventListener('config-changed', onConfig as EventListener);
    es.addEventListener('library-changed', () => {
      void refresh();
    });
    return () => {
      es.close();
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [refresh, scheduleRefresh]);

  const applyConfig = useCallback(async (patch: Partial<AppConfig>) => {
    try {
      const next = await api.updateConfig(patch);
      setInfo((prev) => (prev ? { ...prev, config: next } : prev));
      return next;
    } catch {
      return null;
    }
  }, []);

  const docsById = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);

  const findDoc = useCallback(
    (target: string): DocSummary | null => {
      const key = normalizeKey(target);
      if (!key) return null;
      return (
        docs.find((d) => normalizeKey(d.title) === key) ??
        docs.find((d) => d.aliases.some((a) => normalizeKey(a) === key)) ??
        docs.find((d) => normalizeKey(d.relPath.replace(/\.md$/i, '')) === key) ??
        docs.find((d) => normalizeKey(d.relPath.split('/').pop()!.replace(/\.md$/i, '')) === key) ??
        null
      );
    },
    [docs],
  );

  const resolveWiki = useCallback(
    (target: string) => {
      const doc = findDoc(target);
      return doc ? { href: `#/doc/${doc.id}` } : null;
    },
    [findDoc],
  );

  const value = useMemo<LibraryContextValue>(
    () => ({
      info,
      config: info?.config ?? null,
      docs,
      tags,
      docsById,
      loading,
      error,
      progress,
      refresh,
      refreshDocs,
      applyConfig,
      resolveWiki,
      findDoc,
    }),
    [info, docs, tags, docsById, loading, error, progress, refresh, refreshDocs, applyConfig, resolveWiki, findDoc],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error('useLibrary 必须在 LibraryProvider 内使用');
  return ctx;
}
