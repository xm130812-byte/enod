import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { DocPayload } from '../types.ts';
import { renderMarkdown } from '../lib/markdown.ts';
import { applyMarks, collectText, flashAnnotation, markSpecsFromAnchors } from '../lib/annotate.ts';
import { reanchorAll } from '../lib/reanchor.ts';
import type { ResolvedAnchor } from '../lib/reanchor.ts';
import { highlightCodeBlocks } from '../lib/highlight.ts';
import { api } from '../api.ts';
import type { TocItem } from './Toc.tsx';

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

function readToc(root: HTMLElement): TocItem[] {
  return [...root.querySelectorAll<HTMLElement>('h1, h2, h3')].map((el) => ({
    id: el.id || el.textContent?.trim() || String(Math.random()),
    text: (el.textContent ?? '').trim(),
    level: Number(el.tagName.slice(1)),
  }));
}

export const ArticleView = forwardRef<ArticleHandle, ArticleViewProps>(function ArticleView(props, ref) {
  const { doc, theme, resolveWiki, onNavigateWiki, onAnnotationClick, onToc, onAnchors, onImage } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ left: number; top: number; title: string; text: string } | null>(null);
  const hoverTimer = useRef<number | null>(null);
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
    el.innerHTML = renderMarkdown(doc.body, {
      resolveWiki: (target) => propsRef.current.resolveWiki(target),
    });
    sanitize(el);
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

  return (
    <>
      <div
        className="article"
        ref={containerRef}
        onMouseOver={(event) => {
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
