# myco — K8s 集群部署指南（Helm 一键部署，内网/代理环境）

> 目标：把 Docker 单机部署的 myco（见 [docker.md](./docker.md)）迁移到
> [k8s-cluster-init.md](./k8s-cluster-init.md) 搭建的三节点集群上。
> **部署方式：Helm chart（`k8s/myco/`），一条 `helm upgrade --install` 完成，
> 不使用散装 kubectl apply。**
>
> 集群：master `7.242.106.252` + worker `7.242.106.110` / `7.242.109.33`
> （K8s v1.35.3 / cri-dockerd / Flannel / Pod CIDR 10.244.0.0/16）。
> 操作默认在 **master（252）** 上执行（`export KUBECONFIG=/root/.kube/config`，
> Helm 3.19.0 已装）。
>
> ✅ **本文档已在 252 集群实测走通（2026-10-17）**：从 docker 版
> （`myco:delm08`）就地切换到 K8s 版，零数据搬迁，验证清单全过。
> 实测中修复的 4 个坑已回写进正文：master taint 未容忍（§1）、
> namespace ownership 冲突致资源静默缺失（§5）、env-secret 模板
> YAML 特殊字符/注释行漏过滤（§9）、codehub hosts IP 过时（§9）。
>
> 📋 **内网 hosts 完整映射（2026-10-19 基准，宿主 `/etc/hosts` 权威来源）**：
>
> ```
> 7.194.47.62    apigw-mq.huawei.com
> 10.129.3.241   pb-dgg.sppsws.huawei.com
> 7.202.25.45    codehub-dg-g.huawei.com
> 172.19.152.237 proxy.huawei.com
> 7.156.115.217  api.code-agent.rnd.huawei.com
> 7.237.97.68    models.ascend.huawei.com
> ```
>
> ⚠️ `codehub-dg-g.huawei.com` 的 IP 以 252 宿主 `/etc/hosts` 实时值为准
> （2026-10 实测曾从 `7.202.25.45` 变为 `100.95.29.121`，见 §9 排查表）。
> 容器内直连域名必须同时进 `NO_PROXY`/`no_proxy`：
> `api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,7.216.246.115`
> （docker 版完整 `-e` 写法见 docker.md §"宿主 run 命令"）。

---

## 0. 架构速览

```
                        ┌────────────────────────────────────────────────────┐
 Browser ──HTTP──▶ 252:80 (宿主) ══ hostNetwork ══▶ Caddy ──▶ node mycod :3000
                        │                          │    └─ spawns claude agent (Agent SDK)
                        │                          └─ reads /data/.env
                        │                          └─ requests ──▶ api.code-agent.rnd.huawei.com
                        │                                     (7.156.115.217, hostAliases 直连)
                        │
      Release: myco (chart k8s/myco)
      Pod: replicas=1, nodeSelector→252, strategy=Recreate
        ├─ /data      ← Local PV → 252:/data/myco/state  (2T 盘)
        ├─ /root      ← Local PV → 252:/data/myco/state/home   ← 与 docker 版同目录，零搬迁
        ├─ /wks       ← Local PV → 252:/data/myco/state/wks    ← 同上
        └─ /etc/caddy/Caddyfile ← ConfigMap (ro)
      调度: tolerations 容忍 control-plane:NoSchedule（master 即目标节点）
```

与 Docker 部署（docker.md §0/§4.2）的映射：

| Docker | Helm chart | 说明 |
|---|---|---|
| `--add-host=…:IP` ×6 | `values.yaml → hostAliases` | 容器不继承宿主 `/etc/hosts`，kubelet 合并写入；6 条完整映射见文首基准表（IP 变动时先核对 252 宿主 `/etc/hosts`） |
| `-e NO_PROXY/…` + state/`.env` | `--set-file envFile=` → Secret `envFrom` | `.env` 原样导入，改凭据只需重跑 helm 命令 |
| `-v state:/data` 等 ×4 | Local PV/PVC ×3 + Caddyfile ConfigMap | `Caddyfile` 从文件变 ConfigMap |
| `-p 80:80 -p 443:443` | `hostNetwork: true` | Caddy 直接监听宿主 80 |
| `--restart unless-stopped` | Deployment（`strategy: Recreate`） | 单副本 + 本地盘，滚动更新会挂载死锁 |

> 存储结论（为什么不用三节点 6T）：见 §7。

---

## 1. 前置条件

