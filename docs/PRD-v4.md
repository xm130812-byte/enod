# md-reader · PRD & Tech Spec v4

> 版本：**v4.0（定稿）** ｜ 日期：2026-11-06
> 本文档**取代** PRD v3 中与「形态 / 平台 / 内核 / 体积 / 编辑范围」相关的决策，其余条款（文件格式、批注锚点、双链语义、安全模型）继续有效。
> 面向实现 Agent：所有决策附理由与被否决的方案；未写明处可自由实现。
> **本版无待确认项**：Q1–Q6 已于 2026-11-06 全部定稿，见 §11。
> **本版范围声明**：不讨论企业内网部署、终端管控、软件白名单与 PE 改名等交付环境问题。本版只做产品本身。
> **实现版本**：v4.2（2026-11-07），变更登记见 §13；规格基线仍为 v4.0。

---

## 0. 本版定稿决议

| 编号 | 问题 | **结论** |
|---|---|---|
| D1 | 内核语言 | **从 Node 迁移到 Rust**。目标产物 8–10 MB，三平台一致 |
| D2 | 桌面壳 | **界面只承诺 Chromium 内核**：Windows 内嵌 WebView2（Chromium）；macOS / Linux **不内嵌**，调起 Chrome / Chromium。壳仍用 Tauri v2，只负责托盘 / 单实例 / 自启 / 更新 |
| D3 | 多端范围 | **桌面三平台 P0**（Win / macOS / Linux）；**手机·平板只支持 Chrome for Android**（只读，P1）；iOS 不做 |
| D4 | 体积目标 | 安装后 **≤ 15 MB / 平台**，安装包 **≤ 12–15 MB**；web 资源 ≤ 2.5 MB |
| D5 | 非 md 编辑 | **txt / sql 完全可编辑**；**docx 只读 + 批注 + 转 md 副本**；html 只读 |
| D6 | 非 md 元数据 | 落在 **sidecar JSON**（`<文件名>.<ext>.reader.json`），跟着文件走 |
| D7 | 书库格式 | **完全不变**：`.md` + frontmatter 仍是唯一真相源，v3 书库零迁移 |
| D8 | API | **保持 `/api/v1` 契约不变**，双栈期用契约测试保证两套实现等价 |

**四条被否掉的路线，记在这里避免反复：**

1. **继续用 Node，只是把 SEA 做到三个平台** —— Node SEA 的 exe 是「node.exe + blob」，Windows 加 UPX 能到 22.7 MB，但 macOS arm64 上 UPX 基本不可用（Mach-O 支持有限），Linux 也要 90 MB 上下。这与「体积尽量小 + 多端」直接冲突，且每个平台都要维护一套 Node 二进制。**放弃**。
2. **Electron** —— 150 MB 起步，与体积目标差一个数量级。**放弃**（v3 已否）。
3. **纯浏览器 + File System Access API** —— 无文件监听、写回不原子、GBK 无解、Safari/Firefox 不支持。**放弃**（v2/v3 已论证）。
4. **内嵌 WebKit 内核**（macOS 的 WKWebView、Linux 的 WebKitGTK）—— **放弃**。界面只承诺 Chromium：`color-mix()`、Popover、`:has()`、`inert` 等特性在 WebKit 上要么缺失要么版本敏感，为它们写兼容层等于把「一套代码」变成「一套代码 + 一张降级矩阵」，与 v4 的维护成本目标冲突。macOS / Linux 直接调 Chrome。

> **v3 的 D2 为什么不完全推翻**：v3 否决内嵌，理由是「内嵌 = 两个内核 = Chrome-only 前提失效」。这个判断在 macOS/Linux 上成立，但**在 Windows 上不成立 —— WebView2 就是 Chromium**。所以 v4 的落点是：**Windows 内嵌（零内核差异，白拿窗口体验），macOS/Linux 不内嵌（继续调 Chrome）**。既守住了「只用 Chromium」，又在唯一不需要付兼容代价的平台上拿到了原生窗口。

---

## 1. 现状盘点（v3 基线与实际进度）

### 1.1 里程碑完成情况

| v3 里程碑 | 状态 | 证据 |
|---|---|---|
| **M0 可行性** | ✅ | 3000 篇实测：冷索引 20.3s、搜索 p95 22ms、GBK+CRLF 写回保真 |
| **M1 骨架** | ✅ | `11fb161` 一次提交 72 文件 14103 行，守护进程 / 索引 / 书架 / 渲染 / 搜索 |
| **M2 写作** | ✅ | CodeMirror 6 + Live Preview、800ms 自动保存、冲突对话框 |
| **M3 批注** | ✅ | 4 色高亮、四级锚点重定位、orphaned 分组、导出 Markdown |
| **M4 双链** | ✅ | `[[ ]]` 解析、反链、悬浮预览、Unlinked Mentions、断链 |
| **M5 剪藏** | ✅（待验收） | `bef5e14`；本地假页面 + 5 个单测通过，**20 个主流站点成功率未验收** |
| **M1.5 打包** | ⚠️ 部分 | `b2807c9` SEA sidecar 跑通；**Tauri 壳未做**（本机无 Rust/MSVC） |
| **M6 交付** | ⛔ | 无安装包、无托盘、无自启 |

### 1.2 v3 之后多出来的能力（v4 的起点）

| 能力 | 说明 | commit |
|---|---|---|
| **多格式只读浏览** | `.txt` / `.sql` / `.html` / `.docx` 转 markdown 派生正文，可搜索、可进目录、可被双链引用；原文件只读 | `ed00dfc` |
| **非 md 身份稳定性** | 非 md 无 frontmatter，id 由路径哈希派生，索引重建不掉身份 | `ed00dfc` |
| **图片本地化** | html / docx 的图片落到 `assets/<派生id>/`，断网可读 | `ed00dfc` |
| **一页视图批注面板** | 与万卷共用同一套批注 / 反链 / 提及 / 出链面板 | `2595657` |
| **体积优化** | 发布包 26.7 → 25.4 MB；web 4.2 → 2.7 MB | `1205d72` |
| **桌面化 UI** | 暖纸 / 深灰主题、内嵌收起、切换动效 | `22532a1`、未提交的后续 |

### 1.3 代码规模（v4 要迁移的量）

| 部分 | 行数 | 迁移策略 |
|---|---|---|
| `packages/server/src` | **5383** | 重写为 Rust（本版主要工作量） |
| `packages/web/src` | **7216** | **原样复用**，零改动（界面内核仍是 Chromium） |
| 测试 | 61 个用例 | 核心用例移植为 Rust 集成测试，其余保留 e2e |
| 运行时依赖 | 7 个（readability / iconv-lite / linkedom / mammoth / turndown / turndown-plugin-gfm / yaml） | 逐一对位替换，见 §4.3 |

---

## 2. 产品

### 2.1 一句话

把硬盘里的 `.md`、`.txt`、`.sql`、`.html`、`.docx` 变成一个**能舒服地读、能直接改、能全局搜、能划线批注、能互相链接**的私人书库 —— 装在包里不超过 15 MB，Windows / macOS / Linux 一个样。

### 2.2 用户与场景

单一用户，就是你自己。v4 新增两个场景：

| 场景 | 描述 | 关键诉求 |
|---|---|---|
| 消化存量 | 3000+ 篇长文，按状态与标签组织 | 找得到、看得快、读得完 |
| 深度阅读 | 打开两万字长文，划线写旁注 | 排版舒服、批注不丢 |
| 边读边写 | 读到错字就地改 | 进得去、改得动、不破坏原文件 |
| **多设备接力**（新） | 台式机读一半，笔记本接着读；平板上只看 | 进度、批注、状态跨设备一致 |
| **非 md 也能动手**（新） | 配置文件、SQL 脚本、导出的文本，改完直接存 | 不为了改一行去开 VS Code |

### 2.3 它不是什么

