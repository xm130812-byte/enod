/**
 * 批注锚点重定位
 *
 * 批注在 frontmatter 里只保存 { exact, prefix, suffix, pos }。文档被外部编辑器改动后，
 * 需要把旧的字符偏移重新映射到当前的纯文本：
 *   1. 字面查找 exact 的全部出现位置；
 *   2. 多个命中时用 prefix/suffix 的最长公共后缀/前缀打分，分数相同再按离 pos 的距离；
 *   3. 没有字面命中（高亮内部被改）时，在 pos 附近 ±2000 字符窗口内做允许 20% 编辑距离的
 *      近似匹配；exact 超过 2000 字符时放弃 O(n*m) 的编辑距离 DP，改用 prefix/suffix 上下文定位；
 *   4. 仍然找不到就返回 null，由调用方标记 orphaned（绝不静默丢弃）。
 *
 * 所有下标都是 UTF-16 code unit，与 JS 字符串和 DOM 文本节点一致；文本不做 normalize。
 */

export interface AnnotationAnchor {
  id: string
  exact: string
  prefix?: string | null
  suffix?: string | null
  pos?: number | null
}

export interface ResolvedAnchor {
  id: string
  start: number
  end: number
  score: number
  strategy: 'exact' | 'context' | 'fuzzy' | 'orphan'
}

/** 半开区间 [start, end) */
interface Span {
  start: number
  end: number
}

interface ScoredHit extends Span {
  context: number
}

interface ApproxHit extends Span {
  dist: number
}

/** 字面命中收集上限：病态文本（如单字符 exact）下避免一次批注就收集几十万个位置 */
const MAX_LITERAL_HITS = 4096
/** 命中数触顶时，额外补扫 pos 附近这么多个命中，避免正确位置被截断 */
const MAX_LOCAL_HITS = 2048
/** 补扫 pos 附近时的半径 */
const LOCAL_HIT_RADIUS = 50_000
/** exact 超过该长度就不再跑编辑距离 DP（O(n*m) 太贵），退化为上下文定位 */
const MAX_FUZZY_LENGTH = 2000
/** 近似匹配 / 上下文定位的搜索半径 */
const WINDOW_RADIUS = 2000
/** 存储的 prefix/suffix 参与比较的长度上限 */
const CONTEXT_LENGTH = 32

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000
}

function hasUsableExact(exact: string): boolean {
  return exact.length > 0 && exact.trim().length > 0
}

/**
 * 收集 needle 在 [from, to) 内的全部出现位置（含重叠），最多 limit 个。
 * 每次 indexOf 从上一个命中 +1 开始，整体扫描成本是线性的，不会随命中数退化成 O(n²)。
 */
function findOccurrences(
  text: string,
  needle: string,
  from: number,
  to: number,
  limit: number,
): number[] {
  const out: number[] = []
  const needleLength = needle.length
  if (needleLength === 0 || limit <= 0) return out
  const end = Math.min(to, text.length)
  let index = text.indexOf(needle, Math.max(0, from))
  while (index !== -1 && out.length < limit) {
    if (index + needleLength > end) break
    out.push(index)
    index = text.indexOf(needle, index + 1)
  }
  return out
}

/** 已占用区间是否与 [start, end) 相交（相邻不算重叠） */
function overlapsAny(occupied: Span[], start: number, end: number): boolean {
  for (const span of occupied) {
    if (start < span.end && span.start < end) return true
  }
  return false
}

function distanceToPos(index: number, pos: number | null): number {
  // pos 缺失时用下标本身当距离，保证结果确定（更靠前的优先）
  return pos === null ? index : Math.abs(index - pos)
}

function isCloser(index: number, than: number, pos: number | null): boolean {
  const a = distanceToPos(index, pos)
  const b = distanceToPos(than, pos)
  return a < b || (a === b && index < than)
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  return i
}

