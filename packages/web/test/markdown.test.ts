import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, slugifyHeading } from '../src/lib/markdown.ts';

test('headings get slugified, CJK-safe, deduped ids', () => {
  const html = renderMarkdown(
    '# 你好 世界\n\n## 你好 世界\n\n# Hello, World!\n',
  );

  assert.match(html, /<h1 id="你好-世界">/);
  assert.match(html, /<h2 id="你好-世界-2">/);
  assert.match(html, /<h1 id="hello-world">/);

  assert.equal(slugifyHeading('Hello, World!'), 'hello-world');
  assert.equal(slugifyHeading(' 你好，世界！ '), '你好世界');
  assert.equal(slugifyHeading('C++ / Rust'), 'c-rust');

  // Inline markup must not leak into the id.
  assert.match(renderMarkdown('# Hello *world*\n'), /id="hello-world"/);
  assert.match(renderMarkdown('# `code` heading\n'), /id="code-heading"/);
});

test('wiki links support display text, anchors and spaces', () => {
  const calls: Array<[string, string | undefined]> = [];
  const resolveWiki = (target: string, anchor?: string) => {
    calls.push([target, anchor]);
    return { href: `#/doc/${target}${anchor ? `#${anchor}` : ''}` };
  };

  const html = renderMarkdown(
    '[[目标页面|显示文本]] [[页面#小节]] [[My Page]]',
    { resolveWiki },
  );

  assert.match(html, /href="#\/doc\/目标页面"/);
  assert.match(html, /class="wiki-link"/);
  assert.match(html, /data-wiki-target="目标页面"/);
  assert.match(html, />显示文本<\/a>/);

  assert.match(html, /data-wiki-anchor="小节"/);
  // No explicit display: defaults to the target, not the anchor.
  assert.match(html, /data-wiki-target="页面"[^>]*>页面<\/a>/);

  assert.match(html, /data-wiki-target="My Page"/);
  assert.match(html, /href="#\/doc\/My Page"/);

  assert.deepEqual(calls, [
    ['目标页面', undefined],
    ['页面', '小节'],
    ['My Page', undefined],
  ]);
});

test('wiki links fall back to broken links without a resolver / when null', () => {
  const broken = renderMarkdown('[[不存在]]');
  assert.match(broken, /class="wiki-link wiki-broken"/);
  assert.doesNotMatch(broken, /href=/);
  assert.match(broken, /data-wiki-target="不存在"/);
  assert.match(broken, /title="链接目标不存在"/);
  assert.match(broken, />不存在<\/a>/);

  const nullResolved = renderMarkdown('[[页面#小节]]', {
    resolveWiki: () => null,
  });
  assert.match(nullResolved, /class="wiki-link wiki-broken"/);
  assert.match(nullResolved, /data-wiki-anchor="小节"/);

  // A throwing resolver must not break rendering either.
  assert.doesNotThrow(() =>
    renderMarkdown('[[页面]]', {
      resolveWiki: () => {
        throw new Error('boom');
      },
    }),
  );
});

test('wiki inner text is not parsed as markdown emphasis/links', () => {
  const html = renderMarkdown('[[目标|*不是斜体* 和 [链接](https://e.com)]]', {
    resolveWiki: () => ({ href: '#/doc/target' }),
  });

  assert.match(html, /class="wiki-link"/);
  assert.match(html, />\*不是斜体\* 和 \[链接\]\(https:\/\/e\.com\)<\/a>/);
  assert.doesNotMatch(html, /<em>/);
  assert.doesNotMatch(html, /href="https:\/\/e\.com"/);
});

test('footnotes render a reference link and a footnotes section', () => {
  const html = renderMarkdown('正文[^1]\n\n[^1]: 脚注内容\n');

  assert.match(html, /class="footnote-ref"/);
  assert.match(html, /href="#fn1"/);
  assert.match(html, /<section class="footnotes">/);
  assert.match(html, /class="footnote-item"/);
  assert.match(html, /class="footnote-backref"/);
});

test('task list renders non-interactive checkboxes', () => {
  const html = renderMarkdown('- [ ] 待办\n- [x] 完成\n');

  assert.match(html, /contains-task-list/);
  assert.match(html, /task-list-item/);
  assert.match(html, /task-list-item-checkbox/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /checked=""/);
  assert.match(html, /<label>/);
});

test('tables and strikethrough work (GFM)', () => {
  const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n');

  assert.match(html, /<div class="table-wrap">/);
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /<\/table>\s*<\/div>/);

  assert.match(renderMarkdown('~~删除~~'), /<s>删除<\/s>/);
});

test('math renders katex markup and leaves currency alone', () => {
  const html = renderMarkdown(
    '质能方程 $E=mc^2$\n\n$$\n\\int_0^1 x^2 dx\n$$\n',
  );

  assert.match(html, /<span class="math math-inline"><span class="katex">/);
  assert.match(html, /<div class="math math-block">/);
  assert.match(html, /katex/);

  const currency = renderMarkdown('$5 and $10');
  assert.doesNotMatch(currency, /math-inline/);
  assert.match(currency, /\$5 and \$10/);

  // Escaped dollars are plain text.
  const escaped = renderMarkdown('price: \\$5');
  assert.doesNotMatch(escaped, /math-inline/);
  assert.match(escaped, /price: \$5/);

  // Block math inside a blockquote keeps the container marker out of the TeX.
  const quoted = renderMarkdown('> $$\n> x^2\n> $$\n');
  assert.match(quoted, /<blockquote>\s*<div class="math math-block">/);
  assert.doesNotMatch(quoted, /&gt;/);
});

test('images are lazy and carry the md-image class', () => {
  const html = renderMarkdown('![图](images/pic.png "标题")');

  assert.match(html, /src="images\/pic\.png"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /class="md-image"/);
  assert.match(html, /alt="图"/);
});

test('external links open in a new tab, internal links do not', () => {
  const html = renderMarkdown(
    '[示例](https://example.com) [内部](#章节) [相对](./other.md)',
  );

  assert.match(
    html,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">示例<\/a>/,
  );
  // Hash links are left alone (markdown-it percent-encodes the fragment).
  assert.match(html, /<a href="#[^"]*">内部<\/a>/);
  assert.match(html, /<a href="\.\/other\.md">相对<\/a>/);

  // markdown-it rejects javascript: URLs, keep that behaviour.
  assert.doesNotMatch(renderMarkdown('[x](javascript:alert(1))'), /href=/);
});

test('inline raw HTML passes through (app sanitizes later)', () => {
  assert.match(renderMarkdown('这是 <b>bold</b> 文本'), /<b>bold<\/b>/);
});

test('unclosed wiki link syntax does not crash and stays literal', () => {
  const inputs = ['不完整的 [[ 链接', '[[未闭合', '[[a|b'];
  for (const input of inputs) {
    assert.doesNotThrow(() => renderMarkdown(input));
    assert.match(renderMarkdown(input), /\[\[/);
  }
});

test('code blocks keep language class and add reader attributes', () => {
  const html = renderMarkdown('```ts\nconst a = 1;\n```\n');

  assert.match(html, /<pre class="code-block" data-lang="ts">/);
  assert.match(html, /<code class="language-ts">/);
  assert.doesNotMatch(html, /shiki/);
});