- 不是笔记软件：不做每日笔记、大纲、模板、插件市场。
- 不是 Obsidian / Logseq 的替代品：不做 graph 炫技，不做 outliner。
- 不是云盘：文件永远在本地，同步交给坚果云 / WebDAV / Git。
- **不是 Word**：docx 只读 + 批注 + 转 md，不原地编辑（理由见 §6.3）。
- 不是协作工具：没有账号、没有分享链接、没有多用户。

### 2.4 成功标准（v4 可验收）

1. **体积**：Windows 安装包 ≤ 12 MB；macOS dmg ≤ 14 MB；Linux AppImage ≤ 15 MB（安装后占用 ≤ 20 MB）。
2. **多端**：同一书库在三个桌面平台打开，进度 / 批注 / 状态完全一致；手机上能只读浏览并搜索。
3. **编辑**：`.md` / `.txt` / `.sql` 三种文件都能在应用内改、保存后原编码原 EOL 不变。
4. **启动**：双击到书架可交互 ≤ 1.5s（3000 篇库）。
5. **零迁移**：把 v3 的书库目录直接指过来就能用，不产生任何新文件（sidecar 除外）。

---

## 3. 形态与多端矩阵

### 3.1 运行形态（保持「本地服务 + Web UI」）

```
┌──────────────────────────────────────────────┐
│ Tauri 壳（Rust，3–4 MB）                      │
│  ├─ 托盘 / 单实例 / 开机自启 / 更新检查        │
│  ├─ 拉起内核，等待 run.json                    │
│  └─ 打开界面：Windows 内嵌 WebView2            │
│                macOS/Linux 调起 Chrome          │
└───────────────┬──────────────────────────────┘
                │ 127.0.0.1:随机端口（HTTP + SSE）
┌───────────────▼──────────────────────────────┐
│ md-reader-core（Rust，8–10 MB）               │
│  路由 │ 索引(SQLite FTS5) │ 监听 │ 格式转换    │
└───────────────┬──────────────────────────────┘
                │ fs
        ┌───────▼────────┐
        │  书库目录        │
        └────────────────┘
```

**为什么内核仍然是一个本地 HTTP 服务，而不是直接做成 Tauri 的 IPC command**：

- 前端 7216 行、`fetch('/api/v1/...')` 遍布全项目，改 IPC 等于重写数据层；
- 保留 HTTP 后，**手机 / 平板浏览器访问同一套接口**（§3.3）成本几乎为零；
- 双栈期（Node 与 Rust 并存）可以用同一批 e2e 对两个实现跑，保证契约等价。

### 3.2 桌面端

| 平台 | 支持级别 | 界面承载 | 安装包 |
|---|---|---|---|
| Windows 10/11 x64 | **P0** | **内嵌 WebView2**（Chromium，系统自带） | NSIS，per-user（免 UAC） |
| macOS 13+（Apple Silicon / Intel） | **P0** | **调起 Chrome**（不内嵌 WKWebView） | dmg，自用不公证 |
| Linux（Ubuntu 22.04+ / Fedora 38+） | **P0** | **调起 Chrome / Chromium**（不内嵌 WebKitGTK） | AppImage + deb |

- **同一套 Chromium 语义**：三个平台的界面内核都是 Chromium，测试矩阵只有一套（Windows 的 WebView2 版本 ≈ 对应 Chrome 版本）。
- **找不到 Chrome / Chromium 时**（macOS / Linux）：壳弹出一次性提示「需要安装 Chrome 或 Chromium 才能显示界面」，给出下载链接，**不降级到 WebKit、不做兼容承诺**。
- **单实例**：第二次启动只唤起已有窗口（Windows）或已有标签页（macOS/Linux），不新起进程。
- **托盘**：打开书库 / 重新打开界面 / 开机自启 / 退出。

### 3.3 移动端（P1，只读）

不做原生 App。手机 / 平板通过浏览器访问同一台机器上的内核：

| 项 | 设计 |
|---|---|
| 可达性 | 内核监听 `0.0.0.0` **必须显式开启**，并强制 Bearer token（沿用 v3 §4.3 的 LAN 方案） |
| 浏览器 | **只支持 Chrome for Android**（Chromium 内核）；iOS 上的 Chrome 底层是 WebKit，**不支持** |
| 能力范围 | **只读**：书架、阅读、搜索、目录、批注**查看**；不提供编辑与批注创建 |
| 布局 | 单栏阅读、抽屉式目录、底部工具条；断点 768px |
| 认证 | 首次扫码或输入 `http://<ip>:<port>/?t=<token>`，token 存 localStorage |
| 不做 | 离线缓存、推送、后台同步、原生分享菜单 |

> 移动端**不是**「首屏体验」的验收对象：它的目标是「在沙发上看完刚才那篇」，不是取代桌面。反过来，正因为只支持 Chromium，移动端不需要任何额外的兼容工作 —— 同一份 CSS / JS。

### 3.4 端口与单实例

沿用 v3 §2.2：首次 `listen(0)` 随机，端口写入 `run.json` 后**粘性复用**（浏览器 origin 绑定 localStorage）。
v4 增加一条：Windows 内嵌模式下端口对用户不可见，也不出现在任何 UI 里；macOS/Linux 因为走浏览器，端口会出现在地址栏（这是「不内嵌」的可见代价）。

---

## 4. 技术架构

### 4.1 选型

| 层 | v3 | **v4** | 理由 | 放弃的 |
|---|---|---|---|---|
| 运行时 / 内核 | Node 24 | **Rust（edition 2021，MSRV 1.80）** | 三平台单文件 8–10 MB，无运行时依赖 | Node SEA（体积）、Go（SQLite/FTS5 与中文分词生态弱） |
| HTTP | Node `http` | **axum + tokio** | 生态成熟、SSE 支持好 | actix-web（编译慢） |
| 数据库 | `node:sqlite` | **rusqlite（bundled，开 FTS5）** | 静态链接 SQLite，无系统依赖 | sqlx（异步但编译期校验成本高） |
| 分词 | `Intl.Segmenter('zh')` | **jieba-rs + bigram 兜底** | 唯一可用的中文分词；bigram 兜底已有实现可移植 | 自研 HMM（成本不划算） |
| 文件监听 | `fs.watch` | **notify** | 跨平台封装，Linux inotify 也支持 | 轮询（CPU 与延迟都差） |
| 前端 | React 18 + Vite | **不变** | 零改动，最大杠杆 | 重写（无收益） |
| 渲染 | markdown-it | **不变（前端）** | 渲染在前端，跟内核语言无关 | — |
| 编辑 | CodeMirror 6 | **不变** | 同上 | — |
| 格式转换 | readability / mammoth / turndown | **readability-rs / docx-rs / htmd** | Rust 对位替代，见 §4.3 | 调用外部 CLI（分发负担） |
| 桌面壳 | Tauri（不内嵌） | **Tauri v2；仅 Windows 内嵌 WebView2** | 见 §0 | Electron |
| 打包 | SEA + UPX | **Tauri bundle（NSIS / dmg / AppImage）** | 一体化安装包 + 自动更新 | 手动 zip（无更新能力） |

**铁律（沿用 v3）**：不引入任何需要用户侧编译的原生模块。Rust 侧一律静态链接（`rusqlite` 用 `bundled` feature，SQLite 编进二进制）。

### 4.2 体积预算（硬约束）

| 组成 | 预算 | 说明 |
|---|---|---|
| `md-reader-core` 二进制 | **≤ 10 MB** | `opt-level="z"`、LTO、`strip`、`panic=abort`；SQLite 静态链接约占 1.5 MB |
| Tauri 壳 | ≤ 4 MB | 复用系统 WebView，不打包 Chromium |
| web 资源 | ≤ 2.5 MB | 现状 2.71 MB，见 §4.4 的削减项 |
| 安装包 | ≤ 12–15 MB | NSIS / dmg / AppImage 的 LZMA 压缩后 |

**对照**：v3 的 Node SEA 在 Windows 上是 22.7 MB（UPX 后），macOS arm64 基本压不动（同体积的 Mach-O，UPX 支持有限）。

