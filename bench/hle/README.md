# myco HLE 基准测试(hle)

在 **HLE**(Humanity's Last Exam,2500 题)上对比 **myco 单agent** 与 **myco run-n2**(双 agent)两种模式的答题能力。

**核心原则:接口直接复用 myco 源码,不重写引擎。**
- 单agent -> myco `server/src/local-claude.js` 的 `callLocalClaude`
- run-n2  -> myco `server/src/team-session.js` 的 `TeamSession`(worker-A + worker-B + 共享 board,与 `/run-n2` 同一套机制)
- 这些 myco 模块通过 `NODE_PATH=bench/hle/node_modules` 解析其 `@anthropic-ai/claude-agent-sdk` / `zod` 依赖,**不修改 `server/` 任何代码**。

myco 侧以**阻塞式 POST 接口**暴露,给编排脚本(agent-bench 用)调用:

| 接口 | 说明 | 返回 |
|---|---|---|
| `GET  /` | 服务信息(模型/是否 mock) | `{ok, model, baseUrl, mock}` |
| `POST /answer` | `{mode:'single'\|'n2', question, system?, timeoutMs?}` 阻塞到返回回答 | `{ok, mode, answer, ms, error?}` |
| `POST /judge` | `{engine:'single'\|'n2', question, answer, truth, timeoutMs?}` 用该引擎判 `answer` 相对 `truth` 的对错 | `{ok, engine, correct, extracted, answer, ms, error?}` |

## 目录

```
bench/hle/
  server.js            # 阻塞式 POST 服务(内部复用 myco 引擎)
  run.py               # 编排:并行+分批答题、交叉判分、实时进度、报表
  lib/
    config.js          # 读取 myco 状态 .env 的模型+代理配置
    engine.js          # 复用 callLocalClaude / TeamSession 的薄适配层
    judge.js           # 判分 prompt(HLE 官方判分思路)+ 结果解析
    loader.py          # 解析 problems/*.md -> {id, question, truth}
  scripts/install.sh   # 装 SDK(走代理)
  scripts/server.sh    # 启动 POST 服务
  run_all.sh / run_single.sh / run_n2.sh
  demo/01.json          # 示例问题集(每行一个 JSON 题,`--questions demo/01.json` 直接跑)
  work/<YYYYMMDDHHMMSS>/# 本次测试的工作区:每次运行一个时间戳目录
    n2/<序号>/          #   run-n2 每题一个目录,按题目序号 0001..2500 命名
      final_answer.txt  #     最终答案
      transcript.txt    #     轨迹:模型具体打印 + 调用信息(见下)
      problem.txt / problem_id.txt / board.jsonl / events-worker-{A,B}.jsonl
    single/<序号>/      #   单agent 每题一个目录,和 n2 同级
      final_answer.txt
    result/             #   本次运行的输出:report.md / results.json / results.jsonl
      #   transcript.txt 记录每个 worker 的「模型具体打印 + 调用信息」:
      #   [worker-A][assistant] … 模型的文本输出
      #   [worker-A][tool_use] <工具名> <入参>   /  [tool_result] <结果>
      #   [worker-A][turn_result] … 回合结束的最终文本
      #   (events-worker-{A,B}.jsonl 只含 thinking_tokens 系统噪音,看模型
      #    实际说了/做了什么请看 transcript.txt)
```

## 安装(一次)

```bash
cd /data/s00791175/myco-test/myco-1014/bench/hle
bash scripts/install.sh        # 代理 npm install,装 SDK 到 node_modules
```

## 运行

**一键拉起(单agent + run-n2 并行 + 交叉判分 + 汇总表):**
```bash
cd /data/s00791175/myco-test/myco-1014/bench/hle
./run_all.sh --limit 20 --concurrency 3     # 先只跑 20 题试试
```

**分别拉起(只跑单agent / 只跑 run-n2),同样支持分批、并发、分片:**
```bash
./run_single.sh --limit 20 --concurrency 3
./run_n2.sh     --limit 20 --concurrency 2
```

**手动起服务再跑(便于实时看并发):**
```bash
MYCO_ENV=/data/s00791175/Delm/mycoFile/state/.env scripts/server.sh --port 8787
HLE_SERVER=http://127.0.0.1:8787 python3 run.py --mode all --concurrency 2 --batch 10
```

### run.py 常用参数(分批 / 分配下发,支撑不住就调档)
```
--problems <dir>      题目目录(默认 agent-bench/bench/hle/problems)
--questions <file>    直接从 JSON-lines 文件加载问题集(每行一个 {id,question,truth,seq?}),
                      绕开 --problems 目录。想快速跑一组自选题:
                        ./run_all.sh --questions demo/01.json            # 跑 demo(8 题)
                        ./run_all.sh --questions demo/01.json --limit 3
--mode all|single|n2  跑哪些管道(all=单agent+run-n2 并行)
--concurrency N       同时并行处理的题数(每题内部答题/判分再并行)
--batch N             分批下发的批次大小(用于进度/续跑)
--limit N             只跑前 N 题
--range a:b           只跑下标 [a,b) 的连续一段(按下标,不能按难度挑)
--ids <id1,id2,...>   只跑指定这些题目 id;也可传一个文件路径(file 里每行一个 id,
                      支持逗号和 # 注释),如 --ids /path/to/ids.txt
--shard k/n           分片:k/n(多机/多进程分配)
--text-only           只跑纯文本题(跳过带图题;带图题块最难,常超时/502)
--timeout <ms>        每题模型超时(默认 600000)
--no-resume           忽略已有 results.jsonl 重新跑
```

## 交叉判分方式

每题以 `problems/*.md` 里的 `## Answer` 为**标准答案**(ground truth):
- **单agent 的回答** -> 用 **run-n2** 引擎当裁判判对错(engine=n2)
- **run-n2 的回答** -> 用 **单agent** 引擎当裁判判对错(engine=single)

## 输出(结果呈现,md + json 都有)

报告写入 `work/<YYYYMMDDHHMMSS>/result/`:`report.md`(人眼可读)+ `results.json`(机器可读)+ `results.jsonl`(增量续跑),与本次运行的 `n2/`、`single/` 工作区同在一个时间戳目录。默认 `--out` 自动对齐到 server 的 `work/<stamp>/result/`(通过 `GET /` 的 `workRoot`);`run_all.sh` 用同一个 `--stamp` 起 server,报告和 worker 一定同目录。

**增量落盘 + 断点续跑**:每答完/判完一题,该题的 `{id, single, n2, judge_*}` 行会立刻追加写入 `results.jsonl`(实时,进程被杀也不丢已完成部分)。重新运行不带 `--no-resume` 时,自动加载 `results.jsonl` 并**跳过已完成的题**(只补跑没做完的)。服务端还保证:任何一题在 `--timeout` 内没答完会被中止并记为失败(返回 `ok:false`,不会卡死整个批)。

`report.md` 以**正确率分析**为主:
1. **正确率(唯一的核心指标)**:只统计「**双方都有答案**」的题目(单agent 与 run-n2 都给出了非空回答)作为分母——只出一边的题无法公平对比,已从分母剔除。给出两模式各自的答对数 / 正确率,以及谁更高。
2. **逐题明细**:仅列出「双方都有答案」的题,每题 `n2 答案 → 对/错(by single)` 与 `single 答案 → 对/错(by n2)`,方便人眼复核。
3. 不再输出速度对比 / 正确性胜出清单——report 只汇报正确率。

## 离线冒烟(不调模型)
```bash
scripts/server.sh --mock --port 8787 &
python3 run.py --server http://127.0.0.1:8787 --mode all --limit 5
```
`--mock` 让引擎返回预设答案,校验 HTTP 契约 / 编排 / 报表结构。

## 只改 bench 的说明
所有新增/修改都只在 `myco-1014/bench/hle/` 内;对 `server/` 和
`agent-bench/bench/hle/problems`(只读)不做任何改动。模型配置默认读取
`MYCO_ENV` 指定的 myco 状态 `.env`(默认 `/data/s00791175/Delm/mycoFile/state/.env`)。
