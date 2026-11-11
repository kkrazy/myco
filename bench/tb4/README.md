# myco TB4（Terminal-Bench 4.0）基准测试(bench/tb4)

在 **Terminal-Bench 4.0** 的**终端任务**上对比 **myco 单agent** 与 **myco run-n2**（双 agent）
作为 agent 的执行效果。与 hle 同一套骨架：node 阻塞式 POST 服务驱动 myco 引擎 + python 编排 +
增量落盘 + 报表；判分改用 **TB4 官方 verifier**（每个任务自带的 tests/ 容器判 0/1），而非 hle 那种
引擎互判。

**核心原则：接口直接复用 myco 源码，不重写引擎。**
- single -> myco `server/src/agent-session.js` 的 **工具型单 AgentSession**（Bash 等工具、
  `autonomousPermission:true` 自主批准），与 `compare-lanes.js` 的 /compare single shadow lane 同款。
  > 注意：hle 的 single 用 `callLocalClaude`（无工具）只能答题；TB4 是 agentic 终端任务，
  > 所以这里 single 是有工具的变体。
- run-n2  -> myco `server/src/team-session.js` 的 `TeamSession`（worker-A + worker-B + 共享 board），
  与 `/run-n2` / hle n2Ask 同一套机制。
- 这些 myco 模块通过 `NODE_PATH=<bench/hle>/node_modules`（`run_all.sh` 设置）解析其
  `@anthropic-ai/claude-agent-sdk` / `zod` 依赖，**不改 `server/` 任何代码**。

## 每个任务怎么跑

1. **工作区物化**（`lib/workspace.py`）：build 一次任务的 `environment/Dockerfile` 镜像，
   `docker cp` 把容器内 `/app`（任务初始数据/源码）拷到 `work/tb4-<stamp>/<task>/seed/`，
   再复制成 `single/`、`n2/` 两份。**agent 在宿主机这些工作区里操作**（不强制 Docker 隔离）。
2. **agent 运行**（`node server.js` 的 `POST /run` + `lib/engine.js`）：single/n2 在各自 cwd
   跑任务；系统提示/任务文本里注明天 `/app/...` 映射到当前工作目录（相对路径）。完成或超时即返回。
3. **判分**（`lib/verify.py`）：build 一次任务的 `tests/Dockerfile`，`docker run --rm
   -v <工作区>:/app -v <resultdir>:/logs/verifier <img> bash -c "/tests/test.sh"`，
   读 `/logs/verifier/reward.txt`（1/0；缺省回退 reward.json / reward-details.json）判对错。
4. **编排与报表**（`run.py`，复用 `bench/utils/orch.py`）：逐任务跑 single+n2（默认顺序）→ 各自
   verify → 写 `results.jsonl`（增量续跑）+ `report.md` / `results.json`（single acc、n2 acc、逐题用时、
   正确性/速度对比）。

## 目录

```
bench/tb4/
  server.js            # POST /run(mode,cwd,instruction) 阻塞式服务；复用 utils/http-server + utils/env
  run.py               # 编排：物化→跑→验→报表；复用 utils/orch
  run_all.sh / run_single.sh / run_n2.sh
  package.json
  lib/
    loader.py          # 解析 tasks/<name>/{task.toml,instruction.md}
    workspace.py       # docker build env + docker cp /app -> host 工作区
    verify.py          # docker build tests + 跑 verifier -> 0/1
    engine.js          # 工具型 single AgentSession + n2 TeamSession 驱动（复用 myco 模块）
  work/tb4-<stamp>/    # 每次运行一个时间戳目录（与 hle-<stamp> 区分）
```

## 任务选择（ARM 宿主 / 无 GPU）

默认清单 5 个（最快 + 架构无关，避开 arm-support.md 里的 GPU/playwright 硬限制任务）：
`photonic-waveguide-routing`(0.75h)、`music-harmony`(1h)、`bun-sourcemap-leak`(1.5h)、
`foodstuff-beta-activity`(1.5h)、`interleaved-vigenere`(2h)。
可随时用 `--tasks <name1,name2,...>` 增删。想更多可从 hle 的 `docs/arch/bench/tb4` 分析里挑。

