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
# Auth: GitHub OAuth + invitation allowlist.
#   $MYCO_STATE_DIR/allowed-github-users.txt   one GitHub login per line
#   $MYCO_STATE_DIR/.env                       MYCO_GH_CLIENT_ID, MYCO_GH_CLIENT_SECRET, MYCO_PUBLIC_ORIGIN
#
# Usage:
#   ./scripts/deploy.sh                                # full deploy (test → build → ship → swap → verify)
#   ./scripts/deploy.sh --skip-tests                   # skip the pre-flight smoke test
#   ./scripts/deploy.sh --dry-run                      # plan only; no image transfer or swap
#   ./scripts/deploy.sh --allow-github-user <login>    # add a GitHub login to the allowlist (no build/ship)
#   ./scripts/deploy.sh --set-oauth <id>:<secret>      # write OAuth client_id/secret into .env (no build/ship)
#   ./scripts/deploy.sh --set-anthropic-key sk-ant-…   # write ANTHROPIC_API_KEY into .env + restart (no build/ship)
#   MYCO_DEPLOY_HOST=user@host \
#   MYCO_STATE_DIR=/path/on/remote ./scripts/deploy.sh
#
# Local mode: when MYCO_DEPLOY_HOST points at loopback (e.g.
# `user@localhost`, `localhost`, `*@127.0.0.1`), the script skips
# the SSH multiplexer + the image-stream save/load and runs every
# step locally (bash + cp + local docker daemon). Use this when
# you're on the target host itself and don't have ssh-to-self
# configured.
#   MYCO_DEPLOY_HOST=kkrazy@localhost ./scripts/deploy.sh
#   # optional override for the verify-step curl target:
#   MYCO_VERIFY_DOMAIN=myco.labxnow.ai MYCO_DEPLOY_HOST=kkrazy@localhost ./scripts/deploy.sh
set -euo pipefail

# Anchor cwd to the repo root regardless of where the caller invoked
# us from. After the td-33 move into scripts/, this script's own
# directory is scripts/ but every relative path inside (Dockerfile,
# ./test/test.sh, server/, web/, etc.) is relative to the repo root.
# The double-cd-then-pwd pattern is robust against $0 being relative
# (e.g. `./scripts/deploy.sh`) vs absolute.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/.."

# ─── config ──────────────────────────────────────────────────────────────────
REMOTE="${MYCO_DEPLOY_HOST:-kkrazy@myco.labxnow.ai}"
IMAGE="${MYCO_IMAGE_TAG:-myco:latest}"
NAME="${MYCO_CONTAINER:-myco}"
STATE_DIR="${MYCO_STATE_DIR:-/home/kkrazy/myco-state}"
SKIP_TESTS=0
SKIP_POST_CHECKS=0
DRY_RUN=0
ADD_ALLOW=""
SET_OAUTH=""
SET_ANTHROPIC_KEY=""

# Populated by verify_deploy; consumed by post_deploy_checks so the
# HTTP probes can hit the same domain the version-stamp probe used.
RESOLVED_DOMAIN=""

# Populated by open_ssh + build_image; consumed by later steps.
SOCK=""
LOCAL_ID=""
# Set to 1 when REMOTE points at loopback — open_ssh detects this
# and the remote/remote_scp helpers below short-circuit to bash/cp
# instead of going through ssh/scp. Lets the script run from the
# target host itself (the path mycobeta + prod both use when the
# operator isn't on a machine with local Docker).
IS_LOCAL=0

# ─── helpers ─────────────────────────────────────────────────────────────────
step()   { printf "\n── %s ──\n" "$*"; }
ok()     { printf "  ✓ %s\n" "$*"; }
warn()   { printf "  ! %s\n" "$*" >&2; }
die()    { printf "  ✗ %s\n" "$*" >&2; exit 1; }

