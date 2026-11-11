# K8s 集群安装指南（Docker + cri-dockerd + kubeadm，内网/代理环境）

> 目标：在无法直连外网的华为内网机器上，安装 Docker + Kubernetes 集群
> （新版 K8s 1.35 + cri-dockerd 方案），master 单独安装 Helm。
>
> 本文档记录了从「探测环境 → 安装 Docker → 解决代理坑 → cri-dockerd
> → kubeadm init/join → Flannel → Helm → 新增节点」的完整流程。
> 其中 **systemd 代理配置的 `%` 转义** 和 **代理 MITM 自签名证书** 是两个关键坑。

---

## 0. 集群架构速览

节点规划（均为 Ubuntu 24.04 / aarch64 / 64C 244G）:

```mermaid
flowchart LR
    subgraph k8scluster["K8s 集群 (kubeadm v1.35.3)"]
        subgraph master["7.242.106.252 — master / control-plane"]
            M_HELM["Helm 3.19.0"]
            M_K8S["kube-apiserver :6443<br/>etcd / controller-manager / scheduler"]
            M_CRI["cri-dockerd 0.3.17"]
            M_DOCKER["Docker 29.9.1"]
            M_K8S --> M_CRI --> M_DOCKER
            M_HELM --> M_K8S
        end
        subgraph worker1["7.242.106.110 — worker"]
            W1_K8S["kubelet / kube-proxy"]
            W1_CRI["cri-dockerd 0.3.17"]
            W1_DOCKER["Docker 29.9.1"]
            W1_K8S --> W1_CRI --> W1_DOCKER
        end
        subgraph worker2["7.242.109.33 — worker"]
            W2_K8S["kubelet / kube-proxy"]
            W2_CRI["cri-dockerd 0.3.17"]
            W2_DOCKER["Docker 29.9.1"]
            W2_K8S --> W2_CRI --> W2_DOCKER
        end
        master <-. "kubeadm join :6443" .-> worker1
        master <-. "kubeadm join :6443" .-> worker2
        FLANNEL["Flannel v0.27.2 (DaemonSet)<br/>Pod CIDR: 10.244.0.0/16"]
    end

    subgraph external["出网路径"]
        NEXUS["内网 Nexus<br/>10.155.96.21:8081<br/>(ubuntu-ports / docker-ce 源)"]
        PROXY["HTTP 代理 (MITM)<br/>p_atlas@10.195.176.39:8081<br/>(镜像拉取 / 文件下载, curl 需 -k)"]
    end

    k8scluster -->|"apt 包"| NEXUS
    k8scluster -->|"容器镜像 / 下载"| PROXY
    classDef nodeStyle fill:#e8f0fe,stroke:#4285f4,stroke-width:1px
    style k8scluster fill:#f6f8fa,stroke:#d0d7de
    class M_K8S,W1_K8S,W2_K8S,M_HELM nodeStyle
```

网络: Pod CIDR `10.244.0.0/16`（Flannel）· Service CIDR `10.96.0.0/12`

安装流程（每台机器的执行顺序）:

```mermaid
flowchart TD
    S1["① 环境探测<br/>(出网能力 / Nexus 可用性)"] --> S2["② 安装 Docker<br/>(内网 Nexus docker-ce 源)"]
    S2 --> S3["③ Docker 代理配置<br/>daemon.json + systemd proxy.conf<br/>⚠️ % 要转义成 %%"]
    S3 --> S4["④ 安装 cri-dockerd<br/>(github 走代理, curl -k)"]
    S4 --> S5["⑤ K8s 前置配置<br/>内核模块 / sysctl / kubelet 指向 cri-dockerd"]
    S5 --> S6{"角色?"}
    S6 -->|master| S7["⑥ kubeadm init<br/>预拉控制面镜像"]
    S6 -->|worker| S8["⑧ kubeadm join<br/>(master 上的 token)"]
    S7 --> S9["⑦ 部署 Flannel CNI<br/>(ghcr.io → docker.io 镜像)"]
    S9 --> S10["⑩ 安装 Helm<br/>(仅 master)"]
    S8 --> S11["⑨ 验证<br/>kubectl get nodes 全 Ready"]
    S10 --> S11
    classDef warn fill:#fef3cd,stroke:#d4a017
    classDef good fill:#d4edda,stroke:#28a745
    class S3,S9 warn
    class S11 good
```

