# Harness² 架构设计

Harness² 是 myco 集成的自动调优系统。给它一个具体的代码任务，它会自动生成多个 harness 配置变体，跑真实 rollout，盲选出最优配置，供人工采纳或发布。

## 整体流程

```
/harness run [--n2] [--k N] <任务描述>
       │
       ▼
  harness-runner.js
  startSweep({ cwd, task, k, rolloutMode })
       │  写 status.json，spawn python3 进程
       ▼
  run_sweep.py (harness² Python 库)
       │
  ┌────┴────┐
  │  提案   │  propose → probe → compose
  │  阶段   │  使用 claude_local 通道（本机 claude CLI）
  │         │  产出 N 个 harness 变体（inv/dom/agg）
  └────┬────┘
       │ N 个 harness 变体
  ┌────┴────┐
  │  执行   │  每个变体跑 rollout
  │  阶段   │  myco-runner.js → AgentSession（单 agent）
  │         │                → TeamSession（--n2 双 agent）
  └────┬────┘
       │ rollout 结果（trajectory.txt + meta.json）
  ┌────┴────┐
  │  盲选   │  不看 harness 内容，只看结果
  │  阶段   │  selection.json（选中哪个 + 理由）
  └────┬────┘
       │
       ▼
  /harness diff → adopt → publish
```

## 模块结构

```
server/src/
  agents/harness2/       ← 统一模块入口（参考 agents/rlm/）
    index.js             ← 门面，re-export 下面三个子模块
    runner.js            ── → harness-runner.js
    result.js            ── → harness-result.js
    market.js            ── → harness-market.js
  harness-runner.js      ← sweep 生命周期（startSweep / cancelSweep / getStatus / 孤儿清理）
                            也是 per-session 隔离的推导点：runsRootFor / sweepTagFor
  harness-result.js      ← diff / adopt / pull / rollback / snapshot
  harness-market.js      ← 市场发布 / 安装 / 列表
  harness-hooks.js       ← c8 hooks.json 声明式钩子
  harness-scripts.js     ← .myco_harness/scripts/ 预批准脚本

bench/harness2/
  myco-runner.js         ← harness² 调用的 CLI，每 rollout 一次
                           支持 --mode myco（单 agent）和 --mode n2（双 agent）
  lib/
    engine.js            ← 路径映射、materialise、runRollout、runRolloutN2
    transcript.js        ← 轨迹渲染（events.jsonl → trajectory.txt）

vendor/harness2/
  harness2/
    benchmarks/myco.py   ← MycoAdapter（任务源、preflight、stage_task）
    substrate/myco.py    ← MycoSubstrate（调用 myco-runner.js）
    core/proposer.py     ← claude_local 通道实现
    core/spec.py         ← CHANNELS 注册
    config.py            ← PROPOSER_MODEL_BY_CHANNEL
```

## harness 组件映射

harness² 用自己的布局（c1..c8）存储配置文件，`myco-runner.js` 在 materialise 时映射到 myco 的路径：

| harness² 路径 | myco 路径 | 说明 |
|---|---|---|
| `systemprompt.md` | `CLAUDE.md` | 角色、流程、规则 |
| `guardrails.md` | `CLAUDE.md`（追加） | 禁止事项 |
| `tool_guidance.md` | `.claude/tool_guidance.md` | 工具使用指南 |
| `hooks.json` | `.claude/hooks.json` | 声明式钩子 |
| `sub_agents/<name>/AGENT.md` | `.claude/agents/<name>.md` | 子 agent（扁平化） |
| `skills/<name>/` | `.claude/skills/<name>/` | 可复用技能 |
| `scripts/<name>.py` | `.myco_harness/scripts/<name>.py` | 预批准脚本 |

### run-n2 专属组件

这三个组件不写入文件系统，在 `TeamSession` 启动时直接注入到 worker 的系统提示词里：

| harness² 路径 | 作用 |
|---|---|
| `worker_a_startup.md` | 覆盖 `STARTUP_A`（worker-A 的任务分解策略） |
| `worker_b_startup.md` | 覆盖 `STARTUP_B`（worker-B 的环境探索策略） |
| `board_guidance.md` | 覆盖 `BOARD_COMMANDS + WAITING`（协作板规范） |

读取路径：`engine.readN2Components(harnessDir)` → 传入 `new TeamSession({ workerAStartup, ... })`。

## sweep 生命周期

```
harness-runner.js
  startSweep({ cwd, task, k, rolloutMode })
    → 生成 sweep id（sw-<timestamp>）
    → 写 _harness_/sweeps/<id>/status.json { status: 'running' }
    → spawn: python3 -m harness2.cli.run_sweep --bench myco --substrate myco --k <k>
        环境变量: sweepEnv({ cwd, task, rolloutMode })
    → 轮询 stderr 进度行，emit chat 事件
    → sweep 结束 → 写 result.json，更新 status.json { status: 'success'|'failed' }
    → server boot 时扫 _harness_/sweeps/*/run.pid，清理孤儿进程
```

