# --- Build stage: install npm deps + claude ---
# base: node:26-alpine (2026-11-02) — the @anthropic-ai/claude-agent-sdk 0.3.142
# is ESM-only (main: sdk.mjs); Node 20.18.1 cannot require() it, which broke the
# agent on every WS attach ("require() of ES Module ... not supported", blank
# chat). Node 26 has require(esm) on by default. delm-23 worked only because it
# happened to be built on node 20.20.2. Tag from SWR:
#   swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:26-alpine-linuxarm64
FROM node:26-alpine AS builder
WORKDIR /build
# Proxy support: Docker build should pass --build-arg http_proxy/https_proxy
ARG http_proxy
ARG https_proxy
ARG no_proxy
ENV http_proxy=$http_proxy https_proxy=$https_proxy no_proxy=$no_proxy
COPY server/package.json server/package-lock.json* ./
RUN npm config set proxy "$http_proxy" && \
    npm config set https-proxy "$https_proxy" && \
    npm config set strict-ssl false && \
    npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force
# node:26 ships npm 11, which blocks postinstall scripts by default — that
# skips claude-code's `install.cjs` (downloads the native binary) and leaves
# the CLI broken. --allow-scripts re-enables it for this package only.
RUN npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code && npm cache clean --force

# --- Runtime stage ---
FROM node:26-alpine

# Proxy support: Docker build should pass --build-arg http_proxy/https_proxy
ARG http_proxy
ARG https_proxy
ARG no_proxy
ENV http_proxy=$http_proxy https_proxy=$https_proxy no_proxy=$no_proxy

# c7 (harness2-integration §2): .myco_harness/scripts/*.py is the
# per-session helper-script surface, and the project's guidance tells the
# agent to run them with `python3`. Without an interpreter in the image
# that surface is dead on arrival (verified on the test host: exit 127,
# "python3: not found" — the agent fell back to awk). ~50 MB.
# (2026-11-02) This step goes through the flaky enterprise proxy and was seen
# to stall indefinitely on the LAST few py3 packages (0 CPU for ~1h — the
# socket waits forever). `--timeout` aborts a no-progress connection; the loop
# retries up to 5x instead of hanging the whole cold build.
RUN set -e; ok=0; \
    for i in 1 2 3 4 5; do \
      if apk add --no-cache --timeout 30 bash git openssh ca-certificates curl nss-tools python3; then ok=1; break; fi; \
      echo "apk add attempt $i failed, retrying in 5s"; sleep 5; \
    done; \
    [ "$ok" = 1 ] || { echo "apk add failed after 5 attempts" >&2; exit 1; }; \
    mkdir -p /usr/share/fonts/truetype

# Caddy + JetBrainsMono nerd-fonts are COPYed from build-assets/ (pre-fetched
# on the build host) instead of curl'd at build time. The HIS enterprise
# proxy drops large external downloads inside the buildkit sandbox (curl exit
# 56 on the 47MB caddy / hangs), while the same curl on the host succeeds, so
# we vendor the binaries into build-assets/ and COPY them in. This makes the
# build network-free for these steps. NOTE: build-assets/caddy +
# build-assets/lean-ctx are arm64 builds (this repo's deploy targets — incl.
# 7.242.106.110 — are all aarch64); amd64 (myco.labxnow.ai prod) would need
# amd64 variants staged under build-assets/. build-assets/ is gitignored.
COPY build-assets/caddy /usr/bin/caddy
COPY build-assets/JetBrainsMono.tar.xz /tmp/fonts.tar.xz
RUN chmod +x /usr/bin/caddy && \
    tar -xJf /tmp/fonts.tar.xz -C /usr/share/fonts/truetype && \
    rm /tmp/fonts.tar.xz

# lean-ctx (MCP server that compresses file reads / shell output before they
# hit the LLM context). Same as caddy: vendored in build-assets/ and COPYed in
# instead of curl'd, because the build-time proxy drops the download. The
# arch-neutral name lets scripts/deploy-local.sh stage the right build
# (aarch64 or x86_64) under build-assets/lean-ctx.tar.gz regardless of host.
# See that script for the per-arch download URL. Version pinned 3.6.14 to match.
COPY build-assets/lean-ctx.tar.gz /tmp/lean-ctx.tar.gz
RUN mkdir -p /usr/local/lib/lean-ctx && \
    tar -xz -C /usr/local/lib/lean-ctx -f /tmp/lean-ctx.tar.gz && \
    chmod +x /usr/local/lib/lean-ctx/lean-ctx && \
    ln -sf /usr/local/lib/lean-ctx/lean-ctx /usr/local/bin/lean-ctx && \
    rm /tmp/lean-ctx.tar.gz && \
    /usr/local/bin/lean-ctx --version

WORKDIR /app

COPY --from=builder /build/node_modules ./server/node_modules
COPY --from=builder /usr/local/lib/node_modules/@anthropic-ai/claude-code /usr/local/lib/node_modules/@anthropic-ai/claude-code
COPY --from=builder /usr/local/bin/claude /usr/local/bin/claude
COPY server/src ./server/src
COPY web/public ./web/public
# bug-81: ship the scripts/ dir so docker-entrypoint.sh can register
# scripts/git-credential-myco.sh as the global git credential.helper.
# Without this, the entrypoint logs a "credential helper missing"
# warning at boot and git push falls back to the broken-by-design
# interactive prompt → "could not read Username" → push fails.
COPY scripts ./scripts
RUN chmod +x /app/scripts/*.sh 2>/dev/null || true
# User manual served by the in-app book-icon modal. Lives at the
# project root for git/docs visibility; copied into /app/ so the
# server's GET /USER_MANUAL.md route can read it from inside the
# container.
COPY USER_MANUAL.md ./USER_MANUAL.md
# docs/whatsnew — served by GET /whatsnew (server/src/index.js WHATSNEW_DIR
# resolves to /app/docs/whatsnew). Without this COPY the endpoint returns
# available:false and the "功能上新" banner never shows.
COPY docs ./docs
# P2 (harness2-in-myco-plan §5): the tuning loop runs as a child process of
# mycod, so harness2 and its runner must live INSIDE the image — a host
# install would be invisible to the container.
#
# harness2 is vendored under vendor/ rather than pulled at build time: the
# build host has no internet (only an internal MITM proxy), and a pinned copy
# is what makes a rebuild reproducible. Its runtime dependencies are empty
# (pyproject `dependencies = []`) and the core imports only the stdlib, so
# there is no `pip install` step and no proxy involved.
COPY vendor/harness2 ./vendor/harness2
COPY bench/harness2 ./bench/harness2
# PYTHONPATH lets `python3 -m harness2.cli.run_sweep` resolve from any cwd;
# the runner spawns with an absolute path, so it needs no PATH entry.
ENV PYTHONPATH=/app/vendor/harness2
# Fail the build, not the first rollout, if the vendored copy cannot import or
# has drifted from the package layout the substrate imports from.
RUN python3 -c "import harness2, harness2.cli.run_sweep, harness2.substrate.myco;     print('harness2 vendored ok:', harness2.__file__)"
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
