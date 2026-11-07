import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { UnlinkedMention } from '../api.ts';
import type {
  AiEntry,
  AiJob,
  AiKind,
  Annotation,
  AnnotationColor,
  ConflictDetail,
  DocPayload,
  DocStatus,
} from '../types.ts';
import { useLibrary } from '../hooks/useLibrary.tsx';
import { useToast } from '../hooks/useToast.tsx';
import { ArticleView } from './ArticleView.tsx';
import type { ArticleHandle } from './ArticleView.tsx';
import { EditorViewPane } from '../editor/EditorViewPane.tsx';
import type { EditorHandle } from '../editor/EditorViewPane.tsx';
import { Toc } from './Toc.tsx';
import type { TocItem } from './Toc.tsx';
import { SelectionToolbar } from './SelectionToolbar.tsx';
import { AiCard, kindLabel } from './AiCard.tsx';
import { ColumnResizer } from './ColumnResizer.tsx';
import { Lightbox } from './Lightbox.tsx';
import { ConflictDialog } from './ConflictDialog.tsx';
import { MoveDialog } from './DocDialogs.tsx';
import { Modal } from './Modal.tsx';
import { Icon } from './Icons.tsx';
import { getSelectionInfo } from '../lib/annotate.ts';
import type { SelectionInfo } from '../lib/annotate.ts';
import { clearFindMatches, highlightFindMatches } from '../lib/find.ts';
import { clamp, formatPercent, formatRelativeTime, formatWords, statusLabel } from '../lib/format.ts';

interface ReaderPageProps {
  docId: string;
  onBack: () => void;
  onOpenDoc: (id: string) => void;
  simple?: boolean;
  onSwitchMode?: () => void;
  onTocChange?: (items: TocItem[]) => void;
  onActiveChange?: (id: string | null) => void;
  onOpenSearch?: () => void;
}

type PanelTab = 'notes' | 'ai' | 'backlinks' | 'mentions' | 'links';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const STATUS_OPTIONS: { value: DocStatus; label: string }[] = [
  { value: 'unread', label: '未读' },
  { value: 'reading', label: '在读' },
  { value: 'done', label: '已读' },
];

const scrollMemory = new Map<string, number>();

/** 目录 / 批注栏的默认宽度，与 desktop.css 里的初始值保持一致。 */
const TOC_W_DEFAULT = 214;
const PANEL_W_DEFAULT = 312;

/** 读一个持久化的列宽；坏值回退默认。 */
function readStoredWidth(key: string, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key));
    return Number.isFinite(raw) && raw >= 120 ? raw : fallback;
  } catch {
    return fallback;
  }
}

/** 手机/平板是只读入口（PRD §3.3）：隐藏编辑与划线创建，查看批注不受影响。 */
const MOBILE_READ_ONLY =
  typeof window !== 'undefined' &&
  window.matchMedia('(pointer: coarse)').matches &&
  window.innerWidth <= 768;