## 状态隔离：三个边界

同一个容器里会有多个用户、多个 session 同时跑 sweep，所有状态都必须按作用域分开。

| 层 | 作用域 | 落点 |
|---|---|---|
| sweep 运行目录 | 每 (user, session) | `<MYCO_DATA>/harness2-runs/<user>/<session>/myco/{rollouts,adapt}` |
| namespace | 每 session 一个 tag | `myco-myco-agg<k>-sess-<user>-<hex8>` |
| staging 任务目录 | 每「任务文本」一份，跨 session 共享 | `<MYCO_STAGE_ROOT>/<staging-key>` |
| market 条目 | personal 按 user；published 全局 | `/data/market/` |

`sessionScope(cwd)` 从 `/wks/<user>/<session-id>/…` 拆出两者。cwd 不在这套形状下
（测试、跨挂载）时回落到 `default/<basename>`，保证仍是一个稳定的非共享区。

**namespace tag 有长度约束**：tag 会进入 namespace，namespace 会进入每个 run id，
而 `myco-runner.js` 拒绝超过 64 字符的 run id（因为它是路径的一级）。session id
本身是 `myco-<user>-<8 hex>`，所以 tag 只取 8 位 hex 后缀：

```
正确  sess-t59900502-9cfbc953            → run id 56 字符
错误  sess-t59900502-myco-t59900502-9cfbc953 → run id 71 字符，每个 rollout 在 argv 阶段就死
```

## 任务 staging

rollout 工作区里的任务输入来自一份 staged 拷贝，它在 `_stage()` 时生成并缓存，
之后按「任务文本的哈希」定位。

**为什么要按文本哈希**：所有内联任务共用 id `inline-task`，只按 id 缓存会让容器
里第一个任务变成永久任务——`staged` 标记存活，后续 sweep 拿到的还是旧提示词。

**位置**：默认落在 data 卷（`<MYCO_DATA>/harness2-task-cache`，容器里是 2TB 的
bind mount），而不是 `/tmp`（overlay，约 10GB）。一份 staged 任务是项目的**完整
拷贝**，而 runner 还会把它复制进每个 rollout 工作区——一轮 k=1 sweep 的实际消耗
是 `(1 + 4k) × staged 大小`，所以承载它的卷决定了「任务能多大」。

解析顺序：`MYCO_STAGE_ROOT` → `<MYCO_DATA>/harness2-task-cache` →
`/data/harness2-task-cache` → `tempfile.gettempdir()`。

**大小额度**（两个可配变量，不是硬编码）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `MYCO_STAGE_MAX_FILE_MB` | 单文件上限 | 64 |
| `MYCO_STAGE_MAX_TOTAL_MB` | 整份拷贝上限 | 512 |

超出额度的文件写入 `<meta>/skipped.json`（**meta 目录，不是 task 目录**——后者
里的任何东西都会被当作项目内容复制进工作区），并在 stderr 汇总一行。

> 早先这里是单文件硬编码 2MB。那个数字是为 **proposer 上下文**定的，但同一个
> 目录也是 **agent 的任务输入**，两者额度要求不同，而 proposer 侧本来就有独立
> 保护（`deliverable_files` 排除 seed、自身 512KB 上限）。后果是一个 Silesia
> 语料任务（12 个 5–51MB 文件）起步时工作区里**没有数据**，agent 只能 `find /`
> 去搜。

## rollout 成功/产出的判定

两个判定分开，而且判据必须一次说清楚——两侧都踩过坑：

**runner 侧 `delivered`（`isDelivered`）**：工作区里存在「新增的文件」或
「相对 seed 哈希改变的文件」。不只看 turns：一个被超时杀掉的 rollout 可能
`turns=0` 但已有 51 次工具调用，工具调用才是持久的工作证据。

**adapter 侧 `rollout_ok`**：`runs` 非空，且（`ok` 或 `delivered` 或
`toolCalls > 0`）。三种"看起来失败"都要放行：

| 报告 | 含义 | 判定 |
|---|---|---|
| `runs: []` | runner 在 argv 阶段就退出，没开始 | 失败 |
| `ok:false, delivered:true` | 干完了但停得不干净（n2 stall） | **可用** |
| `ok:false, toolCalls:51` | 撞超时被杀，但确实做了工作 | **可用** |

反过来，只看 `run_dir.exists()` 也不行：substrate 在调用 runner **之前**就建好
目录，失败的 rollout 也有目录。

## stall 看门狗

n2 团队的 liveness 是**按 worker**记录的，不是团队级。团队级计时会让一个忙碌的
worker 掩盖同伴——实测中 worker-B 静默 23 分钟没人发现，因为 worker-A 一直在发事件、
每次都把唯一的计时器清零。

