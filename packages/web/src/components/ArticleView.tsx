import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AiEntry, DocPayload } from '../types.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import {
  applyAiChips,
  applyMarks,
  collectText,
  flashAi,
  flashAnnotation,
  markSpecsFromAnchors,
} from '../lib/annotate.ts';
import { reanchorAll } from '../lib/reanchor.ts';
import type { ResolvedAnchor } from '../lib/reanchor.ts';
import { highlightCodeBlocks } from '../lib/highlight.ts';
import { api } from '../api.ts';
import type { TocItem } from './Toc.tsx';
import { AnnCard, ANN_CARD_DEFAULT, ANN_CARD_MAX, ANN_CARD_MIN } from './AnnCard.tsx';
import { AiFloatCard } from './AiFloatCard.tsx';

export interface ArticleHandle {
  flash: (annotationId: string) => void;
  flashAi: (aiId: string) => void;
  scrollToHeading: (slug: string) => void;
  getText: () => string;
}

interface ArticleViewProps {
  doc: DocPayload;
  theme: 'light' | 'dark';
  resolveWiki: (target: string, anchor?: string) => { href: string } | null;
  onNavigateWiki: (href: string, anchor: string | null) => void;
  onAnnotationClick: (id: string) => void;
  onAiClick: (id: string) => void;
  onAiDelete: (entry: AiEntry) => void;
  onAiRerun: (entry: AiEntry) => void;
  onToc: (items: TocItem[]) => void;
  onAnchors: (payload: { resolved: ResolvedAnchor[]; orphaned: string[]; aiOrphaned: string[] }) => void;
  onImage: (src: string, alt: string) => void;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** txt / sql 是原始文本，不能按 markdown 渲染（会被吃掉换行和符号）。 */
function renderPlainText(body: string, kind: 'txt' | 'sql'): string {
  if (kind === 'sql') {
    return `<pre class="code-block sql-view"><code class="language-sql">${escapeHtml(body)}</code></pre>`;
  }
  return `<pre class="txt-view">${escapeHtml(body)}</pre>`;
}

function sanitize(root: HTMLElement): void {
  root.querySelectorAll('script,iframe,object,embed,link,meta,form').forEach((node) => node.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

function resolveImages(root: HTMLElement): void {
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!src || /^(https?:|data:|blob:|\/)/i.test(src)) continue;
    img.src = api.fileUrl(src.replace(/^\.\//, ''));
  }
}

/**
 * markdown-it 对「**加粗：**中文」这种"闭合标记前是中文标点、后面紧跟汉字"的写法
 * 会保留成字面量（CommonMark 的 flanking 判定）。合法强调在渲染时已经被消费掉，
 * 所以这里把文本节点里剩余的 **x** 兜底转成 <strong>，不会碰到代码块。
 */
function unstickEmphasis(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.data.includes('**')) continue;
    const tag = (node.parentElement?.tagName ?? '').toLowerCase();
    if (tag === 'code' || tag === 'pre') continue;
    nodes.push(node);
  }
  for (const node of nodes) {
    const parts = node.data.split(/(\*\*[^*\n]+\*\*)/g);
    if (parts.length < 3) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      const match = /^\*\*([^*\n]+)\*\*$/.exec(part);
      if (match) {
        const strong = document.createElement('strong');
        strong.textContent = match[1]!;
        frag.append(strong);
      } else if (part) {
        frag.append(document.createTextNode(part));
      }
    }
    node.replaceWith(frag);
  }
}

function readToc(root: HTMLElement): TocItem[] {
  return [...root.querySelectorAll<HTMLElement>('h1, h2, h3')].map((el) => ({
    id: el.id || el.textContent?.trim() || String(Math.random()),
    text: (el.textContent ?? '').trim(),
    level: Number(el.tagName.slice(1)),
  }));
}

const CARD_SIZE_KEY = 'mr.annCard.sizes';

/** 最多同时钉住 3 个浮框（批注和 AI 共用一个额度）。 */
const MAX_PINNED = 3;

