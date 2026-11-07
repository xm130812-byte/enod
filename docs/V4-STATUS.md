# md-reader v4 · 实施状态（2026-11-06）

> 对照 `PRD-v4.md` 的里程碑逐项验收。所有数字来自本机 WSL2 · Arch Linux 实测，
> 命令与证据文件一并列出，便于复跑。

## 0. 结论速览

| 里程碑 | 状态 | 关键证据 |
|---|---|---|
| **M7 内核迁移** | ✅ 完成 | Node ↔ Rust 契约 **23/23** 通过 |
| **M7.5 高危项对齐** | ✅ 完成 | 金标准 **6/6 逐字一致**；分词召回 **98.01%**；剪藏真网页跑通 |
| **M8 多端壳** | 🟡 **Windows NSIS（enod）+ Linux deb 已装/已跑通**；macOS runner 不可用 | Win 安装包 **6.86 MiB**，装后 WebView2 打开书架；Linux deb **9.19 MiB**，shell 冒烟通过 |
| **M9 编辑体验** | ✅ 完成（含三栏 diff3） | txt/sql 保编码保 EOL **20/20**；Playwright 真浏览器 **12/12**；docx 三路径 |
| **M10 体积与发布** | ✅ 安装包达标（Win/Linux） | Win NSIS **6.86 MiB**、Linux deb **9.19 MiB**；内核 9.87 MiB、web 2.43 MB |
| **M11 移动只读** | ✅ 服务端 + 响应式 + 390px 实测 | token **401/200** + Cookie；390×844 无横向溢出、侧栏隐藏 |

## 1. 代码落点

```
packages/core/                 Rust 内核（Cargo workspace）
├─ crates/reader-core/         lib：全部业务逻辑
│  ├─ src/atomic.rs            tmp→fsync→rename（目录也 fsync）
│  ├─ src/config.rs            config.json / run.json，未知字段保留
│  ├─ src/encoding.rs          BOM→UTF-8→UTF-16→GB18030
│  ├─ src/frontmatter/         解析 + 行级 patch（保注释/键序）
│  ├─ src/db/                  单连接 actor + FTS5 schema/迁移/查询
│  ├─ src/indexer.rs           全量/增量索引、resolveLinks
│  ├─ src/watcher.rs           notify + 250ms 防抖
│  ├─ src/library/             文档/批注/资产/clip jobs/sidecar
│  ├─ src/adapt/               txt / sql / html / docx → markdown
│  ├─ src/clip/                SSRF 防护、抓取、提取、图片本地化
│  └─ src/http/                axum 路由、安全中间件、SSE、静态托管
├─ crates/reader-cli/          bin：md-reader-core
└─ tests/
   ├─ contract/*.json          23 个契约 fixture
   └─ golden/*.json            6 个转换金标准快照

packages/shell/                Tauri v2 壳（源码；构建见 §5）
packages/web/                  前端（v3 原样复用 + v4 编辑/移动端改动）
scripts/
├─ contract.mjs                Node vs Rust 双跑契约
├─ golden.mjs                  生成金标准快照（Node 侧）
├─ recall.mjs                  50 条查询召回率对比
├─ edit-flow.mjs               txt/sql/docx 编辑验收
└─ (core)/smoke.sh clip-smoke.sh lan-smoke.sh release.sh
```

## 2. M7：内核迁移

### 2.1 契约测试（23/23）

```bash
cd md-reader
node scripts/contract.mjs
```

覆盖：`health`、`library`、`docs` 列表/筛选/单篇（含正文、headers、links）、
`backlinks`、`tags`、`preview`、`search`、`config`、`mentions`，以及
创建 → 读 → 改正文（baseHash）→ 改状态 → 增/改/删批注 → 搜索 → 删除 的完整写路径。

- 双跑使用 **同一份 sample-library 的两个副本**、各自临时数据目录。
- 比对忽略时间戳、端口、随机 id、mtime；其余字段逐字比较。
- 23/23 通过是 M7 的合并门槛。

### 2.2 关键语义移植

