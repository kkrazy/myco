# TB4 运行流程与 agent 身份分析

> 相关源码：
> - evalscope 适配器 `evalscope/evalscope/benchmarks/terminal_bench/terminal_bench_adapter.py`
> - myco sdk `/data/s00791175/myco-test/myco-1014/sdk/{index,server}.js`、`bench/hle/lib/`
> - myco 引擎 `server/src/local-claude.js`、`server/src/team-session.js`

## 1. Terminal-Bench 4.0 是什么

- 官方 checkout `harbor-framework/terminal-bench`，烧 66 个真实终端任务（含 11 个多容器、
  3 个 H100 GPU 任务）。每个任务目录结构：

  ```
  tasks/<name>/
    task.toml            # 版本 + 资源上限（CPU/内存/GPU）
    instruction.md       # 给 agent 的任务要求
    environment/Dockerfile  # agent 运行环境容器
    solution/            # oracle 解法
    tests/Dockerfile     # verifier（判分）容器
  ```

- 评测范式是 **agent 在 environment 容器里执行终端命令完成任务，verifier 在独立
  容器里判 0/1 reward**（`_extract_valid_reward` → `acc`）。

## 2. evalscope ↔ Harbor 适配（TB4 怎么接入 evalscope）

`terminal_bench_adapter.py`：

- `__init__` 里 `check_import('harbor', extra='terminal_bench', raise_error=True,
  feature_name=...)`（`:141`），并校验 `Harbor>=0.14.0,<1.0.0`（`:621-627`）。
  **`harbor` 是一个 Python 包（Harbor harness），不是 agent。**
- 运行靠 `from harbor.trial.trial import Trial`、`Trial.create(...).run()`（`:195,236`）。
- 判分：读取 trial 的 `verifier_result.rewards['reward']`（0–1），作为 `acc`（`:469-476`）。

### 关键参数（`extra_params`）

| 参数 | 默认 | 说明 |
|---|---|---|
| `agent_name` | `terminus-2` | **TB4 的 agent 类型**。见下 |
| `environment_type` | `docker` | `docker / daytona / e2b / modal` |
| `max_turns` | `None`(用 Harbor agent 默认) | agent 最大轮数 |
| `task_names` | `None` | 指定 Harbor 任务名/glob 过滤 |
| `timeout_multiplier` 等 | `1.0` | 超时控制 |

### agent_name 的选项（evalscope 支持全集）

```
oracle, terminus-2, claude-code, codex, qwen-coder, openhands, opencode, mini-swe-agent
```

- `terminus-2`：唯一用 evalscope 配置的 model 的 agent —— 把 model 包成
  `HarborLLM(model)` 塞进 trial（`:203-211,233-238`）。
- 其余（`claude-code`、`codex` 等）：作为**独立 CLI 工具**运行，用它们自己的 API key
  （`adapter.py:40-42` 描述明确写：`Only terminus-2 uses the evalscope model for
  inference; other agents ... run as standalone CLI tools with their own API keys`）。

## 3. TB4 用的 agent 到底是谁 —— 确切回答

**在 evalscope 原生 TB4 适配器里，agent 不可能是 myco。**

- `AgentConfig(name=self.agent_name, model_name=model.name, ...)`（`:213-218`）——
  `name` 只能取上面那个集合。**myco-single / myco-n2 不在其中。**
- 没有任何配置能让 `agent_name` 指向 myco。要接入 myco，必须：
  - 给 Harbor 写一个**自定义 agent 类型**（在 Harbor trial 环境里驱动 myco 引擎），或
  - 给 evalscope 写**自定义 agent 适配器**。均属新开发，不是改配置。

### myco-sdk 到底注册了什么（与"mycosingle/run-n2"澄清）

myco sdk 的包名是 **`myco-sdk`**（`sdk/package.json` `"name": "myco-sdk"`），并**非**
`harbor` 的 sdk，全树 grep `harbor` 仅命中 demo 题目英文 "harboring" 一词。

sdk 对外暴露 **OpenAI 兼容 HTTP 模型端点**，`/v1/models` 注册的模型 ID 为
（`sdk/server.js:109-112`）：

| 模型 ID | 路由规则 | 底层引擎 |
|---|---|---|
| `myco-single` | 默认 | 单 agent → `callLocalClaude`（`server/src/local-claude.js`），一个
  `@anthropic-ai/claude-agent-sdk` `query()`，`allowedTools: []`（**无工具**） |
| `myco-n2` | 模型名含 `n2`（`/n2/i`，`:114-116`） | run-n2 → `TeamSession`（`server/src/team-session.js`），
  实际 spawn **`worker-A` / `worker-B`** 两个 AgentSession，共享 DelmBoard |

**确切命名**：注册名是带连字符的 `myco-single` / `myco-n2`（你写的不带连字符的
`mycosingle` 略有出入）；`run-n2` 是引擎的 mode 字符串（`engine.answer('n2')`），
n2 模式下真正叫 agent 的名是 `worker-A` / `worker-B`。**不存在字面上叫
"mycosingle" 或 "run-n2" 的 agent。**

⚠️ 关键限制：**myco-sdk 是 answer 式**，`callLocalClaude` 无工具调用；sdk README 也
明确"agentic 工具调用式评测（SWE-bench/BFCL）不适用"。TB4 恰恰是 agentic 终端任务，
myco-sdk 回一个纯文本答案、无终端/工具访问，**无法完成终端任务**。

## 4. 那 myco-sdk 该怎么接 evalscope？

sdk README（`myco-1014/sdk/README.md` 第 107–235 行）**只覆盖 answer 式评测**
（ARC/HLE/MMLU 等）：当 OpenAI 兼容模型节点接，`--model myco-single`（或
`myco-n2`）`--api-url http://127.0.0.1:<port>/v1`。本机已有运行记录印证
（`evalscope/outputs/*/task_config.yaml` 均为 `datasets: [arc]`、`model: myco-single`、
`api_url` 指向 sdk 的 `/v1`）——没有一个 `terminal_bench`。

## 5. 本机现状（实测）

`eval_1793177383351` 日志：
```
WARNING: `harbor` not found. Please run `pip install 'evalscope[terminal_bench]'` ...
ERROR: Task failed (ImportError)
```
`venv/bin/pip show harbor` → **未安装**。所以那次跑 TB4 在 import 即失败，
**没有 agent 运行**。要跑通第一件事：在 evalscope venv 装 `harbor`（内网出网受限，
需走内网 pip 镜像）。
