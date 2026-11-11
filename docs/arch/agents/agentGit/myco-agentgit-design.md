# myco × Agent-Git:Agent 会话版本控制 / 回滚集成设计(v1)

> 设计日期:2026-10-28
> 参考实现:Agent-Git v0.2.0-alpha(`/data/s00791175/Agent-Git`,Python + LangGraph,3830 行核心代码)
> 目标仓库:`/data/s00791175/myco-test/myco-1014`(myco,Node + claude-agent-sdk)
> 新代码落点:`server/src/agents/agentgit/`

---

## 0. 结论先行:有集成可能性,方式是"概念移植"而非"代码引入"

**Agent-Git 是什么**:一个给 LangGraph agent 加 Git 式版本控制的包——
Commit State(状态快照)/ State Revert(非破坏性回滚,回滚即开新分支)/
Branching(并行探索)/ Tool Revert(按调用记录逆向工具副作用)。三层模型:
ExternalSession(用户可见容器)→ InternalSession(单个 agent 实例,可回滚)→
Session History(消息 + 工具调用序列)。SQLite/PostgreSQL 持久化,auto-checkpoint
在每次工具调用后自动打点。

**为什么不能直接引入代码**(三条硬差距):

| # | Agent-Git 的假设 | myco 的现实 | 结论 |
|---|---|---|---|
| 1 | agent 是**自己搭的 LangGraph StateGraph**:`agent → tools → checkpoint` 三节点循环,状态是一个可整体序列化的 dict | agent 是 **claude-agent-sdk 的黑盒会话**,上下文由 SDK/网关托管,myco 只拿到事件流 + `resume: sdkSessionId` | LangGraph 图层整个不适用;但 SDK 恰好提供等价原语:`resume` + `forkSession` + `enableFileCheckpointing`(见 §2.1) |
| 2 | Checkpoint = `session_state` + `conversation_history` 两个字段直接 dump | myco 拿不到 SDK 内部对话 state,只有 `transcript.js`/events.jsonl 的事件历史 | checkpoint 需改为"SDK 会话句柄 + 事件位点 + 工作区文件快照"的组合 |
| 3 | LLM 层用 LangChain `ChatOpenAI`,工具层 `ToolNode` | 模型经 myco 网关(Claude Agent SDK),工具经 MCP / 内置 tools | 模型与工具封装层完全替换 |

**为什么概念层值得移植**:myco 目前已经有零散的"类 checkpoint"机制
(critique.js 的 stage-checkpoint、artifacts.js 的 originalText 快照、board 的
append-only 事件),但**没有统一的会话版本控制层**:用户没法把一次失败的
n2 团队运行回滚到某个工具调用点重试,也没法从同一状态开出两条探索分支。
Agent-Git 的三层模型恰好是这块缺的骨架,而且它的两个核心设计决策
(回滚=非破坏性新分支、工具逆向=按 invocation record 的账本)不依赖任何
LangGraph 机制,可原样落到 Node。

---

## 1. Agent-Git 机制盘点(可移植性逐项评估)

| 机制 | 代码位置 | 依赖 LangGraph? | 移植到 myco 的方式 |
|---|---|---|---|
| ExternalSession / InternalSession 两级会话 | `sessions/*.py`, `database/models.py` | 否(纯数据模型) | **直接移植**:myco 现在只有一级 `AgentSession`;新增"会话树"层 |
| Checkpoint(commit) | `checkpoints/checkpoint.py` | 部分(state dict 来自 LangGraph) | 重定义:SDK 句柄 + 事件位点 + 文件快照(§3.2) |
| 非破坏性回滚(rollback → 新 internal session 分支) | `rollback_agent.py` | 否(核心是"复制 state 到新 session") | **直接移植**:利用 SDK `forkSession`,语义天然吻合 |
| auto-checkpoint(每次工具调用后打点) | `_checkpoint_node` | 是(图节点) | 改为事件流订阅:AgentSession 已有工具事件总线,挂监听器节流打点 |
| Tool Rollback Registry(`ToolSpec{forward,reverse}` + invocation record) | `core/rollback_protocol.py` | **否**(189 行,纯协议) | **几乎原样移植**到 TypeScript;reverse 函数对接 myco 工具 |
| 两级回滚(simple reversion for state-independent / compensating action for path-dependent) | `rollback_agent.py` | 否 | 原样移植为两类 reverse handler |
| Diff(两个 checkpoint 之间的 state/tool/对话变更) | `checkpoints/diff.py`(370 行,纯函数) | 否 | 原样移植;diff 对象改为事件与文件变更 |
| User/Auth | `auth/*` | 否 | **不移植**——myco 已有 auth.js,多用户场景才需要,一期跳过 |
| MemorySaver checkpointer | `rollback_agent.py` | 是 | 不移植——持久化由 SDK sessionStore + SQLite 账本承担 |

