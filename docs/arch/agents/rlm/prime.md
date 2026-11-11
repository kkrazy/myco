# Prime Agent 代码分析报告

> 仓库路径：`D:\project\data_infra\llm_demo\paper\RLM\prime-agent-src`
> 分析日期：2026-10-21
> 项目版本：v0.10.0

---

## 一、项目概览

### 1.1 基本信息

| 属性 | 值 |
|------|-----|
| 项目名称 | Prime Agent: A Self-Improving RLM Harness |
| 开发组织 | PrimeIntellect-ai |
| 编程语言 | Rust (edition 2021) + Python (RLM runtime) |
| 许可证 | MIT |
| 版本 | 0.10.0 |
| 构建系统 | Cargo workspace |
| 论文 | arXiv:2608.23552 |

### 1.2 核心定位

Prime Agent 是一个开源的编码与研究 Agent，围绕两个核心抽象构建：

1. **Recursive Language Model (RLM)**：将上下文视为变量（*prompt-as-a-variable*），将递归子 Agent 等工具视为函数调用（*programmatic tool / sub-agent calling*），运行在持久化 Python REPL 之上。
2. **Continual Harness**：将补充提示、记忆、技能描述和可复用子 Agent 规格存储为持久状态，Agent 可通过 `/refine` 进行小的、有证据支撑的增量更新。

### 1.3 关键依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| `tokio` | 1 (full) | 异步运行时 |
| `serde` / `serde_json` | 1 | 序列化（preserve_order 保持插入顺序） |
| `anyhow` | 1 | 错误处理 |
| `tracing` | 0.1 | 结构化日志 |
| `reqwest` | 0.12 | HTTP 客户端（rustls TLS） |
| `ratatui` | 0.29 | 终端 UI 框架 |
| `crossterm` | 0.28 (vendored patch) | 终端事件处理 |
| `futures` | 0.3 | 异步原语 |
| `nix` | 0.29 | Unix 系统调用 |
| `uuid` | 1 (v4, v7) | ID 生成 |

### 1.4 构建与发布

- **LTO 策略**：`thin` LTO + 4 codegen units，优化跨 crate 内联（热渲染路径）
- **Debug 信息**：`line-tables-only`，发布管道通过 `objcopy --strip-debug` 生成发布二进制 + 分离调试 sidecar
- **Lint 策略**：全 workspace 启用 `clippy::pedantic` + 40+ 额外 lint，`-D warnings` 作为合并门控
- **安全策略**：`unsafe_code = "forbid"`（workspace 级），仅 pa-types/pa-core/pa-cli 因平台绑定保留自有 lint 表

---

## 二、目录结构树

```
prime-agent-src/
├── Cargo.toml                    # workspace 根配置
├── Cargo.lock
├── README.md
├── AGENTS.md                     # 开发规则（贡献者必读）
├── CONTRIBUTING.md
├── LICENSE
├── Makefile                      # 本地检查镜像（fmt+clippy+test）
├── deny.toml                     # cargo-deny 配置
├── install-rust.sh / install.ps1 # 安装脚本
│
├── crates/                       # 10 个 Rust workspace 成员
│   ├── pa-types/                 # 共享 wire/domain 类型（43 个 .rs 文件）
│   ├── pa-telemetry/             # 遥测事件与 sink（17 个 .rs 文件）
│   ├── pa-agent/                 # Provider 无关的 Agent 循环（14 个 .rs 文件）
│   ├── pa-ai/                    # Provider API、模型注册、流式传输（80 个 .rs 文件）
│   ├── pa-models/                # 实时模型目录与传输（11 个 .rs 文件）
│   ├── pa-core/                  # 会话引擎：工具/技能/提示/内核/设置（100+ 个 .rs 文件）
│   ├── pa-daemon/                # 监督者、worker 进程、wire 协议（100+ 个 .rs 文件）
│   ├── pa-tui/                   # 终端 UI（100+ 个 .rs 文件）
│   ├── pa-cli/                   # prime-agent 二进制，组合根（79 个 .rs 文件）
│   └── pa-perf/                  # 性能基准工具（dev/CI only，不发布）
│
├── prime-agent-runtime/          # Python RLM 运行时
│   ├── pyproject.toml
│   ├── uv.lock
│   ├── src/
│   │   └── rlm/
│   │       ├── __init__.py       # RLM 内核 shim（spawn/create_session/find_models...）
│   │       ├── repl.py           # CPython REPL 运行时（协议 v3）
│   │       ├── repl.md           # REPL 协议文档
│   │       ├── harness.py        # 持久化 harness 状态管理
│   │       ├── factory.py        # Factory 状态机验证与执行
│   │       ├── bash.py           # Bash 句柄管理
│   │       ├── mcp.py / mcp_base.py  # MCP 集成
│   │       ├── skill.py          # 技能加载
│   │       ├── factory.py        # Factory 规格验证/编译/执行
│   │       ├── _winjob.py        # Windows 进程组管理
│   │       └── machines/         # 状态机目录
│   └── test/                     # Python 测试
│
├── skills/                       # 14 个内置技能
│   ├── agent-message/            # agent_message.send 通信
│   ├── agent-observe/            # agent_observe 观察
│   ├── attach-image/             # 图片附加
│   ├── compact/                  # 上下文压缩
│   ├── edit/                     # 文件编辑
│   ├── factory/                  # Factory 状态机
│   ├── goal/                     # 目标管理
│   ├── mcp/                      # MCP 服务器
│   ├── prime-intellect/          # Prime Intellect 集成
│   ├── refine/                   # /refine 自改进
│   ├── rlm-heartbeat/            # RLM 心跳
│   ├── skill-creator/            # 技能创建器
│   └── websearch/                # 网页搜索
│
├── docs/                         # 文档
│   ├── daily-stats.md
│   ├── slack-mcp.md
│   ├── legacy-release-inventory.json
│   ├── legacy-upgrade-contract.md
│   └── legacy-upgrade-evidence.md
│
├── vendor/                       # vendored 依赖
│   └── crossterm/                # crossterm 0.28.1 patch（kitty 轮询限制 250ms）
│
├── scripts/                      # 构建/发布脚本
└── packaging/                    # 打包配置
```

