# hyperEngine 调度与 TeamSession 引擎映射设计（dispatch-and-team）

> 状态：**设计方案（未实现）。** 本文件是 `docs/arch/agents/hyperEngine/myco-hyperEngine-design.md`
> 的调度专题子文档（对应主文档 §6），定义：
> 1. per-AgentSession 引擎选择（pick）的时机、粒度、粘性与落库；
> 2. 四条 spawn 路径（单代理 / RLM / 团队 worker / RLM 团队 worker）如何统一获得引擎；
> 3. `sessions.js` / `agent-session.js` / `team-session.js` 的注入点（带行号锚点，基于 develop @ 0d070d0）；
> 4. respawn / resume / 中途切换三类时序下的行为契约；
> 5. 零影响不变式与测试计划。
>
> 依赖：主文档 §5 的 Driver 契约（`overlay(opts) -> { env?, model?, engineOptions? }`、
> `kind: 'query' | 'remote-server' | 'child-process' | 'in-process'`、`capabilities`），
> §4 的会话开关 `rec.hyperEngineMode`（/he on|off，见 ui-switch.md）。

---

## 1. 设计原则（从主文档 §2 细化到调度层）

1. **选择在 spawn 时刻一次性完成并粘住**：一个 AgentSession 从诞生到死亡的整个生命期
   使用同一个引擎后端。理由：
   - **resume 安全**（peer FACT path-16）：claude SDK 的 `options.resume(sessionId)`
     语义要求同一会话连续性；中途换引擎 = 换一套会话存储模型（codex 无 resume、
     dsh 内存态、opencode server 持有），等价于丢上下文。
   - **迭代不变量**：`agent-session.js` 的 `_activeGwAtIteration` 模式（:168）已证明
     「一个迭代 = 一套冻结的连接参数」；引擎同理，甚至更强（跨迭代也不能变）。
2. **pick 发生在 spawn 调用方，注入经 AgentSession opts 字段**：镜像 `modelOverride` /
   `activeGw` 的 fr-102 模式 —— 调用方（`ensureLiveSession` / `TeamSession._spawnWorker` /
   `spawnRlmAgent` 透传）解析出引擎名，作为 `opts.hyperEngine` 传给 AgentSession；
   AgentSession **不自行随机**。理由：
   - 随机源（rng）、落库（rec）、可用性探测（available()）都只在 spawn 路径上有意义；
   - AgentSession 保持纯消费者，`opts.hyperEngine` 缺省 → 恒等 claude，零影响成立点单一。
3. **随机粒度 = 每个 AgentSession**：主会话选一次；团队每个 worker 各选一次
   （worker-A / worker-B 可异引擎 —— 这正是「混合」的展示面）。
4. **开关关闭 = 恒 claude**：`isHyperEngineOn(rec) === false` 时 pick 直接返回
   `'claude'`，`opts.hyperEngine` 传 `'claude'`（或省略，两者等价）。

---

## 2. 四条 spawn 路径与统一 pick 点

现状（develop @ 0d070d0）所有会话最终都经过 **一个** 构造面 —— `AgentSession`
（`spawnAgent`，agent-session.js:2502；RLM 经 `spawnRlmAgent` → 内部同样调
`spawnAgent`，agents/rlm/index.js:149）。因此 pick 的注入面天然收敛为
`opts.hyperEngine` 一个字段：

| # | 路径 | 调用点 | 引擎解析处（设计） |
|---|---|---|---|
| 1 | 单代理（默认） | `sessions.js` `ensureLiveSession` :1356 `spawnAgent(...)` | `ensureLiveSession` 在调用前 `pickEngine(rec, { worker: null })` |
| 2 | RLM 主会话 | `sessions.js` :1338 `spawnRlmAgent(...)` | 同上 —— pick 后经 `spawnRlmAgent` opts **透传**（spawnRlmAgent 用 `Object.assign({}, opts, …)` 组装 rlmOpts，agents/rlm/index.js:136，未知字段天然透传到 spawnAgent） |
| 3 | 团队 worker（非 RLM） | `team-session.js` `_spawnWorker` :242 `new AgentSession(...)` | `_spawnWorker` 在 `common` 组装处（:202）pick：`hyperEngine: this._resolveWorkerEngine(actor)` |
| 4 | 团队 worker（RLM/explore） | `team-session.js` :227 `spawnRlmAgent(...)`（展开 `common`） | 同上 —— pick 放进 `common`，两条 worker 分支共享 |

