/**
 * AI 输出的 HTML 净化。
 *
 * 和正文那条路径（ArticleView 里的 sanitize）**策略不同**，刻意不合并：
 * - 正文里的图片是书库自己的 assets，要保留；
 * - AI 输出是模型写的，里面出现 <img> 大概率是远端追踪像素，一律删掉；
 * - 卡片空间小，行内 style 也清掉，样式只由 .ai-md 决定；
 * - 所有外链改成新标签打开，免得把读者从阅读页带走。
 */

const DROP_SELECTOR = 'script,iframe,object,embed,link,meta,form,img,picture,source,video,audio,base';
const UNSAFE_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

export function sanitizeAiHtml(html: string): string {
  const box = document.createElement('div');
  box.innerHTML = html;
  box.querySelectorAll(DROP_SELECTOR).forEach((node) => node.remove());

  for (const el of box.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcset') {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href') && UNSAFE_URL.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  for (const anchor of box.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noreferrer');
  }
  return box.innerHTML;
}