# When IS_LOCAL=1: bypass ssh, run commands directly. Heredoc stdin
# from callers (e.g. allow_github_user, set_oauth_in_env) is passed
# through to bash -s exactly like ssh delivers it to the remote
# bash -s, so handlers don't need to change.
remote() {
  if [ "$IS_LOCAL" = "1" ]; then
    bash -c "$*"
  else
    ssh -o ControlPath="$SOCK" "$REMOTE" "$@"
  fi
}
# scp(src, "user@host:dst") → cp(src, dst) in local mode. We strip
# the "user@host:" prefix off the second arg.
remote_scp() {
  if [ "$IS_LOCAL" = "1" ]; then
    local src="$1"
    local dst="${2#*:}"
    cp "$src" "$dst"
  else
    scp -o ControlPath="$SOCK" "$@"
  fi
}

# ─── steps ───────────────────────────────────────────────────────────────────

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --skip-tests)            SKIP_TESTS=1; shift ;;
      --skip-post-checks)      SKIP_POST_CHECKS=1; shift ;;
      --dry-run)               DRY_RUN=1; shift ;;
      --allow-github-user)     [ -n "${2:-}" ] || die "--allow-github-user requires a GitHub login"
                               ADD_ALLOW="$2"; shift 2 ;;
      --allow-github-user=*)   ADD_ALLOW="${1#--allow-github-user=}"; shift ;;
      --set-oauth)             [ -n "${2:-}" ] || die "--set-oauth requires client_id:client_secret"
                               SET_OAUTH="$2"; shift 2 ;;
      --set-oauth=*)           SET_OAUTH="${1#--set-oauth=}"; shift ;;
      --set-anthropic-key)     [ -n "${2:-}" ] || die "--set-anthropic-key requires the key value"
                               SET_ANTHROPIC_KEY="$2"; shift 2 ;;
      --set-anthropic-key=*)   SET_ANTHROPIC_KEY="${1#--set-anthropic-key=}"; shift ;;
      --help|-h)
        sed -n '2,28p' "$0" | sed 's/^# \?//'
        exit 0
        ;;
      *) echo "unknown arg: $1"; exit 2 ;;
    esac
  done
}

run_tests() {
  if [ "$SKIP_TESTS" = "1" ]; then
    echo "(skipping ./test/test.sh — --skip-tests)"
    return 0
  fi
  step "Pre-flight: ./test/test.sh"
  ./test/test.sh
  ok "tests passed"
}

build_image() {
  step "Building $IMAGE"
  docker build -t "$IMAGE" -f docker/Dockerfile . >/dev/null
  LOCAL_ID=$(docker images "$IMAGE" --format '{{.ID}}')
  ok "built $IMAGE ($LOCAL_ID)"
}

open_ssh() {
  # Local-mode short-circuit: when REMOTE is loopback, skip the
  # SSH multiplexer entirely and just verify docker is reachable
  # on this host. This is what running `./scripts/deploy.sh` FROM the
  # target host wants — no need for ssh-to-self (which prod
  # doesn't have configured anyway).
  case "$REMOTE" in
    localhost|127.0.0.1|*@localhost|*@127.0.0.1) IS_LOCAL=1 ;;
  esac
  if [ "$IS_LOCAL" = "1" ]; then
    docker --version >/dev/null 2>&1 || die "docker not available locally"
    ok "local mode — bypassing SSH (target: $REMOTE)"
    return 0
  fi
  SOCK="$HOME/.ssh/cm/deploy-$(echo "$REMOTE" | tr -c 'A-Za-z0-9' '_')"
  mkdir -p "$(dirname "$SOCK")"
  ssh -o ControlMaster=auto -o ControlPath="$SOCK" -o ControlPersist=10m \
      -o ConnectTimeout=10 -o ServerAliveInterval=30 -fN "$REMOTE" \
    || die "could not open SSH master to $REMOTE"
  trap 'ssh -o ControlPath="$SOCK" -O exit "$REMOTE" 2>/dev/null || true' EXIT
  remote "docker --version >/dev/null" || die "docker not available on $REMOTE"
}

ensure_state_dir() {
  step "Ensuring state dir on $REMOTE: $STATE_DIR"
  remote "mkdir -p '$STATE_DIR' '$STATE_DIR/home' '$STATE_DIR/wks'"
  ok "$STATE_DIR{,/home,/wks} ready"
}

