# myco — Docker 部署指南（华为 Anthropic 网关）

> 目标：让本机 Docker 部署的 myco 能访问给定的 Anthropic 兼容网关
> （`http://api.code-agent.rnd.huawei.com`，模型 `glmmoedsa`）。
>
> 部署**从全量 `docker/Dockerfile` 构建开始**（产物自带 `python3` + `harness²`），
> 关键三件套：①用华为云 SWR 拉 `node:26-alpine` 基镜像解决 docker.io 被阻断、
> ②构建/运行带正确 proxy+no_proxy、③`--add-host` 补内网 /etc/hosts 映射。
> 脚本 `scripts/deploy-local.sh` 一次做完全部（见 §4.0）。

---

## 0. 架构速览

```
                         ┌────────────────────────────────────────────┐
  Browser ──HTTP/WS──▶ Caddy (80/443) ──▶ node server (mycod, :3000)
                         │                 │   └─ spawns claude agent (Agent SDK)
                         │                 └─ reads /data/.env (state dir .env)
                         │                 └─ requests ──▶ api.code-agent.rnd.huawei.com
                         │                                      (7.156.115.217)
                         └────────────────────────────────────────────┘
        Docker 状态目录（bind mount，宿主可见）:
          /data/s00791175/Delm/mycoFile/state        → /data      (sessions.json, .env, git-tokens.json, …)
          /data/s00791175/Delm/mycoFile/state/home   → /root
          /data/s00791175/Delm/mycoFile/state/wks    → /wks
          /data/s00791175/Delm/mycoFile/state/Caddyfile → /etc/caddy/Caddyfile (ro)
```

- 镜像：**`myco:latest`（从 `docker/Dockerfile` 全量构建，本地打，不是远端拉）**。
- 容器入口 `docker/docker-entrypoint.sh` 启动时加载 `$MYCO_DATA/.env`（即宿主
  `state/.env`）并 `export` 到 `node` 主进程；`node` 主进程 `env: { ...process.env }`
  把环境变量透传给每个 claude agent 会话。

---

## 1. 前置条件

| 项 | 版本 / 说明 |
|---|---|
| Docker | 可运行容器，端口 80/443 空闲 |
| 镜像 | `myco:latest`（本地全量构建，见 §4.0） |
| 状态目录 | 默认 `/data/s00791175/Delm/mycoFile/state`（`MYCO_STATE_DIR`） |
| 网关 | `http://api.code-agent.rnd.huawei.com`（DNS/IP 见 §3） |
| 认证 | `ANTHROPIC_AUTH_TOKEN`（华为网关的 bearer token）+ 模型名 `glmmoedsa` |
| 企业代理 | `http://p_atlas:<密码>@10.195.176.39:8081`（见 state `.env` 的 `MYCO_ENTERPRISE_PROXY_URL`） |

---

## 2. 配置 API（写入 state `.env`）

在宿主状态目录的 `.env` 中加入以下项，容器启动时自动加载：

```bash
# /data/s00791175/Delm/mycoFile/state/.env
ANTHROPIC_AUTH_TOKEN=<你的 token>                       # 华为网关 bearer token
ANTHROPIC_MODEL=glmmoedsa
ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com
MYCO_ALLOW_ALL=1                                        # 跳过所有权限确认（见下方说明）
# 企业代理（容器内 apk/npm/git/agent 出外网用；host:port 以此为准）
MYCO_ENTERPRISE_PROXY=1
MYCO_ENTERPRISE_PROXY_URL=http://p_atlas:<密码>@10.195.176.39:8081
MYCO_ENTERPRISE_NO_PROXY=127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,7.216.246.115,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com
# 流空闲看门狗（可选——不写则代码默认即生效，见 §2.2）
# CLAUDE_ENABLE_STREAM_WATCHDOG=1
# CLAUDE_STREAM_IDLE_TIMEOUT_MS=900000
```

> **MYCO_ALLOW_ALL=1**：`server/src/permissions.js decide()` 读取该变量，命中后跳过
> 整个 allow/deny 评估直接返回 `allow`——容器化部署下 agent 不再弹出任何 `/decide`
> 权限确认。**显式 `/deny` 规则仍然优先生效**，所以 deny 列表在开放模式下依旧是可用
> 的 kill-switch。写入 state `.env` 后需重建/重启容器才生效（entrypoint 启动时加载）。