---

## 三、Workspace Crate 架构

### 3.1 依赖层次图

```
                    pa-cli (组合根 / prime-agent 二进制)
                   /  |  \  \  \  \  \
             pa-core pa-ai pa-agent pa-daemon pa-tui pa-telemetry pa-models
              / | \    |              |  |  |  \
        pa-types pa-ai pa-models   pa-types pa-core pa-agent pa-ai
            |    |                   pa-telemetry pa-models
          (leaf) pa-types              |
                 (leaf)             (leaf)
```

**核心规则**：依赖只能从高 crate 指向低 crate，无环、无反向边。`pa-types` 是唯一的共享词汇 crate。

### 3.2 各 Crate 职责

#### pa-types — 共享 wire/domain 类型

| 文件 | 职责 |
|------|------|
| `lib.rs` | `JsonMap` 类型别名、`JsNumber`（JS number parity 新类型） |
| `ai/` | 模型消息面（AssistantMessage、Usage 等，镜像 TS `packages/ai/src/types.ts`） |
| `session.rs` | 会话条目类型（EntryBase、AgentMessage、CompactionEntry 等） |
| `compaction.rs` | 压缩相关 wire 类型 |
| `goal.rs` | 目标状态类型（GoalState、GoalStatus） |
| `daemon/` | daemon wire 协议（DaemonCommand、DaemonOutbound、Worker 描述符等） |
| `incident/` | 事件分类器（anomaly 检测、日志解析模式） |
| `platform/` | 平台抽象（目录、身份、进程、终端、传输） |
| `slash_commands.rs` | 斜杠命令 wire 类型 |
| `skill_blocks.rs` | 技能块格式 |

**设计要点**：每个 wire struct 携带 `#[serde(flatten)] rest: JsonMap` catch-all，未建模字段在 parse/serialize 往返中存活——保证与 TS 产品的字节级兼容。

#### pa-telemetry — 遥测事件与 sink

| 文件 | 职责 |
|------|------|
| `event.rs` / `events.rs` | 事件 schema 定义 |
| `sink.rs` / `sinks/` | sink 实现（analytics HTTP、file、mock、noop） |
| `client.rs` | 后台 worker 客户端（fire-and-forget） |
| `catalog.rs` | 事件目录 |
| `install_id.rs` | 安装 ID |

**设计要点**：遥测从用户面代码 fire-and-forget，后台 worker 端到端拥有投递语义。启动/会话创建/首渲染路径不得持有 flush 或 await sink。

#### pa-agent — Provider 无关 Agent 循环

| 文件 | 职责 |
|------|------|
| `agent.rs` | `Agent` 结构体：拥有 agent 状态、消息队列、事件监听器、活跃运行生命周期 |
| `agent_loop/` | 底层循环（entry、run、response、tools、tool_call、abort） |
| `stream.rs` | `StreamFn` trait — LLM 流式调用边界 |
| `types.rs` | Agent 层类型（AgentMessage、AgentTool、Model、Usage） |
| `abort.rs` | `AbortController` / `AbortSignal` — 取消传播 |
| `scripted.rs` | 测试用 scripted agent |
| `validation.rs` | 消息验证 |

**设计要点**：循环全程使用 `AgentMessage`，仅在模型调用边界转换为 LLM-bound `Message`。`AgentOptions` 支持 `before_tool_call`/`after_tool_call`/`should_stop_after_turn`/`should_stop_before_turn` 等钩子。

#### pa-ai — Provider API、模型注册、流式传输

| 文件/目录 | 职责 |
|-----------|------|
| `providers/anthropic/` | Anthropic Claude provider（convert、params、stream） |
| `providers/openai_completions/` | OpenAI Chat Completions provider |
| `providers/openai_responses/` | OpenAI Responses API provider |
| `providers/openai_codex_responses/` | OpenAI Codex WebSocket provider |
| `providers/bedrock/` | AWS Bedrock provider（h2c cleartext HTTP/2、eventstream） |
| `providers/google*` | Google Vertex AI / Gemini provider |
| `providers/mistral/` | Mistral provider |
| `providers/faux/` | 测试用 faux provider |
| `oauth/` | OAuth 流程（Anthropic、GitHub Copilot、OpenAI Codex、xAI、PKCE） |
| `registry.rs` | `ProviderRegistry` — provider 注册与查找 |
| `models.rs` / `models_generated.rs` | 模型目录（手工维护，镜像 TS `models.generated.ts`） |
| `stream.rs` | `complete`/`stream` 统一入口 |
| `utils_inner/` | SSE 解码、JSON 修复、overflow 检测、TLS 客户端、流失败分类 |
| `cache_pricing.rs` | Anthropic 缓存定价计算 |

#### pa-models — 实时模型目录

