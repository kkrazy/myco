# Claude Code TUI ⇄ myco Interaction Rules

This file is the single source of truth for how myco's chat picker drives
claude code's terminal UI. Each rule was learned from a live failure
(usually on mycobeta), and each one is pinned by at least one regex and
one test so a future refactor that breaks the contract trips immediately.

When you add a new rule (e.g. claude code 2.2.x changes a dialog shape):
1. Add the regex/constant to `pty-patterns.js` with a long comment quoting
   the exact TUI output that motivated it.
2. Add the rule entry to this file (number, title, why, enforcement).
3. Add a test under `test/` that fails if the rule is broken.
4. Add a static `grep` sentinel in `test/test.sh` so the wiring can't silently
   regress.

Rules are numbered for stable cross-reference from commit messages and
issue tracker.

---

## R-01 — Single-select pick on a STOCK dialog → `digit + "\r"`

**Stock dialogs** (trust folder, permission prompt, plan-confirm) use
Ink's `SelectInput` widget. Digit moves the cursor; Enter commits.

- **Send:** `String(n) + "\r"` (digit then CR)
- **Why:** without the CR the cursor lands on option `n` but the
  selection isn't committed — user is stuck looking at a still-active
  dialog.
- **Code:** `server/src/pty.js handleMenuPick` (default branch)
- **Test:** `test/menu-pick-race.test.js`
  → "pick: WITH trailing CR when no wizard tab bar"
- **test.sh sentinel:** "pty.js: handleMenuPick gates trailing CR on
  `_isWizardActive`"

## R-02 — Single-select pick INSIDE the plan-mode wizard (SIMPLE variant) → `digit` only

The plan-mode interview wizard renders a breadcrumb tab bar
(`← ☒ Step ☐ Step ✔ Submit →`). The SIMPLE variant auto-commits +
auto-advances on a single digit. The wizard treats Enter as "advance
past this screen," so a trailing CR leaks to the *next* screen.

- **Send:** `String(n)` (bare digit, no CR)
- **Why (observed mycobeta demo010, 2026-05-13):**
  - Q1 `"2\r"` → "2" picks + advances to Q2. The leaked `"\r"`
    advanced *past Q2 entirely* (Q2 was never broadcast).
  - Q4 `"3\r"` → "3" picks + advances to the Submit tab. The leaked
    `"\r"` landed on the Submit tab's default cursor (Cancel) and
    the wizard returned "user rejected".
- **Detection:** `WIZARD_TAB_BAR_RE` matches `← [^]* ☐|☒|✔ [^]* →`
  AND the rich-footer regex `WIZARD_RICH_FOOTER_RE` does NOT match.
- **Code:** `server/src/pty.js handleMenuPick` via `_detectWizard()`
  returning `kind: 'simple'`
- **Test:** `test/menu-pick-race.test.js`
  → "pick: NO trailing CR when the wizard tab bar is visible"
- **test.sh sentinel:** "pty.js: `_isWizardActive` helper defined"

## R-02b — Single-select pick INSIDE the RICH wizard variant → `digit + "\r"`

The rich variant of the plan-mode interview wizard expands each
option inline (description, pros/cons table, optional Notes field).
Footer reads "Enter to select · ↑/↓ to navigate · n to add notes ·
Tab to switch questions · Esc to cancel". In this variant the digit
key MOVES the cursor and renders the option's detail panel — it
does NOT commit. Enter is required.

- **Send:** `String(n) + "\r"`
- **Why (observed mycobeta demo010, 2026-05-13):**
  - "Which architecture should the order-processing service use?"
    click on option 1 sent bare `"1"` → cursor moved to Monolith
    and rendered its detail panel; the wizard sat on the same screen
    indefinitely. User reported "click on the option didn't submit
    the selection."
- **Detection:** `WIZARD_TAB_BAR_RE` matches AND `WIZARD_RICH_FOOTER_RE`
  (`/\bn\s+to\s+add\s+notes\b|\bTab\s+to\s+switch\s+questions\b/i`)
  matches — both signals required to flip back to digit+CR.
