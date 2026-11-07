import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DocPayload } from '../types.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { applyMarks, collectText, flashAnnotation, markSpecsFromAnchors } from '../lib/annotate.ts';
import { reanchorAll } from '../lib/reanchor.ts';
import type { ResolvedAnchor } from '../lib/reanchor.ts';
import { highlightCodeBlocks } from '../lib/highlight.ts';
import { api } from '../api.ts';
import type { TocItem } from './Toc.tsx';
import { AnnCard, ANN_CARD_DEFAULT, ANN_CARD_MAX, ANN_CARD_MIN } from './AnnCard.tsx';

export interface ArticleHandle {
  flash: (annotationId: string) => void;
  scrollToHeading: (slug: string) => void;
  getText: () => string;
}

interface ArticleViewProps {
  doc: DocPayload;
  theme: 'light' | 'dark';
  resolveWiki: (target: string, anchor?: string) => { href: string } | null;
  onNavigateWiki: (href: string, anchor: string | null) => void;
  onAnnotationClick: (id: string) => void;
  onToc: (items: TocItem[]) => void;
  onAnchors: (payload: { resolved: ResolvedAnchor[]; orphaned: string[] }) => void;
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

const CARD_SIZE_KEY = 'mr.annCard.size';

/** 读浮框尺寸；坏值回退默认。 */
function readCardSize(): { w: number; h: number } {
  try {
    const raw = localStorage.getItem(CARD_SIZE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { w?: number; h?: number };
      const w = Number(parsed.w);
      const h = Number(parsed.h);
      if (Number.isFinite(w) && Number.isFinite(h)) {
        return {
          w: Math.min(ANN_CARD_MAX.w, Math.max(ANN_CARD_MIN.w, w)),
          h: Math.min(ANN_CARD_MAX.h, Math.max(ANN_CARD_MIN.h, h)),
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { ...ANN_CARD_DEFAULT };
}

function persistCardSize(size: { w: number; h: number }): void {
  try {
    localStorage.setItem(CARD_SIZE_KEY, JSON.stringify(size));
  } catch {
    /* ignore */
  }
}

export const ArticleView = forwardRef<ArticleHandle, ArticleViewProps>(function ArticleView(props, ref) {
  const { doc, theme, resolveWiki, onNavigateWiki, onAnnotationClick, onToc, onAnchors, onImage } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ left: number; top: number; title: string; text: string } | null>(null);
  /** 悬浮中的批注（松手就消失） */
  const [hoverAnn, setHoverAnn] = useState<{ id: string; left: number; top: number } | null>(null);
  /** 钉住的批注 id，最多 3 个，按钉住的先后排 */
  const [pinnedAnn, setPinnedAnn] = useState<string[]>([]);
  /** 浮框尺寸，全局共用一份，写进 localStorage */
  const [cardSize, setCardSize] = useState<{ w: number; h: number }>(() => readCardSize());
  const hoverTimer = useRef<number | null>(null);
  const annTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const propsRef = useRef({
    doc,
    theme,
    resolveWiki,
    onNavigateWiki,
    onAnnotationClick,
    onToc,
    onAnchors,
    onImage,
  });
  propsRef.current = { doc, theme, resolveWiki, onNavigateWiki, onAnnotationClick, onToc, onAnchors, onImage };

  /** 打开悬浮卡：贴在高亮旁边，下方放不下就翻到上方。 */
  const openHover = useCallback(
    (id: string, rect: DOMRect) => {
      const height = Math.min(cardSize.h, window.innerHeight - 60);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - cardSize.w - 12));
      const below = rect.bottom + 10;
      const top = below + height > window.innerHeight - 12 ? Math.max(12, rect.top - height - 10) : below;
      setHoverAnn({ id, left, top });
    },
    [cardSize.w, cardSize.h],
  );

  /** 延后关闭：给鼠标从高亮移到浮框留出时间，移进浮框时会被取消。 */
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setHoverAnn(null), 220);
  }, []);

  /** 钉住：最多 3 个，超了丢最早的那个。 */
  const pinAnn = useCallback((id: string) => {
    setPinnedAnn((prev) => (prev.includes(id) ? prev : [...prev, id].slice(-3)));
    setHoverAnn(null);
  }, []);

  const unpinAnn = useCallback((id: string) => {
    setPinnedAnn((prev) => prev.filter((item) => item !== id));
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
    propsRef.current.onAnchors({ resolved, orphaned: orphaned.map((o) => o.id) });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      flash(id: string) {
        if (containerRef.current) flashAnnotation(containerRef.current, id);
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

  // 批注变化：重新定位并高亮
  useEffect(() => {
    applyAnchors();
  }, [doc.annotations, applyAnchors]);

  // 滚动时收起悬浮卡（钉住的保持不动）；浮框内部滚动不算
  useEffect(() => {
    if (!hoverAnn) return;
    const hide = (event: Event) => {
      const target = event.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('.ann-card')) return;
      setHoverAnn(null);
    };
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [hoverAnn]);

  // Esc 关掉悬浮卡
  useEffect(() => {
    if (!hoverAnn) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHoverAnn(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hoverAnn]);

  // 切文档 / 删批注后丢掉失效的钉住项
  useEffect(() => {
    setPinnedAnn((prev) => {
      const next = prev.filter((id) => doc.annotations.some((item) => item.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [doc.annotations]);

  return (
    <>
      <div
        className="article"
        ref={containerRef}
        onMouseOver={(event) => {
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
      {hoverAnn &&
        (() => {
          const annotation = doc.annotations.find((item) => item.id === hoverAnn.id);
          if (!annotation) return null;
          return (
            <AnnCard
              annotation={annotation}
              style={{ left: hoverAnn.left, top: hoverAnn.top, width: cardSize.w, maxHeight: cardSize.h }}
              onEnter={cancelClose}
              onLeave={scheduleClose}
              onPin={() => pinAnn(annotation.id)}
              onClose={() => setHoverAnn(null)}
              onResize={(size) => {
                setCardSize(size);
                persistCardSize(size);
              }}
            />
          );
        })()}

      {pinnedAnn.length > 0 && (
        <div className="ann-dock">
          {pinnedAnn.map((id) => {
            const annotation = doc.annotations.find((item) => item.id === id);
            if (!annotation) return null;
            return (
              <AnnCard
                key={id}
                annotation={annotation}
                pinned
                style={{ width: cardSize.w, height: cardSize.h }}
                onPin={() => unpinAnn(id)}
                onClose={() => unpinAnn(id)}
                onResize={(size) => {
                  setCardSize(size);
                  persistCardSize(size);
                }}
              />
            );
          })}
        </div>
      )}
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
