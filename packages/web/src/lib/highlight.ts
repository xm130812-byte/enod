import type { Highlighter } from 'shiki';

const LANGS = [
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'json',
  'bash',
  'shell',
  'powershell',
  'python',
  'rust',
  'html',
  'css',
  'sql',
  'markdown',
  'yaml',
  'diff',
  'go',
  'java',
  'c',
  'csharp',
];

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // 动态 import，让 Shiki 单独成一个 chunk
    highlighterPromise = import('shiki').then((mod) =>
      mod.createHighlighter({
        themes: ['github-light', 'github-dark'],
        langs: LANGS,
      }),
    );
  }
  return highlighterPromise;
}

function addCopyButton(pre: HTMLElement): void {
  if (pre.querySelector('.code-copy')) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-copy';
  button.textContent = '复制';
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const code = pre.querySelector('code');
    const content = code?.textContent ?? '';
    void navigator.clipboard.writeText(content).then(() => {
      button.textContent = '已复制';
      window.setTimeout(() => {
        button.textContent = '复制';
      }, 1600);
    });
  });
  pre.appendChild(button);
}

export async function highlightCodeBlocks(root: HTMLElement, theme: 'light' | 'dark'): Promise<void> {
  const pres = [...root.querySelectorAll<HTMLElement>('pre.code-block')];
  if (pres.length === 0) return;

  let highlighter: Highlighter;
  try {
    highlighter = await getHighlighter();
  } catch (error) {
    console.warn('[highlight] shiki 初始化失败，代码块降级为纯文本', error);
    for (const pre of pres) addCopyButton(pre);
    return;
  }

  for (const pre of pres) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const declared = pre.dataset.lang ?? '';
    const fromClass = /language-([\w+#-]+)/.exec(code.className)?.[1] ?? '';
    const lang = (declared || fromClass).toLowerCase().replace(/^language-/, '');
    if (!lang) {
      addCopyButton(pre);
      continue;
    }
    try {
      const html = highlighter.codeToHtml(code.textContent ?? '', {
        lang,
        theme: theme === 'dark' ? 'github-dark' : 'github-light',
      });
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const shikiPre = tmp.querySelector('pre');
      if (shikiPre) {
        pre.classList.add('shiki');
        pre.innerHTML = shikiPre.innerHTML;
      }
    } catch {
      /* 未知语言：保持纯文本 */
    }
    addCopyButton(pre);
  }
}
