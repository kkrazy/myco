#!/usr/bin/env bash
#
# deploy-local.sh — one-click local Docker build + deploy for the myco image,
# automating every step that docs/deploy/docker.md §4 does BY HAND (and that, on
# an intranet host behind the HIS proxy, is the part people trip on):
#
#   0. prep_base_image   SWR pull + re-tag the node:26-alpine base (docker.io
#                        is blocked by the proxy, so we pull from Huawei SWR).
#   1. prefetch_assets   host-side curl (via proxy) of the three external
#                        binaries the image needs but which the buildkit sandbox
#                        proxy DROPS (caddy, lean-ctx, JetBrainsMono fonts) into
#                        gitignored build-assets/ (the Dockerfile COPYs them in).
#   2. build_image       full proxy build of docker/Dockerfile (harness2 shipped).
#   3. recreate          recreate the container with the docker.md §4.2
#                        --add-host / proxy / no_proxy / single-state-dir layout.
#   4. self_check        post-deploy verification (hosts, env, harness, HTTP 200).
#
# Why this exists (all problems actually hit 2026-11-02):
#   * node:20-alpine drifted to 20.18.1, which CANNOT require() the ESM-only
#     @anthropic-ai/claude-agent-sdk (sdk.mjs) -> agent never spawns -> blank
#     chat. This script builds on node:26-alpine, where require(esm) is on by
#     default. Do not downgrade the base back to node:20.
#   * The enterprise proxy drops large in-buildkit-sandbox downloads (curl
#     exit 56 / hang) while the same curl on the HOST succeeds. Hence step 1:
#     we fetch on the host and COPY into the image, keeping the build network-
#     free for those steps. (npm/apk still use the proxy during the build.)
#   * node:26 ships npm 11, which blocks postinstall scripts; the image handles
#     claude-code's via --allow-scripts.
#
# Architectures: auto-detects aarch64 vs x86_64 and fetches the matching caddy /
# lean-ctx. Works on the local aarch64 dev box AND an x86_64 prod host.
#
# Idempotent: safe to re-run. Already-fetched assets / already-present base /
# running container are skipped. --fresh re-does downloads + full rebuild.
#
# Overrides (env): MYCO_STATE_DIR, MYCO_CONTAINER, MYCO_IMAGE, MYCO_BASE_TAG.
#
# Usage:
#   ./scripts/deploy-local.sh                 full pipeline (base+assets+build+run+check)
#   ./scripts/deploy-local.sh --skip-build    recreate container + self-check only
#   ./scripts/deploy-local.sh --skip-run      build image only (no container ops)
#   ./scripts/deploy-local.sh --fresh         force re-download + full rebuild

set -euo pipefail

# ---------------- configuration (overridable) ----------------
STATE_DIR="${MYCO_STATE_DIR:-/data/s00791175/Delm/mycoFile/state}"
STATE_ENV="$STATE_DIR/.env"
CONT="${MYCO_CONTAINER:-myco-local}"
IMG="${MYCO_IMAGE:-myco:latest}"
BASE_TAG="${MYCO_BASE_TAG:-node:26-alpine}"
LEAN_CTX_VER="${MYCO_LEAN_CTX_VER:-3.6.14}"
BUILD_ASSETS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/build-assets"

# ---------------- helpers ----------------
step() { printf '\n\033[1;36m==> [%s]\033[0m %s\n' "$1" "$2"; }

# Read one KEY= from the state .env (no credential printing anywhere).
get_env() {
  [ -f "$STATE_ENV" ] || return 1
  grep -E "^$1=" "$STATE_ENV" | tail -1 | cut -d= -f2-
}

