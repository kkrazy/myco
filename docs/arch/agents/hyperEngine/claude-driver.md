# hyperEngine Driver —— claude（Claude Agent SDK，默认引擎 / 恒等驱动）

> 状态：**设计方案（未实现）。** hyperEngine 引擎注册/选择/调度层的**默认**引擎驱动。
> 依据仓库：https://github.com/anthropics/claude-agent-sdk-typescript.git
> （npm 包 `@anthropic-ai/claude-agent-sdk`，CHANGELOG 至 v0.3.316；公开仓库只含 README +
> CHANGELOG + examples，源码经 npm 发布）。本文同时锚定 myco 现有消费点
> （`server/src/agent-session.js` / `local-claude.js` / `sessions.js` / `team-session.js`，
> develop @ ac81c4e）。

---

## 1. claude SDK 真实能力盘点（调研结论）

Claude Agent SDK（前身 Claude Code SDK）以**进程内 SDK 驱动 Claude Code CLI 子进程**的
形态工作：`query()` 返回 `AsyncIterable<SDKMessage>`，SDK 与 CLI 之间走 stdio 上的 JSON
控制协议。**引擎本体 = CLI 二进制**（`extractFromBunfs()` 内嵌，0.2.113 起为平台原生二进制）。

### 1.1 核心模型

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'