---

## 2. myco 侧的接入点(已存在的能力)

### 2.1 SDK 原语(这是集成可行的根本原因)

`server/src/agent-session.js:44-58` 的 `SDK_OPTIONS_ALLOWLIST` 里已经允许:

- **`resume` / `sessionId`** — 按 `sdkSessionId` 恢复会话(agent-session.js 每轮
  `.write()` 都在用,"resumes SDK session by id");
- **`forkSession`** — 从既有会话分叉新会话,**不污染原轨迹**——这正是
  Agent-Git "非破坏性回滚"想要的语义,SDK 层原生提供;
- **`enableFileCheckpointing`** — SDK 自带文件级 checkpoint,可作为工作区
  快照的底层实现之一。

也就是说:Agent-Git 在 LangGraph 里**自己实现**的三件事(复制 state、开新
session、恢复),claude-agent-sdk **原生就有对应物**。集成不是把 LangGraph
塞进 myco,而是把 Agent-Git 的**账本与树结构**架在 SDK 这三个原语上。

### 2.2 已有的事件与状态基础

- **事件流**:AgentSession 每轮把事件追加进 `events.jsonl`(12 MB 上限滚动),
  `transcript.js` 已能重建对话——对应 Agent-Git 的 `conversation_history`;
- **工具事件**:工具调用(含参数、结果)在事件流里可见——对应
  `tool_invocations` 账本的原始数据源;
- **team-session / board**:`agent-n2` 的 DelmBoard 本身是 append-only 事件,
  可作为 n2 会话 checkpoint 的一部分一并入账;
- **critique.js 的 stage-checkpoint**:已经是"运行中打点"的雏形,可收敛到新层。

---

## 3. 设计方案

### 3.1 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ myco server(单 Node 进程,现状)                              │
│                                                              │
│  AgentSession(agent / agent-n2 模式)── 事件流 ──┐           │
│                                                  │           │
│  ┌───────────────────────────────────────────────▼────────┐  │
│  │ server/src/agents/agentgit/   ← 新增层(全部新代码)     │  │
│  │                                                          │  │
│  │  SessionTree      ExternalSession → InternalSession 树  │  │
│  │                  (回滚/分支 = forkSession 派生新节点)   │  │
│  │  CheckpointStore  commit = {sdkSessionId, eventCursor,  │  │
│  │                    fileSnapshot?, toolLedger 快照}      │  │
│  │  ToolRollbackRegistry  ToolSpec{forward, reverse}       │  │
│  │                  + invocation ledger(append-only)       │  │
│  │  DiffEngine       两 checkpoint 间 diff(移植 diff.py)  │  │
│  │  AgentGitMCP      把 commit/branch/revert/diff 暴露为   │  │
│  │                  mcp__agentgit__* 工具给 agent 自己用   │  │
│  └──────────────┬───────────────────────────────────────────┘  │
│                 │ forkSession / resume / sessionId               │
│                 ▼                                             │
│        claude-agent-sdk(黑盒会话,网关模型)                   │
│                 ▼                                             │
│  SQLite 账本(会话树 + checkpoints + tool invocations)         │
└──────────────────────────────────────────────────────────────┘
```

设计原则(与 sdk/、rlm 设计一致):**引擎零改动**——AgentSession、
team-session、local-claude 不动;新层只通过(a)已有事件订阅、(b)SDK
options 透传 `forkSession`/`resume`,两个既有接口接入。

### 3.2 数据模型(SQLite,一张账本库)

```sql
-- 对应 Agent-Git ExternalSession:myco 的一级会话(agent-session id)
CREATE TABLE external_sessions (
  id INTEGER PRIMARY KEY,
  session_name TEXT, mode TEXT DEFAULT 'agent',   -- agent | agent-n2
  created_at TEXT
);