> ⚠️ **安全**：token / 代理密码是 live 凭证，勿提交到 git、勿打印进日志/终端回放。

### 2.2 流空闲看门狗（CLAUDE_ENABLE_STREAM_WATCHDOG / CLAUDE_STREAM_IDLE_TIMEOUT_MS）

> 2026-11-09 fec-n2-37 复盘引入。Claude Code CLI 自带「每请求流空闲看门狗」：
> 一个流式响应超过阈值没有交付任何 SSE chunk，就 abort **该次 fetch** 并在 CLI
> 内部重试（默认最多 10 次）——turn 不中断、不产生 turn_result/iteration_aborted，
> 对 run-n2 等团队会话完全透明（不会提前结束）。它只检测「请求在飞却无数据」，
> 长工具调用（yosys 综合、远端 ssh）期间没有在飞请求，不受影响。修复前一个
> 挂死的网关请求可以让 run-n2 静默 66 分钟（0b1beffc 实测），直到网关 socket
> 偶然断线才解锁。

- **默认即生效**：`server/src/agent-session.js streamIdleWatchdogEnv()` 在每次
  SDK 迭代把 `CLAUDE_ENABLE_STREAM_WATCHDOG=1` + 15 分钟窗口 overlay 进子进程
  env，**无需在 .env 里写任何东西**。
- **可调**：在 state `.env` 写 `CLAUDE_STREAM_IDLE_TIMEOUT_MS=<毫秒>` 覆盖窗口；
  代码层钳制 **10 分钟下限**（CLI 内部只钳 5 分钟）。写完 `docker restart` 生效。
- 远端生产（deploy.sh 管理的 .env）：`./scripts/deploy.sh --set-stream-idle-timeout <分钟>`
  一条命令写入 + 重启；全量部署会幂等播种 15 分钟默认（已配置则保留操作员值）。
- **观测**：网关若是缓冲型（整响应算完才吐 chunk），日志会反复出现
  `Streaming idle warning` / `Streaming idle timeout`——调大窗口缓解
  （误触发代价只是多一次内部重试）。**`.env` 写
  `CLAUDE_ENABLE_STREAM_WATCHDOG=0` 关不掉**——helper 每次 overlay 强制为 1；
  真要禁用只能调大窗口到事实不触发，或删掉 `streamIdleWatchdogEnv()` 的 overlay。
- ⚠️ 该 env 是 CLI 内部未公开文档变量（逆向自 vendored 2.1.142 二进制）。SDK
  升级若改名/删除，变量被忽略、行为退回现状，不会更糟。

### 2.3 邀请白名单开关（MYCO_DISABLE_ALLOWLIST）

登录门禁有两层：**要不要登录**（`MYCO_AUTH_REQUIRED=1`）和**谁能登录**（邀请白名单）。
`MYCO_DISABLE_ALLOWLIST=1` 临时关闭第二层——文件保留不动，但任何持有效
GitHub/Gitee/CodeHub token 的用户都可登录（"开放模式"）。清掉或设为 `0`/`false`
即恢复邀请模式。当前本地部署默认开放。

---

## 3. 容器 DNS 与 docker.io 被阻断（根因）

### 症状
- agent 会话报 `Not logged in · Please run /login` 或 `fetch failed` / Configuration
  `Could not resolve host`。
- `docker build -f docker/Dockerfile` 卡在 `FROM node:26-alpine`：
  `failed to fetch anonymous token ... dial tcp ... i/o timeout`。

### 根因
1. 容器 DNS（`100.125.1.250` / `100.125.129.250`）解析不到华为内网域名。
2. 走 HIS 企业代理访问内网端点会被拦截（HTTP 504）。
3. 环境一直靠**宿主 `/etc/hosts`** 里的硬编码映射访问内网域名，容器**不继承**宿主
   hosts，必须用 `--add-host` 补。宿主完整内网映射：
   ```
   7.194.47.62    apigw-mq.huawei.com
   10.129.3.241   pb-dgg.sppsws.huawei.com
   7.202.25.45    codehub-dg-g.huawei.com
   172.19.152.237 proxy.huawei.com
   7.156.115.217  api.code-agent.rnd.huawei.com
   7.237.97.68    models.ascend.huawei.com
   100.94.164.16  registry-cbu.huawei.com
   7.221.105.132  kwe-g.codehub.huawei.com
   ```