### 4.3 依赖对位表（迁移清单）

| v3 依赖 | 用途 | Rust 对位 | 风险 |
|---|---|---|---|
| `node:sqlite` + FTS5 | 索引 | `rusqlite` + feature `bundled`,`functions` | 低 |
| `Intl.Segmenter('zh')` | 中文分词 | `jieba-rs` | **中**：切分结果不同，索引需重建，召回要重测 |
| `fs.watch({recursive})` | 增量索引 | `notify`（`RecommendedWatcher`） | 低（Linux 需 inotify 上限检查） |
| `yaml` | frontmatter 读写 | `serde_yaml` + 自写**局部行替换** | **中**：必须保住「保字节修改」语义，不能整段重新序列化 |
| `iconv-lite` | GBK/UTF-16 | `encoding_rs` | 低（Rust 这边更规范） |
| `@mozilla/readability` | 剪藏 / html 提取 | `readability-rs` | **高**：提取质量不如 Mozilla 原版 |
| `turndown` + gfm | HTML → MD | `htmd` 或自写规则 | **中**：表格/脚注行为差异 |
| `mammoth` | docx → HTML | `docx-rs`（或直接解 OOXML） | **高**：样式映射、表格、图片提取都要自己写 |
| `linkedom` | 无头 DOM | `scraper` / `html5ever` | 低 |
| Node `fetch` | 剪藏抓取 | `reqwest` | 低（注意 SSRF 防护要移植） |

> **三个高危项（readability / mammoth / 分词）必须有金标准回归集**：拿现在 Node 版对同一批输入（现成的 sample-library + 20 个真实网页 + 10 个 docx）产出 JSON 快照，Rust 版逐条比对，差异逐条裁决。

### 4.4 体积削减项（web 侧 2.71 → ≤2.5 MB）

| 项 | 现状 | 做法 | 预计 |
|---|---|---|---|
| `highlight-shiki` chunk | 1.21 MB | **语法包分两层**：内置 8 种（js / ts / json / bash / python / html / css / sql）+ 其余（markdown / yaml / diff / tsx / jsx / powershell）按需 `import()` 成独立 chunk | −300 KB 首屏 |
| `index.js`（React + CodeMirror） | 1.22 MB | CodeMirror 改为 `React.lazy` 分包（只在进入编辑态时加载） | 分包不减小总量，但改善首屏 |
| KaTeX 字体 | 0.25 MB（woff2） | 已只留 woff2；可评估「公式改为 SVG 内联」砍掉字体 | −250 KB（可选） |
| 主题 / 图标 | 少量 | 内联 SVG，不引图标库 | — |

> **Q5 已定**：体积优先级高于语法高亮语言数量。取舍顺序是「体积 > 语言覆盖」；上表的分层加载已经是对语言数量的让步上限 —— 如果再超预算，直接从内置 8 种里继续砍。

### 4.5 跨平台约束（沿用 v3 §4.2，新增三项）

| 约束 | 做法 |
|---|---|
| 路径即身份 | 禁止用路径当主键；库内只存 POSIX 相对路径 |
| Unicode | 比较前统一 NFC，只比较不改写 |
| 大小写 | 链接解析用 casefold；仅大小写重命名需两步 rename |
| 应用数据目录 | 统一走 `core/paths.rs`，业务代码禁止拼 `home_dir()` |
| **（新）Chromium 定位** | macOS/Linux 需探测 Chrome 路径（§6.1），找不到要明确提示，不能静默失败 |
| **（新）Linux 监听** | inotify watch 数量上限（默认 8192）需检测并提示 |
| **（新）Apple Silicon** | 通用二进制（`aarch64` + `x86_64`）会让 dmg 翻倍 → **只出 aarch64**；Intel Mac 走 Rosetta 2（Q3 已定） |

### 4.6 安全模型

沿用 v3 §4.3，全部移植：

- 默认只绑 `127.0.0.1`；`0.0.0.0` 必须显式开启且强制 token（移动端场景）。
- 变更请求：`POST/PATCH/DELETE` + `Content-Type: application/json` + `X-Reader-Client: 1`，跨源 `Origin` 一律 403。
- API 只收不透明 `docId`，服务端反查路径并校验仍在根目录内。
- 渲染层 HTML 白名单清洗（前端 sanitize，保持不变）。
- 新增：**剪藏的 SSRF 防护必须在 Rust 侧重写**（当前实现有逐跳重定向校验、私网段拦截，见 `clip/url.ts`），这是资产安全的关键。

### 4.7 工程结构（Cargo workspace）

放在 `packages/core/`，与现有 `packages/server`（Node，双栈期保留）并列：

```
packages/core/
├─ Cargo.toml                 # workspace
├─ rust-toolchain.toml        # channel = "stable"
├─ crates/
│  ├─ reader-core/            # lib：全部业务逻辑，可单测
│  │  └─ src/
│  │     ├─ lib.rs
│  │     ├─ error.rs          # AppError → {error:{code,message,detail}}
│  │     ├─ ulid.rs  hash.rs  encoding.rs  atomic.rs  paths.rs  config.rs
│  │     ├─ frontmatter/
│  │     │  ├─ mod.rs         # 只读解析（serde_yaml）
│  │     │  └─ patch.rs       # 局部行替换，保注释与键序
│  │     ├─ markdown.rs       # 标题 / [[链接]] / 摘要 / 字数
│  │     ├─ tokenizer.rs      # jieba-rs + bigram 兜底
│  │     ├─ db/
│  │     │  ├─ mod.rs         # 单连接 actor + 迁移
│  │     │  ├─ schema.sql
│  │     │  └─ queries.rs
│  │     ├─ indexer.rs  watcher.rs
│  │     ├─ library/
│  │     │  ├─ mod.rs         # 文档 CRUD / 状态 / 链接
│  │     │  ├─ annotations.rs
│  │     │  ├─ assets.rs
│  │     │  └─ parse.rs
│  │     ├─ adapt/
│  │     │  ├─ mod.rs         # kind 分派 + 内容哈希缓存
│  │     │  ├─ html.rs txt.rs sql.rs docx.rs
│  │     ├─ clip/
│  │     │  ├─ mod.rs         # 异步任务队列
│  │     │  ├─ fetch.rs       # reqwest + SSRF 防护
│  │     │  └─ extract.rs     # readability + htmd
│  │     └─ http/
│  │        ├─ mod.rs         # axum Router
│  │        ├─ routes/        # 按资源分文件，对齐 §7 的分组
│  │        ├─ security.rs    # X-Reader-Client / Origin / CSP
│  │        └─ sse.rs
│  └─ reader-cli/             # bin：md-reader-core
└─ tests/
   ├─ contract/               # 契约测试 fixture（见 §4.11）
   └─ golden/                 # 转换金标准快照（见 §4.3）
```

**为什么拆 lib + bin 而不是单 crate**：`reader-core` 能被集成测试直接当库调用（不起进程、不占端口），契约测试和金标准回归都在这一层做；`reader-cli` 只负责解析参数、拉配置、起 runtime。

### 4.8 模块映射（TS → Rust）

