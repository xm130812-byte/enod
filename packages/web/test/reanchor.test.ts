import test from 'node:test'
import assert from 'node:assert/strict'

import { reanchor, reanchorAll } from '../src/lib/reanchor.ts'
import type { AnnotationAnchor, ResolvedAnchor } from '../src/lib/reanchor.ts'

function mustResolve(text: string, ann: AnnotationAnchor): ResolvedAnchor {
  const resolved = reanchor(text, ann)
  assert.notEqual(resolved, null, `批注 ${ann.id} 应该能重定位`)
  return resolved as ResolvedAnchor
}

test('1. 单一字面命中：返回精确的 start/end 与 exact 策略', () => {
  const text = 'The quick brown fox jumps over the lazy dog.'
  const ann: AnnotationAnchor = {
    id: 'a1',
    exact: 'brown fox',
    prefix: 'quick ',
    suffix: ' jumps',
    pos: 10,
  }

  const result = mustResolve(text, ann)
  assert.equal(result.id, 'a1')
  assert.equal(result.start, 10)
  assert.equal(result.end, 19)
  assert.equal(text.slice(result.start, result.end), 'brown fox')
  assert.equal(result.strategy, 'exact')
  assert.equal(result.score, 1)
})

test('2. 重复文本：prefix/suffix 把锚点消歧到第二处', () => {
  const text =
    'Chapter one mentions the shared topic briefly. Chapter two explores the shared topic in depth.'
  const exact = 'the shared topic'
  const first = text.indexOf(exact)
  const second = text.indexOf(exact, first + 1)
  assert.ok(first >= 0 && second > first, '测试文本必须包含两处 same exact')

  const ann: AnnotationAnchor = {
    id: 'a2',
    exact,
    prefix: text.slice(second - 32, second),
    suffix: text.slice(second + exact.length, second + exact.length + 32),
    pos: second,
  }
  const result = mustResolve(text, ann)
  assert.equal(result.start, second)
  assert.equal(result.end, second + exact.length)
  assert.equal(result.strategy, 'exact')

  // 上下文权重高于 pos：即使 pos 指向第一处，也应该按 prefix/suffix 选第二处
  const wrongPos = mustResolve(text, { ...ann, pos: first })
  assert.equal(wrongPos.start, second)
})

test('3. 前方插入文本：下标整体平移后仍能字面命中', () => {
  const original = 'Intro line.\n\nCached results are invalidated whenever the source file changes.'
  const exact = 'Cached results'
  const oldStart = original.indexOf(exact)
  const ann: AnnotationAnchor = {
    id: 'a3',
    exact,
    prefix: original.slice(oldStart - 14, oldStart),
    suffix: original.slice(oldStart + exact.length, oldStart + exact.length + 32),
    pos: oldStart,
  }

  const text = 'Preface inserted by another editor.\n\n' + original
  const result = mustResolve(text, ann)
  assert.notEqual(result.start, oldStart, '下标应该已经改变')
  assert.equal(result.start, text.indexOf(exact))
  assert.equal(result.end, text.indexOf(exact) + exact.length)
  assert.equal(text.slice(result.start, result.end), exact)
  assert.equal(result.strategy, 'exact')
})

test('4. 高亮内部改了一个字：fuzzy 命中附近且区间正确', () => {
  const original = 'The quick brown fox jumps over the lazy dog.'
  const exact = 'brown fox jumps'
  const oldStart = original.indexOf(exact)
  const text = 'The quick brown fix jumps over the lazy dog.'
  const expectedStart = text.indexOf('brown fix jumps')
  const ann: AnnotationAnchor = {
    id: 'a4',
    exact,
    prefix: original.slice(Math.max(0, oldStart - 8), oldStart),
    suffix: original.slice(oldStart + exact.length, oldStart + exact.length + 16),
    pos: oldStart,
  }

  const result = mustResolve(text, ann)
  assert.equal(result.strategy, 'fuzzy')
  assert.equal(result.start, expectedStart)
  assert.equal(result.end, expectedStart + exact.length)
  assert.equal(text.slice(result.start, result.end), 'brown fix jumps')
  assert.ok(result.score > 0.8 && result.score <= 1, `score=${result.score}`)
})

