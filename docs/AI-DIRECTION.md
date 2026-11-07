# enod × DSH：AI 能力怎么接进来（方向提案 v0.1）

> 目标：让 enod 具备 AI 能力，但不把 enod 变成"又一个套壳聊天框"。
> 结论先行：**enod 做「AI 的落位层」，DSH 做「AI 的执行层」**。

---

## 1. 现状与问题

现在已经跑通的链路是：

```
DSH 会话 ──工具──▶ enod HTTP API ──▶ 读写批注
```

AI 完全在 DSH 侧，enod 只是被操作的对象。这条链路能用，但每加一个能力就要在插件里加一段胶水，而且**AI 的产出没有协议**：

- 分析写到哪？（现在是往备注里塞一段文本）
- 锚在哪？（一段划线？一个段落？整篇？）
- 谁产出的？（哪个模型、哪版提示词、跑了多久）
- 能不能重跑、对比、撤销？

没有这些，AI 能力只会长成一堆"写进正文的文本"，越用越乱。

## 2. 主张

enod 不该内建模型调用，也不该绑死某个厂商。它该提供的是 AI 产出**必须落位**的那三样东西：

| 概念 | 作用 | enod 已有对应物 |
|---|---|---|
| **锚点 anchor** | 结果属于文本的哪一段 | 批注（exact/prefix/suffix/pos）已经是一等公民 |
| **任务 job** | "对某个锚点做某件事"的可排队请求 | 剪藏任务队列已经证明这套模型可行 |
| **账本 ledger** | 这次产出由谁、用什么、何时产生 | frontmatter / sidecar 已有版本与哈希基础 |

模型、提示词、联网工具留在 DSH —— 那里迭代最快，也最该由用户当前选中的模型来执行。enod 只保证"结果落在正确的位置、可追溯、可重跑"。

## 3. 数据模型

### 3.1 AI 结果（`reader.ai[]`）

写在 frontmatter，与 `reader.annotations` 平级；非 md 文件走 sidecar（同现有规则）。

```yaml
reader:
  ai:
    - id: 01M7AB...            # ULID
      kind: explain            # explain | verify | counter | summarize | ask
      anchor:
        type: annotation       # annotation | paragraph | doc
        id: 01M6TD...          # annotation 时为批注 id
        quote: "……"            # 冗余存一份，锚点失效时仍可读
      output: "……"             # 结果正文（纯文本/Markdown）
      sources:                 # 联网得来的引用
        - title: "Anthropic, Building effective agents"
          url: "https://…"
      run:
        model: deepseek-flash
        promptVersion: v3
        startedAt: 2026-11-07T09:12:00+08:00
        durationMs: 8400
      status: done             # done | stale
```

**为什么锚点要冗余存 quote**：文本会被编辑，锚点会漂。批注已经有四级重定位，AI 结果复用同一套逻辑；实在对不上时标 `stale` 而不是删掉。

### 3.2 任务（不入 frontmatter，走索引库）

任务是一次性的、可丢弃的，`index.db` 里一张表就够：

```
ai_jobs(id, doc_id, anchor_type, anchor_id, kind, prompt, state, created, claimed_by, finished)
state: queued | running | done | failed | cancelled
```

## 4. 接口