/** 一块浮框：批注（ann）和 AI 产出（ai）走同一套状态机。 */
interface FloatCardState {
  /** `${kind}:${id}`，批注和 AI 的 id 空间可能重叠，必须区分 */
  key: string;
  kind: 'ann' | 'ai';
  id: string;
  x: number;
  y: number;
  pinned: boolean;
  w: number;
  h: number;
}

/** 每个批注分别记住自己的浮框尺寸。 */
function readCardSizes(): Record<string, { w: number; h: number }> {
  try {
    const raw = localStorage.getItem(CARD_SIZE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { w?: number; h?: number }>;
    const out: Record<string, { w: number; h: number }> = {};
    for (const [id, size] of Object.entries(parsed ?? {})) {
      const w = Number(size?.w);
      const h = Number(size?.h);
      if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
      out[id] = {
        w: Math.min(ANN_CARD_MAX.w, Math.max(ANN_CARD_MIN.w, w)),
        h: Math.min(ANN_CARD_MAX.h, Math.max(ANN_CARD_MIN.h, h)),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persistCardSize(id: string, size: { w: number; h: number }): void {
  try {
    const all = readCardSizes();
    all[id] = size;
    localStorage.setItem(CARD_SIZE_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export const ArticleView = forwardRef<ArticleHandle, ArticleViewProps>(function ArticleView(props, ref) {
  const { doc, theme, resolveWiki, onNavigateWiki, onAnnotationClick, onAiClick, onAiDelete, onAiRerun, onToc, onAnchors, onImage } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ left: number; top: number; title: string; text: string } | null>(null);
  /** 浮框：批注和 AI 共用一套（同一套拖/钉/改大小）；坐标是视口坐标 */
  const [cards, setCards] = useState<FloatCardState[]>([]);
  /** 每张卡记住自己的尺寸（`ann:id` / `ai:id` → 尺寸） */
  const sizesRef = useRef<Record<string, { w: number; h: number }>>(readCardSizes());
  const hoverTimer = useRef<number | null>(null);
  const annTimer = useRef<number | null>(null);
  const aiTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const propsRef = useRef({
    doc,
    theme,
    resolveWiki,
    onNavigateWiki,
    onAnnotationClick,
    onAiClick,
    onAiDelete,
    onAiRerun,
    onToc,
    onAnchors,
    onImage,
  });
  propsRef.current = { doc, theme, resolveWiki, onNavigateWiki, onAnnotationClick, onAiClick, onAiDelete, onAiRerun, onToc, onAnchors, onImage };

  /** 打开悬浮卡：贴在高亮/✦ 旁边，下方放不下就翻到上方。批注与 AI 共用。 */
  const openHover = useCallback((kind: 'ann' | 'ai', id: string, rect: DOMRect) => {
    const key = `${kind}:${id}`;
    const size = sizesRef.current[key] ?? ANN_CARD_DEFAULT;
    const height = Math.min(size.h, window.innerHeight - 60);
    const x = Math.max(12, Math.min(rect.left, window.innerWidth - size.w - 12));
    const below = rect.bottom + 10;
    const y = below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 10) : below;
    // 悬浮卡永远只有一个；钉住的原地保留
    setCards((prev) => [
      ...prev.filter((card) => card.pinned || card.key === key),
      { key, kind, id, x, y, pinned: false, w: size.w, h: size.h },
    ]);
  }, []);

  /** 延后关闭：给鼠标从高亮/✦ 移到浮框留出时间，移进浮框时会被取消。 */
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  /** 只收掉没钉住的卡；钉住的留在原地。 */
  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setCards((prev) => prev.filter((card) => card.pinned));
    }, 220);
  }, []);

  /** 钉住：位置就地保留（不搬家），最多 3 个（批注 + AI 合计），超了丢最早钉的那个。 */
  const pinCard = useCallback((key: string) => {
    setCards((prev) => {
      const next = prev.map((card) => (card.key === key ? { ...card, pinned: true } : card));
      const pinned = next.filter((card) => card.pinned);
      if (pinned.length <= MAX_PINNED) return next;
      const drop = new Set(pinned.slice(0, pinned.length - MAX_PINNED).map((card) => card.key));
      return next.filter((card) => !drop.has(card.key));
    });
    cancelClose();
  }, [cancelClose]);

  /** 钉住按钮：没钉就钉，已钉就关掉（和批注原来的手感一致）。 */
  const togglePin = useCallback(
    (card: FloatCardState) => {
      if (card.pinned) {
        setCards((prev) => prev.filter((item) => item.key !== card.key));
      } else {
        pinCard(card.key);
      }
    },
    [pinCard],
  );

  const closeCard = useCallback((key: string) => {
    setCards((prev) => prev.filter((card) => card.key !== key));
  }, []);

  const moveCard = useCallback((key: string, x: number, y: number) => {
    setCards((prev) => prev.map((card) => (card.key === key ? { ...card, x, y } : card)));
  }, []);

  /** 每张卡自己的尺寸，拖动后记住（按 `kind:id` 存）。 */
  const resizeCard = useCallback((key: string, size: { w: number; h: number }) => {
    sizesRef.current[key] = size;
    persistCardSize(key, size);
    setCards((prev) => prev.map((card) => (card.key === key ? { ...card, w: size.w, h: size.h } : card)));
  }, []);

  const applyAnchors = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const current = propsRef.current.doc;
    const { text } = collectText(el);
    const anchors = current.annotations.map((a) => ({
      id: a.id,
      exact: a.exact,
      prefix: a.prefix,
      suffix: a.suffix,
      pos: a.pos,
    }));
    const { resolved, orphaned } = reanchorAll(text, anchors);
    const colors = new Map(current.annotations.map((a) => [a.id, a.color]));
    applyMarks(el, markSpecsFromAnchors(resolved, colors));

    // AI 产出：只给有原文锚点的条目放小 ✦（概括整篇那种没有锚点）
    const aiAnchors = (current.ai ?? [])
      .filter((entry) => entry.exact.trim().length > 0)
      .map((entry) => ({
        id: entry.id,
        exact: entry.exact,
        prefix: entry.prefix,
        suffix: entry.suffix,
        pos: entry.pos,
      }));
    const aiResolved = reanchorAll(text, aiAnchors);
    applyAiChips(el, aiResolved.resolved);

    propsRef.current.onAnchors({
      resolved,
      orphaned: orphaned.map((o) => o.id),
      aiOrphaned: aiResolved.orphaned.map((o) => o.id),
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      flash(id: string) {
        if (containerRef.current) flashAnnotation(containerRef.current, id);
      },
      flashAi(id: string) {
        if (containerRef.current) flashAi(containerRef.current, id);
      },
      scrollToHeading(slug: string) {
        const el = containerRef.current;
        if (!el) return;
        const target =
          el.querySelector<HTMLElement>(`[id="${CSS.escape(slug)}"]`) ??
          [...el.querySelectorAll<HTMLElement>('h1,h2,h3')].find((h) => (h.textContent ?? '').trim() === slug);
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
      getText() {
        return containerRef.current ? collectText(containerRef.current).text : '';
      },
    }),
    [],
  );

  // 文档内容变化：重建文章 DOM
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    if (doc.kind === 'txt' || doc.kind === 'sql') {
      el.innerHTML = renderPlainText(doc.body, doc.kind);
      propsRef.current.onToc([]);
      void highlightCodeBlocks(el, propsRef.current.theme).then(() => {
        if (!cancelled) applyAnchors();
      });
      return () => {
        cancelled = true;
      };
    }
    el.innerHTML = renderMarkdown(doc.body, {
      resolveWiki: (target) => propsRef.current.resolveWiki(target),
    });
    sanitize(el);
    unstickEmphasis(el);
    // 顶栏已经显示标题；正文首个 H1 与标题相同时不重复渲染
    const first = el.firstElementChild as HTMLElement | null;
    if (first?.tagName === 'H1' && (first.textContent ?? '').trim() === doc.title.trim()) first.remove();
    resolveImages(el);
    propsRef.current.onToc(readToc(el));
    void highlightCodeBlocks(el, propsRef.current.theme).then(() => {
      if (cancelled) return;
      resolveImages(el);
      propsRef.current.onToc(readToc(el));
      applyAnchors();
    });
    return () => {
      cancelled = true;
    };
  }, [doc.id, doc.body, applyAnchors]);

  // 主题变化：只重新高亮代码，不重建 DOM（保持滚动位置）
  const firstTheme = useRef(true);
  useEffect(() => {
    if (firstTheme.current) {
      firstTheme.current = false;
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    void highlightCodeBlocks(el, theme).then(() => applyAnchors());
  }, [theme, applyAnchors]);

  // 批注 / AI 产出变化：重新定位并高亮
  useEffect(() => {
    applyAnchors();
  }, [doc.annotations, doc.ai, applyAnchors]);

  // 滚动时收起悬浮卡（钉住的留在原地）；浮框内部滚动不算
  useEffect(() => {
    if (!cards.some((card) => !card.pinned)) return;
    const hide = (event: Event) => {
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('.ann-card')) return;
      setCards((prev) => prev.filter((card) => card.pinned));
    };
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [cards]);

  // Esc 关掉没钉住的卡
  useEffect(() => {
    if (!cards.some((card) => !card.pinned)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setCards((prev) => prev.filter((card) => card.pinned));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cards]);

  // 切文档 / 删批注 / 删 AI 产出后丢掉失效的卡（批注与 AI 共用一套）
  useEffect(() => {
    setCards((prev) => {
      const next = prev.filter((card) =>
        card.kind === 'ann'
          ? doc.annotations.some((item) => item.id === card.id)
          : (doc.ai ?? []).some((item) => item.id === card.id),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [doc.annotations, doc.ai]);

  return (
    <>
      <div
        className="article"
        ref={containerRef}
        onMouseOver={(event) => {
          const chip = (event.target as HTMLElement).closest<HTMLElement>('.ai-chip');
          if (chip?.dataset.aiId) {
            cancelClose();
            if (aiTimer.current !== null) window.clearTimeout(aiTimer.current);
            const id = chip.dataset.aiId;
            const rect = chip.getBoundingClientRect();
            aiTimer.current = window.setTimeout(() => openHover('ai', id, rect), 120);
            return;
          }
          const mark = (event.target as HTMLElement).closest<HTMLElement>('mark.ann');
          if (mark?.dataset.annId) {
            cancelClose();
            if (annTimer.current !== null) window.clearTimeout(annTimer.current);
            const id = mark.dataset.annId;
            const rect = mark.getBoundingClientRect();
            annTimer.current = window.setTimeout(() => openHover('ann', id, rect), 120);
            return;
          }
          const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a.wiki-link');
          if (!link || link.classList.contains('wiki-broken')) return;
          const target = link.dataset.wikiTarget;
          if (!target) return;
          if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
          const rect = link.getBoundingClientRect();
          hoverTimer.current = window.setTimeout(() => {
            void api
              .preview(target)
              .then((res) => {
                if ('notFound' in res) return;
                const maxWidth = 320;
                const left = Math.max(12, Math.min(rect.left, window.innerWidth - maxWidth - 12));
                const above = rect.bottom + 190 > window.innerHeight;
                setPreview({
                  left,
                  top: above ? rect.top - 8 : rect.bottom + 8,
                  title: res.title,
                  text: res.excerpt,
                });
              })
              .catch(() => {});
          }, 260);
        }}
        onMouseOut={(event) => {
          const chip = (event.target as HTMLElement).closest<HTMLElement>('.ai-chip');
          if (chip) {
            const to = event.relatedTarget as HTMLElement | null;
            if (!to || !chip.contains(to)) {
              if (aiTimer.current !== null) {
                window.clearTimeout(aiTimer.current);
                aiTimer.current = null;
              }
              scheduleClose();
            }
          }
          const mark = (event.target as HTMLElement).closest<HTMLElement>('mark.ann');
          if (mark) {
            const to = event.relatedTarget as HTMLElement | null;
            if (!to || !mark.contains(to)) {
              if (annTimer.current !== null) {
                window.clearTimeout(annTimer.current);
                annTimer.current = null;
              }
              // 留出移动时间：鼠标移到浮框上时会被 onMouseEnter 取消
              scheduleClose();
            }
          }
          const link = (event.target as HTMLElement).closest('a.wiki-link');
          if (!link) return;
          if (hoverTimer.current !== null) {
            window.clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
          }
          setPreview(null);
        }}
        onClick={(event) => {
        const target = event.target as HTMLElement;
        const chip = target.closest<HTMLElement>('.ai-chip');
        if (chip?.dataset.aiId) {
          event.stopPropagation();
          propsRef.current.onAiClick(chip.dataset.aiId);
          return;
        }
        const wiki = target.closest<HTMLAnchorElement>('a.wiki-link');
        if (wiki) {
          event.preventDefault();
          const href = wiki.getAttribute('href');
          if (!href) return;
          propsRef.current.onNavigateWiki(href, wiki.dataset.wikiAnchor ?? null);
          return;
        }
        const internal = target.closest<HTMLAnchorElement>('a[href^="#"]');
        if (internal) {
          const href = internal.getAttribute('href')!;
          if (href.startsWith('#/')) return; // 交给 hash 路由
          event.preventDefault();
          const id = decodeURIComponent(href.slice(1));
          const el = containerRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
          el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          return;
        }
        const mark = target.closest<HTMLElement>('mark.ann');
        if (mark?.dataset.annId) {
          propsRef.current.onAnnotationClick(mark.dataset.annId);
          return;
        }
        const img = target.closest<HTMLImageElement>('img.md-image, .article img');
        if (img) {
          propsRef.current.onImage(img.src, img.alt);
        }
        }}
      />
      {cards.map((card) => {
        const style = {
          left: card.x,
          top: card.y,
          width: card.w,
          ...(card.pinned ? { height: card.h } : { maxHeight: card.h }),
        };
        if (card.kind === 'ann') {
          const annotation = doc.annotations.find((item) => item.id === card.id);
          if (!annotation) return null;
          return (
            <AnnCard
              key={card.key}
              annotation={annotation}
              pinned={card.pinned}
              style={style}
              onEnter={cancelClose}
              onLeave={scheduleClose}
              onPin={() => togglePin(card)}
              onClose={() => closeCard(card.key)}
              // 拖动即钉住：否则鼠标一离开卡片就没了
              onDragStart={() => pinCard(card.key)}
              onMove={(x, y) => moveCard(card.key, x, y)}
              onResize={(size) => resizeCard(card.key, size)}
            />
          );
        }
        const entry = (doc.ai ?? []).find((item) => item.id === card.id);
        if (!entry) return null;
        return (
          <AiFloatCard
            key={card.key}
            entry={entry}
            pinned={card.pinned}
            style={style}
            onEnter={cancelClose}
            onLeave={scheduleClose}
            onPin={() => togglePin(card)}
            onClose={() => closeCard(card.key)}
            onDragStart={() => pinCard(card.key)}
            onMove={(x, y) => moveCard(card.key, x, y)}
            onResize={(size) => resizeCard(card.key, size)}
            onJump={() => {
              if (containerRef.current) flashAi(containerRef.current, entry.id);
            }}
            onRerun={() => propsRef.current.onAiRerun(entry)}
            onDelete={() => propsRef.current.onAiDelete(entry)}
            onOpenPanel={() => propsRef.current.onAiClick(entry.id)}
          />
        );
      })}
      {preview && (
        <div
          className="wiki-preview"
          style={{ left: preview.left, top: preview.top }}
          onMouseLeave={() => setPreview(null)}
        >
          <strong>{preview.title}</strong>
          <p>{preview.text || '（空文档）'}</p>
        </div>
      )}
    </>
  );
});
