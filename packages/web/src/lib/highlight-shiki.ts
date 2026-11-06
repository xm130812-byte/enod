import type { HighlighterCore, LanguageInput, ThemeInput } from 'shiki/core';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/*
 * 只打包用得到的语法。
 *
 * 之前 `import('shiki')` 会把 Shiki 自带的 300 多种语言全部切成 chunk，
 * 前端 dist 里 10MB 的 JS 有 8MB 是永远用不到的语法高亮。
 * 这里改用 shiki/core + 显式语言包；本文件由 highlight.ts 动态 import，
 * 所以这些语法只在文章里真的出现代码块时才加载。
 *
 * 体积取舍：rust / go / java / c / csharp 的语法包没打进来（合计约 400KB），
 * 需要时在下面补一行 import 即可。
 */
import langJavaScript from 'shiki/langs/javascript.mjs';
import langTypeScript from 'shiki/langs/typescript.mjs';
import langJson from 'shiki/langs/json.mjs';
import langBash from 'shiki/langs/bash.mjs';
import langPython from 'shiki/langs/python.mjs';
import langHtml from 'shiki/langs/html.mjs';
import langCss from 'shiki/langs/css.mjs';
import langSql from 'shiki/langs/sql.mjs';
import themeGithubLight from 'shiki/themes/github-light.mjs';
import themeGithubDark from 'shiki/themes/github-dark.mjs';

// Q5：体积优先。内置 8 种语法；tsx/jsx/powershell/markdown/yaml/diff 超出预算，
// 一律降级为纯文本（代码块仍可复制），不再打进包里。
const LANGS: LanguageInput[] = [
  langJavaScript,
  langTypeScript,
  langJson,
  langBash,
  langPython,
  langHtml,
  langCss,
  langSql,
];

const THEMES: ThemeInput[] = [themeGithubLight, themeGithubDark];

export function createHighlighter(): Promise<HighlighterCore> {
  return createHighlighterCore({
    themes: THEMES,
    langs: LANGS,
    // 用 JS 正则引擎，省掉 oniguruma 的 wasm（约 600KB）；常用语法的高亮结果与原来一致
    engine: createJavaScriptRegexEngine(),
  });
}
