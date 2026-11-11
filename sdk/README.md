# myco SDK — 单agent / run-n2 统一接口

把 myco 的两套引擎(**单agent** 与 **run-n2** 双agent)封装成一个小而稳的接口层,对外提供
一个 HTTP 服务和一个 Node 库。**不重写引擎——底层直接复用 `bench/hle/` 已经封装好的
myco 引擎**(进而进程内调用 `server/src/local-claude.js` 的 `callLocalClaude` 与
`server/src/team-session.js` 的 `TeamSession`,和 `/run-n2` 是同一套机制)。

> 定位:sdk 是这些评测接口的统一落脚处。后续 bench 所用的接口都可以收敛到这里,
> 这里新增的只有"接口封装逻辑",引擎逻辑全部复用。

## 目录

```
sdk/
  index.js     # 库接口:answer / runSingle / runN2 / judge / init / info …(复用 bench/hle 引擎)
  server.js    # HTTP 服务:GET /、/health;POST /answer、/judge(原生 bench 风格)
  start.sh     # 一键拉起脚本
  README.md
```

## 拉起(HTTP 接口)

```bash
cd /data/s00791175/myco-test/myco-1014/sdk
./start.sh --port 8787
```

- 模型/代理配置默认读 `MYCO_ENV` 指定的 myco 状态 `.env`
  (默认 `/data/s00791175/Delm/mycoFile/state/.env`),即走和线上 myco 同一个模型网关。
- 启动参数与 `bench/hle/server.js` 完全一致,可作 bench/run.py 的 drop-in:
  `--port <n>`(默认 8787)、`--concurrency <n>`(默认 4)、`--timeout <ms>`(默认 600000)、
  `--env <state/.env>`、`--stamp <YYYYMMDDHHMMSS>`、`--mock 1`(离线冒烟,不调模型)。

离线冒烟(校验 HTTP 契约,不碰模型):
```bash
./start.sh --mock --port 8788
curl -s http://127.0.0.1:8788/
```

## HTTP 接口

| 方法/路径 | 请求体 | 返回 |
|---|---|---|
| `GET /` 、`/health` | — | `{ok, service, mode, model, baseUrl, mock, workRoot}` |
| `POST /answer` | `{mode:'single'\|'n2', question, system?, timeoutMs?, id?, seq?}` | `{ok, mode, answer, ms, error?}` |
| `POST /judge` | `{engine:'single'\|'n2', question, answer, truth, timeoutMs?}` | `{ok, engine, correct, extracted, answer, ms, error?}` |
| `GET /v1/models` | — | OpenAI 兼容的模型列表(`myco-single` / `myco-n2`) |
| `POST /v1/chat/completions` | OpenAI Chat Completions 请求(`stream` 支持) | OpenAI 格式 `{choices:[{message:{content}}],…}` 或 SSE 流 |

**OpenAI 兼容桥**:把本 SDK 当作一个 OpenAI "Chat Completions 模型端点"来用(evalscope Web 的
Model Connection 只认 OpenAI 兼容或 Local Transformers,这个桥正是为此而加)。`base_url`
填 `http://127.0.0.1:<port>/v1`,`api_key` 任意非空;按请求里的 `model` 字段路由——名字含
`n2` 走 run-n2,否则走单agent:
```bash
curl -s -X POST http://127.0.0.1:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"myco-single","messages":[{"role":"user","content":"What is 2+2?"}]}'
# 流式(evalscope openai SDK 原生支持):
curl -sN -X POST http://127.0.0.1:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"myco-n2","stream":true,"messages":[{"role":"user","content":"What is 2+2?"}]}'
```
说明:它不是真正的 LLM 服务——它在内部把 `messages` 里的问题抽出来喂给 myco 引擎,
再把答案作为 assistant 消息返回。answer式评测(HLE/MMLU/GPQA 等发 prompt→判答案)适用;
evalscope 原生 agentic 评测(SWE-bench/BFCL 这类工具调用)不适用。

