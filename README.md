# myco

A mobile-first web UI to monitor, control, and discuss Claude Code sessions running on your machine. Open it on your phone, laptop, or VS Code; multiple devices can attach to the same session, and you can chat with collaborators (and Claude itself) alongside the live terminal.

## Features

- **Live terminal in the browser** — xterm.js + WebSocket. WebGL renderer with a Canvas fallback. Custom keyboard bar tuned for Claude Code (`Esc`, `1/2/3`, `Enter`, double-tap-`Esc`).
- **Session lifecycle** — list, spawn, attach, delete. Spawning checks for an existing session in that cwd; deleting kills the pty but keeps Claude's transcript on disk so you can resume in the same directory later.
- **Resume across restarts** — server restart? On reconnect, mycod scans `~/.claude/projects/<cwd>/` and resumes the *newest* transcript, so `/clear` and `/resume` survive a restart.
- **Multi-device** — attach the same session from phone, laptop, and the VS Code terminal at the same time. Browser tabs auto-reattach on visibility change with a ping/pong liveness probe; the page reloads back into your last-active session.
- **Discussion pane** — collaborator chat per session, persisted to disk. Two ways to engage Claude from chat: type any message and it's forwarded to the running Claude session as a normal user turn (works for owner and read-only viewers — `@user` mentions stay in-chat, no forward), or prefix with `/btw …` to spawn a fresh `claude -p` in the session's cwd and post the reply back to the chat.
- **Share links** — read-only, time-limited URLs to show a session to someone without giving them the auth token.
- **VS Code integration** — a one-tap "open in VS Code" action drops a `.vscode/tasks.json` into the session's cwd that auto-runs `myco attach <id>` in a Remote-SSH terminal on folder open.
- **Auth + TLS** — optional bearer-token auth (single-user or per-user), HTTPS with auto-redirect from `:80`, and a Let's Encrypt installer script.
- **Server-log panel** — recent `mycod` log lines streamed to the UI. Useful when something goes sideways from a phone.

## Requirements

- **macOS or Linux** (POSIX paths, systemd recommended on Linux).
- **Node.js 18+**.
- **Claude Code CLI** installed and on `PATH` as `claude`.
- *(Optional)* `ANTHROPIC_API_KEY` — only needed if you don't have a `claude.ai` subscription configured for the `claude` CLI. The discussion pane and AI session-summary feature both run via `claude -p`, which inherits whatever auth the CLI is set up with.

## Install

```bash
git clone <repo-url> myco
cd myco/server
npm install
```

## Run (dev)

```bash
# from the project root
./mycod
```

Or directly:

```bash
cd server
MYCO_WORKSPACE=$HOME/projects npm start
```

Without TLS, the server binds to `127.0.0.1:3000` by default (set `HOST=0.0.0.0` to expose on the LAN). Open `http://localhost:3000` (or `http://<lan-ip>:3000` from another device on the same network).

## Run (production, HTTPS)

Set the TLS env vars and the server switches to HTTPS on `:443` plus an HTTP→HTTPS redirect on `:80`:

```bash
TLS_CERT_PATH=/path/to/fullchain.pem \
TLS_KEY_PATH=/path/to/privkey.pem  \
MYCO_TOKEN=$(openssl rand -hex 16) \
MYCO_WORKSPACE=$HOME/projects \
./mycod
```

Sample `myco.service` is included; copy to `/etc/systemd/system/`, edit paths, then `sudo systemctl enable --now myco`. The unit grants `CAP_NET_BIND_SERVICE` so it can bind `:80`/`:443` as a non-root user.