4. `docker.io` 被 HIS 代理阻断 → **base 镜像 `node:26-alpine` 拉不到**，buildkit
   解 `FROM node:26-alpine` 时代 `i/o timeout`。用华为云 SWR 镜像源拉（§4.0 脚本 / §4.0b step 0）。

**结论**：容器里用 `--add-host` 补 hosts 映射（直连 IP、不走代理），内网域名/IP 加进
`NO_PROXY` / `no_proxy`；base 镜像用 SWR 源拉。

> 💡 **诊断技巧**：`docker exec myco-local echo $HTTP_PROXY` 往往打印空 —— 是因
> `$HTTP_PROXY` 在**宿主 shell** 里先被展开了，不是容器里没设。看容器真实 env 用：
> `docker inspect myco-local --format '{{json .Config.Env}}'`。

---

## 4. 构建与重建（从全量开始）

### 4.0 一键自动化部署（推荐首选路径）

**`scripts/deploy-local.sh` 把 §4 里每一步手动的活（以及内网代理下最容易翻车的那些
下载）全部自动化成一个命令：**

```bash
bash scripts/deploy-local.sh                      # 全流程：base + assets + 构建 + 起容器 + 自检
bash scripts/deploy-local.sh --skip-build         # 只重建容器 + 自检（改 .env / 换参数后的日常）
bash scripts/deploy-local.sh --skip-run           # 只构建镜像，不碰容器
bash scripts/deploy-local.sh --fresh              # 强制重新下载外部二进制 + 全量重构建
```

**它替你做了**（与下方手动的 4.0–4.3 等价）：

1. **prep_base_image** — 检测本机架构（aarch64/x86_64），从华为云 SWR 拉对应
   `node:26-alpine` 并 `docker tag` 成本地 `node:26-alpine`（docker.io 被代理阻断，不能直接拉）。
2. **prefetch_assets** — 在**宿主**上用代理 curl 下载镜像需要的三个外部二进制（caddy、
   lean-ctx、JetBrainsMono 字体）到 **gitignored `build-assets/`**。
   > 这一点最关键：构建沙箱内的代理会**掉落大文件下载**（caddy 47MB → curl exit 56，
   > lean-ctx 会挂起），而同一条 curl 在宿主上能成功。所以改为宿主预取 + `COPY`
   > 进镜像，构建时这几步不再出外网。已有文件会跳过（`--fresh` 才重新下）。
3. **build_image** — 带 `--build-arg http_proxy/https_proxy` 全量构建 `docker/Dockerfile`
   （npm/apk 走代理，产物带 `python3` + harness²）。
4. **recreate_container** — 用 §4.2 完全一致的 `--add-host` + proxy/no_proxy + 单状态目录
   布局重建容器（session 数据全在 bind mount，重建不丢）。
5. **self_check** — 自检 hosts 映射 / API env / 容器 DNS / harness python3 / `GET /` HTTP 200。

**`node:` 版本红线的由来（2026-11-02 实测）：** 别再退到 `node:20-alpine` —— 它漂移成了
`20.18.1`，**无法 `require()` 纯 ESM 的 `@anthropic-ai/claude-agent-sdk`**，导致每次 WS attach
建会话都失败 → **对话框空白**。`node:26` 默认开启 `require(esm)`，脚本固定用它。降级会复现空白聊天。

前置条件：`$STATE_DIR/.env` 至少含 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、
`ANTHROPIC_BASE_URL`、`MYCO_ALLOW_ALL=1`、`MYCO_ENTERPRISE_PROXY_URL`、
`MYCO_ENTERPRISE_NO_PROXY`（脚本找不到会给出模板并退出）。可覆盖的环境变量：
`MYCO_STATE_DIR` / `MYCO_CONTAINER` / `MYCO_IMAGE` / `MYCO_BASE_TAG`。

#### 需要手动下载的东西（全清单，`deploy-local.sh` 已自动做）

在一个内网 + 企业代理环境里，"下载"从来不是单纯一条 curl —— 下面每一项要么 docker.io 拉不到、
要么构建沙箱代理会掉落，**全部都必须先落到本地再进镜像**。它们都进 **gitignored `build-assets/`**，
由脚本自动预取（§4.0 第 2 步）；这里列出来是为了让你知道到底下什么、从哪下：