设计要点：

- **路径 2/4 零改动即可透传**：`spawnRlmAgent` 的 `Object.assign({}, opts, {...})`
  不剔除字段，`AgentSession` ctor 只读取自己认识的 opts。因此 RLM 路径的接线成本 =
  在 RLM 调用点传入一个字段，不改 `agents/rlm/` 任何文件。
- **TeamSession 需要拿到开关态**：现状 `getOrCreateTeamSession`（sessions.js:1408）
  构造 `TeamSession` 时已透传 `rlm: isRlmEffective(rec)`（:1418）——hyperEngine 沿同一
  模式新增 `hyperEngineMode: isHyperEngineOn(rec)`（或直接传 pick 结果 map，见 §3）。
- **explore 模式的特殊性**：`team-session.js` :224 `const rlmWorker = this.rlm || this.explore`
  —— explore workers 被强制走 RLM 引擎（自进化循环依赖 `rlm.addPrompt` 通道）。
  **explore 模式下 hyperEngine 随机必须禁用**（explorer 的 Continual Harness 是
  RLM 专属机制，换引擎即断）：`_spawnWorker` 在 `this.explore === true` 时恒返回
  `'claude'`（RLM 是 prompt/MCP 叠加而非引擎后端，其底座仍是 claude SDK query()）。

---

## 3. 落库与 respawn：`rec.hyperEngine` 粘性印记

**问题**（peer FACT path-11 审计第 5 条）：`ensureLiveSession` 在容器重启 / reaper
回收后**重新执行**。若每次 respawn 重新随机，同一会话的两次生命期会跑在不同引擎上；
对 claude 引擎这是无害的（resume 照常），但对 codex（无 resume，子进程死 = 会话死）
是**上下文丢失**。

**设计**：把 pick 结果**印记在 rec 上**，随 `/data/sessions.json` 持久化：

```js
// sessions.js rec 字段（新增）：
rec.hyperEngine        // 'claude' | 'opencode' | 'codex' | 'dsh' | null
                       //   主会话（AgentSession 粒度）的粘性印记；null = 从未 pick
rec.hyperEngineWorkers // { 'worker-A': 'codex', 'worker-B': 'dsh' } | undefined
                       //   agent-n2 团队每个 worker 的印记（镜像 rec.sdkSessions :1422 的形状）
```

pick 函数的完整决策表：

```js
// hyperEngine/dispatch.js
function pickEngine({ rec, worker }) {
  // 0) 开关没开 → 恒 claude（零影响的第一道门）
  if (!isHyperEngineOn(rec)) return registry.get('claude');
  const stamped = worker
    ? (rec.hyperEngineWorkers && rec.hyperEngineWorkers[worker])
    : rec.hyperEngine;
  // 1) 已有粘性印记 → 复用（respawn 不换引擎；resume/上下文安全）
  if (stamped) {
    const drv = registry.get(stamped);
    // 印记引擎已不可用（如 codex 二进制被卸载）→ 回退 claude 并重印记，
    // 宁可降级也不启动一个必然失败的进程。
    if (drv && drv.available()) return drv;
  }
  // 2) 无印记 → 在 available() 后端里随机选一个（claude 恒在候选集）
  const drv = randomChoice(registry.candidates());
  return drv;
}
```

- **印记写入时机**：`ensureLiveSession` pick 后 `rec.hyperEngine = drv.name;
  saveStore()`（镜像 :1417 `rec.mode` / :1426 `saveStore()` 的既有节奏）。
  团队侧 `getOrCreateTeamSession` 在构造 TeamSession 前（或 TeamSession 构造后
  回填）写 `rec.hyperEngineWorkers`，镜像 :1422-1425 对 `rec.sdkSessions` 的回填。
