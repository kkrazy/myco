# Agent SDK migration plan

**Branch:** `agent-sdk-research`  
**Goal:** retire the `claude` CLI + PTY scraping architecture in favor of the
Claude Agent SDK driving structured events. Eliminates the entire TUI-detection
bug class (menu drift, "Superseded by a newer dialog", resume-after-background
missed output, ring-buffer overflow, etc.).

**Strategy:** parallel architecture, opt-in per session. PTY sessions stay
working end-to-end until SDK sessions reach feature parity, then we flip the
default. NO big-bang rewrite.

**Scope reality check:** ~3000 LoC of server PTY code + 4800 LoC of browser
app.js to migrate. Realistic multi-week effort. Each phase delivers
something runnable + reviewable.

---

## Phase 0 — research + POC ✅ DONE

- [x] Research SDK capabilities → `agent-sdk-research.md` (this branch)
- [x] Empirically verify subscription auth works → `agent-sdk-poc.mjs`
- [x] Capture real `AskUserQuestion` + `canUseTool` event shapes against our cwd

## Phase 1 — agent-session foundation (this PR)

Goal: a working `AgentSession` class side-by-side with `PtySession`. New
sessions can opt into `mode: 'agent'`; default stays `'pty'`. Browser still
attaches via existing route, but if the session is agent-mode, gets a
structured event stream instead of xterm output.

- [ ] **`server/src/agent-session.js`** — wraps SDK `query()`, exposes a
      session interface mirroring `PtySession` (`emit('data'|'chat'|'menu'|
      'state-update')`, `write()` semantically = send next user message,
      `alive`, `pendingMenu`, `_lastStatus`).
- [ ] **`server/src/sessions.js`** — `spawnSession({ mode })`, default
      `mode='pty'`. Persists `mode` on the rec so reconnects know which
      class to instantiate.
- [ ] **`server/src/pty.js attachWebSocket`** — branches on session mode:
      PTY path unchanged; agent path streams `{t:'agent-event', event}`
      frames instead of `{t:'output', data}`.
- [ ] **`web/public/app.js`** — recognises `agent-event` frames, renders
      them in a temporary "agent event log" pane (basic, ugly, working).
- [ ] **Test:** `test/agent-session.test.js` — spawn one agent session,
      send a one-line prompt, assert we get `system/init` + at least one
      assistant block + `result/success`. Skip if no `~/.claude/.credentials.json`.

## Phase 2 — first-class menu/permission events in the chat pane

Now that SDK sessions emit structured events, route `AskUserQuestion` and
permission requests through the existing chat-pane menu card UI. The
infrastructure is already there (`broadcastMenuToChat`,
`handleMenuPick` with `pendingMenu`), just needs the input source swapped.

- [ ] `agent-session.js` — `canUseTool` callback that emits a `menu` event
      with the canonical menu shape `{question, options:[{n,label,...}], hash}`
      so the existing chat-card render path works unchanged.
- [ ] When the user picks via the chat callout, the callback resolves the
      pending promise with `{behavior:'allow', updatedInput:{...}}`.
- [ ] Permission requests (non-AskUserQuestion `canUseTool` fires) → same
      menu card with options `[1] Allow once  [2] Allow always  [3] Deny`.
      `[2]` echoes `updatedPermissions` to persist a `.claude/settings.local.json`
      rule.
- [ ] Delete `_supersedeStaleMenus` from agent-session paths (no longer needed —
      `canUseTool` is one-shot per request).

## Phase 3 — structured event renderer (proper UI)

Replace the xterm terminal pane with a rich event-log pane for agent-mode
sessions. Each event type gets its own visual treatment.

- [ ] `web/public/app.js` — `renderAgentEventLog()` with cards per event:
      `text` blocks → markdown; `tool_use` → tool name + truncated input +
      collapsible full input; `tool_result` → bytes count + collapsible
      content (markdown if Read result, ansi-rendered if Bash, raw if other);
      `result` → completion banner with cost + token usage.
- [ ] Streaming text deltas append in place — no whole-message re-renders.
- [ ] Per-event timing badges (elapsed since prior event).
- [ ] CSS for the new pane.

## Phase 4 — chat → SDK input pipe

Replace `session.write()` (PTY bytes) with SDK's streaming-input model.
The chat pane's plain text routing → SDK `prompt: asyncIterable` yielding
`{type:'user', message:{role:'user', content}}`.

- [ ] `agent-session.js` — internal queue of user messages; SDK's prompt
      generator yields from the queue.
- [ ] `pty.handleChatPostfixes` — when session is agent-mode, enqueue the
      message instead of `session.write()`.
- [ ] `@<known-user>` mention path unchanged (chat-only).
- [ ] `/decide N` → resolve the pending `canUseTool` callback with
      `{behavior:'allow', updatedInput:{...nth option...}}`.
