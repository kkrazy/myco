# Mycelium — Claude Code Instructions

## Working in this repo

1. **Always prefer existing scripts over ad-hoc commands.** Before composing a one-off shell sequence, look for a script that already does the job (`./test.sh`, `./test-browser.sh`, `./deploy.sh`, `./install-tls.sh`, etc.). If one exists, run it. If one almost exists, extend it rather than copy-pasting its logic into a new chat-only command. This keeps behaviour reproducible and the CI/dev paths in sync.

## Pre-Commit

1. **Always run `./test.sh` before committing.** Fix any failures before proceeding with the commit.

2. **Every new feature must come with a test.** When you add a behaviour to `server/`, `web/public/`, the Dockerfile, or any deploy/runtime path, also add a check to `./test.sh` that would have caught the bug if the feature regressed. Static-only behaviour can usually be a `grep` or a `node -e` check; runtime behaviour belongs in the persistence/server-smoke section that runs the real container. Aim for the smallest test that fails meaningfully if the feature breaks. Bug fixes also count as features — write the regression test before (or alongside) the fix so it red-green-flips.

## Deployment

1. **Always deploy via `./deploy.sh`.** It builds the Docker image locally, streams it over SSH to `myco.labxnow.ai`, and swaps the container against a single bind-mounted state directory. Do not push raw source or `systemctl restart` on the remote.

2. **Single-state-dir layout** (the deploy.sh contract):
   - One host directory holds *all* persistent state. Default: `MYCO_STATE_DIR=/home/kkrazy/myco-state` (override with the env var).
   - Container bind-mounts:
     ```
     $MYCO_STATE_DIR        → /data    (sessions.json, .env, caddy/, …)
     $MYCO_STATE_DIR/home   → /root    (claude config: .claude/, .claude.json)
     $MYCO_STATE_DIR/wks    → /wks     (workspaces)
     $MYCO_STATE_DIR/Caddyfile → /etc/caddy/Caddyfile  (read-only)
     ```
   - No named or anonymous Docker volumes — everything is reachable from the host. Backup = tar the state dir; restore = untar and `docker run`.
   - First-time deploys onto a host that previously used Docker volumes are auto-migrated by `deploy.sh` (one-shot `cp` from each old volume into the matching state-dir subdir, only if the target is empty).
   - The Caddyfile lives in the state dir too — `deploy.sh` seeds it from `/home/kkrazy/myco/Caddyfile` (remote) or the project tree (local) on first deploy.

3. **Override knobs:** `MYCO_DEPLOY_HOST`, `MYCO_STATE_DIR`, `MYCO_IMAGE_TAG`, `MYCO_CONTAINER`. `--skip-tests` skips `./test.sh`, `--dry-run` reports the plan without shipping or swapping.

## Troubleshooting

1. **`[connecting...] / [reconnecting...]` loop in the terminal pane, no `/attach/` requests in `docker logs myco`** — the browser is failing the WSS handshake before it reaches the server. Verify the server is fine first by hitting it from a different network: `curl -sk -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://myco.labxnow.ai/attach/<session-id>"` should return `101 Switching Protocols` and stream output. If it does, the user's network/firewall is dropping or stripping WS upgrade traffic — common culprits: corporate firewalls/DPI, VPN clients, antivirus that proxies HTTPS, browser extensions, or a stale `alt-svc: h3=":443"` cached by the browser pointing at HTTP/3 (which doesn't support WebSocket — clear via `chrome://net-internals/#alt-svc` or test in incognito). Disabling HTTP/3 in `Caddyfile` (`servers { protocols h1 h2 }`) is the quick remediation.

## Code Style

1. **Break functionality into small functions with one clear responsibility.** Aim for fewer than ~80 lines per function. If a function is doing setup + work + teardown, or covers more than one concept, split it. Name each function for what it does (`build_image`, `seed_caddyfile`, `test_persist_after_restart`) — the call site should read like prose. Top-level orchestration belongs in a `main()` (or equivalent) that just sequences the named steps. This keeps diffs reviewable and makes scripts/code easy to extend without rewriting the world.

## Design Guidelines

1. **Always use Mermaid diagrams** for any architecture, flow, sequence, or state diagrams. Never use ASCII art boxes or plain-text diagrams.