| 项 | 要求 | 检查命令（master 上） |
|---|---|---|
| 集群 | 三节点 Ready | `kubectl get nodes` |
| kubeconfig | master `/root/.kube/config` 可用 | `kubectl get ns` 不报错 |
| 镜像 | 已推 `registry-cbu.huawei.com`（§2），或已 `docker load` 进 252（§2.1） | 252 上 `docker images \| grep myco` |
| 252 磁盘 | `/data` 为独立 2T 盘 | `df -h /data` |
| 端口 | 252 上 80/443 空闲 | `ss -lntp \| grep -E ':80 \|:443 '` |
| 252 旧容器 | docker 版若曾在 252 跑过需先摘除 | `docker ps -a \| grep myco` → `docker stop <名>` |
| master taint | control-plane 污点已被 chart tolerations 覆盖 | `kubectl describe node 7.242.106.252 \| grep -A2 Taints` |
| 凭据 | 源机 Docker state 的 `.env`（§4 迁到 252） | `grep -c '=' state/.env` |

> **master taint（2026-10-17 实测踩坑）**：252 是 control-plane，默认带
> `node-role.kubernetes.io/control-plane:NoSchedule` 污点。本 chart 的设计就是
> 固定调度 master，**必须容忍该污点**——chart 已内置（values.yaml `tolerations`，
> deployment 模板渲染），自建 chart 时漏了这一条会表现为 Pod 永远 Pending：
> `0/3 nodes are available: 1 node(s) had untolerated taint(s)`。
>
> **registry-cbu.huawei.com 在 252 上 DNS 解析失败（NXDOMAIN）**——镜像走仓库
> 这条路当前不通。实际部署用 §2.1 路径：252 本机 `docker load`（或沿用本机
> 已有镜像如 `myco:delm08`）+ `imagePullPolicy: IfNotPresent`，helm 命令照常。
> 代理 URL 里的密码含 `@`（编码 `%40`）时尤其注意走本机镜像，别折腾远程 pull。

> 端口检查若显示 `docker-proxy` 占着 80——就是旧 docker 版还在，先 `docker stop`；
> 若是别的进程，评估后再动（hostNetwork 下 Pod 会直接抢宿主 80，冲突会表现为
> Pod 反复 `CrashLoopBackOff`，Caddy 日志报 bind: address already in use）。

### 1.1 从 docker 版平滑切换（如 252 或源机正在跑 docker 版）

1. 源机上停 docker 容器：`docker stop myco-local`（**不删**，数据在 bind mount，回退就靠它）
2. 数据 rsync 到 252（§4）
3. Helm 部署 + 验证（§5、§6）
4. 观察一两天无问题后，源机再 `docker rm myco-local` 收尾

回退路径：`helm -n myco uninstall myco` → 源机 `docker start myco-local`。PV reclaimPolicy=Retain，252 上的数据副本不删。

---

## 2. 构建并推送镜像（在有源码的机器上）

> ⚠️ **构建产物迁移（2026-11-02）**：`docker/Dockerfile` 现在**依赖 `build-assets/`
> 里预取的外部二进制**（caddy / lean-ctx / JetBrainsMono，构建时 `COPY build-assets/`
> 进镜像，这几步不再出外网——构建沙箱代理会掉落大文件下载）。所以构建不能裸
> `docker build`，得先走 `scripts/deploy-local.sh --skip-run`（它自动 SWR 拉
> `node:26-alpine` 基镜像 + 在**宿主**上用代理预取 `build-assets/` + 全量构建），
> 或手动按 docker.md §4.0b 的 step 0/0.5 准备基镜像与 `build-assets/` 后再 build。
> 详见 `docs/deploy/docker.md` §4.0/§4.0b。

集群节点拉镜像走 `registry-cbu.huawei.com`（daemon.json 已配 insecure + mirror），
因此**镜像必须先推到该内网仓库**：

> ⚠️ **实测（2026-10-17）**：`registry-cbu.huawei.com` 在 252 上 DNS 解析
> NXDOMAIN，仓库路径当前不通——实际部署走的是 §2.1（252 本机镜像 +
> `IfNotPresent`）。仓库修复后本节才生效；在那之前把 §2.1 当主路径。