| 项 | 值 |
|---|---|
| 操作系统 | Ubuntu 24.04.3 LTS, aarch64 (arm64) |
| Docker | 29.9.1 (docker-ce, 来自内网 Nexus 源) |
| 容器运行时对接 | cri-dockerd 0.3.17 (K8s 1.24+ 移除 dockershim) |
| Kubernetes | v1.35.3 (kubeadm/kubelet/kubectl, pkgs.k8s.io 已预装) |
| CNI | Flannel v0.27.2 |
| Helm | v3.19.0 (仅 master) |
| 内网 apt 源 | `http://10.155.96.21:8081`（Nexus，出网被断时唯一可用源） |
| 出网代理 | `http://p_atlas:proxy%40123@10.195.176.39:8081`（MITM 代理） |

> ⚠️ 机器**无法直连外网**（curl 外网全部超时），一切外网访问要么走内网
> Nexus，要么走代理。且该代理对 HTTPS 做中间人（自签名证书），
> `curl` 必须加 `-k`，Docker 需把相关 registry 配成 insecure。

---

## 1. 环境探测（装前确认）

```bash
# OS / 架构 / 内核模块
cat /etc/os-release | head -2          # Ubuntu 24.04, aarch64
lsmod | grep -E "br_netfilter|overlay" # 需要有, 没有就 modprobe

# 出网能力
ping -c2 8.8.8.8                       # 100% loss → 只能靠 Nexus + 代理
curl -sI --max-time 8 https://github.com   # 超时 → 需要代理

# 内网 Nexus 可用性
curl -s -o /dev/null -w "%{http_code}" \
  http://10.155.96.21:8081/ubuntu-ports/dists/noble/Release    # 200

# k8s 官方源(packages已预装则无需外网, apt update 失败可忽略)
dpkg -l | grep kube
```

---

## 2. 三台机器安装 Docker（内网 Nexus 源）

```bash
# ① 添加 docker-ce 源（指向内网 Nexus 的 docker-ce 代理路径）
mkdir -p /etc/apt/keyrings
curl -fsSL http://10.155.96.21:8081/docker-ce/linux/ubuntu/gpg -o /tmp/docker.gpg
cat /tmp/docker.gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg

echo 'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.gpg] http://10.155.96.21:8081/docker-ce/linux/ubuntu/ noble stable' \
  > /etc/apt/sources.list.d/docker-ce.list

apt-get update
apt-cache policy docker-ce     # 确认有 Candidate（内网源通了才有）

# ② 安装并启动
DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io
systemctl enable --now docker
docker version                  # Server Version: 29.9.1
```

> 🕳️ **坑 1**：`docker-ce.list` 里的 URL 如果 shell 变量展开时机不对会
> 写成 `http:///docker-ce/...`（空 host），apt 报 `Undetermined Error`。
> 直接写完整字面量 URL 最稳。

---

## 3. Docker 代理 + insecure registry 配置（三台）

### 3.1 daemon.json（insecure + 内网仓库，参考同环境 7.244.1.111 的配置）

```bash
cat > /etc/docker/daemon.json <<'EOF'
{
  "insecure-registries": ["registry-cbu.huawei.com", "registry.k8s.io", "docker.io", "registry-1.docker.io", "ghcr.io"],
  "registry-mirrors": ["http://registry-cbu.huawei.com"]
}
EOF
```

### 3.2 systemd 代理 drop-in —— 注意 `%%` 转义！

```bash
mkdir -p /etc/systemd/system/docker.service.d
cat > /etc/systemd/system/docker.service.d/proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://p_atlas:proxy%%40123@10.195.176.39:8081"
Environment="HTTPS_PROXY=http://p_atlas:proxy%%40123@10.195.176.39:8081"
Environment="NO_PROXY=localhost,127.0.0.1,10.155.96.21,registry-cbu.huawei.com,7.242.106.110,7.242.106.252,7.242.109.33,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,.svc,.cluster.local"
EOF

systemctl daemon-reload && systemctl restart docker

# 验证代理真的注入了（见 §3.3 的坑）
systemctl show docker -p Environment | grep -o "HTTP_PROXY=[^ ]*"
# 应输出: HTTP_PROXY=http://p_atlas:proxy%40123@10.195.176.39:8081
```