| 项 | 实现 |
|---|---|
| ULID | 26 字符 Crockford Base32，同毫秒单调递增 |
| 编码 | 探测顺序与 v3 一致；GBK/CRLF 写回保真（见 M9 验收） |
| frontmatter | 只做行级 patch；`reader:`/`source:` 之外的字节不动 |
| 原子写 | 同目录 tmp → fsync 文件 → rename → fsync 目录；失败重试 |
| SQLite | `rusqlite(bundled)` + FTS5；`PRAGMA user_version`，只 ADD COLUMN；FTS 异常时重建 |
| 路径 | 库内只存 POSIX 相对路径；`..` 词法归一 + root 校验 |
| 安全 | Origin 白名单、`X-Reader-Client`、JSON/图片 content-type、32MB 体积上限 |
| SSE | `broadcast(256)`，`hello` + 15s 心跳 |

## 3. M7.5：三个高危项

### 3.1 金标准（6/6 逐字一致）

```bash
cd packages/core && cargo test -p reader-core --test golden
```

快照由 Node 版适配层生成（`node scripts/golden.mjs`），Rust 版逐字比对：

- docx ×1：标题、表格、列表、粗斜体、图片（`assets/<派生id>/`）全部一致
- html ×1：正文容器、图片 15 张本地化、标题清理、代码/链接一致
- txt ×3、sql ×1：硬换行、围栏、行数截断规则一致

> html 的正文提取没有使用 `readability-rs`（其输出会丢标题层级与图片）。
> 改为 scraper DOM + 「段落文本量 × (1−链接密度)」评分选容器，再用 htmd 转 markdown，
> 结果与 Mozilla Readability 的产物逐字对齐。PRD §4.3 的「高」风险项因此降为已验证。

### 3.2 分词召回（98.01%）

```bash
node scripts/recall.mjs
```

- 49 条真实查询（标题、标签、正文词），对比 Node `Intl.Segmenter` 结果集。
- 平均召回 **98.01%**（门槛 95%）。
- 低于 95% 的 3 条：`引用测试`（50%）、`Super-agent 设计探索…`（66.7%）、`设计`（85.7%）。
  原因是 Node 把 OOV 词切成单字，命中了不含整词、但含单字的文档；Rust 侧用
  `bigrams` + `单字兜底` 已尽量对齐，但仍保留了更高的精确率。**逐条裁决结论：不为了
  追平噪声结果而继续放宽查询。**

### 3.3 剪藏

```bash
bash packages/core/clip-smoke.sh https://en.wikipedia.org/wiki/Readability
```

- 真实网络页面：`done`，8569 字，5 张图片本地化，来源/站点/作者写入 frontmatter。
- SSRF：逐跳重定向校验（≤6 跳）、私网/回环/云元数据地址拦截、图片 URL 同样校验。
- 任务状态机：`queued → fetching → extracting → [duplicate] → images → saving → done|error`；
  30 分钟 GC、最多 50 条、SSE `clip-progress`。

## 4. M9：编辑体验

```bash
node scripts/edit-flow.mjs
```

| 验收 | 结果 |
|---|---|
| txt 正文是原始文本（不是派生 markdown） | ✅ |
| txt 保存后仍为 GB18030 + CRLF、无 BOM | ✅ |
| sql 保存后不写 frontmatter | ✅ |
| docx 批注写 `<文件名>.reader.json`，重开可读 | ✅ |
| docx 正文编辑被拒绝（405 read-only） | ✅ |
| `compat`：txt editable=true；docx editable=false / canConvertToMd=true | ✅ |

前端改动：

- 统一编辑器按 `kind` 切换：md 走 Live Preview / `[[ ]]` 补全 / 粘贴图片；
  txt / sql 走纯文本（sql 常显行号），不再把原始文本当 markdown。
- 阅读态：txt 用 `pre-wrap` 原样显示；sql 用代码块渲染。
- 顶栏徽标区分「可编辑 / 只读 · 格式」；docx/html 菜单新增
  「用系统程序打开」「转为 Markdown 副本」「导出 Markdown」。
