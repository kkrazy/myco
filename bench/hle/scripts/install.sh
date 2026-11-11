#!/usr/bin/env bash
# Install the node dependencies (@anthropic-ai/claude-agent-sdk + zod) that
# myco's reused engine modules require, into bench/hle/node_modules.
#
# Override the proxy with HLE_PROXY if the default enterprise proxy is not
# reachable (e.g. HLE_PROXY="http://p_atlas:proxy%40123@10.170.22.41:8080").
set -euo pipefail
HLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HLE_ROOT"

export http_proxy="${HLE_PROXY:-http://p_atlas:proxy%40123@10.195.176.39:8081}"
export https_proxy="$http_proxy"
export no_proxy="${no_proxy:-127.0.0.1,localhost,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}"

echo "[hle-install] installing @anthropic-ai/claude-agent-sdk + zod into $HLE_ROOT/node_modules"
npm install --no-audit --no-fund

echo "[hle-install] verifying SDK loads:"
NODE_PATH="$PWD/node_modules" node -e "require('@anthropic-ai/claude-agent-sdk'); console.log('claude-agent-sdk OK')"
