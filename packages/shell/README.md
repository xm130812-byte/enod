# md-reader Tauri 壳（M8）

只做四件事：托盘、单实例、开机自启、把 Chromium 界面带出来。界面逻辑全在 web/core。

## 形态

| 平台 | 默认界面 | 可切换 |
|---|---|---|
| Windows | 内嵌 WebView2 | Chrome 标签页 |
| macOS | Chrome 标签页 | — |
| Linux | Chrome / Chromium 标签页 | — |

打开方式存在 core `config.json` 的 `shell.openMode`（`window` / `browser`）；Windows 缺省
`window`，macOS/Linux 缺省 `browser`。托盘右键可随时切换并持久化。

## 构建前置

- **Windows**：MSVC Build Tools（VS 2022 C++ 工作负载）+ WebView2 Runtime（系统一般自带）。
- **macOS**：Xcode Command Line Tools。
- **Linux**：`gtk3`、`webkit2gtk-4.1`、`libappindicator` 的开发包。
  这些是 **Tauri 壳本身的编译依赖**，不是界面内核；界面仍只承诺 Chromium。

WSL 无 root 时可用 `scripts/sysroot.py` 建 rootless sysroot；本机已用这套方式编译通过。

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

- 启动：拉起内核（`--no-open`，Windows 用 `CREATE_NO_WINDOW` 隐藏黑框），从 stdout 解析
  `http://127.0.0.1:<port>`，再按默认打开方式开界面。
- 托盘：打开界面 / 默认打开方式（应用窗口、Chrome 标签页）/ 开机自启 / 退出；退出时 kill 内核。
- 左键托盘：按当前默认方式打开。
- 单实例：第二次启动按默认方式唤起窗口或标签页。
- 浏览器模式用 `--new-tab <url>`；找不到 Chrome/Chromium 时退回默认浏览器。

## 验证状态

- Linux：`cargo check` 通过；deb 构建通过；`scripts/shell-smoke.sh` 验证
  `--new-tab http://127.0.0.1:…` + health 200。
- Windows：CI 出 NSIS；待装包验证无黑框与两种打开方式切换。