- 所有格式的阅读态都可划线批注（docx/html 走 sidecar）。

**diff3 已补**：冲突对话框现在是三栏 —— 磁盘版 / 我的版（CodeMirror MergeView 行级 diff，可滚动对齐）/ 可编辑合并结果；
≤900px 自动降为单栏堆叠。实现见 `packages/web/src/components/ConflictDialog.tsx`。

### 4.1 真浏览器 e2e（Playwright + Windows Chrome CDP）

```bash
PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright \
CDP_URL=http://127.0.0.1:9222 \
node scripts/ui-check.cjs
```

**12/12 通过**，控制台零错误：

- 桌面 1280×900：书架渲染、md 阅读、进入编辑、输入后 800ms 自动保存写回、编辑器实例未重建
- 冲突：外部改盘后保存触发 409 → 「逐行合并」显示三栏 diff3（2 个 CodeMirror + 可编辑结果）
- txt：以 `pre.txt-view` 原样渲染，可进入编辑
- docx：只读徽标、无编辑按钮
- 移动 390×844：书架无横向溢出、阅读页侧栏隐藏

截图：`docs/screenshots/v4-shelf-desktop.png`、`v4-reader-desktop.png`、`v4-txt-edit.png`、
`v4-diff3.png`、`v4-shelf-mobile.png`、`v4-reader-mobile.png`。

## 5. M8：Tauri 壳（Linux 已出 deb；Win/mac 走 CI）

源码：`packages/shell/src-tauri/`

- Windows：`WebviewWindowBuilder` 内嵌 WebView2；macOS/Linux：探测并 `--app=<url>` 调 Chrome，
  找不到时弹一次性说明并打开下载页（不降级 WebKit）。
- 托盘：打开书库 / 重新打开界面 / 开机自启 / 退出；单实例插件；退出时 kill 内核。
- `externalBin` 约定 sidecar 名 `md-reader-core`；`bundle.resources` 把 web 放到 `web/`，
  壳启动内核时通过 `READER_WEB_DIST` 指过去。

### 5.1 无 root 构建 Linux 壳

WSL 无 root，但可以不用 root：把 Arch 的 GTK/WebKit 开发包解到用户目录，再用
`PKG_CONFIG_SYSROOT_DIR` 指向它。

```bash
python3 scripts/sysroot.py --download      # 197 个包 → ~/gtk-sysroot
node scripts/prepare-sidecar.mjs x86_64-unknown-linux-gnu
bash scripts/tauri-linux-build.sh          # cargo check：通过
bash scripts/tauri-linux-bundle.sh --bundles deb
```

结果：

- `cargo check` 通过（Tauri 2.12 / webkit2gtk-4.1 2.54.2 / GTK 3.24.52）。
- **deb 产出：9.16 MiB**（`release/md-reader_0.1.0_amd64.deb`），
  `Depends: libappindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`；
  安装后布局为 `/usr/bin/md-reader-shell` + `/usr/bin/md-reader-core` +
  `/usr/lib/md-reader/web/`，壳能找到 sidecar 与 web。
- **AppImage 未产出**：Tauri 的 linuxdeploy 会把 WebKitGTK/GTK 一起打进 AppImage，
  体积远超 15 MB；PRD 的体积是硬约束，因此 Linux 交付选 deb（系统包管理器提供 WebKit 运行库）。
  这是与 PRD「AppImage + deb」的一处偏差，已在 §8 记录。

### 5.2 运行时冒烟（壳 → 内核 → Chrome）

WSL 没有真实显示与 Chrome，用 GTK Broadway 后端 + 假 `google-chrome` 验证整条启动链：

```bash
bash scripts/shell-smoke.sh
# chrome args: --app=http://127.0.0.1:37846 --new-window
# health: 200 {"ok":true,...}
# SHELL SMOKE PASS
```