test('4b. 高亮内部删掉一个词：fuzzy 区间长度随之变化', () => {
  const ann: AnnotationAnchor = {
    id: 'a4b',
    exact: 'the quick brown fox jumps',
    prefix: 'Start: ',
    suffix: ' over the dog',
    pos: 7,
  }
  const text = 'Start: the quick brown jumps over the dog'
  const result = mustResolve(text, ann)
  assert.equal(result.strategy, 'fuzzy')
  assert.equal(result.start, 7)
  assert.equal(result.end, 7 + 'the quick brown jumps'.length)
  assert.equal(text.slice(result.start, result.end), 'the quick brown jumps')
  assert.ok(result.score > 0.8)
})

test('5. 高亮文字被删除：返回 null 且进入 orphaned', () => {
  const original = 'Before deleting this highlighted clause, check the surrounding context.'
  const exact = 'highlighted clause'
  const start = original.indexOf(exact)
  const ann: AnnotationAnchor = {
    id: 'a5',
    exact,
    prefix: original.slice(Math.max(0, start - 24), start),
    suffix: original.slice(start + exact.length, start + exact.length + 24),
    pos: start,
  }
  const text = 'Before deleting this , check the surrounding context.'

  assert.equal(reanchor(text, ann), null)

  const { resolved, orphaned } = reanchorAll(text, [ann])
  assert.deepEqual(resolved, [])
  assert.equal(orphaned.length, 1)
  assert.equal(orphaned[0], ann, 'orphaned 必须原样返回批注，不能静默丢弃')
})

test('6. 两条批注候选重叠：贪心接受 + 掩码重试，结果互不重叠', () => {
  const text = 'alpha beta gamma alpha beta delta alpha beta epsilon'
  const exact = 'alpha beta'
  const a: AnnotationAnchor = { id: 'a6', exact }
  const b: AnnotationAnchor = { id: 'b6', exact }

  const { resolved, orphaned } = reanchorAll(text, [a, b])
  assert.equal(orphaned.length, 0)
  assert.equal(resolved.length, 2)

  const first = resolved[0]!
  const second = resolved[1]!
  assert.ok(first.start < second.start)
  assert.ok(first.end <= second.start, '接受区间不能重叠')
  assert.equal(text.slice(first.start, first.end), exact)
  assert.equal(text.slice(second.start, second.end), exact)
})

test('6b. 只有一处候选且已被占用：另一条批注进入 orphaned', () => {
  const text = 'the lone token appears exactly once here'
  const exact = 'lone token'
  const a: AnnotationAnchor = { id: 'a6b', exact }
  const b: AnnotationAnchor = { id: 'b6b', exact }

  const { resolved, orphaned } = reanchorAll(text, [a, b])
  assert.equal(resolved.length, 1)
  assert.equal(orphaned.length, 1)
  assert.deepEqual(orphaned, [b])
})

test('7. 完全无关的区域不会被 20% 阈值外的近似匹配命中', () => {
  const text = 'Completely different content about gardening, soil preparation and compost.'
  const ann: AnnotationAnchor = {
    id: 'a7',
    exact: 'quantum entanglement experiment',
    prefix: 'physics lab notes: ',
    suffix: ' measured at dawn',
    pos: 5,
  }

  assert.equal(reanchor(text, ann), null)

  const { resolved, orphaned } = reanchorAll(text, [ann])
  assert.deepEqual(resolved, [])
  assert.deepEqual(orphaned, [ann])
})