- **中途关开关**（/he off）：印记**不清除**，但下一次 respawn 因 `isHyperEngineOn`
  为 false 走恒 claude —— 已活会话不受影响（引擎粘到会话死亡为止）。印记留着，
  再开开关后 respawn 回到原引擎（可预期、无惊吓）。若要「关了就忘」，可让
  `/he off` 清印记 —— 设计上选**不清**，理由：用户短暂关闭再打开不应静默换引擎。
- **中途开开关**（/he on）：对**已活**会话无影响（pick 只在 spawn 时发生）；下一次
  respawn（重启 / reaper / 显式 kill）才生效。ui-switch.md 的 `/he` 命令回复文案
  必须写明这一点（「将在下次会话重启后生效」）。

---

## 4. agent-session.js 注入点（行号锚点 @ develop 0d070d0）

`_ensureIteration` 的 sdkOpts 构造是唯一的 env/model 汇聚点；hyperEngine 叠加
**插在所有既有赋值之后、fr-45 lint 之前**，即 `composeSystemPrompt`（:672-674）
与 `_validateSdkOpts(sdkOpts)`（:681）之间：

```js
// agent-session.js（设计中的新增块，~10 行）：
// hyperEngine：仅当本会话被指派了非 claude 引擎时叠加。
// opts.hyperEngine 缺省/null/'claude' → 块内无操作，sdkOpts 与现状逐字节一致。
const engineName = this.hyperEngine || 'claude';          // ctor: this.hyperEngine = opts.hyperEngine || null
if (engineName !== 'claude') {
  const drv = hyperRegistry.get(engineName);
  if (!drv) throw new Error(`[hyperEngine] unknown engine ${engineName}`);
  const ov = drv.overlay({
    sdkOpts, modelOverride: this.modelOverride, activeGw: this.activeGw,
    user: this.user, worker: this.workerRole, cwd: this.cwd,
  });
  if (ov.env)    Object.assign(sdkOpts.env, ov.env);     // env 已是 {...process.env,...gwEnv,...gitEnv}（:491），叠加安全
  if (ov.model)  sdkOpts.model = ov.model;                // 叠加在 :659-660 的 gw/系统默认解析之后 → 引擎选择可覆盖
  if (ov.engineOptions) sdkOpts._hyperEngineOptions = ov.engineOptions;  // P0 壳阶段不消费；P1 真后端时由 driver 的 sendTurn 读取
}
```

约束与依据：

1. **P0 壳阶段（主文档两阶段契约）**：opencode/codex/dsh driver 的 `overlay()`
   仍返回空对象（或仅一个命名空间 env，如 `MYCO_HYPER_ENGINE=<name>` 供观测），
   实际推理仍走 claude `query()`。上块在 P0 只产生**可观测的印记**（日志 +
   `MYCO_HYPER_ENGINE` env），行为零变化 —— 这让「随机三选一」的全链路（开关 →
   pick → 印记 → 叠加 → 日志）可以先于真实后端落地验证。
2. **`_validateSdkOpts`（fr-45 lint，:681）必须仍然通过**：叠加块不得引入 SDK
   Options 白名单之外的顶层键。`_hyperEngineOptions` 以 `_` 前缀挂在 sdkOpts 上会
   触发 fr-45 的 unknown-key 日志 —— 因此 P1 设计改为把 engineOptions 存回
   `this._hyperEngineOptions`（AgentSession 实例字段），**不进 sdkOpts**。
3. **每次迭代的叠加是幂等的**：`_ensureIteration` 每轮重建 sdkOpts，叠加块每轮
   重跑 —— driver 的 overlay() 必须是纯函数（无隐藏状态），契约在主文档 §5。