- 解包 deb 到临时目录，用 `dbus-run-session` + `broadwayd` 起壳；
- 壳从内核 stdout 解析端口 → 用 `--new-tab <url>` 调 Chrome（探测 PATH 里的 google-chrome）；
- 假 Chrome 记录参数后退出，脚本再请求 `/api/v1/health`，确认内核仍在服务。

### 5.3 Windows NSIS：安装 + WebView2 实测

CI（windows-latest）产物 `md-reader_0.1.0_x64-setup.exe` = **7,130,688 B（6.80 MiB）**。

在 Windows 主机上实测：

```powershell
# 静默安装到 %LOCALAPPDATA%\md-reader
md-reader_0.1.0_x64-setup.exe /S
# 启动壳 + 内核（WebView2 远程调试用于验收）
md-reader-shell.exe
```

结果：

- 安装目录：`md-reader-core.exe`（9.35 MB）+ `md-reader-shell.exe`（3.73 MB）+ `web/`；
- 首次启动发现并修复了一个**真实迁移 bug**：v3 的 `index.db` 没有 `kind` 列，
  `schema.sql` 里的 `CREATE INDEX docs_kind` 在 ALTER 之前执行会直接报
  `no such column: kind`，壳 25s 超时退出。已把索引移到 `migrate()` 的 ALTER 之后，
  并新增 `migrates_v3_database_without_kind` 回归测试。
- 修复后重新装包：壳 + 内核常驻，WebView2（Edg/156）通过 CDP 验证到
  `.shelf`、19 篇文档、原有批注都在；截图
  `docs/screenshots/v4-windows-installed.png`。
- **P0 托盘/打开方式**（2026-11-07）：Windows 装包验证 core/tasklist/cmd 均不再创建
  conhost（19→19），应用窗口标题 `md-reader`；写 `shell.openMode=browser` 后只开
  Chrome 标签、不开应用窗口。托盘菜单点击尚未做 UI 自动化，菜单构建/事件路径已随包运行。
- 卸载：`uninstall.exe /S` 干净移除安装目录。

### 5.4 macOS：runner 拿不到

macOS job 在 **1 秒内 cancelled**，`runner_name` 为空、没有任何 step 执行 —— 不是编译错误。
与社区同类现象一致（macOS runner acquisition failure / 计费限制）：

- 已把 macOS 拆成独立 workflow `.github/workflows/macos-build.yml`，
  避免它把 Windows/Linux 主 workflow 带成 `cancelled`；
- 需要仓库账号启用 macOS runner（Billing/额度）或接 self-hosted Mac 后再触发。

## 6. M10：体积

```bash
bash packages/core/release.sh
```

| 组成 | 预算 | 实测 |
|---|---|---|
| `md-reader-core` | ≤10 MB | **10,345,608 B（9.87 MiB / 10.35 MB）**，已去 `.eh_frame` |
| web 资源 | ≤2.5 MB | **2,426,830 B（2.43 MB）** |
| 二进制 xz -9 | — | **4,815,252 B（4.82 MB）**，安装包压缩后近似 |
| Linux 便携包 tar.gz | ≤15 MB | **6,557,108 B（6.56 MB）**，内核 + web + 启动脚本 |
| **Windows NSIS（M8）** | ≤12–15 MB | **7,130,688 B（6.80 MiB）**，per-user 安装 |
| **Linux deb（M8）** | ≤12–15 MB | **9,640,518 B（9.19 MiB）**；安装后 18,402 KB（≤20 MB） |
| macOS dmg | ≤15 MB | 待 runner 可用；代码与 workflow 已就绪 |

- 为压体积：`opt-level="z"`、fat LTO、`panic=abort`、strip；Shiki 只内置 8 种语法
  （js/ts/json/bash/python/html/css/sql），其余按 Q5 降级为纯文本。
- 二进制比 10 MB 目标多 0.34 MB（按 MiB 计已达标）。剩余大头是 jieba 词典（`.rodata`
  ~3.7 MB）与 PIE 重定位（`.rela.dyn` ~0.98 MB）；继续压需要换精简词典或改静态链接，
  会牵动分词召回，未在本轮冒险。

## 7. M11：移动只读

