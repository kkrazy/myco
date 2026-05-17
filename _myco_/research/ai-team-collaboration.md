# AI-native team collaboration in myco — research + proposal

**Status:** research draft · 2026-05-17 · author: claude (kkrazy session)
**Scope:** features to add to myco to make AI + human collaboration first-class.
Not a commitment — a menu the team picks from.

---

## 1. Executive summary

Myco today is a strong *single-human + claude* surface. The seams begin to
show the moment a **team** is involved — multiple humans, multiple AI
sessions, overlapping work, async handoffs, drift across days. The
shortest-distance gap closures:

1. **Cross-session memory** so two humans / two AI sessions don't re-discover
   the same finding.
2. **Routing of AI's open questions** to the right human, not OS-broadcast
   to everyone attached.
3. **Approval / review queue** so risky AI actions (deploys, deletes,
   destructive git) wait for a human nod without blocking everything else.
4. **Team-wide observability** — what's every AI doing right now, what did
   it spend, what touched what.
5. **Async handoff** — leave a task for "the next teammate", and the next
   teammate's session reads + acts on it without re-typing context.

Items 1-3 are the highest leverage and the most concretely buildable on
top of the existing primitives (rec.chat, plan.json, agent-session, share
tokens). Items 4-5 are 1-2 quarter projects.

---

## 2. What myco already has (the foundations to build on)