| 文件 | 职责 |
|------|------|
| `fetch.rs` | 从远程获取模型目录 |
| `chain.rs` | no-cold-start 链（bundled → cache → fetch） |
| `cache.rs` | 磁盘缓存 |
| `offline.rs` | 离线模式 |
| `pinning.rs` | 传输固定 |
| `prime_inference.rs` | Prime Inference 集成 |
| `schema.rs` | 目录 schema |

#### pa-core — 会话引擎（核心 crate）

这是最复杂的 crate，包含 100+ 个 `.rs` 源文件，涵盖以下子系统：

| 模块 | 职责 |
|------|------|
| `kernel/` | **RLM 内核层**：持久化 Python REPL 生命周期管理 |
| `refinement/` | **Continual Harness / /refine**：自改进流水线 |
| `session/` | 会话管理：解析、迁移、上下文重建、树 |
| `session_engine/` | 会话引擎契约（SessionEngine trait） |
| `autonomous/` | **Autonomous mode**：自主运行驱动 |
| `prompts/` | 分层系统提示组装 |
| `tools/` | 工具定义（bash、edit、ipython） |
| `skills/` | 技能加载与格式化 |
| `mcp/` | MCP 服务器管理（连接、OAuth、目录） |
| `models/` | 模型解析、允许列表、Prime Inference 目录 |
| `packages/` | 包管理（git、npm、更新） |
| `auth/` | 认证管理（Prime Inference、Prime Traces、Provider OAuth） |
| `cron/` | 定时任务调度器 |
| `goals.rs` | 线程目标：状态模型、验证、宿主响应序列化 |
| `agent_traces/` | Agent 轨迹（continuous、HTTP、upload） |
| `export_html/` | HTML 导出（ANSI→HTML、主题、工具渲染） |
| `platform/` | 平台操作（浏览器、文件系统、锁目录、权限、进程、shell） |
| `resources/` | 资源解析 |
| `settings/` | 设置管理 |
| `update/` | 更新管理 |
| `workspace_snapshot/` | 工作区快照 |

#### pa-daemon — 监督者、worker 进程、wire 协议

| 模块 | 职责 |
|------|------|
| `supervisor.rs` | **Supervisor 运行时**：每会话一个 worker 进程 |
| `engine.rs` | `SessionEngine` trait — turn 行为契约 |
| `session_store.rs` | **JSONL 会话存储**：append-only，每会话一个 `.jsonl` 文件 |
| `journal.rs` | 恢复日志：append-only JSONL |
| `compaction.rs` | worker 侧压缩管理 |
| `rlm_children.rs` | **RLM 子 Agent 会话**：daemon 侧 `RlmSubagentHost` |
| `rlm_ledger.rs` | **RLM spawn 账本**：append-only JSONL 记录 spawn/rename/delete |
| `agent_messaging.rs` | **agent_message/agent_observe 控制器** |
| `agent_message_broadcast.rs` | agent 消息广播 |
| `agent_message_ingest.rs` | agent 消息摄入 |
| `autonomous_continuation.rs` | 自主续行 |
| `auto_compaction.rs` | 自动压缩 |
| `branch_navigation.rs` | 分支导航 |
| `goal_continuation.rs` | 目标续行 |
| `cron/` | 定时任务（heartbeat、jobs、session_artifacts） |
| `socket.rs` / `framing.rs` | Unix socket 通信与 JSONL 帧化 |
| `peer.rs` / `peer_client.rs` | worker-to-worker 直接 peer 投递 |
| `supervisor_link.rs` | supervisor 链接 |
| `registration.rs` / `registry.rs` | worker 注册与注册表 |

#### pa-tui — 终端 UI

100+ 个 `.rs` 文件，基于 `ratatui` + `crossterm`。关键组件包括：

| 模块 | 职责 |
|------|------|
| `app.rs` | 应用主循环 |
| `chat.rs` / `chat_slash.rs` | 聊天界面与斜杠命令 |
| `agents_view.rs` | Agent 浏览视图（运行中/空闲/已保存会话） |
| `session.rs` / `session_ui.rs` | 会话 UI |
| `daemon_client.rs` | daemon wire 客户端 |
| `subagents.rs` | 子 Agent 视图 |
| `goal_surface.rs` | 目标面板 |
| `markdown.rs` | Markdown 渲染 |
| `bash_view.rs` / `bash_card.rs` | Bash 输出视图 |
| `onboarding.rs` / `onboarding_flow.rs` | 引导流程 |
| `clipboard.rs` / `osc52.rs` | 剪贴板（OSC 52 / tmux 转发） |

**设计要点**：`pa-tui` 仅从 wire 类型和事件渲染，不链接会话引擎。

#### pa-cli — prime-agent 二进制（组合根）

| 模块 | 职责 |
|------|------|
| `main.rs` | 入口：内存调优 → 剥离 worker 环境 → `main_with_runtime` |
| `args.rs` | CLI 参数解析 |
| `interactive_mode.rs` | 交互模式 |
| `daemon_mode.rs` | daemon 模式 |
| `headless_autonomous.rs` | 无头自主模式 |
| `command_registry.rs` | 命令注册表 |
| `update_flow/` | 更新流程（coordinator、phases、plan、swap） |
| `daemon_discovery/` | daemon 发现（scan、kill、stop） |
| `print_boundary/` | 边出边界打印 |

**设计要点**：`pa-cli` 是组合根——将各 crate 连接在一起，不含业务逻辑。

