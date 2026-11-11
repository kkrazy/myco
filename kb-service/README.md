# myco-kb — 领域知识库服务

独立进程，为 myco 的**科研模式**提供领域知识检索与沉淀。myco 只通过 HTTP 调用它，
自己不建索引、不存向量、不解析语料。

- **零依赖**：只用 Node 内置模块（`node:sqlite` / `http`）。无 npm 包、无 Docker 必需、无外部数据库。
- **词法检索**：SQLite FTS5 + BM25，字段加权（text 1.0 / title 4.0 / section 2.0）。
- **中文检索**：CJK bigram 索引（`unicode61` 会把整段中文当一个 token，必须拆 bigram）。
- **可选向量**：配置 `KB_EMBED_URL` 后启用 OpenAI 兼容 embedding + RRF 融合；不配也能完整工作。
- **Markdown-first 写回**：知识正文是 `notes/<kind>/<slug>.md`，SQLite 只是可丢弃的派生索引。

## 快速开始

```bash
# 1. 建库（math 语料，约 45 秒 / 133k chunks / 367 MB）
KB_ROOT=./kb-data node bin/kb.js build --corpus /path/to/math --kb math

# 2. 启动服务
KB_ROOT=./kb-data KB_PORT=7317 node src/server.js

# 3. 检索
KB_ROOT=./kb-data node bin/kb.js search "Selmer corank" -k 3
```

在 myco 的 `$MYCO_STATE_DIR/.env` 里加：

```
MYCO_KB_URL=http://127.0.0.1:7317
MYCO_KB_TOKEN=<可选，与服务的 KB_TOKEN 一致>
```

然后在会话里 `/research on`（或 `/kb use math`）。

## CLI

| 命令 | 作用 |
|---|---|
| `kb serve` | 启动 HTTP 服务 |
| `kb build --corpus <dir> [--kb math] [--incremental]` | 建库 / 增量重建 |
| `kb search <query> [-k 6] [--kind theorem] [--source local]` | 命令行检索 |
| `kb stats` | 论文 / chunk / note 统计 |
| `kb notes list [--kind insight] [--status draft]` | 列出本地知识 |
| `kb notes add --title <t> --kind insight --content <text>` | 写一条知识 |
| `kb notes verify\|deprecate\|rm <slug>` | 状态流转 |
| `kb notes reindex` | 从 Markdown 重建本地索引 |
| `node bin/eval.js --kb math --n 100` | 检索质量评测 |

## HTTP API

所有非 `/health` 请求在设置 `KB_TOKEN` 后需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活 + 版本 + KB 列表（免鉴权） |
| GET | `/kbs` | KB 列表 + manifest |
| GET | `/kbs/:kb/stats` | 计数与分类 |
| POST | `/kbs/:kb/search` | `{query, k, kinds, source, discipline, family, ...}` |
| GET | `/kbs/:kb/chunks/:id` | 单个 chunk + 相邻 chunk |
| GET | `/kbs/:kb/related?paper=&family=` | 同族 / 同学科论文 |
| GET | `/kbs/:kb/notes?kind=&status=` | 本地知识列表 |
| POST | `/kbs/:kb/notes` | 写入（同 slug 自动合并） |
| GET/PATCH/DELETE | `/kbs/:kb/notes/:slug` | 读取 / 改状态或正文 / 删除 |
| POST | `/kbs/:kb/notes/reindex` | 从 Markdown 重建本地索引 |
| POST | `/kbs/:kb/build` | 服务端触发建库（admin） |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `KB_ROOT` | `./kb-data` | 知识库根目录 |
| `KB_HOST` / `KB_PORT` | `127.0.0.1` / `7317` | 监听地址 |
| `KB_TOKEN` | 空 | 设置后所有数据接口需要 Bearer token |
| `KB_EMBED_URL` | 空 | OpenAI 兼容 `/v1/embeddings` 基址（如 TEI） |
| `KB_EMBED_MODEL` | `bge-m3` | embedding 模型名 |
| `KB_EMBED_API_KEY` | 空 | embedding 鉴权 |
| `KB_RERANK_CANDIDATES` | `100` | 词法候选池大小 |

## 目录结构

```
kb-data/math/
├── index.sqlite        ← 派生索引（可删，可重建）
├── manifest.json       ← 建库来源与统计
└── notes/              ← 权威副本，git 可跟踪
    ├── README.md
    ├── index.md        ← 自动生成的目录
    ├── insight/*.md
    ├── method/*.md
    ├── counterexample/*.md
    ├── failure/*.md
    ├── lemma/*.md
    └── reference/*.md
```

**索引可丢弃，Markdown 不可丢弃。** 删掉 `index.sqlite` 后 `kb notes reindex`（或重新 build）
即可从 Markdown 恢复全部本地知识。

## 单条知识的格式

```markdown
---
id: bsd-low-selmer-corank
title: "BSD 在 Selmer 余秩不超过 1 时成立"
kind: insight
status: draft
scope: project
tags: ["BSD", "Selmer"]
source:
  session: sess_ab12
  paper: Exact-Birch-Swinnerton-Dyer-Formula-...
  chunks: [10231, 10244]
confidence: medium
created_at: 2026-11-11T10:20:31Z
updated_at: 2026-11-11T10:20:31Z
---

## 结论
...
## 依据
- [KB:Exact-BSD-... §Introduction] ...
## 适用边界
...
## 更新记录
- 2026-11-11T10:20:31Z 由会话 sess_ab12 自动抽取（draft）。
```

`status` 生命周期：`draft`（自动/首次写入）→ `verified`（人工或 `/kb verify`）→
`deprecated`（过时/被推翻，默认不检索）。`## 更新记录` 不进索引（它是溯源，不是知识）。

## 实测（math 语料）

| 指标 | 数值 |
|---|---|
| 论文 / chunk | 748 / 133,021 |
| 建库 | 43 s |
| 索引体积 | 367 MB |
| 检索延迟 | p50 9 ms / p95 19 ms |
| recall@5（摘要派生查询） | 0.99 |
| MRR | 0.966 |

## 测试

```bash
node test/run.js      # 33 个单元测试，无网络
```
