# hyperEngine 驱动设计 — `opencode`（基于 opencode-sdk-js 真实 API）

> 本文是 `docs/arch/agents/hyperEngine/myco-hyperEngine-design.md` 的驱动子文档。
> 调研对象：https://github.com/anomalyco/opencode-sdk-js.git
> 状态：**只设计，不实现。**所有 API 均引自该仓库 `src/` 下的实际 TypeScript 定义
> （Stainless 生成，OpenAPI 规格），非凭空臆造。

---

## 0. opencode-sdk-js 事实清单（Evidence）

| 事实 | 出处（仓库内路径） |
|---|---|
| 客户端 `new Opencode({ baseURL, timeout, maxRetries, defaultHeaders, fetch, fetchOptions, logLevel })`；`baseURL` 缺省读 `process.env['OPENCODE_BASE_URL']`，再缺省 `http://localhost:54321` | `src/client.ts:99-199` |
| 会话生命周期：`client.session.create()` → `Session { id, title, parentID, version, revert, share }`；`session.list()` / `session.delete(id)` / `session.abort(id)` | `src/resources/session.ts:14-38` |
| 发消息：`session.chat(id, body: SessionChatParams)`，`SessionChatParams = { modelID, providerID, parts: Array<TextPartInput \| FilePartInput>, messageID?, mode?, system?, tools?: {[tool]: boolean} }` | `src/resources/session.ts:42-44, 535-549` |
| 消息回读：`session.messages(id)` → `{ id, title, ... }[]`；消息形态 `Message = UserMessage \| AssistantMessage`，`AssistantMessage { id, cost, mode, modelID, providerID, role, sessionID, system[], tokens, error?, summary? }` | `src/resources/session.ts:56-58, 499-533` |
| 事件流：`client.event.list()` → SSE `Stream<EventListResponse>`，可 `break` 或 `stream.controller.abort()` 取消 | `src/resources/event.ts:17-23`、README "Streaming responses" |
| 事件类型（判别联合 `type` 字段）：`installation.updated` / `lsp.client.diagnostics` / `message.updated` / `message.removed` / `message.part.updated` / `message.part.removed` / `storage.write` / **`permission.updated`** / `file.edited` / `session.updated` / `session.deleted` / **`session.idle`** / **`session.error`** / `file.watcher.updated` / `ide.installed` | `src/resources/event.ts:25-258` |
| `message.updated` 携带 `properties.info: Message`（整条消息快照）；消息正文以 `Part` 数组表达：`TextPart { type:'text', text }`、`ToolPart { type:'tool', tool, callID, state: Pending\|Running\|Completed\|Error, ... }`、`StepStartPart` / `StepFinishPart` / `SnapshotPart` / `PatchPart` / `FilePart` | `src/resources/session.ts`（Part 联合） |
| `ToolStateCompleted { status:'completed', input, output: string, title, time:{start,end} }`；`ToolStateError { status:'error', error: string, input }` | `src/resources/session.ts:437-472` |
| `permission.updated` 事件带 `{ id, title, sessionID, metadata }` —— opencode 服务端把待批准动作推给客户端 | `src/resources/event.ts:131-152` |
| `session.idle { sessionID }` = 一轮结束信号（对应 claude SDK 的 `result` 消息） | `src/resources/event.ts`（EventSessionIdle） |
| `session.error { info: MessageOutputLengthError … }` = 出错信号 | `src/resources/event.ts`（EventSessionError） |
| `client.config.get()` → `Config { agent(modes), instructions[], disabled_providers[], experimental, autoupdate, … }` —— 服务端 opencode 实例自身的运行配置 | `src/resources/config.ts` |
| SDK 是**纯 HTTP/SSE 客户端**：不做进程管理，假设一个 opencode server（`opencode serve`）已在 `baseURL` 上监听 | `src/client.ts`（无 spawn 逻辑） |
| 错误处理：非 2xx 抛 `APIError` 子类 | README "Handling errors" |