# Detect docker/diet arch + the per-asset arch tokens.
arch_detect() {
  case "$(uname -m)" in
    x86_64)  DOCKER_ARCH=amd64; SWR_SUFFIX=-linuxamd64;   RUST_ARCH=x86_64-unknown-linux-musl ;;
    aarch64) DOCKER_ARCH=arm64; SWR_SUFFIX=-linuxarm64;   RUST_ARCH=aarch64-unknown-linux-musl ;;
    *) echo "FATAL: unsupported arch $(uname -m)" >&2; exit 1 ;;
  esac
  SWR_BASE="swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine$SWR_SUFFIX"
}

# Fetch one external asset from <url> into build-assets/<dest> if not present.
fetch_asset() {
  local url="$1" dest="$2"
  if [ ! -s "$BUILD_ASSETS/$dest" ]; then
    echo "    fetching $dest ..."
    curl -fsSLk --proxy "$PROXY" -o "$BUILD_ASSETS/$dest" "$url"
  else
    echo "    $dest already present (skip; --fresh to re-fetch)"
  fi
}

prefetch_assets() {
  mkdir -p "$BUILD_ASSETS"
  fetch_asset \
    "https://caddyserver.com/api/download?os=linux&arch=$DOCKER_ARCH" \
    caddy
  fetch_asset \
    "https://github.com/yvgude/lean-ctx/releases/download/v$LEAN_CTX_VER/lean-ctx-$RUST_ARCH-unknown-linux-musl.tar.gz" \
    lean-ctx.tar.gz
  fetch_asset \
    "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.2.1/JetBrainsMono.tar.xz" \
    JetBrainsMono.tar.xz
}

# ---------------- steps ----------------
prep_base_image() {
  if docker image inspect "$BASE_TAG" >/dev/null 2>&1; then
    echo "    base $BASE_TAG present (skip; --fresh to re-pull)"
    return 0
  fi
  echo "    pulling $SWR_BASE ..."
  docker pull "$SWR_BASE"
  docker tag "$SWR_BASE" "$BASE_TAG"
}

build_image() {
  local proxy no_proxy
  proxy="$(get_env MYCO_ENTERPRISE_PROXY_URL || true)"
  no_proxy="$(get_env MYCO_ENTERPRISE_NO_PROXY || get_env no_proxy || true)"
  if [ -z "$proxy" ]; then
    echo "FATAL: MYCO_ENTERPRISE_PROXY_URL not in $STATE_ENV" >&2
    echo "  (fill it first: MYCO_ENTERPRISE_PROXY_URL=http://user:<pass>@host:port)" >&2
    exit 1
  fi
  [ -n "$no_proxy" ] || no_proxy='127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.huawei.com'
  step build "docker build -f docker/Dockerfile -t $IMG (uses proxy; do not interrupt)"
  # Build with the build-time proxy via --build-arg; unset ambient proxy so the
  # builder env isn't double polluted.
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u NO_PROXY -u no_proxy \
    docker build -t "$IMG" -f docker/Dockerfile \
      --build-arg http_proxy="$proxy" \
      --build-arg https_proxy="$proxy" \
      --build-arg no_proxy="$no_proxy" \
      .
}

recreate_container() {
  local proxy no_proxy
  proxy="$(get_env MYCO_ENTERPRISE_PROXY_URL || true)"
  no_proxy="$(get_env MYCO_ENTERPRISE_NO_PROXY || get_env NO_PROXY || true)"
  if [ -z "$proxy" ]; then
    echo "FATAL: proxy env missing in $STATE_ENV" >&2
    exit 1
  fi
  step run "docker run -d --name $CONT (ports 80/443, state=$STATE_DIR)"
  docker rm -f "$CONT" >/dev/null 2>&1 || true
  docker run -d --name "$CONT" --restart unless-stopped \
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
    -e NO_PROXY="$no_proxy" -e no_proxy="$no_proxy" \
    -e HTTP_PROXY="$proxy" -e http_proxy="$proxy" \
    -e HTTPS_PROXY="$proxy" -e https_proxy="$proxy" \
    -e MYCO_DATA=/data -e HOST=127.0.0.1 -e PORT=3000 -e SHELL=/bin/bash \
    -e MYCO_ALLOW_ALL=1 \
    "$IMG"
  docker ps --filter name="$CONT" --format '{{.Names}} {{.Status}} {{.Ports}}'
}

