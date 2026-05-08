#!/bin/sh
set -e

DATA="${MYCO_DATA:-/data}"
WKS="$DATA/wks"
ENV_FILE="$DATA/.env"
CADDY_DATA="$DATA/caddy"

mkdir -p "$WKS" "$CADDY_DATA"

# Symlink /wks → /data/wks so migrated transcript cwds (/wks/...) resolve
if [ ! -e /wks ]; then
    ln -s "$WKS" /wks
fi

# Load .env if it exists
if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
fi

export MYCO_WORKSPACE="/wks"
export MYCO_STATE_DIR="$DATA"
export XDG_DATA_HOME="$CADDY_DATA/.."

# Symlink ~/.claude to /data/.claude so transcripts are persisted in the data volume
mkdir -p "$DATA/.claude"
if [ ! -L "$HOME/.claude" ]; then
    rm -rf "$HOME/.claude" 2>/dev/null
    ln -s "$DATA/.claude" "$HOME/.claude"
fi

# Persist ~/.local for claude-code native install
mkdir -p "$DATA/.local/bin" "$DATA/.local/share"
if [ ! -L "$HOME/.local" ]; then
    rm -rf "$HOME/.local" 2>/dev/null
    ln -s "$DATA/.local" "$HOME/.local"
fi
export PATH="$HOME/.local/bin:$PATH"

# Migrate legacy .jsonl transcripts to directory-based sessions (claude >= 2.1)
for jsonl in $(find "$DATA/.claude/projects" -name "*.jsonl" 2>/dev/null); do
    dir="${jsonl%.jsonl}"
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        mv "$jsonl" "$dir/transcript.jsonl"
    fi
done

# Start Caddy in background
caddy run --config /etc/caddy/Caddyfile &

# Start myco app
exec node server/src/index.js