**关键架构结论**：opencode-sdk-js 与 claude-agent-sdk 不同，它不是「进程内 SDK」而是
「**远程 server 的 API 客户端**」。因此 `opencode` 驱动的落地形态与 `claude` 驱动有本质
区别 —— 见 §2。

---

## 1. myco 侧的对接现状（Integration Points）

`agent-session.js` 当前对 claude SDK 的消费点（opencode 驱动必须等价覆盖）：

| myco 概念 | claude SDK 实现（现状） | opencode SDK 对应物 |
|---|---|---|
| `sdkOpts.env`（`{...process.env, ...gwEnv, ...gitEnv}`） | 子进程环境注入（ANTHROPIC_* 直达模型网关） | **不存在子进程**——模型配置在 opencode server 侧；驱动只能把网关信息翻译成 server 的 provider/model 选择（§3.3） |
| `sdkOpts.model` + `Query.setModel()` | 每次 `query()` 传 model，live 切换 | `session.chat` 的 `modelID` + `providerID` 参数 |
| `query({ prompt: asyncIterable })` 流式输入 | AsyncMessageQueue 持续喂数 | `session.chat(id, { parts: [...] })` 单发一轮；流式输入需用 `message.part.updated` 事件 + 后续 chat（见 §3.4） |
| `for await (const m of stream)` 事件循环 | SDK 消息流（`system`/`assistant`/`user`/`result`/`rate_limit_event`…） | `client.event.list()` 全局 SSE 流，按 `properties.sessionID` 过滤 |
| `canUseTool(toolName, input, ctx)` 权限回调 | SDK 内联回调 | opencode 的 `permission.updated` 事件 + 服务端审批 API（**缺口见 §4-OpenQ1**） |
| `abortController` 中断 | `controller.abort()` | `session.abort(id)` |
| `resume: sdkSessionId` | SDK 会话续接 | `session.create()` 返回的 `id` 保留复用即可（无 resume 概念，消息即历史） |
| `hooks.PreToolUse` 允许/拒绝列表 | SDK hook | 无直接对应；近似用 `SessionChatParams.tools: {[tool]: boolean}` 白名单 + 服务端 permission |
| `mcpServers`（myco / lean-ctx / market） | 进程内/stdio MCP server 传给 SDK | 无对应——需在 opencode server 配置侧声明（超出驱动 overlay 范围，见 §4-OpenQ2） |

myco `AgentSession` 对外发射的事件词汇表（`_emit`）为：`session_ready` / `system_init` /
`turn_start` / `assistant_text` / `tool_use` / `tool_result` / `permission_request` /
`permission_resolved` / `hook_allow` / `hook_deny` / `rate_limit` / `turn_result` /
`iteration_start` / `iteration_aborted` / `fatal` / `resume_failed` / …。opencode 驱动的
核心工作是把这些事件从 opencode 的 SSE 事件流里**归一化**出来（§3.5）。

---

## 2. 驱动形态：进程内 query → 远程 server 适配器

claude 驱动是「直接调 `query()`」。opencode 驱动则是包一层：

```
AgentSession ──> OpenCodeDriver ──> opencode-sdk-js Opencode client
                                        │ HTTP + SSE
                                        v
                              opencode server（opencode serve，
                              baseURL 缺省 http://localhost:54321）
                                        │
                                        v
                              opencode 自行接模型 provider（Anthropic 兼容网关等）
```

**hyperEngine 的「模型经 env 注入 claude code」总原则在 opencode 驱动下的解释**：
`overlay()` 依旧只产出 `{ env, model }` 语义的叠加物，但 `env` 里的 `ANTHROPIC_*` 网关
变量不是注入子进程，而是注入 **opencode server 的进程环境 / server 启动配置**——驱动在
spawn server（或探测既有 server）时把 `gwEnv` 透传过去。模型选择的表达从
`sdkOpts.model` 变为 `chat()` 的 `{ providerID, modelID }`，映射规则见 §3.3。

