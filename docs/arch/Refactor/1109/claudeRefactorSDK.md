# Claude Agent SDK 选项接入分析（myco-1014）

> SDK 版本：`@anthropic-ai/claude-agent-sdk@0.3.142`（`server/package.json`）。
> 结论：7 个候选里 **2 个立刻做**（persistSession:false、effort），**2 个排期**
> （tool_progress、maxTurns+maxBudgetUsd），**3 个暂缓**（forkSession、
> enableFileCheckpointing、sandbox）。

## 总览

| # | 改动点 | 结论 | 优先级 |
|---|---|---|---|
| 1 | effort（thinking/maxThinkingTokens 不接） | 只接 effort，去掉 isolatedDeLM 门禁，打通 bench | **P0** |
| 2 | maxTurns / maxBudgetUsd | 只接 bench 单题路径（per-query 语义），交互会话不接 | P1 |
| 3 | includePartialMessages | 先接 tool_progress（成本极低），partial 缓 | P1→P2 |
| 4 | forkSession | 结构不同无可共享前缀，串行执行 cache TTL 已过 | 暂缓 |
| 5 | enableFileCheckpointing | Bash 改动不在保护范围，n2 共享工作区回滚互相抹杀 | 暂缓 |
| 6 | sandbox | 本机无 bwrap/socat，与 canUseTool 权限模型冲突 | 暂缓 |
| 7 | persistSession:false | callLocalClaude（judge/btw/critic 等一次性调用）加 1 行 | **P0** |

## P0-1：`persistSession: false`（local-claude.js）

**现状**：`delm/grade-worker.cjs` 已用；`server/src/local-claude.js`（judge /
btw / critic / summarizer 调用点）**没有**——全是一次性、不 resume 的调用，
却把 transcript 写进 `/root/.claude/projects/`（实测已 3.2G，单 HLE run 的
project 目录 70-121M）。

**做法**：`local-claude.js` 的 options 加 `persistSession: false`。零风险
（该 helper 本就无 resume 逻辑），同时从源头消除一次性调用误留 transcript、
被 `importExistingTranscripts` 误认领的隐患（sessions.js:72-75 的
enclosing-session 规则只需挡真正的会话）。

## P0-2：effort 打通

**现状**：effort 只在 DeLM 隔离分支赋值（agent-session.js:689，
`if (this.isolatedDeLM)` 内）；普通 AgentSession、TeamSession worker
（team-session.js common 不透传）、HLE 的 `callLocalClaude`
（local-claude.js options 无此字段）全拿不到。`thinking` 在 allowlist 但
全仓库无赋值；`maxThinkingTokens` 已被 SDK 标 deprecated。

**做法**：
- `AgentSession` 加通用 `sdkEffort`（去掉 isolatedDeLM 门禁）。
- `TeamSession.common` 透传 → HLE n2 worker 生效。
- `callLocalClaude` 加参数 → HLE 单 agent 生效。
- HLE 从环境变量读（如 `HLE_EFFORT=high|xhigh|low`），按题目难度分档。

**坑**：
- effort 只在支持 adaptive thinking 的模型上生效；网关模型 glmmoedsa
  是否支持未知——**先用一题 A/B 验证**再全量。
- 不要用 `thinking:{type:'enabled'}` 去看推理：thinking block 在 resume 时
  不可变（bug-40 根因），触发 400 只能丢弃 resume 重开、丢上下文。
- 模型即使返回 thinking block，`_handleEvent` 也只处理 text/tool_use
  （agent-session.js:1203+），thinking 被静默丢弃——"流里没推理"一部分是
  自己过滤的。

## P1-1：tool_progress（先于 includePartialMessages）

**现状**：SDK 的 `type:'tool_progress'` 事件（带 tool_use_id / elapsed_time）
现在落到 `unknown_event` 被丢弃（agent-session.js:1399 → 客户端 9059 丢弃）。

**收益**：这是"长 Bash 无事件被误杀"的**真正**信号——partial message 只在
模型生成时出现，工具执行期间不会有 token 流，partial 解决不了这个问题。
接 tool_progress 后 liveness 从"工具边界"细化到"工具运行中心跳"。

**做法**：`_handleEvent` 加分支 → 事件进 buffer（不落盘或低频落盘）→
TeamSession `_relay` 让它参与看门狗计时（或单独作为 liveness 参考）。

## P1-2：maxTurns + maxBudgetUsd（仅 bench 单题路径）

**收益**：比时间窗精确的失控防护。1100 条 turn_result 实测：`maxTurns:200`
对正常题几乎不触发；`maxBudgetUsd:$10-15` 较稳（$5 会砍掉约 5% 的题）。