---

## 四、核心机制代码实现分析

### 4.1 RLM (Recursive Language Model) 实现

RLM 的实现跨越 Rust 宿主层和 Python 运行时层：

#### 4.1.1 Rust 宿主层 — `pa-core/src/kernel/`

**内核协议（protocol.rs）**：版本 3 的 newline-delimited JSON 协议。

```rust
pub const REPL_PROTOCOL_VERSION: u64 = 3;

pub enum Request {
    Execute { code: String },
    Interrupt,
    HostReply { data: Value },
    Snapshot { path, manifest_path, max_bytes, max_variable_bytes, prune_oversized },
    Restore { path, max_bytes, max_variable_bytes },
    ListNames,
    McpStatus { servers, timeout_ms },
    Shutdown,
}
```

**内核管理器（manager/）**：`ReplKernelManager` 管理内核子进程的生命周期——spawn、handshake、execute、interrupt、snapshot/restore、shutdown。

**内核供应器（provisioner.rs）**：`IpythonKernelProvisioner` 每会话拥有一个内核管理器，负责：
- 启动并发控制（信号量限流，默认 `min(16, cores*2)`）
- 保存的命名空间恢复（在运行时 bootstrap 之前）
- 释放/杀死时的快照刷新
- 技能导入失败报告

**RLM 运行时辅助（rlm_runtime.rs）**：纯规范化/搜索辅助——`rlm.spawn` / `rlm.find_models` 的 kwargs 验证：
- `normalize_requested_rlm_subagent_session_name` — 会话名验证（≤64 字符）
- `normalize_requested_rlm_subagent_thinking_level` — thinking level 验证（off/minimal/low/medium/high/xhigh/max）
- `normalize_requested_rlm_subagent_model` — 模型覆盖验证
- `find_rlm_model_matches` — 模型搜索/匹配

**Live Kernel 注册表（live_kernels.rs）**：进程级单例注册表，跟踪所有活跃内核的 `Weak<Inner>`，确保 `shutdown_all_live_kernels()` 能在进程退出时逐一 flush+teardown。

#### 4.1.2 Python 运行时层 — `prime-agent-runtime/src/rlm/`

**REPL 运行时（repl.py）**：
- 入口点 `python -m rlm.repl`，协议版本 3
- 在单一 `__main__` 命名空间中执行代码单元，支持 top-level `await`
- 单一 asyncio 事件循环
- 通道分离：请求在 fd 0（stdin），事件在 fd 1 的私有 dup 上
- fd 1/2 重定向到管道，pump 线程将原始字节作为 `stdout`/`stderr` 事件发送
- 快照/恢复：pickle 序列化命名空间，magic header `PRIME-AGENT-KERNEL-SNAPSHOT-V2`
- 大小限制：快照默认 256 MiB，单变量 16 MiB，结果文本 1 MiB，payload 16 MiB

**RLM Shim（__init__.py）**：
- `RLMSpawnHandle`：spawn 返回的句柄（rlm_child_id、name、session_dir、model）
- `RLMCreateSessionHandle`：create_session 返回的句柄
- `RLMSubagent`：子 Agent 注册表行（status、activity、tool_use_count、duration_ms、answer_preview 等）
- 暴露 `rlm.spawn`/`find_models`/`collect`/`list_subagents`/`delete_subagent`/`create_session`/`progress_note`/`harness`/`factory` 等 API

**Factory 状态机（factory.py）**：
- 声明式状态机规格验证与编译
- DAG sugar → machine form 编译（每个 node 变为一个 state，fan-in node 的完整依赖集编译为单一 join transition）
- `FactoryExecutor`：通过 `rlm.spawn`/`rlm.collect`/`rlm.delete_subagent` 运行 canonicalized machines
- 失败策略：`fail_fast` / `continue` / `escalate`
- 约束：MAX_NODES=1024, MAX_RETRIES=10, MAX_PARALLEL=64, MAX_CHILDREN=1,000,000

### 4.2 Continual Harness / CRUD 接口

#### 4.2.1 Rust 侧 — `pa-core/src/refinement/`

**状态模型（mod.rs）**：

```rust
pub enum RefinementKind { Prompt, Memory, Skill, Subagent, Factory }
pub enum RefinementAction { Create, Update, Delete }
pub enum HarnessScope { Local, Global }

pub struct HarnessEntry {
    id: String, kind: RefinementKind, title: String, content: String,
    path: String, scope: Option<HarnessScope>,
    reference: JsonMap, arguments: JsonMap, metadata: JsonMap,
    source: String, created_at: String, updated_at: String, version: u64,
}

pub struct HarnessState {
    schema: u64,
    entries: BTreeMap<RefinementKind, BTreeMap<String, HarnessEntry>>,
    refinements: Vec<HarnessRefinementEvent>,
}
```

五种 harness 组件类型：`prompt`（补充提示）、`memory`（持久事实）、`skill`（Python 技能）、`subagent`（子 Agent 规格）、`factory`（状态机工作流规格）。

**Refine 规划器（planner.rs）**：
- `REFINEMENT_SYSTEM_PROMPT`：详细的系统提示，指导 LLM 生成 JSON 格式的 Create/Update/Delete 编辑
- `RefinementEdit` / `RefinementProposal` 结构体
- `is_incomplete_json` / `parse_json_candidate`：截断 JSON 检测与解析
- `apply_refinement_proposal` / `rollback_proposal`：提案应用与回滚

