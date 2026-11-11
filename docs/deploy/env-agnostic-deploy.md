# myco Docker 部署 —— 跨环境 Runbook（适配全部环境）

> 目标：在一**台全新/陌生环境**上，用同一套步骤把 myco 容器跑起来。
> 本文把"**环境相关参数**"和"**固定步骤**"分开：换环境时你只需要改参数，
> 步骤本身一套走到底。同一环境日常就 `bash scripts/deploy-local.sh` 一键即可，
> 本文是"环境切换/新环境首次部署"时用的详细手册。

---

## 0. 先分清：哪些是"环境相关"，哪些是"固定不变"

| 类别 | 项 | 说明 |
|---|---|---|
| **环境相关**（换环境必须重填） | 架构 `arch` | `aarch64` / `x86_64`，`uname -m` 决定 |
| | 内网 hosts IP 映射 | 每台宿主 `/etc/hosts` 里的内网域名→IP 不同 |
| | 代理 `proxy` | 该网络的 HTTP 代理 host:port（含密码） |
| | 网关 token | `ANTHROPIC_AUTH_TOKEN`（华为网关 bearer） |
| | 状态目录 `STATE_DIR` | 用哪个绝对路径放 state |
| | 对外端口 | 80/443 是否空闲（或改用别的 -p） |
| **固定不变**（每环境同一套） | 容器布局 | 单状态目录 bind mount（state/home/wks/Caddyfile→/data） |
| | 构建方式 | 从全量 `docker/Dockerfile` 构建，产物带 python3+harness² |
| | 环境变量骨架 | `MYCO_DATA/HOST/PORT/SHELL/MYCO_ALLOW_ALL` 等 |
| | self-check 清单 | hosts / API env / 容器 DNS / harness / HTTP 200 |

> 一句话：**`deploy-local.sh` 是"一个环境里一次配好做成的"。跨环境时，先按 §1–§3
> 把环境相关的四样（arch / hosts / proxy / STATE_DIR）对好，再进 §4 部署。**

---

## 1. 收集本环境的 6 个参数（每环境仅一次）

```bash
# ① 架构（决定 base 镜像 / caddy / lean-ctx 的版本）
uname -m
#   aarch64 → arm64 / aarch64        x86_64 → amd64 / x86_64

# ② 状态目录（一个绝对路径，宿主可见；default 形如 <repo>/../state）
STATE_DIR=/data/<you>/mycoFile/state      # 用你自己的路径，不要沿用别人的

# ③ 内网 hosts 映射（从宿主 /etc/hosts 直接读，别手抄别人的 IP）
grep -E 'huawei|code-agent|ascend|registry-cbu' /etc/hosts

# ④ 代理（该网络的 HTTP 代理，含用户:密码@host:port）
#    从宿主 shell 或上一个环境的 .env 里取，勿写死进 git

# ⑤ 网关 token（ANTHROPIC_AUTH_TOKEN）
#    该环境的 live 凭证

# ⑥ 端口 80/443 是否空闲
ss -ltnp | grep -E ':80 |:443 ' || echo "80/443 空闲"
```

> ⚠️ 让脚本别看错架构 / 别把**别的机器**的 hosts IP 抄过来——这俩是跨环境翻车第一位的。

---

## 2. 准备状态目录 + `.env` + Caddyfile

```bash
mkdir -p "$STATE_DIR/home" "$STATE_DIR/wks"

# 2.1 .env（每个环境按该环境真实值填，模板如下）
cat > "$STATE_DIR/.env" <<'EOF'
ANTHROPIC_AUTH_TOKEN=<该环境 token>
ANTHROPIC_MODEL=glmmoedsa
ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com
MYCO_ALLOW_ALL=1
MYCO_DISABLE_ALLOWLIST=1
# —— 以下两项是该环境的代理 / 内网 no_proxy ——
MYCO_ENTERPRISE_PROXY_URL=http://<user>:<pass>@<host>:<port>
MYCO_ENTERPRISE_NO_PROXY=127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,<内网网关IP/域名>
EOF
chmod 600 "$STATE_DIR/.env"

# 2.2 Caddyfile（deploy-local.sh 只 mount 不创建，首次必须自己放）
cat > "$STATE_DIR/Caddyfile" <<'CADDY'
{
    servers { protocols h1 h2 }
}
:80 {
    encode gzip
    reverse_proxy localhost:3000
}
CADDY
```

---

## 3. 基础镜像 + 构建资产（按 §1 的 arch 对）

### 3.1 base 镜像 `node:26-alpine`

- **华为内网 / docker.io 被阻断的环境**：从 SWR 拉（`deploy-local.sh` 会自动做，
  前提是 SWR 可达）：按 arch 选 `-linuxarm64`（aarch64）/ `-linuxamd64`（x86_64）。
