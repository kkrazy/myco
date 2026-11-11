# myco — K8s 部署（Helm chart）

部署统一走 Helm（master 252 已装 Helm 3.19.0，见
`docs/deploy/k8s-cluster-init.md` §10），**不使用散装 kubectl apply**。

```
k8s/myco/                 # Helm chart
├── Chart.yaml
├── values.yaml           # 默认值：调度节点 / 存储 / hosts 映射 / Caddyfile / 探活
└── templates/
    ├── _helpers.tpl      # 校验 image.repository、env 注入方式
    ├── namespace.yaml
    ├── storageclass.yaml # local-data（静态供应 + WaitForFirstConsumer）
    ├── pv.yaml           # 252 本机 2T 的 Local PV ×3 + PVC ×3
    ├── caddyfile.yaml    # Caddyfile ConfigMap（:80 反代 :3000）
    ├── env-secret.yaml   # --set-file envFile=<state/.env> 生成的运行时 Secret
    ├── deployment.yaml   # 单副本 Recreate，hostNetwork，hostAliases 内网映射
    └── NOTES.txt         # helm install 完成后打印的验证指引
```

## 一键部署

```bash
# 前置：252 上 mkdir -p /data/myco/{state,home,wks}，镜像已推 registry-cbu.huawei.com
# 先干跑校验再正式安装（详见 docs/deploy/k8s-deploy.md §5）：
helm template myco ./myco -n myco \
  --set image.repository=registry-cbu.huawei.com/<ns>/myco \
  --set image.tag=<tag> \
  --set-file envFile=/data/myco/state/.env > /tmp/render.yaml && grep -c '^kind:' /tmp/render.yaml  # 11

helm upgrade --install myco ./myco -n myco --create-namespace \
  --set image.repository=registry-cbu.huawei.com/<ns>/myco \
  --set image.tag=20261017 \
  --set-file envFile=/data/myco/state/.env
```

验证 / 升级 / 卸载：

```bash
helm -n myco status
helm -n myco get values myco
helm -n myco upgrade myco ./myco --reuse-values --set image.tag=<new>
helm -n myco uninstall myco    # PV reclaimPolicy=Retain，252 磁盘数据不删
```

> 存储说明：三节点 2T×3 无法联合成统一 6T（无共享块设备；Longhorn 纠删卷随
> Pod 漂移失效，JuiceFS/CephFS 需要系统级组件且代理环境拉取困难）。
> 当前方案：Pod 固定调度 master，状态目录用 252 本机 2T `/data`。
> 详见 `docs/deploy/k8s-deploy.md` §7。
