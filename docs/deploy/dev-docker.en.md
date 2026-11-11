# myco — Local Multi-User Development Deployment (dev-docker.en.md)

> A simplified guide for "several people testing on the same machine at the
> same time". For the full procedure see `docker.md`.

## 1. Full flow: build image → set hosts → set proxy → set .env → start

> 💡 **Single-instance one-click automation**: if you only run ONE instance on a
> box (no same-host multi-user), just run `bash scripts/deploy-local.sh` — it
> does everything in §1.0–§1.5 for you (SWR base pull + host prefetch of
> `build-assets/` + full build + container up + self-check). See `docker.md`
> §4.0. For **same-host multi-user** you must still follow this page manually
> with per-user `-p`/`<tag>`/`state`, because `deploy-local.sh` uses a shared
> `myco:latest`/`myco-local` which would collide across users.

### 1.0 Build the image (start from the **full** `docker/Dockerfile`)

```bash
# 0) Make sure the base image node:26-alpine is present locally.
#    docker.io is blocked by the internal HIS proxy, so pull from the Huawei
#    SWR mirror instead (the daemon already trusts it as an insecure-registry;
#    ~8s). arm64 hosts use -linuxarm64; x86 use -linuxamd64; check uname -m.
docker pull swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64
docker tag swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64 node:26-alpine

# 1) Full build (the ONLY step that needs the proxy: npm ci / claude-code /
#    caddy / fonts / apk python3 all reach the outside network). The result is
#    born with python3 + harness² and works out of the box.
#    PROXY comes from MYCO_ENTERPRISE_PROXY_URL in state/.env — never hard-code it.
cd <repo root>
PROXY=$(grep '^MYCO_ENTERPRISE_PROXY_URL=' <state>/.env | cut -d= -f2)
docker build -t myco:<your-tag> -f docker/Dockerfile \
  --build-arg http_proxy="$PROXY" \
  --build-arg https_proxy="$PROXY" \
  --build-arg no_proxy='127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.huawei.com' \
  .
```

> ⚠️ **Use your own image tag** — do not use a generic tag like `myco:latest`,
> or multiple people on the same machine will overwrite each other's image.
> Use the same `<your-tag>` in the `docker run` below.
>
> 🕳️ **Gotcha (2026-10-31)**: do NOT substitute `docker build -f Dockerfile.local`
> (the incremental layer) for the full build — the incremental layer only copies
> working-tree source on top of an existing image and **lacks `python3` /
> `vendor/harness2`**, so `/harness run` fails with `python3: not found`. If you
> want a fast incremental layer, stack it on a base that already has harness
> (see docker.md §4.4). By default, use this full build.

### 1.1 Set /etc/hosts (inside the container)

The container does **NOT** inherit the host's `/etc/hosts`. Use `--add-host`
to map the Huawei intranet domains into the container:

```bash
--add-host=api.code-agent.rnd.huawei.com:7.156.115.217 \
--add-host=codehub-dg-g.huawei.com:7.202.25.45 \
--add-host=models.ascend.huawei.com:7.237.97.68 \
--add-host=proxy.huawei.com:172.19.152.237 \
--add-host=apigw-mq.huawei.com:7.194.47.62 \
--add-host=pb-dgg.sppsws.huawei.com:10.129.3.241 \
--add-host=registry-cbu.huawei.com:100.94.164.16 \
--add-host=kwe-g.codehub.huawei.com:7.221.105.132
```

### 1.2 Set the proxy

Intranet domains/IPs must be reached **directly, bypassing the proxy**; only
external requests go through the enterprise proxy:

```bash
# Enterprise proxy (HTTP/HTTPS — pass one copy of each lowercase/UPPERCASE name)
# host:port follows MYCO_ENTERPRISE_PROXY_URL in state/.env
-e HTTP_PROXY=http://p_atlas:<password>@10.195.176.39:8081 \
-e HTTPS_PROXY=http://p_atlas:<password>@10.195.176.39:8081 \
# no_proxy: intranet direct-connect entries (pass the same values lowercase too)
-e NO_PROXY=localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,kwe-g.codehub.huawei.com,7.216.246.115
```

