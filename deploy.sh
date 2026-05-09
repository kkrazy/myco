#!/usr/bin/env bash
# Deploy myco to myco.labxnow.ai via Docker image.
#
# Canonical layout: ALL persistent state lives under a single host directory
# ($MYCO_STATE_DIR), bind-mounted into the container as:
#
#   $MYCO_STATE_DIR        → /data    (sessions.json, .env, caddy/, …)
#   $MYCO_STATE_DIR/home   → /root    (claude config: .claude/, .claude.json)
#   $MYCO_STATE_DIR/wks    → /wks     (workspaces)
#   $MYCO_STATE_DIR/Caddyfile → /etc/caddy/Caddyfile
#
# A redeploy is just `docker rm + docker run` against the same state dir;
# nothing lives in unnamed/named docker volumes.
#
# Usage:
#   ./deploy.sh                     # full deploy (test → build → ship → swap → verify)
#   ./deploy.sh --skip-tests        # skip the pre-flight smoke test
#   MYCO_DEPLOY_HOST=user@host \
#   MYCO_STATE_DIR=/path/on/remote ./deploy.sh
set -euo pipefail

REMOTE="${MYCO_DEPLOY_HOST:-kkrazy@myco.labxnow.ai}"
IMAGE="${MYCO_IMAGE_TAG:-myco:latest}"
NAME="${MYCO_CONTAINER:-myco}"
STATE_DIR="${MYCO_STATE_DIR:-/home/kkrazy/myco-state}"
SKIP_TESTS=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,21p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "unknown arg: $arg"; exit 2 ;;
  esac
done

cd "$(dirname "$0")"

step() { printf "\n── %s ──\n" "$*"; }
ok()   { printf "  ✓ %s\n" "$*"; }
die()  { printf "  ✗ %s\n" "$*" >&2; exit 1; }

# 1. Pre-flight tests
if [ "$SKIP_TESTS" = "0" ]; then
  step "Pre-flight: ./test.sh"
  ./test.sh
  ok "tests passed"
else
  echo "(skipping ./test.sh — --skip-tests)"
fi

# 2. Build image locally
step "Building $IMAGE"
docker build -t "$IMAGE" . >/dev/null
LOCAL_ID=$(docker images "$IMAGE" --format '{{.ID}}')
ok "built $IMAGE ($LOCAL_ID)"

# 3. Open multiplexed SSH connection
SOCK="$HOME/.ssh/cm/deploy-$(echo "$REMOTE" | tr -c 'A-Za-z0-9' '_')"
mkdir -p "$(dirname "$SOCK")"
ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=10m \
    -o ConnectTimeout=10 -o ServerAliveInterval=30 -fN "$REMOTE" \
  || die "could not open SSH master to $REMOTE"
trap 'ssh -o ControlPath="$SOCK" -O exit "$REMOTE" 2>/dev/null || true' EXIT
remote() { ssh -o ControlPath="$SOCK" "$REMOTE" "$@"; }
remote_scp() { scp -o ControlPath="$SOCK" "$@"; }

remote "docker --version >/dev/null" || die "docker not available on $REMOTE"

# 4. Ensure state dir + subdirs
step "Ensuring state dir on $REMOTE: $STATE_DIR"
remote "mkdir -p '$STATE_DIR' '$STATE_DIR/home' '$STATE_DIR/wks'"
ok "$STATE_DIR{,/home,/wks} ready"

# 5. Seed Caddyfile if missing (state dir is the source of truth)
if ! remote "test -f '$STATE_DIR/Caddyfile'"; then
  if remote "test -f /home/kkrazy/myco/Caddyfile"; then
    remote "cp /home/kkrazy/myco/Caddyfile '$STATE_DIR/Caddyfile'"
    ok "Caddyfile seeded from /home/kkrazy/myco/Caddyfile"
  else
    remote_scp Caddyfile "$REMOTE:$STATE_DIR/Caddyfile"
    ok "Caddyfile uploaded from project tree"
  fi
fi