# Seed an empty allowlist file if one doesn't exist yet. The first deploy onto
# a host with OAuth configured but no allowlist would leave nobody able to
# log in — we make the file but don't pre-populate it (admin uses
# --allow-github-user to add entries).
ensure_allowlist_seed() {
  local result
  result=$(remote "
    AL='$STATE_DIR/allowed-github-users.txt'
    if [ -f \"\$AL\" ]; then
      echo unchanged
    else
      cat > \"\$AL\" <<'EOF'
# GitHub logins allowed to sign in to myco. One per line. '#' starts a comment.
# Add more with:  ./scripts/deploy.sh --allow-github-user <login>
EOF
      echo created
    fi
  ")
  case "$result" in
    created)   ok "allowed-github-users.txt seeded (empty — add entries with --allow-github-user)" ;;
    unchanged) ok "allowed-github-users.txt already present" ;;
    *)         die "ensure_allowlist_seed: unexpected result '$result'" ;;
  esac
}

# Warn if OAuth config is missing — the server boots in single-user 'default'
# mode without it, which is fine for dev but not what production wants.
warn_if_oauth_unset() {
  local missing
  missing=$(remote "
    EF='$STATE_DIR/.env'
    [ -f \"\$EF\" ] || { echo 'env-missing'; exit 0; }
    miss=''
    for v in MYCO_GH_CLIENT_ID MYCO_GH_CLIENT_SECRET MYCO_PUBLIC_ORIGIN; do
      grep -qE \"^\$v=\" \"\$EF\" || miss=\"\$miss \$v\"
    done
    echo \"\$miss\"
  ")
  if [ -n "$(echo "$missing" | tr -d ' ')" ]; then
    warn "OAuth not configured (missing in .env: $missing)"
    warn "  Set with: ./scripts/deploy.sh --set-oauth <client_id>:<client_secret>"
    warn "  And ensure MYCO_PUBLIC_ORIGIN=https://<your-host> is in $STATE_DIR/.env"
  else
    ok "OAuth env vars present in .env"
  fi
}

# Idempotently add a GitHub login to the allowlist on the remote. Echoes
# 'added' or 'unchanged'.
allow_github_user() {
  local login="$1"
  if ! [[ "$login" =~ ^[a-zA-Z0-9_-]{1,24}$ ]]; then
    die "invalid GitHub login '$login' (1-24 chars [A-Za-z0-9_-])"
  fi
  step "Allowlisting GitHub user '$login'"
  ensure_state_dir
  ensure_allowlist_seed
  local result
  result=$(remote "LOGIN='$login' AL='$STATE_DIR/allowed-github-users.txt' bash -s" <<'REMOTE_SH'
    set -e
    if grep -qE "^${LOGIN}\b" "$AL"; then echo unchanged; exit 0; fi
    echo "$LOGIN" >> "$AL"
    echo added
REMOTE_SH
  )
  case "$result" in
    added)     ok "allowlist: added '$login'" ;;
    unchanged) ok "allowlist: '$login' already present" ;;
    *)         die "allow_github_user: unexpected result '$result'" ;;
  esac
}

