# Harness² 使用指南

Harness² 自动调优 harness 配置：给它一个具体的代码任务，它会自动生成多个 harness 变体，跑真实 rollout，盲选出最优配置。

## 前提条件

- myco 服务正常运行
- `claude` CLI 可用
- 项目目录可访问（包含项目源代码文件）

## 快速开始

### 1. 跑一次调优

```
/harness run fix greet() to return "hello" instead of "hi"
```

任务文本直接传给 adapter，任何项目目录都能用。k=1 大约 5 分钟。

**可选参数：**

| 参数 | 说明 | 示例 |
|---|---|---|
| `--k <1-4>` | rollout 轮数，默认 1，每加一轮花费翻倍 | `/harness run --k 2 <task>` |
| `--n2` | 用双 agent 协作模式（run-n2）跑 rollout | `/harness run --n2 <task>` |
| `--timeout <时长>` | 每个 rollout 的超时，默认 5h。接受 `1800` / `300m` / `5h`；上限 24h | `/harness run --timeout 8h <task>` |

参数可以组合使用（flag 必须写在任务文本前面）：

```
/harness run --k 2 --n2 fix greet() to return "hello"
/harness run --n2 --k 2 --timeout 5h fix add() to return a+b instead of a-b
```

**超时是怎么算的**：`--timeout` 只设每个 rollout 的上限。sweep 的总墙钟上限由
`4 × k × 每轮超时 + 3600s（改进阶段预留）` 自动推导——比如 `k=1 --timeout 5h`
得到 75600s（21 小时）。刻意不设成固定值：早期的固定 7200s 比 rollout 预算本身
还短，导致 sweep 还没进改进阶段就被杀。

**费用参考**：一轮 `k=1` 全尺寸任务（每路跑满几小时）约 $200；`k=2` 翻倍。

### 2. 查看进度

```
/harness status
```

### 3. 查看差异

sweep 完成后：

```
/harness diff
```

### 4. 采纳

```
/harness adopt
```

把选中的 harness 写进当前 session 的工作区，下一轮对话立即生效。

### 5. 取回 agent 的产出

```
/harness pull
```

`adopt` 装的是 **harness**（`CLAUDE.md`、`skills/`、`memory/`）。agent 在 rollout
里写出来的**代码**不在这里——要拿它用 `pull`。

```
/harness pull                     # 盲选中的那一路
/harness pull --all               # 每一路各一个子目录，直接 diff -r 对比
/harness pull inv1                # 指定某一路
/harness pull --to src            # 指定落点（默认 _harness_/deliverables/<sweep>/）
/harness pull --bulk              # 连数据集和编译产物一起要
```

**它怎么区分"产出"和"噪音"**：一个 rollout 工作区里混着三类文件，只有一类是
agent 的工作——

| 类别 | 判据 | 处理 |
|---|---|---|
| 任务输入 | 与 seed 哈希一致 | 排除 |
| harness 写入 | 在 `meta.harnessWritten` 清单里 | 排除 |
| 其余 | 新增，**或改过种子** | 交付物 |

第三行后半句是关键：**改过种子文件也算产出**。任务给了起始实现时，改它才是
正事；把"文件名在种子里"当成"没动过"会把这个任务本身判为无产出。

大文件按三重过滤：大小（10MB 语料）、扩展名（PNG/PDF/压缩包）、前 8KB 的
NUL 字节探针（编译产物常常没有后缀）。跳过的文件会明确列出来，不静默丢弃。

### 6. 回滚

```
/harness rollback
```

### 7. 发布到市场

```
/harness publish
```

## 手动安装 harness

### 生成模板

```
/harness init
```

生成到 `_harness_/template/`：`systemprompt.md`、`tool_guidance.md`、`guardrails.md`。

n2 模式：

```
/harness init n2
```

额外生成三个 n2 组件：`worker_a_startup.md`、`worker_b_startup.md`、`board_guidance.md`。

### 安装本地 harness

```
/harness install _harness_/template
```

从本地目录安装 harness 到当前 session，支持相对或绝对路径。

## Harness 市场

### 面板操作

打开 Skills 面板 → 点 **Harness 市场** 标签：浏览、查看详情、安装。

### 命令操作

```
/harness-market list
/harness-market info <name>
/harness-market install <name>
```

## run-n2 模式

run-n2 是双 agent 协作模式（worker-A + worker-B 共享一块 DelmBoard）。harness² 可以调优它的协作策略。

n2 专属组件：

| 组件 | 作用 |
|---|---|
| `worker_a_startup.md` | worker-A 的任务分解策略 |
| `worker_b_startup.md` | worker-B 的环境探索策略 |
| `board_guidance.md` | 协作板使用规范和等待策略 |

这三个组件不写入文件系统，在 TeamSession 启动时注入到 worker 的系统提示词里。

## 命令一览

| 命令 | 作用 |
|---|---|
| `/harness run [--n2] [--k <1-4>] [--timeout <dur>] <task>` | 启动 sweep（默认 k=1 单 agent） |
| `/harness status [id]` | 查看 sweep 状态 |
| `/harness cancel` | 取消 sweep |
| `/harness diff [id]` | 查看差异 |
| `/harness adopt [id]` | 采纳 harness |
| `/harness pull [--all] [--bulk] [--to <dir>] [id] [runLabel]` | 取回 agent 产出的代码 |
| `/harness rollback [sweepId]` | 回滚 |
| `/harness publish [id]` | 发布到市场 |
| `/harness init [n2]` | 生成配置模板 |
| `/harness install <dir>` | 安装本地 harness |
| `/harness-market list` | 列出市场条目 |
| `/harness-market info <name>` | 查看条目详情 |
| `/harness-market install <name>` | 从市场安装 |

## 文件布局

采纳后 harness 写入的路径：

| harness² 路径 | myco 路径 | 说明 |
|---|---|---|
| `systemprompt.md` | `CLAUDE.md` | 角色、流程、规则 |
| `guardrails.md` | `CLAUDE.md`（追加） | 禁止事项 |
| `tool_guidance.md` | `.claude/tool_guidance.md` | 工具使用指南 |
| `sub_agents/<name>/AGENT.md` | `.claude/agents/<name>.md` | 子 agent |
| `skills/<name>/` | `.claude/skills/<name>/` | 可复用技能 |
| `scripts/<name>.py` | `.myco_harness/scripts/<name>.py` | 预批准脚本 |
| `worker_a_startup.md` | （注入，不写盘） | n2: worker-A 策略 |
| `worker_b_startup.md` | （注入，不写盘） | n2: worker-B 策略 |
| `board_guidance.md` | （注入，不写盘） | n2: 协作板规范 |

## 跨项目复用（P8）

安装过市场 harness 的 session，下次 `/harness run` 会自动以它为调优的起始基线，而不是从零开始。

## 常见问题

**sweep 启动就失败**：确认 myco 服务正常运行，`claude` CLI 可用。

**采纳后没变化**：采纳后需要开始新的一轮对话才会加载新的 harness 配置。

**想用别的 harness 做基线**：设置环境变量 `HARNESS2_MYCO_BASE_HARNESS` 指向它的目录。
