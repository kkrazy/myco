# Terminal-Bench 4.0 分析

> 状态：**分析文档**。基于本机 checkout
> `/data/s00791175/myco-test/terminal-bench`（`harbor-framework/terminal-bench`，
> HEAD `2c22157c`）与 evalscope `terminal_bench_v4` 适配器源码逐条核实，非臆测。
> 相关结论均附带代码路径。

TB4 = evalscope 内置 benchmark `terminal_bench_v4`（Terminal-Bench-4.0），通过
Harbor harness 在隔离容器里跑 agent 的终端任务评测。本目录拆成：

| 文档 | 内容 |
|---|---|
| [`overview-runflow.md`](overview-runflow.md) | TB4 怎么跑、evalscope↔Harbor 适配、**agent 到底是谁**、与 myco-sdk 的关系 |
| [`arm-support.md`](arm-support.md) | 架构（ARM/aarch64）支持分析：哪些任务能跑、哪些是 x86/GPU 硬限制 |

## TL;DR（三句结论）

1. **`harbor` 不是 agent，也不是 myco 的 sdk**。在 evalscope TB4 里 `harbor` 是一个
   **Python 包 / 评测 harness**（`pip install 'evalscope[terminal_bench]'`）；本机
   venv 未安装，导致 `eval_1793177383351` 在 import 阶段直接 `ImportError`、任何
   agent 都没跑起来。

2. **TB4 的 agent 由 `agent_name` 参数决定，默认 `terminus-2`**，可选
   `oracle / terminus-2 / claude-code / codex / qwen-coder / openhands / opencode /
   mini-swe-agent`。**列表里没有 myco**。myco-1014 的 sdk 是
   `myco-sdk`（OpenAI 兼容 answer 式模型端点，暴露 `myco-single` / `myco-n2`），
   不是 Harbor agent 类型，也无法用 evalscope 原生 TB4 适配器接入。

3. **架构（ARM）**：框架本身架构无关；能不能跑落到每个任务的 Docker 镜像。至少
   4 个任务是 **x86/GPU 硬限制**（`jax-speedrun-gpu`、`vllm-deepseek-streaming`、
   `fp8-rmsnorm-gemm`、`math-eval-grader` 的 verifier），另有 3 个依赖
   playwright 镜像（微软官方仅 amd64）。**本机为 aarch64/arm64**，无 GPU。
