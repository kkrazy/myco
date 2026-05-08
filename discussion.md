# myco — Session Discussion Log

This file summarizes all Claude Code sessions that touched the myco project, from April 28 to May 8, 2026. It's meant to be committed and loaded later for context.

## Project overview

myco is a mobile-first web UI to monitor, control, and discuss Claude Code sessions running on a host. One `mycod` process owns the pty for each running `claude` session; multiple viewers (phone, laptop, VS Code) attach over WebSocket.

---

## Pre-history — Initial build (April 28, 2026)

The myco project was created before any of the sessions documented here. The initial codebase included: Express + ws server, node-pty spawning, xterm.js terminal rendering, a card-based session list UI, and the custom mobile keyboard with Esc/Esc-Esc/1-3/Enter. This was built in one or more early sessions whose transcripts are not available in the current project directories.

---

## Session A — Performance, share links, VS Code, card descriptions (Apr 29–30, 2026)
Session ID: `99025f4e` in `-wks-default-Myco/` (~2.3MB)

The user reported slow scrolling in the mobile web UI. Diagnosed the default xterm.js DOM renderer as the bottleneck; added WebGL rendering with a Canvas fallback, plus express.static mounts for the xterm addon modules. Deployed on port 3001 for testing.

Added custom JS touch-scroll handler with EWMA velocity tracking and requestAnimationFrame momentum (replacing native `-webkit-overflow-scrolling`). Sensitivity was tuned for mobile. Added a styled delete button on session cards (red gradient, pop animation). Fixed the send button to defer the Enter keystroke by 60ms so Claude's TUI doesn't interpret the burst as a paste. Added auto-hide of the soft keyboard on scroll.

Built the share-link feature: time-limited read-only URLs via `POST /sessions/:id/share` that let someone view a session without the auth token. Built the "open in VS Code" feature using `vscode://vscode-remote/` URLs, initially with local path issues, then adjusted to use Remote-SSH connections. Added `POST /sessions/:id/vscode-prep` to write a `.vscode/tasks.json` that auto-runs `myco attach <id>` on folder open.

Fixed card descriptions to show the assistant's last response (not the user's first prompt) by modifying `summarizeRecentContext` in `sessions.js` to walk backwards through the transcript preferring assistant text blocks.

Files changed: `app.js`, `styles.css`, `keyboard.js`, `index.html`, `sessions.js`, `index.js` (server).

---

## Session B — Systemd service, security review, keyboard fixes, WS reconnect (Apr 30 – May 7, 2026)
Session ID: `1ff60e57` in `-wks-kkrazy-myco/` (~640KB) and `11194a71` in `-home-kkrazy-myco/` (~1MB)

The user asked to convert `start.sh` into a systemd service. Created `myco.service` with `EnvironmentFile` pointing to `.env`. Initially ran as root, which broke because `os.homedir()` returned `/root` instead of `/home/kkrazy`, so it couldn't find `~/.myco/sessions.json` or `~/.claude/projects/`. Fixed by adding `User=kkrazy` and `Group=kkrazy`.

Performed a comprehensive security audit identifying 12 issues: auth tokens in WebSocket URL query strings, full parent environment leaked to child PTY processes, port 3000 bound on all interfaces, tokens in localStorage, no rate limiting, `.env` not in `.gitignore`, session IDs leaking usernames. Fixes applied: rebound server to `127.0.0.1`, added `.env` to `.gitignore`, whitelisted environment variables passed to child PTY processes.

Fixed keyboard bugs: input text was wiped when toggling between native and custom key modes. Added `_pendingInput` preservation across re-renders and auto-minimize keyboard after sending. Later fixed a related bug where switching modes via hotkeys (Esc, 1/2/3) also cleared input.

Implemented WebSocket auto-reconnect for both the main session and share-viewer connections with exponential backoff (1s initial, 15s max, resets on success). Git commit was blocked initially by missing `user.name`/`user.email` config.

Attempted multi-device viewport independence (same session rendering independently on mobile, browser, VS Code) but hit an API error and was not completed.

