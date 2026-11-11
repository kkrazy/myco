# myco-runner ↔ Harness² 接口契约

> **状态：冻结（P0）。** 之后只允许**新增字段**，不允许改名、改语义、删字段。
> 任何变更必须 Node 侧（`bench/harness2/`）和 Python 侧（`harness2/substrate/myco.py`）
> 同时修改，并在同一次提交里更新本文件。
>
> 双方读者：`harness2/substrate/myco.py` 的 `execute()` / `read_trajectory()`，
> 以及 `bench/harness2/myco-runner.js`。

---

## 1. 为什么需要这份契约

Harness² 的调优循环（Python）和 myco 的会话执行（Node）是**两个进程**。
没有一份写死的中介格式，两边就会各自演化、互相踩。冻结这份契约后：

- Node 侧可以先交一个 `--dry-run` 桩（返回符合契约的假数据）
- Python 侧拿着桩就能写 `read_trajectory()` 并自测
- 两条线真正并行，而不是互相等待

---

## 2. 调用方式

```bash
node bench/harness2/myco-runner.js \
  --task-dir    <绝对路径>          # 任务输入目录（只读，runner 不写）
  --harness-dir <绝对路径>          # 要执行的 harness 树（写进会话工作区）
  --run-id      <字符串>            # 唯一 run id，调用方生成（[A-Za-z0-9._-]{1,64}）
  --out         <绝对路径>          # 输出根目录（不存在则创建）
  --timeout     <秒>                # 单个 rollout 的硬超时
  [--k <n>]                         # 同一 harness 跑几遍（默认 1）
  [--dry-run]                       # 不调模型，产出契约形状的假数据
```

### 2.1 参数约束

| 参数 | 必填 | 约束 |
|---|---|---|
| `--task-dir` | 是 | 必须存在且是目录 |
| `--harness-dir` | 否 | 省略表示"用默认 harness"（即只写 `task-dir`，不覆盖 `.claude/`） |
| `--run-id` | 是 | `^[A-Za-z0-9._-]{1,64}$`，会被拼进路径，禁止 `/` 与 `..` |
| `--out` | 是 | 绝对路径；runner 会在其下创建 `<run-id>-<i>/` |
| `--timeout` | 是 | 正整数秒；到点 `SIGTERM` → 5 秒后 `SIGKILL` |
| `--k` | 否 | 正整数，默认 1；上限由 runner 决定（初期 2） |

### 2.2 环境变量

| 变量 | 含义 | 默认 |
|---|---|---|
| `MYCO_SRC` | myco 的 `server/src` 绝对路径 | **必填，无默认**（见 §6.2） |
| `MYCO_ENV` | 读取模型/代理配置的 `.env` 路径 | 无（用进程环境） |
| `MYCO_HARNESS_ALLOW_ALL` | 设为 `1` 时会话使用 `autonomousPermission` | 未设 |

> **注意**：runner **不使用** `MYCO_ALLOW_ALL`。那是进程级变量，会污染同进程的
> 其他会话。无人值守要用会话级的 `autonomousPermission`（`agent-session.js:229`）。

---

## 3. 退出码

| 码 | 含义 |
|---|---|
| `0` | 整批跑完（**不代表任务成功**，成功看 §4 的 `ok`） |
| `1` | 参数错误 / 环境错误（`MYCO_SRC` 不存在等） |
| `2` | runner 自身故障（内部异常） |

调用方**必须先看退出码，再看 JSON**。

---

## 4. stdout：单行 JSON

**stdout 只能是这一行 JSON。** 所有日志走 stderr（§5），这样解析不会有歧义。

```json
{
  "contract": 1,
  "run_id": "r-0001",
  "harness_dir": "/abs/harness",
  "task_dir": "/abs/task",
  "ok": true,
  "k": 1,
  "runs": [
    {
      "run_id": "r-0001-1",
      "run_dir": "/abs/runs/r-0001-1",
      "ok": true,
      "delivered": true,
      "cost_usd": 0.12,
      "wall_s": 145.2,
      "turns": 7,
      "error": null
    }
  ],
  "error": null
}
```

### 4.1 字段语义

| 字段 | 类型 | 含义 |
|---|---|---|
| `contract` | int | 契约版本，当前 `1`。**Python 侧必须检查** |
| `run_id` | string | 回显调用方传入的 `--run-id` |
| `harness_dir` | string \| null | 回显 `--harness-dir` 的绝对路径；未传时为 `null` |
| `task_dir` | string | 回显 `--task-dir` 的绝对路径 |
| `k` | int | 回显 `--k`；`runs.length` 可能小于它（部分失败） |
| `ok` | bool | **这批 runner 正常完成**（不是任务成功） |
| `runs[]` | array | 每次 rollout 一条，长度 `≤ k` |
| `runs[].ok` | bool | 这次 rollout 的 agent 正常结束（没崩、没超时） |
| `runs[].delivered` | bool | 任务约定的交付物存在（判定规则见 §7） |
| `runs[].cost_usd` | number \| null | 估算成本；拿不到就是 `null`，**不要填 0** |
| `runs[].wall_s` | number | 墙钟秒数 |
| `runs[].turns` | int | agent 回合数 |
| `runs[].error` | string \| null | 失败原因（人类可读，不含 token） |
| `error` | string \| null | 批次级错误（如参数不合法） |

**失败语义**：`ok: false` 时 `runs` 可能为空数组，`error` 必有值。
**部分失败**：`ok: true` 但某个 `runs[i].ok: false` —— 这是合法状态，调用方要逐条判断。

---

## 5. stderr：进度行

供 `harness-runner.js`（mycod 侧）解析成面板进度。**不是** Python 侧的接口。