> 🕳️ **坑 2（最隐蔽）**：代理密码里的 `%40`（即 `@` 的 URL 编码）会被
> systemd 当作 **specifier** 解析，`%4` 不是合法槽位 → 整行
> `Environment=` 被 **静默丢弃**，journal 里只有一行不起眼的 warning：
> `Failed to resolve specifiers in HTTP_PROXY=..., ignoring: Invalid slot`。
> 症状：`docker pull registry.k8s.io/...` 报 `dial tcp ...:80: i/o timeout`
> （直连而非走代理）。**解法：把 `%` 写成 `%%`**（systemd 转义），
> systemd 展开后恢复为 `%40`。

### 3.3 NO_PROXY 必须覆盖

- `10.155.96.21`（Nexus，走内网直连，不该走代理）
- `registry-cbu.huawei.com`（内网仓库）
- **三个节点 IP**（kubelet/内网组件互访）
- `10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12`（Pod/Service 网段兜底）
- `.svc,.cluster.local`（集群内域名）

### 3.4 验证拉镜像

```bash
docker pull registry.k8s.io/pause:3.10     # 成功即代理+insecure 均生效
```

> 🕳️ **坑 3**：该代理对 HTTPS 做 MITM（返回自签名证书），curl 直接访问
> 会报 `SSL certificate problem: self-signed certificate in certificate chain`，
> curl 加 `-k`；Docker 侧则靠 daemon.json 的 insecure-registries 绕过验证。

---

## 4. 安装 cri-dockerd（三台，K8s 1.24+ 必需）

K8s 1.24 移除了 dockershim，kubelet 不再直接对接 Docker。要继续用 Docker
作为容器运行时，必须装 **cri-dockerd**（实现 CRI 接口，桥接到 dockerd）。

```bash
# ① 下载 arm64 二进制（走代理, curl 加 -k 绕过 MITM 证书）
export https_proxy=http://p_atlas:proxy%40123@10.195.176.39:8081
curl -skL --max-time 120 -o /tmp/cri-dockerd.tgz \
  "https://github.com/Mirantis/cri-dockerd/releases/download/v0.3.17/cri-dockerd-0.3.17.arm64.tgz"

tar -xzf /tmp/cri-dockerd.tgz -C /tmp
install -m 755 /tmp/cri-dockerd/cri-dockerd /usr/local/bin/cri-dockerd
/usr/local/bin/cri-dockerd --version     # cri-dockerd 0.3.17

# ② 创建 systemd 服务
cat > /etc/systemd/system/cri-docker.service <<'EOF'
[Unit]
Description=CRI Interface for Docker Application Container Engine
Documentation=https://docs.mirantis.com
After=network-online.target docker.service firewalld.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=notify
ExecStart=/usr/local/bin/cri-dockerd --container-runtime-endpoint fd:// --network-plugin=cni --pod-infra-container-image=registry.k8s.io/pause:3.10
ExecReload=/bin/kill -s HUP $MAINPID
TimeoutSec=0
RestartSec=2
Restart=always
StartLimitBurst=3
StartLimitIntervalSec=60
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/cri-docker.socket <<'EOF'
[Unit]
Description=CRI Docker Socket for the API

[Socket]
ListenStream=%t/cri-dockerd.sock
SocketMode=0660
SocketUser=root
SocketGroup=docker

[Install]
WantedBy=sockets.target
EOF

systemctl daemon-reload
systemctl enable --now cri-docker.socket cri-docker.service

# 验证
systemctl is-active cri-docker.service    # active
ls /var/run/cri-dockerd.sock              # socket 存在
```

---

## 5. K8s 前置系统配置（三台）

```bash
# ① 内核模块
cat > /etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
EOF
modprobe overlay && modprobe br_netfilter

# ② sysctl
cat > /etc/sysctl.d/k8s.conf <<'EOF'
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sysctl --system

# ③ kubelet 指向 cri-dockerd（关键）
mkdir -p /etc/systemd/system/kubelet.service.d
cat > /etc/systemd/system/kubelet.service.d/0-cri.conf <<'EOF'
[Service]
Environment="KUBELET_EXTRA_ARGS=--container-runtime-endpoint=unix:///var/run/cri-dockerd.sock --pod-infra-container-image=registry.k8s.io/pause:3.10"
EOF
systemctl daemon-reload
```