**Refine 执行器（executor.rs）**：
- `RefineOptions`：global 标志、自定义指令、rollback_id
- `overview_for_prompt`：为 refine 提示生成 harness 概览（每 kind 40 条目上限，240 字符内容截取）
- `history_for_prompt`：为 refine 提示生成历史记录
- `generate_refinement_id`：`refine_<timestamp>` 格式 ID

**Harness 排序（ranking.rs）**：
- `harness_query_terms`：文本分词（CJK bigram 支持）
- 基于查询词的 harness 条目相关性评分
- SHA-256 digest 生成

#### 4.2.2 Python 侧 — `prime-agent-runtime/src/rlm/harness.py`

- `HarnessState` / `HarnessEntry` / `RefinementEvent` 数据类
- 本地/全局双存储（`_state_cache` 按 `(Path, HarnessScope)` 缓存）
- 文件锁（stale 检测 10s，50 次重试，0.02s 间隔）
- CJK 感知的查询分词与 bigram 匹配
- CRUD 操作：create/update/delete/query/list

### 4.3 IPython REPL 集成

**工具定义（pa-core/src/tools/ipython.rs）**：
- `create_ipython_tool_definition` — 暴露给模型的 `python_repl` 工具
- `IpythonKernelProvisioner` — 内核生命周期 seam
- `KernelExecutor` — 执行器
- `sent_agent_message_json` / `LateSentAgentMessageHandler` — agent 消息集成

**内核 bootstrap（kernel/bootstrap.rs）**：
- `build_rlm_bootstrap_code` — 生成 RLM bootstrap 代码
- `ensure_kernel_python` — 确保 Python 环境可用
- `KernelPythonSkill` — 技能导入

**协议通道**：
- 请求：fd 0（stdin），newline-delimited JSON
- 事件：fd 1 的私有 dup（在一切之前创建），确保协议帧不被 Python stdout 污染
- fd 1/2 重定向到管道，pump 线程读取原始字节
- fd 0 在 reader 线程接管后重绑定到 `/dev/null`

### 4.4 子 Agent 生成和通信 (agent_message)

#### 4.4.1 RLM 子 Agent 生成 — `pa-daemon/src/rlm_children.rs`

`rlm.spawn` / `rlm.create_session` 创建真实的 daemon 会话，每个子 Agent 运行在独立的受监督 worker 进程中（与 TS 不同，TS 在同一进程内）。

```rust
pub struct ParentIdentity {
    rlm_depth: u32,
    rlm_max_depth: u32,
    model: Option<String>,
    cwd: Option<String>,
    session_id: Option<String>,
    session_file: Option<String>,
    thinking: Option<String>,
}
```

关键超时常量：
- `TURN_DONE_WAIT_SECS = 60` — 等待父 turn 完成的时间
- `CREATE_TIMEOUT_MS = 120_000` — 创建超时
- `PROMPT_TIMEOUT_MS = 30_000` — 提示超时
- `WATCH_MAX_UNREACHABLE_POLLS = 150` — 不可达子 Agent 的最大轮询次数

#### 4.4.2 RLM Spawn 账本 — `pa-daemon/src/rlm_ledger.rs`

每 sessions 目录一个 append-only JSONL 文件，记录 spawn/rename/delete 准入事件。家族拓扑（parent/child 边、深度、名称）从该文件读回，而非从会话文件重新推导，因此历史和非驻留子 Agent 在 passivation 后仍保持 roster 可见。

```rust
pub enum RlmLedgerDeleteReason { User, ParentTeardown, Revoked, Gc }
```

约束：`RLM_LEDGER_MAX_BYTES = 32 MiB`，`RLM_LEDGER_MAX_RECORDS = 100,000`。

#### 4.4.3 Agent 消息通信 — `pa-daemon/src/agent_messaging.rs`

`agent_message`/`agent_observe` 控制器：

- `FamilyIdentity`：会话的持久家族身份（active_session_id、parent edges、rlm_depth）
- 从 worker 推送的 summary 构建，成员资格仅从 edges 推导，不从名称推导
- `same_session_file`：通过 canonical-path 相等或持久 session ID 判断同一会话
- 支持三种关系：parent、child、sibling（通过 rlm_depth 判断）

**消息投递路径**：worker-to-worker 直接 peer 投递 → supervisor-routed 回退。

#### 4.4.4 消息广播 — `pa-daemon/src/agent_message_broadcast.rs`

Supervisor 侧的 `agent_messages_status`/`_pause`/`_resume` 广播形式：
- `live_workers_in_creation_order` — 按创建顺序获取活跃 worker
- `forward_client_command` — 将客户端命令转发到特定 resident

### 4.5 /refine 自改进流水线

完整流水线（`pa-core/src/refinement/`）：

```
用户触发 /refine
    │
    ▼
[executor.rs] RefineOptions { global, instructions, rollback_id }
    │
    ├─ 如果 rollback_id → planner.rs::rollback_proposal
    │
    ▼
[executor.rs] overview_for_prompt(state) → harness 概览
[executor.rs] history_for_prompt(history) → 历史记录
    │
    ▼
[planner.rs] REFINEMENT_SYSTEM_PROMPT + 概览 + 历史 + 轨迹
    │  → LLM 调用（max_output_tokens = 32,000）
    ▼
[planner.rs] parse_proposal(reply) → RefinementProposal
    │  ├─ 直接 JSON 解析
    │  ├─ fenced code block 提取
    │  └─ brace-sliced 提取（含截断诊断）
    ▼
[planner.rs] apply_refinement_proposal(state, proposal, options)
    │  ├─ 逐条应用 Create/Update/Delete
    │  ├─ 版本递增
    │  └─ 记录 HarnessRefinementEvent
    ▼
持久化到 harness_state.json（local 或 global）
    │
    ▼
记录到 refinement_history.jsonl
```