// 一次性：
for await (const m of query({ prompt: '...', options })) { ... }
// 多轮：prompt 传 AsyncIterable<SDKUserMessage>（myco 的 AsyncMessageQueue 形态），
//       或 options.resume = sessionId 续会话。
// v2 session API（unstable_v2_createSession 等）已于 0.3.142 移除 —— 设计不得依赖。
```

- **resume**：`options.resume: sessionId`；`resumeSessionAt` / `resumeDropsTurn`（0.3.223）、
  `forkSession()` 精细控制。myco 的 `sdkOpts.resume = this.sdkSessionId` 即此通道。
- **warm 通道**：`startup()` 预热（首查 ~20× 提速）；`prewarm()` + `SpareProcess.claim()`
  （0.3.282，alpha）可先起进程后绑定会话——性能优化期可考察，不影响驱动契约。
- **Query 级控制方法**（`query()` 返回的 handle 上）：`setModel()`、`setPermissionMode()`、
  `setMcpServers()`、`interrupt({cancel_queued})`、`close()` 等——myco 已用 `stream.setModel()`
  （agent-session.js:703）。

### 1.2 Options 关键面（驱动 overlay 的合法杠杆）

| Option | 语义 | 驱动使用 |
|---|---|---|
| `env` | **整体替换**子进程环境（0.2.113 breaking；不与 process.env 合并） | 必须 `{...process.env, ...overlay}` 展开（见 §2.1） |
| `model` | 会话级模型选择 | 经 `engineOptions` 映射到 `sdkOpts.model` |
| `resume` | 按 sessionId 续会话 | 透传 myco `sdkSessionId` |
| `systemPrompt` | 合并式系统提示 | 驱动不碰；RLM/harness 叠加保持现状 |
| `canUseTool` | 权限回调 → `{behavior:'allow'\|'deny'\|'ask', …}` | 驱动**直通** myco `_canUseTool`（恒等） |
| `permissionMode` | `'default'\|'acceptEdits'\|'plan'\|'bypassPermissions'\|'auto'` | 驱动不碰 |
| `mcpServers` | 含 `createSdkMcpServer` 进程内服务器 | 驱动不碰（myco_mcp / lean-ctx / board / rlm 全在此） |
| `settings` + `settingSources` | `['user','project','local']`，缺省**不读**文件系统配置 | 驱动不碰 |
| `hooks` | PreToolUse / PostToolUse / Stop / SessionStart… | 驱动不碰（allow-list Pre 钩子在此） |
| `agents` | 子 agent 定义 | 驱动不碰 |
| `sessionStore` | 可插拔转录镜像（alpha） | 见 §6.2：hyperEngine 审计缝 |
| `executable` / `pathToClaudeCodeExecutable` / `extraArgs` | CLI 二进制与追加参数 | claude 驱动**不用**（恒等默认） |

### 1.3 SDKMessage 事件流（hyperEngine 的规范事件模型）

`query()` 产出的联合类型（驱动 normalize 的**恒等基准**——其它引擎都向它对齐）：

- `system/init`：`session_id`、`model`、`tools`、`skills`、`mcp_servers`、
  `claude_code_version`、`capabilities`（interrupt_receipt_v1 等能力协商面）。
- `system/*` 其它子类型：`status`、`api_retry`、`model_fallback`、`informational`、
  `permission_denied`…
- `assistant` / `user`：content blocks；`stream_event`（`includePartialMessages` 时）承载
  content_block 增量（打字机流）。
- `result`（终帧）：`subtype`（`success` / `error_max_turns` / `error_during_execution` /
  `error_max_budget_usd`…）、`is_error`、`total_cost_usd`、`usage`（本轮主循环）vs
  `modelUsage`（累计，**计费字段**）、`terminal_reason`、`num_turns`、`duration_api_ms`。
- 任务/生命周期帧：`task_started` / `task_progress` / `command_lifecycle` /
  `rate_limit_event` / `hook_*`。

**取整条轮次收尾信号 = `result` 帧**（与 opencode `session.idle`、codex `TASK_COMPLETE`、
dsh `turn/end`+`result` 对齐——见各兄弟 driver 文档）。

---

## 2. 驱动形态：恒等驱动（identity driver）

claude 驱动是 hyperEngine 里的**零叠加基准**：myco 现有调用链就是「claude 引擎 + 全部
现有注入」，因此驱动不做任何改写，只把统一 Driver 契约**透传**到既有代码路径。

### 2.1 overlay 契约（P0 壳阶段）

```js
// drivers/claude.js
module.exports = {
  name: 'claude',
  label: 'Claude (claude-agent-sdk, 默认)',
  kind: 'sdk-subprocess',            // 进程内 SDK → CLI 子进程
  capabilities: { resume: true, interrupt: true, approvals: true, eventStream: true },
  available() { return true; },       // 恒真：claude 永在候选集，随机永不落空
  overlay() { return {}; },           // 恒等：不注入 env、不改 model —— 走现状
};
```

**为什么 `overlay()` 返回空是正确的**：myco 的 `sdkOpts.env` 构造
（agent-session.js:480）本就按 SDK 文档要求的形态展开——

```js
env: { ...process.env, ...gwEnv, ...(gitEnv || {}) }
```

`options.env` 是**替换语义**（0.2.113 breaking change：不与宿主环境合并），而 myco
先展平 `process.env` 再叠 `gwEnv`（ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL，来自
`gateways.getProfile`）与 `gitEnv`——这与 SDK 文档示例 `env: {...process.env, X}` 完全
一致。claude 驱动的 overlay 叠在最后（最高优先级）但**为空** → `sdkOpts` 与现状逐字节
一致，零影响承诺由此成立。

- P0 壳阶段唯一动作（如需演示链路）：`overlay()` 返回 `{ env: { MYCO_ENGINE: 'claude' } }`
  ——无害的自标注变量，不进入任何 SDK 决策。**默认实现连这个也不加**，测试
  `claude-driver-identity` 锁定空 overlay。

### 2.2 真实阶段（P2）：恒等的意义

即便落地真实多引擎（opencode/codex/dsh 各自的 adapter 跑自己的进程/客户端），claude
驱动**依然恒等**——它不是「适配器」，它就是 myco 的本命路径。统一 `EngineDriver` 接口
（主文档 §5.2 是**唯一命名基准**）在 claude 侧的实现是**直通**：

| §5.2 `EngineDriver` 方法 | claude 实现 |
|---|---|
| `capabilities` | `{ streaming:'iterator', cancel:'abortController', permission:'canUseTool', resume:true }` —— §5.2 已按 claude 实测定型；可选在 `system/init` 帧上做能力协商（SDK 自带 `capabilities` 字段），非必需 |
| `openSession(cfg)` | `query({ prompt, options: sdkOpts })` 原样调用（agent-session.js:685 现状）；多轮输入 = 既有 `AsyncMessageQueue`（流式 prompt iterable）。`cfg.resume` → `options.resume`（agent-session.js:584）——「迭代器本身就是会话」 |
| `sendTurn(text)` | 既有 `_msgQueue` 推送（多轮共享一次 `query()`；流式输入模式），事件流 = `SDKMessage` 迭代器 |
| `approve(id, ok)` | `canUseTool` 的 resolve（既有 `_canUseTool` 回调直通；id 即 SDK 的 `requestId`） |
| `abort()` | 既有 `abortController.abort()`（SDK 文档字段名，见 agent-session.js bug-14 注）；如 handle 可用可补 `stream.interrupt({cancel_queued})` 做细粒度取消 |
| `close()` | 既有迭代收尾 + `_currentQuery` 清理（:904）；模型热切 = 既有 `stream.setModel()`（agent-session.js:703，`_appliedModel` 去重）——§5.2 表外补充能力，claude 独有 |
| normalize（内部） | **恒等/薄映射**：SDKMessage 即规范模型（见 §3）；归一层只对其它引擎翻译，claude 不翻译 |

**不加任何中间层**：claude 路径上 introduce adapter 会违背「开关没开零影响」+ 给唯一
已验证的生产路径加风险。其它驱动的 adapter 把自家事件**翻译成** SDKMessage 等价物；
claude 驱动只是「不翻译」。

---

## 3. 事件 normalize：规范模型即本引擎原生流

hyperEngine 的规范化层以 SDKMessage 为**规范事件模型**（canonical model），claude 驱动
的 normalize 表因此是**薄直通**：

| SDKMessage | myco 帧映射 | 备注 |
|---|---|---|
| `system/init` | `engine-init`（或沿用现状 system 帧处理） | 记 `session_id` → `sdkSessionId`；`capabilities` 缓存供 interrupt 协商用 |
| `assistant`（content blocks） | 既有 assistant 处理（tool_use / text 分发） | 现状即此，无新逻辑 |
| `stream_event` | 打字机增量（`includePartialMessages` 开启时） | 现状 |
| `user`（tool_result blocks） | 既有 tool-result 处理 | 现状 |
| `result` | `turn_result` 终帧 | `subtype`/`is_error`/`terminal_reason` 直传；`modelUsage` 是累计计费字段（`usage` 只是本轮） |
| `system/api_retry`、`model_fallback` 等 | `engine-raw` 透传 | 驱动不得吞掉未知 system 子类型（对齐 dsh 的「未知事件透传不 crash」规则） |

规则与其它驱动共享：normalize 是纯函数；`meta.seq` 由服务器 `allocSeq` 分配（chat
持久化契约不破坏）；未知类型 → `engine-raw` 透传帧。claude 侧额外注意**工具名漂移**：
SDK 曾出现 Agent 工具上报名 `'Task'` vs `'Agent'` 的 wire 漂移（0.3.x 修复），normalize
对工具名做 `LEGACY_TOOL_NAME_ALIASES` 容忍（SDK 已导出该表）。

---

## 4. 与 myco 四条 spawn 路径的关系（审计结论）

claude 驱动覆盖的路径 = **全部现状路径**。hyperEngine 的接线原则（见核心架构文档）：
**pick 发生在调用方，`hyperEngine` 以 opt 传入**；claude 被选中（或开关关闭）时该 opt
不产生任何行为差异：

| Spawn 路径 | 现状入口 | claude 驱动下 |
|---|---|---|
| 新会话 | `sessions.js` `spawnAgent(id, {cwd, modelOverride, activeGw, …})` | 不传 `hyperEngine`（或传 `'claude'`）→ 逐字节现状 |
| 重生（restart/reaper） | `ensureLiveSession` → `spawnAgent` | 同上；`rec.hyperEngineMode !== 'on'` 时恒不传 |
| RLM 会话/通道 | `agents/rlm/index.js:149 spawnRlmAgent → spawnAgent` | rlmOpts 透传；RLM 内核/Continual Harness **只存在于 claude 引擎**（`rlm_eval`/`addPrompt` 是 claude 会话的 MCP 工具）→ **RLM 会话的引擎候选集在真实阶段锁定为 `{claude}`**（壳阶段允许随机但 overlay 恒等，语义不变） |
| 团队 worker | `team-session.js:227 spawnRlmAgent` / `:242 new AgentSession` | 每个 worker 独立 pick；claude 侧零差异。explore 团队 worker 被**强制 RLM**（team-session.js:218-220）→ 同上一行约束 |

**注入点审计**（claude 驱动相关的全部既有事实）：

1. `agent-session.js:480` — `sdkOpts.env` 展开（gwEnv 在 gitEnv 前；hyperEngine overlay
   若非空应叠在**最后**）。
2. `agent-session.js:658-660` — 模型解析：`gw.model || process.env.ANTHROPIC_MODEL`；
   **`/model` 会话覆盖已退役**（恒清 null，不再进 sdkOpts.model）。claude 驱动不改此逻辑。
3. `agent-session.js:703` — `stream.setModel(effModel)` 强制生效模型（含 resume 场景），
   `_appliedModel` 去重。
4. `agent-session.js:681` — `_validateSdkOpts` + `SDK_OPTIONS_ALLOWLIST`（:42）：驱动
   不得引入 allowlist 外的 sdkOpts 顶层键（claude 驱动本就不加键）。
5. `local-claude.js` `_resolveGateway`（:41-58）— 一次性调用的镜像注入点（critic、
   summarizer 等消费者）。**设计决定：一次性调用路径不参与引擎随机**（结果可复现性 >
   多样性；调用方多为基础设施功能）。claude 驱动因此对 `local-claude.js` **零改动**。

---

## 5. 权限 / 工具桥（恒等）

- `canUseTool(toolName, input, opts)` 是 SDK 侧回调：myco 的 `_canUseTool` +
  PreToolUse allow-list 钩子（agent-session.js:480 hooks 块）已是完整实现。claude
  驱动**原样透传**，不新建桥。
- 统一 Driver 契约的 `approvals` 能力位对 claude 恒为 `true`，语义即「myco 权限面板 +
  allow-list 全功能可用」。
- 与其它引擎的差异要在核心文档明示：dsh 只对「越权升级」回调（fail-closed）、codex 走
  `handleCommand/handlePatch`、opencode 有自己的 permission 事件——**claude 是语义最全
  的基准**，其它驱动的桥都以「向 claude 的 canUseTool 语义对齐」为目标。

---

## 6. 会话标识、resume 与审计

### 6.1 resume 粘性（核心不变式的 claude 侧论据）

`options.resume` 按 sessionId 续转录 → **引擎选择必须 per-AgentSession 粘滞**（spawn 时
pick 一次，会话生命周期内不换）。claude 侧证据：resume 恢复的是 CLI 侧转录，只有 claude
引擎能读。核心架构已定：pick 结果落 `rec`（fr-102 的 modelOverride re-seed 同型），重生
时复用同一 pick；`engine-picked` 事件写 `_myco_/events.jsonl`。

### 6.2 SessionStore 审计缝（SDK 现成能力，替代侵入式落库）

SDK 的 `sessionStore`（alpha）是结构化转录镜像接口：

```ts
interface SessionStore {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>
  load(key): Promise<SessionStoreEntry[] | null>
  listSessions?(projectKey): Promise<{ sessionId, mtime }[]>
  delete?(key): Promise<void>
  listSubkeys?(key): Promise<string[]>
}
```

设计上这是一个**零侵入审计缝**：hyperEngine 可提供一个包装 SessionStore，在 `append`
时为条目打引擎标签（或仅在 load 时校验「该 session 的引擎标签 === 当前 pick」），不改
`query()` 调用本身。P0/P1 不启用（transcript 落盘现状不动），列为 P2 可选——解决原设计
开放问题 #2（每会话用了哪个引擎的复现/审计）而无需改 sessions.json 结构。

### 6.3 成本计量

`result.modelUsage` 是**累计全管线**计费字段（含子 agent），`usage` 只是本轮主循环。
hyperEngine 若做跨引擎成本对比（claude vs opencode vs codex vs dsh 的 run 成本），claude
侧以 `modelUsage` 为准；其它引擎各没有等价物时，normalize 层允许 `usage: null` 并在
对比报表标注口径差异。

---

## 7. 风险与边界

| 风险 | 设计应对 |
|---|---|
| SDK 发版节奏极快（0.1.0→0.3.316，与 Claude Code v2.1.x 逐版对齐） | 驱动只依赖 `query()` + SDKMessage 联合这个稳定面；myco 锁 package.json 版本（现状已锁）；不碰内部协议 |
| v2 session API 已删（0.3.142） | 设计不引用任何 `createSession()` 形态 API；多轮 = AsyncIterable + resume（现状） |
| `env` 替换语义被误当叠加语义 | claude 驱动 overlay 恒空 + 测试锁定「恒等」；其它驱动的 env 注入文档统一引用本节 §2.1 的展开规则 |
| 工具名 wire 漂移（Task/Agent 先例） | normalize 容忍别名（`LEGACY_TOOL_NAME_ALIASES`）；未知 system 子类型 `engine-raw` 透传不 crash |
| RLM 内核与引擎耦合（`rlm_eval`/`addPrompt` 是 claude 会话的 MCP 工具） | 真实阶段 RLM 会话/explore worker 的候选集锁 `{claude}`；壳阶段随机无害（overlay 恒等）——核心架构文档的调度约束节引用本条 |
| `sessionStore` 仍是 alpha | 审计缝列为 P2 可选；P0/P1 用 `engine-picked` 事件即可满足复现需求 |

---

## 8. 测试计划（新增，镜像 hyperEngine 测试表）

| 测试 | 断言 |
|---|---|
| `claude-driver-identity` | `overlay()` 返回空对象；`pickEngine` 关闭态恒选 claude；开启态 claude 在候选集（`available()===true`） |
| `claude-driver-zero-impact` | `rec.hyperEngineMode !== 'on'` 时 spawn opts **不含** `hyperEngine` 键；`_validateSdkOpts` 输出与现状一致（allowlist 零新增键） |
| `claude-normalize-thin` | SDKMessage 样本（init/assistant/result）→ myco 帧直通映射；未知 system 子类型 → `engine-raw` 不 throw |
| `claude-normalize-result` | `result` 帧的 `subtype`/`is_error`/`modelUsage` 直传；`usage` 与 `modelUsage` 口径区分断言 |
| `claude-resume-sticky` | 同一 rec 两次 spawn（模拟 restart/reaper）pick 复用；`engine-picked` 事件只写一次 |
| `claude-rlm-lockset`（真实阶段） | RLM 会话/explore worker 的候选集 === `['claude']`；普通会话候选集含四引擎 |

> 离线跑法：全部为纯函数断言（overlay/normalize/pick），不需要真实 SDK 子进程；
> `zero-impact` 测试是「开关没开逻辑一点不能影响」承诺的 claude 侧锁定件。
