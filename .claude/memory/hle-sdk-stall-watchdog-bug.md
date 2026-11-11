---
name: hle-sdk-stall-watchdog-bug
description: myco bench hle 的 `[local-claude] sdk error: Assignment to constant variable` 根因与修复
metadata:
  type: project
---

问题：`bench/hle` 跑 hle 时 `server.log` 全是 `[local-claude] sdk error: Assignment to constant variable.`，single 每题 final_answer 都是 1 字节空（`\n`），测试结果全空。

根因（2026-10-30 逐步排查确证）：`server/src/local-claude.js` 的 **stall watchdog**（`stallTimeoutMs>0`，`singleAsk` 默认传 `HLE_STALL_MS=120000`）与 claude-agent-sdk + 华网关（`ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com`）交互，触发 SDK 内部该 TypeError。**与并发数、SDK 版本（0.3.309/0.3.142 都撞）、CLAUDE_CODE_* 环境变量无关**——独立进程并发调 `callLocalClaude` 不带 `stallTimeoutMs` 时 100% 成功，一加 `stallTimeoutMs:120000` 就 100% 报错。

**修复**：`singleAsk` 读 `HLE_STALL_MS` env（`Number(process.env.HLE_STALL_MS || 120000)`），设 `HLE_STALL_MS=0` 禁用 watchdog 即绕过，不改任何代码：
```bash
HLE_STALL_MS=0 HLE_PORT=8801 bash run_all.sh --questions demo/q-30.json --concurrency 30 ...
```
验证：stamp `hle-20261030163322`-like，sdk_error=0，single 出非空答案。

**为什么**：watchdog 里 `ac.abort()` 对 SDK stream 的 abort 路径在网关下会产生该非法赋值错误（疑似 SDK 对 abort 的处理 bug）。

**How to apply**：以后 hle 跑全失败、server.log 满屏 `Assignment to constant variable` 时，先查是不是没设 `HLE_STALL_MS=0`。排查手法：独立 node 脚本并发调 `server/src/local-claude.js` 的 `callLocalClaude`（sys.path 指向 `bench/utils/env` + `NODE_PATH=bench/hle/node_modules`），逐参数二分定位。关联 [[bench-tb4-utils]]。
