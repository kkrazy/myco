# myco — Cheat Sheet

Shared work surface for humans + autonomous agents on the same project.

**+ New session** in the sidebar → chat opens → type to steer the agent.

## Git — `/git <args>`  *(owner/admin)*

**Clone a repo to get started.** Every session is a fresh workspace —
bring code in first. Full pass-through to the `git` CLI.

```
/git clone https://github.com/owner/repo
/git status
/git log --oneline -10
/git diff HEAD~3
/git fetch origin
/git commit -m "fix: bug X"
```

Caps 60 s · 1 MB stdout · 16 KB stderr · `GIT_TERMINAL_PROMPT=0` (fails fast). Private repos: embed PAT in URL `https://x-access-token:<PAT>@github.com/...` or `/setpat <token>` first. `--global` mutates container `$HOME` (affects ALL sessions) — prefer project-scoped `git config`.

## Plan — `/td` `/fr` `/bug`

Items live in `_myco_/plan.json` (git-tracked) → `git clone` = full onboarding.

```
/td bump node in dockerfile
/fr add dark-mode toggle
/bug load-older loops past page 5
/bug! <text>                   ← agent rewrites into Problem/Expected/Actual
/fr @myco add dark-mode toggle ← files an issue on github.com/kkrazy/myco (uses your PAT)
/fr @myco --as labxnow ...     ← picks the `labxnow` PAT alias (multi-account via /setpat --as)
```

**Multi-account / switch PATs (fr-82):** stash multiple PATs per target under named aliases and pick which one to use per command.
- `/setpat @<target> [--as <alias>] <token>` — store (with optional alias)
- `/fr @<target> [--as <alias>] <text>` — use (omit `--as` to use the default un-aliased PAT, or fall back to your GitHub OAuth login)
- `/listpat [@<target>]` — show which aliases are stored


Per-item: vote · comment · edit · ▶ Run (Fix/Implement/Do) · Close/Reopen · delete. Items with optional `analysis` / `implPlan` fields render collapsible Analysis / Implementation-plan accordions.

## Changed files (Plan footer)

Scroll past the plan items. Drag the top strip to resize.

- **Mentions / Recent** rows — bug/fr/td tokens from diff + last 5 commit subjects
- **+N −M chip** per file (lines added / removed)
- **Click a row** — inline-expand the diff with per-language syntax highlight
- **Click any `+` / context line** — per-line comment to the AI (Esc cancels)
- **✓ Accept** = `git add <file>` · **✕ Reject** = revert tracked / DELETE untracked (confirms)
- **Accept all / Reject all** — header bulk buttons

## Chat + roles

| | |
|---|---|
| Plain text | → the agent |
| `@user` / `@all` | discussion (not the agent) |
| `/cmd` | slash command |
| **Stop** (red ■) | interrupts in-flight turn |
| **Permission modal** | Allow once / always / Deny |
| **↑ / ↓** at input edge | recall previous messages (this session) |

Roles — **Owner** (spawner) · **Admin** (`/admin <login>`) · **Guest** (share link / non-allowlisted; `@mention` + file plan items only).

## Run queue

`/queue fr-43 bug-21` adds + auto-dispatches if idle. `/qstatus` · `/qcancel <id>` · `/qclear` · `/qresume` after auto-pause-on-failure. `/next` ranks top-10 open items (LLM rerank, cached 2h).

## Files + editor

Tree → click any text file. **✎ Edit** in the header (owner/admin) opens CodeMirror 6 with highlight / line nums / search / fold. Cmd/Ctrl+S to save · Esc to cancel. Mtime check prevents silent overwrites.

## Sharing · cross-device · mobile

Mint a share link from the session menu → read-only viewer (sees live chat + tools + plan + files; can `@mention` + file plan items). Phone ↔ laptop in seconds; lossless reconnect after network blips. Mobile (≤900px): sidebar + chat are mutually exclusive overlays — back icon ☰ toggles.

## Slash commands (reference)

**Guest**: `/help` · `/me` · `/whoami` · `/td` `/fr` `/bug` · `/task` `/skip` `/cancel` · `/allowlist` · `/qstatus` · `/whatsnext` `/next`

**Owner/admin**: `/admin` · `/git` · `/queue` `/qcancel` `/qclear` `/qresume` · `/btw` · `/feature` `/bug` (GitHub issue) · `/setpat <token>`

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connecting…/reconnecting…` loop | Try incognito (clears HTTP/3 `alt-svc`) — WSS being stripped by firewall/VPN |
| "Not invited yet" | Ask host to add your GitHub login to `allowed-github-users.txt` |
| `/feature` "no token" | Sign out + in OR `/setpat <token>` |
| ✎ Edit hidden | Hard-refresh; confirm not in viewer mode |
| Queue stalls | `/qcancel <id>` |
| Chat input red ring | Guest-restricted text — use `@mention` |
