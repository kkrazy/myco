# myco — 本地多用户开发部署（dev-docker.md）

> 面向「同一台机器多人同时测试」的简化版。完整流程见 `docker.md`。

## 1. 完整流程：打镜像 → 设 hosts → 设 proxy → 设 .env → 启动

> 💡 **单实例一键自动化**：若你只是本机跑一个实例（不涉及同机多用户），
> 直接 `bash scripts/deploy-local.sh`（SWR 拉基镜像 + 宿主预取 `build-assets/` +
> 全量构建 + 起容器 + 自检），它就是本文 1.0–1.5 所有手动步骤的合体，见
> `docker.md` §4.0。**同机多用户**仍需按本文手动各自 `-p/<tag>/state` 区分，
> 不能共用 `deploy-local.sh` 的 `myco:latest`（会互相覆盖镜像/容器）。

### 1.0 打镜像（从**全量** `docker/Dockerfile` 开始）

```bash
# 0) 先保证基镜像 node:26-alpine 在本地。
#    ⚠️ 别退回 node:20-alpine：它漂移到 20.18.1 无法 require() 纯 ESM 的
#    @anthropic-ai/claude-agent-sdk → 每次 attach 建会话失败 → 对话框空白。
#    node:26 默认开启 require(esm)，这是 2026-11-02 空白聊天的根因修复。
#    docker.io 被内网 HIS 代理阻断拉不到 → 用华为云 SWR 源拉（daemon 已把它配为
#    insecure-registry，实测 8s）。arm64 主机用 -linuxarm64；x86 换 -linuxamd64，
#    用 `uname -m` 确认架构。
docker pull swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64
docker tag swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64 node:26-alpine

# 1) 全量构建（唯一一次走代理：npm ci / claude-code / caddy / 字体 / apk python3
#    都要出外网）。产物**天生带 python3 + harness²**，直接可用。
#    PROXY 从 state/.env 的 MYCO_ENTERPRISE_PROXY_URL 取，勿写死/勿进 git。
cd <仓库根目录>
PROXY=$(grep '^MYCO_ENTERPRISE_PROXY_URL=' <state>/.env | cut -d= -f2)
docker build -t myco:<你的标识> -f docker/Dockerfile \
  --build-arg http_proxy="$PROXY" \
  --build-arg https_proxy="$PROXY" \
  --build-arg no_proxy='127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.huawei.com' \
  .
```

> ⚠️ **用你自己的镜像名**——别用 `myco:latest` 之类的通用 tag，否则多人同机会
> 互相覆盖同名镜像。打镜像和下面 `docker run` 里用同一个 `<你的标识>` tag。
>
> 🕳️ **这次的坑（2026-10-31）**：别用 `docker build -f Dockerfile.local`（增量层）
> 代替全量——增量层只是「从现有镜像拷源码」，**不含 `python3` / `vendor/harness2`**，
> 跑 `/harness run` 会报 `python3: not found`。要省时间就在带 harness 的基上做增量
> （见 `docker.md` §4.4 备注），默认请走本节全量。

### 1.1 设置 /etc/hosts(容器内)

容器**不继承**宿主 `/etc/hosts`，必须用 `--add-host` 把华为内网域名映射进容器:

```bash
--add-host=api.code-agent.rnd.huawei.com:7.156.115.217 \
--add-host=codehub-dg-g.huawei.com:7.202.25.45 \
--add-host=models.ascend.huawei.com:7.237.97.68 \
--add-host=proxy.huawei.com:172.19.152.237 \
--add-host=apigw-mq.huawei.com:7.194.47.62 \
--add-host=pb-dgg.sppsws.huawei.com:10.129.3.241 \
--add-host=registry-cbu.huawei.com:100.94.164.16
```

### 1.2 设置 proxy

内网域名/IP 必须**直连不走代理**，外部请求才走企业代理:

```bash
# 企业代理(HTTP/HTTPS,大小写各传一份)——host:port 以 state/.env 的 MYCO_ENTERPRISE_PROXY_URL 为准
-e HTTP_PROXY=http://p_atlas:<密码>@10.195.176.39:8081 \
-e HTTPS_PROXY=http://p_atlas:<密码>@10.195.176.39:8081 \
# no_proxy:内网直连项(小写同值再传一份)
-e NO_PROXY=localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,7.216.246.115
```

> ⚠️ 密码勿进 git;从 `.env` 的 `MYCO_ENTERPRISE_PROXY_URL` 取。新增内网域名/IP 要同步加进 `--add-host` 和 `no_proxy`。

### 1.3 设置 .env