4. **local-claude.js 一次性调用（v1 不接）**：`callLocalClaude()` 走同 SDK 但无
   AgentSession 生命期，无 rec 上下文；主文档将其列为 v1 非目标（与 peer 审计
   「4 spawn 路径」结论一致 —— 一次性调用不属于会话 spawn 面）。

---

## 5. TeamSession 侧的设计块（team-session.js）

```js
// 构造参数（新增，getOrCreateTeamSession 传入）：
//   hyperEngineMode: boolean —— 会话开关态（isHyperEngineOn(rec)）
// _spawnWorker 的 common（:202）新增：
const engine = this._resolveWorkerEngine(actor);   // 见下
...common, hyperEngine: engine.name,

// TeamSession.prototype._resolveWorkerEngine(actor)：
//   1) this.explore === true            → 'claude'（explore 强制 RLM，RLM 底座是 claude query）
//   2) this.hyperEngineMode !== true    → 'claude'（零影响）
//   3) rec.hyperEngineWorkers?.[actor] 已印记且 available() → 复用
//   4) 否则 registry.candidates() 随机
//   结果经回调写回 rec.hyperEngineWorkers[actor]（TeamSession 不直接持有
//   sessions store —— 用构造注入的 onEnginePicked(rec) 回调，避免循环依赖）
```

- **worker 异引擎组合**是特性而非缺陷：worker-A=claude + worker-B=codex 时，
  两 worker 共享同一个 Delm board（`DelmBoard` 唯一连接面，team-session.js:111），
  引擎差异不影响协作协议（board 是 JSONL 持久化消息面，与引擎无关）。
- **事件合流不变**：`_relay`（:254）对 worker 的 agent-event 打 `worker` /
  `workerSeq` 标签推入 team buffer —— P1 真实后端时，各 driver 的归一化层已把
  事件翻成 myco 词汇，`_relay` 无需改动。**这一点是「事件归一化放在 driver 内」
  契约的回报**：TeamSession 对引擎无感知。
- **kill 路径**：`TeamSession.kill` 已为 RLM worker 调 `shutdownRlmKernel`；P1 时
  需为 child-process 引擎（codex）worker 增加 `driver.close()` 调用（`kind`
  字段决定是否需要）—— 设计为在 AgentSession 的 `kill()`（agent-session.js:2485 起）
  统一做 `this._engineRuntime?.close()`，TeamSession 调 worker.kill() 即可，不改团队代码。

---

## 6. 时序行为契约（调度视角）

| 场景 | 行为 |
|---|---|
| 开关 off + spawn | pick=claude；`opts.hyperEngine` 不传或 'claude'；sdkOpts 逐字节同现状 |
| 开关 on + 首次 spawn | 随机 pick（available() 过滤）；印记 rec；叠加（P0 仅观测 env）；日志 `[hyperEngine] session=<id> engine=<name>` |
| 开关 on + respawn（重启/reaper） | 读印记复用；印记引擎不可用 → 回退 claude 并重印记 |
| 开关 on + agent-n2 首建 | 每 worker 独立随机；印记 `rec.hyperEngineWorkers`；回填节奏镜像 rec.sdkSessions（sessions.js:1422） |
| 开关 on → off（活会话中） | 活会话不变；下次 respawn 恒 claude；印记保留 |
| 开关 off → on（活会话中） | 活会话不变；下次 respawn 若有旧印记则复用旧引擎 |
| /run-explore（explore 模式） | worker 恒 claude（RLM 强制底座）；主会话开关照常但 explore 团队不受随机影响 |
| 团队 worker 引擎死亡（P1，codex 子进程退出） | driver 责任（child-process kind）：检测退出 → 归一化 error 事件 → TeamSession stall watchdog（:43）既有机制兜底 nudge/fail；hyperEngine 不在调度层做自动换引擎（印记粘性优先，避免半途换引擎的上下文断裂） |

---

## 7. 零影响不变式（调度层专列）