- **能直连 docker.io 的环境**：直接 `docker pull node:26-alpine` 即可，tag 名一致。
- ⚠️ **红线（2026-11-02 实测）**：别退到 `node:20-alpine`——漂移到 20.18.1 后
  无法 `require()` 纯 ESM 的 `@anthropic-ai/claude-agent-sdk`，对话框会空白。
  `node:26` 默认 `require(esm)`。现有 tag 若已存在，脚本会跳过重新拉取——
  想刷新基础镜像就手动 pull 覆盖 tag 后再 build。

### 3.2 `build-assets/`（caddy / lean-ctx / 字体）——**强架构相关**

| 资产 | 下载来源 | 架构 token |
|---|---|---|
| caddy | `caddyserver.com/api/download?...&arch=<amd64\|arm64>` | 按 `uname -m` |
| lean-ctx | `github.com/yvgude/lean-ctx/.../lean-ctx-<x86_64\|aarch64>-...` | 按 `uname -m` |
| JetBrainsMono | `github.com/ryanoasis/nerd-fonts/...` | 无关 |
| harness2 | 仓库内 `vendor/harness2` | 无网依赖 |

- `deploy-local.sh` 会按本机 arch 自动预取进 `build-assets/`（gitignored）。
- 💣 **跨环境最容易踩**：`git clone / git pull` **不会**把 build-assets 带过去
  （gitignored）——正常。但如果你手动 `scp -r` / `rsync` **整个仓库目录**到
  一台**不同架构**的机器，旧的 build-assets（例如 aarch64）会被脚本当作
  "已存在"而跳过下载 → 打入镜像的是**错误架构**的 caddy/lean-ctx。
  **应对**：换了架构的机器，要么 `--fresh`（强制重下），要么先 `rm -rf build-assets`。

---

## 4. 部署（两选一）

### 4.1 一键（同环境 / 新环境参数已对好）

```bash
export MYCO_STATE_DIR="$STATE_DIR"          # 覆盖默认绝对路径（必须）
bash scripts/deploy-local.sh                # SWR base → assets → build → 起容器 → 自检
# 之后日常：改 .env / 换 tag 只重建容器
bash scripts/deploy-local.sh --skip-build   # 等价 redeploy-local-docker.sh
# 强制刷新（重下资产 + 全量重建；不会刷新已存在的 base tag）
bash scripts/deploy-local.sh --fresh
```

### 4.2 手动分步（了解每一步 / 脚本不符时）

```bash
cd <仓库根目录>
export STATE_DIR=... MYCO_IMAGE=myco:<tag>

# ① base 镜像（SWR 或 docker.io）
docker pull <按 arch 的 node:26-alpine 源> && docker tag <同上> node:26-alpine

# ② 宿主侧预取 assets（走该环境代理；arch 按 uname -m）
mkdir -p build-assets
curl -fsSLk --proxy "$PROXY" -o build-assets/caddy \
  "https://caddyserver.com/api/download?os=linux&arch=$DOCKER_ARCH"
curl -fsSLk --proxy "$PROXY" -o build-assets/lean-ctx.tar.gz \
  "https://github.com/yvgude/lean-ctx/releases/download/v3.6.14/lean-ctx-${RUST}-unknown-linux-musl.tar.gz"
curl -fsSLk --proxy "$PROXY" -o build-assets/JetBrainsMono.tar.xz \
  "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.1/JetBrainsMono.tar.xz"

# ③ 全量构建（代理从该环境 .env 取，勿写死）
PROXY=$(grep '^MYCO_ENTERPRISE_PROXY_URL=' "$STATE_DIR/.env" | cut -d= -f2-)
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u NO_PROXY -u no_proxy \
  docker build -t myco:latest -f docker/Dockerfile \
    --build-arg http_proxy="$PROXY" --build-arg https_proxy="$PROXY" \
    --build-arg no_proxy='127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.huawei.com' \
    .
```

---

## 5. 生成容器 —— 关键：`--add-host` 从**本机** `/etc/hosts` 生成

容器不继承宿主 hosts，必须 `--add-host` 补。**别用别的环境抄来的 IP**——直接从
这台机器的 `/etc/hosts` 提取内网域名→IP，动态生成，怎么都不会错：