> kubeadm/kubelet/kubectl 1.35.3 三台均已预装（pkgs.k8s.io 源装好的）；
> 如新机器没有，参考 §9 的新增节点步骤。

---

## 6. 初始化 master（仅在 7.242.106.252）

```bash
# ① 预拉控制面镜像（走 cri-dockerd, 依赖 §3 的代理配置）
kubeadm config images pull --cri-socket unix:///var/run/cri-dockerd.sock
# Pulled: kube-apiserver / kube-controller-manager / kube-scheduler /
#         kube-proxy / coredns:v1.13.1 / pause:3.10.1 / etcd:3.6.6-0  (均 v1.35.3)

# ② init
kubeadm init \
  --apiserver-advertise-address=7.242.106.252 \
  --pod-network-cidr=10.244.0.0/16 \
  --service-cidr=10.96.0.0/12 \
  --cri-socket unix:///var/run/cri-dockerd.sock \
  --node-name 7.242.106.252 \
  --upload-certs

# 成功输出中保存 join 信息（也可随时用 kubeadm token create --print-join-command 重新生成）:
#   kubeadm join 7.242.106.252:6443 --token <token> \
#     --discovery-token-ca-cert-hash sha256:<hash>

# ③ 配置 kubectl
mkdir -p /root/.kube
cp /etc/kubernetes/admin.conf /root/.kube/config
export KUBECONFIG=/root/.kube/config   # 建议写入 /root/.bashrc
kubectl get nodes    # 此时 master 为 NotReady（还没装 CNI, 正常）
```

> 🕳️ **坑 4**：`kubeadm init` 前若 shell 里残留 `https_proxy`，记得把
> `7.242.106.252` 加进 `no_proxy`，否则 kubectl/helm 访问本机 apiserver:6443
> 的请求会被发去代理导致 `Gateway Time-out`。

---

## 7. 部署 Flannel CNI（仅在 master）

```bash
# ① 下载 manifest（走代理, -k 绕 MITM）
export https_proxy=http://p_atlas:proxy%40123@10.195.176.39:8081
curl -skL --max-time 60 -o /tmp/kube-flannel.yml \
  "https://github.com/flannel-io/flannel/releases/download/v0.27.2/kube-flannel.yml"

# ② ghcr.io 被该代理拒绝(denied)，把镜像换成 docker.io 的 flannel 官方镜像
sed -i "s|ghcr.io/flannel-io/flannel|docker.io/flannel/flannel|g; \
        s|flannel-cni-plugin:v1.7.1-flannel1|flannel-cni-plugin:v1.5.1-flannel1|" \
  /tmp/kube-flannel.yml

# ③ 部署（清掉 proxy 再操作 kubectl, 或确保 no_proxy 含 master IP）
unset https_proxy http_proxy
kubectl apply -f /tmp/kube-flannel.yml

# ④ 验证
kubectl -n kube-flannel get pods -o wide   # kube-flannel-ds-xxx  1/1 Running
kubectl get nodes                          # master → Ready
```

> 🕳️ **坑 5**：`ghcr.io/flannel/*` 走该代理返回 `error from registry: denied`，
> 换 `docker.io/flannel/*` 同名镜像即可。cni-plugin 的新 tag
> (`v1.9.2`) docker.io 上没有，用 manifest 原始的 `v1.5.1-flannel1`。

---

## 8. 加入 worker 节点（在 110 / 33 上）

```bash
# 每台 worker 执行（join 信息来自 §6 的 init 输出）
kubeadm join 7.242.106.252:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --cri-socket unix:///var/run/cri-dockerd.sock \
  --node-name <本机IP>

# 回 master 验证
kubectl get nodes -o wide
# NAME            STATUS   ROLES           VERSION   CONTAINER-RUNTIME
# 7.242.106.110   Ready    <none>          v1.35.3   docker://29.9.1
# 7.242.106.252   Ready    control-plane   v1.35.3   docker://29.9.1
# 7.242.109.33    Ready    <none>          v1.35.3   docker://29.9.1

kubectl get pods -A     # 全部 Running
```

Flannel 是 DaemonSet，新节点加入后自动拉起，无需手动操作。

---