-- 对应 InternalSession:一条"轨迹"(rollback/branch 会派生新的行)
CREATE TABLE internal_sessions (
  id INTEGER PRIMARY KEY,
  external_session_id INTEGER NOT NULL REFERENCES external_sessions(id),
  parent_session_id INTEGER REFERENCES internal_sessions(id), -- 分支来源
  branched_from_checkpoint INTEGER REFERENCES checkpoints(id),
  sdk_session_id TEXT,            -- claude-agent-sdk 会话句柄
  created_at TEXT
);

-- 对应 Checkpoint:commit 状态
CREATE TABLE checkpoints (
  id INTEGER PRIMARY KEY,
  internal_session_id INTEGER NOT NULL REFERENCES internal_sessions(id),
  name TEXT, is_auto INTEGER DEFAULT 0,
  sdk_session_id TEXT,           -- 打点时的 SDK 句柄(分支/恢复的 resume 目标)
  event_cursor INTEGER,          -- events.jsonl 的位点(重建 transcript 用)
  conversation_tail TEXT,        -- 最近 N 条消息的 JSON(展示/恢复上下文用)
  tool_invocations TEXT,         -- 账本快照 JSON(回滚时要逆向哪些调用)
  file_snapshot_ref TEXT,        -- 可选:工作区快照引用(tar 或 SDK fileCheckpoint)
  created_at TEXT
);

-- 工具调用账本(Agent-Git ToolInvocationRecord 的持久化)
CREATE TABLE tool_invocations (
  id INTEGER PRIMARY KEY,
  internal_session_id INTEGER NOT NULL,
  checkpoint_id INTEGER,         -- 该调用发生在哪个 commit 之后
  seq INTEGER,                   -- 会话内单调序号(逆向按倒序回放)
  tool_name TEXT, args TEXT, result_summary TEXT,
  success INTEGER, error_message TEXT,
  reversible INTEGER DEFAULT 0,  -- 是否注册了 reverse handler
  reverted_at TEXT,              -- 非空 = 已被逆向(幂等保护)
  created_at TEXT
);
```

与 Agent-Git 的模型差异只有一处实质变化:`checkpoints.session_state`
(整份 LangGraph state dict)换成 **`sdk_session_id + event_cursor + 文件快照引用** ——
因为 myco 的"state"在 SDK 手里,我们记录的是**恢复所需的最小句柄集**。

### 3.3 核心操作语义

全部四个操作都映射到 SDK 原语,不碰引擎:

| Agent-Git 操作 | myco 实现 | 依赖的 SDK 原语 |
|---|---|---|
| `commit`(create_checkpoint) | 在当前 internal session 上写一行 checkpoint:记录 sdkSessionId、事件位点、账本快照 | 无副作用,纯记账 |
| `branch`(branching) | 新建 internal_sessions 行(parent=当前,branched_from=目标 commit),`query({forkSession: true, resume: 目标 commit 的 sdkSessionId})` 派生 SDK 会话 | **forkSession** |
| `revert`(rollback_to_checkpoint) | ① 从账本倒序逆向目标 commit 之后的工具调用;② 同 branch 一样 fork 出新 internal session(非破坏性);③ 原轨迹保持可查 | **forkSession** + ToolRollbackRegistry |
| `diff` | DiffEngine 对比两个 checkpoint 的 conversation_tail / tool_invocations / 文件变更 | 纯本地计算 |

