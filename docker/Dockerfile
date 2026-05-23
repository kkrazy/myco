# --- Build stage: install npm deps + claude ---
FROM node:20-alpine AS builder
WORKDIR /build
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# --- Runtime stage ---
FROM node:20-alpine

RUN apk add --no-cache bash git openssh ca-certificates curl nss-tools && \
    # Caddy: pick the right arch automatically so the image builds for
    # both amd64 (myco.labxnow.ai prod) and arm64 (Apple Silicon dev,
    # ARM cloud VMs). Was hardcoded `arch=amd64` — fr-55 enhancement.
    ARCH=$(uname -m) && case "$ARCH" in \
      x86_64)  CADDY_ARCH=amd64 ;; \
      aarch64) CADDY_ARCH=arm64 ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=$CADDY_ARCH" -o /usr/bin/caddy && \
    chmod +x /usr/bin/caddy && \
    mkdir -p /usr/share/fonts/truetype && \
    curl -fsSL "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.3.0/JetBrainsMono.tar.xz" | tar -xJ -C /usr/share/fonts/truetype

# fr-55: install lean-ctx (MCP server that compresses file reads /
# shell output before they hit the LLM context). The npm wrapper's
# postinstall.js auto-picks the right binary for the build arch
# (x86_64 or aarch64 × musl/gnu), so this works for both amd64 and
# arm64 builds without extra glue. Symlink into /usr/local/bin so
# the Anthropic Agent SDK can spawn it via stdio MCP at query time.
RUN npm install -g lean-ctx-bin && \
    ln -sf "$(npm root -g)/lean-ctx-bin/bin/lean-ctx" /usr/local/bin/lean-ctx && \
    /usr/local/bin/lean-ctx --version

WORKDIR /app

COPY --from=builder /build/node_modules ./server/node_modules
COPY --from=builder /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code
COPY --from=builder /usr/local/bin/claude /usr/local/bin/claude
COPY server/src ./server/src
COPY web/public ./web/public
# User manual served by the in-app book-icon modal. Lives at the
# project root for git/docs visibility; copied into /app/ so the
# server's GET /USER_MANUAL.md route can read it from inside the
# container.
COPY USER_MANUAL.md ./USER_MANUAL.md
COPY docker/Caddyfile /etc/caddy/Caddyfile
RUN mkdir -p /app/web/public/fonts && \
    cp /usr/share/fonts/truetype/JetBrainsMonoNerdFont-Regular.ttf /app/web/public/fonts/ && \
    cp /usr/share/fonts/truetype/JetBrainsMonoNerdFont-Bold.ttf /app/web/public/fonts/ 2>/dev/null; true

COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Build timestamp — UI fetches /build.txt and shows it in the status bar.
# Always re-runs (date is unique each build) but the layer is cheap.
RUN date -u +%Y-%m-%dT%H:%M:%SZ > /app/web/public/build.txt

ENV MYCO_DATA=/data \
    HOST=127.0.0.1 \
    PORT=3000 \
    SHELL=/bin/bash

EXPOSE 80 443

VOLUME ["/data", "/root", "/wks"]

ENTRYPOINT ["/docker-entrypoint.sh"]