# Idempotently write MYCO_GH_CLIENT_ID and MYCO_GH_CLIENT_SECRET into .env.
# Re-running with a different secret rotates it. Echoes one of: written
# (file/keys created or any value changed) | unchanged.
set_oauth_in_env() {
  local entry="$1"
  if ! [[ "$entry" =~ ^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$ ]]; then
    die "invalid --set-oauth '$entry' (expected client_id:client_secret, no whitespace/commas)"
  fi
  local cid="${entry%%:*}"
  local csec="${entry#*:}"
  step "Setting OAuth client_id and client_secret in .env"
  ensure_state_dir
  local result
  result=$(remote "CID='$cid' CSEC='$csec' EF='$STATE_DIR/.env' bash -s" <<'REMOTE_SH'
    set -e
    touch "$EF"
    chmod 600 "$EF"
    changed=0
    upsert() {
      key="$1"; val="$2"
      if grep -qE "^$key=" "$EF"; then
        cur=$(sed -n "s/^$key=//p" "$EF" | head -1)
        if [ "$cur" != "$val" ]; then
          # Use cat-based rewrite to keep the bind-mounted inode stable.
          tmp=$(mktemp)
          awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' "$EF" > "$tmp"
          cat "$tmp" > "$EF"
          rm -f "$tmp"
          changed=1
        fi
      else
        printf '%s=%s\n' "$key" "$val" >> "$EF"
        changed=1
      fi
    }
    upsert MYCO_GH_CLIENT_ID "$CID"
    upsert MYCO_GH_CLIENT_SECRET "$CSEC"
    if [ "$changed" = "1" ]; then echo written; else echo unchanged; fi
REMOTE_SH
  )
  case "$result" in
    written)   ok ".env: client_id/client_secret upserted" ;;
    unchanged) ok ".env: already has matching client_id/client_secret" ;;
    *)         die "set_oauth_in_env: unexpected result '$result'" ;;
  esac
  warn "OAuth env changes only take effect after the container is restarted (re-run ./scripts/deploy.sh)"
}

# Write ANTHROPIC_API_KEY to the state-dir .env and restart the container so
# the new value is picked up by process.env. Used by the Plan/Arch/Test
# extractor and the existing session summarizer.
set_anthropic_key_in_env() {
  local key="$1"
  if ! [[ "$key" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]]; then
    die "invalid --set-anthropic-key (expected sk-ant-… with no whitespace)"
  fi
  step "Setting ANTHROPIC_API_KEY in .env"
  ensure_state_dir
  local result
  result=$(remote "K='$key' EF='$STATE_DIR/.env' bash -s" <<'REMOTE_SH'
    set -e
    touch "$EF"
    chmod 600 "$EF"
    if grep -qE "^ANTHROPIC_API_KEY=" "$EF"; then
      cur=$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$EF" | head -1)
      if [ "$cur" = "$K" ]; then echo unchanged; exit 0; fi
      tmp=$(mktemp)
      awk -v v="$K" 'BEGIN{FS=OFS="="} $1=="ANTHROPIC_API_KEY" {print "ANTHROPIC_API_KEY="v; next} {print}' "$EF" > "$tmp"
      cat "$tmp" > "$EF"
      rm -f "$tmp"
    else
      printf '%s=%s\n' ANTHROPIC_API_KEY "$K" >> "$EF"
    fi
    echo written
REMOTE_SH
  )
  case "$result" in
    written)   ok ".env: ANTHROPIC_API_KEY upserted" ;;
    unchanged) ok ".env: ANTHROPIC_API_KEY already matches — no change"; return 0 ;;
    *)         die "set_anthropic_key_in_env: unexpected result '$result'" ;;
  esac
  step "Restarting $NAME so the new env value takes effect"
  if remote "docker ps --filter name=^${NAME}\$ --format '{{.Names}}' | grep -q ."; then
    remote "docker restart '$NAME' >/dev/null"
    ok "container restarted"
  else
    warn "container '$NAME' not running — start it with: ./scripts/deploy.sh"
  fi
}

seed_caddyfile() {
  if remote "test -f '$STATE_DIR/Caddyfile'"; then return 0; fi
  if remote "test -f /home/kkrazy/myco/Caddyfile"; then
    remote "cp /home/kkrazy/myco/Caddyfile '$STATE_DIR/Caddyfile'"
    ok "Caddyfile seeded from /home/kkrazy/myco/Caddyfile"
  else
    remote_scp docker/Caddyfile "$REMOTE:$STATE_DIR/Caddyfile"
    ok "Caddyfile uploaded from project tree (docker/Caddyfile)"
  fi
}

print_dry_run_plan() {
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
}

