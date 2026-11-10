# enod · 版本链路追踪（v1 → v5）

> 用途：把 **功能 → 设计取向 → 实现落点 → 验收证据** 串成一条可回溯的链，回答三个问题：
> 「这个功能是哪一版来的？」「当时为什么这么设计？」「现在改在哪、怎么证明它还对？」
>
> 维护约定见 [§12](#12-维护约定)。本文件只记录**已发生的事实**，不做规划；
> 每个结论后面都挂了证据文件，读不到证据的条目会显式标注「推断」。

**置信度图例**：`✅ 有文档/代码直接支撑` ｜ `🟡 由两份以上材料互证` ｜ `⚠️ 推断（无一手材料）`

---

## 0. 一句话时间线

| 版本 | 时间 | 形态 | 内核 | 一句话 |
|---|---|---|---|---|
| **v1** | 2026-11 上旬 ⚠️ | 纯 Web / PWA | 浏览器 | 「Markdown 知识库」，零安装、移动端优先 —— 被证伪 |
| **v2** | 2026-11-06 ✅ | Tauri 桌面应用（内嵌 webview） | Rust | 定位从「知识库」改成「阅读器」，押注 Rust + Tauri IPC |
| **v2.1** | 2026-11-06 ✅ | 本地守护进程 + Chrome 页面 | Node 24 | 同日反转形态：引擎是服务、界面是网页，Tauri 降级为壳 |
| **v3** | 2026-11-06 ✅ | 守护进程 + Chrome（Tauri 仅打包） | Node 24 | 定稿基线：写作升 P0，零原生模块、只承诺 Chrome |
| **v3.x** | 2026-11-06 ✅ | 同上 | Node 24 | 交付前打磨：一页/万卷双视图、视觉 M2、SEA 便携版 |
| **v4** | 2026-11-06 → 11-07 ✅ | 守护进程 + 壳（WebView2 / Chrome） | **Rust** | 内核重写、多格式、移动只读、托盘、体积硬约束，改名 **enod** |
| **v4.3** | 2026-11-07 → 11-08 ✅ | 同上 + **AI 队列与落位层** | Rust | 内核对 AI「只落位、不推理」：`reader.ai[]` + 任务队列 + 书库问答 |
| **v5** | 2026-11-10 ✅ | **被 DSH 嵌进右栏**（iframe + 本地 HTTP 桥） | Rust | 换 DSH 的皮、跟 DSH 的动效，并把 enod 变成宿主里的一栏 |

> 编号口径：v1–v4 沿用 [PRD-v4.md](./PRD-v4.md) §13 的实现版本登记（v4.1 内核、v4.2 托盘）；
> **v4.3 与 v5 是本文件侧给的口径**——v4.3 没有 PRD 变更（规格见 [AI-DIRECTION.md](./AI-DIRECTION.md)），
> v5 是形态上的新增（enod 第一次成为**可被嵌入的一面**），没有 PRD，理由见 [§8](#8-v5--与-dsh-合流2026-11-10)。
>
> 名字链路：`md-reader`（代码/仓库/包名沿用至今）→ **enod**（2026-11-07 起用于 productName / 窗口标题 / 托盘 / 网页标题）。
> 见 [PLAN-v4-remaining.md](./PLAN-v4-remaining.md) §7 日志与 `packages/shell/src-tauri/tauri.conf.json`。

---

## 1. v1 · 知识库与轻量阅读器（无一手文档）⚠️

| 维度 | 内容 |
|---|---|
| 功能 | 把 Markdown 当**知识库/笔记软件**用，文件树做首页；纯 Web、零安装、移动端 PWA |
| 设计 | 「像笔记软件一样管理 Markdown」，写作与整理是一等公民 |
| 实现 | 浏览器 + File System Access API 直接读写本地目录 |
| 结论 | **被证伪**，三个致命问题：只有 Chromium 支持文件夹读写；没有文件监听；写回不原子、编码无从处理 |

证据：[PRD-v2.md](../../PRD-v2.md) §0「v1 → v2 变更摘要」、[docs/ENVIRONMENT.md](../../docs/ENVIRONMENT.md) §1「v1 的浏览器灾难随架构切换已经消失」。
v1 的独立 PRD 未留存到本仓库，以上为 v2 文档里的回顾，标记为 ⚠️。

---

## 2. v2 · 转向「阅读器」，押注 Tauri + Rust（2026-11-06）✅

| 维度 | 内容 |
|---|---|
| 功能 | 书架（未读/在读/已读/收件箱）、阅读进度、页面级双链、网页剪藏（第二阶段） |
| 设计 | 一句话从「知识库」改为「**私人书库**」；写作从主体降为附属；明确不做云服务/协作/大纲/插件/PDF/EPUB |
| 实现 | React 18 + Vite 前端；Rust core（notify / 原子写 / 编码探测、jieba + FTS5、reqwest + Readability）；通信走 **Tauri IPC** |
| 遗留 | 「双链未提及 → Logseq 式页面级反链」「无内容引入 → 剪藏链路」两项是 v2 新增的核心模块 |

证据：[PRD-v2.md](../../PRD-v2.md) §0、§1、§3。
注意 v2 的架构图是「前端 → Tauri IPC → Rust Core」，这一层在 v2.1 当天就被换掉了。

---

## 3. v2.1 · 形态反转：守护进程 + Web UI（2026-11-06，同日）✅

| 项 | v2 | v2.1 | 原因 |
|---|---|---|---|
| 形态 | Tauri 应用，内嵌 webview | **本地守护进程 + 浏览器访问 `127.0.0.1:端口`** | 调试面直接可开；前后端可并行 |
| 后端语言 | Rust | **TypeScript / Node 24** | 本机没有 rustup 与 MSVC |
| Tauri 角色 | 应用主体 | **降级为可选外壳**（托盘、自启、单实例、安装包） | 逻辑已在 HTTP 之上 |
| 通信 | Tauri IPC | **HTTP + SSE** | 前端可独立开发；手机/iPad 可只读 |

| 维度 | 内容 |
|---|---|
| 功能 | 与 v2 同 |
| 设计 | 「一个本地服务 + 一个网页」，只通过 HTTP 契约耦合；顺带白捡多端只读 |
| 实现 | Node 24 **零原生模块**：`node:sqlite`（含 FTS5）、`Intl.Segmenter('zh')`、内置 `fetch`、`fs.watch({recursive})`；明确拒绝 better-sqlite3 / nodejieba / sharp / chokidar |
| 代价 | 多进程、多端口、启动等端口就绪；「任何本地网页都可能敲这个端口」→ 必须做安全模型 |

证据：[docs/ARCH-v2.1.md](../../docs/ARCH-v2.1.md) §0、§2.1、§2.2。

---

## 4. v3 · 定稿基线（2026-11-06）✅

### 4.1 七个必须记住的决议

| 编号 | 问题 | 结论 |
|---|---|---|
| D1 | 兼容 Logseq graph？ | **不兼容**，只认 `[[ ]]` 链接语义 |
| D2 | 应用形态 | **守护进程 + Chrome 访问**；Tauri 只做打包外壳，**不内嵌 webview** |
| D3 | 批注存储 | frontmatter 的 `reader.annotations`，正文不插任何标记 |
| D4 | 编辑器 | **CodeMirror 6 + Live Preview 装饰**，不做 ProseMirror 式 WYSIWYG |
| A2 | 端口 | 随机分配，首次随机后**粘性复用**（`run.json`） |
| A3 | 写作 | **P0**，第一版就要能完整写 |
| A5 | 平台 | Windows + macOS，浏览器**只承诺 Chrome**（当版不支持 Linux） |

### 4.2 功能面

书架（卡片/目录/标签/来源四视图、批量操作、虚拟滚动）· 阅读器（排版可调、三主题、TOC 高亮、沉浸、Shiki、KaTeX、脚注、文内查找）· 写作（CM6 + Live Preview、800ms 自动保存、冲突三选）· 批注（4 色、四级锚点重定位、orphaned 分组）· 双链（反链、悬浮预览、Unlinked Mentions、断链标红）· 搜索（`Ctrl+K`、200ms 去抖、标题/正文/标签/批注备注）· 剪藏（Readability → markdown → 图片本地化 → Inbox）· 设置。

### 4.3 里程碑（PRD-v3 §8，作为 v3 交付的验收口径）

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 可行性** | 中文召回、3000 文件索引、GBK+CRLF 写回、`fs.watch` 递归 | 四项全过 |
| **M1 骨架** | 守护进程 + 随机端口 + 静态托管 + 书架 + 渲染 + 搜索 | 3000 篇可搜、点开 <150ms |
| **M1.5 打包验证**（刻意前移） | Tauri 壳 + SEA sidecar + 托盘 | 双击安装包 → 托盘 → 自动开 Chrome |
| **M2 写作** | 编辑态、Live Preview、自动保存、文件操作、冲突 | 写 500 字 → 存 → 重开一致 |
| **M3 批注** | 划线、写回、四级重定位、面板 | 换编辑器可见；外部改动能重定位或标 orphaned |
| **M4 双链** | `[[]]` 解析、反链、预览、Unlinked、断链 | 50 篇互链 100% 正确 |
| **M5 剪藏** | 抓取、提取、图片、去重、收件箱 | 20 站成功率 >85% |
| **M6 交付** | 双平台安装包、自启、托盘、崩溃恢复 | 各装一次，用一周不崩 |

### 4.4 实现事实

- 后端 `packages/server/`（Node 原生 TS，零构建）：`core/`（ULID、hash、编码、EOL、原子写、frontmatter、分词、路径、配置）、`store/db.ts`、`library/`（索引、watch、文档读写、adapt）、`http/`（路由、安全、SSE）。
- 前端 `packages/web/`：React 18 + Vite + CodeMirror 6 + markdown-it + Shiki + KaTeX。
- 「文件就是数据库」：身份是 frontmatter 里的 ULID，路径不是身份；只写 `reader:` / `source:`，行级 patch 保注释与键序；编码保持 UTF-8/BOM/UTF-16/GB18030，EOL 保持 CRLF/LF。
- 交付：SEA 便携版（`dist/sea/md-reader.exe`），发布目录约 26.7 MB。

证据：[PRD-v3.md](../../PRD-v3.md)、[README.md](../README.md)、`packages/server/src/`。

---

## 5. v3.x · 交付前打磨（2026-11-06）🟡

这一轮没有新 PRD，改动记录在 README 与截图里：

| 变化 | 内容 |
|---|---|
| 视图重构 | **「一页」与「万卷」两种主视图**：一页=文件夹/目录两 tab + 单篇；万卷=书架 + 三栏阅读 + 状态导航；选择写 `localStorage · mr.app.mode` |
| 视觉 M2 | 参照 MiaoYan 的留白 + Mole 的深灰；暖纸画布、小圆角、28px 图标按钮、短动效、`prefers-reduced-motion`、两档密度 |
| 阅读布局 | 文档 / 专注 / 沉浸三种，布局写进配置，进出文章不丢 |
| 细节 | 侧栏可收成 46px 导轨、右面板收成边缘把手、文内查找、Unlinked Mentions、拖入 `.md` 导入 |

证据：[README.md](../README.md)、[docs/UI-DESIGN.md](./UI-DESIGN.md)、`docs/screenshots/`。

---

## 6. v4 · 内核重写与交付形态（2026-11-06 → 11-07）✅

### 6.1 为什么重写

v3 的 Node 实现已经把契约跑通，但三件事卡住：**单文件分发体积**（要带 Node 运行时）、**索引与分词的确定性**（`Intl.Segmenter` 对 OOV 的切法与 jieba 不同）、**多格式**（docx/html 需要更稳的本地解析）。v4 的取舍是：**换内核，不换契约** —— 前端零改动，用 23 个契约 fixture 双跑兜底。

### 6.2 功能面新增

| 能力 | 说明 |
|---|---|
| 多格式 | `.md` 可编辑；`.txt` / `.sql` **原生文本可编辑**（保编码保 EOL、不写 frontmatter）；`.html` / `.docx` 只读浏览 + 可划线批注（sidecar）+ 转 Markdown 副本 + 导出 |
| 冲突合并 | 三栏 diff3：磁盘版 / 我的版（MergeView 行级 diff）/ 可编辑结果 |
| 移动只读 | `--host 0.0.0.0` 强制 token（`?t=` 种 HttpOnly Cookie），服务端一律 403 写操作；≤768px 单栏、隐藏编辑入口 |
| 托盘与打开方式 | 托盘菜单（打开界面 / 应用窗口 / Chrome 标签 / 退出）、`shell.openMode` 存 config、360×620 概览弹层（统计/索引/最近/工作区切换/快捷动作）、关窗只 hide、二次启动恢复窗口 |
| 打包 | Tauri v2 壳 + sidecar：Windows NSIS / Linux deb；体积硬约束 |

### 6.3 里程碑（V4-STATUS 口径）

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M7 内核迁移 | ✅ | 契约 **23/23** |
| M7.5 高危项 | ✅ | golden **6/6**；召回 **98.01%**；剪藏真网页 8569 字 + 5 图 |
| M8 多端壳 | 🟡 | NSIS **6.86 MiB** 装通；deb **9.19 MiB**；macOS runner 拿不到 |
| M9 编辑体验 | ✅ | txt/sql 20/20；Playwright **12/12**；docx 三路径 |
| M10 体积 | ✅ | core 9.87 MiB、web 2.43 MB、tar.gz 6.56 MB |
| M11 移动只读 | ✅ | 401/200 + Cookie；390×844 无横向溢出 |

### 6.4 实现事实

- Rust 内核 `packages/core/crates/reader-core`：`atomic.rs` / `encoding.rs` / `frontmatter/{mod,patch}.rs` / `db`（单连接 actor + FTS5）/ `indexer` / `watcher` / `library` / `adapt/{txt,sql,html,docx}` / `clip`（SSRF 逐跳校验）/ `http`（axum + 安全中间件 + SSE）。
- 体积手段：`opt-level="z"`、fat LTO、`panic=abort`、strip、去 `.eh_frame`；Shiki 只内置 8 种语法。
- 壳 `packages/shell/src-tauri`：sidecar 约定 `md-reader-core`，`bundle.resources` 把 web 放到 `web/`，壳用 `READER_WEB_DIST` 指过去；Windows 下 spawn core 带 `CREATE_NO_WINDOW`。
- 改名 **enod**：`productName` / `identifier: app.enod.desktop` / 窗口标题 / tooltip / 网页标题 / 侧栏品牌 / 托盘图标。

证据：[docs/V4-STATUS.md](./V4-STATUS.md)、[docs/PLAN-v4-remaining.md](./PLAN-v4-remaining.md)、[packages/core/README.md](../packages/core/README.md)、`packages/shell/src-tauri/`。

---

## 7. v4.3 · AI 落位层（2026-11-07 → 11-08）✅

主张一句话：**enod 不内建模型调用，只保证 AI 产出落在正确的位置、可追溯、可重跑**；模型、提示词、联网工具留在 DSH。否则 AI 能力只会长成「一堆写进正文的文本」。

### 7.1 落地物

| 层 | 落地物 | 落点 |
|---|---|---|
| 数据 | `reader.ai[]` 与 `reader.annotations` 平级；`reader.ai: false` 可关；多行输出写成 YAML 字面量块，文件里直接可读 | `frontmatter/` |
| 任务 | `index.db` 的 `ai_jobs`（queued / running / done / error / canceled + attempts / worker / claimed_at），5 分钟超时把 running 放回队列 | `library/ai.rs` |
| 接口 | `/docs/:id/ai`、`DELETE /docs/:id/ai/:aiId`、`/ai/jobs` 的入队 · 列表 · claim · complete · fail · cancel | `http/routes.rs` |
| 上下文包 | claim **不返回裸任务**：小节标题 + 围绕锚点截断的正文（4000 字预算）+ 任务指令 + 提示词版本，在内核里组装好，换谁当 worker 材料都一样 | `library/ai.rs` |
| 前端锚点 | 每条有原文锚点的结果在锚点末尾插一个 ✦（`mark.ai` 不包裹原文，否则会和批注高亮打架）；重定位复用批注那套四级 `reanchor` | `components/ArticleView.tsx` |
| 前端面板 | 选区工具条「解释 / 核实 / 背景 / 反问」；侧栏 AI tab（排队中 / 失败 / 已有产出，可删、可重跑、跳原文）；书架卡片 ✦N | `AiCard.tsx`、`SelectionToolbar.tsx`、`ShelfPage.tsx` |
| 浮框 | AI 与批注**共用一套外壳**：拖标题栏、右下角改大小、可钉住（合计最多 3 个）、尺寸按 `ai:<id>` 记忆 | `AnnCard.tsx`、`AiFloatCard.tsx` |
| 渲染 | 产出按 Markdown 渲染（粗体 / 列表 / 行内代码 / 表格 / `[[双链]]` 可点），走 AI 专用净化：删远端图片与内联样式、外链新标签 | `AiMarkdown.tsx` |
| worker | DSH 插件 6 个工具：`enod_ai_list` / `enqueue` / `claim` / `submit` / `fail` / `discard` | `enod-dsh-plugin/lib/tools-ai.js` |

### 7.2 书库级问答：把成本做成可算的

| 做法 | 进模型的上下文 | 2.78 万字 / 14 篇的库 |
|---|---|---|
| 整库塞进去 | 全部 27,849 字 | ≈ 18,566 tokens，且书库一大就爆 |
| **检索 + 预算装箱（已做）** | 16 段 / 8 篇 / 6,930 字 | **≈ 4,620 tokens（省 75%）** |

关键在于**检索在本地跑**：FTS5 + jieba 打分、按小节切块、按预算贪心装箱全在内核完成，0 token。所以花费只跟预算档有关，和书库多大无关（1000 篇的库也是同一个上限）。

- `kind=library`，不锚定某篇（`doc_id` 为空）；三档预算 4,000 / 8,000 / 16,000 字，硬上限 24,000 字；
- 装箱约束：最多 8 篇、每篇最多 2 段、单段最多 2,000 字；
- 交结果**落成一篇新文档**（`Inbox/问书库：<问题>.md`，标签 `问书库` `AI汇总`），不塞进 `reader.ai[]`——那里放的是「某段旁边的解释」；
- 提示词要求「只依据片段回答、矛盾要写出来、没材料就说没有」；标准档约 ¥0.009/次。

### 7.3 顺带修的

| 问题 | 修法 | commit |
|---|---|---|
| 标题显示「未命名」 | 7 条占位标题过滤 + `create_doc` / `save_doc` 从正文 H1 取名 | `9f1190a` |
| AI 产出以源码形式出现 | 改为 Markdown 渲染 + 专用净化 | `93e0ace` |
| AI 浮框与批注浮框两套行为 | 统一成一套外壳（`AnnCard`） | `d0ec488` |
| 演示文档混在仓库夹具里 | 演示文档迁到正式书库 `D:\note`，`sample-library/` 只留转换夹具 | `1a20745` |

证据：[docs/AI-DIRECTION.md](./AI-DIRECTION.md)（主张、数据模型、M1–M3 逐条落地记录）、`library/ai.rs`、`packages/core/tests/`；提交 `bec9fce` → `208edfc` → `0967e0b` → `d0ec488` → `93e0ace` → `9f1190a`。

---

## 8. v5 · 与 DSH 合流（2026-11-10）✅

> 没有 PRD。动因是一句用户诉求：「把 DSH 的界面和工作区动画移植到 enod；同时想在 DSH 右边工作台打开 enod 同步学习。」
> 三个决定：**皮跟 DSH 走**、**不在 enod 里重写宿主**、**两边互为定位器**。
> 走这条路之前否决过「写 Obsidian 插件」，理由见 [§10](#10-被否决--回滚过的路线)。

### 8.1 换肤：搬 token，不是改颜色

新增 `styles/dsh-tokens.css` 装 DSH 的原料（色阶、圆角、阴影、动效曲线、四档描边），`app.css` 的 `:root` 再把 enod 自己的语义变量映射过去——以后跟 DSH 升级只改一张表。细节与取到的关键值见 [UI-DESIGN.md](./UI-DESIGN.md) §8。

| 维度 | 取到的值 |
|---|---|
| 中性色 | bluish 阶梯 `#f9fafb → #ebeef2 → #cfd3d6 → #61666b → #0f1115`，偏冷不是纯灰 |
| 圆角 | 4 / 8 / 12 / 16 / 20 / 28 |
| 层次 | 靠描边（4% → 10%、12%、16%），hover 才出阴影；去掉暖纸投影 |
| 动效曲线 | `cubic-bezier(.4,0,.2,1)`；100 / 200 / 300ms，**抽屉单独 180ms** |
| 主按钮 | 近黑填充（深色下反成白），强调色只给链接 / 选中 / 焦点环 |
| 页面层次 | 浅色 `#f9fafb` → 侧栏 `#f5f7fa` → 卡 `#fff`；深色 `#151517` → `#111113` → `#232324`（近黑底逐层提亮，不是把浅色反过来） |

### 8.2 动效：行 FLIP 与浮卡

新增 `lib/flip.ts`（`useRowFlip`），对齐 DSH 的 `AnimatedRows`：

| 场合 | 时长 | 说明 |
|---|---|---|
| 新增行 | 220ms | 淡入 + 轻抬 |
| 换位 | 260ms | FLIP 从旧位置滑过去 |
| 删除 | 200ms | 留一份不可交互的幽灵副本在原位淡出，不延迟卸载、不撑大滚动容器 |

只在**成员或顺序变化**的那次提交里播；内容更新、滚动、首帧都不播；`prefers-reduced-motion` 下整条路径短路。已接书架卡片网格、书架列表、阅读器批注 / AI 列表。

悬浮信息卡（`components/HoverCard.tsx`）复刻 DSH 的分组等待：列表里第一张等 **800ms**，亮过卡之后移到相邻行立即换卡，指针离开 **320ms** 后重置等待。

### 8.3 被嵌进右栏：embed 契约

| 端点 | 作用 | 关键约束 |
|---|---|---|
| `POST /api/v1/embed/beacon` | 页面 5s 一次心跳（`seq/at/href/title`） | 回 `{ok, open?}`：**顺带把待跳转地址带回并清空**，省掉第二条通道 |
| `POST /api/v1/embed/open` | 宿主一句话让面板跳到某篇 | `text/plain` body，避开额外预检；不返回页面内容 |
| `GET /api/v1/embed/state` | 面板存活探测（`seq/at/ageMs/href/title`） | `ageMs < 12s` 判在线，右栏状态栏据此变色 |

安全：

- `is_embed_origin` **只对 `/api/v1/embed` 前缀生效**，放行 `dsh-app://` 与 `http://` + loopback（任意端口）；
- embed 的 POST 豁免 `X-Reader-Client` 与 Content-Type 校验（跨源预检过不去），其余写接口一个都不放松；
- CSP `frame-ancestors` 追加 `http://127.0.0.1:*` / `http://localhost:*` / `dsh-app:` —— enod 从此允许被本机页面框住，但只限这几种来源。

### 8.4 右栏插件

`dsh-plugin-enod-annotations`（独立仓库 `D:\something\enod-dsh-plugin`，0.5.0）：

- 同时注册 `sidebarRightTabs`（占席位）与 `slots`（渲染内容），`keepMounted` —— 切走再切回来不重载 iframe；
- 面板 = 26px 状态栏（● 已连接 / 正在连 / 读不到 + 当前文档标题）+ iframe `/?embed=1`；
- 在线判定改成**轮询 `/api/v1/embed/state`（1.5s）**，不再等 postMessage —— 那条路在这套壳里不通（见 8.6）；
- `?embed=1` 时前端加 `data-embed='1'`：隐藏书架 / 阅读器顶栏，强制完整（complex）布局；
- 版本门：删掉 `peerDependencies`，只声明 `engines.dsh: ^0.2.2-rc.1`。

### 8.5 四个便捷点（用户勾选的）

| 便捷点 | 做法 |
|---|---|
| **双向定位** | 宿主侧：插件在任何 enod 工具读到文档（`getDoc()`）后 `POST /embed/open`，面板随即翻到那篇；面板侧：点 ✦ 开侧栏、切 AI tab、聚焦该条 |
| **选中即问** | 选区工具条加「问…」，入队 `kind=ask` 并自动聚焦提问框（`inputActions` 是会话作用域渲染 prop，第三方插件拿不到，所以走 AI 队列而不是直接塞输入框） |
| **答案回写批注** | AI 卡片加「记到批注」：同锚点已有批注就**追加**（`---` + `✦ kind（AI）` + 结果），没有就**新建**一条黄高亮；写完自动切到批注标签 |
| **看得到状态** | 状态栏显示「enod 已连接 · <文档标题>」；`document.title` 也跟着文档走（`<doc> · enod`），标签页和状态栏说的是同一件事 |

### 8.6 踩到并修掉的坑

| 症状 | 真正原因 | 修法 | 位置 |
|---|---|---|---|
| 插件在宿主里显示「已停用」 | `peerDependencies` 钉 `@deepseek-ai/dsh-tools@0.2.1-rc.5`，DSH 升到 `0.2.2-rc.1` 后不满足（`>=0.2.1-rc.5` 在默认 semver 下**不**含 `0.2.2-rc.1`） | 删 peer，改 `engines.dsh` | `19e5590` |
| 用 `dsh.bundle` 装本地插件被判成「未选中」 | bundle 是「组合包」语义 | 只声明 `dsh.client` | `93935b7` |
| 右栏白屏，`onLoad` 明明已触发 | `onLoad` ≠ 应用就绪 | 只认页面发来的 `enod:ready`，并去掉整页不透明兜底 | `5ea0c0a`、`58cc3df` |
| 面板一直「正在连」 | `postMessage` 在 `dsh-app://app` 这个自定义 scheme 下不落地 | 换本地 HTTP 心跳 | `580de20`、`c73fe79` |
| `GET /embed/state` 403 + CORS 报错 | 安全中间件只认 `http://` 本机来源，宿主 origin 是 `dsh-app://app` | 放行该 scheme，CSP 同步加 | `a803493` |
| 标签页永远只写「enod」 | — | `document.title = '<doc> · enod'` | `e6e309c` |

### 8.7 刻意没做

- **enod → DSH 的反向跳转**（点 ✦ 跳到对话里那条回答）：第三方插件拿不到会话渲染钩子，得走 typert 远程服务，先留缺口（见 [§11](#11-当前未闭环)）；
- 正文排版不动（18px / 1.75 行高 / 68ch）：DSH 的 13–14px 是给产品 UI 的，中文长文会累；
- 批注四色（黄/绿/蓝/粉）与护眼 sepia 保留：前者是内容语义，后者是第三主题；
- 不引入 Montserrat（中文界面里几乎不出现，白背 180KB 不划算）。

证据：`docs/screenshots/v4-dsh-light.png`、`v4-dsh-dark.png`、`v4-dsh-hovercard.png`、`v4-embed.png`；提交 `82b7c13` → `7459834` → `54b1af0` → `580de20` → `e6e309c` → `a803493` → `45b891d`；插件 `d4ad860` → `95b45ba`。

---

## 9. 功能链路矩阵

一行一个功能，看它从哪来、现在在哪、怎么证明。

| 功能 | v1 | v2 | v2.1 | v3 | v4 | v4.3 | v5 | 当前落点 | 验收证据 |
|---|---|---|---|---|---|---|---|---|---|
| **形态** | 纯 Web/PWA | Tauri 内嵌 | 守护进程 + 浏览器 | 同 v2.1 | 守护进程 + Tauri 壳（WebView2/Chrome） | 同 v4 | **被 DSH 嵌进右栏的一栏**（iframe + 宿主插件） | `packages/shell/src-tauri/src/main.rs`、`enod-dsh-plugin/lib/client.js` | shell 冒烟、NSIS 装机、右栏实测 |
| **内核** | 浏览器 | Rust | Node 24 | Node 24 | **Rust（axum + rusqlite）** | 同 v4 + `ai_jobs` | 同 v4.3 + embed 三端点 | `packages/core/crates/reader-core/src/lib.rs` | 契约 23/23 |
| **书架** | 文件树 | 卡片 + 状态分组 | 同 v2 | 四视图 + 批量 + 虚拟滚动 | 继承 + 一页/万卷双视图 | 继承 + 卡片 ✦N | 继承 + 行 FLIP / hover 卡 | `components/ShelfPage.tsx`、`lib/flip.ts` | CDP e2e |
| **阅读器** | 基础渲染 | 排版可调、进度 | 同 v2 | 三主题、TOC、沉浸、Shiki、KaTeX | 继承 + 多格式只读 | 继承 + ✦ 锚点与浮卡 | **换 DSH 皮肤**，标题跟着文档走 | `components/ArticleView.tsx`、`ReaderPage.tsx` | `v4-reader-desktop.png`、`v4-dsh-light.png` |
| **写作** | 无 | 附属能力 | 同 v2 | **P0**：CM6 + Live Preview、800ms 保存、冲突三选 | 继承 + txt/sql 纯文本编辑 | 同 v4 | 同 v4 | `packages/web/src/editor/` | `scripts/edit-flow.mjs` 20/20 |
| **冲突** | — | 三选对话框 | 同 v2 | 手动合并面板 | **三栏 diff3** | 同 v4 | 同 v4 | `components/ConflictDialog.tsx` | `v4-diff3.png` |
| **批注** | 无 | 划线 + 反链面板 | 同 v2 | 4 色 + 四级重定位 + orphaned | 继承 + docx/html sidecar | 继承 + AI 结果共用浮框 | 浮框可钉/可调；「记到批注」回写 | `library/annotations.rs`、`AnnCard.tsx` | 单测 + 契约 |
| **双链** | 无 | 页面级 `[[ ]]` | 同 v2 | 反链/预览/Unlinked/断链 | 继承 | 继承 | 继承 | `src/indexer.rs`（resolveLinks） | 契约 fixture |
| **搜索** | 无 | jieba + FTS5 | 同 v2 | `Intl.Segmenter` + FTS5 | jieba + bigram + 单字兜底 | 继承 + 打分复用进书库装箱 | 同 v4.3 | `src/tokenizer.rs`、`db/` | `scripts/recall.mjs` 98.01% |
| **剪藏** | 无 | 第二阶段规划 | 同 v2 | Readability → md → 图片 → Inbox | Rust 版 + SSRF 逐跳校验 + 任务状态机 | 同 v4 | 同 v4 | `src/clip/`、`library/clip_jobs.rs` | `clip-smoke.sh`（真实网页） |
| **多格式** | 无 | 无 | 无 | 仅 `.md` | txt/sql 可编辑；html/docx 只读 + 转 md | 同 v4 | 同 v4 | `src/adapt/` | golden 6/6 |
| **移动端** | PWA（目标） | 未提 | LAN 只读（白捡） | 未做 | **M11 只读 + 响应式** | 同 v4 | 同 v4 | `http/security.rs`、`styles/mobile.css` | `lan-smoke.sh`、390×844 截图 |
| **托盘/开窗** | 无 | 托盘（规划） | 托盘（规划） | M1.5 验证、M6 交付 | 菜单 + 概览弹层 + 两种打开方式 | 同 v4 | 同 v4 | `shell/src-tauri/src/{main,prefs}.rs` | `PLAN-v4-remaining.md` §3 |
| **编码保真** | 无解 | 编码探测 | 同 v2 | UTF-8/BOM/UTF-16/GB18030 + EOL | 同 v3 | 同 v4 | 同 v4 | `src/encoding.rs` | GB18030+CRLF 20/20 |
| **安全** | 无 | 无 | "任何本地网页可敲端口" | Origin 白名单 + `X-Reader-Client` + CSP | 同 v3 + LAN token | 同 v4 | **+ embed 只对 `/api/v1/embed` 放行 `dsh-app://`，CSP `frame-ancestors`** | `http/security.rs`、`http/routes.rs` | `lan-smoke.sh` 401/403、embed 403→200 |
| **AI 产出** | — | — | — | — | — | **`reader.ai[]`（锚点 + 来源 + run 记录 + stale）** | 按 Markdown 渲染、可记回批注 | `library/ai.rs`、`AiCard.tsx`、`AiMarkdown.tsx` | CDP e2e、Node 端到端 |
| **AI 任务** | — | — | — | — | — | **`ai_jobs` 表 + claim 返回上下文包** | 选区「问…」直接入队 | `library/ai.rs`、`SelectionToolbar.tsx` | 超时回收、claim 原子性 |
| **书库问答** | — | — | — | — | — | **FTS5 + jieba 检索、按预算装箱，`kind=library`** | 书架「问书库」按钮 | `library/ai.rs`、`AiLibraryDialog.tsx` | 6,930 字 / 4,620 tokens（省 75%） |
| **换肤与动效** | 暖纸 | 暖纸 + 深灰 | 同 v2 | 视觉 M2 | 继承 | 继承 | **DSH token 表 + 抽屉 180ms + 行 FLIP + 800ms 浮卡** | `styles/dsh-tokens.css`、`lib/flip.ts`、`HoverCard.tsx` | `v4-dsh-light/dark/hovercard.png` |
| **嵌入** | — | — | LAN 只读 | — | — | — | **`?embed=1` + embed 三端点 + 心跳带回跳转地址** | `http/routes.rs`、`App.tsx` | `v4-embed.png`、`/embed/state` 心跳 |
| **宿主集成** | — | — | — | — | — | 批注读写的 DSH 工具 | **右栏常驻面板 + 读到哪篇跳哪篇** | `enod-dsh-plugin/lib/{client.js,enod.mjs}` | 面板 1.5s 心跳、`/embed/open` 200 |

---

## 10. 被否决 / 回滚过的路线

记录这些是为了**不再反复讨论**：

| 路线 | 出现版本 | 结局 | 理由 |
|---|---|---|---|
| 浏览器 + File System Access API | v1 | ❌ 否决 | 只有 Chromium 支持；无文件监听；写回不原子；GBK 无解 |
| Tauri 内嵌 webview 承载 UI | v2 | ❌ 否决（v2.1） | macOS 是 WKWebView、Windows 是 WebView2 → 两个内核，"只认 Chrome" 前提失效 |
| Rust core + Tauri IPC | v2 | ⏸ 搁置（v2.1 改 Node）→ ✅ v4 以另一种形态回归 | v2.1 时本机无 rustup/MSVC；v4 补齐 MSVC 后改走**守护进程**而非 IPC |
| 兼容 Logseq graph | v3 | ❌ 否决 | 不解析 `- ` 大纲与 `key:: value`，只认 `[[ ]]` |
| better-sqlite3 / nodejieba / sharp / chokidar | v2.1 | ❌ 否决 | 一旦引入原生模块，Windows 要装 VS、macOS 要装 Xcode CLT |
| WYSIWYG 表格 / 块拖拽 | v3 | ❌ 否决 | 表格在编辑器里就是源码 + 等宽对齐 |
| AppImage | v4 | ❌ 否决 | 会把 WebKitGTK 打进包，远超 15 MB；Linux 改出 deb |
| 无头浏览器做移动端验证 | v4 | 🟡 妥协 | 只验了桌面 Chromium 390×844，真机 Chrome for Android 未验 |
| 写 Obsidian 插件做双向同步 | v5 前 | ❌ 否决 | 要同步批注与正文就得重写编辑器与同步层，投入产出远低于「把 enod 嵌进宿主」 |
| 在 enod 内建测试目录 | v4.3 | ❌ 否决 | 正式书库只有 `D:\note` 一个；`sample-library/` 退化为格式转换夹具，不再当测试场地 |
| 用 `dsh.bundle` 分发本地插件 | v5 | ❌ 否决 | bundle 是「组合包」语义，本地插件会被登记成未选中，宿主里直接显示「已停用」 |
| `postMessage` 当宿主 ↔ 面板的通道 | v5 | ❌ 否决（该壳不落地） | `dsh-app://app` 这个自定义 scheme 下消息到不了父窗口；改本地 HTTP 心跳 |
| 在 enod 里内建模型调用（API key / 计费 / 限流） | v4.3 | ❌ 否决 | 这些不该进本地内核；enod 只做落位层，模型留在宿主侧 |

---

## 11. 当前未闭环

| 项 | 现状 | 卡点 |
|---|---|---|
| macOS 交付 | 代码 / workflow 就绪 | GitHub runner 拿不到（1 秒 cancelled，无 step 执行） |
| 二进制体积 | 10.35 MB（9.87 MiB） | 比 ≤10 MB 目标多 0.34 MB；大头是 jieba 词典与 PIE 重定向 |
| 剪藏成功率 | 本地假页 + 单测通过，真网页跑通 1 例 | 20 个主流站点未验收 |
| 批量移动 / 大文档 | 批量改状态/标签有，移动没有；>10 万字不分块 | 排在 P1/P2 |
| 真机移动端、LAN 首屏 <2s | 未验 | 同上 |
| **v4 需求基线** | `PRD-v4.md` 在 WSL 主副本里有，D: 镜像里没有 | 镜像与主副本的 `docs/` 未完全同步，读到哪一份取决于你在哪边看 |
| enod → DSH 反向定位 | 面板能被宿主带到某篇，点 ✦ 跳不回对话里的那条回答 | 第三方插件拿不到会话渲染钩子；要做需走 typert 远程服务 + 给消息做锚点 |
| 插件改动的生效方式 | 改 `lib/client.js` 必须重启 DSH | 宿主启动时把 client bundle 读进内存，没有 bundle watcher（`dsh-hmr` 只监听 profile patch） |
| 面板记忆上次位置 | 只记 `dsh.enod.src`，不记「上次在读哪篇」 | 深链要落在宿主侧配置里，面板侧无法自证 |
| AI 批量任务 / 成本统计 | 单条任务可跑，批量没有；成本只有口径没有仪表盘 | 排在 M3 后半（见 [AI-DIRECTION.md](./AI-DIRECTION.md) §9） |

---

## 12. 维护约定

1. **一次变更三行**：功能（用户看到什么）／设计（为什么这样取舍）／实现（改在哪个文件）。缺一行就别记。
2. **只写已发生**：规划写进 `PLAN-*.md`，本文件只收"已合并/已验收"的事实；未验收的写成 🟡 并注明缺口。
3. **每条都要有证据**：链接到 PRD / 状态文档 / 契约 fixture / 截图之一；拿不到证据就标 ⚠️ 推断。
4. **改契约必须同时改这里**：`/api/v1` 的任何字段变化（含 `/api/v1/embed` 那三个端点），都要更新 [§9](#9-功能链路矩阵) 对应行与 `packages/core/tests/contract/`。
5. 新版本收尾时补一行"一句话时间线"，并把新功能挂进矩阵。

---

## 13. 证据索引

| 文件 | 覆盖 |
|---|---|
| [PRD-v2.md](../../PRD-v2.md) | v1→v2 转向、v2 完整设计、被否方案 |
| [docs/ARCH-v2.1.md](../../docs/ARCH-v2.1.md) | 形态反转推演、Node 零原生模块验证、安全模型 |
| [PRD-v3.md](../../PRD-v3.md) | v3 定稿决议、功能规格、API 契约、M0–M6 |
| [docs/V4-STATUS.md](./V4-STATUS.md) | v4 M7–M11 逐项验收与数字 |
| [docs/PLAN-v4-remaining.md](./PLAN-v4-remaining.md) | 托盘/打开方式 P0–P3、双副本同步协议、状态日志 |
| [docs/PACKAGING.md](./PACKAGING.md) · [docs/UI-DESIGN.md](./UI-DESIGN.md) · [docs/TRAY-DESIGN-v1.md](./TRAY-DESIGN-v1.md) | 打包、视觉、托盘规范 |
| [packages/core/README.md](../packages/core/README.md) | Rust 内核参数、v4 新端点、兼容性 |
| [docs/AI-DIRECTION.md](./AI-DIRECTION.md) | AI 落位层的主张与非目标、`reader.ai[]` 数据模型、M1–M3 落地记录、书库问答的成本口径 |
| `docs/screenshots/v4-dsh-light.png` · `v4-dsh-dark.png` · `v4-dsh-hovercard.png` · `v4-embed.png` | v5 的换肤（浅/深）、悬浮信息卡、右栏嵌入 |
| 插件仓库 `D:\something\enod-dsh-plugin`（独立 git，`b229efc → 95b45ba`） | DSH 侧的批注 / AI 工具与右栏面板，不在本仓库内 |
| `docs/screenshots/` | 各版本界面与装机证据 |