- [ ] Special-key tokens (`enter`, `esc`, `ctrl-c`) become "interrupt"
      semantics — interrupt the in-flight SDK iteration via AbortSignal.

## Phase 5 — session resume + reconnect

SDK has `options.resume: <session_id>` → use it for browser reconnect.
PTY ring buffer becomes obsolete for agent-mode sessions.

- [ ] On WS attach to an existing agent-mode session, the server checks
      whether there's a running SDK iteration. If yes, replay the buffered
      events. If no (process died / was respawned), call `query({resume:
      session_id})` to re-attach to the SDK session and continue streaming.
- [ ] Per-session event buffer (capped, similar to today's 1MB byte ring
      but counting events, not bytes).
- [ ] Add the diagnostic logs: `[agent-attach] sid=<id> mode=agent
      buffered-events=<n>`, `[agent-resume] sdk-session-id=<id>`.

## Phase 6 — port hooks (PreToolUse / PostToolUse)

Today: menu-interceptor + permissions logic embedded in PtySession. With
agent-mode that all moves to a `hooks: { PreToolUse: [...], PostToolUse:
[...] }` config wired in `agent-session.js`. Cleaner separation.

- [ ] Migrate the per-session allow-list (`permissions.js`) to a PreToolUse
      hook that returns `allow`/`deny`/`modify`.
- [ ] Auto-approve allowlist entries (skipping `canUseTool` entirely so
      the chat-pane menu card doesn't pop for already-allowed tools).
- [ ] Audit log every tool use → existing `[chat→pty]` log analogue.

## Phase 7 — port artifact extraction off `claude -p`

`server/src/extractor.js` and `server/src/btw.js` both spawn `claude -p`
subprocesses today. With the SDK in the project, replace those with SDK
`query()` calls — no separate binary spawn, no PATH dependency, same auth.

- [ ] `extractor.js` — replace `runClaudeP` with `query({prompt, options:{
      maxTurns:1, allowedTools:[]}})`. Read the result text from the
      final `result` message.
- [ ] `btw.js` — same swap; `runClaudeP` becomes an SDK call.
- [ ] `slashcmds.dedupePlanItems` — same swap (already routes through
      `btw.runClaudeP`).

## Phase 8 — flip the default ✅ DONE

`spawnSession`'s default is now `mode='agent'`. PTY is opt-in via the
spawn-modal "Legacy PTY" checkbox or `POST /sessions {"mode":"pty"}`.
Existing PTY sessions in /data keep working (their rec.mode='pty'
persists). Env-var escape hatch: `MYCO_DEFAULT_MODE=pty` forces the
old default fleet-wide.

- [x] Change `spawnSession` default
- [x] Flip the spawn-modal checkbox semantics (was "opt into agent",
      now "opt into PTY fallback")
- [x] Document the env-var override in sessions.js

After production validation:

- [ ] Update CLAUDE.md docs (Deployment section, Troubleshooting)
- [ ] Mark `pty.js`, `menu-interceptor.js`, `menu.js`, `permissions.js`
      as deprecated in their file headers (Phase 9 follow-up)

## Phase 9 — kill the PTY path

Remove all the things this migration made obsolete.

- [ ] `server/src/pty.js` — delete (move WS attach plumbing to a thin
      `server/src/attach.js` or fold into index.js).
- [ ] `server/src/menu-interceptor.js`, `server/src/menu.js`,
      `server/src/permissions.js`, `server/src/pty-patterns.js` — delete.
- [ ] `web/public/vendor/xterm*` — delete (1.5MB shed).
- [ ] `web/public/app.js` — strip the xterm-init, replay-buffer client,
      `[diag-resume]` / `[ws-attach]` instrumentation (obsolete with SDK
      resume), menu-pick hash-guard, etc.
- [ ] Tests in `test/` that exercise PTY-specific paths (menu-broadcast,
      menu-pick-race, pty-mode-change, spinner-regex, …) — either delete
      or convert to agent-session equivalents where the test intent is
      still meaningful.
- [ ] CLAUDE.md `R-*` rules in `server/src/INTERACTION_RULES.md` — many
      become obsolete; the surviving ones move to a new `AGENT_RULES.md`.

---

## Rollback story

Each phase commits independently on this branch. If a phase causes
regressions, revert that single commit; PTY sessions keep working
because phases 1–7 explicitly preserve the PTY path. Phase 8 is the
only point of no return — we hold there until we're satisfied.

## Non-goals for this migration

- We do NOT rewrite the browser chat pane unless directly necessary.
  Chat-pane code stays unchanged for agent-mode sessions; only the
  source of events changes.
- We do NOT change the auth model. Subscription OAuth keeps working;
  ANTHROPIC_API_KEY still overrides if set.
- We do NOT replace artifacts.js / sessions.js storage layer. The
  JSONL transcript pipeline is unchanged.

---

**Status:** Phase 0 ✅. Starting Phase 1 in commits behind this plan.
