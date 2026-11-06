# reader-core · md-reader Rust 内核

`/api/v1` 契约与 v3 Node 实现等价；前端零改动。全部业务逻辑在 `reader-core`，
`reader-cli` 只解析参数、起 runtime。

## 构建 / 运行

```bash
cd packages/core
cargo build --release -p reader-cli
~/target/release/md-reader-core --data-dir /tmp/mdreader --no-open
# 默认 127.0.0.1 + 随机粘性端口；run.json 写在 data-dir
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--data-dir <dir>` | 数据目录（默认按平台规则） |
| `--port <n>` | 0 = 随机；被占用时自动回退随机 |
| `--host 0.0.0.0` | 开启 LAN；强制 token（写入 `<data-dir>/token`） |
| `--token <t>` | 指定 token；也可用 `READER_TOKEN` |
| `--no-open` | 不自动开浏览器 |
| `--impl node` | 兼容双栈期的回滚开关（本实现忽略） |

环境变量：`READER_ROOT` 覆盖书库根，`READER_DATA_DIR` 覆盖数据目录，
`READER_CLIP_ALLOW_PRIVATE=1` 允许剪藏抓本机/内网（仅测试）。

## 目录

```
crates/reader-core/src/
├─ atomic.rs encoding.rs paths.rs config.rs ulid.rs hash.rs
├─ frontmatter/{mod,patch}.rs      行级 frontmatter 改写
├─ markdown.rs tokenizer.rs        派生物与 jieba/bigram
├─ db/{mod,schema.sql}             单连接 actor + FTS5
├─ indexer.rs watcher.rs           全量/增量索引与防抖
├─ library/                        文档、批注、资产、sidecar、clip jobs
├─ adapt/{txt,sql,html,docx}.rs    → markdown
├─ clip/{fetch,extract,url}.rs     SSRF + 正文 + 图片
└─ http/{mod,routes,security,sse}  axum + 中间件
crates/reader-cli/src/main.rs      入口
tests/contract/*.json              契约 fixture
tests/golden/*.json                转换金标准
```

## 测试

```bash
cargo test -p reader-core                 # 单测 + golden
cd ../.. && node scripts/contract.mjs     # Node vs Rust（23 个）
node scripts/recall.mjs                   # 召回率（≥95%）
node scripts/edit-flow.mjs                # txt/sql/docx 编辑验收
bash packages/core/smoke.sh               # health/stats/docs/search 冒烟
bash packages/core/clip-smoke.sh          # 真网页剪藏
bash packages/core/lan-smoke.sh           # LAN token + 只读
bash packages/core/release.sh             # release + 体积
bash packages/core/bundle.sh              # Linux 便携包 + tar.gz
PLAYWRIGHT_PATH=... CDP_URL=... node scripts/ui-check.cjs  # 真浏览器 e2e
```

## v4 新增端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/docs/:id/compat` | `{editable,annotatable,canConvertToMd}` |
| POST | `/docs/:id/convert` | 生成 md 副本，返回新 docId |
| GET | `/docs/:id/export` | 导出 markdown（下载） |
| POST | `/docs/:id/open` | 调系统关联程序打开原文件 |

## 兼容性

- `run.json` / `config.json` 字段与 v3 逐字对齐；config 里不认识的键原样保留。
- `index.db` 用 `user_version` 迁移：只 `ALTER TABLE ADD COLUMN`；FTS 列不一致时重建。
- md 身份在 frontmatter；txt/sql/html/docx 身份在 sidecar（缺失则按路径派生）。
- 非 md 的状态/进度/批注写 `<文件名>.<ext>.reader.json`，与源文件同目录。