> ⚠️ Never commit the password to git; take it from `MYCO_ENTERPRISE_PROXY_URL`
> in `.env`. Whenever you add a new intranet domain/IP, add it to BOTH
> `--add-host` and `no_proxy`.

### 1.3 Set .env

Write it into your host state directory; the entrypoint loads it
automatically at container start:

```bash
# /data/<your-tag>/state/.env
ANTHROPIC_AUTH_TOKEN=<token>
ANTHROPIC_MODEL=glmmoedsa
ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com
MYCO_ALLOW_ALL=1
# Stream-idle watchdog (optional — the 15-min code default is already active;
# see docker.md §2.2)
# CLAUDE_ENABLE_STREAM_WATCHDOG=1
# CLAUDE_STREAM_IDLE_TIMEOUT_MS=900000
```

> It is read exactly once at startup — after editing `.env` you must
> `docker restart <container-name>` for changes to take effect.

> **Stream-idle watchdog** (active by default since 2026-11-09):
> `agent-session.js` injects `CLAUDE_ENABLE_STREAM_WATCHDOG=1` + a 15-minute
> window into every SDK iteration — a hung gateway request self-heals via an
> internal CLI abort+retry within ~15 min. The turn is NOT interrupted, long
> tool calls are unaffected (no in-flight request while a tool runs), and
> /run-n2 lanes cannot end early. To tune the window, set
> `CLAUDE_STREAM_IDLE_TIMEOUT_MS=<ms>` in `.env` (10-min floor, enforced in
> code) and restart the container.

### 1.4 One `docker run` to bring it all up

hosts + proxy + mounts in a single command. **The only things multiple people
on one machine need to change are the ports and names** — see the callout
below:

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
  --add-host=kwe-g.codehub.huawei.com:7.221.105.132 \
  -p 443:443 -p 80:80 \
  -v /data/<your-tag>/state/home:/root \
  -v /data/<your-tag>/state/wks:/wks \
  -v /data/<your-tag>/state/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /data/<your-tag>/state:/data \
  -e NO_PROXY=localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,kwe-g.codehub.huawei.com,7.216.246.115 \
  -e HTTP_PROXY=http://p_atlas:<password>@10.195.176.39:8081 \
  -e HTTPS_PROXY=http://p_atlas:<password>@10.195.176.39:8081 \
  -e MYCO_DATA=/data -e HOST=127.0.0.1 -e PORT=3000 -e SHELL=/bin/bash \
  -e MYCO_ALLOW_ALL=1 \
  myco:<your-tag>
```

> 🔧 **How multiple people share one machine**: ports inside the container are
> fixed (Caddy 80/443, node :3000). Each person **only changes the host port
> on the LEFT side of `-p`** — leave the container side (80/443/3000) alone:
> - User A: `-p 18080:80 -p 18443:443 -p 13000:3000 -v /data/A/state:/data --name myco-A`
> - User B: `-p 28080:80 -p 28443:443 -p 23000:3000 -v /data/B/state:/data --name myco-B`
>
> Everyone browses `http://<host>:<their-own-host-port>`. **The image tag,
> ports, `--name` and state path must each be unique per person**, otherwise
> you get port conflicts on the same machine (`bind: address already in use`)
> or two containers fighting over the same `sessions.json`/`.env`.

### 1.5 Post-start self-check

```bash
docker ps --filter name=myco-local                            # container running
docker exec myco-local grep code-agent /etc/hosts             # hosts applied → 7.156.115.217 ...
docker exec myco-local sh -c 'tr "\0" "\n"</proc/1/environ|grep ANTHROPIC'  # .env loaded
docker exec myco-local sh -c 'command -v python3 && python3 --version'     # harness² python3 present
docker logs myco-local 2>&1 | grep -m1 'mycod running'        # service listening on :3000
```

## 2. How .env takes effect inside the container

The container entrypoint `docker/docker-entrypoint.sh` runs `. /data/.env`
(the `.env` in the host state directory) at startup and exports it to the
node main process, which passes it through into every agent session.
**It is read exactly once at startup** — after changing `.env` you must
`docker restart <container-name>` for the change to take effect.