- **Code:** `server/src/pty.js _detectWizard()` returning `kind: 'rich'`.
- **Test:** `test/menu-pick-race.test.js`
  → "pick: RICH wizard variant needs Enter — digit + CR"
- **test.sh sentinel:** "pty-patterns.js: WIZARD_RICH_FOOTER_RE defined" +
  "pty.js: _detectWizard distinguishes simple vs rich wizard"

## R-03 — Multi-select toggle → bare `digit`

Claude code's multi-select dialog responds to a bare digit by flipping
that option's checkbox without committing/advancing. Submission is
separate (R-04).

- **Send:** `String(n)` (no CR)
- **Why:** sending `digit + "\r"` would commit the whole dialog on the
  first toggle, foreclosing further selections.
- **Code:** `server/src/pty.js handleMenuToggle`
- **Test:** `test/menu-pick-race.test.js`
  → "toggle: one click flips opt.checked exactly once (no double-flip)"
- **test.sh sentinels:** "handleMenuToggle writes digit only (no CR)" +
  "handleMenuToggle has no CR (matches multi-select toggle semantics)"

## R-04 — Multi-select submit → paced `↓` then `"\r"`

After toggling the desired options, the cursor must move to the
dedicated submit row and press Enter. The row is labeled `Submit`,
`Done`, `Continue`, `Finish`, `OK`, or — in the plan-mode interview
wizard — `Next`.

- **Send:** for `i` in `0..navCount-1`: write `"\x1b[B"` (down-arrow),
  wait 30 ms; then wait 80 ms, write `"\r"`.
- **Why paced:** Ink's input loop debounces consecutive arrow presses
  arriving in a single PTY chunk; the cursor advances ONE step instead
  of `navCount`.
- **Why fixed gap of 30 ms:** verified on mycobeta to be the smallest
  gap claude's TUI reliably processes as separate events.
- **Code:** `server/src/pty.js handleMenuSubmit` + `_findSubmitNavCount`
- **Test:** `test/menu-multiselect.test.js` (regex coverage) +
  runtime parse log `[menu-submit-parse]` (gated by
  `MYCO_MENU_SUBMIT_DEBUG=1`).
- **test.sh sentinel:** "handleMenuSubmit paces arrows with setTimeout
  (no rapid-burst)"

## R-05 — `navCount` is measured in ITEMS, not LINES

Claude's TUI navigates option-by-option. Multi-line option descriptions
between numbered options DO NOT count as down-arrow stops.

- **Rule:** count rows matching `MENU_OPT_LINE_RE` OR `SUBMIT_ROW_RE`,
  strictly between cursor (exclusive) and submit (inclusive).
- **Why (observed mycobeta demo010, 2026-05-13):** the Features
  multi-select had 9 LINES between cursor and Next but only 5
  NAVIGABLE ITEMS. The 4-row line-count overshoot wrapped the cursor
  past Next, past "Chat about this", back to the option list, and
  pressed Enter on a checkbox row instead of the Submit row.
- **Code:** `server/src/pty.js _findSubmitNavCount` (item-count loop)
- **Test:** runtime probe via `MYCO_MENU_SUBMIT_DEBUG=1`. Each
  scanned row gets a `tag` (cursor/option/submit/cursor-fallback) so a
  failed wizard run is reproducible from the log alone.

## R-06 — Multi-select cursor row REQUIRES a checkbox on the same line

A stray `❯` glyph elsewhere in the viewport (wizard breadcrumb step
pointer, redraw residue, hint text) inflates the cursor→Submit
distance if we anchor on "first `❯`".

- **Pattern:** `MULTI_SELECT_CURSOR_RE = /❯[^[\]]*\[\s*[xX✓✔●▪◉█* ]?\s*\]/`
  — requires `❯` AND a `[...]` checkbox on the same line.
- **Fallback:** if no checkbox-bearing cursor row is found (e.g. the
  cursor lands ON the Submit row itself), fall back to the first `❯`.
- **Code:** `server/src/pty-patterns.js MULTI_SELECT_CURSOR_RE` +
  `_findSubmitNavCount` cursorRow detection.