| 现文件 | 体量 | Rust 目标 | 迁移备注 |
|---|---|---|---|
| `index.ts` | 6 KB | `reader-cli/src/main.rs` | 参数解析、单实例、开浏览器 |
| `core/ulid.ts` | 1.7 KB | `ulid.rs` | 用 `ulid` crate；**必须保持 26 字符 Crockford base32 格式**，否则老书库 id 校验失败 |
| `core/hash.ts` | 0.4 KB | `hash.rs` | sha1 截断规则要一致（`assets` 文件名依赖它） |
| `core/encoding.ts` | 3.5 KB | `encoding.rs` | `encoding_rs` + 自写 BOM/UTF-16 启发式，探测顺序必须与 v3 一致 |
| `core/atomic.ts` | 2.3 KB | `atomic.rs` | tmp → fsync → rename，**目录与文件都要 fsync** |
| `core/paths.ts` | 3.3 KB | `paths.rs` | 三平台数据目录规则表 |
| `core/config.ts` | 5.8 KB | `config.rs` | 字段名与默认值逐字对齐（§4.10） |
| `core/frontmatter.ts` | 22 KB | `frontmatter/{mod,patch}.rs` | **最高风险**：解析用 serde_yaml，但写回必须走自己的行级 patch，禁止整体重新序列化 |
| `core/markdown.ts` | 3.5 KB | `markdown.rs` | 标题提取、`[[ ]]` 扫描、`stripFencedCode`、字数、摘要 |
| `core/tokenizer.ts` | 2.3 KB | `tokenizer.rs` | jieba 词典首次加载约 100 ms，进程内单例 |
| `store/db.ts` | 21 KB | `db/` | schema 与 v3 完全兼容（只加列，不改表） |
| `library/indexer.ts` | 6.5 KB | `indexer.rs` | 全量扫描 + 增量 + `resolveLinks` |
| `library/parse.ts` | 7 KB | `library/parse.rs` | 含 `parseDerivedDoc`（非 md 的合成记录） |
| `library/service.ts` | **44 KB** | `library/{mod,annotations,assets}.rs` | 最大的文件，按「文档 / 批注 / 资产 / 预览」四块拆 |
| `library/watcher.ts` | 4.6 KB | `watcher.rs` | `notify` 防抖 250 ms，目录增删走全量重扫 |
| `library/adapt.ts` | 16 KB | `adapt/` | 四个转换器 + 内容哈希缓存（LRU 24） |
| `library/clip/{extract,url}.ts` | 25 KB | `clip/{fetch,extract}.rs` | SSRF 防护、图片下载、canonical 去重 |
| `http/server.ts` | 21 KB | `http/` | 路由表 + 安全中间件 + 静态托管 |
| `http/sse.ts` | 1.4 KB | `http/sse.rs` | broadcast → SSE 帧 |
| `http/errors.ts` | 0.7 KB | `error.rs` | 错误码字符串必须逐字一致（前端按 code 分支） |

### 4.9 并发模型与状态

| 资源 | 做法 | 理由 |
|---|---|---|
| 运行时 | `tokio` multi-thread（默认工作线程 = CPU 核数） | axum 依赖 |
| SQLite | **单连接 + 专用线程（actor）**，所有查询经 `mpsc` 投递 | rusqlite 是同步 API；单写者避免 `database is locked`，也省掉每次 `spawn_blocking` 的开销 |
| 文档写 | 每文档一把 `tokio::sync::Mutex`，key 是 docId | 对应 v3 的 `withLock`，避免同文档并发保存互相覆盖 |
| 索引 | 单任务串行；watcher 事件 250 ms 合并后批量提交 | 索引是 CPU + IO 混合，并行收益低、冲突多 |
| 阻塞调用 | `spawn_blocking`：文件读写、docx/readability 转换、jieba 首次加载 | 不堵 runtime 线程 |
| SSE | `tokio::sync::broadcast(256)` | 一个事件多订阅者；慢消费者丢弃而不是阻塞 |
| 正文缓存 | 不常驻，LRU 3 篇（按 docId） | 与 v3 一致，控制内存 |
| 剪藏任务 | 进程内 `HashMap<jobId, Job>` + 30 分钟 GC，最多 50 条 | 与 v3 的行为一致 |

### 4.10 兼容性硬约束（配置与运行时文件）

双栈期最容易被忽略的是「配置文件不兼容」—— 一旦 `run.json` 的字段变了，端口粘性失效，用户所有 `localStorage`（主题、字号、布局）全部丢失。**必须逐字对齐**：

| 文件 | 字段 | 约束 |
|---|---|---|
| `run.json` | `pid` `port` `instanceId` `startedAt` `url` `libraryRoot` `version` | 名称、类型、语义完全一致；`instanceId` 用于单实例检测 |
| `config.json` | `libraryRoot` `theme` `accent` `density` `readerLayout` `fontSize` `lineHeight` `measureCh` `fontFamily` `autosave` `progressSync` `versionKeep` `lastDocId`… | 缺字段用 v3 的默认值；**不认识的字段要原样保留**（写回时不能丢） |
| `index.db` | §5.4 的表结构 | 只允许 `ALTER TABLE ADD COLUMN`；v3 的库能被 Rust 直接打开 |
| 数据目录 | Win `%APPDATA%\md-reader`　mac `~/Library/Application Support/md-reader`　Linux `~/.local/share/md-reader` | 路径规则与 v3 完全一致 |

### 4.11 契约测试与切换方案

**Fixture 格式**（`packages/core/tests/contract/*.json`）：

```json
{
  "name": "docs.list.all",
  "request": { "method": "GET", "path": "/api/v1/docs?status=all" },
  "expect": {
    "status": 200,
    "jsonPath": [
      { "path": "$[0].relPath", "op": "exists" },
      { "path": "$[0].kind",   "op": "equals", "value": "md" }
    ]
  }
}
```

**双跑 harness**（`scripts/contract.mjs`）：

1. 用同一份 `sample-library`，分别启动 Node 版与 Rust 版（不同端口、各自临时数据目录）；
2. 顺序重放 fixture；
3. 比对 `status` / 关键字段（**忽略**时间戳、端口、随机 id、mtime）；
4. 任一不等 → 打印 diff 并退出非零。

**切换顺序**（按风险从低到高，可随时回滚）：

| 阶段 | 端点 | 回滚方式 |
|---|---|---|
| 1 | `health`、`library*`、`docs` 列表、`docs/:id` 读、`search`、`tags`、`preview` | 启动参数 `--impl node` |
| 2 | `POST /docs`、`PATCH`、`move`、`DELETE` | 同上 |
| 3 | 批注增删改、`assets` 上传 | 同上 |
| 4 | `clip` + 图片下载 | 同上 |
| 5 | `events`（SSE） | 同上 |

**双栈期纪律**：双栈期间**只改 Rust，不改 Node 行为**（除非修 bug 且两边同步）。Node 实现保留到 M10 发布完成。

### 4.12 构建与体积控制

```toml
[profile.release]
opt-level = "z"      # 体积优先
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true
```

- **依赖白名单**：不允许引入需要 C++ 运行时或系统动态库的 crate。`rusqlite` 用 `bundled`（编 C，gcc 即可），**不用**系统 SQLite（否则各发行版版本不一）。
- **体积核对**：`cargo build --release && ls -lh target/release/md-reader-core`，目标 ≤ 10 MB；超了用 `cargo-bloat --release --crates` 定位。
- **构建环境**：Linux 在 WSL 里（gcc 已就绪，无需 root）；Windows 需 MSVC；macOS 走 CI。

### 4.13 开发环境（2026-11-06 已就绪）

| 环境 | 状态 | 说明 |
|---|---|---|
| **WSL2 · Arch Linux** | ✅ 主开发环境 | `gcc / g++ / make / git / node 26 / pnpm 12 / python3 / sqlite3` 全在；rustup 用户级安装 **rustc 1.99.1 / cargo 1.99.1** |
| 构建目录 | ✅ ext4 | `~/.cargo/config.toml` 里 `build.target-dir = ~/target`；源码仍在 `/mnt/d/something/md-reader` |
| 磁盘 | ✅ 不占 C 盘 | WSL 虚拟磁盘在 `D:\WSL\ArchLinux\ext4.vhdx` |
| 冒烟验证 | ✅ | `rusqlite` + `bundled` 编出 SQLite **3.54.1**，FTS5 建表与中文读写通过 |
| 端口连通 | ✅ | WSL 内起的服务，Windows 侧 Chrome 可直接访问 `127.0.0.1:<port>` |
| Windows 原生构建 | ⛔ 缺 MSVC | 当前账号非管理员，装不了 VS Build Tools；需要时走管理员或 CI |
| macOS 构建 | ⛔ | 无 Mac，走 GitHub Actions 的 macOS runner |