## 3. Five-step runbook for a fresh host (kai instance example)

Bringing an instance up on a **brand-new host** from scratch (example:
`/data/kc` state dir, image `myco:kai`, host ports 1880/18443):

### Step 1 — Create the state directories

```bash
mkdir -p /data/kc/state/home /data/kc/state/wks
```

### Step 2 — Write the Caddyfile (`/data/kc/state/Caddyfile`)

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

Notes:
- The global block `{ ... }` MUST come before any site block.
- `protocols h1 h2` disables HTTP/3 so WebSocket (the chat connection)
  works reliably.
- Caddy listens on `:80` and proxies to the myco app on `127.0.0.1:3000`.

### Step 3 — Write the environment file (`/data/kc/state/.env`)

```bash
cat > /data/kc/state/.env <<'EOF'
ANTHROPIC_AUTH_TOKEN=<your token>
ANTHROPIC_MODEL=glmmoedsa
ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com
MYCO_ALLOW_ALL=1
MYCO_DISABLE_ALLOWLIST=1
EOF
```

Notes:
- `MYCO_ALLOW_ALL=1` + `MYCO_DISABLE_ALLOWLIST=1` bypass the GitHub
  invite allowlist — every user can sign in. Only use this on a trusted
  internal network.

### Step 4 — Build the image (full, with proxy)

```bash
# 0) Prepare the node:26-alpine base (arm64 from SWR; x86 use -linuxamd64)
docker pull swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64
docker tag swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64 node:26-alpine

# 1) Full build (the only proxy step; result has python3 + harness²)
cd /data/kc/myco-1014
PROXY=$(grep '^MYCO_ENTERPRISE_PROXY_URL=' /data/kc/state/.env | cut -d= -f2)
docker build -t myco:kai -f docker/Dockerfile \
  --build-arg http_proxy="$PROXY" \
  --build-arg https_proxy="$PROXY" \
  --build-arg no_proxy='127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.huawei.com' \
  .
```

> ℹ️ Some tips:
> - The proxy is passed via `--build-arg` (http_proxy/https_proxy) so the RUN
>   steps (`apk add`, `npm ci`, `npm i -g claude-code`, caddy/font/lean-ctx
>   downloads) can reach the outside network. Running `docker build` while the
>   host shell itself has proxy vars is also fine, but the build-args are the
>   reliable path.
> - Take `<password>` from `MYCO_ENTERPRISE_PROXY_URL` in `state/.env`
>   (`@` encodes as `%40`); never commit it to git.
> - The full build is slow (`npm ci` + global claude-code + `apk add python3` +
>   caddy/font downloads; tens of minutes depending on proxy speed). The result
>   is **born with `python3` + `harness²`**.
> - For quick code-change iterations, stack the incremental `Dockerfile.local`
>   on a harness-bearing base (see docker.md §4.4) — the incremental image keeps
>   harness.

### Step 5 — Run the container

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
    --add-host=kwe-g.codehub.huawei.com:7.221.105.132 \
    -p 18443:443 \
    -p 1880:80 \
    -v /data/kc/state/home:/root \
    -v /data/kc/state/wks:/wks \
    -v /data/kc/state/Caddyfile:/etc/caddy/Caddyfile:ro \
    -v /data/kc/state:/data \
    -e NO_PROXY=localhost,127.0.0.1,host.docker.internal,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,kwe-g.codehub.huawei.com,7.216.246.115 \
    -e HTTP_PROXY=http://p_atlas:<password>@10.195.176.39:8081 \
    -e HTTPS_PROXY=http://p_atlas:<password>@10.195.176.39:8081 \
    -e MYCO_DATA=/data \
    -e HOST=127.0.0.1 \
    -e PORT=3000 \
    -e SHELL=/bin/bash \
    -e MYCO_ALLOW_ALL=1 \
    myco:kai
```

After startup browse to `http://<host>:1880`; run the §1.5 self-checks with
the container name replaced by `myco-kai`.