**坑（关键）**：
- 语义是 **per-query 不是 per-session**。交互式 AgentSession 用
  AsyncMessageQueue 维持一个长生命周期 query 跨所有用户 turn——设了
  maxBudgetUsd 会在聊几轮后随机断线（emit idle → 下次 write 冷启动）。
  **交互会话不接**；bench/DeLM "一题一个 query" 语义正好。
- `error_max_turns` / `error_max_budget_usd` 是 SDKResultError subtype 不是
  异常：`local-claude.js:132-135` 只读 `m.result`，会变成
  "model returned no text" 丢失可分类原因——**接的时候必须映射 subtype**
  到 detail.error，orch.py 才能分该不该重试。
- `taskBudget` 是 alpha 且是"告诉模型省着用"不是硬停，不能替代。

## P2：includePartialMessages

打字机效果 + token 级 liveness。若开：`_emit` 前必须过滤/聚合（否则每个
delta 都写 events.jsonl，buffer 5000 上限会挤掉真正的 tool_use/turn_result）；
前端要新增分支，不能走 unknown_event 落盘路径。`forwardSubagentText`
是另一个独立选项，仅嵌套 transcript 场景才需要。

## 暂缓三项的理由

| 项 | 核心障碍 |
|---|---|
| forkSession | /compare 两条 lane 结构不同（plain AgentSession vs board 协议 worker），无可共享前缀；串行执行间隔下 prompt cache TTL 已过，省不到钱 |
| enableFileCheckpointing | checkpoint 只覆盖 SDK 文件工具；n2 大量用 Bash（cat >、git checkout）不在保护范围，回滚会"半回滚"；n2 共享工作区回滚 A 会抹掉 B 的成果。若做：run 结束后的离线回放命令，非在线 |
| sandbox | 本机/镜像均无 bwrap/socat；`autoAllowBashIfSandboxed` 与 canUseTool 聊天面板权限模型冲突；`allowUnsandboxedCommands` 默认 true 可逃逸。唯一真实增量是 network.allowedDomains，但需先解决依赖安装（chroot 内嵌 bwrap 需 enableWeakerNestedSandbox） |

## sessionStore（单独立项，不与磁盘优化混合）

能绕开 bug-40 根因（lean-ctx compaction-sync 重写 `~/.claude/projects`
下的 JSONL 破坏 thinking block 字节一致性）：transcript 镜像进自有存储，
resume 前 load() 物化。但 alpha、与 persistSession:false 互斥、需实现
append/load/listSessions、且 events.jsonl 是派生 UI 流非原始 transcript——
两套真相需先明确分工。**单独评估**。

## 落地顺序

| 优先级 | 改动 | 改动面 |
|---|---|---|
| **P0** | local-claude.js 加 `persistSession: false` | 1 行 |
| **P0** | effort 打通 bench 单 agent + n2 | 小 |
| P1 | tool_progress 事件处理 | 小 |
| P1 | bench/DeLM 接 maxTurns + maxBudgetUsd（含 subtype 映射） | 中 |
| P2 | includePartialMessages（不落盘） | 中 |
| 暂缓 | forkSession / enableFileCheckpointing / sandbox | — |

## 关键代码位置

| 主题 | 位置 |
|---|---|
| SDK 选项 allowlist | `server/src/agent-session.js:43-56` |
| sdkOpts 组装 | `server/src/agent-session.js:485-606` |
| effort 唯一赋值点（DeLM 门禁内） | `server/src/agent-session.js:689` |
| 事件分发 `_handleEvent` | `server/src/agent-session.js:1116+` |
| unknown_event 兜底 | `server/src/agent-session.js:1399` |
| 事件落盘 `_emit` | `server/src/agent-session.js:2169` |
| resume 失败 / thinking-block 恢复 | `server/src/agent-session.js:760-786, 1018-1048` |
| 一次性调用 helper | `server/src/local-claude.js:102-111` |
| TeamSession worker 构造 | `server/src/team-session.js:222-236` |
| /compare lane | `server/src/compare-lanes.js:171-240`（串行，slashcmds.js:3979 注释） |
| DeLM 配置默认值 | `delm/api.js:11-25`（effort 默认 null；answer/first_output timeout 7200s） |
| DeLM worker | `delm/worker.cjs:62-70`（非 success 即 exit 1） |
| HLE 单 agent / n2 | `bench/hle/lib/engine.js:130-146, 229+`（STALL_MS / n2Ask） |
| SDK 类型定义 | `server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（Options:1155；tool_progress:3583；sessionStore:3735） |

## 与既有 bug 修复的关联

- **长 Bash 误杀**（220/240min 看门狗讨论的残余风险）→ tool_progress 是
  正解（P1-1），比再调大时间窗精确。
- **bench/hle n2 提前完成**（已修：settle 守卫 + GRACE_MS 120s）与
  **/run-n2 单 worker 死亡提前完成**（已修：wholeTeamQuiet）不受本分析影响。
- bug-40（thinking-block resume 400）→ sessionStore 单独立项评估（见上）。