---

## Session C — VS Code CLI, vscode-prep endpoint (May 6, 2026)
Session ID: `045ed935` in `-wks-kkrazy-myco/` (~446KB)

The user asked about the remote server hostname stored in the VS Code share button, then requested that it default to `kkrazy@<hostname>` with the machine's SSH key. Also requested that opening a VS Code session automatically bring up a terminal and attach to the live Claude session.

Built the `myco` CLI tool at `cli/index.js` — a headless WebSocket client that connects to the same `/attach/<id>` endpoint the web UI uses, renders in the terminal with raw stdin/stdout, and detaches via `Ctrl-] q`. Added a shell launcher script at the repo root (`myco`). Added `POST /sessions/:id/vscode-prep` to drop a `.vscode/tasks.json` with `runOn: folderOpen` into the session's working directory. Updated the frontend to call `vscode-prep` before opening the `vscode://vscode-remote/` URL.

Files changed: `cli/index.js` (new), `myco` launcher (new), `server/src/index.js`, `web/public/app.js`.

---

## Session D — Port 80 conflict, Caddy coexistence (May 6, 2026)
Session IDs: `b0c8b3a3` (~52KB) and `f71b1ff9` (~88KB) in `-home-kkrazy-myco/`

Two short sessions dealing with the same issue. The user asked to change myco to listen on port 80. The service file was updated with `PORT=80` and `AmbientCapabilities=CAP_NET_BIND_SERVICE`, but mycod crashed with `EADDRINUSE` because Caddy was already bound to port 80. Claude read the Caddyfile and found it was configured to reverse-proxy `myco.labxnow.ai` to `localhost:3000`. The resolution was to revert myco back to `PORT=3000` and let Caddy handle ports 80/443 with TLS termination, proxying to myco on 3000.

---

## Session E — Git push, SSL diagnosis, TLS in-process (May 6–8, 2026)
Session IDs: `52ceb54a` (~900KB) and `05da4cd4` (~192KB) in `-home-kkrazy-myco/`

The user asked to push code to `https://github.com/kkrazy/myco`. No git remote was configured; added origin and pushed main. Then committed a large batch of uncommitted changes (11 files, ~1200 lines) including auth improvements, log capture, session summarizer, share tokens, WebSocket ping/pong, WebglAddon support, and updated `.gitignore`.

Later the user reported `ERR_SSL_PROTOCOL_ERROR` when accessing `13.220.25.82`. Diagnosis: the Node app was HTTP-only on `127.0.0.1:3000`, while Caddy held ports 80/443 proxying `myco.labxnow.ai` to localhost:3000. This session led to adding native TLS support to the Node server (`TLS_CERT_PATH`/`TLS_KEY_PATH` env vars, `https.createServer` when set, HTTP→HTTPS redirect on `:80`), plus switching the remote URL from HTTPS to SSH (`git@github.com:kkrazy/myco.git`).

---

## Session F — TLS, auto-attach, multi-device independence (May 6–7)

### TLS certificate for myco.labxnow.ai
- The original `.tls/cert.pem` was self-signed (`CN=13.220.25.82`). Browsers showed "unsafe" warnings.
- Wrote `install-tls.sh` — stops mycod, runs `certbot --standalone -d myco.labxnow.ai`, copies `fullchain.pem`/`privkey.pem` into `.tls/` with correct ownership, restarts mycod. Ran successfully; issuer is now Let's Encrypt R12.
- Wrote `install-renewal-hook.sh` — installs certbot pre/deploy/post hooks: pre stops myco (frees :80 for ACME), deploy copies renewed cert into `.tls/`, post restarts myco regardless of outcome. Includes a `--dry-run` validation. First attempt failed because mycod was on :80; added pre/post hooks to fix.

