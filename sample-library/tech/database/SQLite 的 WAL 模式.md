---
title: SQLite 的 WAL 模式
tags: [工程, 数据库]
aliases: [WAL, write-ahead logging]
created: 2026-11-02T21:40:00+08:00
reader:
  id: 01M6PHE1PXXQ9PGJQQGTY2P1H8
  status: reading
  progress: 0.34
  annotations: []
---

# SQLite 的 WAL 模式

默认的 rollback journal 在写入时要锁住整个数据库，读和写互斥。WAL（write-ahead logging）把改动先追加到 `-wal` 文件，读操作继续读旧快照，写入不再阻塞读取。

## 打开

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

`synchronous = NORMAL` 是 WAL 下的常用组合：断电可能丢最后一个事务，但不会损坏数据库。

## 代价

| 项目 | rollback journal | WAL |
|---|---|---|
| 读写并发 | 互斥 | 读写并行 |
| 文件 | `index.db` | 多出 `-wal` / `-shm` |
| 同步盘 | 冲突多 | 需要 checkpoint 合并 |

WAL 文件不会自己缩小，需要 `wal_checkpoint(TRUNCATE)` 或等自动 checkpoint。同步盘（坚果云 / OneDrive）对 `-wal` 的同步很容易冲突，所以索引库永远放在应用数据目录，不进书库。

## 和这个项目的关系

md-reader 的 `index.db` 只是缓存，删掉可以重建；真正的数据是 `.md` 文件。因此可以用最激进的 WAL 设置换吞吐。具体的中文索引见 [[SQLite FTS5 中文检索]]，索引层为什么坚持零原生模块见 [[为什么零原生模块]]。

## 观察

- 3000 篇文档全量索引时，WAL 让「读列表」和「写入索引」可以同时发生。
- checkpoint 由 SQLite 自己调度，不需要应用层操心。
