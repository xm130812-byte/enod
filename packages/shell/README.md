# md-reader Tauri 壳（M8）

只做四件事：托盘、单实例、开机自启、把 Chromium 界面带出来。界面逻辑全在 web/core。

## 形态

| 平台 | 界面 | 说明 |
|---|---|---|
| Windows | 内嵌 WebView2 | `WebviewWindowBuilder`，零内核差异 |
| macOS | 调 Chrome | 不内嵌 WKWebView；找不到时提示安装 |
| Linux | 调 Chrome / Chromium | 不内嵌 WebKitGTK；按 PATH 探测 |

## 构建前置

- **Windows**：MSVC Build Tools（VS 2022 C++ 工作负载）+ WebView2 Runtime（系统一般自带）。
- **macOS**：Xcode Command Line Tools。
- **Linux**：`gtk3`、`webkit2gtk-4.1`、`libappindicator` 的开发包。
  这些是 **Tauri 壳本身的编译依赖**，不是界面内核；界面仍只承诺 Chromium。

本机（WSL Arch，无 root）实测：

```
pkg-config --libs --cflags gdk-3.0
→ Package 'gdk-3.0' was not found
cargo check → rc=101
```

Windows 侧账号非管理员、缺 MSVC；macOS 无机器。因此安装包尚未产出（详见
`docs/V4-STATUS.md` §5）。

## 构建步骤

```bash
# 1. 先出内核
cd packages/core && cargo build --release -p reader-cli

# 2. 复制成 Tauri sidecar（名字带 target triple）
TRIPLE=$(rustc -vV | sed -n 's/host: //p')
mkdir -p packages/shell/src-tauri/binaries
cp ~/target/release/md-reader-core \
   packages/shell/src-tauri/binaries/md-reader-core-$TRIPLE

# 3. 壳
cd packages/shell/src-tauri
cargo tauri build       # 或 CI: cargo build --release
```

产物：Windows NSIS（per-user）、macOS dmg（仅 aarch64）、Linux AppImage + deb。
`tauri.conf.json` 已声明 `externalBin: ["binaries/md-reader-core"]`，安装后内核与壳同目录；
`bundle.resources` 把 `packages/web/dist` 放到 `web/`，壳通过 `READER_WEB_DIST` 传给内核。

CI 已配置 `.github/workflows/v4-build.yml`：三平台 runner 上装依赖 → 构建 web/内核 →
`scripts/prepare-sidecar.mjs` → `cargo tauri build` → 上传安装包。本地无法编译，因此
首次 CI 运行可能需要按实际 `tauri` 小版本微调 tray/menu API。

## 行为

- 启动：拉起内核（`--no-open`），从 stdout 解析 `http://127.0.0.1:<port>`，再开界面。
- 单实例：第二次启动只唤起已有窗口/标签页。
- 托盘：打开书库 / 重新打开界面 / 开机自启 / 退出；退出时 kill 内核。
- 找不到 Chrome/Chromium：一次性说明 + 打开下载页，不降级 WebKit。

## 未验证

`main.rs` 按 Tauri v2 API 编写，但本机无法编译（缺 gdk-3.0 / MSVC）；
首次在 CI 上构建时可能需要按实际 `tauri` 小版本微调 menu/tray API。