### Last-session auto-attach
- On page load, the app showed an empty terminal — user had to tap a session card every time. After a mycod restart or browser refresh, you'd land on nothing.
- Client now persists `myco_active_id` to localStorage on every `openSession(id)`. On `init()`, prefers the persisted id if it still exists in the session list, falling back to `mostRecentSession()` (picks the session with the latest `last_activity || created_at`).
- Deleting the active session clears `myco_active_id`.

### Resume newest transcript (not the first one)
- After a mycod restart, `ensureLiveSession` was using `rec.claudeSessionId` — a value cached once at spawn and never updated. If you `/clear` or `/resume` inside Claude, the active transcript changes, but the server still resumed the original. You'd land on the first transcript.
- Fix: `ensureLiveSession` is now async; on attach it scans `~/.claude/projects/<encoded-cwd>/*.jsonl` and picks the newest by mtime as the `--resume` target. Falls back to `rec.claudeSessionId` only if the scan finds nothing.

### Multi-device viewport independence (discussed, not merged)
- Identified root cause: all viewers share one pty; each client sends `{t:"resize", cols, rows}` and the last writer wins — a phone attaching shrinks the laptop's render.
- Proposed three options: (1) max-of-attached sizing, (2) tmux per-client, (3) per-viewer `claude --resume`. Recommended option 1 (track per-client viewports, resize pty to `max(cols)` and `max(rows)`).
- User asked to discard this change. Implementation was reverted.

---

## Session G — WS liveness probe, Esc redraw fix, discussion pane (May 7)

### WebSocket liveness probe
- Mobile browsers can suspend a backgrounded tab and let the WS go silently dead — the client thinks it's still OPEN, but bytes stop flowing. On foreground, the terminal appears frozen.
- Server now handles `{t:"ping"}` from any client (including share-link viewers) by replying `{t:"pong"}`.
- Client probes on `visibilitychange → visible`, `focus`, and `pageshow`. Also probes every 15s while the tab is visible (periodic `setInterval`, gated on `document.visibilityState`). If no pong within 2s, closes the WS — the existing reconnect loop picks it up with exponential backoff (resets to 1s on success).
- Detection budget: mobile background → foreground ~3s; foreground silent death ~17s.