```
[progress] stage=materialise run=r-0001 1/1
[progress] stage=rollout run=r-0001-1 start
[progress] stage=rollout run=r-0001-1 tool=Bash
[progress] stage=rollout run=r-0001-1 done ok=true 145.2s
[progress] stage=done run=r-0001 1/1 ok
```

| 字段 | 取值 |
|---|---|
| `stage` | `materialise` / `rollout` / `done` |
| `run` | run id |
| `tool` | 当前工具名（可选，用于面板显示"正在做什么"） |

其他 stderr 行是自由格式日志，解析方应忽略不匹配 `[progress]` 前缀的行。

---

## 6. 目录布局

### 6.1 输出

```
<out>/
  <run-id>-<i>/                 # i 从 1 开始
    trajectory.txt              # ★ Python 侧唯一要读的文件
    events.jsonl                # 原始 SDK 事件（调试用，Python 侧不解析）
    workspace/                  # 会话工作区快照
    meta.json                   # 见 §6.3
    runner.log                  # 本次 rollout 的 stderr 落盘
```

`workspace/` 里是**任务交付物**所在。runner 在 rollout 结束后把会话工作区
（不含 `node_modules`）复制进来，保证 sweep 之后还能检查交付物。

### 6.2 `MYCO_SRC`

`bench/harness2/lib/engine.js` 通过 `require(<MYCO_SRC>/...)` 拿 myco 的模块。

**没有默认值。** 现有 `bench/hle/lib/engine.js` 默认写死
`/data/s00791175/myco-test/myco-1014/server/src`，那台机器不存在，照抄会踩。
未设置时 runner 直接退出码 `1` 并打印修复命令。

### 6.3 `meta.json`

```json
{
  "contract": 1,
  "run_id": "r-0001-1",
  "harness_dir": "/abs/harness",
  "task_dir": "/abs/task",
  "cwd": "/abs/runs/r-0001-1/workspace",
  "model": "GLM",
  "startedAt": "2026-10-28T07:12:31.004Z",
  "finishedAt": "2026-10-28T07:14:56.203Z",
  "wall_s": 145.2,
  "timeoutHit": false,
  "exitCode": 0,
  "nodeVersion": "v20.20.2"
}
```

---

## 7. `delivered` 的判定

**规则（有序，命中即停）**：

1. `<task-dir>/DELIVERABLE` 文件存在 → 读它，取第一行作为相对路径，检查
   `workspace/<该路径>` 是否存在
2. 否则，`workspace/` 内**新增或修改**的非隐藏文件（排除 `.claude/`、`_myco_/`、
   `.myco_harness/`、`node_modules/`）数量 > 0 → `true`
3. 否则 `false`

规则 1 给 benchmark 精确控制；规则 2 是"agent 确实改了点东西"的兜底。

---

## 8. 轨迹语法（`trajectory.txt`）

**与 `harness2/substrate/opencode.py:render_events()` 的输出形态一致**——
Python 侧两条路径共享同一个 `read_trajectory` 消费逻辑。

逐行：

```
[ACTION] <tool_name>(<args JSON，按 args_trunc 截断>)
[OBSERVATION] <tool result，按 obs_trunc 截断>
[OBSERVATION ERROR] <工具报错内容>
[ASSISTANT] <assistant 文本，按 obs_trunc 截断>
[THINKING] <thinking 文本，按 obs_trunc 截断>
[ERROR] <会话级错误>
```

### 8.1 截断规则

| 参数 | 控制什么 | 下限 |
|---|---|---|
| `obs_trunc` | `[OBSERVATION]` / `[ASSISTANT]` / `[THINKING]` 单条上限 | **10000 字符**（`core/spec.py` 硬性拒绝更小值——截断会凭空造出缺陷） |
| `args_trunc` | `[ACTION]` 参数上限 | 400（myco 侧固定用 400） |
| `max_chars` | 整份轨迹上限 | 由 `BenchSpec` 给定 |

超过 `max_chars` 时截断尾部并追加一行
`…(+N chars — render truncation)`，**与该格式完全一致**（注意是全角省略号 `…`）。

### 8.2 截断标记

单条截断时追加 `…(+N chars — render truncation)`，N 为被丢弃的字符数。
与 `harness2/substrate/opencode.py` 的 `_TRUNC_FMT` 逐字节相同。

### 8.3 空轨迹

没有任何可解析事件时，输出**恰好**一行：

```
(no parseable events in trajectory)
```

---

## 9. 并发与隔离

- `--k n` 时 n 个 rollout **并发**执行（初期宽度 2）
- 每次 rollout 一个**独立进程**、一个**独立工作区**、一个**独立 `_myco_/`**
- rollout 之间**不共享**任何会话状态
- 任一次超时不影响其他次

---

## 10. 契约版本管理

`contract` 字段当前为 `1`。以下变更**不需要**升版本（向后兼容）：

- 新增可选字段
- 新增 `[progress]` 的 `stage` 取值

以下变更**必须**升版本并同时改两侧：

- 改字段名 / 删字段 / 改语义
- 改目录布局
- 改轨迹语法标记

---

## 11. dry-run 桩的保证

`--dry-run` 必须：

- 产出**完全符合 §4 / §6.1 / §6.3 / §8** 的结构（假内容，真形状）
- **不 require 任何 myco 模块**（所以不需要 `MYCO_SRC`）
- **不调用任何模型**
- 退出码 `0`，`ok: true`
- 轨迹里放一条 `[ACTION]` + `[OBSERVATION]`，确保 `read_trajectory()` 有东西可解析

Python 侧在 P1 的真实 runner 就绪前，只依赖 dry-run 桩。