**自动 refine 审查门**：
- `AUTO_REFINE_REVIEW_SYSTEM_PROMPT` — 决定是否应运行 /refine
- `AUTO_REFINE_REVIEW_MAX_OUTPUT_TOKENS = 4,096`
- 拒绝一次性噪声、无支撑假设、瞬态工具输出

**关键约束**：
- 基础系统提示不可变，/refine 永不重写
- 默认 scope 为 local（会话局部）
- 所有编辑仅作用于请求 scope 的存储
- 全局编辑必须为稳定跨会话经验

### 4.6 会话管理 (JSONL, 压缩, 分支)

#### 4.6.1 会话存储 — `pa-daemon/src/session_store.rs`

- **格式**：append-only JSONL，每会话一个 `<agent-dir>/sessions/<uuid>.jsonl` 文件
- **首行**：session header（版本、ID、cwd 等）
- **条目链**：parent-id 链形成树结构
- **当前版本**：`CURRENT_SESSION_VERSION = 3`
- **兼容性**：与 TS 产品布局兼容（reattach、checkpoint/resume、外部工具读取相同文件）

`SessionManager`（`pa-core/src/session/manager.rs`）负责：
- 会话创建/追加/持久化
- 崩溃修复（`repair_jsonl_damage`）
- 索引（`by_id`、`labels_by_id`、`leaf_id`）
- 窗口化存储（`WindowedSessionStore`）
- Git 上下文捕获
- 持久化监听器

#### 4.6.2 压缩 — `pa-daemon/src/compaction.rs`

`CompactionManager`：
- 每会话一个压缩槽位，每次新运行替换旧槽位
- `compact` 命令：先中断当前 turn → 设置 `isCompacting` → 发出 `compaction_start` 事件 → 执行压缩 → 追加持久条目 → 发出 `compaction_end` 事件
- `abort_compaction`：中止手动和自动运行
- 自动压缩（`auto_compaction.rs`）：基于阈值百分比（默认 95%）

#### 4.6.3 分支导航 — `pa-daemon/src/branch_navigation.rs`

会话树支持分支导航，条目通过 parent-id 链形成树结构，支持 branch_summary 条目类型。

#### 4.6.4 恢复日志 — `pa-daemon/src/journal.rs`

Append-only JSONL 恢复日志：
- 记录最新 busy/operation 状态和队列快照
- `.recovery.jsonl` 后缀
- `.orphans.jsonl` 孤儿进程日志
- `append_record` / `append_records`（批量原子写入）/ `rewrite_records`（temp+rename）

### 4.7 后台 Daemon

#### 4.7.1 Supervisor — `pa-daemon/src/supervisor.rs`

```
Supervisor
├── accept_loop     — 接受客户端连接
├── adoption        — 重启后采纳活跃会话
├── clients         — 客户端管理
├── launch_budget   — 启动预算
├── routing         — 命令路由
├── sessions        — 会话管理
├── signals_shutdown — 信号处理与关闭
├── supervision     — 监督（重启退避，有界尝试）
├── worker_lifecycle — worker 生命周期
└── update_restart  — 更新重启
```

**架构**：每活跃会话一个 worker 进程（不在进程内托管会话）。worker 受监督，带退避重启，会话在磁盘上持久化（append-only JSONL），因此即使 supervisor 重启也能 reattach。

#### 4.7.2 Session Engine — `pa-daemon/src/engine.rs`

`SessionEngine` trait 定义 turn 行为契约：

```rust
pub trait SessionEngine: Send + Sync {
    fn run_prompt(&self, prompt: PromptRequest, ...) -> impl Future<Output = ...>;
    fn abort_auto_compaction(&self);
    fn goal_state_value(&self) -> Value;
    fn can_passivate_worker(&self) -> bool;
    fn release_settled_child_kernel(&self);
    // ... 更多方法
}
```

Worker 拥有会话存储、队列、事件排序和 wire 帧化；Engine 拥有 turn 行为。

### 4.8 Autonomous Mode

**`pa-core/src/autonomous/`**：

```rust
pub trait AutonomousDriver: Send + Sync {
    fn account_message(&self, state: &mut AutonomousRuntimeState, message: &AssistantMessage);
    fn after_turn<'a>(&'self, state: &'a mut AutonomousRuntimeState, message: &'a AssistantMessage)
        -> AutonomousFollowUpFuture<'a>;
}

pub enum AutonomousFollowUp {
    Inactive,
    Continue { text: String },
    Stop { reason: AutonomousStopReason, status: Box<AgentAutonomousStatus> },
}

pub enum AutonomousStopReason {
    GatePassed,
    GateRetryExhausted,
    Limit(AutonomousLimitReason),
}
```

**默认限制**：
- `DEFAULT_MAX_CONTINUATIONS = 3`
- `DEFAULT_MAX_TURNS = 12`
- `DEFAULT_MAX_TOKENS = 80,000`
- `DEFAULT_TIMEOUT_MS = 30 分钟`
- `DEFAULT_GATE_MAX_RETRIES = 3`
- `DEFAULT_GATE_TIMEOUT_MS = 5 分钟`
- `DEFAULT_SUBAGENT_KEEP_ALIVE_MS = 25 分钟`