```bash
# ① 全量构建（不是增量叠层！K8s 节点上没有 myco:local-newN 底层）
#    前置：先按 docker.md §4.0 准备好 node:26-alpine 基镜像 + build-assets/
#          （直接跑 `bash scripts/deploy-local.sh --skip-run` 一步到位，产物 myco:latest）。
#    需走代理拉基础镜像 node:26-alpine（不要用 node:20——漂移到 20.18.1 无法 require()
#    纯 ESM 的 claude-agent-sdk，导致对话框空白），MITM 证书 → --build-arg 传代理。
#    代理 URL 从 state/.env 取，勿写死。
PROXY=$(grep '^MYCO_ENTERPRISE_PROXY_URL=' state/.env | cut -d= -f2)
docker build -f docker/Dockerfile \
  --build-arg http_proxy="$PROXY" \
  --build-arg https_proxy="$PROXY" \
  --build-arg no_proxy=localhost,127.0.0.1,10.155.96.21,registry-cbu.huawei.com \
  -t registry-cbu.huawei.com/<你的namespace>/myco:$(date +%Y%m%d) .

# ② 推送
docker push registry-cbu.huawei.com/<你的namespace>/myco:$(date +%Y%m%d)
```

> ⚠️ **严禁用 `myco:local-newN` 之类的本地增量 tag 直接推**——它们叠在源机
> 本机的 `myco:latest` 之上，仓库里缺底层，别的机器 pull 下来跑不起来。
> 上仓库的镜像必须走 `docker/Dockerfile` 全量构建（且带 `build-assets/`）。
> 镜像 tag 只在 `helm --set` 时引用，chart 文件里不硬编码；
> 推荐用日期 tag（`20261017`），一 tag 一版本，回滚 = `helm rollback`。

### 2.1 本机镜像路径（当前实际主路径，2026-10-17 实测）

`registry-cbu` DNS 不通时的离线路径（cri-dockerd 直接复用节点 docker）——
**当前部署实际走的就是这条**：

> 💡 `scripts/redeploy-1014-remote.sh` 把下面整套"本机 `docker save | gzip` →
> ssh 到远端 → `docker load` → 建 state 目录/.env → 重建容器"自动化成一个命令
> （远端仓库路径写法、凭据复用、hosts 域名按远端自身 `/etc/hosts` 适配），
> 推 docker 版远端时优先用它；推 K8s 节点时把目标从 110 换成 252、把
> Caddyfile/helm 步骤换成 §5 的 helm 命令即可。

```bash
# 构建机（镜像已由 deploy-local.sh 打好，或按 §2 手动 build）
docker save registry-cbu.huawei.com/<ns>/myco:20261017 | gzip > myco-20261017.tar.gz
scp myco-20261017.tar.gz root@7.242.106.252:/data/myco/

# 252 上
gunzip -c /data/myco/myco-20261017.tar.gz | docker load
```

镜像进 252 本机 docker 后，`imagePullPolicy: IfNotPresent`（values 默认）
下 kubelet 会直接用本机镜像、不再拉仓库——helm 命令照常执行即可，
`--set image.repository=myco --set image.tag=delm08`（短名引用本机 tag）。
若 252 上已有现役 docker 版镜像（如从 docker 版就地切换），直接用它，
连 save/load 都省了——2026-10-17 的实际部署就是沿用 `myco:delm08`。

---

## 3. master（252）上的目录准备

chart 的 hostPath 与 **docker 版布局完全一致**（home/wks 是 state 的子目录），
252 上若已跑过 docker 版则**目录天然就位，零搬迁**（2026-10-17 实测如此）：

```bash
# Local PV 不自动建目录，全新环境必须先手工创建
mkdir -p /data/myco/state /data/myco/state/home /data/myco/state/wks

# 确认磁盘（应为独立 2T 盘挂载）
df -h /data

# myco 镜像内以 root 运行，目录保持 root 属主即可（与 docker 版一致）
ls -ld /data/myco/state /data/myco/state/home /data/myco/state/wks
```

## 4. 迁移存量数据（可选但推荐）

把当前 Docker 版（源机）的状态目录同步到 252：

```bash
# 在源机上执行（先配好免密 SSH）；home/wks 落到 state 子目录（与 chart hostPath 一致）
rsync -a /data/s00791175/Delm/mycoFile/state/      root@7.242.106.252:/data/myco/state/
rsync -a /data/s00791175/Delm/mycoFile/state/home/ root@7.242.106.252:/data/myco/state/home/
rsync -a /data/s00791175/Delm/mycoFile/state/wks/  root@7.242.106.252:/data/myco/state/wks/
```

> 若 252 上 docker 版**已在这台机器跑过**（数据本就在 252 的 state 目录），
> 本节整个跳过——2026-10-17 的实际部署即如此，零数据搬迁。