---

## 3. OpenCodeDriver 设计

### 3.1 注册信息（registry 中的条目）

```js
{
  name: 'opencode',
  label: 'OpenCode（远程 server 适配）',
  kind: 'remote-server',              // 与 claude 的 'in-process' 区分
  available(rec, opts) {
    // 1) 可达性探测：GET <baseURL>/config（client.config.get()），
    //    超时 800ms；不可达 -> false（dispatch 据此把它从候选集剔除，
    //    候选集永远剩 claude，不会落空）。
    // 2) 环境探测：OPENCODE_BASE_URL 已配置，或探测到本机 54321 端口在听。
  },
  overlay(ctx) { /* §3.2 */ },
  // 统一 EngineDriver 接口（主文档 §5.2 为唯一命名基准）：
  async openSession(cfg) { /* §3.4 步骤 1-5：ensureServer + session.create()，返回 EngineSession */ },
  async sendTurn(text, { signal } = {}) { /* §3.4 步骤 6-7：chat() + 事件流，产出 EngineEvent */ },
}
```

`available()` 的语义与 hyperEngine 注册表契约一致：**false 只影响候选集，不影响默认
路径**。开关开启但 opencode server 不在 → 该次 spawn 随机池退化为 `claude`（+ 其它
可用后端），不会报错。

### 3.2 `overlay(ctx)` —— sdkOpts 叠加物

镜像 claude 驱动的 overlay 签名（hyperEngine §注册表），返回叠加物：

```js
overlay({ sdkOpts, modelOverride, activeGw, user, worker }) {
  // 壳阶段（本设计稿的当前状态）：返回 {} —— 不改任何 sdkOpts，
  // spawn 仍走 claude code，用于演示完整「注册/随机选择」链路。
  //
  // 落地阶段返回：
  return {
    env: {
      // 1) 指向 myco 托管/探测到的 opencode server
      OPENCODE_BASE_URL: this._resolveBaseUrl(user, activeGw),
      // 2) 网关叠加：把 rec.activeGw 解析出的 ANTHROPIC_BASE_URL /
      //    ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 保留原样 ——
      //    opencode server 的 Anthropic 兼容 provider 读取同一组 env，
      //    因此「经 env 注入」的通道保持不变，只是消费方从
      //    claude-code 子进程变成 opencode server 进程。
      ...gwEnv,   // 同 agent-session.js:478-485 的 gwEnv 构造
    },
    model: undefined,   // opencode 不用 sdkOpts.model（模型在 sendTurn 里选）
  };
}
```

**要点：overlay 产物仍是「env 键值 + 可选 model/engineOptions」**，与 hyperEngine 统
一驱动契约（OverlayResult = `{ env?, model?, engineOptions?, eventPolicy? }`）兼容。
若采用统一契约，本驱动的 `modelID / providerID / mode / tools` 选择应放进
`engineOptions`（opencode 专有键），`env` 只承载网关鉴权（ANTHROPIC_* / OPENCODE_BASE_URL）
——与 codex 驱动把模型放进 CLI `-c k=v`、dsh 驱动放进 `createAgent()` 的分工一致。
差别仅在消费端：claude/codex/dsh 是进程内或子进程，opencode 是远程 server 进程。

### 3.3 网关 / 模型映射

`_resolveBaseUrl(user, activeGw)`：
1. `process.env.OPENCODE_BASE_URL` 存在 → 用它（显式配置优先）。
2. 否则探测 `http://localhost:54321`（SDK 缺省值）可达 → 用它。
3. 否则 → `available()` 已经返回 false，不会被选中。

`modelID/providerID` 映射（`sendTurn` 时确定）：