**日常命令**：

```powershell
wsl -d archlinux                       # 进 WSL（交互 shell，cargo 已在 PATH）
cd /mnt/d/something/md-reader
cargo build / cargo test               # 产物落 ~/target（ext4）
```

> **踩坑记录**：这台的 `~/.bashrc` 顶部有 `[[ $- != *i* ]] && return`，非交互 shell 会直接返回。脚本里调用 cargo 时要用 `bash -lc`，或在脚本开头显式 `export PATH="$HOME/.cargo/bin:$PATH"`，否则报 `cargo: command not found`。

### 4.14 关键数据流（含失败分支）

**打开文档** `GET /api/v1/docs/:id`

```
DB 查 rel_path
 ├─ 无记录 → 404 not-found
 └─ 有 → 读盘（ENOENT → 删 DB 记录 + 404）
      → 探测编码（BOM → UTF-8 → UTF-16 启发 → GB18030）
      → kind=md  : parseLayout（frontmatter + body）
        kind≠md  : adapt 转换（内容哈希命中缓存则复用，否则转换并写缓存）
      → 组装：headings / links / backlinks / annotations / source
      → 若 hash 或 title 与 DB 不一致 → 就地重索引（自愈）
      → 200 { body, links, backlinks, headings, annotations, ... }
```

**保存文档** `PATCH /api/v1/docs/:id`

```
安全中间件（§4.15）
 → 拿 per-doc 异步锁（同文档串行）
 → 读盘算 hash
    ├─ 与 baseHash 不等 → 409 { current:{hash, mtime, body} }   ← 绝不覆盖
    └─ 相等 → 解析 layout
         → 只重写 reader: / source: 两个块（行级 patch，§4.18）
         → 原子写 tmp → fsync → rename
         → 快照 versions/<docId>/<ts>.md（保留 20）
         → 更新 DB + 重建 links
         → resolveLinks → SSE doc-changed
         → 200 { hash, mtime }
```

**全量索引**（启动 / 手动重建）

```
walk（跳过点目录、.trash、assets）
 → 逐文件 stat：mtime+size 与 DB 相同 → 跳过
 → 解析 → upsert docs + docs_fts + links + annotations_mirror
 → 遍历完：staleDocs(existing) 删除磁盘上已不存在的记录
 → resolveLinks（全库重算）
 → 写 meta.lastIndexedAt → SSE index-progress(done)
```

**增量监听**

```
notify 事件 → 250ms 防抖合并
 ├─ 路径被忽略（点文件 / .trash / 临时后缀）→ 丢弃
 ├─ 目录事件（无扩展名）→ 全量重扫
 └─ 文件事件 → indexFile（mtime/size 未变则跳过）→ SSE doc-changed / doc-removed
```

**剪藏任务状态机**

```
queued → fetching → extracting → [duplicate] → images → saving → done
                                              └──────────────→ error
```

每个状态推进都 `broadcast('clip-progress')`，同时写入 `jobs` 表供轮询（`GET /clip/:jobId`）。任务 30 分钟过期，最多保留 50 条。

### 4.15 HTTP 层设计

**中间件顺序**（顺序即安全语义，不可调换）：

| # | 中间件 | 行为 |
|---|---|---|
| 1 | 绑定校验 | 非 loopback 且未开 `--host` → 直接拒绝连接 |
| 2 | 体积限制 | 请求体 > 32 MB → 413（图片上传走单独限额） |
| 3 | Origin 校验 | 带 `Origin` 且不等于自身 origin → 403 |
| 4 | 变更请求校验 | `POST/PATCH/DELETE` 必须 `X-Reader-Client: 1` + `application/json`（图片上传豁免 content-type） |
| 5 | 路由分发 | axum `Router`，按资源分组 |
| 6 | 错误映射 | `AppError` → `{error:{code,message,detail}}` + 状态码 |
| 7 | 静态兜底 | 非 `/api/*` → `web/` 目录；未知路径回落 `index.html` |

**路由分组**（与 §7 一一对应）：

```
/api/v1
├─ health
├─ library/{,stats,dirs,open,rescan}
├─ docs/{, :id, :id/status, :id/move, :id/annotations…, :id/backlinks, :id/links, :id/mentions, :id/convert, :id/export, :id/compat}
├─ search  tags  preview
├─ assets  files
├─ clip/{, :jobId}
└─ events              # SSE
```

**SSE 帧格式**（必须与 v3 逐字一致，前端按事件名分支）：

```
event: doc-changed
data: {"id":"01J…","relPath":"a.md","origin":"save"}

: ping            ← 每 15s 心跳，防止代理断流
```

**CSP**（沿用 v3）：`script-src 'self' 'wasm-unsafe-eval'`、`img-src 'self' data: blob: https:`、`object-src 'none'`、`base-uri 'none'`。

### 4.16 索引库 DDL（v4 目标态）