stream_image() {
  if [ "$IS_LOCAL" = "1" ]; then
    step "Local mode — image already in the local docker daemon"
    ok "skipped save/load (image=$IMAGE)"
    return 0
  fi
  step "Streaming $IMAGE to $REMOTE"
  docker save "$IMAGE" | gzip -1 | remote "gunzip | docker load" >/dev/null
  ok "image loaded"
}

swap_container() {
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
}

# Pull the public hostname for the verify step out of, in order:
#   1. $STATE_DIR/.env's `MYCO_PUBLIC_ORIGIN=https://<host>[:port]`
#   2. $STATE_DIR/Caddyfile's first non-`{` virtual-host header
#      (a bare `<host> {` line).
#   3. "localhost" (last-ditch — will fail visibly under Caddy's
#      no-cert-for-localhost guard, but at least surfaces the actual
#      remote error in `verify_deploy`'s die() message).
#
# Runs through `remote` so it works in both local mode (bash -c)
# and remote-via-ssh mode. Echoes the bare hostname (no scheme,
# no path, no port stripped — keeps it pragmatic).
_derive_verify_domain() {
  local d
  d=$(remote "[ -r '$STATE_DIR/.env' ] && grep -E '^MYCO_PUBLIC_ORIGIN=' '$STATE_DIR/.env' | head -1 | sed -E 's|^MYCO_PUBLIC_ORIGIN=https?://||' | sed 's|/.*||'" 2>/dev/null | tr -d '\r\n')
  if [ -n "$d" ]; then echo "$d"; return; fi
  # Fallback: Caddyfile's first virtual host. Skip the global `{`
  # block at line 1 (the `servers { protocols … }` block has no
  # hostname on its opening line, just `{`).
  d=$(remote "[ -r '$STATE_DIR/Caddyfile' ] && awk '/^[A-Za-z0-9._:-]+ *\{$/{ sub(\" *\\\\{\$\",\"\",\$0); print; exit }' '$STATE_DIR/Caddyfile'" 2>/dev/null | tr -d '\r\n')
  if [ -n "$d" ]; then echo "$d"; return; fi
  echo "localhost"
}

verify_deploy() {
  step "Verifying"
  local domain expected_raw expected served
  # Pick the URL the verify step should hit:
  #
  # 1. Explicit MYCO_VERIFY_DOMAIN override always wins — useful for
  #    one-off targets / overlay testing.
  # 2. Remote-mode deploys (ssh user@host …): use the SSH host, since
  #    that's the public name by construction.
  # 3. Local-mode deploys (MYCO_DEPLOY_HOST=*@localhost — the mycobeta
  #    + myco on-host recipe): auto-derive from the public origin
  #    baked into the running container. Three lookup layers:
  #      a. $STATE_DIR/.env's `MYCO_PUBLIC_ORIGIN=https://<host>` —
  #         the established setting deploy.sh ships + warns about.
  #      b. $STATE_DIR/Caddyfile's first virtual-host header (the
  #         `<host> { … }` line) — survives the rare .env-but-no-
  #         Caddyfile drift.
  #      c. "localhost" — last-ditch. Caddy refuses requests for
  #         localhost (no cert) but `curl -k` still surfaces the
  #         actual error in the failure message.
  #    The previous default of "localhost" red-flipped on every
  #    on-host mycobeta deploy because Caddy 421s the request.
  if [ "$IS_LOCAL" = "1" ]; then
    if [ -n "${MYCO_VERIFY_DOMAIN:-}" ]; then
      domain="$MYCO_VERIFY_DOMAIN"
    else
      domain=$(_derive_verify_domain)
    fi
  else
    domain=$(echo "$REMOTE" | sed 's/.*@//')
  fi
  # Expose to post_deploy_checks so its HTTP probes hit the same host.
  RESOLVED_DOMAIN="$domain"
  # Read the freshly-baked build stamp from the running container.
  # This is the SAME value the server (src/index.js indexHtml())
  # URL-encodes into the served `?v=…` token; comparing against the
  # source index.html's `?v=N` placeholder would always fail because
  # the server rewrites it. The Dockerfile generates build.txt with
  # `date -u +%Y-%m-%dT%H:%M:%SZ` — colons are the only chars
  # encodeURIComponent transforms (→ %3A), so the URL-encoding step
  # below is exact (no other reserved chars in the ISO timestamp).
  expected_raw=$(remote "docker exec $NAME cat /app/web/public/build.txt" 2>/dev/null | tr -d '\r\n')
  [ -n "$expected_raw" ] || die "could not read build.txt from container '$NAME' — is the new image up?"
  expected=$(echo "$expected_raw" | sed 's/:/%3A/g')
  served=""
  for i in 1 2 3 4 5 6 7 8; do
    # `[^"'\''\s&<]+` matches the full encoded value (year, dashes,
    # `T`, `%3A`, digits, trailing `Z`) — the old `\d+` was greedy
    # only on the year prefix and silently mismatched everything
    # post-build-stamp rollout.
    #
    # The trailing `|| true` keeps the retry loop alive under
    # `set -euo pipefail` when curl|grep|head returns empty: grep's
    # exit 1 on no-match (Caddy→mycod 502 race in the first second
    # after container swap) would otherwise propagate via pipefail
    # and abort the script before any retry — exactly the silent
    # exit that 179da49's mycobeta+myco deploys hit.
    served=$(curl -sk --max-time 5 "https://$domain/" 2>/dev/null | grep -oP 'app\.js\?v=\K[^"'\''\s&<]+' | head -1 || true)
    [ -n "$served" ] && break
    sleep 2
  done
  [ -n "$served" ] || die "https://$domain/ not responding after redeploy"
  [ "$served" = "$expected" ] \
    && ok "https://$domain/ serving app.js?v=$served (matches build.txt $expected_raw)" \
    || die "version mismatch: served '$served', container build.txt '$expected_raw' (URL-encoded '$expected') — stale container or routing layer caching?"
}