| # | 物 | 下载来源（默认） | 架构 | 落点 | 为什么手动 |
|---|---|---|---|---|---|
| 1 | base 镜像 `node:26-alpine` | `swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64`（arm64）/ `-linuxamd64`（x86） | 按主机 | 本地镜像，tag 成 `node:26-alpine` | docker.io 被 HIS 代理阻断 |
| 2 | **caddy** 二进制 | `https://caddyserver.com/api/download?os=linux&arch=<amd64\|arm64>` | 按主机 | `build-assets/caddy` | 构建沙箱代理掉 47MB 下载（curl exit 56） |
| 3 | **lean-ctx** (MCP 压缩器) v3.6.14 | `https://github.com/yvgude/lean-ctx/releases/download/v3.6.14/lean-ctx-<x86_64\|aarch64>-unknown-linux-musl.tar.gz` | 按主机 | `build-assets/lean-ctx.tar.gz` | 同上（沙箱代理挂起） |
| 4 | **JetBrainsMono Nerd Font** | `https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.1/JetBrainsMono.tar.xz` | 无关 | `build-assets/JetBrainsMono.tar.xz` | 同上；终端/编辑器等宽字体 |
| 5 | `vendor/harness2` | 仓库内 `vendor/harness2` + `bench/harness2`（已 vendored，**无需下载**） | 无关 | 镜像内 `/app/vendor/harness2` | —（无网依赖） |

> 🔑 第 2–4 项的要点：**在宿主上用代理 curl**（宿主代理能拉通），脚本写入 `build-assets/`；
> `docker/Dockerfile` 用 `COPY build-assets/...` 把它们拷进镜像 → 构建时这几步**不再出外网**。
> `--fresh` 强制全部重下；已有文件自动跳过（幂等）。
> 若目标主机是 x86_64（如生产 `myco.labxnow.ai`），脚本会自动抓 x86 版 caddy/lean-ctx，无需改 Dockerfile。

> 若你想手动一步步来（或脚本不适用），用下面的 4.0b/4.1/4.2/4.3 分步命令，二者等价。

### 4.0a 部署脚本一览（本地 / 远端，与三者关系）

仓库 `scripts/` 下三支部署脚本分工不同，本质是**同一条流水线拆出的三段**：

| 脚本 | 作用域 | 干什么 | 与其它脚本的关系 |
|---|---|---|---|
| `deploy-local.sh` | **本机 · 全流程** | SWR 拉基镜像 → 宿主预取外部二进制（caddy/lean-ctx/字体）进 `build-assets/` → 全量构建 `myco:latest` → 重建 `myco-local` → 自检 | **一切的基础**：先在本机把带 harness 的镜像打出来并跑起来 |
| `redeploy-local-docker.sh` | **本机 · 只重建容器** | 假定 `myco:latest` 已就绪，只 `docker rm -f` 并按 §4.2 重建容器（hosts/proxy/no_proxy 从 state `.env` 取，**不写死**） | ≈ `deploy-local.sh --skip-build` 的独立版；改动 `.env` / 换了镜像 tag 后的日常快速重启 |
| `redeploy-1014-remote.sh` | **远端 · 推送部署** | 把本机刚打的镜像 `docker save \| gzip \| ssh docker load` 流到远端主机（不推源码、远端不重编译），建新 state 目录 + 复用远端凭据，重建远端容器 | **复用 `deploy-local.sh` 的构建产物**，是它的"远端出口" |

一层层的关系一句话：**`deploy-local.sh` 是本机"从零到跑"的那一步；`redeploy-local-docker.sh` 是它的"只换容器"快捷件；`redeploy-1014-remote.sh` 是把 `deploy-local.sh` 打出来的镜像搬去远端再部署。** 三者都幂等可重跑，state 都是 bind mount，重建不丢会话数据。

### 4.0b 手动 · 本地镜像全量构建（`docker/Dockerfile`，产物带 harness²）

> **首选路径**：直接全量构建 `docker/Dockerfile`。它自带 `apk add python3` +
> `COPY vendor/harness2` + `bench/harness2` + `ENV PYTHONPATH` + `import` 自检——
> **产出的镜像天生带 `python3` + `harness²`**，不需要任何"补层"。