```sql
CREATE TABLE docs (
  id           TEXT PRIMARY KEY,
  rel_path     TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'md',   -- md|txt|sql|html|docx
  meta_path    TEXT,                          -- 非 md 的 sidecar 相对路径
  mtime        INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  hash         TEXT NOT NULL,
  title        TEXT NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  aliases      TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'unread',
  progress     REAL NOT NULL DEFAULT 0,
  words        INTEGER NOT NULL DEFAULT 0,
  excerpt      TEXT NOT NULL DEFAULT '',
  source_url   TEXT,
  encoding     TEXT NOT NULL DEFAULT 'utf8',
  eol          TEXT NOT NULL DEFAULT '\n',
  created      TEXT,
  indexed_at   INTEGER NOT NULL,
  ann_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX docs_status ON docs(status);
CREATE INDEX docs_mtime  ON docs(mtime);
CREATE INDEX docs_kind   ON docs(kind);

CREATE VIRTUAL TABLE docs_fts USING fts5(
  doc_id UNINDEXED, rel_path, title_tokens, body_tokens,
  tags_tokens, notes_tokens, bigrams, tokenize = 'unicode61'
);

CREATE TABLE links (
  src_id TEXT NOT NULL, dst_id TEXT, dst_raw TEXT NOT NULL,
  dst_anchor TEXT, kind TEXT NOT NULL DEFAULT 'wiki'
);
CREATE INDEX links_src ON links(src_id);
CREATE INDEX links_dst ON links(dst_id);

CREATE TABLE annotations_mirror (
  id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, exact TEXT NOT NULL,
  note TEXT, color TEXT, created INTEGER
);
CREATE INDEX ann_doc ON annotations_mirror(doc_id);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

**迁移策略**：v3 的库只有 `docs_fts` 6 列、无 `kind`/`meta_path`。用 `PRAGMA user_version` 判定，执行 `ALTER TABLE ADD COLUMN` + 重建 FTS 表（FTS 不能 ALTER，只能 DROP 后重建再灌数据）。**不做整体重建**——3000 篇重灌要 20 秒，而这个迁移只发生一次，可接受。

### 4.17 搜索实现

**写入**（索引期）：

1. `jieba::cut(text, false)` → 去重 → 空格拼接为 `body_tokens`
2. 同时生成 CJK bigram 串写入 `bigrams`（兜底）
3. 标题+别名写 `title_tokens`，标签写 `tags_tokens`，批注的 `note + exact` 写 `notes_tokens`

**查询**：

```sql
SELECT doc_id, bm25(docs_fts, 0, 0, 8.0, 1.0, 4.0, 2.0, 0.5) AS rank
FROM docs_fts WHERE docs_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?
```

列权重对应：`doc_id`(0) `rel_path`(0) **标题(8)** `正文(1)` **标签(4)** **批注(2)** bigram(0.5)。

- 主查询无结果 → 用 bigram 串再查一次（`"中文" AND "文检"`），解决分词切错导致的漏召回。
- 结果片段：在正文里定位首个命中，取前后各 60 字；非 md 用转换后的正文，不用原始文件。
- `matchStart/End` 只对 md 有意义（前端用它滚动定位）；非 md 返回 0。

### 4.18 frontmatter 局部改写算法

**这是整个迁移里最容易写出回归的地方**——直接 `serde_yaml::to_string` 整个结构，会丢掉注释、打乱键序、把用户手写的引号风格全改掉，git diff 会变成整文件重写。

实现必须走「行级 patch」，步骤：

1. 定位开头 `---` 与闭合 `---` 的行号（`parseLayout` 已有等价逻辑）。
2. 在区间内按行扫描，找到顶层键 `reader:` 与 `source:` 的**起始行**和**块范围**（到下一个顶格键为止，或到闭合围栏）。
3. 只序列化需要改的那一个键的值（生成新的 YAML 片段），然后把这几行**替换**掉；其余行逐字节保留。
4. 块不存在 → 在闭合围栏前插入新块；整个 frontmatter 不存在 → 在文件头插入 `---\n...\n---\n`。
5. 写回前校验：重新解析一遍，确认 `reader.id` 与预期一致、其它键的值未变。

**已知边界**（写进测试用例，不静默处理）：

| 场景 | 行为 |
|---|---|
| `reader: {id: x}` 内联写法 | 统一展开成块格式（这一处会丢该行的注释，可接受） |
| 用户自己写了 `reader:` 但结构不合法 | 不猜测，原样保留并跳过写入 + 记 warning |
| 文件本身没有 frontmatter | 头部插入，不动正文一个字节 |
| CRLF 文件 | 插入的片段也用 CRLF |

### 4.19 批注锚点重定位（Rust 落地要点）

四级顺序与 v3 完全一致，不能改：

1. `exact` 全文匹配，单命中即采用；
2. 多命中时用 `prefix`/`suffix` 做相似度打分，取最高；
3. 都失败 → 在 `pos ± 2000` 字符窗口内做模糊匹配（Levenshtein ≤ 20%，按字符而非字节，中文要按 `chars()` 迭代）；
4. 仍失败 → 标记 `orphaned`，进「已失效批注」分组，**绝不静默删除**。

性能约束：单篇 20 万字、500 条批注的重定位要在 300 ms 内完成（v3 实测 297 ms）。Rust 侧注意别在 `chars()` 上做 O(n²) 扫描。

### 4.20 测试分层

| 层 | 位置 | 覆盖 | 什么时候跑 |
|---|---|---|---|
| 单元 | `reader-core` 内 `#[cfg(test)]` | 编码探测、frontmatter patch、分词、markdown 解析、四种格式转换 | 每次保存 |
| 契约 | `tests/contract/` + `scripts/contract.mjs` | Node 与 Rust 对同一请求返回等价（§4.11） | M7 起每个 PR |
| 金标准 | `tests/golden/` | docx / html / clip 的转换快照逐字比对 | M7.5 |
| e2e | 现有 `scripts/ui-flow.mjs`（CDP） | 编辑 → 自动保存 → 划线 → 状态切换 | M9 起 |
| 体积 | CI | 二进制 ≤10 MB、安装包 ≤15 MB | M10 |

> **测试数量基线**：v3 现有 61 个用例（服务端 34 + 前端 27）。迁移后服务端用例应**全部有对应用**，前端用例不动。

---

## 5. 数据模型

### 5.1 概念（v3 之上扩展）

```
Library（一个根目录 = 一个书库）
 ├─ Doc（一个文件：md / txt / sql / html / docx）
 │   ├─ 元数据（md: frontmatter；非 md: sidecar JSON）
 │   └─ 派生态（非 md：转换出来的 markdown，仅缓存）
 ├─ Link（由正文 [[...]] 推导）
 └─ Source（本地文件 / 网页剪藏）
```

### 5.2 文件内格式（不变）

`.md` 的 frontmatter 结构、写入规则、原子写、快照策略**完全沿用 v3 §3.2**，一个字都不改。这是「书库零迁移」的前提。

### 5.3 非 md 的元数据：sidecar JSON（D6）

非 md 文件没有 frontmatter，而 `index.db` 是可删可重建的缓存 —— 身份与批注不能只存在那里。

```
book/
 ├─ 季度回顾.docx
 └─ 季度回顾.docx.reader.json      ← sidecar，跟着文件走
```

```json
{
  "id": "01D5B401FD70FEB047A5875925",
  "status": "reading",
  "progress": 0.42,
  "annotations": [
    {
      "id": "a1",
      "exact": "索引是可删可重建的缓存",
      "prefix": "…",
      "suffix": "…",
      "pos": 1284,
      "color": "yellow",
      "note": "和后面的取舍呼应",
      "created": "2026-11-06T10:00:00+08:00"
    }
  ],
  "updated": "2026-11-06T10:00:00+08:00"
}
```

| 规则 | 说明 |
|---|---|
| 命名 | `<完整文件名>.reader.json`，与源文件同目录 |
| 只写自己的键 | 同 frontmatter 的命名空间隔离原则 |
| 原子写 | 同 `.tmp → fsync → rename` |
| 缺失即默认 | sidecar 不存在 = 未读、无批注；不报错 |
| 索引可重建 | 删掉 sidecar 只丢状态与批注，不影响读 |
| 同步 | 跟源文件一起被网盘同步，不单独配置 |

> `assets/` 里由转换产生的图片（html / docx）**属于缓存**，删掉后下次索引自动重建；用户主动粘贴的图片才是资产。区分方式：派生图片落在 `assets/<派生id>/`，粘贴图片落在 `assets/<docId>/`。

### 5.4 索引库（扩展一列）

```sql
-- v3 的表结构不变，新增 kind 与 sidecar 路径
ALTER TABLE docs ADD COLUMN kind TEXT NOT NULL DEFAULT 'md';      -- md|txt|sql|html|docx
ALTER TABLE docs ADD COLUMN meta_path TEXT;                       -- sidecar 相对路径（非 md）
```

`kind` 仍然可以从扩展名推导，但落库后查询与筛选更快（「只看 Word」这种需求）。

### 5.5 目录布局

书库与数据目录沿用 v3 §3.4。新增两项：

```
书库根/
 ├─ *.md  *.txt  *.sql  *.html  *.docx
 ├─ *.reader.json              # sidecar（新增）
 ├─ assets/<id>/               # 粘贴与派生图片
 └─ .trash/

应用数据目录（不进书库）
 ├─ run.json  config.json
 ├─ index.db
 └─ versions/<docId>/<ts>.md
```

---

## 6. 功能规格

### 6.1 界面内核承诺（本版收紧）

**只承诺 Chromium 内核**，不做 WebKit 兼容。落地方式按平台不同：

| 平台 | 承载 | 版本要求 | 不满足时 |
|---|---|---|---|
| Windows | 内嵌 WebView2 | Chromium ≥ 120（与 v3 的 Chrome 120+ 对齐） | 安装包内置 Evergreen 引导器（约 +2 MB，仅旧系统触发） |
| macOS | 调起 Chrome | Chrome ≥ 120 | 提示安装，不降级到 Safari |
| Linux | 调起 Chrome / Chromium | ≥ 120 | 提示安装，不降级到 WebKitGTK |
| Android | Chrome for Android | ≥ 120 | 提示升级 |
| iOS | — | — | **不支持**（Chrome on iOS 底层仍是 WebKit） |

**启动时的 Chromium 定位**（壳负责）：

