#!/usr/bin/env bash
#
# Deploy the latest myco code to remote Box 7.242.106.110 as a NEW container
# on ports 80/443, with /etc/hosts + proxy + env consistent with
# docs/deploy/docker.md (adapted to the remote host's OWN /etc/hosts & proxy).
#
# Non-destructive: does NOT touch the existing myco-hle30 container (18800).
# Creates a fresh state dir /data/s00791175/Delm/mycoFile/state and a .env that
# reuses the ANTHROPIC token from hle30's .env + the proxy line from the remote
# root .bashrc (never printed to stdout).
#
# Transport: the full harness-bearing image is built locally (myco:1014 == the
# local myco:latest == HEAD ffd836c) and streamed via
#   gunzip -c <tar> | ssh ... 'docker load'
# so no source is pushed / rebuilt on the remote.
#
# Usage:
#   ./scripts/redeploy-1014-remote.sh                # uses /tmp/myco-1014.tar.gz
#   MYCO_REMOTE_IMAGE_TAR=/path/img.tgz ./...         # custom image tarball
#
# Idempotent: safe to re-run — `docker rm -f` the target container then recreates.
# State dir is a bind mount, so no session data is lost.
#
# NOTE on quoting (learned the hard way): remote steps are passed as QUOTED
# heredocs ('REMOTE' — no local expansion) so $, $(...), and quotes reach the
# remote verbatim. Non-secret values (paths, NO_PROXY list) are injected via an
# env-prefix on the ssh command line instead of heredoc interpolation.

set -euo pipefail

HOST="${MYCO_REMOTE_HOST:-root@7.242.106.110}"
PW="${MYCO_REMOTE_PW:-Hw123456}"
CONT="${MYCO_CONTAINER:-myco-local}"
IMG="${MYCO_REMOTE_IMAGE:-myco:1014}"
STATE_DIR="/data/s00791175/Delm/mycoFile/state"
STATE_ENV="$STATE_DIR/.env"
TAR="${MYCO_REMOTE_IMAGE_TAR:-/tmp/myco-1014.tar.gz}"
NO_PROXY_LIST="127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,7.216.246.115,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com,10.195.176.39,10.155.96.21,7.242.0.0/16"

# Non-secret values carried to the remote for every step.
ENVP="STATE_DIR='$STATE_DIR' STATE_ENV='$STATE_ENV' NO_PROXY_LIST='$NO_PROXY_LIST' CONT='$CONT' IMG='$IMG'"

echo "==> host:      $HOST"
echo "==> container: $CONT  (ports 80/443, HTTP only per remote Caddyfile)"
echo "==> image:     $IMG"
echo "==> state:     $STATE_DIR (fresh)"
echo "==> tar:       $TAR"

[ -f "$TAR" ] || { echo "FATAL: image tarball $TAR not found" >&2; exit 1; }

# ---------- 1. stream image to remote + load ----------
echo "==> [1/5] streaming image to remote + docker load ..."
gunzip -c "$TAR" | sshpass -p "$PW" ssh -o StrictHostKeyChecking=no "$HOST" 'docker load'
sshpass -p "$PW" ssh -o StrictHostKeyChecking=no "$HOST" \
  "IMG='$IMG' bash -s" <<'REMOTE'
set -euo pipefail
if ! docker image inspect "$IMG" >/dev/null 2>&1; then
  SRC="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep "myco:" | head -1)"
  [ -n "$SRC" ] && docker tag "$SRC" "$IMG"
fi
echo "remote $IMG = $(docker image inspect "$IMG" --format '{{.Id}}')"
REMOTE

# ---------- 2. create state dir + Caddyfile ----------
echo "==> [2/5] creating state dir + Caddyfile ..."
sshpass -p "$PW" ssh -o StrictHostKeyChecking=no "$HOST" "$ENVP bash -s" <<'REMOTE'
set -euo pipefail
mkdir -p "$STATE_DIR/home" "$STATE_DIR/wks"
if [ ! -f "$STATE_DIR/Caddyfile" ]; then
  cat > "$STATE_DIR/Caddyfile" <<'CADDY'
{
    servers {
        protocols h1 h2
    }
}
:80 {
    encode gzip
    reverse_proxy localhost:3000
}
CADDY
fi
echo "state dir ready: $(ls -d "$STATE_DIR")"
REMOTE