/**
 * prefix/suffix 上下文相似度，范围 0..1。
 * 分子是「已存 prefix 与命中前文本的最长公共后缀」+「已存 suffix 与命中后文本的最长公共前缀」，
 * 分母是两段已存上下文的长度之和。
 */
function contextScore(
  text: string,
  start: number,
  end: number,
  prefix: string | null | undefined,
  suffix: string | null | undefined,
): number {
  const left = prefix ?? ''
  const right = suffix ?? ''
  const total = left.length + right.length
  if (total === 0) return 0
  let matched = 0
  if (left.length > 0) {
    const before = text.slice(Math.max(0, start - left.length), start)
    matched += commonSuffixLength(left, before)
  }
  if (right.length > 0) {
    const after = text.slice(end, Math.min(text.length, end + right.length))
    matched += commonPrefixLength(right, after)
  }
  return matched / total
}

/**
 * 收集 needle 在 pos 附近（半径 radius）的命中，优先最近的：先向后扫，再向前扫。
 * 用于字面命中太多、被 MAX_LITERAL_HITS 截断时补齐正确位置。
 */
function findOccurrencesNear(
  text: string,
  needle: string,
  center: number,
  radius: number,
  limit: number,
): number[] {
  const out: number[] = []
  const needleLength = needle.length
  if (needleLength === 0 || limit <= 0) return out

  const end = Math.min(text.length, center + radius)
  let index = text.indexOf(needle, center)
  while (index !== -1 && index < end && out.length < limit) {
    out.push(index)
    index = text.indexOf(needle, index + 1)
  }

  const start = Math.max(0, center - radius)
  let back = text.lastIndexOf(needle, Math.max(0, center - 1))
  while (back !== -1 && back >= start && out.length < limit) {
    out.push(back)
    if (back === 0) break
    back = text.lastIndexOf(needle, back - 1)
  }
  return out
}

/**
 * 收集字面命中。正常情况下就是全量；命中数触顶时优先保证前 MAX_LITERAL_HITS 个，
 * 再补扫 pos 附近（文档被大量重复片段填满时，正确位置通常仍在 pos 附近）。
 */
function collectLiteralHits(text: string, exact: string, pos: number | null): number[] {
  const hits = findOccurrences(text, exact, 0, text.length, MAX_LITERAL_HITS)
  if (hits.length < MAX_LITERAL_HITS || pos === null) return hits

  const local = findOccurrencesNear(text, exact, pos, LOCAL_HIT_RADIUS, MAX_LOCAL_HITS)
  if (local.length === 0) return hits

  const seen = new Set(hits)
  for (const hit of local) {
    if (!seen.has(hit)) {
      seen.add(hit)
      hits.push(hit)
    }
  }
  return hits
}

/** 第 1、2 级：字面命中 + 上下文打分消歧 */
function resolveLiteral(
  text: string,
  ann: AnnotationAnchor,
  exact: string,
  pos: number | null,
  occupied: Span[],
): ResolvedAnchor | null {
  const hits = collectLiteralHits(text, exact, pos)
  if (hits.length === 0) return null

  let best: ScoredHit | null = null
  let usable = 0
  for (const start of hits) {
    const end = start + exact.length
    if (overlapsAny(occupied, start, end)) continue
    usable++
    const context = contextScore(text, start, end, ann.prefix, ann.suffix)
    if (
      best === null ||
      context > best.context ||
      (context === best.context && isCloser(start, best.start, pos))
    ) {
      best = { start, end, context }
    }
  }
  if (best === null) return null

  // 唯一命中即最高置信度；多命中时上下文匹配得越好越可信（0.9~1.0）
  const score = usable === 1 ? 1 : 0.9 + 0.1 * best.context
  return {
    id: ann.id,
    start: best.start,
    end: best.end,
    score: roundScore(score),
    strategy: 'exact',
  }
}