沿用现有 `/api/v1` 风格，只加四组：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ai/jobs` | 入队 `{docId, anchor:{type,id}, kind, prompt?}`，返回 `{jobId}` |
| GET | `/ai/jobs?state=queued&limit=1` | worker 领取（原子 claim），返回任务与**上下文包** |
| POST | `/ai/jobs/:id/complete` | 回写 `{output, sources, run}`，落进 `reader.ai[]` |
| POST | `/ai/jobs/:id/fail` | 记录失败原因，可重试 |
| GET | `/docs/:id/ai` | 按锚点列出结果 |
| SSE | `/events` | 新增 `ai-progress` 事件（queued/running/done） |

**关键设计**：`GET /ai/jobs` 返回的不是裸任务，而是**已经组装好的上下文包**——文档摘要底稿、锚点所在小节、相邻批注。这层在 enod 内核里做（Rust 侧已有 `buildContext` 的等价能力），保证无论谁当 worker，喂给模型的材料都一样。

## 5. DSH 侧：一个 worker 插件

```
DSH 会话 ──HTTP──▶ enod /ai/jobs ──▶ [claim] ──▶ 用当前会话模型执行 ──▶ [complete] ──▶ reader.ai[]
```

- 插件里不做推理，只做「取任务 → 调工具（web_search / 读文件）→ 交结果」；
- 用户在 enod 里点一个按钮，等于入队；DSH 这边（或独立的 headless worker）消费；
- 也可以反向：DSH 里说"给这篇的批注都做一次核实"，插件批量入队，enod 面板显示进度。

这样**同一个 AI 能力有三个入口**：enod 里的按钮、DSH 里的自然语言、命令行。

## 6. 三个首批能力（按投入产出排）

1. **批注级**（已在跑）：解释 / 核实 / 找反例 / 补背景 → 落进 `reader.ai[]`，替代现在往备注里塞文本的做法。
2. **段落级问答**：选中一段 → "这段在说什么/和哪篇冲突" → 答案锚到该段落，悬停可看引用。
3. **书库级**：跨文档问答与主题聚合（"我这半年关于 agent 的笔记有哪些互相矛盾的观点"），结果落成一篇新文档而不是聊天记录。

## 7. 前端（最小改动）

- 选区工具条：现有「高亮/批注/复制」后面加一个「问 AI」；
- 右侧面板：新增「AI」tab，按锚点分组，每条带模型/时间/重跑/删除；
- 批注悬浮卡：备注下面显示该批注的 AI 结果（一个即可，多了折叠）。

## 8. 非目标

- 不做 enod 内建的模型调用（API key、计费、限流都不该进内核）；
- 不做云端账号与协作；
- 不做"全文外发"——默认只发锚点上下文，全文需要显式同意。

## 9. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | `reader.ai[]` + 三个接口 + DSH worker 插件跑通批注级 | enod 里点一下，结果落到 frontmatter，DSH 里能看到任务完成 |
| M2 | 段落级问答 + 前端 AI tab + 悬停引用 | 选中段落提问，答案锚定，刷新不丢 |
| M3 | 书库级问答 + 批量任务 + 成本统计 | 一次问 50 篇，产出可导航的汇总文档 |

## 10. 与现有工作的关系

- 现在这个 DSH 插件（`dsh-plugin-enod-annotations`）是 M1 的雏形：读上下文、写回结果。升级点是**把"写备注"换成"写 `reader.ai[]`"**，备注退化为用户自己的旁注。
- enod 内核已经有任务队列（剪藏）、上下文切片、锚点重定位、SSE——M1 基本是复用，不是新造。

## 11. M1 落地记录（2026-11-07）

已实现，可跑通端到端：

| 层 | 落地物 |
|---|---|
| 数据 | `reader.ai[]` 读写；`reader.ai: false` 关闭；多行输出写成 YAML 字面量块（`\|2-`），文件里直接可读 |
| 存储 | `index.db` 的 `ai_jobs` 表（queued/running/done/error/canceled + attempts/worker/claimed_at），5 分钟超时把 running 放回队列 |
| 接口 | `/docs/:id/ai`、`DELETE /docs/:id/ai/:aiId`、`/ai/jobs` 的入队 / 列表 / claim / complete / fail / cancel |
| 上下文包 | claim 时返回小节标题 + 该节正文（围绕锚点截断，4000 字预算）+ 任务指令 + 提示词版本 |
| 前端 | 选区工具条加「解释 / 核实 / 背景 / 反问」；侧栏新增 AI tab（排队中 / 失败 / 已有产出，可删、可重跑、可跳到原文） |
| worker | 插件新增 6 个工具：`enod_ai_list` / `enod_ai_enqueue` / `enod_ai_claim` / `enod_ai_submit` / `enod_ai_fail` / `enod_ai_discard` |

验收方式：CDP 实测（选中正文 → 点「解释」→ 后端出现排队任务 → worker 领活交结果 → 侧栏卡片刻渲染），
外加 Node 端到端脚本核对 frontmatter 里的 `ai:` 块、来源、run 记录与原有 `annotations:` 块共存。

## 12. M2 落地记录（2026-11-07）

目标是把 AI 产出从「侧栏里的一列卡片」变成「长在正文上的」。已实现：

| 能力 | 做法 |
|---|---|
| 正文锚点 | 每条有原文锚点的 `reader.ai[]` 在锚点末尾插一个小 ✦（`mark.ai` 不包裹原文，避免和批注高亮打架）；重定位复用批注的四层 `reanchor` |
| 悬停回看 | 悬停 ✦ 弹出轻量浮层（类型 / 原文 / 产出 / 来源 / 模型），不拖不钉，滚动即收 |
| 点开定位 | 点 ✦ 自动开侧栏、切 AI tab、聚焦对应条目并滚进视野；侧栏「跳到原文」反向闪 ✦ |
| 自由提问 | AI tab 顶部加提问框（`kind=ask`），带当前选区；`Ctrl+Enter` 入队 |
| 失效提示 | 原文改动导致锚点对不上的条目会被标出来，点「跳到原文」直接提示锚点已失效，不装作没事 |
| 书架可见 | `docs` 表加 `ai_count` 列，卡片底部显示 ✦N（和我自己的批注数分开） |

仍然没做：书库级问答（要产出可导航的汇总文档）、批量任务、成本统计——留给 M3。

## 13. 书库级问答（2026-11-07，M3 的第一块）

担心的是成本，所以先把它做成**可算的**，而不是靠「应该不会太贵」：

| 做法 | 进模型的上下文 | 14 篇 / 2.78 万字的库 |
| --- | --- | --- |
| 整库塞进去 | 全部 27,849 字 | ≈ 18,566 tokens，且书库一大就爆 |
| 检索 + 预算装箱（已做） | 16 段 / 8 篇 / 6,930 字 | **≈ 4,620 tokens（省 75%）** |

关键在**检索在本地跑**：FTS5 + jieba 打分、按小节切块、按预算贪心装箱，全在 enod 里完成，0 token。
模型只看到装箱后的片段，所以**花费只跟预算档有关，和书库多大无关** —— 1000 篇的库也是 8,000 字上限。

- 任务类型 `kind=library`，不锚定某篇文档（`doc_id` 为空）
- 预算三档：小 4,000 字 / 标准 8,000 字 / 深 16,000 字，硬上限 24,000 字
- 装箱约束：最多 8 篇、每篇最多 2 段、单段最多 2,000 字
- 交结果**落成一篇新文档**（`Inbox/问书库：<问题>.md`，标签 `问书库` `AI汇总`），
  正文 = 原问题引用 + 答案 + 外部来源，不塞进 `reader.ai[]`（那里放的是「某段旁边的解释」）
- 提示词要求「只依据片段回答、矛盾要写出来、没有材料就说没有」

入口两处：书架头部的「问书库」按钮（带预算档选择），或在对话里直接说「问一下书库：…」。