# Post-deploy validation — observability for things verify_deploy
# doesn't cover (lean-ctx integration, auxiliary static routes).
# Advisory only: warnings never abort the deploy (it's already
# happened). Reports a final warning count so the operator knows
# whether to investigate.
#
# Checks (cheap + automated only — soaking tests like RSS-under-load
# or agent-actually-uses-ctx_read live in the manual playbook):
#   1. lean-ctx binary present + version (fr-55)
#   2. lean-ctx resolves on PATH inside the container (fr-55)
#   3. No lean-ctx startup errors in `docker logs` (fr-55)
#   4. /USER_MANUAL.md serves 200 (the sidebar book-icon route)
#   5. /vendor/codemirror.bundle.js serves 200 (fr-50 editor bundle)
#
# Skip with --skip-post-checks for tight deploy loops where the
# operator will run validation manually.
post_deploy_checks() {
  if [ "$SKIP_POST_CHECKS" = "1" ]; then
    printf "(skipping post-deploy validation — --skip-post-checks)\n"
    return 0
  fi
  step "Post-deploy validation"
  local warnings=0
  local domain="$RESOLVED_DOMAIN"

  # ── 1. lean-ctx binary version (fr-55) ──
  local lean_ctx_version
  lean_ctx_version=$(remote "docker exec $NAME lean-ctx --version 2>&1" 2>/dev/null | head -1 | tr -d '\r')
  if echo "$lean_ctx_version" | grep -qE '^lean-ctx [0-9]+\.[0-9]+'; then
    ok "lean-ctx: $lean_ctx_version"
  else
    warn "lean-ctx --version failed in container — fr-55 compression layer is NOT active. Got: '${lean_ctx_version:-<empty>}'. Check Dockerfile install + npm postinstall logs."
    warnings=$((warnings + 1))
  fi

  # ── 2. lean-ctx PATH resolution (fr-55) ──
  local lean_ctx_path
  lean_ctx_path=$(remote "docker exec $NAME which lean-ctx 2>/dev/null || true" 2>/dev/null | head -1 | tr -d '\r')
  if [ -n "$lean_ctx_path" ]; then
    ok "lean-ctx on PATH at: $lean_ctx_path"
  else
    warn "lean-ctx NOT on PATH inside container — the SDK's stdio MCP spawn (\`command: \"lean-ctx\"\`) will fail with ENOENT. Check the Dockerfile symlink to /usr/local/bin/lean-ctx."
    warnings=$((warnings + 1))
  fi

  # ── 3. No lean-ctx startup errors in container logs (fr-55) ──
  # Tail last 200 lines to scope to the current container's recent
  # startup; older runs are bind-mounted away by the container swap.
  local err_count
  err_count=$(remote "docker logs --tail 200 $NAME 2>&1 | grep -iE 'lean-ctx.*(failed|error|ENOENT|ECONNREFUSED|ETIMEDOUT)' | wc -l" 2>/dev/null | tr -d ' \r\n')
  if [ "${err_count:-0}" = "0" ]; then
    ok "no lean-ctx errors in container logs (last 200 lines)"
  else
    warn "found $err_count lean-ctx error line(s) in container logs — run: docker logs --tail 200 $NAME | grep -i lean-ctx"
    warnings=$((warnings + 1))
  fi

  # ── 4. /USER_MANUAL.md serves 200 (sidebar book icon) ──
  local manual_status
  manual_status=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://$domain/USER_MANUAL.md" 2>/dev/null || echo '???')
  if [ "$manual_status" = "200" ]; then
    ok "/USER_MANUAL.md serves 200"
  else
    warn "/USER_MANUAL.md returned HTTP $manual_status — the sidebar book icon will show 'Could not load the user manual'. Check the GET /USER_MANUAL.md route in server/src/index.js + Dockerfile COPY USER_MANUAL.md."
    warnings=$((warnings + 1))
  fi

  # ── 5. /vendor/codemirror.bundle.js serves 200 (fr-50 editor) ──
  local cm_status
  cm_status=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://$domain/vendor/codemirror.bundle.js" 2>/dev/null || echo '???')
  if [ "$cm_status" = "200" ]; then
    ok "/vendor/codemirror.bundle.js serves 200"
  else
    warn "/vendor/codemirror.bundle.js returned HTTP $cm_status — the in-app editor will fall back to textarea. Check that npm run build:editor ran + the bundle is checked in."
    warnings=$((warnings + 1))
  fi

  printf "\n"
  if [ "$warnings" -gt 0 ]; then
    printf "  ! %d post-deploy warning(s). Deploy succeeded; investigate above.\n" "$warnings" >&2
  else
    ok "all post-deploy checks passed"
  fi
}