/**
 * 从一个近似的起点出发，用带状的编辑距离 DP 求最优区间。
 * 允许起点在 seedStart..seedStart+slack 之间自由滑动（吸收种子位置之前的增删字符），
 * 返回距离 <= maxErrors 的最优 {start, end, dist}。
 * 复杂度 O((m + maxErrors + slack) * (2 * maxErrors + slack))。
 */
function approxFromSeed(
  text: string,
  seedStart: number,
  pattern: string,
  maxErrors: number,
  slack: number,
): ApproxHit | null {
  const m = pattern.length
  const usable = Math.min(text.length - seedStart, m + maxErrors + slack)
  if (usable <= 0) return null

  const patternCodes = new Int32Array(m)
  for (let i = 0; i < m; i++) patternCodes[i] = pattern.charCodeAt(i)

  const INF = maxErrors + 1
  const width = m + 1
  let prev = new Int32Array(width)
  let prevStart = new Int32Array(width)
  let cur = new Int32Array(width)
  let curStart = new Int32Array(width)

  // 第 0 行：文本还没消耗，先删掉 pattern 的前 j 个字符（允许命中从 pattern 中间开始）
  for (let j = 0; j <= m; j++) prev[j] = Math.min(j, INF)

  let best: ApproxHit | null = null
  for (let i = 1; i <= usable; i++) {
    cur.fill(INF)
    curStart.fill(0)
    // 跳过文本开头的少量字符（free start），最多 slack 个
    if (i <= slack) {
      cur[0] = 0
      curStart[0] = i
    }
    const code = text.charCodeAt(seedStart + i - 1)
    const jFrom = Math.max(1, i - maxErrors - slack)
    const jTo = Math.min(m, i + maxErrors)
    for (let j = jFrom; j <= jTo; j++) {
      let value = prev[j - 1]! + (code === patternCodes[j - 1]! ? 0 : 1)
      let start = prevStart[j - 1]!

      const skipText = prev[j]! + 1
      if (skipText < value) {
        value = skipText
        start = prevStart[j]!
      }
      const skipPattern = cur[j - 1]! + 1
      if (skipPattern < value) {
        value = skipPattern
        start = curStart[j - 1]!
      }
      if (value > INF) value = INF
      cur[j] = value
      curStart[j] = start
    }
    if (cur[m]! <= maxErrors) {
      const dist = cur[m]!
      if (best === null || dist < best.dist) {
        best = { start: seedStart + curStart[m]!, end: seedStart + i, dist }
      }
    }
    let swap = prev
    prev = cur
    cur = swap
    swap = prevStart
    prevStart = curStart
    curStart = swap
  }
  return best
}

/**
 * 第 3 级：pos 附近窗口 + 20% 编辑距离的近似匹配。
 * 候选起点来自三处：prefix 尾部 / suffix 头部的上下文锚点、exact 的分块种子、pos 本身。
 * 分块种子用鸽笼原理：k 次编辑最多破坏 k+1 个分块中的 k 个，至少有一块完整出现在文本里。
 */