test('8. 中文与 Emoji：下标是 UTF-16 code unit', () => {
  const text = '中文说明：这里有一段需要高亮的内容。Emoji 表情 😀👍 也很重要。'

  const exact = '需要高亮的内容'
  const start = text.indexOf(exact)
  const ann: AnnotationAnchor = {
    id: 'a8',
    exact,
    prefix: text.slice(Math.max(0, start - 8), start),
    suffix: text.slice(start + exact.length, start + exact.length + 8),
    pos: start,
  }
  const result = mustResolve(text, ann)
  assert.equal(result.start, start)
  assert.equal(result.end, start + exact.length)
  assert.equal(text.slice(result.start, result.end), exact)

  // 一个 emoji 是 2 个 code unit，两个 emoji 是 4 个
  const emoji = '😀👍'
  const emojiStart = text.indexOf(emoji)
  assert.ok(emojiStart > 0)
  const emojiAnn: AnnotationAnchor = {
    id: 'a8e',
    exact: emoji,
    prefix: text.slice(emojiStart - 6, emojiStart),
    suffix: text.slice(emojiStart + emoji.length, emojiStart + emoji.length + 6),
    pos: emojiStart,
  }
  const emojiResult = mustResolve(text, emojiAnn)
  assert.equal(emoji.length, 4)
  assert.equal(emojiResult.start, emojiStart)
  assert.equal(emojiResult.end, emojiStart + 4)
  assert.equal(text.slice(emojiResult.start, emojiResult.end), emoji)
})

test('9. 超长高亮（>2000 字符）内部被改：改用 prefix/suffix 上下文定位', () => {
  const prefix = 'PREFIX-0123456789-abcdefghijklmn'
  const suffix = 'ZYXWVUTSRQPONMLKJIHGFEDCBA-9876543210'
  const exact = 'Q'.repeat(2100)
  const editedExact = 'Q'.repeat(1000) + 'W' + 'Q'.repeat(1099)
  const text = prefix + editedExact + suffix

  const ann: AnnotationAnchor = {
    id: 'a9',
    exact,
    prefix,
    suffix,
    pos: prefix.length,
  }

  const result = mustResolve(text, ann)
  assert.equal(result.strategy, 'context')
  assert.equal(result.start, prefix.length)
  assert.equal(result.end, prefix.length + exact.length)
  assert.ok(result.score > 0 && result.score <= 1)
})

test('10. 空或纯空白 exact 直接返回 null', () => {
  const text = 'anything at all'
  assert.equal(reanchor(text, { id: 'e1', exact: '' }), null)
  assert.equal(reanchor(text, { id: 'e2', exact: '   \n\t ' }), null)
  assert.deepEqual(reanchorAll(text, [{ id: 'e3', exact: '' }]).orphaned, [
    { id: 'e3', exact: '' },
  ])
})

test('11b. 字面命中超过收集上限时，pos 附近的命中仍会被考虑', () => {
  const text = 'noise '.repeat(5000) + 'LEFT noise RIGHT'
  const target = text.lastIndexOf('noise')
  const ann: AnnotationAnchor = {
    id: 'cap',
    exact: 'noise',
    prefix: 'LEFT ',
    suffix: ' RIGHT',
    pos: target,
  }

  const result = mustResolve(text, ann)
  assert.equal(result.start, target)
  assert.equal(result.end, target + 'noise'.length)
})

test('11. 200k 字符文档 + 500 条批注：整体耗时可接受', () => {
  const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. '
  const text = paragraph.repeat(Math.ceil(200_000 / paragraph.length)).slice(0, 200_000)

  const annotations: AnnotationAnchor[] = []
  for (let i = 0; i < 500; i++) {
    const start = i * 380
    const exact = text.slice(start, start + 12)
    annotations.push({
      id: `perf-${i}`,
      exact,
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(start + 12, start + 44),
      pos: start,
    })
  }

  const started = performance.now()
  const { resolved, orphaned } = reanchorAll(text, annotations)
  const elapsed = performance.now() - started

  assert.equal(orphaned.length, 0)
  assert.equal(resolved.length, 500)
  for (let i = 0; i < annotations.length; i++) {
    const anchor = annotations[i]!
    const result = resolved[i]!
    assert.equal(text.slice(result.start, result.end), anchor.exact)
  }
  assert.ok(elapsed < 3000, `500 条批注耗时 ${elapsed.toFixed(1)}ms`)
})
