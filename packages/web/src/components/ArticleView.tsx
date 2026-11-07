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
import { AiPopover } from './AiPopover.tsx';

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

/** 最多同时钉住 3 个浮框。 */
const MAX_PINNED = 3;

interface AnnCardState {
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
  const { doc, theme, resolveWiki, onNavigateWiki, onAnnotationClick, onAiClick, onAiDelete, onToc, onAnchors, onImage } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ left: number; top: number; title: string; text: string } | null>(null);
  /** 正文里的 AI 锚点浮层：一次只开一个，不拖不钉 */
  const [aiPop, setAiPop] = useState<{ id: string; left: number; top: number } | null>(null);
  /** 浮框：同时最多 1 个悬浮卡（pinned=false）+ 3 个钉住的卡；坐标是视口坐标 */
  const [cards, setCards] = useState<AnnCardState[]>([]);
  /** 每张卡记住自己的尺寸（批注 id → 尺寸） */
  const sizesRef = useRef<Record<string, { w: number; h: number }>>(readCardSizes());
  const hoverTimer = useRef<number | null>(null);
  const annTimer = useRef<number | null>(null);
  const aiTimer = useRef<number | null>(null);
  const aiCloseTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const propsRef = useRef({
    doc,
    theme,
    resolveWiki,
    onNavigateWiki,
    onAnnotationClick,
    onAiClick,
    onAiDelete,
    onToc,
    onAnchors,
    onImage,
  });
  propsRef.current = { doc, theme, resolveWiki, onNavigateWiki, onAnnotationClick, onAiClick, onAiDelete, onToc, onAnchors, onImage };

  /** 打开悬浮卡：贴在高亮旁边，下方放不下就翻到上方。 */
  const openHover = useCallback((id: string, rect: DOMRect) => {
    const size = sizesRef.current[id] ?? ANN_CARD_DEFAULT;
    const height = Math.min(size.h, window.innerHeight - 60);
    const x = Math.max(12, Math.min(rect.left, window.innerWidth - size.w - 12));
    const below = rect.bottom + 10;
    const y = below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 10) : below;
    // 悬浮卡永远只有一个；钉住的原地保留
    setCards((prev) => [
      ...prev.filter((card) => card.pinned || card.id === id),
      { id, x, y, pinned: false, w: size.w, h: size.h },
    ]);
  }, []);

  /** 延后关闭：给鼠标从高亮移到浮框留出时间，移进浮框时会被取消。 */
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

  /** 钉住：位置就地保留（不搬家），最多 3 个，超了丢最早钉的那个。 */
  const pinCard = useCallback((id: string) => {
    setCards((prev) => {
      const next = prev.map((card) => (card.id === id ? { ...card, pinned: true } : card));
      const pinned = next.filter((card) => card.pinned);
      if (pinned.length <= MAX_PINNED) return next;
      const drop = new Set(pinned.slice(0, pinned.length - MAX_PINNED).map((card) => card.id));
      return next.filter((card) => !drop.has(card.id));
    });
    cancelClose();
  }, [cancelClose]);

  const closeCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((card) => card.id !== id));
  }, []);

  /** 打开 AI 锚点浮层；位置贴着 ✦，下方放不下就翻到上方。 */
  const openAiPop = useCallback((id: string, rect: DOMRect) => {
    const width = 430;
    const height = 300;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const below = rect.bottom + 8;
    const top = below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 8) : below;
    setAiPop({ id, left, top });
  }, []);

  const cancelAiClose = useCallback(() => {
    if (aiCloseTimer.current !== null) {
      window.clearTimeout(aiCloseTimer.current);
      aiCloseTimer.current = null;
    }
  }, []);

  const scheduleAiClose = useCallback(() => {
    if (aiCloseTimer.current !== null) window.clearTimeout(aiCloseTimer.current);
    aiCloseTimer.current = window.setTimeout(() => setAiPop(null), 200);
  }, []);  const moveCard = useCallback((id: string, x: number, y: number) => {
    setCards((prev) => prev.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  /** 每张卡自己的尺寸，拖动后记住（按批注 id 存）。 */
  const resizeCard = useCallback((id: string, size: { w: number; h: number }) => {
    sizesRef.current[id] = size;
    persistCardSize(id, size);
    setCards((prev) => prev.map((card) => (card.id === id ? { ...card, w: size.w, h: size.h } : card)));
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

  // AI 浮层不钉，滚动正文或按 Esc 就收；浮层内部滚动不算
  useEffect(() => {
    if (!aiPop) return;
    const onScroll = (event: Event) => {
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('.ai-pop')) return;
      setAiPop(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAiPop(null);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [aiPop]);

  // 切文档 / 删批注后丢掉失效的卡
  useEffect(() => {
    setCards((prev) => {
      const next = prev.filter((card) => doc.annotations.some((item) => item.id === card.id));
      return next.length === prev.length ? prev : next;
    });
  }, [doc.annotations]);

  // AI 产出被删掉后，浮层也要跟着消失
  useEffect(() => {
    setAiPop((prev) => (prev && (doc.ai ?? []).some((item) => item.id === prev.id) ? prev : null));
  }, [doc.ai]);

  return (
    <>
      <div
        className="article"
        ref={containerRef}
        onMouseOver={(event) => {
          const chip = (event.target as HTMLElement).closest<HTMLElement>('.ai-chip');
          if (chip?.dataset.aiId) {
            cancelAiClose();
            if (aiTimer.current !== null) window.clearTimeout(aiTimer.current);
            const id = chip.dataset.aiId;
            const rect = chip.getBoundingClientRect();
            aiTimer.current = window.setTimeout(() => openAiPop(id, rect), 100);
            return;
          }
          const mark = (event.target as HTMLElement).closest<HTMLElement>('mark.ann');
          if (mark?.dataset.annId) {
            cancelClose();
            if (annTimer.current !== null) window.clearTimeout(annTimer.current);
            const id = mark.dataset.annId;
            const rect = mark.getBoundingClientRect();
            annTimer.current = window.setTimeout(() => openHover(id, rect), 120);
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
            if (aiTimer.current !== null) {
              window.clearTimeout(aiTimer.current);
              aiTimer.current = null;
            }
            scheduleAiClose();
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
          setAiPop(null);
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
        const annotation = doc.annotations.find((item) => item.id === card.id);
        if (!annotation) return null;
        return (
          <AnnCard
            key={card.id}
            annotation={annotation}
            pinned={card.pinned}
            style={{
              left: card.x,
              top: card.y,
              width: card.w,
              ...(card.pinned ? { height: card.h } : { maxHeight: card.h }),
            }}
            onEnter={cancelClose}
            onLeave={scheduleClose}
            onPin={() => (card.pinned ? closeCard(card.id) : pinCard(card.id))}
            onClose={() => closeCard(card.id)}
            // 拖动即钉住：否则鼠标一离开卡片就没了
            onDragStart={() => pinCard(card.id)}
            onMove={(x, y) => moveCard(card.id, x, y)}
            onResize={(size) => resizeCard(card.id, size)}
          />
        );
      })}
      {aiPop && (() => {
        const entry = (doc.ai ?? []).find((item) => item.id === aiPop.id);
        if (!entry) return null;
        return (
          <AiPopover
            entry={entry}
            left={aiPop.left}
            top={aiPop.top}
            onEnter={cancelAiClose}
            onLeave={scheduleAiClose}
            onOpenPanel={() => {
              setAiPop(null);
              propsRef.current.onAiClick(entry.id);
            }}
            onDelete={() => {
              setAiPop(null);
              propsRef.current.onAiDelete(entry);
            }}
          />
        );
      })()}
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
