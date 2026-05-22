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

# Proxy configuration for corporate networks
# These can be overridden by setting env vars at container start
export http_proxy="${http_proxy:-http://p_atlas:proxy%40123@172.18.100.92:8080}"
export https_proxy="${https_proxy:-http://p_atlas:proxy%40123@172.18.100.92:8080}"
export no_proxy="${no_proxy:-127.0.0.1,.huawei.com,localhost,local,.local}"
export GIT_SSL_NO_VERIFY="${GIT_SSL_NO_VERIFY:-1}"

# Configure git to use proxy
git config --global http.proxy "${http_proxy}" 2>/dev/null || true
git config --global https.proxy "${https_proxy}" 2>/dev/null || true
git config --global http.sslverify false 2>/dev/null || true

# Start Caddy in background
caddy run --config /etc/caddy/Caddyfile &

# Start myco app
exec node server/src/index.js
