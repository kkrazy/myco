# myco Usage Guide (English)

> For first-time users: how to sign in, open a session, pull code in, and get the
> agent working. Deployment and ops live in `docs/deploy/dev-docker.md` and
> `docs/deploy/docker.md`. Architecture diagrams: `docs/architecture-overview.en.md`.

---

## 0. Current test environment

| Item | Value |
|---|---|
| URL | `http://7.242.109.33:8080` |
| Container | `myco-tz` |
| Image | `myco:tz-dev` (built from the `dev-miras-tz` branch) |
| Host state dir | `/data/tz_miras/myco-dev/state` |
| Source dir | `/data/tz_miras/myco-dev/myco-1014-dev` |
| Login | No OAuth configured — you enter directly as the `default` user |
| Agent backend | Huawei gateway `http://api.code-agent.rnd.huawei.com`, model `glmmoedsa` |

---

## 1. Open the app

Browse to `http://7.242.109.33:8080/`.

- Left: **session list** (sidebar). Right of it: the control cluster. Center: the
  **chat pane**.
- The same URL works on a phone; the layout is mobile-first.

> If you land on a login screen: this test box has no GitHub OAuth configured, so
> it should drop you straight in as `default`. If you see a sign-in button, check
> that `MYCO_GH_CLIENT_ID` is not set in the state `.env`.

---

## 2. Create a session

Click **+ New session** in the sidebar:

1. Optionally type a display label (e.g. `myco-dev`). It is only a label.
2. Confirm — the server creates a workspace at `/wks/<user>/<session-id>/`.

One session = one isolated workspace + its own chat history + its own Plan. You
can run several sessions in parallel; each is backed by its own agent.

---

## 3. Bring code in

A new session starts empty. Use `/git` commands:

```
/git clone ssh://git@codehub-dg-g.huawei.com:2222/t59900502/myco-1014-dev.git
```

Other common ones:

```
/git status
/git log --oneline -10
/git diff HEAD~3
/git commit -am "fix: xxx"
/git push
```

For private repos, store a token once:

```
/setpat <your-token>
```

> A git credential helper is registered in the container, so tokens saved with
> `/setpat` are used automatically by `git push` — no inline username/password.

---

## 4. Talk to the agent

Just type in the composer and hit send.

| You type | What happens |
|---|---|
| Plain text | The agent picks it up and starts working (reads, edits, runs commands) |
| `@user` / `@all` | Messages a teammate; the agent ignores it |
| `/command` | Runs a slash command (see §7) |
| Red ■ | Interrupts the agent's current turn |
| Permission modal | Allow once / Allow always / Deny |
| ↑ / ↓ at line start | Recall previous inputs |

**About permission prompts:** this test environment sets `MYCO_ALLOW_ALL=1`, so
the agent never asks before running a tool. Turn it off before sharing the box
with others or pointing it at important code (see `dev-docker.md`).

---

## 5. Track work with the Plan

Every work item (bug / feature / todo) is a Plan item stored in the project's
`_myco_/plan.json` — **it travels with git**:

```
/td   bump node version in the Dockerfile
/fr   add a dark-mode toggle
/bug  load-older button loops past page 5
/bug! <one line>      ← the agent rewrites it into Problem / Expected / Actual
```

Per item you can: vote · comment · edit · **▶ Run** (dispatch it to the agent) ·
close/reopen · delete.

After `▶ Run`, the agent works in three stages — **analyze → code → verify** —
and at each stage boundary a critic reviews the diff and the run **pauses for
your explicit acceptance** (`✓ Accept Stage` / `⚡ Ask Claude to Fix Stage`). It
does not auto-advance; that is deliberate.

---

## 6. Run queue

To work through several items back-to-back:

```
/queue fr-43 bug-21     ← enqueue; starts automatically when idle
/qstatus                ← current state
/qcancel <id>           ← drop one
/qresume                ← resume after an auto-pause
/next                   ← ask the agent which 10 items to tackle next
```

A failed item auto-pauses the queue rather than ploughing on.

---

## 7. Slash commands

**Anyone**

| Command | Purpose |
|---|---|
| `/help` | Command help |
| `/td <text>` | File a todo |
| `/fr <text>` | File a feature request |
| `/bug <text>` | File a bug |
| `/task` | List the agent's current internal tasks |
| `/qstatus` `/next` | Queue status / priority suggestions |
| `/btw <question>` | Side-channel one-shot question, does not pollute the session |
| `/me` `/whoami` | Who am I |

**Owner / Admin**

| Command | Purpose |
|---|---|
| `/git <args>` | Run git in the session workspace |
| `/setpat <token>` | Store a code-platform PAT |
| `/admin <login>` | Grant admin |
| `/queue` `/qcancel` `/qclear` `/qresume` | Queue management |

---

## 8. Files

- Click the **Files** icon to browse; click a file to view it.
- **✎ Edit** opens the built-in editor (CodeMirror 6) with syntax highlighting,
  line numbers, search and folding. `Ctrl/Cmd-S` saves, `Esc` cancels.
- Concurrent edits are mtime-checked: a conflict shows Reload / Force overwrite /
  Cancel instead of silently clobbering someone's bytes.

Below the plan items there is **Changed files** — everything the agent touched
this session: `+N −M` per file, click to expand the diff, click a `+` line to
leave a line-level comment for the agent, `✓ Accept` to stage a file or
`✕ Reject` to revert it, plus Accept all / Reject all in the header.

---

## 9. Sharing and multiple devices

- The session menu can mint a **share link**: holders get a read-only view (live
  chat, tool calls, plan, files; they can `@mention` and file plan items but
  cannot drive the agent).
- The same link works on phone and laptop with identical chat history — the
  server is the only source of truth.
- After a disconnect or device switch the client catches up incrementally
  (`?afterSeq=N`), so it never re-downloads the whole history.

---

## 10. Troubleshooting

**Q: Chat is stuck on `[connecting...]` / `[reconnecting...]`**
The browser's WebSocket handshake is being dropped. Confirm the server first:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://7.242.109.33:8080/
```
If that returns 200, a network device (VPN, firewall, AV proxy) is interfering.

**Q: The agent replies `Failed to authenticate. API Error: 401` or `Not logged in`**
`ANTHROPIC_AUTH_TOKEN` is missing or expired in the state `.env`. Add it to
`/data/tz_miras/myco-dev/state/.env`, then `docker restart myco-tz`.

**Q: The agent says it cannot reach the gateway / `fetch failed`**
The container cannot resolve the internal domain. Check the `--add-host` flags on
the container and that the domain is in `no_proxy`.

**Q: I edited `.env` and nothing changed**
`.env` is read once at container boot. Restart:
```bash
docker restart myco-tz
```

**Q: Code changed but the page did not**
The frontend is served `Cache-Control: no-store`, so a normal refresh is enough.
For source changes you must rebuild the image and recreate the container.

**Q: Will we lose data?**
No. All state lives on the host under `/data/tz_miras/myco-dev/state`; recreating
the container does not touch it. Backup = `tar -czf state-backup.tgz
/data/tz_miras/myco-dev/state/`.
