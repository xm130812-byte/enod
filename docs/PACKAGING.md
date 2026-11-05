# 打包验证（M1.5）

> 目标：尽早证伪交付链路。PRD 要求「双击安装包 → 托盘 → 自动打开 Chrome」。
> 本文件记录已经跑通的部分、当前阻塞项，以及继续做需要的工具链。

---

## 1. 当前结论

| 步骤 | 状态 | 产物 |
|---|---|---|
| Node SEA 单文件 sidecar | ✅ 已验证 | `dist/sea/md-reader.exe`（90.3 MB）+ `dist/sea/web/` |
| 便携启动 | ✅ | `dist/sea/md-reader.cmd`（双击启动 exe + 打开 Chrome） |
| Tauri 壳（托盘 + 安装包） | ⛔ 被工具链阻塞 | 本机无 Rust、无 MSVC Build Tools |

SEA 验证的是「sidecar 能不能独立跑」：不依赖系统 Node、内置 `node:sqlite`、静态托管前端、索引与搜索正常。

```powershell
node scripts/package-sea.mjs
# 只验证 sidecar 本身：
dist\sea\md-reader.exe --no-open --port 0 --data-dir dist\sea\testdata
# 或双击 dist\sea\md-reader.cmd（会打开 Chrome）
```

实测（2026-11-06，Windows 11 / Node 24.21）：

```text
exe pid=29172 port=65185
health: {"ok":true,"version":"0.1.0",...}
docs: 12
index: 200 len=872 hasRoot=True
search hits: 7
```

> 注意：Postject 注入后 Node 自带签名会失效（`warning: The signature seems corrupted!`），本地运行没问题；对外分发需要代码签名证书。

---

## 2. Tauri 壳为什么没做

Tauri 在 Windows 上必须用 **Rust + MSVC** 编译：

```
cargo/rustc        → 未安装（Get-Command cargo 为空）
cl.exe / link.exe  → 未安装（无 VS Build Tools，无 vswhere）
WebView2           → 已安装（156.0.4314.58）
```

安装 MSVC Build Tools 需要管理员权限、约 4–6 GB；Rust 工具链约 1–2 GB；Tauri 第一次构建还要下载 WebView2 等 crate。当前会话的审批提示被禁用，无法自动提权，所以这里停在「sidecar 已可用、壳未编译」。

---

## 3. 继续做的步骤

### 3.1 装工具链（需要管理员）

```powershell
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools `
  --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
rustup default stable-msvc
rustc --version
cargo --version
```

### 3.2 壳的行为（Rust 侧）

- 单实例：用 Tauri 单实例插件，第二次启动只唤起 Chrome。
- 托盘菜单：打开书库 / 重新打开浏览器 / 开机自启（注册表 Run 或 Startup 快捷方式）/ 退出。
- 启动 sidecar：`tauri_plugin_shell` 的 sidecar API 拉起 `md-reader.exe --no-open`，轮询 `%APPDATA%\md-reader\run.json` 拿端口。
- 唤起 Chrome：Windows `cmd /c start "" http://127.0.0.1:<port>`；macOS `open -a "Google Chrome"`；找不到 Chrome 时退回默认浏览器。
- 退出：结束 sidecar（发送 SIGTERM 等价操作），清理 `run.json`。
- 打包：Tauri `bundle.externalBin` 指向 `binaries/md-reader-<target-triple>.exe`；NSIS 安装包按用户安装（per-user，避免 UAC）。

### 3.3 需要提前确认的风险

| 风险 | 说明 |
|---|---|
| 构建体积 | Build Tools + Rust + Tauri 缓存 > 6 GB；首次构建 5–15 分钟 |
| 代码签名 | 未签名的 exe / 安装包会触发 SmartScreen；自用可关，分发需要证书 |
| 开机自启 | 需要写用户级注册表 Run，安装包/卸载时要能清理 |
| 端口 | 壳只读 `run.json`，不写死端口；sidecar 挂掉要能重启或提示 |
| macOS | 需要 `open -a` 与 notarization（自用可跳） |

---

## 4. 当前可交付的“便携版”

`dist/sea/` 目录可以直接拷走：

```
dist/sea/
├─ md-reader.exe      # 守护进程 + 前端资源定位
├─ md-reader.cmd      # 双击入口
└─ web/               # index.html + assets
```

没有托盘、没有安装包、没有开机自启；但「双击 → 打开 Chrome → 书架」这条主链路已经能跑。

下一步只差 Tauri 壳把「托盘 + 安装包 + 自启」补齐。