| Primitive | What it gives us |
|-----------|-------------------|
| `AgentSession` + WS attach | Multi-device live attach; presence chips show who's connected |
| `rec.chat` + seq # | Durable global ordering of every user + claude message |
| `_persistAssistantTextToRecChat` | Claude's replies are first-class records, not ephemera |
| `plan.json` (td / fr / bug) | Structured task list, comments, votes, run-status |
| `@user` + `@all` mentions | In-chat addressing, OS notification on mention |
| `architecture.md` artifact | Long-form project memory extracted from chat |
| `bash-elapsed.json` | Project-local runtime norms (what's slow → delegate) |
| Share tokens | Read-only viewer mode for guests |
| `canUseTool` + permission menus | Per-tool gating with allow / deny / one-shot |
| OS notifications | Browser-native pings for blocking decisions |
| `auth-sessions.json` + GitHub OAuth | Identity, allowlist gating |
| File explorer + git decorators | At-a-glance worktree state, file download |

These give us: identity, ordering, persistence, addressing, transcripts,
notifications, and a structured planning surface. Most missing pieces are
*coordination layers* on top, not new substrates.

---

## 3. Proposal — five themes, ranked by leverage

### Theme A · Cross-session memory & federation

**Problem:** Two humans on the same project open two myco sessions. Each
session has its own `_myco_/events.jsonl`, its own chat. If session A
discovers "the auth tests are flaky on port 8080 — use 9080", session B
re-discovers it 30 minutes later. Even worse: an AI session run by Alice
yesterday and an AI session by Bob today don't share notes.

**Proposed features:**

- **`_myco_/notebook.md`** — a free-form team scratchpad, surfaced as a
  new artifact tab next to Plan/Arch/Test. Append-only by default; AI
  is encouraged to write findings here ("Discovered: prisma migrations
  on docker need `--volumes` flag"). Same persistence + git contract as
  plan.json.
- **Cross-session announce** — when an AgentSession on project P writes
  a finding (e.g. a new `_myco_/notebook.md` entry, a new plan item, an
  arch.md edit), other live AgentSessions for the same project get a
  toast: "session B added a note in notebook". Implementation: file-
  watcher on `_myco_/` per project, fan-out via the existing presence
  channel.
- **Session "merge"** — open a stopped session's transcript inline in a
  live session ("show me what Alice's session did at 3 PM"). Same
  /attach/:id-viewer wire-shape, just a read-only historical mode.
- **Project-level memory query** — `/recall <topic>` slash command that
  greps every chat + notebook + plan-comment in `_myco_/` for matches,
  shows top hits inline. Easy first version: ripgrep + a 200-line max.

**Complexity:** S → M. The notebook tab is mostly a clone of arch.md
extractor + a free-form edit mode. The announce fan-out is a single
fs.watch + WS broadcast.

---

### Theme B · Approval & review queue (trust ladder)

**Problem:** Today a permission menu blocks the agent loop until any
attached human clicks. This is fine for "rm a file in /tmp" but wrong
shape for "run `./deploy.sh` to prod" — high-stakes ops should require
a *specific* human (the on-call), not whoever happens to be looking,
and should be reviewable async, not block live work.

**Proposed features:**

- **Per-tool trust tier** — extend the allow/deny list with a third
  tier "queue-for-review". When AI invokes a queued tool, the session
  pauses but DOESN'T block the agent's turn — chat continues, other
  tools work. A `🛂 Awaiting review` chip appears at the top of the
  chat pane.
- **Review queue tab** — new chrome icon next to Plan/Arch/Test
  showing pending reviews across all the user's sessions. Each row
  shows: who requested (session label + AI persona), what (tool +
  input summary + risk reason), when, and approve / reject buttons.
- **Trusted reviewer routing** — `/td` items can carry a
  `reviewer: alice` field; tool calls matching that item's scope get
  routed to alice's review queue specifically.
- **Audit log** — every approve/reject pair is appended to
  `_myco_/audit.jsonl` with (reviewer, action, tool, hash, ts).
  Already-running OAuth identity makes this trivially attributable.
- **Time-bounded auto-trust** — "trust this AI session with bash for
  the next 30 min" or "let this session use $5 of API credits before
  pausing again" — bounded delegation that auto-revokes.

**Complexity:** M. The `canUseTool` hook already returns
`allow|deny|defer`; we add a fourth `queue` state. The review queue
tab is mostly UI; the underlying state lives in `rec.permPending`.

**Why this is high-leverage:** unlocks "team gives AI more agency
without losing oversight". Today every team that wants 24/7 AI loops
has to either fully trust + risk wreckage, or fully gate + lose throughput.

---

### Theme C · AI ↔ human question routing

**Problem:** When AI hits ambiguity ("should I use prisma or drizzle?"),
the current options are: (a) ask in chat and hope someone's looking;
(b) fire OS notification to every attached device, including phones in
pockets at 11 PM; (c) just guess. None are great.

**Proposed features:**

- **`/ask @user <question>`** as a first-class agent-event — AI emits
  it via the SDK's `AskUserQuestion` tool or via slash command. The
  named user gets a high-priority chip in their session's chat pane +
  email (later) + OS notification, regardless of whether they're
  currently in this session. Other users see it as a muted "alice has
  a question from session X" line.
- **Question follow-the-thread** — when alice answers, the answer is
  posted back to the originating AI session as a `user` chat-msg with
  a `meta.replyTo: <ask-id>` link. AI sees it as conversational input
  on its next turn.
- **Question SLA / fallback** — `/ask @alice (default after 1h: just
  use prisma)` lets AI proceed with a sensible default if no reply
  arrives. Avoids the "AI is blocked, has been for 8h" pathology.
- **Topic subscriptions** — `/subscribe auth` or `/subscribe src/auth/**`
  in a user's profile. When ANY session's chat mentions auth, or
  touches a file matching the glob, that user is added to that
  session's "interested" roster + gets a digest entry. Solves the
  "I want to know when anyone breaks the auth invariant" case.

**Complexity:** S → M. `/ask` is mostly a structured chat-msg with a
`kind:'ask'` meta + special rendering. The subscription scanner is
~50 LOC server-side on top of the existing event stream.

---

### Theme D · Team observability dashboard

**Problem:** Today, to know what every AI on your team is doing, you
have to open each session's tab one by one. Per-session cost / token
spend lives only in turn_result events — no team-level rollup. No
"this session has been silent for 2 hours" alarm.

**Proposed features:**

- **`/team` dashboard** — a new top-level route (not per-session) that
  shows: every session for users in your allowlist, with live status
  (running / waiting-on-perm / idle / dead), latest activity, current
  cost burn, and a 1-line agent-state ("running tests", "awaiting
  review on deploy.sh", "idle 23 min").
- **Cost rollup** — sum `total_cost_usd` across all sessions per
  user + per day + per project. Server tracks via existing
  turn_result events; UI shows a small bar chart.
- **Stuck-session detector** — a session that's been in
  "permission_request" for >5 min OR "awaiting_claude" for >2 min
  with no chrome activity → surface as a yellow ⚠ chip on the
  /team dashboard. Lightweight; uses the events.jsonl ts gaps.
- **Replay scrubber** — open any session's transcript at a point in
  time, see what was on screen + what claude was doing. Already
  have the data (rec.chat + events.jsonl with seq #s); needs a
  read-only time-travel renderer.

**Complexity:** M → L. The dashboard route + rollup is straightforward
server-side. Replay scrubber is the bigger chunk — needs a separate
client mode that renders historical state without subscribing to live.

---

### Theme E · Async handoff

**Problem:** Alice has to step away mid-session. The AI is mid-task.
Bob comes online 2 hours later and would like to take over — but has
no easy way to know what Alice was doing, what's left, what's risky.

**Proposed features:**

- **`/handoff @bob <one-liner>`** — Alice types this; the server
  bookmarks the session's current state with a special chat row
  (`kind:'handoff'`), pings bob, and on bob's first attach the chat
  pane scrolls to the handoff marker with the one-liner pinned to the
  top.
- **Resume summary** — when a teammate attaches to a session that's
  been idle >15 min, the chat pane shows a small "Resume" banner:
  "Last activity 2h ago. AI completed 3 turns since you left. Click
  to summarise." Click → AI generates a 5-bullet recap as a
  chat-msg.
- **Steering passes** — explicit "you have the wheel" / "give me the
  wheel" semantics so two humans don't simultaneously type at the
  same AI. Lightweight lock; whoever has it gets a "🎯 driving"
  chip, others get a muted "👀 watching" + read-only input.
- **Inbox** — a new top-level item showing every pending `/ask` or
  `/handoff` or review-queue entry directed at the current user
  across all their sessions. Single funnel for "what needs my
  attention".

**Complexity:** M. Handoff bookmark + resume summary are small. The
"steering pass" is more invasive — needs server-side per-session
lock state + UI to surrender / take.

---

## 4. Sequencing recommendation

The themes above interact. Sequencing them gets us the most value per
ship:

```mermaid
flowchart LR
    A[A.notebook tab + cross-session announce] --> B[B.review queue + audit log]
    A --> C[C./ask routing + subscriptions]
    B --> D[D.team dashboard + cost rollup]
    C --> D
    D --> E[E.handoff + steering passes]
```

**Phase 1 (2-3 weeks, ~1 dev):**
- Theme A (notebook tab, cross-session announce, `/recall`)
- Theme C-lite (`/ask @user` with no SLA/fallback yet)

**Phase 2 (3-4 weeks):**
- Theme B (review queue + trust ladder + audit log)
- Theme C-full (subscriptions, SLA fallback)

**Phase 3 (4-6 weeks):**
- Theme D (team dashboard, cost rollup, stuck-session)
- Theme E (handoff, resume summary, steering lock)

**Replay scrubber** (Theme D) deferred to Phase 4 — it's the highest-
effort piece and depends on stabilizing the event-history wire format.

---

## 5. Open design questions

- **Where does the notebook live cross-project?** Per-project today
  (`<absCwd>/_myco_/notebook.md`). Should there be a personal
  notebook (user-scoped, all projects) and a team notebook
  (project-scoped, all users)?
- **Review queue durability** — should pending reviews survive a
  server restart? (Yes — persist to `_myco_/permissions/queue.jsonl`.)
- **`/ask` cost** — when AI fires `/ask @alice`, who's billed for the
  turns alice's reply triggers? Suggested: the original session
  owner, but track for transparency.
- **Subscription noise floor** — `/subscribe auth` could fire dozens
  of times a day. Need throttling + digest mode.
- **Steering lock + automation** — if AI session is running unattended
  (cron-driven, e.g.), nobody is "driving". Resolve: AI implicitly
  drives unless a human takes the wheel.
- **Privacy** — once cross-session announce exists, a session's notes
  leak to teammates by default. Opt-out toggle or per-session
  visibility?
- **Trust-ladder bootstrap** — how does a new AI session inherit
  trust state from the previous one? Per-tool-pattern (already what
  allow-list does), per-session (each session restarts cold), or
  per-user?

---

## 6. Anti-features (things to deliberately NOT add)

- **No new chat surfaces for the AI to "speak through".** Stay
  within `agent-event` + `chat` frames; don't fork them.
- **No per-feature DB.** Everything lives in `_myco_/*.{json,jsonl,md}`
  or `/data/*.json` — keeps the "git pull = onboard" property of
  rule 5 in best-practices.
- **No silent AI-to-AI loops.** Anything one AI session does that
  affects another must be visible to humans in the chat record. We
  don't build invisible AI mesh — every action is auditable.

---

## 7. Filing this against `plan.json`

Each theme above becomes a feature request. Filed under fr-12 through
fr-16 (see plan.json entries dated 2026-05-17). The granular sub-tasks
inside each theme can be filed as individual `td-` items when
implementation kicks off.

---

*This doc is a research draft, not a commitment. Edit freely; commit
+ push edits per rule 5.*