迁移后在 252 上**编辑 `/data/myco/state/.env`**，做以下 K8s 适配：

0. **确认 `MYCO_ALLOW_ALL=1` 在列**（与 docker 版 [docker.md](./docker.md) 对齐）。
   `server/src/permissions.js decide()` 读取该变量：命中后跳过整个 allow/deny 评估、
   直接返回 `allow`——容器化部署下 agent 不再弹出任何 `/decide` 权限确认窗。
   **显式 `/deny` 规则仍然优先生效**，所以 deny 列表在开放模式下依旧是可用的
   kill-switch。缺失时（如从旧 docker `.env` 迁移、未含此变量）主会话/single-agent
   里跑 k8s 安装等不在默认 allow 列表的命令就会弹权限确认。`.env` 经
   `--set-file envFile=` 原样导入 Secret（§0 映射表），所以改这里后**重跑 helm 命令**
   即生效（entrypoint 启动时也读 `/data/.env`）。docker 版同样要求此变量，
   两环境行为靠它保持一致。

0b. **流空闲看门狗无需迁移动作**（2026-11-09 起默认生效，见 [docker.md §2.2](./docker.md)）。
   `server/src/agent-session.js streamIdleWatchdogEnv()` 每次 SDK 迭代自动注入
   `CLAUDE_ENABLE_STREAM_WATCHDOG=1` + 15 分钟窗口——不依赖 `.env`，从 docker
   迁过来的工作负载行为一致。作用：网关挂死的流式请求约 15 分钟内被 CLI 内部
   abort + 重试（turn 不中断、不影响长工具调用、不会提前结束 /run-n2）。
   要调窗口：在 `.env` 加 `CLAUDE_STREAM_IDLE_TIMEOUT_MS=<毫秒>`（代码钳制
   10 分钟下限）并重跑 helm 命令；**关闭只能调大窗口到事实上的不触发，或改代码**
   ——`.env` 写 `CLAUDE_ENABLE_STREAM_WATCHDOG=0` 无效（helper 强制覆盖为 1）。
   注意远端 docker 版有
   `./scripts/deploy.sh --set-stream-idle-timeout <分钟>` 一键改法，K8s 版直接编辑
   `.env` + 重跑 helm 等价。

1. `NO_PROXY` / `no_proxy` 追加集群网段：
   `7.242.106.252,7.242.106.110,7.242.109.33,10.244.0.0/16,10.96.0.0/12,.svc,.cluster.local`
   并**确认内网直连域名在列**（缺了会走代理被拦截，表现为 HTTP 504/`fetch failed`）：
   `localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,7.216.246.115`
2. 确认 `HOST=127.0.0.1`、`PORT=3000`（deployment 模板会显式设置这两个，
   `.env` 里不写也行）
3. **内网网关 IP 检查**（重点）：`.env` / `state/gateways.json` 里的内网网关
   若写死了**源机 IP**（如 `http://7.242.109.215:xxxx` 的 DS-V4 网关），分两种情况：
   - 网关服务本身还在源机上跑 → 保持不动，但把源机 IP 加进 `NO_PROXY`（直连）
   - 网关应随 myco 一起迁 → 改成 `http://127.0.0.1:xxxx`（hostNetwork 下
     Pod 与宿主同网络栈，本机端口直达）
4. **git-tokens / gateways / auth-sessions / git-worktrees 照搬即可**——它们
   与主机名无关（不绑源机 hostname），rsync 过去直接可用。
5. **在跑的会话**：sessions.json 里状态为运行中的会话，其工作区
   `/wks/<user>/<session>` 是活的 git 检出，里面可能有**未提交/未推送的改动**。
   切换前先在 UI 把会话停干净，或在源机 `git -C <wks> status` 确认干净后再迁；
   rsync 是纯文件复制，中途有写入会产生撕裂副本。

> `state/Caddyfile` 不用迁（chart 的 ConfigMap 提供）。`.env` 同时会被
> entrypoint 从 `/data/.env` 读取—— Helm Secret（envFrom）先生效，
> `.env` 后加载会覆盖同名项，语义一致，两处保留其一即可。

> 252 上留好回退窗口：切换期间源机 docker 版保持 `docker stop`（不 rm），
> K8s 版稳定运行后再考虑清理（§1.1）。

---

## 5. 一键部署（master 上）