self_check() {
  step check "post-deploy self-check for $CONT"
  echo "--- 1) hosts mapping ---"
  docker exec "$CONT" sh -c 'grep code-agent /etc/hosts' || true
  echo "--- 2) node API config (redacted) ---"
  docker exec "$CONT" sh -c 'tr "\0" "\n" </proc/1/environ | grep -i ANTHROPIC | sed -E "s#(=).*#\1<set>#"' || true
  echo "--- 3) container DNS ---"
  docker exec "$CONT" getent hosts api.code-agent.rnd.huawei.com || true
  echo "--- 4) harness2 python3 ---"
  docker exec "$CONT" sh -c 'command -v python3 && python3 --version' 2>/dev/null | head -1 \
    || echo "(entrypoint owns startup; python3 not on path via bare sh)"
  echo "--- 5) server / HTTP (polling) ---"
  local waited=0 boot
  while :; do
    boot="$(docker logs "$CONT" 2>&1 || true)"
    if grep -qE 'mycod running|server running' <<<"$boot"; then break; fi
    sleep 1; waited=$((waited+1))
    [ "$waited" -gt 30 ] && { echo "server did not report ready within 30s"; break; }
  done
  curl -s -o /dev/null -w "GET / -> HTTP %{http_code}\n" http://127.0.0.1/ \
    || echo "curl failed (is Caddy up?)"
  echo "--- logs tail ---"
  docker logs "$CONT" 2>&1 | tail -8
}

# ---------------- entrypoint ----------------
main() {
  local skip_build=0 skip_run=0 fresh=0
  for a in "$@"; do
    case "$a" in
      --skip-build) skip_build=1 ;;
      --skip-run)   skip_run=1 ;;
      --fresh)      fresh=1 ;;
      *) echo "unknown flag: $a" >&2; exit 1 ;;
    esac
  done

  arch_detect
  echo "arch: $(uname -m)  base: $BASE_TAG ($SWR_BASE)"
  echo "state: $STATE_DIR  container: $CONT  image: $IMG"

  # The container + build both need the state .env for proxy values.
  if [ ! -f "$STATE_ENV" ]; then
    echo "FATAL: $STATE_ENV not found." >&2
    echo "  Create it first with at least:" >&2
    echo "    ANTHROPIC_AUTH_TOKEN=<secret>" >&2
    echo "    ANTHROPIC_MODEL=glmmoedsa" >&2
    echo "    ANTHROPIC_BASE_URL=http://api.code-agent.rnd.huawei.com" >&2
    echo "    MYCO_ALLOW_ALL=1" >&2
    echo "    MYCO_ENTERPRISE_PROXY_URL=http://<user>:<pass>@<host>:<port>" >&2
    echo "    MYCO_ENTERPRISE_NO_PROXY=127.0.0.1,localhost,<intranet CIDRs/domains>" >&2
    exit 1
  fi

  local proxy; proxy="$(get_env MYCO_ENTERPRISE_PROXY_URL || true)"

  if [ "$skip_build" -eq 0 ]; then
    step base "prepare base image (SWR, arch=$DOCKER_ARCH)"
    prep_base_image
    step assets "pre-fetch external binaries into build-assets/ (proxy on host)"
    # --fresh drops build-assets so every asset re-downloads.
    [ "$fresh" -eq 1 ] && rm -rf "$BUILD_ASSETS"
    PROXY="$proxy" prefetch_assets
    build_image
  fi

  if [ "$skip_run" -eq 0 ]; then
    recreate_container
    self_check
  fi

  echo
  echo "==> done. $IMG -> $CONT on ports 80/443. No more manual steps."
  echo "==> next iterations: bash scripts/deploy-local.sh --skip-build"
}

main "$@"