| myco 侧输入 | opencode 侧输出 |
|---|---|
| `gw.model`（activeGw 档案的 model） | `modelID = gw.model` |
| `process.env.ANTHROPIC_MODEL`（系统默认） | `modelID = ANTHROPIC_MODEL` |
| 都无 | `modelID = ANTHROPIC_MODEL || 'claude-sonnet-4-5'`（沿用 claude 驱动的系统缺省思路，交由 opencode server 配置兜底） |
| provider | `providerID = 'anthropic'`（opencode 的 Anthropic 兼容 provider；后续多 provider 化时从 `client.config.get().disabled_providers`/provider 列表探测） |

`mode`（= claude 驱动里的 permissionMode 概念）映射：claude `permissionMode:
'default'` → opencode `mode: 'default'`（opencode Config.agent 定义 modes；缺省即 default）。

### 3.4 Turn 执行流（`sendTurn`，替代 `query()` 的等价物）

> 命名对齐：统一 `EngineDriver` 接口（主文档 §5.2 为**唯一命名基准**）在 opencode 侧把
> 下文「spawn 时」块（步骤 1-5）对应到 `openSession(cfg)`，把「每一轮」块（步骤 6-7）
> 对应到 `sendTurn(text, { signal })`；步骤 8、9 对应 §5.2 的 `abort()` / `close()`。
> 早前本文曾用 `runTurn(ctx)` 一词覆盖整个流程，现按 §5.2 收口为 `openSession`/`sendTurn`
> 两个方法——与 claude-driver 的收口（f5b641d）同口径。

```text
spawn 时（AgentSession 生命周期起点，= openSession(cfg)）：
  1  driver.ensureServer(ctx)      // 探测/启动 opencode server，把 overlay env 灌给它
  2  this._oc = new Opencode({ baseURL, timeout: 120_000 })
  3  this._evStream = await client.event.list()   // 全局 SSE，一次建立
  4  this._ocSession = await client.session.create()
  5  把 _ocSession.id 记入会话（复现/审计用，见 hyperEngine §开放问题）
  6  return EngineSession（持有 _oc/_evStream/_ocSession；send/abort/close 如下）

每一轮（AgentSession.write() 驱动，= sendTurn(text, { signal })）：
  7  client.session.chat(this._ocSession.id, {
       modelID, providerID,
       parts: [{ type:'text', text: userMsg }],   // TextPartInput
       mode: 'default',
       tools: allowListAsToolMap,                 // 可选：白名单 → {bash:false,...}
     })
  8  for await (const ev of this._evStream) {
       if (ev.properties?.sessionID !== this._ocSession.id) continue;
       normalize(ev) -> AgentSession 事件（§3.5）
       if (ev.type === 'session.idle') break;     // 本轮结束
     }

中断（AgentSession.interrupt()，= abort()）：
  9  client.session.abort(this._ocSession.id)

会话结束（= close()）：
  10 this._evStream.controller.abort(); client.session.delete(id)（可选）
```

流式输入（AsyncMessageQueue 的等价物）：opencode 一轮 chat 是单发。连续用户输入 =
上一轮 `session.idle` 后再发下一次 `chat()`，与 claude 驱动「每次 .write() 一次
query()」的既有节奏天然对齐（agent-session.js 本来就是 per-turn spawn query）。

### 3.5 事件归一化表（opencode SSE → myco agent-event）

| opencode 事件 | myco agent-event | 载荷映射 |
|---|---|---|
| `session.updated`（首轮） | `session_ready` / `system_init` | `info.id → sdkSessionId` |
| `message.updated` 且 `info.role==='user'` | `user` | `info.id` |
| `message.updated` 且 `info.role==='assistant'`，`info` 带 TextPart | `assistant_text` | `part.text` |
| `message.part.updated`（`type:'tool'`，`state.status:'running'`） | `tool_use` | `tool` 名、`state.input` |
| `message.part.updated`（`type:'tool'`，`state.status:'completed'`） | `tool_result` | `state.output`、`state.title` |
| `message.part.updated`（`type:'tool'`，`state.status:'error'`） | `tool_result`（失败）+ 提示 | `state.error` |
| `permission.updated` | `permission_request` | `title`、`metadata` |
| （myco 权限菜单裁决后） | `permission_resolved` | 驱动调 opencode 服务端审批接口回写（见 OpenQ1） |
| `session.idle` | `turn_result` | `sessionID` |
| `session.error` | `fatal`（或 `retry_attempt`） | `info.error` |
| `message.updated` 且 `info.error?.type` 含 rate-limit 类 | `rate_limit` | `info.error` |
| 其它（installation/lsp/storage/file…） | 忽略（`unknown_event` 不上报，避免 UI 噪声） | — |

