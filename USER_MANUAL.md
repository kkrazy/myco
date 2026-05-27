# myco — Getting Started

A shared workspace where you and an AI coding agent work on the same
project, together. You talk to it like a teammate; it edits files,
runs commands, files issues, and ships PRs.

## 1. Sign in

Click **Sign in with GitHub**. First-time users need to be on the
project's invite list — ask whoever sent you the link to add your
GitHub login if you see "Not invited yet".

## 2. Open your first session

Click **+ New session** in the left sidebar. A session is one
isolated workspace — its own folder, its own chat history, its own
plan. Type a friendly label (optional) and confirm.

## 3. Bring code in — `/git clone`

Every session starts empty. The most common first command:

```
/git clone https://github.com/owner/repo
```

That's it — the agent now sees the code and can read, edit, and
commit. Other `/git` commands work the same way:

```
/git status
/git log --oneline -10
/git diff HEAD~3
/git commit -m "fix: bug X"
```

Private repos: use `/setpat <token>` once to store a personal access
token, then `/git clone` works without inline credentials.

## 4. Talk to the agent

Just type. The agent reads your message, plans, then acts — editing
files, running tests, asking permission before anything destructive.

| You type | What happens |
|---|---|
| **Plain text** | The agent picks it up and works on it |
| `@user` / `@all` | Message a teammate (the agent ignores it) |
| `/cmd` | Run a slash command |
| **Stop** (red ■) | Interrupt the agent mid-turn |
| **Permission modal** | Allow once / Allow always / Deny |
| **↑ / ↓** at line start | Recall your previous messages |

## 5. File work as you go — `/td`, `/fr`, `/bug`

Keep work-in-progress in the **Plan** tab. Items live in
`_myco_/plan.json` (git-tracked), so they travel with the repo.

```
/td   bump node version in dockerfile
/fr   add a dark-mode toggle
/bug  load-older button loops past page 5
/bug! <text>                    ← agent rewrites into Problem/Expected/Actual format
/fr @myco add dark-mode toggle  ← files the issue on github.com/kkrazy/myco
```

Per item: vote · comment · edit · **▶ Run** (the agent picks it up
and works on it) · Close/Reopen · delete.

## 6. Plan view — what's around the items

Scroll past the plan items for **Changed files** (the diff for any
work the agent did this session):

- **+N −M** per file (lines added / removed)
- **Click a row** to inline-expand the diff with syntax highlight
- **Click any `+` line** to drop a per-line comment for the agent
- **✓ Accept** stages the file · **✕ Reject** reverts it
- **Accept all / Reject all** in the header for bulk ops

## 7. Files tab — browse + edit

Click any text file to view it. **✎ Edit** opens an in-browser
editor with syntax highlight, line numbers, search, and fold.
Cmd/Ctrl-S to save, Esc to cancel.

## 8. Run queue

When the agent is working on a Plan item and you want to queue more:

```
/queue fr-43 bug-21       ← add to queue, auto-dispatches if idle
/qstatus                  ← see what's running
/qcancel <id>             ← drop a queued item
/next                     ← agent ranks the top 10 open items for you
```

## 9. Share + mobile

From the session menu, mint a **share link** — anyone with the link
gets a read-only view (live chat, tools, plan, files; they can
`@mention` and file plan items but can't drive the agent).

Same link works on phone and laptop — switch devices any time, the
chat history is the same.

## Slash commands — quick reference

**Anyone**: `/help` · `/me` · `/whoami` · `/td` `/fr` `/bug` ·
`/task` · `/qstatus` · `/next`

**Owner / admin**: `/admin <login>` · `/git <args>` · `/queue`
`/qcancel` `/qclear` `/qresume` · `/setpat <token>`

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chat keeps showing `connecting…` | Try an incognito window — usually a stale browser cache or a firewall stripping WebSockets |
| "Not invited yet" on sign-in | Ask the host to add your GitHub login to the invite list |
| `/fr @<repo>` says "no token" | Sign out and back in, OR run `/setpat <token>` |
| ✎ Edit button missing | Hard-refresh the page; only owners and admins can edit |
| Queue isn't moving | `/qcancel <id>` to drop the stuck item, or `/qresume` after a failure |