写入宿主 state 目录,容器启动时 entrypoint 自动加载:

```bash
# /data/<你的标识>/state/.env
ANTHROPIC_AUTH_TOKEN=<token>
ANTHROPIC_MODEL=glmmoedsa
ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com
MYCO_ALLOW_ALL=1
# 流空闲看门狗（可选——不写则代码默认 15 分钟即生效，详见 docker.md §2.2）
# CLAUDE_ENABLE_STREAM_WATCHDOG=1
# CLAUDE_STREAM_IDLE_TIMEOUT_MS=900000
```

> 只启动时读一次——改完 `.env` 必须 `docker restart <容器名>` 才生效。

> **流空闲看门狗**（2026-11-09 起默认生效）：`agent-session.js` 每次 SDK 迭代
> 自动注入 `CLAUDE_ENABLE_STREAM_WATCHDOG=1` + 15 分钟窗口——网关挂死的请求
> 约 15 分钟内被 CLI 内部 abort + 重试，turn 不中断，不影响长工具调用，也不会
> 提前结束 /run-n2。要调窗口就在 `.env` 写
> `CLAUDE_STREAM_IDLE_TIMEOUT_MS=<毫秒>`（下限 10 分钟，代码钳制），重启容器生效。

### 1.4 一条 `docker run` 整合启动

hosts + proxy + 挂载一次跑起来。**同机多人要改的只有端口与名字,见下方强调**:

```bash
docker rm -f myco-local && \
docker run -d --name myco-local --restart unless-stopped \
  --add-host=api.code-agent.rnd.huawei.com:7.156.115.217 \
  --add-host=codehub-dg-g.huawei.com:7.202.25.45 \
  --add-host=models.ascend.huawei.com:7.237.97.68 \
  --add-host=proxy.huawei.com:172.19.152.237 \
  --add-host=apigw-mq.huawei.com:7.194.47.62 \
  --add-host=pb-dgg.sppsws.huawei.com:10.129.3.241 \
  --add-host=registry-cbu.huawei.com:100.94.164.16 \
  -p 443:443 -p 80:80 \
  -v /data/<你的标识>/state/home:/root \
  -v /data/<你的标识>/state/wks:/wks \
  -v /data/<你的标识>/state/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /data/<你的标识>/state:/data \
  -e NO_PROXY=localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,7.216.246.115 \
  -e HTTP_PROXY=http://p_atlas:<密码>@10.195.176.39:8081 \
  -e HTTPS_PROXY=http://p_atlas:<密码>@10.195.176.39:8081 \
  -e MYCO_DATA=/data -e HOST=127.0.0.1 -e PORT=3000 -e SHELL=/bin/bash \
  -e MYCO_ALLOW_ALL=1 \
  myco:<你的标识>
```

> 🔧 **同机多人怎么改端口**:容器内端口固定(Caddy 80/443、node :3000),
> 多人同机**只改 `-p` 冒号左边的宿主端口**,容器侧(80/443/3000)不动:
> - 用户 A:`-p 18080:80 -p 18443:443 -p 13000:3000 -v /data/A/state:/data --name myco-A`
> - 用户 B:`-p 28080:80 -p 28443:443 -p 23000:3000 -v /data/B/state:/data --name myco-B`
>
> 每个人都访问 `http://<host>:<自己那个宿主端口>`。**镜像 tag、端口、`--name`、
> state 路径都要各自唯一**,否则同机端口冲突(`bind: address already in use`)或
> 共享同一份 `sessions.json`/`.env` 会话打架。

### 1.5 启动自检

```bash
docker ps --filter name=myco-local                            # 容器 running
docker exec myco-local grep code-agent /etc/hosts             # hosts 生效 → 7.156.115.217 ...
docker exec myco-local sh -c 'tr "\0" "\n"</proc/1/environ|grep ANTHROPIC'  # .env 已加载
docker exec myco-local sh -c 'command -v python3 && python3 --version'     # harness² 的 python3 可用
docker logs myco-local 2>&1 | grep -m1 'mycod running'        # 服务监听 :3000
```

## 2. .env 如何在容器生效

容器入口 `docker/docker-entrypoint.sh` 在启动时执行 `. /data/.env`(即宿主
state 目录里的 `.env`)并 `export` 给 node 主进程,再透传进每个 agent 会话。
**只在启动时读取一次**——改了 `.env` 必须 `docker restart <容器名>` 才生效。

## 3. 新主机五步 runbook(以 kai 实例为例)

在一台**全新主机**上从零拉起一个实例(示例:`/data/kc` state 目录、镜像
`myco:kai`、宿主端口 1880/18443):