export function ReaderPage({
  docId,
  onBack,
  onOpenDoc,
  simple = false,
  onSwitchMode,
  onTocChange,
  onActiveChange,
  onOpenSearch,
}: ReaderPageProps) {
  const { config, info, docs, resolveWiki, refreshDocs, applyConfig } = useLibrary();
  const { toast } = useToast();
  const focusMode = !simple && config?.readerLayout === 'focus';

  const [doc, setDoc] = useState<DocPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [conflict, setConflict] = useState<ConflictDetail | null>(null);
  const [externalChanged, setExternalChanged] = useState(false);
  const [toc, setToc] = useState<TocItem[]>([]);
  const onTocChangeRef = useRef(onTocChange);
  onTocChangeRef.current = onTocChange;
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const [orphans, setOrphans] = useState<string[]>([]);
  /** AI 产出里锚点在正文中已经找不到的（原文被改过） */
  const [aiOrphans, setAiOrphans] = useState<string[]>([]);
  const [mentions, setMentions] = useState<UnlinkedMention[]>([]);
  const [panelTab, setPanelTab] = useState<PanelTab>('notes');
  /** 这篇文档在 AI 队列里的任务（排队/跑着/失败），完成后会变成 doc.ai 的一条。 */
  const [aiJobs, setAiJobs] = useState<AiJob[]>([]);
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mr.reader.panel') !== '0';
    } catch {
      return true;
    }
  });
  const [tocOpen, setTocOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('mr.reader.toc') !== '0';
    } catch {
      return true;
    }
  });
  const [tocW, setTocW] = useState<number>(() => readStoredWidth('mr.reader.tocW', TOC_W_DEFAULT));
  const [panelW, setPanelW] = useState<number>(() => readStoredWidth('mr.reader.panelW', PANEL_W_DEFAULT));
  const [immersive, setImmersive] = useState(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCount, setFindCount] = useState(0);
  const [findIndex, setFindIndex] = useState(0);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const [progress, setProgress] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moveMode, setMoveMode] = useState<'move' | 'rename' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [focusAnnId, setFocusAnnId] = useState<string | null>(null);
  /** 侧栏里高亮的 AI 条目（从正文 ✦ 或「重跑」跳过来时） */
  const [focusAiId, setFocusAiId] = useState<string | null>(null);
  /** AI tab 里的自由提问输入 */
  const [aiQuestion, setAiQuestion] = useState('');

  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const articleRef = useRef<ArticleHandle>(null);
  const editorRef = useRef<EditorHandle>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<DocPayload | null>(null);
  const bodyRef = useRef('');
  const dirtyRef = useRef(false);
  const modeRef = useRef<'read' | 'edit'>('read');
  const progressRef = useRef(0);
  const saveInFlight = useRef(false);
  const pendingSave = useRef<string | null>(null);
  const scrollTick = useRef(false);
  const configRef = useRef(config);
  const toastRef = useRef(toast);
  configRef.current = config;
  toastRef.current = toast;

  const updateDoc = (updater: (current: DocPayload) => DocPayload) => {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      docRef.current = next;
      return next;
    });
  };

  useEffect(() => {
    try {
      localStorage.setItem('mr.reader.panel', panelOpen ? '1' : '0');
      localStorage.setItem('mr.reader.toc', tocOpen ? '1' : '0');
      localStorage.setItem('mr.reader.tocW', String(tocW));
      localStorage.setItem('mr.reader.panelW', String(panelW));
    } catch {
      /* ignore */
    }
    const panel = panelRef.current as (HTMLElement & { inert?: boolean }) | null;
    if (panel) panel.inert = !panelOpen || focusMode;
  }, [panelOpen, tocOpen, tocW, panelW, focusMode, doc?.id]);

  /* ---------------------------------------------------------------- load */

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMode('read');
    modeRef.current = 'read';
    setDirty(false);
    dirtyRef.current = false;
    setSaveState('idle');
    setConflict(null);
    setExternalChanged(false);
    setSelection(null);
    setOrphans([]);
    setAiOrphans([]);
    setFocusAiId(null);
    setProgress(0);
    setActiveHeading(null);
    onActiveChangeRef.current?.(null);
    setFindOpen(false);
    setFindQuery('');
    setFindCount(0);
    setFindIndex(0);
    setMoreOpen(false);

    api
      .doc(docId)
      .then((payload) => {
        if (cancelled) return;
        setDoc(payload);
        docRef.current = payload;
        bodyRef.current = payload.body;
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '无法打开文档');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  // 恢复滚动位置
  useEffect(() => {
    if (!doc) return;
    const el = scrollRef.current;
    if (!el) return;
    const saved = scrollMemory.get(doc.id);
    const ratio = saved ?? doc.progress ?? 0;
    requestAnimationFrame(() => {
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0) el.scrollTop = clamp(ratio, 0, 1) * max;
    });
  }, [doc?.id]);

  // 离开文档时记录进度
  useEffect(() => {
    const id = docId;
    return () => {
      const ratio = progressRef.current;
      if (!Number.isFinite(ratio)) return;
      scrollMemory.set(id, ratio);
      try {
        localStorage.setItem(`mr.progress.${id}`, String(ratio));
      } catch {
        /* ignore */
      }
      if (configRef.current?.syncProgress) {
        void api.saveDoc(id, { reader: { progress: ratio } }).catch(() => {});
      }
    };
  }, [docId]);

  /* ---------------------------------------------------------------- SSE */

  useEffect(() => {
    const es = new EventSource(api.eventsUrl());
    const onChanged = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as { id?: string; origin?: string; kind?: string };
        if (data.id !== docId) return;
        if (data.origin === 'save' || data.origin === 'create') return;
        if (data.kind === 'removed') {
          toastRef.current('这篇文档已被删除', 'error');
          onBack();
          return;
        }
        if (modeRef.current === 'edit' && dirtyRef.current) {
          setExternalChanged(true);
          return;
        }
        void api.doc(docId).then((fresh) => {
          const el = scrollRef.current;
          const keep = el ? el.scrollTop : 0;
          setDoc(fresh);
          docRef.current = fresh;
          bodyRef.current = fresh.body;
          requestAnimationFrame(() => {
            if (el) el.scrollTop = keep;
          });
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    };
    const onRemoved = (event: MessageEvent<string>) => {
      try {
        const data = JSON.parse(event.data) as { id?: string };
        if (data.id !== docId) return;
        toastRef.current('这篇文档已被删除', 'error');
        onBack();
      } catch {
        /* ignore */
      }
    };
    es.addEventListener('doc-changed', onChanged as EventListener);
    es.addEventListener('doc-removed', onRemoved as EventListener);
    return () => es.close();
  }, [docId, onBack]);

  /* ---------------------------------------------------------------- mentions */

  useEffect(() => {
    if (panelTab !== 'mentions' || !doc) return;
    let cancelled = false;
    setMentions([]);
    api
      .mentions(doc.id)
      .then((list) => {
        if (!cancelled) setMentions(list);
      })
      .catch(() => {
        if (!cancelled) setMentions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [panelTab, doc?.id, doc?.title]);

  /* ---------------------------------------------------------------- find */

  useEffect(() => {
    if (mode !== 'read') return;
    const container = scrollRef.current?.querySelector<HTMLElement>('.article');
    if (!container) return;
    if (!findOpen || !findQuery.trim()) {
      clearFindMatches(container);
      setFindCount(0);
      setFindIndex(0);
      return;
    }
    const marks = highlightFindMatches(container, findQuery, findIndex);
    setFindCount(marks.length);
    if (marks.length === 0) {
      if (findIndex !== 0) setFindIndex(0);
    } else if (findIndex >= marks.length) {
      setFindIndex(0);
    }
  }, [findOpen, findQuery, findIndex, mode, doc?.body, doc?.annotations]);

  useEffect(() => {
    if (mode === 'edit' && findOpen) {
      setFindOpen(false);
      setFindQuery('');
      setFindCount(0);
      setFindIndex(0);
    }
  }, [mode, findOpen]);

  /* ---------------------------------------------------------------- save */

  const save = async (body: string, opts: { baseHash?: string } = {}): Promise<boolean> => {
    const current = docRef.current;
    if (!current) return false;
    if (saveInFlight.current) {
      pendingSave.current = body;
      return false;
    }
    saveInFlight.current = true;
    setSaveState('saving');
    try {
      const res = await api.saveDoc(current.id, { body, baseHash: opts.baseHash ?? current.rawHash });
      updateDoc((d) => ({
        ...d,
        body,
        rawHash: res.hash,
        mtime: res.mtime,
        encoding: res.encoding,
        words: countWordsApprox(body),
      }));
      bodyRef.current = body;
      setDirty(false);
      dirtyRef.current = false;
      editorRef.current?.markSaved();
      setSaveState('saved');
      window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1600);
      void refreshDocs();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const detail = err.detail as ConflictDetail;
        setConflict(detail);
        setSaveState('error');
        return false;
      }
      setSaveState('error');
      toastRef.current(err instanceof Error ? err.message : '保存失败', 'error');
      return false;
    } finally {
      saveInFlight.current = false;
      const queued = pendingSave.current;
      pendingSave.current = null;
      if (queued !== null) void save(queued);
    }
  };

  const saveRef = useRef(save);
  saveRef.current = save;

  const exitEdit = async (): Promise<void> => {
    if (modeRef.current !== 'edit') return;
    if (dirtyRef.current) {
      const ok = await saveRef.current(bodyRef.current);
      if (!ok) return;
    }
    setMode('read');
    modeRef.current = 'read';
    setSaveState('idle');
    setDirty(false);
    dirtyRef.current = false;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const ratio = clamp(progressRef.current, 0, 1);
      el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight);
    });
  };

  const enterEdit = (): void => {
    if (!doc) return;
    if (MOBILE_READ_ONLY) return;
    // 非 markdown 文件是只读浏览（原文件不能被这次编辑覆盖）
    if (doc.editable === false) return;
    setMode('edit');
    modeRef.current = 'edit';
    setDirty(false);
    dirtyRef.current = false;
    setSaveState('idle');
    setSelection(null);
    setExternalChanged(false);
  };

  const closeFind = (): void => {
    setFindOpen(false);
    setFindQuery('');
    setFindCount(0);
    setFindIndex(0);
    const container = scrollRef.current?.querySelector<HTMLElement>('.article');
    if (container) clearFindMatches(container);
  };

  const stepFind = (delta: number): void => {
    if (findCount <= 0) return;
    setFindIndex((prev) => (prev + delta + findCount) % findCount);
  };

  /* ------------------------------------------------------- external reload */

  const reloadFromDisk = async (): Promise<void> => {
    try {
      const fresh = await api.doc(docId);
      const el = scrollRef.current;
      const keep = el ? el.scrollTop : 0;
      setDoc(fresh);
      docRef.current = fresh;
      bodyRef.current = fresh.body;
      setExternalChanged(false);
      setDirty(false);
      dirtyRef.current = false;
      editorRef.current?.setBody(fresh.body);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = keep;
      });
      toast('已载入磁盘上的最新版本', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '载入失败', 'error');
    }
  };

  /* ------------------------------------------------------------- actions */

  const changeStatus = async (status: DocStatus): Promise<void> => {
    const current = docRef.current;
    if (!current) return;
    try {
      const res = await api.setStatus(current.id, status);
      updateDoc((d) => ({ ...d, status, rawHash: res.hash, mtime: res.mtime }));
      void refreshDocs();
    } catch (err) {
      toast(err instanceof Error ? err.message : '修改状态失败', 'error');
    }
  };

  const createAnnotation = async (color: AnnotationColor, withNote = false): Promise<void> => {
    const current = docRef.current;
    if (!current || !selection) return;
    try {
      const res = await api.addAnnotation(current.id, {
        exact: selection.exact,
        prefix: selection.prefix,
        suffix: selection.suffix,
        pos: selection.pos,
        color,
      });
      updateDoc((d) => ({ ...d, annotations: [...d.annotations, res.annotation], annCount: d.annCount + 1 }));
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      if (withNote) {
        setPanelOpen(true);
        setPanelTab('notes');
        setFocusAnnId(res.annotation.id);
      }
      toast(withNote ? '已高亮，写点想法吧' : '已添加高亮', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '添加批注失败', 'error');
    }
  };

  const saveNote = async (annotation: Annotation, note: string): Promise<void> => {
    const current = docRef.current;
    if (!current || note === annotation.note) return;
    try {
      const res = await api.updateAnnotation(current.id, annotation.id, { note });
      updateDoc((d) => ({
        ...d,
        annotations: d.annotations.map((a) => (a.id === annotation.id ? res.annotation : a)),
      }));
    } catch (err) {
      toast(err instanceof Error ? err.message : '批注保存失败', 'error');
    }
  };

  const deleteAnnotation = async (annotation: Annotation): Promise<void> => {
    const current = docRef.current;
    if (!current) return;
    try {
      await api.deleteAnnotation(current.id, annotation.id);
      updateDoc((d) => ({
        ...d,
        annotations: d.annotations.filter((a) => a.id !== annotation.id),
        annCount: Math.max(0, d.annCount - 1),
      }));
      toast('已删除批注', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  const rebindAnnotation = async (annotation: Annotation): Promise<void> => {
    const current = docRef.current;
    if (!current) return;
    if (!selection) {
      toast('先在正文中选中要重新绑定的文字', 'error');
      return;
    }
    try {
      const created = await api.addAnnotation(current.id, {
        exact: selection.exact,
        prefix: selection.prefix,
        suffix: selection.suffix,
        pos: selection.pos,
        color: annotation.color,
        note: annotation.note,
      });
      await api.deleteAnnotation(current.id, annotation.id);
      updateDoc((d) => ({
        ...d,
        annotations: [...d.annotations.filter((a) => a.id !== annotation.id), created.annotation],
      }));
      setSelection(null);
      window.getSelection()?.removeAllRanges();
      toast('已重新绑定', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '重新绑定失败', 'error');
    }
  };

  /* --------------------------------------------------------------- AI 队列 */

  const refreshAiJobs = async (): Promise<void> => {
    const current = docRef.current;
    if (!current) return;
    try {
      const res = await api.aiJobs({ docId: current.id });
      setAiJobs(res.items.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'error'));
    } catch {
      /* 队列查询失败不该打断阅读 */
    }
  };

  useEffect(() => {
    if (panelTab !== 'ai') return;
    void refreshAiJobs();
    const timer = window.setInterval(() => void refreshAiJobs(), 5000);
    return () => window.clearInterval(timer);
  }, [panelTab, docId]);

  const enqueueAi = async (
    kind: AiKind,
    anchor?: { exact: string; prefix: string; suffix: string; pos: number },
  ): Promise<void> => {
    const current = docRef.current;
    if (!current) return;
    const source =
      anchor ??
      (selection
        ? { exact: selection.exact, prefix: selection.prefix, suffix: selection.suffix, pos: selection.pos }
        : null);
    if (!source && kind !== 'summarize') {
      toast('先在正文里选中一段文字', 'error');
      return;
    }
    try {
      const res = await api.createAiJob({
        docId: current.id,
        kind,
        exact: source?.exact ?? '',
        prefix: source?.prefix ?? '',
        suffix: source?.suffix ?? '',
        pos: source?.pos ?? 0,
      });
      setPanelOpen(true);
      setPanelTab('ai');
      if (source) {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      }
      await refreshAiJobs();
      toast(res.deduped ? '这条已经在队列里了' : '已入队，等 DSH 侧领走', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '入队失败', 'error');
    }
  };

  const cancelAiJob = async (jobId: string): Promise<void> => {
    try {
      await api.cancelAiJob(jobId);
      await refreshAiJobs();
      toast('已取消', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '取消失败', 'error');
    }
  };

  const deleteAi = async (entry: AiEntry): Promise<void> => {
    const current = docRef.current;
    if (!current) return;
    try {
      const res = await api.deleteAiEntry(current.id, entry.id);
      updateDoc((d) => ({ ...d, ai: res.ai ?? d.ai.filter((item) => item.id !== entry.id) }));
      toast('已删除这条 AI 产出', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  const jumpToAi = (entry: AiEntry): void => {
    if (!entry.exact.trim()) {
      toast('这条是整篇概括，正文里没有对应锚点', 'info');
      return;
    }
    if (aiOrphans.includes(entry.id)) {
      toast('原文改动太多，这条的锚点已经对不上了', 'error');
      return;
    }
    articleRef.current?.flashAi(entry.id);
  };

  /** AI tab 里的自由提问：带上当前选区（没选就整篇）。 */
  const askAi = async (): Promise<void> => {
    const current = docRef.current;
    if (!current) return;
    const question = aiQuestion.trim();
    if (!question) {
      toast('先写一句想问的', 'error');
      return;
    }
    try {
      const res = await api.createAiJob({
        docId: current.id,
        kind: 'ask',
        exact: selection?.exact ?? '',
        prefix: selection?.prefix ?? '',
        suffix: selection?.suffix ?? '',
        pos: selection?.pos ?? 0,
        question,
      });
      setAiQuestion('');
      setPanelOpen(true);
      setPanelTab('ai');
      if (selection) {
        setSelection(null);
        window.getSelection()?.removeAllRanges();
      }
      await refreshAiJobs();
      toast(res.deduped ? '这条已经在队列里了' : '已入队，等 DSH 侧领走', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : '入队失败', 'error');
    }
  };

  const uploadImage = async (file: File): Promise<string | null> => {
    const current = docRef.current;
    if (!current) return null;
    try {
      const res = await api.uploadAsset(current.id, file, file.name || 'pasted.png');
      toast('图片已保存到 assets/', 'success');
      return res.relPath;
    } catch (err) {
      toast(err instanceof Error ? err.message : '图片上传失败', 'error');
      return null;
    }
  };

  const copyQuote = async (): Promise<void> => {
    if (!selection) return;
    const quote = `> ${selection.exact}\n\n——「${doc?.title ?? ''}」`;
    try {
      await navigator.clipboard.writeText(quote);
      toast('引用已复制', 'success');
    } catch {
      toast('复制失败', 'error');
    }
    setSelection(null);
  };

  const exportAnnotations = (): void => {
    const current = docRef.current;
    if (!current || current.annotations.length === 0) return;
    const lines: string[] = [
      `# 批注：${current.title}`,
      '',
      `> ${current.relPath} · 导出于 ${new Date().toLocaleString('zh-CN')}`,
      '',
    ];
    current.annotations.forEach((ann, index) => {
      lines.push(`## ${index + 1}. ${ann.exact.replace(/\s+/g, ' ').trim()}`, '');
      if (ann.note.trim()) lines.push(ann.note.trim(), '');
      lines.push(
        `- 颜色：${ann.color}`,
        `- 时间：${ann.created || '未知'}`,
        `- 位置：${ann.pos}`,
        '',
      );
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${current.title.replace(/[\\/:*?"<>|]/g, '-')}-批注.md`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast('批注已导出为 Markdown', 'success');
  };

  const linkMention = async (mention: UnlinkedMention): Promise<void> => {
    const current = docRef.current;
    if (!current) return;
    try {
      const source = await api.doc(mention.id);
      const title = current.title.normalize('NFC');
      const re = new RegExp(escapeRegExp(title), 'g');
      let targetIndex = -1;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source.body))) {
        const open = source.body.lastIndexOf('[[', match.index);
        if (open !== -1) {
          const close = source.body.indexOf(']]', open);
          if (close === -1 || match.index < close) continue;
        }
        targetIndex = match.index;
        break;
      }
      if (targetIndex < 0) {
        toast('正文里没找到可替换的纯文本提及', 'error');
        return;
      }
      const body =
        source.body.slice(0, targetIndex) + `[[${title}]]` + source.body.slice(targetIndex + title.length);
      await api.saveDoc(mention.id, { body, baseHash: source.rawHash });
      setMentions((prev) => prev.filter((item) => item.id !== mention.id));
      toast(`已在「${mention.title}」里加上链接`, 'success');
      void refreshDocs();
    } catch (err) {
      toast(err instanceof Error ? err.message : '加链接失败', 'error');
    }
  };

  /* --------------------------------------------------------------- events */

  useEffect(() => {
    const onMouseUp = () => {
      window.setTimeout(() => {
        const article = scrollRef.current?.querySelector<HTMLElement>('.article');
        if (!article) return;
        setSelection(getSelectionInfo(article));
      }, 0);
    };
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const typing = target
        ? Boolean(target.closest('input, textarea, [contenteditable="true"], .cm-editor'))
        : false;
      if (event.key === 'Escape') {
        if (findOpen) {
          closeFind();
          return;
        }
        if (moreOpen) {
          setMoreOpen(false);
          return;
        }
        if (selection) {
          setSelection(null);
          return;
        }
        if (immersive) {
          setImmersive(false);
          return;
        }
        if (modeRef.current === 'edit') {
          void exitEdit();
          return;
        }
        if (typing) return;
        if (focusMode) {
          void applyConfig({ readerLayout: 'document' });
          return;
        }
        if (!simple) {
          onBack();
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && modeRef.current === 'read') {
        event.preventDefault();
        setFindOpen(true);
        window.setTimeout(() => {
          findInputRef.current?.focus();
          findInputRef.current?.select();
        }, 30);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setPanelOpen((value) => !value);
        return;
      }
      if (typing) return;
      if (event.key === 'e' || event.key === 'E') {
        if (modeRef.current === 'read') enterEdit();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        if (modeRef.current === 'read') enterEdit();
        else void exitEdit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, immersive, moreOpen, findOpen, simple, focusMode, applyConfig, onBack]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const ratio = max > 0 ? clamp(el.scrollTop / max, 0, 1) : 0;
    progressRef.current = ratio;
    if (scrollTick.current) return;
    scrollTick.current = true;
    requestAnimationFrame(() => {
      scrollTick.current = false;
      setProgress(ratio);
      const containerTop = el.getBoundingClientRect().top;
      const headings = [...el.querySelectorAll<HTMLElement>('h1, h2, h3')];
      let current: string | null = null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top - containerTop <= 150) current = heading.id;
        else break;
      }
      // 滚到底时最后一节可能永远到不了顶部阈值，强制选中最后一个标题
      const atBottom = max > 0 && el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
      if (atBottom && headings.length > 0) current = headings[headings.length - 1]!.id;
      setActiveHeading(current);
      onActiveChangeRef.current?.(current);
    });
  };

  const jumpToAnnotation = (id: string): void => {
    articleRef.current?.flash(id);
    setFocusAnnId(id);
  };

  /** 从正文里的 ✦ 点进来：开侧栏、切 AI tab、把那条滚进视野。 */
  const jumpToAiById = (aiId: string): void => {
    setPanelOpen(true);
    setPanelTab('ai');
    setFocusAiId(aiId);
    window.setTimeout(() => {
      const el = document.getElementById(`ai-${aiId}`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 60);
  };

  const handleWikiNavigate = (href: string, anchor: string | null): void => {
    const target = href.replace(/^#\/doc\//, '');
    if (target === docId) {
      if (anchor) articleRef.current?.scrollToHeading(anchor);
      return;
    }
    onOpenDoc(target);
    if (anchor) {
      window.setTimeout(() => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
        el?.scrollIntoView({ block: 'start' });
      }, 400);
    }
  };

  const annotationList = doc?.annotations ?? [];
  const aiList = doc?.ai ?? [];
  const orphanList = useMemo(() => annotationList.filter((a) => orphans.includes(a.id)), [annotationList, orphans]);
  const healthyList = useMemo(() => annotationList.filter((a) => !orphans.includes(a.id)), [annotationList, orphans]);
  const statusLabelText = doc ? statusLabel(doc.status) : '';
  const theme = config?.theme === 'dark' || (config?.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';

  if (loading) {
    return (
      <div className="reader">
        <div className="reader-loading">
          <div className="spinner" />
          <p className="muted">正在打开…</p>
        </div>
      </div>
    );
  }

  if (error || !doc) {
    return (
      <div className="reader">
        <div className="reader-error">
          <Icon name="alert" size={28} />
          <h2>打不开这篇文档</h2>
          <p className="muted">{error ?? '未知错误'}</p>
          <button className="btn btn-ghost" onClick={onBack}>
            回到书架
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`reader ${immersive ? 'immersive' : ''} ${focusMode ? 'focus-mode' : ''} ${simple ? 'simple-view' : ''}`}>
      <header className="reader-head">
        {!simple && (
          <button className="icon-btn" onClick={onBack} title="返回书架（Esc）">
            <Icon name="back" size={19} />
          </button>
        )}

        <div className="reader-title">
          <h1 title={doc.title}>{doc.title}</h1>
          <div className="reader-meta">
            <span>{doc.relPath}</span>
            <span>{formatWords(doc.words)}</span>
            <span>更新于 {formatRelativeTime(doc.mtime)}</span>
            {doc.encoding !== 'utf8' && <span className="encoding-badge">{doc.encoding.toUpperCase()}</span>}
            {doc.kind && doc.kind !== 'md' && (
              <span
                className="encoding-badge"
                title={doc.editable ? '原文件可编辑，保存时保持原编码与换行' : '原文件只读，正文由格式适配层转换'}
              >
                {doc.editable ? '可编辑' : '只读'} · {doc.kind.toUpperCase()}
              </span>
            )}
            {mode === 'edit' && (
              <span className={`save-state ${saveState} ${dirty ? 'dirty' : ''}`}>
                {saveState === 'saving'
                  ? '保存中…'
                  : saveState === 'error'
                    ? '保存失败'
                    : dirty
                      ? '未保存'
                      : '已保存'}
              </span>
            )}
          </div>
        </div>

        <div className="reader-actions">
          {mode === 'read' && (
            <button
              className="icon-btn"
              onClick={() => {
                if (findOpen) closeFind();
                onOpenSearch?.();
              }}
              title="搜索书库（Ctrl+K）"
              aria-label="搜索书库"
            >
              <Icon name="search" size={16} />
            </button>
          )}
          {mode === 'read' && !simple && (
            <select
              className="select status-select"
              value={doc.status}
              onChange={(e) => void changeStatus(e.target.value as DocStatus)}
              title="阅读状态"
              aria-label="阅读状态"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          {mode === 'read' && doc.editable !== false && !MOBILE_READ_ONLY && (
            <button className="icon-btn" onClick={enterEdit} title="编辑（E）" aria-label="编辑">
              <Icon name="edit" size={16} />
            </button>
          )}
          {mode === 'read' && !simple && (
            <button
              className={`icon-btn ${focusMode ? 'active' : ''}`}
              onClick={() => void applyConfig({ readerLayout: focusMode ? 'document' : 'focus' })}
              title={focusMode ? '退出专注模式' : '专注模式'}
              aria-label="切换专注模式"
            >
              <Icon name="layout" size={16} />
            </button>
          )}
          {mode === 'edit' && (
            <>
              <button className="btn btn-ghost small" onClick={() => void saveRef.current(bodyRef.current)}>
                <Icon name="save" size={14} />
                保存
              </button>
              <button className="btn btn-primary small" onClick={() => void exitEdit()}>
                完成
              </button>
            </>
          )}
          <div className="more-wrap">
            <button
              className={`icon-btn ${moreOpen ? 'active' : ''}`}
              onClick={() => setMoreOpen((v) => !v)}
              title="更多"
              aria-label="更多"
              aria-expanded={moreOpen}
            >
              <Icon name="more" size={17} />
            </button>
            {moreOpen && (
              <div className="menu" onMouseLeave={() => setMoreOpen(false)}>
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    setMoveMode('rename');
                  }}
                >
                  <Icon name="edit" size={15} /> 重命名
                </button>
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    setMoveMode('move');
                  }}
                >
                  <Icon name="folder" size={15} /> 移动到…
                </button>
                <span className="menu-sep" />
                {doc.kind !== 'md' && (
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      window.open(api.exportUrl(doc.id), '_blank', 'noopener');
                    }}
                  >
                    <Icon name="save" size={15} /> 导出 Markdown
                  </button>
                )}
                {(doc.kind === 'docx' || doc.kind === 'html') && (
                  <>
                    <button
                      onClick={() => {
                        setMoreOpen(false);
                        void api
                          .openWithSystem(doc.id)
                          .catch((err) => toast(err instanceof Error ? err.message : '无法调起系统程序', 'error'));
                      }}
                    >
                      <Icon name="external" size={15} /> 用系统程序打开
                    </button>
                    <button
                      onClick={() => {
                        setMoreOpen(false);
                        void api
                          .convertToMd(doc.id)
                          .then((created) => {
                            toast(`已生成「${created.relPath}」`, 'success');
                            window.location.hash = `#/doc/${created.id}`;
                          })
                          .catch((err) => toast(err instanceof Error ? err.message : '转换失败', 'error'));
                      }}
                    >
                      <Icon name="copy" size={15} /> 转为 Markdown 副本
                    </button>
                  </>
                )}
                <span className="menu-sep" />
                {!simple && (
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      setImmersive((v) => !v);
                    }}
                  >
                    <Icon name="book" size={15} />
                    {immersive ? '退出沉浸模式' : '沉浸模式'}
                    <kbd>Esc</kbd>
                  </button>
                )}
                {!simple && onSwitchMode && (
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      onSwitchMode();
                    }}
                  >
                    <Icon name="portal" size={15} className="flip-x" /> 切换到一页
                  </button>
                )}
                <span className="menu-sep" />
                <button
                  className="danger"
                  onClick={() => {
                    setMoreOpen(false);
                    setConfirmDelete(true);
                  }}
                >
                  <Icon name="trash" size={15} /> 删除（进 .trash）
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {immersive && (
        <button className="immersive-exit" onClick={() => setImmersive(false)} title="退出沉浸模式（Esc）">
          <Icon name="close" size={13} />
          退出沉浸
        </button>
      )}

      <div className="progress-line" aria-hidden="true">
        <i style={{ width: formatPercent(progress) }} />
      </div>

      {externalChanged && (
        <div className="banner warning">
          <Icon name="alert" size={16} />
          <span>磁盘上的文件被外部修改了。你的编辑还没保存，保存时会要求你处理冲突。</span>
          <button className="btn btn-ghost small" onClick={() => void reloadFromDisk()}>
            载入磁盘版本
          </button>
        </div>
      )}

      <div className="reader-main">
        {!immersive && !simple && (
          <Toc
            items={toc}
            activeId={activeHeading}
            collapsed={focusMode || !tocOpen}
            width={tocW}
            onResize={setTocW}
            onResetWidth={() => setTocW(TOC_W_DEFAULT)}
            onCollapse={() => setTocOpen(false)}
            onJump={(id) => articleRef.current?.scrollToHeading(id)}
          />
        )}

        {!immersive && !simple && !focusMode && !tocOpen && (
          <button
            className="toc-handle"
            onClick={() => setTocOpen(true)}
            title="展开目录"
            aria-label="展开目录"
          >
            <Icon name="chevrons-right" size={13} />
            <span className="toc-handle-label">目录</span>
          </button>
        )}

        <div className="reader-content">
          {findOpen && mode === 'read' && (
            <div className="find-bar">
              <Icon name="search" size={14} />
              <input
                ref={findInputRef}
                value={findQuery}
                placeholder="在本文中查找"
                spellCheck={false}
                onChange={(event) => {
                  setFindQuery(event.target.value);
                  setFindIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    stepFind(event.shiftKey ? -1 : 1);
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeFind();
                  }
                }}
              />
              <span className={`find-count ${findQuery && findCount === 0 ? 'empty' : ''}`}>
                {findQuery ? (findCount > 0 ? `${findIndex + 1}/${findCount}` : '无结果') : ''}
              </span>
              <button className="icon-btn tiny" onClick={() => stepFind(-1)} disabled={findCount === 0} title="上一个（Shift+Enter）">
                <Icon name="up" size={14} />
              </button>
              <button className="icon-btn tiny" onClick={() => stepFind(1)} disabled={findCount === 0} title="下一个（Enter）">
                <Icon name="down" size={14} />
              </button>
              <button className="icon-btn tiny" onClick={closeFind} title="关闭（Esc）">
                <Icon name="close" size={13} />
              </button>
            </div>
          )}
          {doc.source?.url && mode === 'read' && (
            <div className="source-bar">
              <Icon name="link" size={14} />
              <span>来源：{doc.source.site ?? doc.source.url}</span>
              <a href={doc.source.url} target="_blank" rel="noopener noreferrer">
                打开原文
                <Icon name="external" size={12} />
              </a>
            </div>
          )}

          {mode === 'read' ? (
            <div className="reader-scroll" ref={scrollRef} onScroll={onScroll}>
              <div className="article-wrap">
                <ArticleView
                  ref={articleRef}
                  doc={doc}
                  theme={theme}
                  resolveWiki={resolveWiki}
                  onNavigateWiki={handleWikiNavigate}
                  onAnnotationClick={jumpToAnnotation}
                  onAiClick={jumpToAiById}
                  onAiDelete={(entry) => void deleteAi(entry)}
                  onToc={(items) => {
                    setToc(items);
                    onTocChangeRef.current?.(items);
                  }}
                  onAnchors={({ orphaned, aiOrphaned }) => {
                    setOrphans(orphaned);
                    setAiOrphans(aiOrphaned);
                  }}
                  onImage={(src, alt) => setLightbox({ src, alt })}
                />
                <footer className="article-foot">
                  <span>{formatWords(doc.words)}</span>
                  <span>{doc.relPath}</span>
                  <span>{annotationList.length} 条批注</span>
                </footer>
              </div>
            </div>
          ) : (
            <div className="editor-pane">
              <EditorViewPane
                ref={editorRef}
                docId={doc.id}
                kind={doc.kind}
                initialBody={bodyRef.current}
                docs={docs}
                autosave={config?.autosave ?? true}
                imageUrl={(src) => api.fileUrl(src)}
                resolveWiki={(target) => resolveWiki(target)}
                onBodyChange={(body) => {
                  bodyRef.current = body;
                }}
                onDirtyChange={setDirty}
                onSaveRequest={() => void saveRef.current(bodyRef.current)}
                onExitRequest={() => void exitEdit()}
                onUploadImage={uploadImage}
              />
            </div>
          )}
        </div>

        {!immersive && (
          <aside
            className={`side-panel ${panelOpen && !focusMode ? '' : 'closed'}`}
            ref={panelRef}
            aria-hidden={!panelOpen || focusMode}
            style={panelOpen && !focusMode ? { width: `${panelW}px` } : undefined}
          >
            {panelOpen && !focusMode && (
              <ColumnResizer
                width={panelW}
                min={260}
                max={620}
                side="right"
                onChange={setPanelW}
                onReset={() => setPanelW(PANEL_W_DEFAULT)}
                label="批注栏宽度"
              />
            )}
            <div className="side-panel-inner">
              <div className="panel-head">
                <div className="panel-tabs">
                  <button className={panelTab === 'notes' ? 'active' : ''} onClick={() => setPanelTab('notes')}>
                    批注 <span className="count">{annotationList.length}</span>
                  </button>
                  <button className={panelTab === 'ai' ? 'active' : ''} onClick={() => setPanelTab('ai')}>
                    AI <span className="count">{aiList.length + aiJobs.length}</span>
                  </button>
                  <button className={panelTab === 'backlinks' ? 'active' : ''} onClick={() => setPanelTab('backlinks')}>
                    反链 <span className="count">{doc.backlinks.length}</span>
                  </button>
                  <button className={panelTab === 'mentions' ? 'active' : ''} onClick={() => setPanelTab('mentions')}>
                    提及
                  </button>
                  <button className={panelTab === 'links' ? 'active' : ''} onClick={() => setPanelTab('links')}>
                    出链 <span className="count">{doc.links.length}</span>
                  </button>
                </div>
                <button
                  className="icon-btn panel-collapse"
                  onClick={() => setPanelOpen(false)}
                  title="收起侧边栏（Ctrl+Shift+B）"
                  aria-label="收起侧边栏"
                >
                  <Icon name="chevrons-right" size={14} />
                </button>
              </div>

              <div className="panel-body">
              {panelTab === 'notes' && (
                <>
                  {annotationList.length > 0 && (
                    <div className="panel-toolbar">
                      <span>{annotationList.length} 条批注</span>
                      <button className="btn btn-ghost tiny" onClick={exportAnnotations} title="导出为 Markdown">
                        <Icon name="external" size={12} /> 导出
                      </button>
                    </div>
                  )}
                  {annotationList.length === 0 && (
                    <p className="panel-empty">选中正文中的一段文字，就能划高亮、写旁注。批注会写进这篇文件的 frontmatter。</p>
                  )}
                  {orphanList.length > 0 && (
                    <section className="orphan-group">
                      <h4>
                        <Icon name="alert" size={14} /> 已失效批注（{orphanList.length}）
                      </h4>
                      <p className="muted small">原文被改动太多，找不到锚点。选中新的文字后可重新绑定。</p>
                      {orphanList.map((ann) => (
                        <article key={ann.id} className="ann-item orphan">
                          <blockquote>{ann.exact}</blockquote>
                          <div className="ann-actions">
                            <button className="btn btn-ghost tiny" onClick={() => void rebindAnnotation(ann)}>
                              绑定到选中文字
                            </button>
                            <button className="btn btn-ghost tiny danger" onClick={() => void deleteAnnotation(ann)}>
                              删除
                            </button>
                          </div>
                        </article>
                      ))}
                    </section>
                  )}
                  {healthyList.map((ann) => (
                    <AnnotationCard
                      key={ann.id}
                      annotation={ann}
                      focused={focusAnnId === ann.id}
                      onJump={() => jumpToAnnotation(ann.id)}
                      onSaveNote={(note) => void saveNote(ann, note)}
                      onDelete={() => void deleteAnnotation(ann)}
                    />
                  ))}
                </>
              )}

              {panelTab === 'ai' && (
                <>
                  <div className="panel-toolbar">
                    <span>
                      {aiList.length} 条产出
                      {aiJobs.length > 0 ? ` · ${aiJobs.length} 条在队列` : ''}
                    </span>
                    <button
                      className="btn btn-ghost tiny"
                      onClick={() => void enqueueAi('summarize')}
                      disabled={!doc.aiEnabled}
                      title="让 AI 概括整篇"
                    >
                      <Icon name="sparkle" size={12} /> 概括全文
                    </button>
                  </div>
                  {!doc.aiEnabled && (
                    <p className="panel-empty">
                      这篇文档关掉了 AI。把 frontmatter 里的 <code>reader.ai: false</code> 去掉就会重新接任务。
                    </p>
                  )}
                  {doc.aiEnabled && (
                    <div className="ai-ask">
                      <textarea
                        className="ai-ask-input"
                        rows={2}
                        placeholder={
                          selection
                            ? `就选中的「${selection.exact.slice(0, 20)}」提问…`
                            : '就整篇提问（先选中一段也可以）…'
                        }
                        value={aiQuestion}
                        onChange={(event) => setAiQuestion(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            void askAi();
                          }
                        }}
                      />
                      <button
                        className="btn btn-ghost tiny ai-ask-btn"
                        disabled={!aiQuestion.trim()}
                        onClick={() => void askAi()}
                        title="Ctrl+Enter"
                      >
                        <Icon name="sparkle" size={12} /> 问
                      </button>
                    </div>
                  )}
                  {aiJobs.map((job) => (
                    <article key={job.jobId} className={`ai-item ai-job job-${job.status}`}>
                      <header className="ai-head">
                        <span className="ai-kind">
                          <Icon name="sparkle" size={12} /> {kindLabel(job.kind)}
                        </span>
                        <span className="ai-status">
                          {job.status === 'queued'
                            ? '排队中'
                            : job.status === 'running'
                              ? '正在跑'
                              : job.status === 'error'
                                ? '失败'
                                : job.status}
                        </span>
                        <span className="ai-when">{job.worker ? `worker: ${job.worker}` : ''}</span>
                      </header>
                      {job.request?.exact ? <blockquote className="ai-quote">{job.request.exact}</blockquote> : null}
                      {job.error?.message ? <p className="ai-error">{job.error.message}</p> : null}
                      <footer className="ai-foot">
                        {job.status === 'queued' && (
                          <button className="btn btn-ghost tiny" onClick={() => void cancelAiJob(job.jobId)}>
                            取消
                          </button>
                        )}
                        {job.status === 'error' && (
                          <button
                            className="btn btn-ghost tiny"
                            onClick={() =>
                              void enqueueAi(job.kind as AiKind, {
                                exact: job.request?.exact ?? '',
                                prefix: '',
                                suffix: '',
                                pos: job.request?.pos ?? 0,
                              })
                            }
                          >
                            重试
                          </button>
                        )}
                      </footer>
                    </article>
                  ))}
                  {aiList.length === 0 && aiJobs.length === 0 && doc.aiEnabled && (
                    <p className="panel-empty">
                      选中正文的一段文字，点工具条上的「解释 / 核实 / 背景 / 反问」，任务会排进队列，由 DSH 侧领走，结果写回这篇文档的{' '}
                      <code>reader.ai[]</code>。
                    </p>
                  )}
                  {aiList.map((entry) => (
                    <AiCard
                      key={entry.id}
                      entry={entry}
                      focused={focusAiId === entry.id}
                      onJump={() => jumpToAi(entry)}
                      onDelete={() => void deleteAi(entry)}
                      onRerun={() =>
                        void enqueueAi(entry.kind as AiKind, {
                          exact: entry.exact,
                          prefix: entry.prefix,
                          suffix: entry.suffix,
                          pos: entry.pos,
                        })
                      }
                    />
                  ))}
                </>
              )}

              {panelTab === 'backlinks' && (
                <>
                  {doc.backlinks.length === 0 && <p className="panel-empty">还没有别的文档链接到这里。用 [[{doc.title}]] 试试。</p>}
                  {doc.backlinks.map((back) => (
                    <button key={back.srcId + back.relPath} className="backlink-item" onClick={() => onOpenDoc(back.srcId)}>
                      <span className="backlink-title">
                        <Icon name="link" size={13} /> {back.srcTitle}
                      </span>
                      <span className="backlink-context">{back.context}</span>
                    </button>
                  ))}
                </>
              )}

              {panelTab === 'mentions' && (
                <>
                  {mentions.length === 0 && (
                    <p className="panel-empty">
                      没有未链接的提及。当别的文档在正文里提到「{doc.title}」但没有用 [[ ]] 链接时，会出现在这里。
                    </p>
                  )}
                  {mentions.map((mention) => (
                    <article key={mention.id} className="mention-item">
                      <button className="mention-head" onClick={() => onOpenDoc(mention.id)}>
                        <span className={`status-dot status-${mention.status}`} />
                        <span className="mention-title">{mention.title}</span>
                        <span className="mention-path">{mention.relPath}</span>
                      </button>
                      <p className="mention-snippet">{mention.snippet}</p>
                      <button className="btn btn-ghost tiny" onClick={() => void linkMention(mention)}>
                        <Icon name="link" size={12} />
                        加链接
                      </button>
                    </article>
                  ))}
                </>
              )}

              {panelTab === 'links' && (
                <>
                  {doc.links.length === 0 && <p className="panel-empty">这篇文档还没有 [[]] 链接。</p>}
                  {doc.links.map((link) => (
                    <button
                      key={link.dstRaw + (link.anchor ?? '')}
                      className={`outlink-item ${link.broken ? 'broken' : ''}`}
                      disabled={link.broken}
                      onClick={() => link.dstId && onOpenDoc(link.dstId)}
                    >
                      <span className="outlink-title">
                        <Icon name={link.broken ? 'alert' : 'link'} size={13} />
                        {link.dstTitle ?? link.dstRaw}
                        {link.anchor ? `#${link.anchor}` : ''}
                      </span>
                      {link.broken && <span className="outlink-broken">目标不存在</span>}
                    </button>
                  ))}
                </>
              )}
              </div>
            </div>
          </aside>
        )}

        {!immersive && !focusMode && !panelOpen && (
          <button
            className="panel-handle"
            onClick={() => setPanelOpen(true)}
            title="展开批注与反链（Ctrl+Shift+B）"
            aria-label="展开侧边栏"
          >
            <Icon name="panel-right" size={15} />
            <span className="panel-handle-label">批注</span>
            {annotationList.length > 0 && <span className="panel-handle-count">{annotationList.length}</span>}
            <Icon name="chevrons-left" size={13} />
          </button>
        )}
      </div>

      {selection && mode === 'read' && !MOBILE_READ_ONLY && (
        <SelectionToolbar
          info={selection}
          onColor={(color, withNote) => void createAnnotation(color, withNote)}
          onCopy={() => void copyQuote()}
          onAi={(kind) => void enqueueAi(kind)}
        />
      )}

      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}

      {conflict && (
        <ConflictDialog
          doc={doc}
          conflict={conflict}
          mine={bodyRef.current}
          onLoadDisk={() => {
            void reloadFromDisk();
            setConflict(null);
          }}
          onSaveCopy={() => {
            void (async () => {
              try {
                const created = await api.createDoc({
                  dir: doc.relPath.includes('/') ? doc.relPath.slice(0, doc.relPath.lastIndexOf('/')) : 'Inbox',
                  title: `${doc.title}（冲突副本）`,
                  content: bodyRef.current,
                });
                toast(`已另存为「${created.title}」`, 'success');
                await reloadFromDisk();
                setConflict(null);
              } catch (err) {
                toast(err instanceof Error ? err.message : '另存失败', 'error');
              }
            })();
          }}
          onMerge={async (merged, diskHash) => {
            const ok = await saveRef.current(merged, { baseHash: diskHash });
            if (ok) {
              setConflict(null);
              setMode('read');
              modeRef.current = 'read';
              toast('合并结果已保存', 'success');
            }
          }}
          onClose={() => setConflict(null)}
        />
      )}

      {moveMode && (
        <MoveDialog
          doc={doc}
          dirs={info?.dirs ?? []}
          mode={moveMode}
          onClose={() => setMoveMode(null)}
          onMoved={(next) => {
            setDoc(next);
            docRef.current = next;
            bodyRef.current = next.body;
            if (next.id !== docId) onOpenDoc(next.id);
            void refreshDocs();
          }}
        />
      )}

      {confirmDelete && (
        <Modal
          title="删除文档"
          subtitle={doc.relPath}
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  void (async () => {
                    try {
                      await api.deleteDoc(doc.id);
                      toast('已移入 .trash/', 'success');
                      onBack();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : '删除失败', 'error');
                    }
                  })();
                }}
              >
                移入 .trash
              </button>
            </>
          }
        >
          <p className="muted">文件会被移到书库的 .trash/ 目录，可以手动恢复，不会物理删除。</p>
        </Modal>
      )}

      <div className="read-status" title={`${statusLabelText} · ${formatPercent(progress)}`}>
        <span className={`status-dot status-${doc.status}`} />
        {formatPercent(progress)} · {formatWords(doc.words)}
      </div>
    </div>
  );
}

