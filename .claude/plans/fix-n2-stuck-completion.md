# 修复 run-n2「工作完成但永不报完成」的两处根因

## 实例复盘（myco-s00791175-0b1beffc，fec-n2-37）

时间线（全部来自 events-worker-A/B.jsonl + docker logs）：

- 06:38 worker-B 正常 `turn_result: success`，但**没调 `board.done`** → 它的两个 claim 悬空。它随后 idle，`_autoCloseStaleClaim` 本应闭合 claim，但**没跑**（原因见根因 2）。
- 06:45:46 worker-A 最后一个 `tool_result` 落盘，之后 SDK 的下一次模型请求**挂死在网关上 66 分钟**（无任何事件）。
- 07:51:53 网关终于报 `API Error: The socket connection was closed unexpectedly` —— SDK 把它当作**正常 `result`（subtype:'success'）** 结束了 turn。这时 worker-A 才 idle，auto-close 才终于闭合两个 claim → `team-complete` → 08:12 弹出 `✅ /run-n2 完成`。
- 也就是说：**结果最终是好的，但中间挂了 66+ 分钟的静默死区**，且全靠网关偶然断线才解锁。

## 根因

1. **无流静默看门狗（agent-session.js）**：`_ensureIteration` 的 for-await 循环没有任何"多久没收到 SDK 事件"的检测。长工具调用（yosys 综合、远端 ssh）可以合法地静默几十分钟，所以不能设短超时；但 66 分钟的纯 API 挂死也没有任何兜底。stall watchdog 在 team-session 层，默认 220 分钟才 nudge —— 对"API 请求挂死"这个形态太钝。
2. **`_autoCloseStaleClaim` 不响应 turn_result（team-session.js）**：auto-close 只挂在 worker `idle` 事件上。而 worker 的 idle 要等**整个迭代 drain**（`_iterating=false`）才 emit —— streaming-input 模式下迭代可以跨多个 turn 长活。worker-B 06:38 turn 成功结束、claim 该闭合，但因为 worker-A 的迭代还挂着，auto-close 无从触发。它在事件序上响应的是"turn 结果"，不是"进程 idle"。

## 修复方案（两处，均带回归测试）

### 修复 1：`server/src/agent-session.js` — 流静默看门狗

- 常量 `TURN_SILENCE_MS = MYCO_N2_TURN_SILENCE_MS || 30 * 60 * 1000`（30 分钟无任何 SDK 事件 = 异常；正常长工具调用单次 Bash timeout 上限 10 分钟，30 分钟留足余量）。
- `_ensureIteration` 进入 for-await 前启动 `setInterval`（tick 60s）：
  - 任一 SDK 事件到达（`_handleEvent` 内统一打点 `this._lastStreamEventAt = Date.now()`）就重置。
  - 静默超阈值 → `console.log('[stream-watchdog] …')` + `this._abortController.abort()`。AbortController 已在 sdkOpts 里（bug-14 修过的正确字段名），abort 会让 for-await 抛 AbortError → 走既有 `iteration_aborted` 路径 → `emit('idle')` → team 层 auto-close / _maybeComplete 正常接管。**不发明新的恢复机制，只触发已有的 abort 通道。**
  - 循环退出（正常 result / abort / fatal）时 `clearInterval`。
  - `unref()` 该 interval，不阻止进程退出。
- 不碰 `write()`/`interrupt()`/`kill()` 语义；用户主动 Stop（interrupt）仍走原 abort 路径，看门狗只是第二个 abort 来源。

### 修复 2：`server/src/team-session.js` — auto-close 也挂在 turn_result 上