```bash
# 0) 准备好 base 镜像 node:26-alpine（⚠️ 红线上节已述：用 node:26，不要退回 node:20！
#    docker.io 被阻断，用华为云 SWR 源拉，架构要与 uname -m 一致：arm64→-linuxarm64，x86→-linuxamd64）
docker pull swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64
docker tag  swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64 node:26-alpine

# 0.5) 预取三个外部二进制到 build-assets/（✅ 关键：构建沙箱代理会掉落大文件，这里在宿主预取）
#     架构 arch：arm64 / amd64；RUST：aarch64 / x86_64 —— 按 uname -m 选。
#     PROXY 用上方 .env 的 MYCO_ENTERPRISE_PROXY_URL。等价于 scripts/deploy-local.sh 第 2 步。
mkdir -p build-assets
curl -fsSLk --proxy "$PROXY" \
  -o build-assets/caddy \
  "https://caddyserver.com/api/download?os=linux&arch=$arch"
curl -fsSLk --proxy "$PROXY" \
  -o build-assets/lean-ctx.tar.gz \
  "https://github.com/yvgude/lean-ctx/releases/download/v3.6.14/lean-ctx-${RUST}-unknown-linux-musl.tar.gz"
curl -fsSLk --proxy "$PROXY" \
  -o build-assets/JetBrainsMono.tar.xz \
  "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.1/JetBrainsMono.tar.xz"
# 验证：ls -l build-assets/ 三个文件都在（caddy 47MB / lean-ctx 15MB / 字体 6MB）。

# 1) 从仓库根目录全量构建（唯一一次走代理：npm ci / claude-code / apk 出外网；caddy/字体/lean-ctx 已从 build-assets COPY）
cd <仓库根目录>
PROXY=$(grep '^MYCO_ENTERPRISE_PROXY_URL=' <state>/.env | cut -d= -f2)   # 勿写死密码
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u NO_PROXY -u no_proxy \
  docker build -t myco:latest -f docker/Dockerfile \
    --build-arg http_proxy="$PROXY" \
    --build-arg https_proxy="$PROXY" \
    --build-arg no_proxy='127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.huawei.com' \
    .
```

- 全量构建较慢（npm ci + 全局 claude-code + `apk add` + 下载 caddy/字体/lean-ctx，
  十几分钟，取决于代理速度）。
- 构建成功再看：`docker run --rm myco:latest python3 --version` 应有输出，
  `docker run --rm myco:latest sh -c 'PYTHONPATH=/app/vendor/harness2 python3 -c "import harness2; print(harness2.__file__)"'` 能 import。

> 🕳️ **这次的坑（2026-10-31）**：别用增量 `docker build -f Dockerfile.local` 代替
> 全量当初始镜像——增量层只是「从现有镜像 COPY 源码」，**不含 `python3` /
> `vendor/harness2`**，跑 `/harness run` 会报 `python3: not found`。代码小改动想在带
> harness 的基上加速时，见 §4.4 备注。

### 4.1 快速重启（仅重读 `.env`，不动 hosts/镜像）

```bash
docker restart myco-local
```

### 4.2 重建容器（带 hosts 映射 + no_proxy，持久）

> 镜像：`myco:latest`（§4.0 全量，带 harness）或带 harness 的增量标签。

```bash
docker rm -f myco-local && \
docker run -d --name myco-local --restart unless-stopped \
  --add-host=apigw-mq.huawei.com:7.194.47.62 \
  --add-host=pb-dgg.sppsws.huawei.com:10.129.3.241 \
  --add-host=codehub-dg-g.huawei.com:7.202.25.45 \
  --add-host=proxy.huawei.com:172.19.152.237 \
  --add-host=api.code-agent.rnd.huawei.com:7.156.115.217 \
  --add-host=models.ascend.huawei.com:7.237.97.68 \
  --add-host=registry-cbu.huawei.com:100.94.164.16 \
  --add-host=kwe-g.codehub.huawei.com:7.221.105.132 \
  -p 443:443 -p 80:80 \
  -v /data/s00791175/Delm/mycoFile/state/home:/root \
  -v /data/s00791175/Delm/mycoFile/state/wks:/wks \
  -v /data/s00791175/Delm/mycoFile/state/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /data/s00791175/Delm/mycoFile/state:/data \
  -e NO_PROXY=localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,kwe-g.codehub.huawei.com,7.216.246.115 \
  -e no_proxy=localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,kwe-g.codehub.huawei.com,7.216.246.115 \
  -e HTTP_PROXY=http://p_atlas:<PASSWORD>@10.195.176.39:8081 \
  -e http_proxy=http://p_atlas:<PASSWORD>@10.195.176.39:8081 \
  -e HTTPS_PROXY=http://p_atlas:<PASSWORD>@10.195.176.39:8081 \
  -e https_proxy=http://p_atlas:<PASSWORD>@10.195.176.39:8081 \
  -e MYCO_DATA=/data -e HOST=127.0.0.1 -e PORT=3000 -e SHELL=/bin/bash \
  -e MYCO_ALLOW_ALL=1 \
  myco:latest
```