两个继承自 Agent-Git 的关键决策:

1. **回滚 = 分支**(非破坏性)。永远不删除任何轨迹——revert 只是"从旧 commit
   开新枝"。这让 n2 团队的失败运行可以安全回滚重试,board 事件历史仍然完整可审计。
2. **工具逆向分两类**:
   - *state-independent*(如写文件):直接 inverse(恢复 file_snapshot 里的旧内容,
     或 `Write` 反向为恢复 originalText——artifacts.js:1026 已有先例);
   - *path-dependent*(如发外部请求、改 git):执行**补偿动作**(compensating
     action),由各工具的 reverse handler 声明,做不到的标记 `reversible=0`,
     revert 时如实报告"该副作用无法自动逆向",不静默失败。

### 3.4 ToolRollbackRegistry(TypeScript 版,移植自 rollback_protocol.py)

```ts
// server/src/agents/agentgit/tool-rollback-registry.ts
export interface ToolSpec {
  name: string;
  // reverse 收到当时的 invocation record + 补偿所需的上下文
  reverse?: (rec: ToolInvocationRecord) => Promise<ReverseResult>;
  category: 'state-independent' | 'path-dependent' | 'irreversible';
}
export class ToolRollbackRegistry {
  register(spec: ToolSpec): void;
  record(inv: ToolInvocationRecord): void;      // 来自 AgentSession 工具事件订阅
  revertAfter(checkpointId: number): Promise<ReverseReport>; // 倒序回放、幂等(reverted_at)
}
```

一期注册的 reverse(与 myco 现有工具面对齐):

| 工具 | 类别 | reverse 实现 |
|---|---|---|
| Write / Edit | state-independent | 打点时把旧内容存入 file_snapshot;reverse = 写回旧内容 |
| Bash | path-dependent(部分) | 只对声明了 `--agentgit-undo` 提示的命令做补偿;其余 irreversible |
| board 写操作 | state-independent | DelmBoard 已是 append-only;reverse = 追加一条补偿事件(与现有设计一致) |
| MCP 外部工具 | irreversible(默认) | 记账但不逆向;`reversible=0` |

### 3.5 打点时机(auto-checkpoint 的移植)

Agent-Git 在 LangGraph 图里插 checkpoint 节点;myco 改用**事件驱动节流**:

- 订阅 AgentSession 的工具事件流(已有);
- 规则:每次"高副作用"工具(Write/Edit/Bash)成功后自动打 `is_auto=1` 的
  commit;纯读工具(Read/Grep)不打;同一 turn 内合并(避免 5 次连续小 Edit
  产生 5 个 commit);
- 用户/agent 可显式 commit(命名 commit)。
- auto commit 保留上限(如每 internal session 最近 50 个,超出清最老的
  auto commit——对应 Agent-Git 的 `cleanup_auto_checkpoints` 工具)。

### 3.6 暴露方式:三层入口

1. **MCP 工具(给 agent 自己用)**——`server/src/agents/agentgit/mcp-server.js`
   按 `mcp/board-mcp.js` 的模式实现,暴露:
   `agentgit_commit / agentgit_list_commits / agentgit_revert / agentgit_branch /
   agentgit_diff`。这让 agent 在长任务里**自主**打点与回退(对 RLM/长 REPL
   运行尤其有价值:探索失败即 revert,不烧上下文)。
2. **slash 命令(给用户用)**——`/agentgit commit|log|revert|branch|diff`,
   挂进现有 slashcmds.js;`/agentgit log` 输出 commit 树。
3. **HTTP/库接口(给 bench 用)**——`sdk/` 增加
   `POST /checkpoint-op {op:'commit'|'revert'|'branch', session, checkpoint}`,
   让 bench/hle 的 n2 失败样本可以"回滚到出错前重试"——这是评测侧最直接的收益。

### 3.7 n2(team-session)的覆盖

- checkpoint 粒度放在 **TeamSession 级**(不是单 worker 级):commit 快照包含
  board 事件位点 + 两个 worker 的 sdkSessionId + 工作区快照;