## 9. 后续新增节点

新机器需要先完成 **§2 ~ §5 全部步骤**（Docker、代理、cri-dockerd、
系统配置），以及安装 kubeadm/kubelet/kubectl（如未预装）：

```bash
# k8s 官方 apt 源（需代理；若内网 Nexus 有 kubernetes 代理源可替换）
export https_proxy=http://p_atlas:proxy%40123@10.195.176.39:8081
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key \
  | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.35/deb/ /' \
  > /etc/apt/sources.list.d/kubernetes.list
apt-get update && apt-get install -y kubelet kubeadm kubectl
apt-mark hold kubelet kubeadm kubectl
```

然后在 master 上生成 join 命令（token 24h 过期，随时可重建）：

```bash
# master (252) 上
kubeadm token create --print-join-command
# 输出末尾追加两个参数再在新机器上执行:
#   --cri-socket unix:///var/run/cri-dockerd.sock --node-name <新机器IP>
```

### 移除节点

```bash
# master 上
kubectl drain <节点名> --ignore-daemonsets --delete-emptydir-data
kubectl delete node <节点名>
# 该节点上
kubeadm reset && rm -rf /etc/cni/net.d /var/lib/etcd
```

---

## 10. 安装 Helm（仅 master 252）

```bash
export https_proxy=http://p_atlas:proxy%40123@10.195.176.39:8081
curl -skL --max-time 180 -o /tmp/helm.tgz \
  "https://get.helm.sh/helm-v3.19.0-linux-arm64.tar.gz"
tar -xzf /tmp/helm.tgz -C /tmp
install -m 755 /tmp/linux-arm64/helm /usr/local/bin/helm

helm version    # v3.19.0
# 验证与集群对接（先 unset proxy, 否则 apiserver 请求绕道代理会超时）
unset https_proxy http_proxy
export KUBECONFIG=/root/.kube/config
helm list -A
```

> `get.helm.sh` 走代理同样被 MITM，curl 必须 `-k`；下载的 tar 包本身
> 有官方 SHA256 可校验。

---

## 11. 端到端验证

```bash
# master 上部署一个测试负载，确认调度到 worker 且 Pod 网络正常
kubectl create deployment nginx-test --image=nginx:alpine
kubectl get pods -l app=nginx-test -o wide
#   nginx-test-xxx   1/1 Running   10.244.2.2   7.242.109.33
kubectl delete deployment nginx-test
```

---

## 12. 踩坑速查表

| # | 坑 | 症状 | 解法 |
|---|---|---|---|
| 1 | 机器无法直连外网 | curl/ping 外网全部超时 | apt 用内网 Nexus（`10.155.96.21:8081`），其余走代理 |
| 2 | 代理 MITM 自签名证书 | `SSL certificate problem: self-signed certificate in chain` | curl 加 `-k`；Docker 把 registry 配成 insecure |
| 3 | systemd 的 `%` specifier | 代理 env 被**静默丢弃**，`docker pull` 直连超时；journal 报 `Failed to resolve specifiers ... Invalid slot` | drop-in 里 `%` 写成 `%%` |
| 4 | kubectl/helm 访问 apiserver 绕道代理 | `Gateway Time-out` | `no_proxy` 加 master IP，或操作前 `unset https_proxy` |
| 5 | ghcr.io 被代理拒绝 | flannel 镜像 `error from registry: denied` | 换 `docker.io/flannel/*` 镜像 |
| 6 | apt 源 URL 空 host | `Undetermined Error` | sources.list 里写完整字面量 URL，别用未展开的变量 |
| 7 | K8s 1.24+ 无 dockershim | kubelet 起不来 / 找不到 runtime | 装 cri-dockerd，kubelet 加 `--container-runtime-endpoint=unix:///var/run/cri-dockerd.sock` |

---

## 13. 日常使用备忘

- master 上操作 kubectl/helm：`export KUBECONFIG=/root/.kube/config`（可写入 `.bashrc`）
- shell 临时用代理下载文件：`export https_proxy=...` 用完 `unset`，或确保 `no_proxy` 含 `7.242.106.252,10.155.96.21`
- kubeadm join token 24h 过期：`kubeadm token create --print-join-command` 随时补
- Flannel/kube-proxy 是 DaemonSet，新节点自动纳管，无需手动部署