function resolveFuzzy(
  text: string,
  ann: AnnotationAnchor,
  exact: string,
  m: number,
  pos: number | null,
  occupied: Span[],
): ResolvedAnchor | null {
  if (m > MAX_FUZZY_LENGTH) return null
  const maxErrors = Math.floor(m * 0.2)
  // exact 太短时连一个字符的改动都算超过 20%，不做近似，直接交给上层判定 orphan
  if (maxErrors < 1) return null

  const from = pos === null ? 0 : Math.max(0, pos - WINDOW_RADIUS)
  const to = pos === null ? text.length : Math.min(text.length, pos + WINDOW_RADIUS + m)
  if (to - from < m - maxErrors) return null

  const starts = new Set<number>()
  const addStart = (value: number): void => {
    // 收缩 maxErrors：锚点位置可能因为块前后的增删字符偏 ±maxErrors，
    // 让 DP 的自由起点同时覆盖两个方向（见下面的 slack）。
    starts.add(clamp(value - maxErrors, 0, Math.max(0, text.length - 1)))
  }

  // 上下文锚点
  const prefix = ann.prefix ?? ''
  const suffix = ann.suffix ?? ''
  if (prefix.length >= 4) {
    const tailLength = Math.min(CONTEXT_LENGTH, prefix.length)
    const prefixTail = prefix.slice(prefix.length - tailLength)
    for (const hit of findOccurrences(text, prefixTail, from, to, 8)) addStart(hit + tailLength)
  }
  if (suffix.length >= 4) {
    const headLength = Math.min(CONTEXT_LENGTH, suffix.length)
    const suffixHead = suffix.slice(0, headLength)
    for (const hit of findOccurrences(text, suffixHead, from, to, 8)) addStart(hit - m)
  }

  // 分块种子
  const seedLength = Math.max(2, Math.floor(m / (maxErrors + 1)))
  const blockCount = Math.ceil(m / seedLength)
  const seedStep = Math.max(1, Math.ceil(blockCount / 64))
  for (let block = 0; block < blockCount; block += seedStep) {
    const offset = block * seedLength
    const needle = exact.slice(offset, offset + seedLength)
    if (needle.length < 2) continue
    for (const hit of findOccurrences(text, needle, from, to, 4)) addStart(hit - offset)
  }

  if (pos !== null) addStart(pos)
  if (starts.size === 0) return null

  const ordered = [...starts].sort(
    (a, b) => distanceToPos(a, pos) - distanceToPos(b, pos) || a - b,
  )
  const slack = 2 * maxErrors + 2
  const maxAttempts = m <= 128 ? 64 : m <= 512 ? 12 : 3
  let best: ApproxHit | null = null
  let attempts = 0
  for (const start of ordered) {
    if (attempts >= maxAttempts) break
    attempts++
    const hit = approxFromSeed(text, start, exact, maxErrors, slack)
    if (hit === null) continue
    if (overlapsAny(occupied, hit.start, hit.end)) continue
    if (
      best === null ||
      hit.dist < best.dist ||
      (hit.dist === best.dist && isCloser(hit.start, best.start, pos))
    ) {
      best = hit
    }
  }
  if (best === null) return null

  // 全对上是 0.9，刚好 20% 编辑距离约 0.79
  const score = 0.35 + 0.55 * (1 - best.dist / m)
  return {
    id: ann.id,
    start: best.start,
    end: best.end,
    score: roundScore(score),
    strategy: 'fuzzy',
  }
}

/**
 * exact 过长时的廉价兜底：只认 prefix 尾部和 suffix 头部这两段字面上下文，
 * 用它们框出高亮区间，并要求区间长度与 exact 相差不超过 50%（整段被删时不会误判）。
 */
function resolveContext(
  text: string,
  ann: AnnotationAnchor,
  exact: string,
  m: number,
  pos: number | null,
  occupied: Span[],
): ResolvedAnchor | null {
  const prefix = ann.prefix ?? ''
  const suffix = ann.suffix ?? ''
  if (prefix.length < 6 || suffix.length < 6) return null

  const tailLength = Math.min(CONTEXT_LENGTH, prefix.length)
  const headLength = Math.min(CONTEXT_LENGTH, suffix.length)
  const prefixTail = prefix.slice(prefix.length - tailLength)
  const suffixHead = suffix.slice(0, headLength)

  const from = pos === null ? 0 : Math.max(0, pos - WINDOW_RADIUS - m)
  const to = pos === null ? text.length : Math.min(text.length, pos + WINDOW_RADIUS + m)
  if (to - from < headLength) return null

  const tolerance = Math.max(2, Math.ceil(m * 0.5))
  let best: { start: number; end: number; context: number } | null = null
  for (const tailHit of findOccurrences(text, prefixTail, from, to, 64)) {
    const start = tailHit + tailLength
    if (start >= to) continue
    const suffixIndex = text.indexOf(suffixHead, start)
    if (suffixIndex === -1 || suffixIndex + headLength > to) continue
    const end = suffixIndex
    const spanLength = end - start
    if (spanLength <= 0 || Math.abs(spanLength - m) > tolerance) continue
    if (overlapsAny(occupied, start, end)) continue
    const context = contextScore(text, start, end, prefix, suffix)
    if (
      best === null ||
      context > best.context ||
      (context === best.context && isCloser(start, best.start, pos))
    ) {
      best = { start, end, context }
    }
  }
  if (best === null) return null

  return {
    id: ann.id,
    start: best.start,
    end: best.end,
    score: roundScore(0.3 + 0.5 * best.context),
    strategy: 'context',
  }
}