`AssistantMessage.cost` / `tokens` 可映射到 myco 的用量统计帧（与 claude 驱动的
`result` 消息 cost 用量对齐；缺省不做，列为后续增强）。

### 3.6 权限流缺口

claude SDK 的 `canUseTool` 是**进程内回调**（myco 弹聊天窗菜单卡，用户点选，Promise
resolve）。opencode 的 `permission.updated` 是**服务端事件**，SDK 未暴露对应的
「批准/拒绝」回写 API（仓库 `src/resources/` 中只有 app/config/event/file/find/
session/tui，无 permission resource）。落地阶段的取舍：

- **方案 A（推荐，第一版）**：opencode 驱动统一用 `tools` 白名单（`SessionChatParams.
  tools: {bash:false}` 禁用危险工具）+ 服务端 default permission 配置，**不弹菜单**。
  myco UI 上注明「opencode 引擎下权限菜单降级为服务端策略」。设计上安全、无 API 缺口。
- **方案 B（待 opencode 上游补 API）**：`permission.updated` 事件映射菜单卡 +
  新增的 permission 回写端点。留作 OpenQ1 跟踪。

---

## 4. 开放问题（opencode 驱动）

1. **permission 回写 API 缺失**：SDK 只有 `permission.updated` 事件，无
   `permission.respond()` 类资源。第一版按 §3.6 方案 A 降级。
2. **MCP 注入**：claude 驱动的 `mcpServers`（myco / lean-ctx / market）无法经
   opencode SDK 传入 —— 需在 opencode server 的配置文件里声明同名 MCP server。
   设计上把「托管 opencode server」的配置模板纳入 `hyperEngine/drivers/opencode.js`
   的 `ensureServer` 职责（生成本地配置文件 + 启动），第二版再做。
3. **TeamSession 双 worker**：两个 worker 可各自随机到 opencode，则共享一个
   opencode server、各建一个 `session.create()` 的 session（sessionID 不同，
   `_relay` 的 worker 标记照常工作）。事件流过滤按 `sessionID` 隔离，无串扰。
4. **resume 语义**：opencode session 生命周期由 server 管理（重启丢 session）。
   `AgentSession._ocSession` 丢失时（`session.list()` 里查不到）自动 `create()` 新
   session 并在 UI 上提示一次 `resume_failed` 同义事件。

---

## 5. 测试断言（并入 hyperEngine 测试表）

| 测试 | 断言 |
|---|---|
| `opencode-driver-off` | 开关关 → `overlay()` 返回 `{}`，sdkOpts 逐字节不变 |
| `opencode-driver-unavailable` | `OPENCODE_BASE_URL` 未设且 54321 不可达 → `available()===false`，`pickEngine` 候选集剔除 opencode，恒有 claude 兜底 |
| `opencode-event-normalize` | 用 fixture SSE 事件数组断言 §3.5 映射表逐行成立 |
| `opencode-turn-idle-break` | mock 流注入 `session.idle` → `turn_result` 恰好一次，循环退出 |
| `opencode-chat-params` | `sendTurn` 产出的 `SessionChatParams` 字段与 §3.3/3.4 一致（modelID/providerID/mode/tools） |

> 全部用 `BENCH_MOCK=1` 离线跑（mock Opencode client，不起真实 server）。
