# myco — User Manual

A shared work surface where humans + autonomous agents collaborate on the same project. Open it on phone or laptop; spawn agent sessions; file plan items; watch the agent work; share with collaborators.

## Quick start

1. Sign in with GitHub at `https://myco.labxnow.ai` (invitation-only).
2. **+ New session** in the sidebar → an agent session spawns → type into the chat to steer it.

Spawn as many sessions as you need — each is an independent agent against the same project workspace. The sidebar is your parallel-work cockpit.

## Roles

- **Owner** — full control (you spawned it).
- **Admin** — granted via `/admin <login>`. Same as owner minus delete + admin grants.
- **Guest** (share-link / non-allowlisted) — read + `@mention` + file plan items. Send button auto-disables for blocked input.

## Plan = the team's backlog

Items live in `_myco_/plan.json`, git-tracked, so a `git clone` is the entire onboarding step — new teammates inherit the full backlog. Humans and agents both contribute: humans file via slash commands, agents post run-summaries after every dispatched run.

```
/td bump node in dockerfile           Todo
/fr add dark-mode toggle              Feature
/bug load-older loops past page 5     Bug
/bug! <text>                          ask the agent to rewrite into Problem/Expected/Actual
```

Each item supports: 👍 vote · 💬 comment · ✎ edit (owner/admin) · ▶ Run (label varies: Fix/Implement/Do) · Close/Reopen. Run queues the dispatch — when the agent finishes, a `meta.kind:run-summary` comment lands back on the item with cost, duration, and the final assistant text.

## Run queue (sequential dispatch)

Drop multiple items in; agent walks through them one at a time. Auto-pauses on failure so a stuck pattern doesn't cascade.

| Command | What |
|---|---|
| `/queue fr-43 bug-21` | Add to queue (auto-dispatches if idle) |
| `/qstatus` | Print current state (guest-allowed) |
| `/qcancel <id>` | Remove entry; auto-advances if it was the running head |
| `/qresume` | Unpause after auto-pause-on-failure |
| `/qclear` | Drop every pending |

## What's next — `/next` (or `/whatsnext`)

Ranked list of open items so the team doesn't re-derive priorities every session. Heuristic (voters ×3, comments capped at 5, Bug>Feature>Todo, fresh +2 / stale −0.5, last-run failure −1.5) + LLM rerank. Cached 2h in `plan.whatsNext`. Append `force` to regenerate now.

Each row shows score + layer + snippet + the heuristic reasons — so you can tell *why* an item ranks where it does.

## Files + editor

📁 chrome icon → tree → click any text file. Owner/admin sees **✎ Edit** in the file viewer header. Click to open CodeMirror 6 (syntax highlight, line numbers, search, fold, oneDark). **Cmd/Ctrl+S** save · **Esc** cancel.

**Concurrent-edit safe**: every save sends the mtime you opened the file at. If the file changed on disk (a teammate, another agent session, anything else), a 409 conflict modal offers **↻ Reload** / **⚠ Force overwrite** / **✕ Cancel**. Your edits are never silently lost.

## Chat

- Plain text → the agent. `@user` → discussion (not the agent). `@all` → broadcast ping to everyone attached. `/cmd` → slash command.
- **Stop button** (red square in header) — interrupts in-flight turn; type to continue.
- **Permission modal** appears when the agent wants a tool. Pick **Allow once / always / Deny**.

## Slash commands (full)

**Guest-allowed**: `/help` · `/me` · `/whoami` · `/td` `/fr` `/bug` · `/task` `/tasks` `/skip` `/cancel` · `/allowlist` · `/qstatus` · `/whatsnext` `/next`

**Owner/admin only**: `/admin` · `/queue` `/qcancel` `/qclear` `/qresume` · `/btw` (side-channel one-shot question — doesn't touch the main session) · `/feature` `/bug` (open GitHub issue) · `/setpat <token>` (per-repo PAT)

## Sharing

Mint a share link from the session menu — anyone with the URL (no sign-in needed) attaches as a read-only viewer. They see live chat + tool calls + plan + files, can `@mention` and file plan items, can't drive the agent or edit files. Presence chips in the header show who's attached.

## Cross-device + multi-session

Type on your phone, see it on your laptop seconds later. Brief network blips trigger lossless reconnect — only the missed window streams back. Chat history is persisted indefinitely (100k message cap per session, effectively unbounded). Run multiple sessions in parallel by spawning more from the sidebar; switch between them with one tap.

## Mobile (≤900px)

Sidebar + chat are mutually exclusive (overlay). Back icon ☰ toggles. Re-tapping the same session card restores the chat pane.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connecting…/reconnecting…` loop | Try incognito (clears HTTP/3 `alt-svc`); WSS is being stripped by firewall/VPN |
| "Not invited yet" | Ask host to add your GitHub login to `allowed-github-users.txt` |
| `/feature` "no token" | Sign out + in (refreshes `repo` scope) OR `/setpat <token>` |
| ✎ Edit hidden | Hard-refresh (cached `app.js`); check you're not in viewer mode |
| Queue stalls | `/qcancel <id>` to drop stuck head + auto-advance |
| Chat input blocked (red ring) | Guest-restricted text; use `@mention` or guest-allowed slash command |

## Reporting

`/bug <description>` or `/fr <description>` — lands in `_myco_/plan.json`, gets ranked by `/next`, shipped via the run-queue. The team gets indefinite shared memory of every reported problem; new teammates inherit it the moment they clone the project.