/** 内部实现：occupied 是本轮已占用的区间（重试时作为掩码，避免再次选中重叠位置） */
function resolveAnchor(
  text: string,
  ann: AnnotationAnchor,
  occupied: Span[],
): ResolvedAnchor | null {
  const exact = typeof ann.exact === 'string' ? ann.exact : ''
  if (!hasUsableExact(exact)) return null

  const m = exact.length
  const pos =
    typeof ann.pos === 'number' && Number.isFinite(ann.pos)
      ? clamp(Math.trunc(ann.pos), 0, text.length)
      : null

  const literal = resolveLiteral(text, ann, exact, pos, occupied)
  if (literal !== null) return literal

  if (m > MAX_FUZZY_LENGTH) return resolveContext(text, ann, exact, m, pos, occupied)
  return resolveFuzzy(text, ann, exact, m, pos, occupied)
}

/** 重定位单条批注；找不到返回 null（调用方应标记 orphaned） */
export function reanchor(text: string, ann: AnnotationAnchor): ResolvedAnchor | null {
  return resolveAnchor(text, ann, [])
}

/**
 * 批量重定位：
 * 先各算一次候选，按 score 降序（同分时离 pos 更近的优先）贪心接受互不重叠的区间；
 * 因重叠落选的批注带着已占用区间的掩码再试一次，仍放不下才归入 orphaned。
 */
export function reanchorAll(
  text: string,
  annotations: AnnotationAnchor[],
): { resolved: ResolvedAnchor[]; orphaned: AnnotationAnchor[] } {
  const occupied: Span[] = []
  const resolved: ResolvedAnchor[] = []
  const orphaned: AnnotationAnchor[] = []

  const pending: { ann: AnnotationAnchor; candidate: ResolvedAnchor; order: number }[] = []
  annotations.forEach((ann, order) => {
    const candidate = reanchor(text, ann)
    if (candidate === null) {
      orphaned.push(ann)
    } else {
      pending.push({ ann, candidate, order })
    }
  })

  pending.sort((a, b) => {
    if (b.candidate.score !== a.candidate.score) return b.candidate.score - a.candidate.score
    const posA = a.ann.pos ?? null
    const posB = b.ann.pos ?? null
    const distA = distanceToPos(a.candidate.start, posA)
    const distB = distanceToPos(b.candidate.start, posB)
    if (distA !== distB) return distA - distB
    return a.order - b.order
  })

  for (const item of pending) {
    if (!overlapsAny(occupied, item.candidate.start, item.candidate.end)) {
      occupied.push({ start: item.candidate.start, end: item.candidate.end })
      resolved.push(item.candidate)
      continue
    }
    // 与已接受区间重叠：带着掩码重试，看能否换到另一处（例如另一处字面出现）
    const retry = resolveAnchor(text, item.ann, occupied)
    if (retry !== null && !overlapsAny(occupied, retry.start, retry.end)) {
      occupied.push({ start: retry.start, end: retry.end })
      resolved.push(retry)
    } else {
      orphaned.push(item.ann)
    }
  }

  resolved.sort((a, b) => a.start - b.start || a.end - b.end)
  return { resolved, orphaned }
}