## 运行

```bash
cd /data/s00791175/myco-test/myco-1014/bench/tb4
./run_all.sh --tasks photonic-waveguide-routing,music-harmony   # 跑这两个
./run_all.sh --mode n2 --timeout 3600000                        # 只跑 run-n2，每题超时 1h
./run_single.sh --tasks music-harmony
```

常用参数：
```
--tasks <n1,n2,...>   任务名列表（默认上面的 5 个）
--mode all|single|n2  跑哪些 agent（默认 all）
--timeout <ms>        每个 agent run 超时（默认 7200000=2h；5 任务×2 模式×2h≈20h，落进 8-24h）
--verify-timeout <ms> verifier 超时（默认 3600000=1h）
--parallel-modes      某任务内 single+n2 并行（默认顺序，避免抢资源）
--skip-verify         跳过 docker verifier（调试）
--no-resume           忽略已有 results.jsonl 重跑
```

## 离线冒烟（不调模型，不 build 镜像）

```bash
NODE_PATH=/data/s00791175/myco-test/myco-1014/bench/hle/node_modules \
  node server.js --mock --port 8790 &          # mock 引擎返回预设结果
python3 run.py --server http://127.0.0.1:8790 --tasks photonic-waveguide-routing \
  --timeout 5000 --out /tmp/t --no-resume --skip-verify
```
`--mock` 让引擎不真调模型，校验 HTTP 契约 / 编排 / 报表结构。

## 与 hle 的关系

共享的纯模块抽到 **`bench/utils/`**（`env.js` / `http-server.js` / `orch.py`），hle 与 tb4 共同 import；
hle 专属逻辑（no-tool singleAsk、judge.js、loader.py、报表细节）仍在 hle 原样。抽离后 hle 用 mock
冒烟验证过行为不变。所有改动只在 `bench/` 内，`server/` 与 `terminal-bench` checkout 不改。

## 依赖代码与前置准备（重要）

TB4 本身**不携带任务数据、不重写引擎**，运行时依赖以下几处外部代码，用之前先确认到位：

| 依赖 | 默认路径 | 说明 | 覆盖方式 |
|---|---|---|---|
| **Terminal-Bench 任务 checkout** | `/data/s00791175/myco-test/terminal-bench/tasks` | 每个任务一个目录：`task.toml` / `instruction.md` / `environment/`(Dockerfile+数据→`/app`) / `solution/`(oracle) / `tests/`(verifier)。`--tasks` **只从这里本地选单，不联网下载任务** | `TB4_TASKS_ROOT` |
| **myco 引擎源码** | `myco-1014/server/src/`（`agent-session.js` / `team-session.js`） | single/n2 直接复用 myco 的 AgentSession（工具型）与 TeamSession，**不改 `server/` 任何代码** | `MYCO_TB4_SRC` |
| **claude-agent-sdk 依赖** | `bench/hle/node_modules`（当前 0.3.142） | `run_all.sh` 设 `NODE_PATH=<hle>/node_modules` 复用 hle 已装的 SDK，**不重复安装** | 本地 `./node_modules` 优先 |
| **模型/代理配置** | `/data/s00791175/Delm/mycoFile/state/.env`（华网关） | `server.js` 启动时经 `utils/env.js` 自动加载 | `MYCO_ENV` |
| **Docker** | 本机 `docker` | 物化工作区（build `environment/Dockerfile` + `docker cp /app`）与判分（build `tests/Dockerfile` 跑 verifier） | — |

### 对应操作

1. **checkout Terminal-Bench**：确认任务在 `TB4_TASKS_ROOT`（默认上面的路径）下齐全，例如
   `photonic-waveguide-routing`、`music-harmony`、`interleaved-vigenere` 等（仓库共 68 个任务）。`--tasks a,b,c` 只是从本地挑，**不会去网上下载任务**。