- revert 一个 n2 commit = 逆向工具账本 + 从 fork 点重启 TeamSession
  (board 从事件位点重建——board 的 append-only 事件已保证可回放,见
  agent-n2.md);
- 分支出的 n2 轨迹可换用不同 prompt/模型配置重跑,天然成为 **A/B 探索车道**
  (与 compare-lanes.js 的多车道对比互补)。

---

## 4. 分期实施

| 期 | 内容 | 交付判据 |
|---|---|---|
| **P0(验证,~1 天)** | 手工验证 SDK `forkSession` + `resume` 组合在 myco 网关下真实可用:同一 sdkSessionId fork 出两条轨迹、各自独立演化、原轨迹不受影响 | 一个最小脚本,两个分支各自的 transcript 互不污染 |
| **P1(账本+commit,~3 天)** | SQLite 三张表 + CheckpointStore + 事件订阅 auto-commit;`/agentgit commit|log`;DiffEngine(移植 diff.py) | agent 跑任务后能列出 commit 树、两 commit 间 diff |
| **P2(回滚,~3 天)** | ToolRollbackRegistry + Write/Edit reverse(文件快照);revert 全链路(账本逆向 + fork 新 internal session) | 任务中途 revert,文件状态恢复,新轨迹可继续,旧轨迹可查 |
| **P3(MCP+分支探索,~2 天)** | agentgit MCP 五工具;`/agentgit branch`;SDK 侧把五工具注入 allowedTools | agent 在一次运行内自主 commit/revert(在 prompt 里声明使用) |
| **P4(n2 + bench,~2 天)** | TeamSession 级 checkpoint;n2 revert 重启;sdk `/checkpoint-op`;bench 重试接入 | n2 失败样本回滚重跑的端到端样例 |

P0 是硬门槛:如果 `forkSession` 在当前网关/SDK 版本下不可用,整个方案退化为
"仅记账 + 人工重建会话"(价值大打折扣),需重新评估。

---

## 5. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| `forkSession` 在 myco 使用的 SDK 版本/网关下行为未验证(allowlist 允许 ≠ 路径上用过) | 分支/revert 两大操作落空 → P0 前置验证 | P0 脚本;失败则降级为 resume-only(有损回滚:重建上下文靠 conversation_tail 重放) |
| SDK 会话句柄的持久性/过期:sdkSessionId 跨进程重启是否可 resume | 长任务的 commit 跨重启失效 | AgentSession 已有 per-turn-resume 机制在用 `resume`,说明句柄至少进程内稳定;跨重启需 P1 实测 |
| 事件位点(events.jsonl 12 MB 滚动截断)与 checkpoint 对不上 | 老 commit 的 transcript 重建失败 | checkpoint 落库时把 conversation_tail 一并存进 SQLite(不依赖 jsonl 存活);cursor 只用于增量 |
| 工作区文件快照体积 | 大仓库频繁 commit 膨胀 | 快照只含**该 turn 被 Write/Edit 的文件**(打点时从工具事件可知),不做全量 tar |
| Bash 类副作用不可逆 | revert 语义有洞 | 如实报告不可逆项;Bash reverse 只在命令自带 undo 提示时启用 |
| 与 RLM 设计(docs/arch/agents/rlm/)的边界 | 两层都管"状态" | 互补关系:RLM 管**单次运行内**的上下文变量化;agentgit 管**跨运行**的轨迹版本控制。两者通过 P3 的 MCP 工具衔接(RLM 内核失败时调 agentgit_revert)。文档互链,不共享存储 |

## 6. 不做的事(明确出界)

- 不引入 LangChain/LangGraph 依赖(纯 Node + SDK);
- 不移植 Agent-Git 的 User/Auth(单用户环境,myco 已有 auth);
- 不做多用户 checkpoint 隔离、不做 PostgreSQL(PostgreSQL 只是 db_config 的
  一个 variant,SQLite 足够);
- 不试图逆向 MCP 外部工具的副作用(默认 irreversible,只记账)。