function AnnotationCard({
  annotation,
  focused,
  onJump,
  onSaveNote,
  onDelete,
}: {
  annotation: Annotation;
  focused: boolean;
  onJump: () => void;
  onSaveNote: (note: string) => void;
  onDelete: () => void;
}) {
  const [note, setNote] = useState(annotation.note);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setNote(annotation.note);
  }, [annotation.note, annotation.id]);

  useEffect(() => {
    if (focused) {
      const timer = window.setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(note.length, note.length);
      }, 60);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [focused, note.length]);

  return (
    <article
      className={`ann-item ${focused ? 'focused' : ''}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('textarea, button')) return;
        onJump();
      }}
    >
      <div className="ann-head">
        <span className={`ann-color dot-${annotation.color}`} />
        <blockquote className="ann-exact" onClick={onJump}>
          {annotation.exact}
        </blockquote>
        <button className="icon-btn tiny" onClick={onDelete} title="删除批注">
          <Icon name="trash" size={13} />
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="ann-note"
        value={note}
        placeholder="写点想法…"
        rows={note.split('\n').length > 1 ? Math.min(6, note.split('\n').length) : 2}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => onSaveNote(note)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.currentTarget.blur();
          }
        }}
      />
      <footer className="ann-foot">{annotation.created ? formatRelativeTime(Date.parse(annotation.created)) : ''}</footer>
    </article>
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countWordsApprox(body: string): number {
  const cjk = (body.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) ?? []).length;
  const latin = (body.replace(/[\u3400-\u4dbf\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_]+/g) ?? []).length;
  return cjk + latin;
}