```bash
cd <项目>/k8s

# 先干跑渲染校验（不碰集群），确认模板/参数无误：
helm template myco ./myco -n myco \
  --set image.repository=myco \
  --set image.tag=delm08 \
  --set-file envFile=/data/myco/state/.env > /tmp/myco-render.yaml
grep -c "^kind:" /tmp/myco-render.yaml   # 应为 11（1 ns + 1 sc + 3 pv + 3 pvc + 1 cm + 1 secret + 1 deploy）
grep -A6 "hostAliases" /tmp/myco-render.yaml | grep huawei.com   # 6 条内网映射都在
grep -A20 "kind: Secret" /tmp/myco-render.yaml | grep "': \"" | cut -d" " -f2 | sort   # env 键名对账，不应出现 "# " 开头的伪键

# namespace 先手工建 + 打上 Helm ownership 标记（2026-10-17 实测踩坑）：
#   --create-namespace 与 chart 内的 namespace.yaml 模板会打架——Helm 报
#   "namespaces myco already exists" 且 release 标记 failed，**部分资源
#   （实测 3 个 PVC 只落地 1 个）静默缺失**。正确姿势是先建好 ns 再装：
kubectl create ns myco
kubectl label ns myco app.kubernetes.io/managed-by=Helm --overwrite
kubectl annotate ns myco meta.helm.sh/release-name=myco meta.helm.sh/release-namespace=myco --overwrite
#   （Helm 3 对已存在 namespace 做归属校验，缺这两个 label/annotation 会拒装：
#    "invalid ownership metadata"）

# 正式部署（镜像在 252 本机 docker 里、仓库存不下时 repository 直接写短名）：
helm upgrade --install myco ./myco -n myco \
  --set image.repository=myco \
  --set image.tag=delm08 \
  --set-file envFile=/data/myco/state/.env
#   仓库可用时则用全名：--set image.repository=registry-cbu.huawei.com/<ns>/myco

# 部署完立刻对账——实测 Helm 曾静默漏 apply 资源，不能只看 STATUS: deployed：
kubectl -n myco get pvc                 # 必须恰好 3 条（data/home/wks）
kubectl get pv | grep myco              # 必须恰好 3 条 Available/Bound
helm -n myco get manifest myco | grep -cE '^kind:'   # 11
```

这一条命令完成：namespace、StorageClass、Local PV×3 + PVC×3、
Caddyfile ConfigMap、env Secret、Deployment（含 hosts 映射/探活/资源限制/
master 污点容忍）。
安装成功后 helm 会打印 `templates/NOTES.txt` 的验证指引（Pod 状态、hosts、
HTTP 200 三连查）。**若发现 PVC 缺失**（上面"对账"步骤不对数），照 §9
"PVC 只建出一部分"行处理。

参数说明：

| 参数 | 作用 |
|---|---|
| `--set image.repository/tag` | 必填；缺 repository 时 chart 渲染即报错 |
| `--set-file envFile=` | 把 `.env` 导入 Secret；缺它（且未给 `envFromSecret`）渲染报错 |
| `--set imagePullSecrets[0].name=myco-registry` | 可选；内网仓库需认证时（Secret 需已存在） |
| `-f my-values.yaml` | 可选；覆盖 `values.yaml` 任意默认值（hosts 映射、磁盘配额、探活参数等） |

若内网仓库需要认证，先建 Secret（这条例外仍走 kubectl）：

```bash
kubectl -n myco create secret docker-registry myco-registry \
  --docker-server=registry-cbu.huawei.com \
  --docker-username=<用户名> --docker-password=<密码>
```

## 6. 验证

