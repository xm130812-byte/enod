# md-reader v4 · 后续实施计划手册

> 状态：WSL 主副本已建立；本手册记录环境、已完成准备项、托盘/打开方式的分阶段实现与验收。
> 主副本：`/home/xm130812/md-reader`（ext4）  
> Windows 镜像：`D:\something\md-reader`（只 pull，不直接改；安装/交付暂存）

## 0. 环境与同步协议

| 项 | 约定 |
|---|---|
| 开发/构建/测试 | WSL `/home/xm130812/md-reader` |
| Windows 镜像 | `D:\something\md-reader`，仅 `git pull --ff-only` |
| 远端 | `https://github.com/xm130812-byte/enod`，分支 `main` |
| 产物 | Linux 在 WSL `release/`；Win/mac 从 GitHub Actions 下载到 D: |
| 备份 | `bash scripts/backup.sh` → bundle + 未提交 patch + release |
| 编辑 | 优先 VS Code Remote WSL；不要从 Windows 侧改源码 |

已完成：WSL 副本、`pnpm install`（硬链接，1.3s）、web build（1.85s）、Rust 测试 + golden 全绿。

### 0.1 本地 Windows 构建（已启用）

- VS Build Tools：`C:\BuildTools`（VCTools + Windows SDK）
- Rust：`%USERPROFILE%\.cargo`，`stable-x86_64-pc-windows-msvc`
- 构建：`powershell -ExecutionPolicy Bypass -File scripts/local-build.ps1 -Target all`
  - 首次 core ~12 分钟、shell ~8 分钟；之后 core 约 1 分钟、shell 约 1 分钟（含 LTO）
  - 产物：`release/debug/bundle/{md-reader-shell.exe,md-reader-core.exe,web/}`
- 注意：本地构建用 D: 镜像源码；改完 WSL 后先同步 `main.rs`/`routes.rs`/`web/dist` 再构建。
- CI 仍保留 `windows-debug`（缓存后 1–3 分钟）作为兜底；打包必须用户确认。

## 1. 准备项（4 件，已完成/待提交）

- [x] 脚本去 `/mnt/d` 硬编码：`packages/core/smoke.sh`、`node-smoke.sh`、`scripts/shell-smoke.sh`、`scripts/webview-check.cjs`
- [x] `.gitattributes`：统一 LF，图片二进制，`sample-library/** -text` 保字节
- [x] `scripts/backup.sh`：git bundle + 未提交 diff + release
- [x] 同步协议写入本手册；D: 只 pull
- [ ] 修正 `sample-library/temp/README.txt` 的 100755 → 100644

## 2. 目标形态

```
Tray Icon（常驻）
  ├─ 左键：window 模式开/聚焦应用窗口；browser 模式开 Chrome 标签
  ├─ 右键：打开 / 默认打开方式 / 退出
  └─ tooltip：md-reader · N 篇 · 索引状态

打开方式
  ├─ 应用窗口（仅 Windows，WebView2）
  └─ Chrome 标签页（三平台）
```

详细视觉/交互见 [TRAY-DESIGN-v1.md](./TRAY-DESIGN-v1.md)。

## 3. 分阶段

### P0 基础：去黑框 + 打开方式 + 托盘菜单

- [x] Windows spawn core 使用 `CREATE_NO_WINDOW`（0x08000000），保留 stdout 端口解析
- [x] `shell.openMode` 存 core `config.json` 扩展字段；缺省 Windows=window，其他=browser
- [x] 托盘菜单：
  - 打开界面
  - 默认：应用窗口（仅 Windows）
  - 默认：Chrome 标签页
  - 退出
- [x] 左键托盘：按当前模式打开
- [x] Chrome 探测加 Windows 路径（Program Files / LOCALAPPDATA）
- [x] browser 模式用 `--new-tab <url>`，不再用 `--app`
- [x] 单实例回调按默认模式打开
- [x] Linux `cargo check` + deb 构建 + shell 冒烟（假 Chrome 收到 `--new-tab`）
- [x] Windows CI 装包验证：无黑框、两种打开模式；菜单点击未做 UI 自动化
  - CI run `42321928581`，NSIS 7,132,563 B；core/tasklist/cmd 均无 conhost（19→19）
  - 应用窗口：标题 `md-reader`，WebView2 CDP 9223，UI 正常
  - 浏览器模式：写 `shell.openMode=browser` 后只开 Chrome 标签，无应用窗口