1. Windows：读注册表 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-…}` 拿 WebView2 版本；缺失则跑引导器。
2. macOS：`/Applications/Google Chrome.app`，其次 `~/Applications`，再 `mdfind`。
3. Linux：`google-chrome`、`google-chrome-stable`、`chromium`、`chromium-browser`，按 PATH 顺序探测。
4. 都找不到 → 一次性弹窗说明 + 打开下载页；**不尝试用默认浏览器打开**（那会是 WebKit 或 Firefox，体验不可控）。

**收益**：`color-mix()`、`:has()`、Popover、`inert`、`Intl.Segmenter` 全部可以直接用，测试矩阵只有一套。v3 的「Chrome 120+ 唯一目标」原样保留。

**验收**：Windows 内嵌窗口 + macOS/Linux 的 Chrome，各跑一遍 `scripts/ui-flow.mjs` 的等价流程（编辑 → 自动保存 → 划线 → 状态切换），控制台零错误。

### 6.2 编辑体验（本版重点）

#### 6.2.1 统一编辑器

`.md` / `.txt` / `.sql` 共用同一套 CodeMirror，按 `kind` 切换：

| kind | 语法模式 | 装饰 | 保存 |
|---|---|---|---|
| `md` | markdown + Live Preview | 标题变大、标记隐藏、图片内联、`[[ ]]` 补全 | `PATCH` 写回原文件 |
| `txt` | plaintext（可选 soft wrap 指示） | 无 | 写回原文件，**保持原编码与 EOL** |
| `sql` | sql 高亮 + 括号匹配 | 行号常显、语句折叠 | 写回原文件 |

#### 6.2.2 保存体验（四项改进）

1. **自动保存的可见性**：编辑态顶栏常驻「未保存 / 保存中 / 已保存 / 失败」，失败必须可重试，绝不静默。
2. **冲突处理升级**：目前是「手动合并面板」，v4 改为**逐行 diff3**（三栏：磁盘版 / 我的版 / 可编辑结果），最小冲突单元到行。
3. **保存前后光标与滚动不跳**：保存不重建编辑器实例（当前已做到，迁移时不能丢）。
4. **大文件**：> 20 万字符时编辑器改为**分块加载**（首屏 5 万字符，滚动到底部再加载下一段），`Ctrl+F` 走全文索引而非 DOM。

#### 6.2.3 docx 的边界（D5）

**不做原地编辑**。理由：OOXML 的段落/样式/编号是树形语义，把 markdown 变更映射回 docx 必然破坏格式；「看起来能改」但存出来变样的产品比「明确只读」更糟。

提供三条替代路径：

| 路径 | 行为 |
|---|---|
| **在 Word 中打开** | 调系统关联程序打开原文件；保存后应用检测到 mtime 变化 → 自动重转 + 批注重锚定 |
| **转为 Markdown 副本** | 生成 `同名.md`（放在同目录或 `Inbox/`），之后按 md 正常编辑；原 docx 保留 |
| **批注** | 在 docx 的渲染视图上划线，批注写进 sidecar；docx 变了之后按 v3 的四级锚点重定位，失败进 orphaned |

#### 6.2.4 快捷键（跨端一致）

沿用 v3 §5.3.5。新增：

| 键 | 作用 |
|---|---|
| `Ctrl/Cmd+Shift+E` | 切换「内嵌窗口 / Chrome」 |
| `Ctrl/Cmd+P` | 切换当前文档的「阅读 / 编辑 / 沉浸」 |
| `Ctrl/Cmd+Shift+S` | 另存为 md 副本（docx / html 可用） |

### 6.3 多格式支持矩阵（v4 目标态）

| 格式 | 浏览 | 搜索 | 入链 | 出链 | 目录 | 编辑 | 批注 |
|---|---|---|---|---|---|---|---|
| `.md` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `.txt` | ✅ | ✅ | ✅ | ✅ | 有 `#` 才有 | **✅（新增）** | ✅ |
| `.sql` | ✅ 高亮 | ✅ | ✅ | ✅ 注释里 | ⛔ | **✅（新增）** | ✅ |
| `.html` | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ |
| `.docx` | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔（另存 md） | **✅（新增）** |

### 6.4 多设备一致性

| 项 | 策略 |
|---|---|
| 身份 | md 用 frontmatter 的 ULID；非 md 用 sidecar 的 id；两者都在文件侧，不依赖 DB |
| 冲突 | 同一文档两台机器同时写 → 各自保留，靠网盘的「冲突副本」+ 应用内检测提示 |
| 进度 | `reader.progress` 默认写本机；开启「同步进度」后写文件（两设备会来回覆盖，需接受） |
| 阅读位置 | 不做跨端同步（成本高、收益低） |

### 6.5 保留的既有能力（不得回退）

书架四视图、批量操作、TOC 高亮、沉浸 / 专注布局、文内查找、图片灯箱、代码高亮、KaTeX、脚注、任务列表、三主题六强调色、Unlinked Mentions、断链检测、剪藏去重与图片本地化。

---

## 7. API 契约

