import type { HighlighterCore } from 'shiki/core';

/** 代码块围栏里常见的缩写 / 别名 → Shiki 语言 id */
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  py: 'python',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  golang: 'go',
  'c#': 'csharp',
  cs: 'csharp',
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    // 动态 import：语法包 / wasm 单独成 chunk，只有出现代码块时才下载。
    highlighterPromise = import('./highlight-shiki').then((mod) => mod.createHighlighter());
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

  let highlighter: HighlighterCore;
  try {
    highlighter = await getHighlighter();
  } catch (error) {
    console.warn('[highlight] shiki 初始化失败，代码块降级为纯文本', error);
    for (const pre of pres) addCopyButton(pre);
    return;
  }

  const loaded = new Set(highlighter.getLoadedLanguages());
  for (const pre of pres) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const declared = pre.dataset.lang ?? '';
    const fromClass = /language-([\w+#-]+)/.exec(code.className)?.[1] ?? '';
    const raw = (declared || fromClass).toLowerCase().replace(/^language-/, '');
    const lang = LANG_ALIAS[raw] ?? raw;
    if (!lang || !loaded.has(lang)) {
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