- `_relay` 里已有对 `event.type === 'turn_result' || 'iteration_aborted' || 'fatal'` 的判断（打 `_lastDoneAt` 的地方）。在该分支补：`setImmediate(() => this._maybeComplete(actor))`。
- `_maybeComplete` 开头已调 `_autoCloseStaleClaim(actor)`，且自带 `_completed` 幂等守卫 + `!this._busy[actor]` 条件 —— turn_result 到达时该 worker 的 busy 状态由 AgentSession 在 drain 时清，时序上 `_busy[actor]` 仍为 true 的话这次 complete 判空跳过，等 idle 事件兜底（双保险，不改变现有 idle 路径）。
  - 更正：为让 turn_result 路径真正生效，在 turn_result 分支里**先**把 `this._busy[actor] = false` 再调 `_maybeComplete(actor)` —— turn 已结束，该 worker 本轮不再忙；若后续又有 write，`_busy` 会由 write 路径重新置 true。这与现有 idle 处理器的语义一致，只是把触发点提前到 turn 边界。
- 用 `setImmediate` 避免在事件中继的同步栈里直接动 board 状态。

### 修复 2 依赖的一个既有事实

worker-B 的场景里 turn_result（06:38）之后迭代仍活着（因为 worker-A？不——worker-B 是独立 AgentSession，自己的迭代 drain 后 909 行 `emit('idle')` 本该触发 auto-close）。复查发现：**worker-B 的 auto-close 确实应该在 06:38 就触发**。需要先在实现阶段验证 worker-B 当时 idle 是否真的 emit 了（事件里 08:12:50 才有 iteration_aborted，说明 worker-B 的迭代一直没 drain —— 它的 SDK 子进程一直活着等 streaming-input 的下一条消息）。这揭示真正的形态：**streaming-input 迭代常驻，turn 边界才是可靠的"工作做完"信号，idle 不可靠**。修复 2 的 turn_result 触发正是对症的。

## 测试

### `test/agent-stream-silence-watchdog.test.js`（新）

静态 + 行为混合，sub-second：

1. grep：`agent-session.js` 含 `_lastStreamEventAt` 打点、`TURN_SILENCE_MS` 常量、for-await 循环外有 interval 启停、`stream-watchdog` 日志标记。
2. 行为：构造一个假的 stream 异步迭代器 —— 先快速发一个事件，然后永不再发；把 `TURN_SILENCE_MS` 环境变量压到 ~200ms 实例化（env 在模块加载时读，需支持构造时覆盖或 `process.env` 先设再 require —— 实现时采用 `MYCO_N2_TURN_SILENCE_MS` 模块级读取，测试里 spawn 子进程 `node -e` 或 require 前 set env）；断言 AbortController 被 abort（监听 `abort` 事件）且迭代以 `iteration_aborted` 收尾。

### 扩展 `test/team-autoclose-claim.test.js`

3. 新增用例：worker emit `agent-event {type:'turn_result', subtype:'success'}`（经 `_relay` 或直接 emit）→ claim 闭合为 done，无需等 `idle`。

### `test/test.sh`

4. 在 node 测试清单处（`node_test_result` 列表）加新 watchdog 测试行。

## 涉及文件

- `server/src/agent-session.js`（修复 1）
- `server/src/team-session.js`（修复 2）
- `test/agent-stream-silence-watchdog.test.js`（新）
- `test/team-autoclose-claim.test.js`（扩展）
- `test/test.sh`（登记新测试）

## 验证

1. `node test/agent-stream-silence-watchdog.test.js` 绿。
2. `node test/team-autoclose-claim.test.js` 绿（含新用例）。
3. 全量 `./test/test.sh` 绿（Pre-Commit §1）。
4. `grep -n "stream-watchdog" server/src/agent-session.js` 确认日志标记（供 Diagnostics §3 的 loop 过滤器将来捡）。

## 不做的事

- 不改 STALL_NUDGE_MS/STALL_FAIL_MS 默认值（220/240 分钟是用户 2026-11-05 特意调长的，保持）。
- 不在 watchdog abort 后自动重试/续跑 turn —— abort 走 `iteration_aborted`，team 层的 stall nudge / 用户聊天 write 会自然重启迭代；自动重发有重复提交风险（这个案例里工作其实已完成）。
- 不加新的 slash 命令或 UI。