**保持 `/api/v1` 不变**（前端零改动），新增三个端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/docs/:id/compat` | 返回该文档的能力位 `{editable, annotatable, canConvertToMd}`，前端据此渲染按钮 |
| POST | `/docs/:id/convert` | `{format:"md"}` → 生成 md 副本，返回新 docId |
| GET | `/docs/:id/export` | `{format:"md"}` → 导出（浏览器下载） |

其余端点、错误体、`baseHash` 冲突协议、SSE 事件（`index-progress` / `doc-changed` / `doc-removed` / `clip-progress`）全部沿用 v3 §6。

**双栈期契约测试**：`packages/server/test/contract/` 下维护一份 JSON 用例集（请求 + 期望响应形态），Node 实现与 Rust 实现各跑一遍，diff 结果必须为空。

---

## 8. 非功能需求

| 指标 | v3 目标 | **v4 目标** | 备注 |
|---|---|---|---|
| 安装包体积 | — | **≤ 12 MB（Win）/ 14 MB（mac）/ 15 MB（Linux）** | 硬指标 |
| 安装后占用 | — | **≤ 20 MB** | 不含书库 |
| 冷启动到可交互 | < 1.5s | **< 1.2s** | Rust 内核无 VM 预热 |
| 打开文档 | < 150ms | **< 120ms** | 5 万字 |
| 搜索首次响应 | < 50ms | **< 40ms** | |
| 保存写回 | < 50ms | **< 40ms** | 含快照 |
| 内存 | < 300MB | **< 250MB** | |
| 3000 篇冷索引 | < 30s | **< 25s** | Rust + jieba 应更快 |
| 移动端首屏 | — | **< 2s（同一 LAN）** | 只读 |
| 崩溃恢复 | 不留半截文件 | 同 | 原子写语义必须移植 |

---

## 9. 里程碑

| 阶段 | 内容 | 验收标准 | 预估 |
|---|---|---|---|
| **M7 内核迁移**（本版主干） | Rust 骨架 + axum + rusqlite(FTS5) + notify + frontmatter 保字节读写；跑通契约测试 | Node 与 Rust 对同一批请求返回 **JSON 等价**；61 个用例里服务端部分全绿 | 2–3 周 |
| **M7.5 高危项对齐** | jieba 分词、docx 转换、readability 三个金标准回归集 | 分词召回率不低于 Node 版 95%；docx 样本 10/10 结构一致；剪藏 20 站点成功率 ≥ 85% | 1.5 周 |
| **M8 多端壳** | Tauri v2：Win/mac/Linux 打包、托盘、单实例、自启；**Windows 内嵌 WebView2，macOS/Linux 探测并调起 Chrome** | 三平台各装一次，双击 → 书架 ≤ 1.5s；Chrome 缺失时有明确提示 | 1.5 周 |
| **M9 编辑体验** | txt/sql 可编辑、diff3 冲突、大文件分块、docx 的三条替代路径 | txt/sql 改完保存后编码/EOL 不变；20 万字 md 可编辑不卡 | 2 周 |
| **M10 体积与发布** | 体积达标、自动更新、崩溃恢复、首次启动引导、文档 | 三平台安装包达标；连续使用一周不崩 | 1.5 周 |
| **M11 移动只读**（P1，**可砍**） | LAN + token、响应式阅读页、批注查看 | 手机 Chrome 能读、能搜、能看批注 | 1 周 |

> 顺序理由：**先内核后壳**。壳可以先在 Node 上验证过（v3 的 sidecar 已经跑通），但体积只有在换内核后才有意义；反过来做会白做一遍打包。

> **Q6 已定：双栈期上限 4 周**。从 M7 开工算起，4 周内 M7+M7.5 必须让 Rust 实现接过全部流量；超时则**直接砍掉 M11**，把移动端留到 v4.1，不允许为了补齐功能而延长双栈期 —— 两套实现并存越久，契约漂移的风险越大。

---

## 10. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| **Rust 重写周期失控**（5383 行 + 7 个依赖对位） | 交付延期 | 按「读写 → 索引 → 转换 → 剪藏」四段切片，每段独立可验证；双栈期长一点没关系，功能不能回退 |
| **中文分词质量下降**（jieba vs Intl.Segmenter） | 搜索召回变差 | bigram 兜底保留；建立 50 条真实查询的召回基线，低于 95% 不合并 |
| **docx 转换质量下降**（docx-rs vs mammoth） | 用户看到的 Word 变丑 | 用现在 mammoth 的输出做金标准，10 个样本逐条比对；不达标就保留 mammoth 的 Node 侧车（体积 +1.7 MB，可接受） |
| **目标机器没有 Chrome / Chromium**（macOS、Linux） | 应用装好了但打不开界面 | 安装时检测并提示；壳首次启动弹一次说明 + 下载页；文档 FAQ 写明这是硬依赖 |
| **WebView2 缺失**（旧 Win10 LTSC） | Windows 端白屏 | 安装包内置 Evergreen 引导器；启动时读注册表校验版本，低于 120 直接引导安装 |
| **UPX 时代的体积惯性** | 误判目标 | 体积以安装包为准，不以 exe 为准 |
| **文件格式漂移** | 老书库打不开 | 书库格式冻结（§5.2）；任何新增字段都是可选、且只写在自己的命名空间 |
| **双栈期数据不一致** | 两个实现写的索引不同 | 索引是缓存，可重建；契约测试保证 API 等价 |
| macOS 公证 / Windows 签名 | 分发受阻 | 自用先关 Gatekeeper / SmartScreen；对外分发再买证书（本版不做） |

---

## 11. 决策记录（本版已全部定稿）

> 六项原「待确认」已于 2026-11-06 全部拍板。实现时按「结论」列执行，不再回问。

| # | 问题 | **结论** | 落到哪 |
|---|---|---|---|
| Q1 | 内嵌 WebView 还是唤起 Chrome？ | **界面只承诺 Chromium 内核**。Windows 内嵌 WebView2（本身就是 Chromium，零内核差异）；macOS / Linux **不内嵌**（WKWebView、WebKitGTK 一律不碰），直接调 Chrome / Chromium；iOS 不支持 | D2、§3.2、§6.1、M8 |
| Q2 | docx 要不要做原地编辑？ | **不做**。只做「sidecar 批注 + 转 md 副本 + 用 Word 打开」三条路。理由：OOXML 是树形语义，markdown 变更映射回去必然破坏格式 | D5、§5.3、§6.2.3 |
| Q3 | macOS 出不出通用二进制？ | **不出**。只发 aarch64，Intel Mac 走 Rosetta 2 —— 通用二进制会让 dmg 直接翻倍 | §4.5 |
| Q4 | 手机端做到什么程度？ | **只读，且只支持 Chrome for Android**。不做原生 App、不做 iOS、不做离线缓存 | D3、§3.3、M11 |
| Q5 | 体积 vs 语法高亮语言数量，谁优先？ | **体积优先**。语法包分两层：内置 8 种，其余按需 chunk；再超预算就继续砍内置列表 | §4.4 |
| Q6 | 双栈期（Node 与 Rust 并存）多久？ | **上限 4 周**。超时直接砍 M11，不延长双栈期 —— 两套实现并存越久，契约漂移风险越大 | §9 |

**由 Q1–Q6 直接推导出的三条硬约束**（实现时不得违反）：

1. macOS / Linux 的壳**没有窗口**，只做托盘 + 拉起内核 + 打开 Chrome；用户关掉浏览器应用仍在托盘里。
2. docx 的任何「编辑」入口都必须导向 §6.2.3 的三条路径，不允许出现第二种语义。
3. 语法高亮的新增语言请求，默认答复是「先看体积预算」。超出预算时，砍语言而不是砍功能。

---

## 12. 一页纸摘要

> **md-reader v4** 把 v3 的「Node 守护进程 + Chrome」换成「**Rust 内核 + Chromium 界面**」。
> 换内核只为一件事：**体积** —— 从每平台 22–90 MB 降到 **12–15 MB 安装包**，三平台一个样。
> 界面只承诺 Chromium：Windows 内嵌 WebView2（零内核差异，白拿窗口体验），macOS/Linux 直接调 Chrome，WebKit 一律不碰。
> 前端 7216 行原样复用，API 契约一个字不改，双栈期用契约测试保证等价；书库格式冻结，老书库零迁移。
> 多端：Windows / macOS / Linux 桌面为主，手机只支持 Chrome for Android 的只读浏览（LAN + token），iOS 不做。
> 编辑：`.md` `.txt` `.sql` 都能直接改，保编码保 EOL；**docx 明确只读**，给「批注 + 转 md 副本 + 用 Word 打开」三条路。
> 三个高危项（中文分词、docx 转换、网页提取）都先建金标准回归集，不达标不合并。
> 一句话：**同样的功能，四分之一的体积，三个系统都能装。**

---

## 13. 实现版本登记

> 规格基线仍为 **v4.0**；本节只登记实现/交付版本，不改变 §0 的决策。

| 实现版本 | 日期 | 变更 |
|---|---|---|
| **v4.1** | 2026-11-07 | Rust 内核落地：Node ↔ Rust 契约 **23/23**、转换金标准 **6/6**、分词召回 **98.01%**；txt/sql 可编辑（保编码保 EOL）、docx 批注/转 md/系统打开、三栏 diff3；LAN 移动只读（token 401/200 + 写 403）；Windows NSIS 与 Linux deb 经 CI 产出并安装验证 |
| **v4.2** | 2026-11-07 | 托盘升级为**单击展开概览**：统计/索引/最近 5 篇/工作区切换/打开方式（应用窗口 ↔ Chrome 标签）/视图（简洁 ↔ 完整）/打开、搜索、新建、设置、重新索引、退出；壳启动内核去黑框；关窗只销毁窗口、应用留托盘；应用改名 **enod** 并统一使用应用图标作为托盘图标；建立本地 Windows MSVC 构建链；Windows NSIS **enod_0.1.0_x64-setup.exe** 已产出并安装验证 |

### 13.1 当前交付状态

- Windows NSIS：已产出并完成安装/WebView2 实测（含 v3 索引迁移修复）。
- Linux deb：已产出并通过壳启动冒烟。
- macOS dmg：未产出，GitHub macOS runner 在 1 秒内被取消（无 runner 分配），需账号启用 macOS runner 或 self-hosted Mac。
- 当前 v4.2 Windows NSIS 已产出：`enod_0.1.0_x64-setup.exe`，**7,198,296 B（6.86 MiB）**，
  SHA-256 `5D541E17E17B4446ADD2AA4F8CFD40F4E5D0210516A6699A19E7EC1573C0A7EF`；
  已做静默安装、WebView2 启动、关窗留托盘、二次启动恢复验证。
- 应用显示名改为 **enod**；内核/壳可执行文件名与数据目录仍保留 `md-reader` 前缀，确保旧书库与配置零迁移。

### 13.2 验证基线

| 项 | 结果 |
|---|---|
| 契约测试 | 23/23 |
| 转换金标准 | 6/6 |
| 分词召回 | 98.01%（49 条查询） |
| 编辑/API 验收 | 20/20 |
| 浏览器 e2e | 12/12 |
| 托盘概览（v4.2） | 单击展开；工作区切换实测；打开方式/视图/搜索实测；无黑框；关窗后壳/内核存活 |
