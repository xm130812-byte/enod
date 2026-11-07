# md-reader 托盘 / 打开方式设计 v1（待确认，不实现）

> 目标：托盘不再是「一个图标」，而是**整体情况概览 + 工作区入口 + 打开方式控制**。
> 本文只描述方案与取舍；确认后再改代码。

## 1. 概念分层

```
Tray Icon（常驻）
  ├─ 左键：按当前模式打开界面 / 展开概览
  ├─ 右键：原生菜单（概览、打开、工作区、打开方式、设置、退出）
  └─ Tooltip：`md-reader · 19 篇 · 索引完成`

Overview（整体情况概览，细分功能）
  ├─ 统计：篇数 / 字数 / 未读·在读·已读
  ├─ 索引状态：空闲 / 进行中 n/N / 最近完成时间 / 错误
  ├─ 最近文档 3–5 篇（点击直达）
  ├─ 工作区：当前路径 + 最近工作区 + 选择文件夹
  ├─ 打开方式：应用窗口 / Chrome 标签页（默认值可改）
  └─ 快捷动作：打开、搜索、新建、重新索引、设置、退出

Main UI
  ├─ 应用窗口（Windows：内嵌 WebView2）
  └─ 浏览器标签页（Chrome / 默认浏览器）
```

## 2. 两种打开模式

| 模式 | 界面 | 适用平台 | 托盘行为 |
|---|---|---|---|
| **应用窗口** | Tauri WebView2 窗口 | **仅 Windows**（PRD 明确 macOS/Linux 不内嵌 WebKit） | 托盘缩为**功能按钮**：左键打开/聚焦窗口；不常驻概览弹层；tooltip 保留摘要 |
| **Chrome 标签页** | `http://127.0.0.1:<port>` 新标签 | 三平台 | 托盘常驻，左键展开**实时概览**；关掉标签页应用不退出 |

- 首次启动默认：Windows = 应用窗口；macOS/Linux = Chrome 标签页（没有应用窗口能力）。
- 默认值可在「概览」和「设置 → 启动与托盘」里修改，立即生效并持久化。
- 每次打开可临时覆盖：托盘右键「这次用 Chrome 打开 / 这次用应用窗口打开」。
- macOS/Linux 的「应用窗口」选项隐藏或置灰。

## 3. 托盘状态机

```
                  ┌────────────────────────────┐
                  │  Tray Icon（始终存在）      │
                  └──────────┬─────────────────┘
        mode=window          │            mode=browser
        ┌────────────────────┘            └────────────────────┐
        ▼                                                      ▼
┌──────────────────┐                                  ┌──────────────────┐
│ 功能按钮          │                                  │ 实时概览          │
│ 左键：开/聚焦窗口 │                                  │ 左键：展开/收起   │
│ 无概览弹层        │                                  │ 常驻，SSE 实时更新│
│ tooltip 显示摘要  │                                  │ 关标签页也不退出  │
└──────────────────┘                                  └──────────────────┘
```

- 关闭应用窗口 = **隐藏到托盘**，不退出；托盘「退出」才结束内核。
- 第二次启动：window 模式聚焦已有窗口；browser 模式打开新标签（Chrome 没有可靠的“聚焦已有标签”API，见 §10）。
- 索引中：托盘图标加状态点 / tooltip 显示 `索引 120/3000`。

## 4. 概览内容（建议 360×480，圆角无边框）

```
┌ md-reader ──────────────────────────┐
│ 本地优先 · 19 篇 · 22.8k 字          │
│ [未读 12] [在读 5] [已读 2]          │
│ 索引：完成 · 2 分钟前                │
│                                      │
│ 最近                                 │
│  · 本地优先                323 字 →  │
│  · SQLite FTS5 中文检索    262 字 →  │
│  · 春夜读书                196 字 →  │
│                                      │
│ 工作区  D:\something\sample-library  │
│         [切换] [选择文件夹…]         │
│                                      │
│ 打开方式  ● 应用窗口   ○ Chrome 标签 │
│           □ 设为默认                 │
│                                      │
│ [打开界面] [搜索] [新建] [设置]      │
│ 索引 21ms · 端口 64826 · v0.1.0      │
└──────────────────────────────────────┘
```

- 统计来自 `/api/v1/library` + `/api/v1/library/stats`；最近文档来自 `/docs?sort=recent&limit=5`。
- 工作区切换调用 `POST /api/v1/library/open`；切换前确认「会重新索引」，切换后 UI 靠 `library-changed` 自动刷新。
- 概览里的「搜索」打开主界面并聚焦搜索框；「新建」「重新索引」直接调现有 API。
- 键盘：↑↓ 选择、Enter 打开、Esc 关闭。

## 5. 默认打开方式与持久化

建议放在 **core 的 `config.json` 扩展字段**（core 已保留未知键，`GET/PATCH /config` 原样返回），这样：

- 托盘和 web 设置页读同一份配置；
- 浏览器标签页里的设置也能改默认值；
- 不新增 API 契约。

```json
{
  "shell": {
    "openMode": "window",          // window | browser
    "trayOverview": true,          // window 模式下是否允许右键“显示概览”
    "recentWorkspaces": ["D:\\...", "D:\\..."]
  }
}
```

- 缺省回退：Windows→window，macOS/Linux→browser。
- 支持「本次覆盖」但不写默认值。
- 工作区当前值仍以 core `libraryRoot` 为准；recentWorkspaces 只是托盘历史。

## 6. 去掉运行时黑框

黑框不是 Tauri 壳，而是壳 spawn 的 **console 子系统 `md-reader-core.exe`** 在 Windows 上新建了控制台。

