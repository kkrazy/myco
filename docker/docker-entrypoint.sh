#!/bin/sh
set -e

DATA="${MYCO_DATA:-/data}"
ENV_FILE="$DATA/.env"
CADDY_DATA="$DATA/caddy"

mkdir -p "$CADDY_DATA"

# Seed /root with shell config from stock /etc/skel if empty (first run)
if [ ! -f /root/.profile ]; then
    cp /etc/skel/.profile /root/ 2>/dev/null || true
fi

# Migrate data from old layout (pre-mount) if /root is missing claude config
if [ ! -f /root/.claude.json ] && [ -f "$DATA/.claude.json" ]; then
    cp "$DATA/.claude.json" /root/.claude.json
fi
if [ ! -d /root/.claude ] && [ -d "$DATA/.claude" ]; then
    cp -a "$DATA/.claude" /root/.claude
fi
if [ ! -d /root/.local ] && [ -d "$DATA/.local" ]; then
    cp -a "$DATA/.local" /root/.local
fi

export PATH="/root/.local/bin:$PATH"

# Load .env if it exists
if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi

export MYCO_WORKSPACE="/wks"
export MYCO_STATE_DIR="$DATA"
export XDG_DATA_HOME="$DATA"

# Enterprise proxy configuration — OPT-IN, off by default.
#
# Public-cloud hosts (mycobeta, prod, opti) need direct internet access
# to api.anthropic.com, github.com, etc. Hard-coding a private-RFC1918
# proxy as the default fallback (the prior behaviour) broke every
# cloud deploy with ConnectionRefused since the proxy host was
# unreachable from public IPs.
#
# To enable, set BOTH in $STATE_DIR/.env (or via `docker run -e`):
#
#   MYCO_ENTERPRISE_PROXY=1
#   MYCO_ENTERPRISE_PROXY_URL=http://user:pass@proxy-host:port
#
# Optional fine-tuning (defaults shown):
#   MYCO_ENTERPRISE_NO_PROXY="127.0.0.1,localhost,local,.local"
#   MYCO_ENTERPRISE_TLS_INSECURE=1   # disables Node + git TLS verification
#                                    # (only needed when the proxy injects
#                                    # its own self-signed cert chain)
#
# No proxy URL is hard-coded — credentials should live in the state-dir
# .env file (mode 0600, not committed), not in source.
if [ "${MYCO_ENTERPRISE_PROXY:-0}" = "1" ]; then
    if [ -z "${MYCO_ENTERPRISE_PROXY_URL}" ] && [ -z "${http_proxy}" ]; then
        echo "[entrypoint] MYCO_ENTERPRISE_PROXY=1 but no MYCO_ENTERPRISE_PROXY_URL or http_proxy set — proxy stack NOT applied" >&2
    else
        PROXY_URL="${MYCO_ENTERPRISE_PROXY_URL:-$http_proxy}"
        export http_proxy="${http_proxy:-$PROXY_URL}"
        export https_proxy="${https_proxy:-$PROXY_URL}"
        export no_proxy="${no_proxy:-${MYCO_ENTERPRISE_NO_PROXY:-127.0.0.1,localhost,local,.local}}"
        # global-agent: explicit proxy URL (needed for bootstrap to pick it up)
        export GLOBAL_AGENT_HTTP_PROXY="${GLOBAL_AGENT_HTTP_PROXY:-${http_proxy}}"

        # TLS-insecure mode: only when the proxy injects its own cert chain.
        # Disables Node TLS verification globally + git SSL verification.
        # Off by default — opt in via MYCO_ENTERPRISE_TLS_INSECURE=1.
        if [ "${MYCO_ENTERPRISE_TLS_INSECURE:-0}" = "1" ]; then
            export NODE_TLS_REJECT_UNAUTHORIZED="0"
            export GIT_SSL_NO_VERIFY="1"
            git config --global http.sslverify false 2>/dev/null || true
        fi

        # Configure git to use proxy
        git config --global http.proxy "${http_proxy}" 2>/dev/null || true
        git config --global https.proxy "${https_proxy}" 2>/dev/null || true

        # Rewrite SSH URLs to HTTPS so they go through the HTTP proxy
        # git@github.com:owner/repo.git → https://github.com/owner/repo.git
        git config --global url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
        git config --global url."https://gitlab.com/".insteadOf "git@gitlab.com:" 2>/dev/null || true
        git config --global url."https://gitee.com/".insteadOf "git@gitee.com:" 2>/dev/null || true

        echo "[entrypoint] enterprise proxy enabled via $http_proxy (TLS-insecure: ${MYCO_ENTERPRISE_TLS_INSECURE:-0})" >&2
    fi
else
    # Cloud-host default: explicitly clear any inherited empty proxy vars
    # (the Dockerfile sets `ENV http_proxy=` from a passed-through build
    # ARG; clear it so no client misinterprets the empty string).
    unset http_proxy https_proxy no_proxy
    unset HTTP_PROXY HTTPS_PROXY NO_PROXY
    unset GLOBAL_AGENT_HTTP_PROXY GLOBAL_AGENT_HTTPS_PROXY
    unset NODE_TLS_REJECT_UNAUTHORIZED GIT_SSL_NO_VERIFY

    # ALSO clean any stale BARE-KEY git proxy/sslverify/insteadOf entries
    # from /root/.gitconfig (bind-mounted from $STATE_DIR/home — survives
    # container swaps). Older entrypoints wrote these unconditionally;
    # without this cleanup, a host that USED to opt in keeps a poisoned
    # gitconfig forever.
    #
    # IMPORTANT: only unset BARE keys (http.proxy, https.proxy). Per-URL
    # entries like `http.<gitee.com>.proxy` are deliberate routes (e.g.
    # the prod-side Gitee SSH tunnel at 172.17.0.1:8888) and MUST be
    # preserved. `git config --unset` with a bare key does NOT touch
    # subsection-scoped keys, so this is safe.
    git config --global --unset http.proxy 2>/dev/null || true
    git config --global --unset https.proxy 2>/dev/null || true
    git config --global --unset http.sslverify 2>/dev/null || true
    git config --global --unset url."https://github.com/".insteadOf 2>/dev/null || true
    git config --global --unset url."https://gitlab.com/".insteadOf 2>/dev/null || true
    git config --global --unset url."https://gitee.com/".insteadOf 2>/dev/null || true
fi

# Start Caddy in background
caddy run --config /etc/caddy/Caddyfile &

# Start myco app
exec node server/src/index.js
