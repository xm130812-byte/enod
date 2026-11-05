# 打包与体积（M1.5）

> 目标：尽早证伪交付链路。PRD 要求「双击安装包 → 托盘 → 自动打开 Chrome」。
> 本文件记录已经跑通的部分、体积优化、当前阻塞项，以及继续做需要的工具链。

---

## 1. 当前结论

| 步骤 | 状态 | 产物 |
|---|---|---|
| Node SEA 单文件 sidecar | ✅ 已验证 | `dist/sea/md-reader.exe`（UPX 后 22.4 MB）+ `dist/sea/web/`（4.2 MB） |
| 便携启动 | ✅ | `dist/sea/md-reader.cmd`（双击启动 exe + 打开 Chrome） |
| 发布目录合计 | ✅ | **26.6 MB**（压缩前 118 MB） |
| Tauri 壳（托盘 + 安装包） | ⛔ 被工具链阻塞 | 本机无 Rust、无 MSVC Build Tools |

SEA 验证的是「sidecar 能不能独立跑」：不依赖系统 Node、内置 `node:sqlite`、静态托管前端、索引与搜索正常。

```powershell
pnpm upx:fetch      # 可选：下载固定版本 UPX（不提交进仓库）
pnpm build
pnpm package
# 只验证 sidecar 本身：
dist\sea\md-reader.exe --no-open --port 0 --data-dir dist\sea\testdata
# 或双击 dist\sea\md-reader.cmd（会打开 Chrome）
```

实测（2026-11-06，Windows 11 / Node 24.21，UPX 压缩后）：

```text
health: ok=true
docs: 12
index: 200
search hits: 7
code blocks: 2 个带语言的代码块全部高亮，无控制台异常
```

> 注意：Postject 注入后 Node 自带签名会失效（`warning: The signature seems corrupted!`），本地运行没问题；对外分发需要代码签名证书。

---

## 2. 体积是怎么压下来的

### 2.1 exe：94.6 MB → 22.4 MB

SEA exe 的构成几乎是纯 Node 运行时：

```text
node.exe            93.6 MB
server bundle        0.9 MB
────────────────────────────
注入后              94.6 MB
```

所以优化只能针对 Node 本体。当前用 **UPX 4.2.4 + LZMA** 整包压缩：

```text
94,647,296 → 23,494,144   24.82%
```

- UPX 是启动时自解压，内存里恢复原镜像，SEA 的 `NODE_SEA_BLOB` 资源不受影响；
- 实测健康检查、静态页面、索引、搜索、代码高亮均正常；
- 代价：首次启动多一次解压（数百毫秒级）；未签名 + 加壳更容易被部分杀软误报；对外分发前建议签名并做一次 Defender 白名单验证。

脚本会自动找 `tools/upx/**/upx.exe`；也可以用 `UPX_BIN` 指定。想保留未压缩版本：

```powershell
$env:NO_UPX='1'; pnpm package
```

### 2.2 web：27.8 MB → 4.2 MB

| 项 | 压缩前 | 压缩后 | 做法 |
|---|---:|---:|---|
| sourcemap | 16.4 MB | 0 | 生产构建关闭（需要时 `SOURCE_MAP=1`） |
| JS | 10.3 MB / 303 chunk | 3.1 MB / 2 chunk | 只打包 19 种 Shiki 语法，按需加载 |
| 字体 / CSS | 1.1 MB | 1.1 MB | KaTeX 字体，保留 |

之前 `import('shiki')` 会把 Shiki 自带的 300 多种语言全部切成 chunk；现在 `shiki/core` + 显式语言包（ts/js/tsx/jsx/json/bash/powershell/python/rust/html/css/sql/markdown/yaml/diff/go/java/c/csharp），并且由 `highlight.ts` 动态 import，只有文章里出现代码块时才下载 2 MB 的 `highlight-shiki` chunk。

### 2.3 还能不能再小

| 方向 | 预估 | 代价 |
|---|---|---|
| 自定义 Node（去掉/换小 ICU） | exe ~15 MB | 要 MSVC + 编译 Node；中文分词依赖 ICU，需改回纯 bigram，搜索质量下降 |
| 换运行时（Bun / Deno 单文件） | 80–100 MB | 比现在大，且 `node:sqlite` 兼容性要重验 |
| 嵌入 web 到 exe + 只发单文件 | 24–25 MB 单文件 | 省掉 4 MB 目录，但静态资源要走 SEA assets，改动大 |
| 安装包 LZMA（NSIS/7z） | 下载 ~23 MB | 安装后仍占 26.6 MB；等 Tauri 壳一起做 |

当前 26.6 MB 已经接近「不重写运行时」的下限；再往下需要动 Node 构建或换语言重写服务端，不建议为体积牺牲中文搜索。

---

## 3. Tauri 壳为什么没做

Tauri 在 Windows 上必须用 **Rust + MSVC** 编译：

```
cargo/rustc        → 未安装（Get-Command cargo 为空）
cl.exe / link.exe  → 未安装（无 VS Build Tools，无 vswhere）
WebView2           → 已安装（156.0.4314.58）
```

安装 MSVC Build Tools 需要管理员权限、约 4–6 GB；Rust 工具链约 1–2 GB；Tauri 第一次构建还要下载 WebView2 等 crate。当前会话的审批提示被禁用，无法自动提权，所以这里停在「sidecar 已可用、壳未编译」。

---

## 4. 继续做的步骤

### 4.1 装工具链（需要管理员）

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
rustup default stable-msvc
rustc --version
cargo --version
```

### 4.2 壳的行为（Rust 侧）

- 单实例：用 Tauri 单实例插件，第二次启动只唤起 Chrome。
- 托盘菜单：打开书库 / 重新打开浏览器 / 开机自启（注册表 Run 或 Startup 快捷方式）/ 退出。
- 启动 sidecar：`tauri_plugin_shell` 的 sidecar API 拉起 `md-reader.exe --no-open`，轮询 `%APPDATA%\md-reader\run.json` 拿端口。
- 唤起 Chrome：Windows `cmd /c start "" http://127.0.0.1:<port>`；macOS `open -a "Google Chrome"`；找不到 Chrome 时退回默认浏览器。
- 退出：结束 sidecar（发送 SIGTERM 等价操作），清理 `run.json`。
- 打包：Tauri `bundle.externalBin` 指向 `binaries/md-reader-<target-triple>.exe`；NSIS 安装包按用户安装（per-user，避免 UAC）。

### 4.3 需要提前确认的风险

| 风险 | 说明 |
|---|---|
| 构建体积 | Build Tools + Rust + Tauri 缓存 > 6 GB；首次构建 5–15 分钟 |
| 代码签名 | 未签名的 exe / 安装包会触发 SmartScreen；自用可关，分发需要证书 |
| 开机自启 | 需要写用户级注册表 Run，安装包/卸载时要能清理 |
| 端口 | 壳只读 `run.json`，不写死端口；sidecar 挂掉要能重启或提示 |
| macOS | 需要 `open -a` 与 notarization（自用可跳） |

---

## 5. 当前可交付的“便携版”

`dist/sea/` 目录可以直接拷走（**26.6 MB**）：

```
dist/sea/
├─ md-reader.exe      # 守护进程 + 前端资源定位
├─ md-reader.cmd      # 双击入口
└─ web/               # index.html + assets
```

没有托盘、没有安装包、没有开机自启；但「双击 → 打开 Chrome → 书架」这条主链路已经能跑。

下一步只差 Tauri 壳把「托盘 + 安装包 + 自启」补齐。