```bash
# ① Release 状态 + Pod 调度到 252
helm -n myco status
kubectl -n myco get pods -o wide
#   myco-xxxx   1/1 Running   10.244.0.x   7.242.106.252

# ② hosts 映射生效（hostAliases）
kubectl -n myco exec deploy/myco -- grep code-agent /etc/hosts
#   7.156.115.217  api.code-agent.rnd.huawei.com

# ③ env 注入（不打印 token 值）
kubectl -n myco exec deploy/myco -- sh -c 'tr "\0" "\n" < /proc/1/environ | grep -c ANTHROPIC'
#   ≥3

# ④ 挂载正确
kubectl -n myco get pvc    # 三条 PVC 全 Bound
kubectl -n myco exec deploy/myco -- ls /data /wks

# ⑤ 服务可达（从集群任意节点或同网段机器）
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://7.242.106.252/auth/check
#   HTTP 200

# ⑤b 存量数据可见（迁移过 §4 的话必查）
kubectl -n myco exec deploy/myco -- sh -c \
  'ls /data/sessions.json /data/git-tokens.json && ls /wks'

# ⑤c 252 宿主资源余量（myco Pod 实际吃的是宿主 2T 盘，不在 K8s 计量内）
ssh root@7.242.106.252 'df -h /data; free -g'

# ⑥ 端到端 API 网关连通（在 Pod 内，token 从 env 读，不打印）
kubectl -n myco exec deploy/myco -- sh -c '
cat > /tmp/v.js <<EOF
const base=process.env.ANTHROPIC_BASE_URL||"http://api.code-agent.rnd.huawei.com";
const model=process.env.ANTHROPIC_MODEL||"glmmoedsa";
const tok=(process.env.ANTHROPIC_AUTH_TOKEN||"");
(async()=>{const c=new AbortController();setTimeout(()=>c.abort(),45000);
try{const r=await fetch(base+"/v1/messages",{method:"POST",
headers:{"content-type":"application/json","anthropic-version":"2023-06-01","authorization":"Bearer "+tok},
body:JSON.stringify({model,max_tokens:8,messages:[{role:"user",content:"hi"}]}),signal:c.signal});
const b=await r.text();console.log("tokLen="+tok.length+" [HTTP "+r.status+"] "+JSON.stringify(b.slice(0,90)));}
catch(e){console.log("ERR:",e.name,e.message);}})();
EOF
cd /app && NODE_PATH=/app/server/node_modules timeout 50 node /tmp/v.js'
#   期望: tokLen=<N> [HTTP 200] "{...assistant...}"
```

### 验证清单

| 步骤 | 检查 | 状态 |
|---|---|---|
| 资源对账 | PVC×3 / PV×3 / manifest 11 个对象全落地 | ☐ |
| 镜像推送 | `registry-cbu.huawei.com` 可 pull（或本机 `docker load`） | ☐ |
| Local PV | 3×PV Available → 3×PVC Bound | ☐ |
| hosts | `/etc/hosts` 含 6 条内网映射 | ☐ |
| env | `ANTHROPIC_*` 注入 PID 1 | ☐ |
| HTTP | `curl 252/auth/check` → 200 | ☐ |
| 网关 | Pod 内 `/v1/messages` → HTTP 200 | ☐ |
| 数据 | 旧 sessions.json 在新 Pod 里可见 | ☐ |
| 会话 | 浏览器打开历史会话可正常查看/续聊 | ☐ |
| 磁盘 | 252 `/data` 余量充足（`df -h`） | ☐ |

---

## 7. 存储方案说明（为什么是"252 单机 2T"而不是"三节点联合 6T"）

**结论：当前环境下三节点 2T×3 无法联合成一个统一 6T 目录，采用 252 单机 2T。**

调研过的路线及否决原因：

| 方案 | 否决原因 |
|---|---|
| LVM/RAID 跨节点 | 不存在——块设备不能跨机器联合，需要分布式块层 |
| **Longhorn**（最接近"联合 6T"） | ① 需在三台机器装 open-iscsi（Nexus 无此包，走 MITM 代理装易失败）；② 控制面 + 驱动共 6+ 个镜像全部要经代理拉取，`ghcr.io` 被该代理拒绝（同 flannel 坑 5）；③ myco 的写模式是**单进程频繁小文件写**（sessions.json、git 检出），跨网络副本写放大严重；④ 副本调度与 Pod 绑定，节点故障时剩余两节点各只能承载 1/3 容量，Pod 重调度后数据未必跟随 |
| JuiceFS | 需要自建**元数据引擎**（Redis/TiKV，单点）+ 对象存储（minio，又是一套有状态服务），内网环境组件下载全靠代理；运维复杂度远超收益 |
| CephFS | 三节点 Ceph 是反模式（monitor 要求奇数节点但最少 3 副本）；安装包 500MB+，内网代理环境部署成功率低；244G×3 的机器跑 Ceph 开销不成比例 |
| NFS（252 导出，110/33 挂载） | 不是"联合"，只是共享 252 的 2T；单点且 master 负载增加。**如果未来只是想让三个节点都能读同一份数据，这是最省事的路线**（`apt install nfs-kernel-server` 在 Nexus 有包） |

**当前方案**：Pod 固定调度 252（`nodeSelector` + Local PV `nodeAffinity` 双保险），
状态目录用 252 本机 2T `/data/myco/`。110/33 的 2T 盘暂时闲置，可留作：