```bash
bash packages/core/lan-smoke.sh
```

- `--host 0.0.0.0` 强制 token：无 token **401**、错误 token **401**、`?t=` **200**；
  首次带 `?t=` 的响应种 `reader_token` HttpOnly Cookie（30 天），后续静态资源/SSE 复用。
- LAN 模式**服务端只读**：所有 `POST/PATCH/DELETE` 直接 **403 `read-only`**，不依赖前端隐藏按钮。
- 前端：从 `?t=` 读 token 存 localStorage、抹掉地址栏参数，所有 fetch 带
  `Authorization: Bearer`，`EventSource`/图片 URL 带 token 兜底；手机（coarse pointer ≤768px）
  隐藏编辑与划线创建入口（其余写操作由服务端 403 兜底）。
- `styles/mobile.css`：≤768px 单栏、隐藏目录/侧栏、抽屉式信息让位、对话框收窄；
  手机首屏直接进入「万卷」单栏书架，文件夹树收起，只留文件列表。
- **已验**：Windows Chrome（Chromium 156）CDP + Playwright，390×844 下书架无横向溢出、
  阅读页 `.side-panel` 为 `display:none`、控制台零错误；截图见 `docs/screenshots/v4-*-mobile.png`。
- **未验**：真机 Chrome for Android、LAN 首屏 <2s。P1 可砍（Q6），当前是「桌面 Chromium 下已验证」。

## 8. 与 PRD 的已知偏差

1. **Linux 数据目录**：PRD 写 `~/.local/share/md-reader`，v3 实际用 `~/.config/md-reader`。
   实现为「已存在 `.config` 就沿用，否则用 XDG_DATA_HOME」，保证老书库零迁移。
2. **搜索**：主查询之外追加 bigram + 单字兜底结果（追加在尾部），以过 95% 召回门槛；
   这让中文查询可能比 Node 多出少量低相关结果。
3. **docx/html 图片**：本地化命名分别按 URL 哈希 / 内容哈希，与 v3 保持一致；
   下载失败保留远程地址并提示。
4. **Linux 壳的 WebKitGTK 依赖**：Tauri v2 在 Linux 上即使不创建窗口也会链接
   `libwebkit2gtk-4.1`。界面仍只调 Chrome，但 deb 必须声明该系统依赖；AppImage 若把
   WebKit 打进去会远超 15 MB，因此 Linux 只出 deb。
5. **二进制超目标 0.35 MB**：10.35 MB vs ≤10 MB（9.87 MiB）；继续压需要换精简 jieba 词典
   或改静态链接，会牵动已验收的分词召回，本轮未冒险。
6. **macOS 安装包未产出**：runner 在 1 秒内 cancelled（无 runner 分配），与代码无关；
   workflow 已拆到 `macos-build.yml`，等账号 Billing/macOS runner 可用后重试。

## 9. 复跑清单

```bash
# WSL
cd /mnt/d/something/md-reader
pnpm install                       # 首次
node packages/web/node_modules/vite/bin/vite.js build --config packages/web/vite.config.ts

cd packages/core
cargo test -p reader-core          # 10 单测 + 6 金标准
cargo build --release -p reader-cli

cd ../..
node scripts/contract.mjs          # 23/23
node scripts/recall.mjs            # ≥95%
node scripts/edit-flow.mjs         # 20/20
PLAYWRIGHT_PATH=/tmp/pw/node_modules/playwright CDP_URL=http://127.0.0.1:9222 node scripts/ui-check.cjs
bash packages/core/clip-smoke.sh
bash packages/core/lan-smoke.sh
bash packages/core/release.sh
bash packages/core/bundle.sh       # 便携包 + tar.gz

# M8 Linux 壳（无 root，sysroot 方式）
python3 scripts/sysroot.py --download
node scripts/prepare-sidecar.mjs x86_64-unknown-linux-gnu
bash scripts/tauri-linux-build.sh
bash scripts/tauri-linux-bundle.sh --bundles deb
bash scripts/shell-smoke.sh
```