示例:
```bash
# 单agent 答题
curl -s -X POST http://127.0.0.1:8787/answer \
  -H 'Content-Type: application/json' \
  -d '{"mode":"single","question":"What is 2+2?"}'

# run-n2 双agent 答题
curl -s -X POST http://127.0.0.1:8787/answer \
  -H 'Content-Type: application/json' \
  -d '{"mode":"n2","question":"What is 2+2?"}'

# 用单agent 引擎判 "4" 相对标准答案 "4" 的对错
curl -s -X POST http://127.0.0.1:8787/judge \
  -H 'Content-Type: application/json' \
  -d '{"engine":"single","question":"What is 2+2?","answer":"4","truth":"4"}'
```

单agent 与 n2 走**各自独立的并发池**,长耗时的 n2 题不会饿死单agent 请求。
`/answer` 会持久化工作目录(`bench/hle/work/<stamp>/<mode>/<seq>/`,含
`final_answer.txt` 与 `transcript.txt`);`/judge` 不持久化。

**失败重试**:模型网关经 Claude Agent SDK 调用,本机在该 SDK 偶发无法 spawn 其捆绑
claude 二进制(负载/进程压力)时会瞬时返回 `ok:false`。sdk 的 `answer()` 会对快速失败
自动重试(默认 2 次,可用 `MYCO_SDK_RETRIES` 或调用侧 `retries` 调整)。这也让评测脚本
对偶发抖动更稳。

## 库接口(Node)

```js
const sdk = require('/data/s00791175/myco-test/myco-1014/sdk');

sdk.init();                       // 载入模型+代理配置(info 返回非敏感配置摘要)
await sdk.answer('single', { question: 'Q?', timeoutMs: 120000 });
await sdk.runN2({ question: 'Q?' });
await sdk.runSingle({ question: 'Q?' });
await sdk.judge('single', { question, answer, truth });
```

返回值皆为 `{ ok, mode, answer, ms, durationMs, error? }`(judge 另含
`correct` / `extracted` / `engine`)。

## 用 evalscope 拉起评测(端到端)

把 sdk 当 OpenAI 兼容模型节点接进 evalscope,用它跑 answer 式评测(HLE/MMLU/ARC 等)。已在本机端到端跑通。

### 先决:安装 evalscope(本机已装好,重装/迁移参考)

评测用的是独立 venv,不污染系统 Python:

```bash
# 1) 建 venv(Python 3.12)
/usr/bin/python3 -m venv /data/s00791175/evalscope/venv

# 2) 装 evalscope(currently 1.14.1),从 PyPI 装入该 venv
/data/s00791175/evalscope/venv/bin/pip install evalscope==1.14.1
```

- 安装位置:`/data/s00791175/evalscope/venv/lib/python3.12/site-packages/evalscope`,标准 PyPI wheel,**不是** editable/源码安装。
- 没有 `requirements.txt` / `install.sh`,上述命令是一次性手跑、未沉淀成脚本。
- ⚠️ 本机出网关闭,重装需走内网 pip 镜像或本地缓存;官方 PyPI 直连会超时。
- 日常一律用 `venv/bin/evalscope` 或 `venv/bin/python -m evalscope`,别用系统 `/usr/bin/python3`(系统里那份不完整,`-m evalscope` 会报 `No module named evalscope.__main__`)。

### 0. 前置:三个服务/环境(都配好代理 + NO_PROXY)

评测要下数据集(走代理),而模型调用要**直连** sdk 的 localhost——所以凡启动 `evalscope` 进程都要
**同时**导出代理与 `NO_PROXY`(`.env` 里已有现成值),否则对 `127.0.0.1:18089` 的请求会被企业代理
转发并返回 **504 Gateway Timeout**。用一个 helper 脚本统一导出。

**先创建该文件**(第 2/3 步的 `source ~/.myco-eval-env.sh` 依赖它,本机 `~/` 下还没有;内容如下,直接 `cat > ~/.myco-eval-env.sh`):