- 以后按节点复制的灾备副本（rsync 定时任务）
- 其它有状态负载的 Local PV
- 若未来确实需要三节点共享，优先考虑 NFS（252 导出）而非分布式文件系统

---

## 8. 日常运维（Helm）

```bash
# 改凭据 / .env 内容：
#   先更新 252:/data/myco/state/.env，然后重跑同一条 helm 命令
helm upgrade --install myco ./myco -n myco \
  --set image.repository=registry-cbu.huawei.com/<ns>/myco \
  --set image.tag=20261017 \
  --set-file envFile=/data/myco/state/.env

# 升级镜像（其余参数复用上次值）：
helm -n myco upgrade myco ./myco --reuse-values --set image.tag=<new>

# ⚠️ --reuse-values 只复用 helm 记录的值，不重读磁盘上的 .env——
# 改了凭据必须显式再传 --set-file envFile=，否则 Secret 还是旧内容。

# 改其它 chart 值（如 hosts 映射、资源限额、探活参数）：
helm -n myco upgrade myco ./myco --reuse-values \
  --set resources.limits.memory=32Gi

# 看 Pod 重建进度（strategy=Recreate：先 Termination 再 Pull/Running）：
kubectl -n myco rollout status deploy/myco --watch

# 查看当前生效值 / 历史：
helm -n myco get values myco
helm -n myco history myco

# 回滚上一版：
helm -n myco rollback myco 0

# 看日志（node 主进程 + Caddy 都在 Pod stdout）：
kubectl -n myco logs deploy/myco --tail=100

# 进入容器排查：
kubectl -n myco exec -it deploy/myco -- bash

# 卸载（PV reclaimPolicy=Retain，252 磁盘数据不删；重装时目录复用）：
helm -n myco uninstall myco
```

> ⚠️ **数据安全**：所有 PV `reclaimPolicy: Retain`，`helm uninstall` 只删
> K8s 对象，252 上 `/data/myco/` 的数据不动。重新部署时 chart 会重建同名
> PV/PVC 并绑回同一目录——只要目录在，数据就在。
> 但**不要**手动 `kubectl delete pv` 后又清目录，那是唯一会丢数据的路径。

> ⚠️ **安全**：`--set-file envFile` 导入的 Secret 含 live 凭证，
> `kubectl -n myco get secret myco-env -o yaml` 明文可见——与 Docker 时代
> （宿主 `.env` 0600）权限模型一致，master 的 kubeconfig 持有者都能读。

---