- [x] 关窗行为：WM_CLOSE → `CloseRequested` 只 hide，shell/core 均存活；二次启动
      `open_main` 能重新 show 同一窗口（debug bundle 实测，日志 `%TEMP%\md-reader-shell.log`）
- [ ] 打包：等确认后再跑 `v4-build`；当前只出 windows-debug 裸程序

**验收**：双击快捷方式只出现应用窗口；托盘右键可切换默认方式；重启后仍生效；浏览器模式出现 Chrome 标签。

### P1 概览（Windows）

- [x] 360×620 无边框 WebView2 弹层，贴托盘、失焦隐藏
- [x] 统计 / 索引状态 / 最近 5 篇 / 当前工作区 / 打开方式切换
- [x] 工作区切换（`POST /library/open`）+ `library-changed` 刷新
- [x] SSE `/api/v1/events` 实时更新，5s 轮询兜底
- [x] 快捷动作：打开界面 / 搜索 / 新建 / 设置 / 重新索引 / 退出
- [x] 视图切换：简洁 / 完整（通过 `?view=` 唤起主界面并持久化）
- [x] 单击托盘图标直接展开概览；双击开主界面留给 P3

### P2 macOS/Linux 概览

- [ ] 方案 A：原生菜单摘要（推荐，不碰 WebKit）
- [ ] 或方案 B：egui 原生小窗（若确认要一致体验）

### P3 设置与打磨

- [ ] 设置页「启动与托盘」：默认打开方式、托盘概览开关
- [ ] 本次覆盖（这次用 Chrome/窗口）不写默认
- [ ] 托盘状态点（索引中/错误）
- [ ] 多显示器/DPI 定位
- [x] 关窗口 = 隐藏到托盘；托盘退出才结束内核（P0 已验证）

## 4. 配置约定

```json
{
  "shell": {
    "openMode": "window",
    "trayOverview": true,
    "recentWorkspaces": []
  }
}
```

- core 已保留未知键，`GET/PATCH /config` 可读写；
- 缺省回退：Windows→window，macOS/Linux→browser；
- 不新增 API 契约。

## 5. 已知限制

1. Chrome 没有可靠“聚焦已有标签”的跨平台 API；再次打开可能新开标签。
2. macOS/Linux 没有「应用窗口」；富概览需选 A/B。
3. Windows/macOS 安装包必须走 CI（本机无 MSVC/Mac）。
4. WSL 副本是唯一开发主线；D: 只做镜像/验收。

## 6. 回归命令

```bash
cd /home/xm130812/md-reader
pnpm build
cd packages/core && cargo test -p reader-core
cd ../..
node scripts/contract.mjs
node scripts/edit-flow.mjs
bash packages/core/smoke.sh
bash packages/core/lan-smoke.sh
# 壳
bash scripts/tauri-linux-build.sh
bash scripts/tauri-linux-bundle.sh --bundles deb
bash scripts/shell-smoke.sh
# 备份
bash scripts/backup.sh
```

## 7. 状态日志

- 2026-11-07：建立 WSL 主副本；4 项准备完成；开始 P0。
- 2026-11-07：P0 代码完成（Linux 编译通过，shell 冒烟 `--new-tab` + health 200）。
- 2026-11-07：P0 Windows 装包验收：无黑框、应用窗口/浏览器两种模式均打开。
- 2026-11-07：修复关窗退出问题（hide 到托盘 + prevent_exit），debug bundle 实测关窗后
  shell/core 存活、二次启动恢复窗口；打包已暂停，等确认。
- 2026-11-07：P1 概览完成：360×620 弹层、统计/索引/最近、工作区切换（tray-ws2 实测）、
  SSE+5s 轮询、打开界面/搜索/新建/设置/索引/退出、视图切换、打开方式切换；
  本地 MSVC 构建链打通（core 12m、shell 8m，增量约 1m）。
- 2026-11-07：修复概览高亮与默认模式不一致：壳直接写 config.json 不会刷新 core 内存，
  已改为写文件后再 `PATCH /api/v1/config` 同步 core；实测 API/文件/高亮一致。