The repo also includes `install-tls.sh` (one-shot Let's Encrypt issuance via `certbot --standalone`) and `install-renewal-hook.sh` (pre/deploy/post hooks so renewals copy the new cert into `.tls/` and restart `myco` automatically).

## Configuration

| Var                  | Default                  | Purpose                                                                      |
|----------------------|--------------------------|------------------------------------------------------------------------------|
| `MYCO_WORKSPACE`     | `$HOME`                  | Root for spawnable sessions; new sessions can't escape this directory.       |
| `MYCO_STATE_DIR`     | `~/.myco`                | Where the session store lives (`store.json`).                                |
| `MYCO_TOKEN`         | *(unset)*                | Single bearer token; everyone authenticates as user `default`.               |
| `MYCO_TOKENS`        | *(unset)*                | Multi-user: `alice:tok1,bob:tok2`. Each user sees only their own sessions.   |
| `MYCO_VSCODE_HOST`   | *(unset)*                | SSH host for VS Code Remote-SSH "open folder" links (e.g. `kkrazy@myhost`).  |
| `TLS_CERT_PATH`      | *(unset)*                | Path to fullchain. If both TLS vars are set, `mycod` switches to HTTPS.      |
| `TLS_KEY_PATH`       | *(unset)*                | Path to private key.                                                         |
| `PORT`               | `3000` (HTTP) / `443` (TLS) | Main listen port.                                                            |
| `HOST`               | `127.0.0.1` (HTTP) / `0.0.0.0` (TLS) | Bind address.                                                                |
| `HTTP_REDIRECT_PORT` | `0` (HTTP) / `80` (TLS)  | Plain-HTTP listener that 301-redirects to HTTPS.                             |
| `ANTHROPIC_API_KEY`  | *(unset)*                | Used by `summarizer.js` for AI-generated session titles. Optional.           |

If neither `MYCO_TOKEN` nor `MYCO_TOKENS` is set, auth is disabled — anyone who can reach the port can spawn sessions. **Don't expose an unauthenticated mycod to the public internet.**

## CLI

The bundled `myco` script is a thin client over the same WebSocket the web UI uses, so you can attach to a running session from a regular shell:

```bash
./myco attach myco-default-abcd1234
# detach: Ctrl-] then q
```

It reuses `server/node_modules` for its `ws` dependency — no separate `npm install`.

## Discussion pane / chat routing / `/btw`

The discussion pane is per-session and persists in the on-disk store. Other people viewing the same session see the same chat history.

How chat routes:

- **Any message** — forwarded to the running Claude session as a normal user turn (the AgentSession's streaming-input queue). Works from owner and read-only viewer chat alike — chat is the collaborative steering channel for the session.
- **`@user …`** at the head — recognized as a discussion mention to a known collaborator. Stamped + persisted as chat-only; NOT forwarded to Claude.
- **`/btw <text>`** — spawns a fresh `claude -p` in the session's cwd, with the last ~20 chat messages and last ~40 lines of ANSI-stripped scrollback as context, and posts the reply into the chat. Doesn't touch the running session. Inherits `process.env` and the user's `~/.claude/` config, so whatever auth (API key or `claude.ai` subscription) the main session uses works here too.
- **`/task`, `/skip N`, `/cancel N`** — task-list intervention. Forwarded to Claude as a natural-language directive (see `CLAUDE.md` task-list etiquette). The agent replies with the list / dismissal confirmation.

Plain text (no `@user` prefix) reaches Claude — there's no separate "talk to claude" prefix any more. Use `@user` if you want a note to stay in chat.

## Architecture

See [architecture.md](./architecture.md). Two notes on what's changed since that doc:

- The session backend is direct `node-pty`, not `tmux` over SSH. One mycod process owns the pty for each running session; tmux is no longer required.
- Stage-2 hooks haven't shipped; AI summaries are generated by polling Claude's transcript files instead.

## Troubleshooting

**"unauthorized" loop** — check the token in the URL or in the prompt matches `MYCO_TOKEN` (or one of the entries in `MYCO_TOKENS`). After changing tokens, all open browsers need to re-enter the new one.

**Sessions don't restore after `mycod` restart** — `store.json` lives in `MYCO_STATE_DIR` (default `~/.myco`). If that directory is gone, sessions are gone. The `claude` transcripts under `~/.claude/projects/<cwd>/` are still there; mycod auto-imports those at startup so you can re-attach.

**Claude in the discussion pane just echoes errors** — make sure `claude` works headlessly: `claude -p "hi"` in the session's cwd should print a reply. If it asks for auth, run `claude /login` once as the systemd `User=` (e.g. `sudo -u kkrazy claude`).

**`posix_spawnp failed`** — `node-pty`'s `spawn-helper` lost its executable bit during `npm install`. The `postinstall` script reapplies it; if it persists:

```bash
chmod +x server/node_modules/node-pty/prebuilds/*/spawn-helper
```

**Phone can't reach the server** — verify both devices are on the same network (or that you're using the public DNS name behind TLS), and check the firewall (macOS: System Settings → Network → Firewall → allow `node`; Linux: `ufw status`).

**Browser warns about TLS** — the bundled `install-tls.sh` issues a Let's Encrypt cert. If you're using a self-signed cert during development, you'll get warnings until you swap it.
