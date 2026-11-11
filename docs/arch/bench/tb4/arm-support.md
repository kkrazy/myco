# TB4 架构（ARM / aarch64）支持分析

> 前提实况：**本机 = aarch64**（`uname -m` → `aarch64`），Docker server 也是
> `linux/arm64`，无 NVIDIA GPU。
>
> 一条原理：TB4 **框架本身架构无关（纯 Python）**；终端任务靠 Docker 镜像跑
> （`environment/` + `tests/` 每个任务一个），所以"支不支持 ARM"是**逐任务、
> 取决于镜像**的问题。

## 1. 判断方法

对 `tasks/*/environment/Dockerfile` + `tasks/*/tests/Dockerfile` 逐条取 `FROM`
基础镜像，并扫描镜像内的 `uname -m` 分支/硬编码 `x86_64|aarch64` 下载。

- **multi-arch 基础镜像**（有官方 linux/arm64 变体）：`python*`、`ubuntu`、
  `debian`、`node`、`eclipse-temurin`、`oven/bun`、`fedora`、`postgres`、`rust`、
  `condaforge/miniforge3`、`mambaorg/micromamba`。
- **x86-only 基础镜像**（无 arm64）：`nvidia/cuda:*`、`vllm/vllm-openai-cpu:*`、
  `pytorch/pytorch:*cuda*`、`mcr.microsoft.com/playwright*`（微软官方仅构建 amd64）。

## 2. 肯定能跑 / 作者显式支持 arm 的任务（aarch64 分支）

以下 Dockerfile **作者显式写了 `aarch64` 分支**（`conda-linux-aarch64.lock`、
`Linux-aarch64`、`archive-tool-linux-aarch64`、`arm64` opam 等），即**工程上有意
支持 ARM**：

| 任务 | 分支依据 |
|---|---|
| `formal-crypto` | miniforge `Linux-aarch64` + `conda-linux-aarch64.lock`（env/test） |
| `coq-block-bound` | opam `arm64` 校验和（env/test） |
| `freecad-impeller` / `freecad-spring-clip` / `freecad-platform-drawing` | micromamba `conda-linux-aarch64.lock`（env/test；注释明说本地 arm64 构建与 Modal amd64 并存） |
| `wdm-design` | `conda-linux-aarch64.lock`（env/test） |
| `rs-archive-clone` | `archive-tool-linux-aarch64` 预编译二进制（env） |

其余默认 multi-arch 基础镜像的任务（ubuntu/python/node 等）———— **原则上也能在
arm64 上构建运行**，它们不依赖主机架构。

## 3. 不依赖架构的任务清单

**候选（架构无关）：本 checkout `tasks/` 下共 66 个权威任务（按 `task.toml`
计数；`tasks/` 下的 `README.md`、`dataset.toml` 不算任务）。排除 §4 明确的
7 个 x86/GPU/playwright 任务后，**其余 ~59 个任务可视为不依赖架构**——但见
§5 的两条保留项。**

## 4. x86 / GPU 硬限制任务（纯 arm64 跑不了）

| 任务 | FROM（基础镜像） | 原因 |
|---|---|---|
| `jax-speedrun-gpu` | `nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04` | CUDA 镜像只有 amd64；且需 H100(sm_90) |
| `vllm-deepseek-streaming` | `vllm/vllm-openai-cpu:v0.21.0` | vLLM 官方镜像只有 amd64 |
| `fp8-rmsnorm-gemm` | `docker.io/nvidia/cuda:13.2.1-devel-ubuntu22.04` | CUDA 只有 amd64 |
| `math-eval-grader` | environment 是 `python:3.12-slim`（multi-arch），但 **verifier 是 `pytorch/pytorch:2.3.1-cuda`** | verifier 跑不起来，整任务无法完成 |

依赖 **playwright 镜像**的任务（微软 `mcr.microsoft.com/playwright*` 官方仅 amd64）：

| 任务 | 位置 |
|---|---|
| `html-js-filter` | verifier：`playwright/python:v1.52.0-noble`（env 用 python 多架构，OK） |
| `layout-config-recreation` | env + verifier 均用 playwright |
| `nextjs-performance` | verifier：`playwright:v1.53.0-noble` |

备注：playwright 的架构判断我未在断网下逐镜像拉取验证，依据是微软官方
"playwright 镜像仅构建 amd64"的公开事实 + 本机 aarch64 Docker 无 binfmt 模拟，
标注为**高置信但需实测确认**。

## 5. 两条保留项（不确定，需真实验证，不算臆测）

1. **digest 固定**：大量 `FROM ...@sha256:...` 用 digest 锁定。若该 digest 是
   **multi-arch manifest index** → arm64 正常；若是**单平台 amd64 manifest** → 即使
   基础镜像名是 ubuntu/python 也会失败，或需 QEMU/binfmt 模拟。**单看本地文件无法
   断定，需实际 `docker build` / 拉 manifest 确认。**
2. **个别任务内部拉平台相关的第三方镜像/二进制**：
   - `payments-pipeline-fix` 多阶段用 `apache/kafka-native:4.3.1`（kafka native
     GraalVM 镜像，arm64 变体是否可用需确认）；
   - 其他任务大量用 `uv`/`pypi` 安装，多架构一般没问题。

## 6. GPU 与多容器任务

README 明确：66 个任务中含 **3 个 H100 GPU 任务**、**11 个多容器任务**。GPU 任务
（上面 §4 前三个 + 数学判分 verifier）即便在 x86 也需真 N 卡；本机无 GPU、且是
arm64，**GPU 任务整体无法在本机跑**（GPU 不可透传给模拟架构）。

## 7. 结论与建议

- **除 §4 的 4+3 个任务外，其余任务在 arm64 上"不依赖架构"，原则上可跑**；其中
  formal-crypto / coq-block-bound / freecad-* / wdm-design / rs-archive-clone 是作者
  显式写了 aarch64 分支、最稳。
- 在本机全量跑 66 个：先排除 GPU/playwright 那 7 个（或换 x86+GPU 机器），对余下
  逐个实际 `docker build`，确认 digest 是否 multi-arch。
- 若目标是"用 evalscope 跑 TB4"，另需先在本机 venv 装 `harbor`（见
  [`overview-runflow.md`](overview-runflow.md) §5），当前会 `ImportError`。

> 本分析基于 2026-10-29 的 checkout；`make docs-pipeline` 等生成物（`_meta/*.json`、
> `docs/*/benchmarks/terminal_bench_v4.md`）为 evalscope 自动生成，未改动。