1. `isHyperEngineOn(rec) === false`（含 `rec.hyperEngineMode` 缺省）→ 四条 spawn
   路径的 `opts.hyperEngine` 均为 'claude'/缺省 → `agent-session.js` 叠加块
   `engineName === 'claude'` 短路 → sdkOpts 与现状逐字节一致。
2. `rec.hyperEngine` / `rec.hyperEngineWorkers` 是**新增字段**：旧 sessions.json
   无此键，读取侧全部 `|| null` / `?.` 兜底，写侧只在开关 on 时触碰 —— 与 fr-102
   （modelOverride）、delm-10（enabledSkills）的旧记录兼容模式一致。
3. `TeamSession` 不改既有分支：`_spawnWorker` 的 RLM/非 RLM 二叉（:225-246）
   只在 `common` 里多一个字段；`_resolveWorkerEngine` 是新增方法。
4. `spawnRlmAgent` / `agents/rlm/` **零改动**：透传由 `Object.assign` 免费获得。
5. explore 模式行为不变：恒 claude = 现状（现状本来就全 claude）。

---

## 8. 测试计划（调度层，全部离线可跑）

| 测试 | 断言 |
|---|---|
| `hyper-pick-off` | `isHyperEngineOn=false` → `pickEngine` 恒 `'claude'`，与印记/worker 参数无关 |
| `hyper-pick-stamp-reuse` | `rec.hyperEngine='codex'`（可用）→ respawn pick 返回 codex（不重新随机） |
| `hyper-pick-stamp-degraded` | 印记引擎 `available()=false` → pick 回退 claude 且建议重印记 |
| `hyper-pick-random-distribution` | 注入 rng 固定种子 → 结果可重入；大样本覆盖 ≥2 个候选（claude 恒在场） |
| `hyper-pick-per-worker` | 两 worker 独立 pick，固定种子下可得到不同引擎；印记分别落在 `hyperEngineWorkers` |
| `hyper-opts-passthrough-rlm` | `spawnRlmAgent(id, {hyperEngine:'opencode', …})` → 返回的 AgentSession `.hyperEngine === 'opencode'`（透传不丢字段） |
| `hyper-explore-forces-claude` | `TeamSession({explore:true, hyperEngineMode:true})` → 两 worker 引擎恒 'claude' |
| `hyper-sdakopts-zero-impact`（关键回归） | `opts.hyperEngine` 缺省/‘claude’ 时，`_ensureIteration` 产出的 sdkOpts 与不接 hyperEngine 的基线 deep-equal（含 env、model、mcpServers 键集） |
| `hyper-fr45-lint-clean` | 叠加后 `_validateSdkOpts` 不产生 unknown-key 日志（engineOptions 不进 sdkOpts） |
| `hyper-team-relay-agnostic` | 模拟异引擎 worker 归一化事件经 `_relay` 打标进 buffer，`worker`/`workerSeq` 正确（团队层引擎无关） |

> 与主文档 §9 测试表的关系：主文档表覆盖 registry / dispatch 基线 / UI 帧；
> 本表补齐**调度时序**（印记复用、降级、explore 强制、团队 relay 无关性、fr-45
> 联动）。全部可用注入 rng + fake driver（available() 可控）离线跑，`BENCH_MOCK=1`。

---

## 9. 开放问题

1. **印记的清除语义**：`/he off` 保留印记（本设计）vs 清除（更「干净」）。若后续
   运维需要强制重随机，可加 `/he repick`（清印记 + 提示下次 respawn 重新随机）——
   v1 不做。
2. **多 worker 扩展（run-explore N 路径）**：explore 恒 claude 已定；未来若允许
   explore 走非 RLM 引擎（自进化机制移植后），`hyperEngineWorkers` 形状天然支持
   N worker（map 按 actor 键）。
3. **印记与 `/he status` 可观测性**：ui-switch.md 已设计 `/he status`；建议其输出
   包含 `rec.hyperEngine` / `rec.hyperEngineWorkers` 当前印记，便于审计（对应主文档
   开放问题 2 的「复现/审计某次对话用了哪个后端」—— 本设计以印记字段直接回答）。