- **Test:** `test/menu-multiselect.test.js`
  → "MULTI_SELECT_CURSOR_RE matches ❯ on a checkbox option line" +
    "rejects a stray ❯ without a checkbox on the same line"

## R-07 — Submit row label MUST be the whole line

Footer hint text like `"Tab/Arrow keys to navigate · Enter to submit"`
or `"Press Enter to Submit"` ends in `submit` and used to win the
"last-match wins" race against the real `Submit` row, pushing
`submitRow` past it by several lines and overshooting the nav burst.

- **Pattern:** `SUBMIT_ROW_RE = /^\s*(?:submit|done|continue|finish|ok|next)\s*$/i`
  — the line contains ONLY the label, surrounded by whitespace.
- **Why `next` is in the alternation:** claude code's plan-mode
  interview wizard labels its per-question advance row "Next"
  (verified mycobeta demo010, 2026-05-13).
- **Code:** `server/src/pty-patterns.js SUBMIT_ROW_RE`
- **Test:** `test/menu-multiselect.test.js`
  → "SUBMIT_ROW_RE matches a bare Submit-row label only" +
    "rejects footer hints that end in 'submit'"

## R-08 — Wizard tab bar detection bypasses the cursor guard for menu broadcast

The plan-mode wizard sometimes paints the `❯` cursor on the breadcrumb
step pointer instead of on a numbered option (e.g. on the Submit
sub-screen "Ready to submit your answers?"). The normal menu scanner
rejects an option run that has no `❯` on it; the wizard signal lets
it through.

- **Pattern:** `WIZARD_TAB_BAR_RE = /←[^←→]*[☐☒✔✓◯●xX][^←→]*[☐☒✔✓◯●xX][^←→]*→/`
- **Code:** `server/src/menu-interceptor.js _scan` (post-cursor-check
  wizard bypass)
- **Test:** `test/menu-broadcast.test.js`
  → "plan-mode wizard submit screen detected even when ❯ is on the
    breadcrumb"

## R-09 — Menu-hash dedup matches ONLY the LAST chat row

`appendChatMessage` collapses re-broadcasts of the same menu (same
hash) into the existing chat row — but ONLY if that row is the
absolute last entry in `state.chatMessages`. Older same-hash rows
sitting mid-chat are stale; the live re-fire must append fresh so the
user sees the picker at the bottom of chat, not silently update a
buried row.

- **Why (observed mycobeta, 2026-05-13):** the wizard's Submit/Cancel
  screen has a deterministic hash that recurs across wizard runs.
  The pre-fix "iterate from index 0" dedup matched a stale row from a
  previous wizard, updated it silently, and the user saw nothing new
  at the bottom of chat — only a page refresh surfaced the fact that
  rec.chat had the row.
- **Code:** `web/public/app.js appendChatMessage` (the
  `lastIdx = state.chatMessages.length - 1` branch)
- **test.sh sentinel:** "app.js: menu-hash dedup constrained to last
  chat row"

## R-10 — pending.options[i] AND the persisted chat row's options[i] share ONE object reference

`broadcastMenuToChat` pushes the menu object as-is into rec.chat
(no clone). The pending menu on the live PtySession and the persisted
chat record point at the SAME `{n,label,checkbox,checked}` objects.

- **Rule:** code that mutates option state must do it ONCE per click,
  not once in the persist path AND once in the pending path.
- **Why (observed mycobeta demo010, 2026-05-13):** the pre-fix
  `handleMenuToggle` flipped `opt.checked` inside
  `_toggleMenuChatCheckbox` (persist) AND again on `pending.options`.
  Net flip was zero — the chat picker's UI never moved and the
  menu-multi diagnostic logged the initial state for every click.
  Worse: the digit was still written to the PTY, so claude's TUI
  diverged from the server's view of `checked`.
- **Code:** `server/src/pty.js handleMenuToggle` (only calls
  `_toggleMenuChatCheckbox`; no second flip on `pending.options[i]`)
- **Test:** `test/menu-pick-race.test.js`
  → "toggle: pending.options and the persisted row share the same
    object reference" + "toggle: one click flips opt.checked exactly
    once (no double-flip)"