# ---------- 3. write .env (reuse hle30 token + remote proxy) ----------
echo "==> [3/5] writing .env (reusing hle30 ANTHROPIC token + remote proxy) ..."
sshpass -p "$PW" ssh -o StrictHostKeyChecking=no "$HOST" "$ENVP bash -s" <<'REMOTE'
set -euo pipefail
LEGACY=/data/hle30/state/.env
TOKEN="$(grep -E '^ANTHROPIC_AUTH_TOKEN=' "$LEGACY" | head -1 | cut -d= -f2-)"
[ -n "$TOKEN" ] || { echo "FATAL: no ANTHROPIC_AUTH_TOKEN in $LEGACY" >&2; exit 1; }
# Proxy line pulled from root .bashrc by grep (literal file read; the script
# guards the export under an interactive-shell check, so sourcing it here would
# leave $http_proxy empty — that was this script's earlier failure).
PROXY="$(grep -E '^export http_proxy=' /root/.bashrc | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$PROXY" ] || { echo "FATAL: no 'export http_proxy=' line in /root/.bashrc" >&2; exit 1; }
umask 077
cat > "$STATE_ENV" <<EOF
ANTHROPIC_AUTH_TOKEN=$TOKEN
ANTHROPIC_MODEL=glmmoedsa
ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com
MYCO_ALLOW_ALL=1
MYCO_DISABLE_ALLOWLIST=1
MYCO_ENTERPRISE_PROXY=1
MYCO_ENTERPRISE_PROXY_URL=$PROXY
MYCO_ENTERPRISE_NO_PROXY=$NO_PROXY_LIST
NO_PROXY=$NO_PROXY_LIST
no_proxy=$NO_PROXY_LIST
# Root-cause fix (2026-11-02): node:20-alpine drifted to 20.18.1, which cannot
# require() the ESM-only @anthropic-ai/claude-agent-sdk (sdk.mjs) -> agent never
# spawns -> blank chat. Fixed at the image level by building on node:26-alpine
# (require(esm) on by default). No NODE_OPTIONS workaround needed.
EOF
echo "wrote $STATE_ENV ($(grep -c . "$STATE_ENV") lines; creds not printed)"
REMOTE

# ---------- 4. (re)create the container with docker.md-consistent env/hosts ----------
echo "==> [4/5] recreating container $CONT ..."
sshpass -p "$PW" ssh -o StrictHostKeyChecking=no "$HOST" "$ENVP bash -s" <<'REMOTE'
set -euo pipefail
set -a; source "$STATE_ENV"; set +a
PROXY="${MYCO_ENTERPRISE_PROXY_URL:?}"; NOPROXY="${NO_PROXY:?}"
docker rm -f "$CONT" >/dev/null 2>&1 || true
docker run -d --name "$CONT" --restart unless-stopped \
  --add-host=api.code-agent.rnd.huawei.com:7.156.115.217 \
  --add-host=codehub-dg-g.huawei.com:100.95.29.121 \
  --add-host=registry-cbu.huawei.com:100.95.129.83 \
  --add-host=apigw-mq.huawei.com:7.194.47.62 \
  --add-host=pb-dgg.sppsws.huawei.com:10.129.3.241 \
  --add-host=models.ascend.huawei.com:7.237.97.68 \
  --add-host=proxy.huawei.com:172.19.152.237 \
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
  "$IMG"
echo "container created:"
docker ps --filter name="$CONT" --format '{{.Names}} {{.Status}} {{.Ports}}'
REMOTE

# ---------- 5. verify ----------
echo "==> [5/5] verifying ..."
sshpass -p "$PW" ssh -o StrictHostKeyChecking=no "$HOST" "$ENVP bash -s" <<'REMOTE'
set -euo pipefail
echo "--- hosts in container ---"
docker exec "$CONT" sh -c 'grep -E "huawei|code-agent" /etc/hosts' || true
echo "--- node env (API config + proxy, redacted) ---"
docker exec "$CONT" sh -c 'tr "\0" "\n" </proc/1/environ | grep -iE "ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|http_proxy|no_proxy" | sed -E "s#(//[^:]+:)[^@]*@#\1<REDACTED>@#"'
echo "--- harness2 python3 ---"
docker exec "$CONT" sh -c 'command -v python3 && python3 --version' 2>/dev/null | head -1 || echo "(entrypoint owns startup; python3 not directly visible via sh)"
echo "--- server boot ---"
docker logs "$CONT" 2>&1 | grep -m3 -iE 'mycod running|server running|error' || true
echo "--- HTTP from host ---"
sleep 2
curl -s -o /dev/null -w "GET / -> HTTP %{http_code}\n" http://127.0.0.1/ || echo "curl failed"
REMOTE

echo "==> done."