> ⚠️ 代理 host:port 以 state `.env` 的 `MYCO_ENTERPRISE_PROXY_URL` 为准；`<PASSWORD>`
> 是 live 凭证，勿写进 git，从 state `.env` 取（`@` 编码为 `%40`）。
>
> **no_proxy 必须直连、不走代理的项**：`api.code-agent.rnd.huawei.com`（默认网关）、
> `codehub-dg-g.huawei.com`（CodeHub git）、`kwe-g.codehub.huawei.com`（KWE CodeHub
> git，2026-11-11 实测：不加则 clone 报 `CONNECT tunnel failed, response 504`）、
> `7.216.246.115`（DS-V4 网关 IP——**必须加**，
> 否则该内网 IP 走 HIS 代理→HTTP 504）。任何新增内网网关 IP/域名，都要同步加进
> `--add-host` 和 `no_proxy`。

> ✅ 会话数据全部在 bind mount `/data/s00791175/Delm/mycoFile/state`（宿主目录），重建容器**不会丢数据**。

### 4.3 重建后的自检

```bash
# 1) hosts 映射是否生效
docker exec myco-local grep code-agent /etc/hosts          # → 7.156.115.217 api.code-agent.rnd.huawei.com
# 2) node 主进程是否加载 API 配置
docker exec myco-local sh -c 'tr "\0" "\n" < /proc/1/environ | grep -i ANTHROPIC'
# 3) 容器内 DNS 解析
docker exec myco-local getent hosts api.code-agent.rnd.huawei.com   # → 7.156.115.217
# 4) harness² 运行时（python3）在位
docker exec myco-local sh -c 'command -v python3 && python3 --version'
# 5) 容器状态 / 服务监听
docker ps --filter name=myco-local
docker logs myco-local 2>&1 | grep -m1 'mycod running'     # → mycod running at http://127.0.0.1:3000
```

### 4.4 harness² 调优安装（全量产物自带，此处仅说明）

> ✅ **全量 `docker/Dockerfile` 构建的镜像天生带 `python3` + `harness²`**，容器起来后
> `/harness run <任务>` 直接可用，无需额外安装。安装/配置/验证详见
> **`docs/deploy/harness2-install.zh.md`**（环境变量、`/harness status`、dry-run 自检等都在那边）。

**代码小改后的快速增量（可选加速）**：在**带 harness 的基**上用 `Dockerfile.local`
叠源码层即可——只要基已含 python3+harness2，增量镜像同样带 harness，秒级完成：

```bash
# 基 = 已经带 harness 的全量 myco:latest（或之前全量产物）；只 COPY 当前源码
docker build -f Dockerfile.local -t myco:<tag> .
```

> 🕳️ **坑（2026-10-31）**：若基是 harness 之前的旧增量层（不含 python3/harness2），
> 增量镜像也不带——不要在这种基上空跑 `/harness`。解决办法：先按 §4.0 全量打一个
> 带 harness 的基，再把增量叠在它上面。

---

## 5. 端到端验证

> 以下脚本**不会打印 token**，仅报告状态码（token 从进程环境读取）。

```bash
docker exec myco-local sh -c '
cat > /tmp/v.js <<'"'"'EOF'"'"'
const base=process.env.ANTHROPIC_BASE_URL||"http://api.code-agent.rnd.huawei.com";
const model=process.env.ANTHROPIC_MODEL||"glmmoedsa";
const tok=(process.env.ANTHROPIC_AUTH_TOKEN||process.env.ANTHROPIC_API_KEY||"");
(async()=>{const c=new AbortController();setTimeout(()=>c.abort(),45000);
try{const r=await fetch(base+"/v1/messages",{method:"POST",
headers:{"content-type":"application/json","anthropic-version":"2023-06-01","authorization":"Bearer "+tok},
body:JSON.stringify({model,max_tokens:8,messages:[{role:"user",content:"hi"}]}),signal:c.signal});
const body=await r.text();console.log("tokLen="+tok.length+" [HTTP "+r.status+"] "+JSON.stringify(body.slice(0,90)));}
catch(e){console.log("ERR:",e.name,e.message);}})();
EOF
tr "\0" "\n" </proc/1/environ > /tmp/env1 && cd /app && set -a && . /tmp/env1 && set +a \
  && NODE_PATH=/app/server/node_modules timeout 50 node /tmp/v.js'
```