- **test.sh sentinel:** "handleMenuToggle flips opt.checked exactly
  once (no double-flip)"

## R-11 — Live `mode-change` event piggybacks the menu safety scan

Plan-mode / auto-mode transitions in claude's TUI are detected by
`_extractMode()` running every 750 ms (same cadence as the menu
periodic scan). The first scan establishes a baseline silently; only
real transitions emit a `mode-change` event.

- **Rule:** first scan must NOT emit (no fictitious "entered default"
  pill on owner reconnect or page refresh).
- **Code:** `server/src/pty.js _checkMenu` (mode-change branch)
- **Test:** `test/pty-mode-change.test.js` — 6 cases including the
  baseline-silence guarantee.

## R-12 — Assistant text comes via agent-event, NOT rec.chat (SDK era)

PTY-era behavior (since superseded): Claude's assistant TEXT mirrored
from the transcript JSONL into `rec.chat` with `meta.transcriptUuid` +
`meta.fromTranscript: true`, then re-emitted as a `'chat'` WS frame so
attached clients saw it. That was the only refresh-survivable record
of claude's prose back when PTY was the byte-pump and there was no
structured event stream.

SDK era (Phase 9+): assistant text rides the `agent-event`
stream (`{type:'assistant_text', text}`) and is persisted to
`<cwd>/_myco_/events.jsonl` via `AgentSession._persistEventToDisk`.
On reattach, the events file hydrates `session.buffer` and the
`agent-replay` WS frame redraws every assistant_text card. So we no
longer need (or want) a parallel chat-bubble path for the same text.

- **Live emit:** `persistAssistantTextToChat` in `attach.js`
  deliberately does NOT call `session.emit('chat', reply)` for
  assistant text any more. If a future refactor re-adds that emit,
  every reply will render twice (chat-msg bubble + agent_text card).
  Regression: `test/persist-assistant-chat.test.js` ("persistAssistant
  TextToChat does not emit live chat frames").
- **History frame:** `sessions.getChatHistory` filters out
  `meta.fromTranscript === true` rows so the `chat-history` WS frame
  doesn't re-introduce duplicates on attach. Storage in `rec.chat` is
  preserved untouched (no data migration needed).
- **Diagnostic:** `[persist-chat] <sid> mirrored=N skipped=M …
  (live emit suppressed — agent-event carries assistant_text)` logs
  every non-empty persist.
- **Test:** `test/persist-assistant-chat.test.js` covers both halves
  (no live emit + history filter).

---

## How to test a new interaction rule

1. **Regex tests** — add to `test/menu-multiselect.test.js` or
   `test/menu-broadcast.test.js` depending on whether the regex is
   for option/cursor detection or for dialog classification.

2. **State-machine tests** — add to `test/menu-pick-race.test.js` for
   PTY-write semantics (what bytes go to claude on each click), or
   `test/pty-mode-change.test.js` for emit-on-transition semantics.

3. **Runtime probes** — add a `console.log` gated on an env var
   (`MYCO_MENU_DEBUG=1`, `MYCO_MENU_SUBMIT_DEBUG=1`) so live repros on
   mycobeta produce a verbatim trace the user can paste back.

4. **Static `grep` sentinel in `test.sh`** — every new regex,
   function, and WS-frame wire-up gets one line that fails if the
   wiring silently disappears.

## When you hit a "user rejected" failure on mycobeta

The diagnostic order:

1. `docker logs myco | grep <session-id>` — does the click sequence
   match what the user did? Look for missing menu broadcasts (a tab
   that never showed).
2. `docker logs myco | grep menu-submit-parse` — for multi-select
   submits, are `cursorRow` / `submitRow` / `items` correct? Read the
   per-row tags.
3. `docker logs myco | grep menu-pick` — the new format includes the
   bytes written and `wizard=true/false`. Verify R-01 / R-02 gate.
4. The session's JSONL at `~/.claude/projects/<cwd>/<sess>.jsonl` —
   look at the `tool_result` content. `"User rejected tool use"` means
   we landed Enter on a Cancel / Reject element. `"User has answered
   your questions: ..."` means the wizard succeeded with the listed
   answers.