```bash
# ~/.myco-eval-env.sh —— 启动 evalscope 前 source 的 helper(代理 + NO_PROXY 统一导出)
# 用法:source ~/.myco-eval-env.sh
MYCO_ENV=/data/s00791175/Delm/mycoFile/state/.env
LOCAL_NET="127.0.0.1,localhost,7.242.106.252"   # 本机回环 + 内网 IP(防模型请求穿代理)
export HTTPS_PROXY="$(grep '^MYCO_ENTERPRISE_PROXY_URL=' "$MYCO_ENV" | cut -d= -f2-)"
export HTTP_PROXY="$HTTPS_PROXY" ALL_PROXY="$HTTPS_PROXY"
export NO_PROXY="$LOCAL_NET,$(grep '^NO_PROXY=' "$MYCO_ENV" | cut -d= -f2-)"
source <(echo "export no_proxy=$NO_PROXY")
```

> 💡 **本机出网关闭时这一步可跳过**:数据集改走本地离线 HF 缓存(见第 3 步说明),模型调用直连
> localhost,都不需要代理。代理导出只在一开始"让 evalscope 走代理下数据集"的场景才必要。

### 1. 拉起 sdk(OpenAI 兼容桥)

```bash
cd /data/s00791175/myco-test/myco-1014/sdk
./start.sh --port 18089 --timeout 300000
curl -s http://127.0.0.1:18089/v1/models      # 应列出 myco-single / myco-n2
```

> ⚠️ **必须用干净环境启动 sdk。** 若从 Claude Code 会话里拉起 `node server.js`,会继承
> `CLAUDE_CODE_*`、`CLAUDECODE`、`CLAUDE_PID`、`CLAUDE_CODE_MESSAGING_SOCKET` 等残留变量,
> 引擎经 Claude Agent SDK spawn 捆绑 claude 二进制会当场失败(`/v1/…` 返回 `502 engine failed to answer`,
> `/tmp/sdk-prod.log` 里重复 "failed to launch")。`./start.sh` 直接后台跑也可能踩到。最稳的
> 干净环境启动方式:
>
> ```bash
> cd /data/s00791175/myco-test/myco-1014/sdk
> nohup env -i \
>   HOME=/root \
>   PATH=/root/.local/bin:/root/.nvm/versions/node/v24.22.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
>   NODE_PATH=/data/s00791175/myco-test/myco-1014/bench/hle/node_modules \
>   MYCO_SRC=/data/s00791175/myco-test/myco-1014/server/src \
>   MYCO_BENCH_LIB=/data/s00791175/myco-test/myco-1014/bench/hle/lib \
>   node server.js --port 18089 --timeout 300000 > /tmp/sdk-prod.log 2>&1 &
> ```

### 2. 拉起 evalscope web(选 `OpenAI-compatible` + 填桥地址)

```bash
cd /data/s00791175/evalscope
source ~/.myco-eval-env.sh                     # ⚠️ 必须带 NO_PROXY(内含本机 IP)
export HF_DATASETS_OFFLINE=1 HF_HUB_OFFLINE=1  # 数据集走本地 HF 缓存(本机出网关闭)
# 可选:数据集默认源。本机补丁默认已是 huggingface;想改回 modelscope 就:
# export EVALSCOPE_DATASET_HUB=modelscope
nohup venv/bin/evalscope service --host 0.0.0.0 --port 9000 \
      --outputs /data/s00791175/evalscope/outputs > /tmp/evalscope-web.log 2>&1 &
curl -s http://127.0.0.1:9000/health          # {"service":"evalscope","status":"ok"}
```

浏览器打开 `http://7.242.106.252:9000`(service `--host 0.0.0.0` 绑所有网卡),在 Web 里新建 **Model Connection**:
- API 类型:**OpenAI-compatible**
- Base URL:`http://127.0.0.1:18089/v1`
- Model:`myco-single`(要 run-n2 就填 `myco-n2`)
- API Key:任意非空(如 `EMPTY`)