2. **装好 hle 依赖**：`cd bench/hle && npm i @anthropic-ai/claude-agent-sdk@0.3.142 zod`（TB4 复用同一份 SDK）。
3. **确认 myco 源码在位**：`server/src/agent-session.js`、`server/src/team-session.js`、`server/src/local-claude.js` 存在（TB4 只读不修改）。
4. **确认 Docker 可用**：`docker version` 正常；**首次跑某任务会 `docker build` 它的 env/tests 镜像，若基础镜像（`python:…-slim` / `oven/bun` 等）本地没有会联网从 Docker Hub 拉取**，拉过一次后缓存，后续离线可跑。
5. （可选）任务 checkout 在别处时，指定 `TB4_TASKS_ROOT=/path/to/tasks ./run_all.sh --tasks …`。

> 排查提示：跑不动先看 `work/tb4-<stamp>/result/server.log` 是否有 build/agent 报错；`--skip-verify` 可跳过 verifier 只调 agent。

## 构建网络与代理（本机实测要点）

**本机关键事实（aarch64，2026-10-30 实测）**：
- 宿主 shell **直连公网不通**（`curl https://pypi.org` → `Network unreachable`）。
- 但 **`docker pull` 能拉镜像**——因为 docker daemon 配了内网代理
  （`/etc/systemd/system/docker.service.d/proxy.conf`，`10.195.176.39:8081`）。
- 因此直接 `docker build` 会卡两处：①BuildKit 拉基础镜像 metadata 超时
  （`DeadlineExceeded`），②`RUN` 步装依赖（`uv sync` / `pip` 访问 pypi/npm/conda）失败。

**TB4 里已固化**（`lib/workspace.py` + `lib/verify.py`）：
- `_base_images()`：解析 Dockerfile 的 `FROM` / `COPY --from=`，**build 前先用 `docker pull`
  （走 daemon 代理）预拉取**这些基础镜像到本地，绕开 BuildKit 拉 metadata 超时。
- `_build_cmd()`：build 时把代理作为 **`--build-arg HTTP_PROXY/HTTPS_PROXY`** 传入，
  让 `RUN` 步（装依赖）也走代理。

**跑之前 export 代理**（值取自 daemon 代理配置）：
```bash
export TB4_BUILD_PROXY="http://p_atlas:proxy%40123@10.195.176.39:8081"
./run_all.sh --tasks photonic-waveguide-routing
```
优先级 `TB4_BUILD_PROXY` > `HTTPS_PROXY` > `HTTP_PROXY`。不 export 也能跑——只是含联网装依赖的
任务 build 会失败；若依赖无需联网/镜像已缓存则无影响。

### 怎么验证一个任务能否在本机构建+跑

1. **看 arm-support**：`docs/arch/bench/tb4/arm-support.md`——GPU/playwright 硬限制任务本机跑不了
   （`jax-speedrun-gpu`、`vllm-deepseek-streaming`、`fp8-rmsnorm-gemm`、`math-eval-grader`、
   `html-js-filter`、`layout-config-recreation`、`nextjs-performance`）；作者显式写 aarch64 分支的
   （`formal-crypto` / `coq-block-bound` / `freecad-*` / `wdm-design` / `rs-archive-clone`）最稳。
2. **预 build 镜像确认能否构建**（env + tests 都成功才算能构建）：
   ```bash
   cd bench/tb4
   export TB4_BUILD_PROXY="http://p_atlas:proxy%40123@10.195.176.39:8081"
   python3 - <<'PY'
   import sys, os; sys.path.insert(0, 'lib')
   from loader import load_tasks
   from workspace import build_env_image
   from verify import build_tests_image
   for n in ['photonic-waveguide-routing', 'music-harmony']:
       t = load_tasks([n])[0]
       try:
           build_env_image(t, 'tb4-env-' + n);  print('OK env  ', n, flush=True)
           build_tests_image(t, 'tb4-test-' + n); print('OK tests', n, flush=True)
       except Exception as e:
           print('FAIL', n, ':', str(e)[-300:])
   PY
   ```
3. **小跑一次确认能跑**：`./run_single.sh --tasks <n>`（只跑 single，快）确认 agent 出结果 +
   verifier 判分正常。
