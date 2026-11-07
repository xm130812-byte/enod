# md-reader

本地优先的 Markdown **阅读器**，顺带能写：把硬盘里的 `.md` 和网页剪藏，变成能舒服读、全局搜、划线批注、双向链接的私人书库。

> 当前状态：**初版已可运行**（M1 骨架 + 写作 / 批注 / 双链 / 搜索 P0）。
> 代码在 **[md-reader/](./md-reader/)**，实现说明、截图、运行方式见 [md-reader/README.md](./md-reader/README.md)。

## 文档

| 文件 | 内容 | 状态 |
|---|---|---|
| **[PRD-v3.md](./PRD-v3.md)** | **唯一基线**：定位、形态、数据模型、技术架构、功能规格、API、里程碑 | ✅ 定稿 |
| **[md-reader/README.md](./md-reader/README.md)** | 初版实现说明：能力矩阵、快速开始、架构、API、性能、已知限制 | ✅ 已实现 |
| [md-reader/docs/UI-DESIGN.md](./md-reader/docs/UI-DESIGN.md) | 界面规范：DSH 风格 token、直角/细线原则、强调色与密度、暗色映射 | ✅ v1 |
| [docs/ENVIRONMENT.md](./docs/ENVIRONMENT.md) | 配套环境：跨平台基线、Windows/macOS 安装与验收、分系统坑位 | 部分执行 |
| [scripts/check-env.mjs](./scripts/check-env.mjs) | 环境自检（只读，不安装） | 已跑通 |
| [PRD-v2.md](./PRD-v2.md) | 历史版本 | 🗄 已废弃 |
| [docs/ARCH-v2.1.md](./docs/ARCH-v2.1.md) | 历史版本（跨平台推演过程） | 🗄 已废弃 |

## 一分钟了解架构

```
Chrome (web UI)  ──HTTP / SSE──▶  Node 守护进程 127.0.0.1:<随机端口>
                                      ├─ node:sqlite + FTS5 索引
                                      ├─ fs.watch 增量
                                      └─ 书库目录 (.md)
```

- **零原生模块**：Windows 不用 VS Build Tools，macOS 不用 Xcode CLT。
- **只面向 Chrome**：不做跨浏览器兼容，可直接用最新特性。
- **随机端口**，首次分配后记住复用（避免 origin 变化导致设置丢失）。
- **写作是 P0**：进入编辑态即改即存，保存后仍是干净的 Markdown。
- **打包成软体**：Tauri 薄壳（托盘 + sidecar）+ 唤起 Chrome，出 Windows/macOS 安装包（尚未实现）。

## 快速开始

```powershell
cd md-reader
pnpm install
pnpm build
pnpm start          # 随机端口 + 自动打开 Chrome
```

开发模式：`pnpm dev`，打开 <http://localhost:5173>。

## 已完成 / 待办

- ✅ 守护进程、随机粘性端口、单实例、SSE、安全中间件
- ✅ SQLite FTS5 中文索引（3000 篇 20.3s）、增量监听
- ✅ frontmatter 保字节改写、原子写、版本快照、GBK/CRLF 保真
- ✅ 书架（含批量改状态 / 打标签）/ 阅读器 / CodeMirror Live Preview 写作 / 批注 / 双链（反链、断链、提及、悬浮预览）/ 搜索
- ✅ 拖入 `.md` 导入、导出批注、剪贴板图片
- ⛔ 剪藏、Tauri 安装包、批量移动目录

## 下一步

1. **M1.5 打包验证**：Tauri 壳 + Node SEA sidecar + 托盘，尽早暴露交付风险。
2. 剪藏（M5）。
3. 写作与书架的细节补齐（批量、拖入、导出批注）。
