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
# cloud deploy with ConnectionRefused since the proxy host
# (172.18.100.92) is unreachable from public IPs.
#
# Set MYCO_ENTERPRISE_PROXY=1 in $STATE_DIR/.env (or pass via
# `docker run -e`) to enable the proxy stack. You can also override
# the URL via MYCO_ENTERPRISE_PROXY_URL=<full-url> in the same .env;
# otherwise we fall back to the historical Huawei p_atlas default
# (kept here so single-flag toggle is enough on the original network).
if [ "${MYCO_ENTERPRISE_PROXY:-0}" = "1" ]; then
    DEFAULT_PROXY="${MYCO_ENTERPRISE_PROXY_URL:-http://p_atlas:proxy%40123@172.18.100.92:8080}"
    export http_proxy="${http_proxy:-$DEFAULT_PROXY}"
    export https_proxy="${https_proxy:-$DEFAULT_PROXY}"
    export no_proxy="${no_proxy:-127.0.0.1,.huawei.com,localhost,local,.local}"
    export GIT_SSL_NO_VERIFY="${GIT_SSL_NO_VERIFY:-1}"
    # Node.js: trust self-signed proxy certificates (required for corporate proxies)
    export NODE_TLS_REJECT_UNAUTHORIZED="${NODE_TLS_REJECT_UNAUTHORIZED:-0}"
    # global-agent: explicit proxy URL (needed for bootstrap to pick it up)
    export GLOBAL_AGENT_HTTP_PROXY="${GLOBAL_AGENT_HTTP_PROXY:-${http_proxy}}"

    # Configure git to use proxy
    git config --global http.proxy "${http_proxy}" 2>/dev/null || true
    git config --global https.proxy "${https_proxy}" 2>/dev/null || true
    git config --global http.sslverify false 2>/dev/null || true

    # Rewrite SSH URLs to HTTPS so they go through the HTTP proxy
    # git@github.com:owner/repo.git → https://github.com/owner/repo.git
    git config --global url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
    git config --global url."https://gitlab.com/".insteadOf "git@gitlab.com:" 2>/dev/null || true
    git config --global url."https://gitee.com/".insteadOf "git@gitee.com:" 2>/dev/null || true
else
    # Cloud-host default: explicitly clear any inherited empty proxy vars
    # (the Dockerfile sets `ENV http_proxy=` from a passed-through build
    # ARG; clear it so no client misinterprets the empty string).
    unset http_proxy https_proxy no_proxy
    unset HTTP_PROXY HTTPS_PROXY NO_PROXY
    unset GLOBAL_AGENT_HTTP_PROXY GLOBAL_AGENT_HTTPS_PROXY
    unset NODE_TLS_REJECT_UNAUTHORIZED GIT_SSL_NO_VERIFY
fi

# Start Caddy in background
caddy run --config /etc/caddy/Caddyfile &

# Start myco app
exec node server/src/index.js
