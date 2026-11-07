import { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown.ts';
import { sanitizeAiHtml } from '../lib/sanitize.ts';

interface AiMarkdownProps {
  text: string;
  className?: string;
  /** 让 [[双链]] 能解析出真实 href */
  resolveWiki?: (target: string, anchor?: string) => { href: string } | null;
  /** 点 [[双链]] 时跳转；不传则双链只是普通文字 */
  onNavigateWiki?: (href: string, anchor: string | null) => void;
}

/**
 * AI 产出的 Markdown 渲染。
 *
 * 模型给的是 `**结论**`、`- 证据` 这种结构，按源码展示等于让它白写；
 * 但也不能直接塞进正文那套渲染器（会带图片、Shiki、目录锚点）。
 * 折中：同一个 markdown-it 管线渲染，再过一层 AI 专用的净化 + 卡片排版。
 */
export function AiMarkdown({ text, className, resolveWiki, onNavigateWiki }: AiMarkdownProps) {
  const html = useMemo(
    () => sanitizeAiHtml(renderMarkdown(text ?? '', resolveWiki ? { resolveWiki } : {})),
    [text, resolveWiki],
  );

  return (
    <div
      className={`ai-md ${className ?? ''}`}
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a.wiki-link');
        if (!link || !onNavigateWiki) return;
        const href = link.dataset.wikiTarget ? link.getAttribute('href') : null;
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        onNavigateWiki(href, link.dataset.wikiAnchor ?? null);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
