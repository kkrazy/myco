# Harness² 安装指南

本文档说明如何在 myco 项目里安装和配置 Harness² 集成。

## 前提条件

- myco 服务（mycod）正常运行
- `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL` 已配置（myco 自带网关）
- `claude` CLI 可用（`which claude` 有输出）

## 服务器部署（Docker）

harness² 集成已经内置在 myco 的 Docker 镜像里，无需单独安装。镜像包含：

- `/app/vendor/harness2/` — harness² Python 库（含 myco adapter 和 `claude_local` 通道）
- `/app/bench/harness2/` — myco runner（Node.js，负责 rollout 执行）
- `/app/server/src/harness-*.js` — Node.js 服务端集成

启动容器时确认以下挂载：

```bash
docker run -d \
  -v /your/state:/data \
  -v /your/workspaces:/wks \
  myco:latest
```

## 环境变量

harness² sweep 需要以下环境变量（mycod 启动时自动继承）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | 是 | 网关认证 token |
| `ANTHROPIC_BASE_URL` | 是 | 网关地址 |
| `ANTHROPIC_MODEL` | 是 | 使用的模型 ID |
| `HARNESS2_MYCO_ROOT` | 否 | myco checkout 根目录（默认 `/app`） |

以下变量由 `harness-runner.js` 自动设置，无需手动配置：

| 变量 | 自动值 |
|---|---|
| `HARNESS2_MYCO_PROJECT` | 当前 session 的 cwd |
| `HARNESS2_MYCO_RUNNER` | `/app/bench/harness2/myco-runner.js` |
| `MYCO_SRC` | `/app/server/src` |
| `HARNESS2_SOLVER_MODEL` | `local/${ANTHROPIC_MODEL}` |
| `HARNESS2_JUDGE_MODEL` | `local/${ANTHROPIC_MODEL}` |

## 任务源配置

harness² sweep 需要知道要调优的任务。通过 `/harness run <任务描述>` 直接传入任务文本，无需任何预置文件：

```
/harness run fix greet() to return "hello" instead of "hi"
```

任务文本会通过 `HARNESS2_MYCO_TASK` 环境变量传给 adapter。任何包含项目源文件的目录都能作为调优目标。

## 验证安装

在 myco 的聊天界面里运行：

```
/harness status
```

如果返回 `No sweep running`，说明集成正常。

运行一次快速测试（`--dry-run` 不消耗 token）：

```bash
docker exec myco-tz sh -c '
export HARNESS2_MYCO_PROJECT=/tmp/test-proj
export HARNESS2_MYCO_TASK="test task"
mkdir -p $HARNESS2_MYCO_PROJECT
echo "{}" > $HARNESS2_MYCO_PROJECT/app.py
export PYTHONPATH=/app/vendor/harness2
python3 -c "
from harness2.benchmarks.myco import MycoAdapter
a = MycoAdapter()
print(a.tasks())
"
'
```

输出 `['inline-task']` 表示安装正确。

## 本地开发部署

在本地开发 myco 时，确认以下路径：

```bash
# bench runner
ls bench/harness2/myco-runner.js

# Python vendor
ls vendor/harness2/harness2/benchmarks/myco.py

# 服务端集成
ls server/src/harness-runner.js server/src/harness-result.js server/src/harness-market.js

# 独立模块
ls server/src/agents/harness2/
```

运行本地测试：

```bash
node --test bench/harness2/engine.test.js
node test/harness-runner.test.js
node test/harness-p4-p7.test.js
```

## 从源码开发新功能

### 代码结构

harness² 集成分三层：