```bash
# 从宿主 /etc/hosts 提取"内网域名  IP"行，拼成 --add-host=domain:IP 列表
HOSTS_FLAGS=$(
  awk '/^(#|$)/{next} /huawei\.com|code-agent|ascend\.huawei/{if($1 !~ /^[0-9]/){print "--add-host="$2":"$1} else {print "--add-host="$2":"$1}}' \
    /etc/hosts | sort -u
)
echo "生成的 --add-host 列表："; echo "$HOSTS_FLAGS"

# proxy / no_proxy 从 .env 取
set -a; source "$STATE_DIR/.env"; set +a
PROXY="${MYCO_ENTERPRISE_PROXY_URL:?}"; NOPROXY="${NO_PROXY:-$MYCO_ENTERPRISE_NO_PROXY}"

docker rm -f myco-local >/dev/null 2>&1 || true
docker run -d --name myco-local --restart unless-stopped \
  $HOSTS_FLAGS \
  -p 80:80 -p 443:443 \
  -v "$STATE_DIR/home:/root" \
  -v "$STATE_DIR/wks:/wks" \
  -v "$STATE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$STATE_DIR:/data" \
  -e NO_PROXY="$NOPROXY" -e no_proxy="$NOPROXY" \
  -e HTTP_PROXY="$PROXY" -e http_proxy="$PROXY" \
  -e HTTPS_PROXY="$PROXY" -e https_proxy="$PROXY" \
  -e MYCO_DATA=/data -e HOST=127.0.0.1 -e PORT=3000 -e SHELL=/bin/bash \
  -e MYCO_ALLOW_ALL=1 \
  myco:latest
```

> 💡 别忘了把内网域名/IP 加进 `.env` 的 `MYCO_ENTERPRISE_NO_PROXY` / `NO_PROXY`——
> 否则内网请求走了 HIS 代理 → HTTP 504。

---

## 6. 部署后自检（每环境必过一遍）

```bash
echo "1) hosts";                      docker exec myco-local grep code-agent /etc/hosts
echo "2) API env";                    docker exec myco-local sh -c 'tr "\0" "\n" </proc/1/environ | grep -i ANTHROPIC'
echo "3) 容器 DNS";                   docker exec myco-local getent hosts api.code-agent.rnd.huawei.com
echo "4) harness python3";            docker exec myco-local sh -c 'command -v python3 && python3 --version'
echo "5) 容器/端口";                  docker ps --filter name=myco-local
echo "6) 服务/HTTP";                  docker logs myco-local 2>&1 | grep -m1 'mycod running'
curl -s -o /dev/null -w "GET / -> HTTP %{http_code}\n" http://127.0.0.1/
```

---

## 7. 常见"换环境"故障速查

| 症状 | 根因（通常是环境相关） | 处理 |
|---|---|---|
| `getaddrinfo ENOTFOUND <内网域名>` | 该环境容器缺 hosts 映射 | 用 §5 从本机 /etc/hosts 重新生成 `--add-host` |
| 内网请求 **HTTP 504**（HIS 拦截页） | 内网域名/IP 没进 no_proxy | 加进 `.env` 的 `MYCO_ENTERPRISE_NO_PROXY` 重建 |
| `docker build` 卡 `FROM node:26-alpine` i/o timeout | 该环境 docker.io 被阻断 | 用 SWR 源拉 + tag（§3.1） |
| 构建出的 caddy/lean-ctx 跑不起来 / 架构不符 | build-assets 是别的架构 | 换架构后 `--fresh` 重下（§3.2） |
| 对话框**空白**、agent 不回复 | 错用 node:20-alpine（无法 require ESM SDK） | 换 node:26-alpine 重建（§3.1 红线） |
| Caddy 不起来 / `/etc/caddy/Caddyfile` 是目录 | 新环境忘了放 Caddyfile | 按 §2.2 先写好再起容器 |
| `MYCO_STATE_DIR` 没设就报路径不存在 | 默认绝对路径是上个环境的 | `export MYCO_STATE_DIR=$STATE_DIR`（§4.1） |
| `HTTP_PROXY` 打印空 | 宿主 shell 先展开了变量 | 用 `docker inspect --format '{{json .Config.Env}}'` 查 |

---

## 8. 一份对照：本机 vs 生产 vs K8s vs 远端

| | 本机 dev（aarch64） | 生产 x86_64 | K8s 节点 | 远端 docker 主机 |
|---|---|---|---|---|
| 用哪个脚本 | `deploy-local.sh` | `deploy-local.sh`（自动抓 x86） | `deploy-local.sh --skip-run` 打镜像 → push registry-cbu | `redeploy-1014-remote.sh` |
| base 镜像 | SWR `-linuxarm64` | SWR `-linuxamd64` | SWR `-linuxamd64` | 复用 `deploy-local.sh` 产物 |
| `--add-host` | 本机 /etc/hosts | 本机 /etc/hosts | 由集群 DNS/网络 | 远端主机 /etc/hosts（脚本已适配） |
| 状态目录 | 本机 STATE_DIR | 生产 STATE_DIR | ——（registry 镜像） | 远端新建 state |
| 关键注意 | 别带旧 aarch64 assets | `--fresh` 或清 build-assets | 严禁推本地增量 tag | 凭据/token 远端复用 |

参考：`docs/deploy/docker.md`（本机方案）、`dev-docker.md`、`k8s-deploy.md`、
`harness2-install.zh.md`，及 `scripts/` 下 `deploy-local.sh` / `redeploy-local-docker.sh` /
`redeploy-1014-remote.sh`。