**续行提示**：当无人类输入时，注入默认续行文本，指示 Agent 继续工作、合理假设、用可观测证据证明阻塞。

**门控评估（gates.rs）**：`should_autonomously_continue` — 运行配置的门控命令，决定是否继续。门控通过仅意味着该门控验证的内容通过；达到限制不意味着任务成功。

---

## 五、关键数据结构

### 5.1 Wire/Domain 类型 (pa-types)

| 类型 | 说明 |
|------|------|
| `JsonMap` | `serde_json::Map<String, Value>` — JSON 对象 map，用于不透明 payload 和未知字段 catch-all |
| `JsNumber` | f64 新类型，实现 JS `JSON.stringify` number parity |
| `AgentMessage` | Agent 层消息（含 role、content blocks、tool calls） |
| `SessionHeader` | 会话文件首行（版本、ID、cwd、git context） |
| `EntryBase` | 会话条目基类（id、parentId、timestamp） |
| `DaemonCommand` | daemon wire 命令（tagged union） |
| `DaemonOutbound` | daemon wire 出站帧 |
| `DaemonWorkerDescriptor` | worker 描述符（ID、PID、socket path、lifecycle） |
| `GoalState` | 目标状态（objective、status、token_budget、tokens_used） |
| `CompactionEntry` | 压缩条目 |

### 5.2 Agent 层类型 (pa-agent)

| 类型 | 说明 |
|------|------|
| `Agent` | 拥有 agent 状态、消息队列、事件监听器、活跃运行生命周期 |
| `AgentStateSnapshot` | 状态快照（system_prompt、model、tools、messages、is_streaming） |
| `AgentOptions` | 构造选项（initial_state、convert_to_llm、stream_fn、hooks） |
| `AgentLoopConfig` | 循环配置（temperature、max_tokens、reasoning、session_id、api_key） |
| `Model` | 模型标识（provider、id、name） |
| `ThinkingLevel` | 思考级别枚举 |

### 5.3 Harness 类型 (pa-core/refinement)

| 类型 | 说明 |
|------|------|
| `HarnessState` | 持久 harness 状态（schema + entries by kind + refinements） |
| `HarnessEntry` | 单个可编辑 harness 条目 |
| `RefinementEdit` | 一次编辑（action + kind + id + content + ...） |
| `RefinementProposal` | 提案（summary + rationale + expected_outcome + edits） |
| `HarnessRefinementEvent` | 精炼事件记录 |
| `RefinementPlan` | 已规划的精炼（proposal + id + rollback info） |

### 5.4 Autonomous 类型 (pa-core/autonomous)

| 类型 | 说明 |
|------|------|
| `AgentAutonomousConfig` | 用户配置（enabled、limits、gates、keep_alive） |
| `AutonomousLimits` | 归一化后的硬限制 |
| `AgentAutonomousStatus` | 运行时状态（used 计数、limits、gates、attempts） |
| `AutonomousRuntimeState` | 内部运行状态 |

### 5.5 RLM 类型

| 类型 | 说明 |
|------|------|
| `RlmModelInfo` | 目录模型信息（provider、id、name） |
| `RlmModelMatch` | 搜索匹配结果 |
| `FamilyIdentity` | 会话家族身份（active_session_id、parent edges、rlm_depth） |
| `ParentIdentity` | 父会话身份（rlm_depth、model、cwd、session_id） |
| `RLMSpawnHandle` (Python) | spawn 返回句柄 |
| `RLMSubagent` (Python) | 子 Agent 注册表行 |

---

## 六、系统提示架构

系统提示采用分层组装（`pa-core/src/prompts/system_prompt.rs`）：

```
[Static Prefix — cache-stable]
├── core                    — 核心 harness 描述 + 完整 API 面
├── usage                   — 强制使用规则
├── guidelines              — 惯用指南
└── model_prompt_extras     — 按模型的补充提示（TOML rule map）

[Dynamic Tail — session-specific]
├── packages                — 包上下文
├── environment             — 环境信息
├── skills                  — 技能清单
├── mcp_servers             — MCP 服务器
├── cwd                     — 工作目录
├── session_role            — 会话角色
└── append_system_prompt    — 追加提示

[harness-digest]            — 独立 user message
```

`SystemPromptBreakdown` 记录 `cached_prefix_len`：`assembled[..cached_prefix_len]` 在共享相同 custom-prompt 和 model-selection 输入的每个会话中字节相同——支持 provider 缓存。

---

## 七、技能体系

14 个内置技能，每个为可导入 Python 包：

| 技能 | 用途 |
|------|------|
| `agent-message` | `agent_message.send` — Agent 间直接通信 |
| `agent-observe` | `agent_observe` — 观察其他 Agent 状态 |
| `attach-image` | 图片附加到消息 |
| `compact` | 上下文压缩 |
| `edit` | 文件编辑工具 |
| `factory` | Factory 状态机工作流 |
| `goal` | 线程目标管理 |
| `mcp` | MCP 服务器管理 |
| `prime-intellect` | Prime Intellect 平台集成 |
| `refine` | /refine 自改进 |
| `rlm-heartbeat` | RLM 心跳 |
| `skill-creator` | 技能创建器（将重复工作流转为技能） |
| `websearch` | 网页搜索 |

**RLM kernel API 面**（暴露给模型的工具）：`bash`、`edit`、`python_repl`（内部 helper：`rename`、`stdout`）。