> 🧩 **本地补丁(改了第三方包,升级会覆盖需重打)**:`evalscope/service/blueprints/eval.py`
> 的 `_build_task_config` 在请求体没给 `dataset_hub` 时,按环境变量 `EVALSCOPE_DATASET_HUB`
> 取值,默认 `huggingface`。所以 Web 里新建任务默认就走(HF,读本地缓存),即使 UI 没有
> hub 下拉框;请求体显式给 `dataset_hub` 仍优先。CLI 路径不受影响(仍可用 `--dataset-hub …`)。

### 3. 直接跑 eval(CLI,与 Web 同一套引擎)

```bash
cd /data/s00791175/evalscope
source ~/.myco-eval-env.sh                     # ⚠️ 必须带 NO_PROXY
venv/bin/evalscope eval \
  --model myco-single \
  --api-url http://127.0.0.1:18089/v1 \
  --api-key EMPTY \
  --datasets arc --limit 2 \
  --dataset-hub huggingface \
  --work-dir /data/s00791175/evalscope/outputs/demo
```

说明:
- `--datasets <名字>` 选内置 benchmark;`--limit N` 限量;`--dataset-hub huggingface` 走 HuggingFace。
- ⚠️ **本机出网关闭**:不要用默认 `modelscope` hub(连 modelscope.cn 必然超时,撞 `_DownloadDeadlineError`
  "下载总时限已耗尽")。必须配离线环境变量,从本地 HF 缓存读数据(ARC 等已缓存于
  `/root/.cache/huggingface/hub/`):
  ```bash
  cd /data/s00791175/evalscope
  HF_DATASETS_OFFLINE=1 HF_HUB_OFFLINE=1 venv/bin/evalscope eval \
    --model myco-single --api-url http://127.0.0.1:18089/v1 --api-key EMPTY \
    --datasets arc --limit 5 --dataset-hub huggingface
  ```
- 跑完在 `--work-dir` 的 `reports/` 下看 `report.html` / `<model>/<dataset>.json`。

### 常见坑
- **504 Gateway Timeout**:几乎都是 `NO_PROXY` 没带上,模型请求穿过企业代理打 localhost 了。
  见第 0 步。
- **偶发"failed to launch"**:本机负载高/残留 claude 进程多时,SDK spawn 捆绑 claude 二进制会偶发失败。
  sdk 已自动重试(`MYCO_SDK_RETRIES`,默认 2);评测批量加大时可适当调高重试或降并发。
- **改 sdk 代码后要重启** `start.sh` 才生效(进程内复用引擎,不热加载)。
- **502 engine failed to answer(持续/偶发)**:几乎都是 sdk 进程继承了 Claude Code 会话残留变量,
  spawn 捆绑 claude 二进制失败。用上面第 1 步的"干净环境"方式重启 sdk。
- **下载总时限已耗尽 / `_DownloadDeadlineError`**:别用默认 modelscope hub;用
  `--dataset-hub huggingface` + `HF_DATASETS_OFFLINE=1 HF_HUB_OFFLINE=1` 读本地缓存(见第 3 步)。

## 说明 / 后续

- **引擎复用**:`index.js` 通过 `MYCO_BENCH_LIB`(默认 `../bench/hle/lib`)require
  bench/hle 的 `engine.js` / `judge.js` / `config.js`;**不改 `server/` 任何代码**。
- 依赖(`@anthropic-ai/claude-agent-sdk`、`zod`)通过 `NODE_PATH=bench/hle/node_modules`
  解析(由 `start.sh` 设置),无需单独 `npm install`。
- **evalscope 接入**:OpenAI 兼容桥(`/v1/chat/completions`,`stream` 支持)已实现,上面的
  TABLE 与示例可直接在 evalscope Web 的 Model Connection 里填
  `base_url=http://127.0.0.1:<port>/v1` + `model=myco-single`(或 `myco-n2`)来连接并跑评测。
  限:answer 式评测适用,agentic 工具调用式不适用。