### Step 1 — 建 state 目录

```bash
mkdir -p /data/kc/state/home /data/kc/state/wks
```

### Step 2 — 写 Caddyfile(`/data/kc/state/Caddyfile`)

```bash
cat > /data/kc/state/Caddyfile <<'EOF'
{
    servers {
        protocols h1 h2
    }
}

:80 {
    encode gzip
    reverse_proxy localhost:3000
}
EOF
```

说明:
- 全局块 `{ ... }` **必须**写在任何 site 块之前;
- `protocols h1 h2` 关闭 HTTP/3,保证 WebSocket(聊天连接)稳定;
- Caddy 监听 `:80`,反代到容器内 `127.0.0.1:3000` 的 myco 应用。

### Step 3 — 写 .env(`/data/kc/state/.env`)

```bash
cat > /data/kc/state/.env <<'EOF'
ANTHROPIC_AUTH_TOKEN=<你的 token>
ANTHROPIC_MODEL=glmmoedsa
ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com
MYCO_ALLOW_ALL=1
MYCO_DISABLE_ALLOWLIST=1
EOF
```

说明:
- `MYCO_ALLOW_ALL=1` + `MYCO_DISABLE_ALLOWLIST=1` 绕过 GitHub 邀请白名单,
  任何持有效 token 的用户都能登录——**只能在可信内网使用**。

### Step 4 — 打镜像(全量,带代理)

```bash
# 0) 准备基镜像 node:26-alpine(arm64 用 SWR 源;x86 换 -linuxamd64)
docker pull swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64
docker tag swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64 node:26-alpine

# 1) 全量构建(唯一一次走代理;产物带 python3+harness²)
cd /data/kc/myco-1014
PROXY=$(grep '^MYCO_ENTERPRISE_PROXY_URL=' /data/kc/state/.env | cut -d= -f2)
docker build -t myco:kai -f docker/Dockerfile \
  --build-arg http_proxy="$PROXY" \
  --build-arg https_proxy="$PROXY" \
  --build-arg no_proxy='127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.huawei.com' \
  .
```

> ⚠️ **`docker build` 时不要带宿主 shell 的代理变量之外的东西**——proxy 以
> `--build-arg` 传入给容器内 RUN 步(http_proxy/https_proxy),宿主 shell 本身建议
> `env -u HTTP_PROXY ... docker build`。带代理构建是**必须**的(不是可选):
> 全量层的 `apk add`、`npm ci`、`npm i -g claude-code`、caddy/字体/lean-ctx 下载
> 都要出外网。
>
> - `<密码>` 从 state `.env` 的 `MYCO_ENTERPRISE_PROXY_URL` 取,`@` 编码为 `%40`;勿写进 git。
> - 全量构建较慢(npm ci + 全局装 claude-code + `apk add python3` + 下载 caddy/字体,
>   十几分钟,取决于代理速度)。产出的镜像**天生带 python3 + harness²**。
> - 之后小改代码想快速叠层,可在带 harness 的基上用增量(见 `docker.md` §4.4),
>   增量镜像同样带 harness。

### Step 5 — 启动容器

```bash
docker rm -f myco-kai && \
docker run -d --name myco-kai --restart unless-stopped \
    --add-host=api.code-agent.rnd.huawei.com:7.156.115.217 \
    --add-host=codehub-dg-g.huawei.com:7.202.25.45 \
    --add-host=models.ascend.huawei.com:7.237.97.68 \
    --add-host=proxy.huawei.com:172.19.152.237 \
    --add-host=apigw-mq.huawei.com:7.194.47.62 \
    --add-host=pb-dgg.sppsws.huawei.com:10.129.3.241 \
    --add-host=registry-cbu.huawei.com:100.94.164.16 \
    -p 18443:443 \
    -p 1880:80 \
    -v /data/kc/state/home:/root \
    -v /data/kc/state/wks:/wks \
    -v /data/kc/state/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v /data/kc/state:/data \
    -e NO_PROXY=localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,7.216.246.115 \
    -e HTTP_PROXY=http://p_atlas:<密码>@10.195.176.39:8081 \
    -e HTTPS_PROXY=http://p_atlas:<密码>@10.195.176.39:8081 \
    -e MYCO_DATA=/data \
    -e HOST=127.0.0.1 \
    -e PORT=3000 \
    -e SHELL=/bin/bash \
    -e MYCO_ALLOW_ALL=1 \
    myco:kai
```

启动后访问 `http://<主机>:1880`,自检命令见 §1.5(把容器名换成 `myco-kai`)。