```
bench/harness2/          ← rollout 执行层（Node.js CLI）
  myco-runner.js         ← harness² 调用的入口，支持 --mode myco/n2
  lib/engine.js          ← 路径映射、materialise、runRollout、runRolloutN2

vendor/harness2/         ← 提案/调度层（Python）
  harness2/
    benchmarks/myco.py   ← myco BenchmarkAdapter（任务源、adapter 接口）
    core/proposer.py     ← claude_local 通道实现
    core/spec.py         ← CHANNELS 注册
    config.py            ← PROPOSER_MODEL_BY_CHANNEL
    substrate/myco.py    ← MycoSubstrate（调用 myco-runner.js）

server/src/              ← 服务端集成层（Node.js）
  agents/harness2/       ← 统一模块入口
    index.js             ← 门面，re-export 下面三个
    runner.js            ← → harness-runner.js
    result.js            ← → harness-result.js
    market.js            ← → harness-market.js
  harness-runner.js      ← sweep 生命周期（startSweep/cancelSweep/getStatus）
  harness-result.js      ← diff/adopt/rollback/snapshot
  harness-market.js      ← 发布/安装/列表
```

### 开发工作流

**1. 修改 bench 层（rollout 逻辑）**

```bash
# 在本地修改
vim bench/harness2/lib/engine.js

# 运行单元测试
node --test bench/harness2/engine.test.js

# 同步到服务器（需要重建镜像生效）
pscp bench/harness2/lib/engine.js root@<server>:/data/.../bench/harness2/lib/
```

**2. 修改 vendor 层（Python adapter）**

```bash
# 在本地修改
vim vendor/harness2/harness2/benchmarks/myco.py

# 语法检查
python -c "import ast; ast.parse(open('vendor/harness2/harness2/benchmarks/myco.py').read())"

# 同步到服务器
pscp vendor/harness2/harness2/benchmarks/myco.py root@<server>:/data/.../vendor/harness2/harness2/benchmarks/
```

**3. 修改服务端层（Node.js 集成）**

```bash
# 在本地修改
vim server/src/harness-runner.js

# 语法检查
node --check server/src/harness-runner.js

# 运行测试
node test/harness-runner.test.js
node test/harness-p4-p7.test.js

# 同步到服务器（docker cp 热更新，无需重建）
pscp server/src/harness-runner.js root@<server>:/data/.../server/src/
```

### 关键设计约定

**环境变量传递链：**

```
mycod (PID 1)
  └── ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL
       └── harness-runner.js sweepEnv()
            ├── HARNESS2_MYCO_PROJECT = session cwd
            ├── HARNESS2_MYCO_TASK = 任务文本（可选）
            ├── HARNESS2_MYCO_RUNNER = bench/harness2/myco-runner.js
            ├── MYCO_SRC = server/src
            ├── HARNESS2_SOLVER_MODEL = local/${ANTHROPIC_MODEL}
            └── HARNESS2_JUDGE_MODEL = local/${ANTHROPIC_MODEL}
```

**任务源优先级：**

1. `HARNESS2_MYCO_TASK` 不为空时构造单条 `inline-task`
2. 未设置时 preflight 报错

**新增 harness 组件的步骤：**

1. 在 `bench/harness2/lib/engine.js` 的 `COMPONENT_MAP` 或 `DIR_MAP` 里加映射
2. 在 `harness-result.js` 的 `adoptHarness()` 和 `diffHarness()` 里加处理逻辑
3. 在 `docs/arch/harness2-architecture.zh.md` 的组件表里更新
4. 在 `harness-market.js` 的 `validateTree()` 里加验证规则（如有）

**run-n2 专属组件**（`worker_a_startup.md`、`worker_b_startup.md`、`board_guidance.md`）不写入文件系统，通过 `engine.readN2Components()` 读出后传入 `TeamSession` 构造函数。

## 构建说明

修改了 Python 侧（`vendor/harness2/`）或 Node 侧（`bench/harness2/`、`server/src/harness*.js`）后，需要重建镜像：

```bash
# 重建
docker build -f docker/Dockerfile -t myco:latest .

# 重建容器
docker rm -f myco-tz
docker run -d --name myco-tz ... myco:latest
```

`server/src/` 里的 Node.js 文件也可以用 `docker cp` 热更新（无需重建），但下次重建时会被覆盖。