# ─── main ────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"
  # NOTE: cwd is anchored to the repo root by the early `cd` near
  # line 46 (after td-33 moved this script into scripts/). The
  # previous `cd "$(dirname "$0")"` here was a leftover from when
  # deploy.sh lived at the repo root, where it was a no-op — after
  # the move it cd'd INTO scripts/, undoing the line-46 anchor and
  # breaking `docker build -f docker/Dockerfile .` plus the
  # `./test/test.sh` invocation. Don't reintroduce.

  # Single-shot config flags: do the operation and exit, no build/ship.
  if [ -n "$ADD_ALLOW" ]; then
    open_ssh
    allow_github_user "$ADD_ALLOW"
    exit 0
  fi
  if [ -n "$SET_OAUTH" ]; then
    open_ssh
    set_oauth_in_env "$SET_OAUTH"
    exit 0
  fi
  if [ -n "$SET_ANTHROPIC_KEY" ]; then
    open_ssh
    set_anthropic_key_in_env "$SET_ANTHROPIC_KEY"
    exit 0
  fi

  run_tests
  build_image
  open_ssh
  ensure_state_dir
  seed_caddyfile
  ensure_allowlist_seed
  warn_if_oauth_unset

  if [ "$DRY_RUN" = "1" ]; then
    print_dry_run_plan
    exit 0
  fi

  stream_image
  swap_container
  verify_deploy
  post_deploy_checks

  printf "\n✓ Deployed %s to %s (state: %s)\n" "$IMAGE" "$REMOTE" "$STATE_DIR"
}

main "$@"