## 9. 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| `helm upgrade` 渲染报错 `image.repository 必填` | 忘了 `--set image.repository` | 补上 repository + tag 重跑 |
| 渲染报错 `envFile 或 envFromSecret 必须提供一个` | 没传 `.env` | `--set-file envFile=/data/myco/state/.env` |
| 渲染报错 `YAML parse error ... env-secret.yaml` | `.env` 值含 YAML 特殊字符（代理 URL 的 `@ :` 等）裸拼进模板 | chart 已修复（key/value 分别 quote）；自建模板时照抄 `env-secret.yaml` 的 quote 写法 |
| 渲染产物里出现 `"# Delm n": "..."` 之类的伪 env | 模板 `hasPrefix` 参数顺序写反（Helm 3 的 sprig 是 `hasPrefix prefix string`），注释行漏进 Secret | chart 已修复（`$l \| hasPrefix "#"` 管道写法）；`helm get manifest` 检查 Secret 里有没有 `#` 开头的 key |
| 装时报 `namespaces "myco" already exists` 且 release 标记 failed | `--create-namespace` 与 chart 内 namespace 模板打架，**部分资源静默未落地** | `helm uninstall` 清干净 → 按本文档 §5 的三步建 ns + 打 Helm ownership 标记 → 重装 |
| 装时报 `invalid ownership metadata: missing key meta.helm.sh/release-name` | namespace 已存在但没有 Helm 的归属 label/annotation | `kubectl label ns myco app.kubernetes.io/managed-by=Helm` + `kubectl annotate ns myco meta.helm.sh/release-name=myco meta.helm.sh/release-namespace=myco` |
| `STATUS: deployed` 但 PVC 只建出一部分（实测 3 缺 2） | 上一行 namespace 冲突的连锁损伤：release failed 时 Helm 的 apply 中断 | `helm get manifest` 提取缺失 PVC 手动 `kubectl apply` 补齐（名字/spec 与 chart 一致），或 uninstall 后按 §5 正规流程重装 |
| Pod 一直 `Pending`，events 报 `untolerated taint(s)` | master 的 control-plane:NoSchedule 污点没被容忍 | chart 已内置 tolerations；自建时在 Deployment spec.template.spec 加 tolerations（key=node-role.kubernetes.io/control-plane, operator=Exists, effect=NoSchedule），或 `helm --reuse-values` 升级到含修复的 chart 版本 |
| Pod 一直 `Pending` | Local PV 未 Bound / nodeSelector 不匹配 | `kubectl -n myco describe pod` 看 events；确认 252 hostname、目录已建 |
| `ContainerCreating` 卡住 | 252 上目录不存在 / 镜像拉取中 | §3 建目录；节点上 `docker images` 看拉取进度 |
| 镜像拉取 `i/o timeout` / `no such host` | registry-cbu DNS 在 252 解析失败（实测 NXDOMAIN），或节点 docker 代理没生效 | 走 §2.1 本机 `docker load` + `IfNotPresent`；代理问题见 k8s-cluster-init.md §3.2 |
| 镜像拉取 `denied` | 仓库需认证 | §5 建 docker-registry Secret + `--set imagePullSecrets[0].name` |
| `Not logged in` / `fetch failed` | env 缺 ANTHROPIC_* 或 hosts 缺映射 | §6 ②③ 排查；更新 `.env` 后重跑 helm 命令 |
| agent 弹权限确认窗（docker 版不弹） | `.env` 缺 `MYCO_ALLOW_ALL=1`（docker 版已设、k8s 迁移时漏了） | 在 `/data/myco/state/.env` 补 `MYCO_ALLOW_ALL=1` 后重跑 helm 命令（见 §4 第 0 条）；改完全局放行后主会话/single-agent 也不弹 |
| HTTP 504（HIS Proxy 拦截页） | 内网 IP 走了代理 | 把目标 IP/域名加进 `.env` 的 `NO_PROXY`/`no_proxy` 再重跑 helm；基准集合：`api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,7.216.246.115` |
| 80 端口冲突 | 252 上还跑着 docker 版 myco | `docker stop myco-local`（在 252 上，如有） |
| Pod 反复 CrashLoopBackOff + `bind: address already in use` | hostNetwork 抢 80 失败（252 上别的进程占了） | 252 上 `ss -lntp \| grep :80 ` 找到占用者处理 |
| PV 一直 Available、PVC Pending | StorageClass `volumeBindingMode=WaitForFirstConsumer`——没 Pod 消费就不绑 | 正常现象，Deployment 就绪后自动 Bound；一直不绑则查 nodeSelector 是否指向 252 的**实际 hostname** |
| 升级后 Pod 卡 ContainerCreating | `strategy: Recreate` 先杀旧再起新，旧 Pod 的挂载没释放干净 | 等待即可（通常 <1min）；`kubectl -n myco get pod` 观察；>5min 则 `describe pod` 查 VolumeFailedDetach |
| 会话能看但续聊报错 / git 操作失败 | 工作区是从源机 rsync 的撕裂副本（迁移时有写入） | 从源机重新 rsync 对应 `/wks/<user>/<session>`，或在该会话里重跑 git 检出 |
| 内网网关（DS-V4 等）连不上 | `.env`/gateways.json 里网关还指向源机 IP，或没进 NO_PROXY | §4 第 3 条：改地址或加 NO_PROXY 后重跑 helm 命令 |
| codehub 401/连不上 | hosts 里 codehub IP 过时（实测 2026-10 已从 `7.202.25.45` 变为 `100.95.29.121`） | 以 252 `/etc/hosts`（或运行中容器 `--add-host`）为准更新 values.yaml `hostAliases` 后 `helm --reuse-values` 升级 |
| 252 宕机 Pod 消失 | Local PV 单节点限制（设计如此） | 252 恢复后 Pod 自动重建；数据完好（都在 252 本机盘） |

---

## 10. 相关文档

- [docker.md](./docker.md) — Docker 单机部署（本方案的前身，env/hosts 的权威来源）
- [k8s-cluster-init.md](./k8s-cluster-init.md) — 集群安装（kubeadm/cri-dockerd/Flannel/Helm，代理坑大全）
- 项目根 `deploy.md` — 上游 labxnow 环境的部署（与内网集群无关）
- `k8s/README.md` — chart 结构与一键部署命令
