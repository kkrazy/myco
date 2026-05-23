# myco — Cheat Sheet

Shared work surface for humans + autonomous agents on the same project.

## Start

1. Sign in at `https://myco.labxnow.ai` (invite-only · PAT, OAuth coming)
2. **+ New session** → chat opens → type to steer the agent

Spawn as many sessions as you want — each is an independent agent on the same workspace.

## Roles

| Role | Acquired by | Can do |
|---|---|---|
| **Owner** | Spawning | Everything |
| **Admin** | `/admin <login>` | Everything except delete / grant admin |
| **Guest** | Share link / non-allowlisted | `@mention`, file plan items, read-only inspect |

## Git — `/git <args>`  *(owner/admin)*

Full pass-through to the `git` CLI in the session workspace.

```
/git status
/git log --oneline -10
/git diff HEAD~3
/git fetch origin
/git commit -m "fix: bug X"
/git clone https://github.com/owner/public-repo
```

| | |
|---|---|
| **Cwd** | session workspace |
| **Timeout / caps** | 60 s · 1 MB stdout · 16 KB stderr |
| **Credentials** | `GIT_TERMINAL_PROMPT=0` — fails fast (no hang) |
| **Quoting** | shlex-style: `"..."`, `'...'`, `\"`, `\\` |
| **Private repos** | embed PAT in URL → `https://x-access-token:<PAT>@github.com/...` · OR `/setpat <token>` first |
| **`--global` caveat** | mutates container `$HOME` → affects ALL sessions. Not blocked, but prefer project-scoped `git config` |

## Plan — `/td` `/fr` `/bug`

Items live in `_myco_/plan.json` (git-tracked) → `git clone` = full onboarding. Humans + agents both contribute.

```
/td bump node in dockerfile
/fr add dark-mode toggle
/bug load-older loops past page 5
/bug! <text>                   ← agent rewrites into Problem/Expected/Actual
```

Per-item: 👍 vote · 💬 comment · ✎ edit (owner/admin) · ▶ Run (Fix/Implement/Do) · Close/Reopen. Run → queue → agent works → `run-summary` comment posted back.

## Run queue

| Command | Effect |
|---|---|
| `/queue fr-43 bug-21` | Add to queue (auto-dispatches if idle) |
| `/qstatus` | Print current state (guest-allowed) |
| `/qcancel <id>` | Remove entry; auto-advances if it was the running head |
| `/qresume` | Unpause after auto-pause-on-failure |
| `/qclear` | Drop every pending |

Auto-pauses on failure so a stuck pattern doesn't cascade.

## What's next — `/next`  *(or `/whatsnext`)*

Ranked top-10 open items. Heuristic: voters × 3 · comments (cap 5) × 1 · Bug 2 / Feature 1 / Todo 0.5 · fresh < 7d +2 · stale > 90d −0.5 · last-run failed/aborted −1.5. + LLM rerank. Cached 2h. Append `force` to regenerate now.

Each row shows score + layer + snippet + WHY it ranked there.

## Files + editor — 📁

Tree → click any text file. Owner/admin sees **✎ Edit** in the header.

| | |
|---|---|
| **Editor** | CodeMirror 6 (highlight · line nums · search · fold · oneDark) |
| **Save / Cancel** | Cmd/Ctrl+S · Esc |
| **Conflict modal (409)** | ↻ Reload from disk · ⚠ Force overwrite · ✕ Cancel |

Concurrent-safe via mtime check; edits never silently lost.

## Chat

| | |
|---|---|
| Plain text | → the agent |
| `@user` | discussion (not the agent) |
| `@all` | broadcast ping |
| `/cmd` | slash command |
| **Stop** (red ■) | interrupts in-flight turn |
| **Permission modal** | Allow once / always / Deny |

## Slash commands (full)

**Guest-allowed**: `/help` · `/me` · `/whoami` · `/td` `/fr` `/bug` · `/task` `/tasks` `/skip` `/cancel` · `/allowlist` · `/qstatus` · `/whatsnext` `/next`

**Owner/admin**: `/admin` · `/git` · `/queue` `/qcancel` `/qclear` `/qresume` · `/btw` (side-channel) · `/feature` `/bug` (GitHub issue) · `/setpat <token>`

## Sharing

Mint a share link from the session menu → read-only viewer attach. Sees live chat + tool calls + plan + files. Can `@mention` + file plan items. Can't drive the agent or edit files. Presence chips in the header show who's attached.

## Cross-device + multi-session

Phone ↔ laptop in seconds. Lossless reconnect after network blips (only the missed window streams back). Chat history persists indefinitely (100k cap per session). Spawn multiple sessions in the sidebar; switch with one tap.

## Mobile (≤900px)

Sidebar + chat are mutually exclusive (overlay). Back icon ☰ toggles. Re-tapping the same session card restores chat.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connecting…/reconnecting…` loop | Try incognito (clears HTTP/3 `alt-svc`) — WSS being stripped by firewall/VPN |
| "Not invited yet" | Ask host to add your GitHub login to `allowed-github-users.txt` |
| `/feature` "no token" | Sign out + in (refresh `repo` scope) OR `/setpat <token>` |
| ✎ Edit hidden | Hard-refresh (cached `app.js`); confirm you're not in viewer mode |
| Queue stalls | `/qcancel <id>` to drop the stuck head + auto-advance |
| Chat input blocked (red ring) | Guest-restricted text — use `@mention` or a guest-allowed slash command |
| `/git` returns "no such command" on prod | Pre-fr-54 deploy. Wait for the next `./scripts/deploy.sh` |

## Reporting

`/bug <description>` or `/fr <description>` → lands in `_myco_/plan.json` → ranked by `/next` → shipped via run-queue. Indefinite shared memory; new teammates inherit on `git clone`.