判定分两步：

1. 静默超过 `STALL_NUDGE_MS`（默认 220 分钟，2026-11-05 从 5 分钟调大——长任务
   的合法静默窗口远超旧值）→ 给该 worker 发「继续」提醒。
   若它**还持有 claim**，提醒它去 `board.done` 收尾（不是"去找更多活"——它可能
   已经干完了，只是没关条目）。
   **liveness 只认 worker 自己的 SDK 事件**：桥接的 RLM 子 agent 事件（带
   `rlmLane` 章）不算——否则死掉的 worker 会被自己还在跑的子 agent 永久掩盖。
2. 仍无响应且超过 `STALL_FAIL_MS`（默认 240 分钟，原 8 分钟）→ `team-failed`，
   并在报告里**指名**哪个 worker 卡住。代价：真死的团队要等满 4 小时才判失败。

注意第 2 步的窗口：判失败不能拿第 1 步的窗口——否则会在提醒发出后 20 秒就杀掉
团队，被提醒者根本没有回应时间。

两个窗口都可用 `MYCO_N2_STALL_NUDGE_MS` / `MYCO_N2_STALL_FAIL_MS` 覆盖。

## 重跑与续跑

run id 由 (namespace, task, label) 决定，所以同一 session 内的重跑落在**同一个
run 目录**。runner 在 materialise 之前会清空该目录（带路径越界校验），否则上一轮
留下的产物会让 `isDelivered` 立刻为 true——base rollout 零工作就"交付"。

**想让下一轮从上一轮的结果继续**，正确做法是把产出放进**项目目录**当任务输入：

```
/harness pull --to sol
```

这样它进入 staging 的 seed 清单，`isDelivered` 的语义变成「相对这份基线**被改动
过**」，四路 rollout 全都从同一起点出发，盲选才公平。复用 run 目录做不到这一点：
只有那一路能看到残留，而且 agent 不知道这些文件是谁写的、做到哪了。

## 提案通道（claude_local）

harness² 原生支持 `opencode` 和 `claude_cli`，两个在没有 Vertex 账户的服务器上都不可用。myco 新增了 `claude_local` 通道：

- 保留调用方的 `ANTHROPIC_*` 环境变量（走 mycod 已配置的网关）
- 使用 `--permission-mode acceptEdits --allowedTools Read,Write,Edit,Glob,Grep,LS` 而不是 `--dangerously-skip-permissions`（兼容 root 运行）
- 模型 id 来自 `ANTHROPIC_MODEL` 环境变量（`PROPOSER_MODEL_BY_CHANNEL["claude_local"]`）

## 任务源

sweep 的任务文本通过 `HARNESS2_MYCO_TASK` 环境变量传入，由 `harness-runner.js` 的 `sweepEnv()` 设置：

```
/harness run fix greet()
  → sweepEnv({ task: "fix greet()" })
      → HARNESS2_MYCO_TASK = "fix greet()"
          → MycoAdapter._plan() 构造 [{ id: "inline-task", text: "fix greet()" }]
```

任何包含项目源文件的目录都能作为调优目标，不需要 `_myco_/plan.json`。

## n2 rollout 调用链

```
/harness run --n2 <task>
  → slashcmds.js: rolloutMode = 'n2'
  → startSweep({ rolloutMode: 'n2' })
  → sweepEnv: HARNESS2_MYCO_ROLLOUT_MODE = 'n2'
  → substrate/myco.py: cmd += ['--mode', 'n2']
  → myco-runner.js --mode n2
  → engine.readN2Components(harnessDir)
  → new TeamSession({ workerAStartup, workerBStartup, boardGuidance })
  → worker-A + worker-B 协作 rollout（DelmBoard 协调）
```

## 市场管道（P6/P7）

```
/harness publish
  → harness-market.buildFromSweep()
    → 读 selection.json 找出 chosen_run_dir
    → 读 workspace/ 里的 harness 文件
    → 计算 sha1，构造 item { type: 'harness', files, metadata }
    → market.publishToMarket({ type: 'harness', ... })

/harness-market install <name>
  → harness-market.installIntoSession()
    → market.readMarketItem({ type: 'harness', name })
    → 按组件映射写入 session cwd（同 adoptHarness 的路径逻辑）
    → 写 _harness_/market-installed.json（P8 复用标记）
    → 保存 snapshot 以支持 rollback
```

## P8：经验复用

如果 session 目录下有 `_harness_/market-installed.json`（安装时写入），下一次 `/harness run` 会自动把安装的 harness 作为调优基线（`HARNESS2_MYCO_BASE_HARNESS`），让调优从已知好的配置出发而不是从零开始。

```
sweepEnv() 检查 _harness_/market-installed.json
  → 存在且有效 → HARNESS2_MYCO_BASE_HARNESS = <installed harness dir>
  → 已有显式 override → 保持不变（显式优先）
```