**RLM kernel 内 API**（在持久 Python REPL 中）：`rlm.spawn/find_models/collect/list_subagents/delete_subagent/create_session/progress_note`、`rlm.harness` CRUD、`agent_message.send`、`agent_observe`、`compact`、`goal`、`refine`、`attach_image`、skills（markdown + Python）。

---

## 八、可靠性模型

### 8.1 Daemon 监督架构

```
Supervisor (单进程)
├── Worker 1 (会话 A) — 独立进程，带退避重启
├── Worker 2 (会话 B) — 独立进程
├── Worker 3 (会话 C) — 独立进程
└── ...
```

- 每活跃会话一个 worker 进程
- worker 受监督，带退避重启（`MAX_CONSECUTIVE_FAILURES`、`STABLE_LIFETIME_MS`）
- 会话在磁盘持久化（append-only JSONL）
- supervisor 重启后可采纳活跃会话（adoption）
- 恢复日志记录 busy/operation 状态和队列快照
- 孤儿进程日志记录子进程状态

### 8.2 代码质量约束

- **无 stubs**：禁止 `todo!()`、禁止吞错误（`anyhow` 冒泡到 UI 可接受）
- **零警告姿态**：`fmt + clippy + tests` 在 `-D warnings` 下运行
- **Parity 门控**：每个触及用户可见面的 PR 必须包含与 TS 二进制的 parity-diff 证据
- **文件大小**：目标 < 2,000 行（含测试），2,000-2,100 为软审查信号
- **性能关键路径**：UI 首次绘制及每帧不得阻塞于网络、磁盘同步或后台记账

---

## 九、架构特点总结

### 9.1 双语言架构

Prime Agent 采用 **Rust + Python** 双语言架构：
- **Rust** 承担所有宿主职责：daemon 监督、wire 协议、会话存储、Provider API、TUI、CLI——高性能、内存安全、零成本抽象
- **Python** 承担 RLM 运行时：持久化 REPL、harness 状态、factory 状态机——灵活的动态语义、丰富的科学计算生态

两者通过 **newline-delimited JSON 协议（v3）** 通信，Rust 宿主通过 stdin 发送请求，Python 运行时通过私有 fd dup 返回事件。

### 9.2 递归 Agent 架构

RLM 的核心创新在于将上下文视为变量、将子 Agent 视为函数调用：
- `rlm.spawn("sub-task", name="worker")` 创建真实 daemon 会话（非进程内模拟）
- 每个子 Agent 运行在独立受监督 worker 进程中
- 子 Agent 通过 `agent_message.send(message, receiver_role="parent")` 回复
- 家族拓扑通过 append-only ledger 持久化，支持 passivation 后恢复
- 支持 RLM 深度限制（`DEFAULT_RLM_MAX_DEPTH`）防止无限递归

### 9.3 自改进 Harness

Continual Harness 是 Prime Agent 的自改进机制：
- 五种组件类型（prompt/memory/skill/subagent/factory）覆盖可复用行为的全谱
- `/refine` 通过 LLM 生成小的、有证据支撑的编辑，永不重写不可变基础系统提示
- 支持 local/global 双 scope，默认 local（会话局部）
- 完整的回滚机制（rollback_id）和精炼历史
- 自动 refine 审查门过滤噪声

### 9.4 长时运行支持

Prime Agent 专为长时运行任务设计：
- **Daemon 持续性**：终端断开后会话、REPL 状态、调度和子 Agent 继续运行
- **心跳与调度**：`/heartbeat`、`rlm_heartbeat`、`prime-agent schedule` 定期或定时重入会话
- **持久目标**：`/goal` 跨 turn 保持目标及其进度
- **有界自主模式**：`/autonomous` 在配置的 turn/token/时间预算内续行，支持用户定义质量门控
- **自动压缩**：基于阈值百分比的自动上下文压缩，保留历史和摘要空间

### 9.5 严格的工程纪律

- **Crate 所有权**：每 crate 一个拥有领域，`pa-types` 唯一共享词汇，无环依赖
- **Parity 优先**：Rust 移植必须与 TS 参考实现字节级兼容（wire 协议、会话文件、UI 行为）
- **性能门控**：首次绘制的 launch 基准测试是合并门控，遥测不得阻塞渲染路径
- **类型安全**：`unsafe_code = "forbid"`（workspace 级），wire struct 全部携带 catch-all `JsonMap`
- **测试纪律**：Bug 修复需要回归测试，验证器优于自评估（tmux 用户级测试、TS 二进制差分测试、golden corpus）

---

## 十、文件统计

| Crate | .rs 文件数 | 主要职责 |
|-------|-----------|----------|
| pa-types | 43 | 共享 wire/domain 类型 |
| pa-telemetry | 17 | 遥测事件与 sink |
| pa-agent | 14 | Agent 循环 |
| pa-ai | 80 | Provider API 与流式传输 |
| pa-models | 11 | 模型目录 |
| pa-core | 100+ | 会话引擎（核心） |
| pa-daemon | 100+ | 监督者与 wire 协议 |
| pa-tui | 100+ | 终端 UI |
| pa-cli | 79 | CLI 组合根 |
| **合计** | **550+** | — |

Python 运行时：10 个源文件（`__init__.py`、`repl.py`、`harness.py`、`factory.py`、`bash.py`、`mcp.py`、`mcp_base.py`、`skill.py`、`_winjob.py`、`repl.md`）。

---

*报告结束*
