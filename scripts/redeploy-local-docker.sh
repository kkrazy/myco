#!/usr/bin/env bash
#
# Redeploy the local myco Docker container (myco-local) per docs/deploy/docker.md §4.2.
# - Rebuilds the container from the harness-bearing myco:latest image you must
#   build first (docs/deploy/docker.md §4.0): `docker build -f docker/Dockerfile -t myco:latest .`
# - Adds the Huawei intranet host mappings via --add-host (matches host /etc/hosts).
# - Injects the enterprise proxy + no_proxy from the state-dir .env (NOT hardcoded,
#   so the password never lands in git or the transcript).
#
# Idempotent: safe to re-run — it `docker rm -f` the old container and recreates.
# Container volumes (state dir) are bind mounts, so no session data is lost.

set -euo pipefail

# --- Resolve paths ---
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${MYCO_STATE_DIR:-/data/s00791175/Delm/mycoFile/state}"
IMAGE="${MYCO_IMAGE_TAG:-myco:latest}"
CONT_NAME="${MYCO_CONTAINER:-myco-local}"
ENV_FILE="$STATE_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: no state .env at $ENV_FILE" >&2; exit 1
fi

# --- Pull proxy + no_proxy from state .env (live credentials never printed) ---
grep_env() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

PROXY="$(grep_env MYCO_ENTERPRISE_PROXY_URL)"
if [ -z "$PROXY" ]; then
  echo "FATAL: MYCO_ENTERPRISE_PROXY_URL empty in $ENV_FILE" >&2; exit 1
fi
# no_proxy: prefer MYCO_ENTERPRISE_NO_PROXY, else the doc's default list.
NO_PROXY_LIST="$(grep_env MYCO_ENTERPRISE_NO_PROXY)"
if [ -z "$NO_PROXY_LIST" ]; then
  NO_PROXY_LIST="127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,7.216.246.115,api.code-agent.rnd.huawei.com,codehub-dg-g.huawei.com"
fi

echo "==> image:   $IMAGE"
echo "==> cont:    $CONT_NAME"
echo "==> state:   $STATE_DIR"
echo "==> proxy:   $(echo "$PROXY" | sed -E 's#(//[^:]+:)[^@]*@#\1<REDACTED>@#')"
echo "==> no_proxy: $NO_PROXY_LIST"

# --- Recreate the container (drop old, recreate with the mapped layout) ---
docker rm -f "$CONT_NAME" >/dev/null 2>&1 || true

docker run -d --name "$CONT_NAME" --restart unless-stopped \
  --add-host=apigw-mq.huawei.com:7.194.47.62 \
  --add-host=pb-dgg.sppsws.huawei.com:10.129.3.241 \
  --add-host=codehub-dg-g.huawei.com:7.202.25.45 \
  --add-host=proxy.huawei.com:172.19.152.237 \
  --add-host=api.code-agent.rnd.huawei.com:7.156.115.217 \
  --add-host=models.ascend.huawei.com:7.237.97.68 \
  --add-host=registry-cbu.huawei.com:100.94.164.16 \
  --add-host=kwe-g.codehub.huawei.com:7.221.105.132 \
  -p 443:443 -p 80:80 \
  -v "$STATE_DIR/home:/root" \
  -v "$STATE_DIR/wks:/wks" \
  -v "$STATE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$STATE_DIR:/data" \
  -e NO_PROXY="$NO_PROXY_LIST" \
  -e no_proxy="$NO_PROXY_LIST" \
  -e HTTP_PROXY="$PROXY" \
  -e http_proxy="$PROXY" \
  -e HTTPS_PROXY="$PROXY" \
  -e https_proxy="$PROXY" \
  -e MYCO_DATA=/data -e HOST=127.0.0.1 -e PORT=3000 -e SHELL=/bin/bash \
  -e MYCO_ALLOW_ALL=1 \
  "$IMAGE"

echo "==> container created:"
docker ps --filter name="$CONT_NAME" --format '{{.Names}} {{.Status}} {{.Image}}'
echo "==> done."
