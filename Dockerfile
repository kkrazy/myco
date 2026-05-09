# --- Build stage: install npm deps + claude ---
FROM node:20-alpine AS builder
WORKDIR /build
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# --- Runtime stage ---
FROM node:20-alpine

RUN apk add --no-cache bash git openssh ca-certificates curl nss-tools && \
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64" -o /usr/bin/caddy && \
    chmod +x /usr/bin/caddy && \
    mkdir -p /usr/share/fonts/truetype && \
    curl -fsSL "https://github.com/ryanoasis/nerd-fonts/releases/download/v3.3.0/JetBrainsMono.tar.xz" | tar -xJ -C /usr/share/fonts/truetype

WORKDIR /app

COPY --from=builder /build/node_modules ./server/node_modules
COPY --from=builder /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code
COPY --from=builder /usr/local/bin/claude /usr/local/bin/claude
COPY server/src ./server/src
COPY web/public ./web/public
COPY Caddyfile /etc/caddy/Caddyfile
RUN mkdir -p /app/web/public/fonts && \
    cp /usr/share/fonts/truetype/JetBrainsMonoNerdFont-Regular.ttf /app/web/public/fonts/ && \
    cp /usr/share/fonts/truetype/JetBrainsMonoNerdFont-Bold.ttf /app/web/public/fonts/ 2>/dev/null; true

COPY docker-entrypoint.sh /docker-entrypoint.sh
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