# 6. One-time migration: if old container has volume-backed mounts and the
#    state dir is empty for that target, copy the volume contents over.
inspect_vol() {
  local dest="$1"
  remote "docker inspect $NAME --format '{{range .Mounts}}{{if eq .Destination \"$dest\"}}{{if eq .Type \"volume\"}}{{.Name}}{{end}}{{end}}{{end}}' 2>/dev/null" || true
}
migrate() {
  local volname="$1" host_target="$2" presence_check="$3"
  [ -z "$volname" ] && return 0
  if remote "$presence_check"; then return 0; fi
  echo "  → migrating $volname → $host_target"
  remote "docker run --rm -v $volname:/src -v '$host_target':/dst alpine sh -c 'cp -an /src/. /dst/' >/dev/null"
}

step "Migrating any existing volumes (one-time)"
DATA_VOL=$(inspect_vol /data)
ROOT_VOL=$(inspect_vol /root)
WKS_VOL=$(inspect_vol /wks)
migrate "$DATA_VOL" "$STATE_DIR"      "test -f '$STATE_DIR/sessions.json'"
migrate "$ROOT_VOL" "$STATE_DIR/home" "test -e '$STATE_DIR/home/.claude.json' -o -d '$STATE_DIR/home/.claude'"
migrate "$WKS_VOL"  "$STATE_DIR/wks"  "test -n \"\$(ls -A '$STATE_DIR/wks' 2>/dev/null)\""
ok "migration done (no-op if state dir already populated)"

if [ "$DRY_RUN" = "1" ]; then
  step "DRY RUN — would now stream image and swap container"
  echo "  image:  $IMAGE ($LOCAL_ID)"
  echo "  remote: $REMOTE"
  echo "  state:  $STATE_DIR (and $STATE_DIR/{home,wks})"
  echo "  caddyf: $STATE_DIR/Caddyfile"
  echo "  cmd:    docker run -d --name $NAME --restart unless-stopped -p 80:80 -p 443:443 \\"
  echo "            -v $STATE_DIR:/data \\"
  echo "            -v $STATE_DIR/home:/root \\"
  echo "            -v $STATE_DIR/wks:/wks \\"
  echo "            -v $STATE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro \\"
  echo "            $IMAGE"
  printf "\n✓ Dry-run complete. Re-run without --dry-run to deploy.\n"
  exit 0
fi

# 7. Stream image to remote
step "Streaming $IMAGE to $REMOTE"
docker save "$IMAGE" | gzip -1 | remote "gunzip | docker load" >/dev/null
ok "image loaded"

# 8. Swap container with the canonical bind-mount layout
step "Swapping container"
remote "docker stop $NAME >/dev/null 2>&1 || true; \
        docker rm $NAME >/dev/null 2>&1 || true; \
        docker run -d --name $NAME --restart unless-stopped \
          -p 80:80 -p 443:443 \
          -v '$STATE_DIR:/data' \
          -v '$STATE_DIR/home:/root' \
          -v '$STATE_DIR/wks:/wks' \
          -v '$STATE_DIR/Caddyfile:/etc/caddy/Caddyfile:ro' \
          $IMAGE" >/dev/null
ok "container started"

# 9. Verify served version matches source
step "Verifying"
DOMAIN=$(echo "$REMOTE" | sed 's/.*@//')
EXPECTED=$(grep -oP 'app\.js\?v=\K\d+' web/public/index.html | head -1)
SERVED=""
for i in 1 2 3 4 5 6 7 8; do
  SERVED=$(curl -sk --max-time 5 "https://$DOMAIN/" 2>/dev/null | grep -oP 'app\.js\?v=\K\d+' | head -1)
  [ -n "$SERVED" ] && break
  sleep 2
done
[ -n "$SERVED" ] || die "https://$DOMAIN/ not responding after redeploy"
[ "$SERVED" = "$EXPECTED" ] \
  && ok "https://$DOMAIN/ serving app.js?v=$SERVED (matches source)" \
  || die "version mismatch: served v$SERVED, source v$EXPECTED"

printf "\n✓ Deployed %s to %s (state: %s)\n" "$IMAGE" "$REMOTE" "$STATE_DIR"