修复：

1. 壳的 release 保持 `windows_subsystem = "windows"`（已有）。
2. Windows 下 `Command::new(core).creation_flags(CREATE_NO_WINDOW)`（0x08000000），同时保留 stdout 管道（解析端口）。
3. 安装器快捷方式只指向 `md-reader-shell.exe`，不直接指向 core。
4. `md-reader-core.exe` 仍保留 console 子系统，方便命令行/排障；只有壳拉起时隐藏。
5. 验收：任务管理器无 `conhost` 黑框；双击安装后的快捷方式只出现应用窗口。

## 7. 平台差异（需要你选）

「Windows 用 WebView2 弹层」没问题；macOS/Linux 若要同样的富概览，只有三条路：

| 方案 | 做法 | 代价 | 是否符合 PRD |
|---|---|---|---|
| **A（推荐）** | Windows：WebView2 弹层；macOS/Linux：**原生菜单**摘要（文字项 + 子菜单） | 两端观感不一致；原生菜单不能画卡片 | ✅ 不碰 WebKit |
| **B** | 三平台统一用 **egui 原生小窗**（Rust，自绘） | +约 3–5 MB，样式与 web 不共享 | ✅ 不碰 WebKit，体验一致 |
| **C** | macOS/Linux 也内嵌 WebView（WKWebView/WebKitGTK）做概览 | 直接违反 D2「WebKit 一律不碰」 | ❌ |

> 我的建议：先做 **A**，Windows 是主场景；如果确认 macOS/Linux 也要富概览，再上 **B**。C 不建议。

## 8. 交互细节

| 操作 | window 模式 | browser 模式 |
|---|---|---|
| 左键托盘 | 打开/聚焦应用窗口 | 展开/收起概览 |
| 双击托盘 | 打开应用窗口 | 打开 Chrome 标签 |
| 右键托盘 | 原生菜单 | 原生菜单 |
| 关闭主窗口 | 隐藏到托盘 | 关标签页，托盘继续 |
| 第二次启动 | 聚焦窗口 | 新开标签（见 §10） |
| 索引完成 | tooltip 更新 | tooltip + 概览更新 |

- 应用窗口模式下，概览不是常驻弹层；右键菜单保留「显示概览」作为一次性面板（可关）。
- 浏览器模式下概览可固定（pin），鼠标移出也不收；否则失焦自动收。

## 9. 实时监控

- 壳订阅 core 的 SSE `/api/v1/events`：`hello`、`index-progress`、`index-done`、`doc-changed`、`library-changed`、`clip-progress`。
- 事件 200ms 合并刷新；SSE 断开时 5s 轮询 `/library/stats` 兜底。
- tooltip 最多 1s 更新一次，避免闪烁。
- 概览打开时才渲染最近文档，关闭后停止请求。

## 10. 已知限制（需接受）

1. **Chrome 标签聚焦**：没有跨平台 API 能可靠聚焦已存在的标签；「再次打开」可能新开一个标签。可选缓解：固定端口 + 固定 URL，由用户自己切标签；或 browser 模式也用 `--app` 窗口（就不是标签页了）。
2. **macOS/Linux 富概览**：见 §7，需要选 A/B/C。
3. **应用窗口仅 Windows**：macOS/Linux 不能提供「应用窗口」选项。
4. 多显示器 / 高 DPI 下托盘弹层定位需要按显示器工作区校正。

## 11. 实现拆分（确认后）

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 去黑框、托盘菜单、打开方式配置、默认值、window/browser 打开 | 0.5 天 |
| P1 | Windows 概览弹层（WebView2）+ 统计/最近/工作区 + SSE | 1 天 |
| P2 | macOS/Linux 原生菜单（A）或 egui（B） | 0.5–1 天 |
| P3 | 设置页「启动与托盘」、本次覆盖、托盘状态点、验收 | 0.5 天 |

新增/改动：

- `packages/shell/src-tauri/src/{tray,overview,core_client,config}.rs`
- `packages/shell/src-tauri/tauri.conf.json`（capabilities/window）
- core 配置扩展字段（不新增 API）
- `packages/web/src/components/SettingsDialog.tsx`（启动与托盘一节）
- 可选 `GET /api/v1/tray` 聚合接口（减少概览 4 次请求）

## 12. 验收清单

- [ ] 双击安装后的快捷方式，**没有黑色控制台**，只出现应用窗口。
- [ ] 首次启动按平台默认模式打开；改默认后重启仍生效。
- [ ] window 模式：托盘是功能按钮，左键聚焦窗口；关窗口不退出。
- [ ] browser 模式：托盘常驻概览，关标签页不退出；索引时 1s 内更新。
- [ ] 概览里切换工作区，主界面自动刷新，索引进度可见。
- [ ] 本次用 Chrome / 本次用窗口 的临时覆盖不改变默认值。
- [ ] macOS/Linux 按选定方案（A/B）工作，且不引入 WebKit。

## 13. 待你确认

1. macOS/Linux 富概览选 **A（原生菜单，推荐）** 还是 **B（egui 统一小窗）**？
2. 左键托盘：window 模式直接开窗口、browser 模式开概览 —— 是否同意？
3. 关闭应用窗口 = 隐藏到托盘（不退出）—— 是否同意？
4. 首次默认：Windows 应用窗口 / macOS·Linux Chrome 标签 —— 是否同意？
5. 默认打开方式存 core `config.json` 的 `shell` 扩展字段 —— 是否同意？
6. Chrome 标签「再次打开可能新开标签」的限制是否接受？