**期望输出**：`tokLen=<N> [HTTP 200] "{...assistant...}"`

---

## 6. 验证清单（对照）

| 步骤 | 检查 | 状态 |
|---|---|---|
| SWR 拉 base 镜像 | `docker pull swr...node:26-alpine-linuxarm64` 成功 | ✅（秒级） |
| 全量构建 | `docker build -f docker/Dockerfile`（带代理）成功 | ✅ |
| 镜像带 harness | `docker run --rm myco:latest python3 --version` 有输出 | ✅ |
| 写入 `.env` | `ANTHROPIC_AUTH_TOKEN` / `MODEL=glmmoedsa` / `BASE_URL` / `MYCO_ALLOW_ALL=1` | ✅ |
| 重建容器加 `--add-host` | `docker exec` 查 `/etc/hosts` | ✅ |
| 容器 DNS | `getent hosts api.code-agent... → 7.156.115.217` | ✅ |
| 真实运行时请求 | `[HTTP 200]` | ✅ |
| 服务器正常 | `docker logs myco-local` 无 401 | ✅ |

---

## 7. 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| `FROM node:20-alpine` 报 `i/o timeout` | docker.io 被 HIS 代理阻断、本地无 base 镜像 | 用 §4.0b step 0 的 SWR 源拉并重打 `node:26-alpine` 标签 |
| **对话框空白、agent 不回复** | `node:20-alpine` 漂移到 20.18.1，无法 `require()` 纯 ESM 的 `@anthropic-ai/claude-agent-sdk` → 每次 attach 建会话失败 | 换 `node:26-alpine` 重建（`scripts/deploy-local.sh` 固定用它），不要退回 node:20 |
| `Not logged in · Please run /login` | 进程环境缺 API 配置 | 确认 `.env` + 重启容器（§2/§4.1） |
| `fetch failed` / `Could not resolve host` | 容器 DNS 解析不了域名 | 用 `--add-host` 重建，把内网域名映射进容器（§4.2） |
| `CodeHub: getaddrinfo ENOTFOUND codehub-dg-g.huawei.com` | 容器缺该域名 hosts 映射 | 加 `--add-host=codehub-dg-g.huawei.com:7.202.25.45`（§4.2） |
| `kwe-g.codehub.huawei.com` clone 报 `CONNECT tunnel failed, response 504` | 该域名缺 hosts 映射且走了企业代理 | 加 `--add-host=kwe-g.codehub.huawei.com:7.221.105.132` 并把域名加进 `no_proxy`，重建容器（§4.2） |
| DS 网关（`7.216.246.115:14000`）504 / 连不上 | `7.216.246.115` 不在 no_proxy | 加进 `NO_PROXY`/`no_proxy` 并重建（§4.2） |
| HTTP 504（HIS Proxy 拦截页） | 请求走了企业代理 | 内网域名/IP 加进 `no_proxy` / `MYCO_ENTERPRISE_NO_PROXY` |
| `/harness run` 报 `python3: not found` | 镜像是不含 harness 的增量层 | 改在带 harness 的全量/增量基上跑（§4.0/§4.4） |
| `docker exec myco-local echo $HTTP_PROXY` 打印空 | 宿主 shell 先展开了变量 | 用 `docker inspect --format '{{json .Config.Env}}'` 查真实 env |
| 修改 `.env` 后不生效 | entrypoint 只在启动时读 | `docker restart myco-local` |

---

## 8. 相关文档

- `dev-docker.md` — 本机多用户开发部署（简化版，同样从全量开始）
- `dev-docker.en.md` — 同上英文版
- `harness2-install.zh.md` — harness² 安装/配置/验证
- 项目根 `deploy.md` — 生产主机部署与运维
- 项目根 `CLAUDE.md` — 单状态目录契约、部署策略

相关脚本（`scripts/`）：

- `deploy-local.sh` — 本机一键部署（§4.0，全流程）
- `redeploy-local-docker.sh` — 本机只重建容器（§4.0a，≈ `--skip-build`）
- `redeploy-1014-remote.sh` — 把本机镜像推送到远端部署（§4.0a）