### Esc force-redraw
- After hitting Esc (e.g. dismissing Claude's autocomplete), the bottom portion of the viewport sometimes showed stale glyphs. Affects both mobile and desktop.
- Client now detects bare `\x1b` or `\x1b\x1b` in `sendInput` and triggers a delayed (80ms) row toggle: sends `resize(cols, rows-1)` then `resize(cols, rows)` 32ms apart. The two SIGWINCHes force Claude's TUI to repaint the full viewport.

### Discussion pane
- Added a per-session chat pane alongside the terminal. On desktop (>900px), both are visible; on mobile, the chat pane and the session sidebar are mutually exclusive (showing one hides the other).
- Chat history persists in `store.json` per session, capped at 200 messages. On WS attach, server replays history via `{t:"chat-history", messages}`. Live messages broadcast via `{t:"chat", message}` to all attached viewers.
- Auth user identity is passed through the WS upgrade handler so messages are attributed correctly. Read-only share-link viewers can read but not post.
- Claude is a participant: messages ending in `?`, mentioning `@claude`, or starting with `/btw` spawn `claude -p` in the session's cwd, inheriting `process.env`. Context: last 20 chat messages + last 40 lines of ANSI-stripped terminal scrollback. Replies attributed to user `claude`.
- Files added: `server/src/btw.js`, chat CSS in `styles.css`, chat HTML in `index.html`, chat state/render in `app.js`, `getChatHistory`/`appendChatMessage` in `sessions.js`, chat broadcast in `pty.js`.

---

## Session H — Docs, deployment (May 7–8)

### README and architecture.md rewrite
- Both docs were written against the original SSH-to-tmux design. Rewrote from scratch to match the shipped codebase: in-process node-pty, bearer-token auth, in-process TLS, share links, VS Code integration, discussion pane, resume-newest-transcript.
- README now has: features list, split dev/prod run instructions, full env var table (11 vars), CLI section, discussion-pane section, refreshed troubleshooting.
- Architecture now has: accurate component table with line counts, store.json shape, WS protocol spec with chat messages, mermaid sequence diagrams for attach/discussion/spawn, operational notes on liveness and per-session chat.

### Deployment to 47.103.62.251
- Target: Ubuntu 24.04 on WSL2, 23GB RAM, 1TB disk.
- Installed Node.js 22 via nodesource, Claude Code CLI v2.1.132 globally.
- Cloned repo via HTTPS, `npm install` in `server/`.
- Configured `.env` with same auth tokens (`MYCO_TOKENS`), `MYCO_WORKSPACE=/wks`, `HOST=0.0.0.0`.
- Installed Caddy v2.11.2. Caddyfile: `myco.labxnow.ai { reverse_proxy localhost:3000 }`. Caddy handles auto-TLS via Let's Encrypt once DNS points to this host.
- DNS for `myco.labxnow.ai` currently points to the original server (13.220.25.82). Needs to be repointed to 47.103.62.251 for Caddy's ACME challenge to succeed.
- Systemd unit installed and active (`myco.service`).

### Docker image (done outside this session, commit 4d061d4)
- Alpine-based Dockerfile with Caddy + Claude Code, single `/data` volume.
- Entry point creates `/wks` symlink, migrates legacy `.jsonl` transcripts to directory-based sessions.
- `POST /auth/reload` endpoint for hot-reloading tokens without restart.
- Share-mode viewers can now type and use chat.
- Share tokens persisted in localStorage; shared sessions appear in home screen with badge.

---

## Session I — Remote deployment to 47.103.62.251 (May 8, 2026)
Session ID: `b493bd79` in `-home-kkrazy-myco/` (~1.4MB)

Deployed myco to a second server (Alibaba Cloud, Ubuntu 24.04 on WSL2, 23GB RAM, 1TB disk, user `ken`, SSH port 19988). Installed Node.js 22 via nodesource and Claude Code CLI v2.1.132 globally. Cloned repo via HTTPS, ran `npm install` in `server/`. Configured `.env` with same auth tokens, `MYCO_WORKSPACE=/wks`, `HOST=0.0.0.0`. Wrote systemd unit (`/etc/systemd/system/myco.service`) with `ExecStart=/usr/bin/node server/src/index.js`, `CAP_NET_BIND_SERVICE`. Installed Caddy v2.11.2 with Caddyfile `myco.labxnow.ai { reverse_proxy localhost:3000 }`. Caddy will auto-provision Let's Encrypt TLS once DNS is repointed. Also ran `install-tls.sh` and `install-renewal-hook.sh` on the original server (`13.220.25.82`) to fix cert renewal hooks (pre/post hooks to stop/start mycod around ACME challenge).

---

## Session J — Chat assistant test (May 7, 2026)
Session ID: `d975f062` in `-wks-kkrazy-myco/` (~14KB)

A single-exchange session triggered by the discussion pane's `@claude` feature. The user asked "what's this project about?" in the chat. Claude, running as a `claude -p` subprocess spawned by `btw.js`, responded with a concise description of the myco project. This validated that the chat assistant integration was working end-to-end. No files changed.

---

## Open items / future work

- **Multi-device viewport independence** — the last-resize-wins issue is still present. Option 1 (max-of-attached sizing) was implemented and reverted in session 1. Needs re-implementation when ready.
- **DNS cut-over for 47.103.62.251** — `myco.labxnow.ai` still points to 13.220.25.82. Repoint to 47.103.62.251 and Caddy will auto-provision TLS.
- **Claude CLI auth on 47.103.62.251** — `claude -p` hasn't been tested on that host yet. Needs `claude /login` or `ANTHROPIC_API_KEY` in `.env` for the discussion pane assistant to work.
- **Periodic cert renewal on original server** — `install-renewal-hook.sh` was installed but the dry-run failed (port 80 conflict). Pre/post hooks were added to stop/start mycod around renewal. Should re-run `install-renewal-hook.sh` to validate.
