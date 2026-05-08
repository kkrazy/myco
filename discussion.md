# myco — Session Discussion Log

This file summarizes the work done across Claude Code sessions on the myco project, from May 6–8, 2026. It's meant to be committed and loaded later for context.

## Project overview

myco is a mobile-first web UI to monitor, control, and discuss Claude Code sessions running on a host. One `mycod` process owns the pty for each running `claude` session; multiple viewers (phone, laptop, VS Code) attach over WebSocket.

---

## Session 1 — TLS, auto-attach, multi-device independence (May 6–7)

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

## Session 2 — WS liveness probe, Esc redraw fix, discussion pane (May 7)

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

## Session 3 — Docs, deployment (May 7–8)

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

## Open items / future work

- **Multi-device viewport independence** — the last-resize-wins issue is still present. Option 1 (max-of-attached sizing) was implemented and reverted in session 1. Needs re-implementation when ready.
- **DNS cut-over for 47.103.62.251** — `myco.labxnow.ai` still points to 13.220.25.82. Repoint to 47.103.62.251 and Caddy will auto-provision TLS.
- **Claude CLI auth on 47.103.62.251** — `claude -p` hasn't been tested on that host yet. Needs `claude /login` or `ANTHROPIC_API_KEY` in `.env` for the discussion pane assistant to work.
- **Periodic cert renewal on original server** — `install-renewal-hook.sh` was installed but the dry-run failed (port 80 conflict). Pre/post hooks were added to stop/start mycod around renewal. Should re-run `install-renewal-hook.sh` to validate.
