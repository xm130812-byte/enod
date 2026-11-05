import type { HighlighterCore, LanguageInput, ThemeInput } from 'shiki/core';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import getWasm from 'shiki/wasm';

/*
 * 只打包用得到的语法。
 *
 * 之前 `import('shiki')` 会把 Shiki 自带的 300 多种语言全部切成 chunk，
 * 前端 dist 里 10MB 的 JS 有 8MB 是永远用不到的语法高亮。
 * 这里改用 shiki/core + 显式语言包；本文件由 highlight.ts 动态 import，
 * 所以这些语法只在文章里真的出现代码块时才加载。
 */
import langJavaScript from 'shiki/langs/javascript.mjs';
import langTypeScript from 'shiki/langs/typescript.mjs';
import langTsx from 'shiki/langs/tsx.mjs';
import langJsx from 'shiki/langs/jsx.mjs';
import langJson from 'shiki/langs/json.mjs';
import langBash from 'shiki/langs/bash.mjs';
import langPowerShell from 'shiki/langs/powershell.mjs';
import langPython from 'shiki/langs/python.mjs';
import langRust from 'shiki/langs/rust.mjs';
import langHtml from 'shiki/langs/html.mjs';
import langCss from 'shiki/langs/css.mjs';
import langSql from 'shiki/langs/sql.mjs';
import langMarkdown from 'shiki/langs/markdown.mjs';
import langYaml from 'shiki/langs/yaml.mjs';
import langDiff from 'shiki/langs/diff.mjs';
import langGo from 'shiki/langs/go.mjs';
import langJava from 'shiki/langs/java.mjs';
import langC from 'shiki/langs/c.mjs';
import langCsharp from 'shiki/langs/csharp.mjs';
import themeGithubLight from 'shiki/themes/github-light.mjs';
import themeGithubDark from 'shiki/themes/github-dark.mjs';

const LANGS: LanguageInput[] = [
  langJavaScript,
  langTypeScript,
  langTsx,
  langJsx,
  langJson,
  langBash,
  langPowerShell,
  langPython,
  langRust,
  langHtml,
  langCss,
  langSql,
  langMarkdown,
  langYaml,
  langDiff,
  langGo,
  langJava,
  langC,
  langCsharp,
];

const THEMES: ThemeInput[] = [themeGithubLight, themeGithubDark];

export function createHighlighter(): Promise<HighlighterCore> {
  return createHighlighterCore({
    themes: THEMES,
    langs: LANGS,
    engine: createOnigurumaEngine(getWasm),
  });
}
