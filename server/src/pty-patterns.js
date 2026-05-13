// One home for every regex that matches CLAUDE'S TUI OUTPUT.
//
// Why a single file?
//
// Claude Code's terminal UI is the only thing whose text we don't control,
// and its wording, spacing, and box-drawing vary between releases and
// surfaces (trust dialog, permission prompts, plan-mode confirm, status
// bar). Whenever a patch of those surfaces breaks an existing match we
// add or relax a regex — and we want all of them in one place so:
//
//   1. New patches go to ONE file, not five.
//   2. Side-by-side review is easy (the patterns are short, the comments
//      that motivate them are long).
//   3. Future archaeology — "why does this regex exist?" — is answered
//      right next to the regex.
//
// Naming convention: <SURFACE>_<WHAT>_RE.
//
// What does NOT belong here:
//   - Regexes that match user-typed input or chat content (those live with
//     the chat / slash-command handlers).
//   - Regexes that parse our own config (allow/deny patterns, etc.).
//   - ANSI-stripping regexes — those live in text-utils.js because they
//     transform text rather than detect TUI surfaces.

// ───────────────────────────────────────────────────────────────────────
// MenuInterceptor — numbered-option dialogs (trust, permission, plan)
// ───────────────────────────────────────────────────────────────────────

// Accepted numbered-option marker shapes:
//   "1." "1)" "[1]" "(1)"
//
// LEFT anchor (?<=^|\s): the marker has to start at column 0 or be
// preceded by whitespace. Blocks in-prose mentions ("v1.0", "arr[4]").
//
// RIGHT anchor (?!\d): the marker can NOT be followed by another digit.
// This still blocks decimals ("3.5", "v1.0") but ALLOWS labels that
// follow immediately without a space — claude code renders option 2 as
// "2.Yes, and don't ask again for Web Search" with no space after the
// dot (verified 2026-05-12). A strict `(?=\s)` requirement silently
// dropped that option and broke menu detection.
//
// Matched globally so multiple options on a single line are all extracted
// (e.g. "[4] Type something. [5] Chat about this").
const MENU_OPT_MARKER_RE = /(?<=^|\s)(?:\[(\d+)\]|\((\d+)\)|(\d+)[.)])(?!\d)/g;

// Line-level "is this a numbered option line?" predicate. Same shape
// as MENU_OPT_MARKER_RE but WITHOUT the /g flag so it can be used as a
// stateless line existence test (no lastIndex pollution). Consumers
// that want to extract each marker on a line still use the /g version;
// callers that only need to count or detect option lines use this one.
const MENU_OPT_LINE_RE =
  /(?<=^|\s)(?:\[(\d+)\]|\((\d+)\)|(\d+)[.)])(?!\d)/;

// Multi-select option marker — claude code renders a checkbox after the
// numbered prefix when the dialog is a multi-select. Each digit press
// TOGGLES one checkbox; Enter submits the whole set. Examples observed:
//
//   ❯ 1. [ ] OAuth
//     2. [x] Allowlist        ← checked, with x (lowercase)
//     3. [✓] PAT login        ← checked, with check glyph
//     4. Done                 ← non-checkbox: digit+Enter submits
//     5. — [ ] Extra option   ← bullet/dash between marker and checkbox
//
// Group 1 (when defined) is the check glyph — presence means "checked".
// Group 2 is the clean label.
//
// Tolerated check glyphs: x, X, ✓, ✔, ●, *, ▪, ◉, █ — whatever claude code
// or a theme decides to render. The optional decoration class lets a
// bullet/dash/arrow sit between the number marker and the `[` without
// breaking detection. Non-checkbox labels (like "Done") still won't
// match here so the caller knows to treat them as plain picks.
const MENU_CHECKBOX_RE =
  /^\s*(?:[•·*▪◦◆◇\-–—➜→›»>]\s+)?\[\s*([xX✓✔●▪◉█*])?\s*\]\s*(.*)$/;

// The CURRENTLY-SELECTED option in a claude code TUI menu is rendered
// with a `❯` cursor in the left gutter:
//
//    ❯ 1. Yes, and use auto mode
//      2. Yes, manually approve edits
//
// We require at least one detected option's LINE to contain this glyph
// before declaring the screen contents a menu. Without this guard,
// plain numbered prose inside a claude assistant turn (e.g. "1. set
// up DB schema  2. add bus  3. worker  4. WS gateway …") matches the
// option-marker regex and gets falsely broadcast as a "🤔 Claude is
// waiting on a decision" callout. Verified false positive on a plan
// body that contained 6 numbered bullets — the scanner caught 4/5/6
// after the top scrolled off and the cursor-marker check would have
// rejected it.
const MENU_CURSOR_RE = /❯/;

// Maximum number of lines allowed BETWEEN consecutive numbered-option
// markers before we decide they're unrelated. Claude code's older
// dialogs packed options on consecutive lines (gap 1), but the ultraplan
// interview menu has multi-line descriptions:
//
//   ❯ 1. Add a hello-world script
//        Create a tiny script in the working
//        directory                          ← gap = 3 from option 1 to 2
//     2. Add a README stub
//
// Plus the same dialog inserts a horizontal divider between option 4 and
// option 5. A limit of 5 covers descriptions of up to ~4 lines AND a
// divider line, while still catching the false-positive case where
// "[3] foo" and "[4] bar" sit on opposite ends of an unrelated screen.
// The contiguous-numbers check (1,2,3 with no gaps) does the real
// false-positive filtering — this is just the upper bound.
const MENU_MAX_OPTION_GAP_LINES = 5;

// Question-line shape: prefer the line that ends with `?`, or carries one
// of claude's recognizable question verbs. Used to find the prompt line
// above a numbered-option block. Verbs widened over time as we observe
// more dialog variants — keep additions specific (full phrases, not
// fragments) so they don't fire on incidental prose.
//
// Observed variants:
//   "Do you want to proceed?"
//   "What would you like to do?"
//   "Allow Bash command?"
//   "Approve this tool use?"
//   "Confirm and run?"
//   "Are you sure you want to continue?"
//   "Would you like me to proceed?"
//   "Should I continue with this approach?"
//   "Is this a project you created or one you trust?"
const MENU_QUESTION_TAIL_RE = /\?\s*$/;
const MENU_QUESTION_VERB_RE =
  /what would you|allow|do you want|approve|confirm|proceed|would you like|are you sure|should i|is this a project/i;

// Explicit trust-folder recognizer. Claude code asks this on the FIRST
// run inside a new cwd; the dialog is generic-numbered (kind="plan" under
// MENU_KIND_PLAN_RE because "proceed" appears in option labels), but we
// keep this pattern separately so callers can light it up with a
// trust-specific UI hint in the future. Multiple observed phrasings.
const TRUST_DIALOG_RE =
  /trust the files in this folder|trust this folder|is this a project you (created|trust)/i;

// Menu classification — drives the friendly label in the chat broadcast
// (and decides whether to consult permissions.decide for auto-allow).
// Inspected on (question + ' ' + joined-option-labels).toLowerCase().
//
// PERMISSION: surfaces include claude code's "Allow Bash command?", "Run
// this command?", "Always allow Edit?" prompts.
//
// PLAN: surfaces include "What would you like to do?" with "Yes, proceed
// with this plan" / "No, keep planning" options, plus continuation
// dialogs after a plan-mode session.
const MENU_KIND_PERMISSION_RE =
  /allow.*\?|permission|approve.*tool|approve.*bash|bypass.*permission|always allow|don'?t allow|run this command|allow this command/i;
const MENU_KIND_PLAN_RE =
  /plan|proceed|continue (with|the) plan|keep planning/i;

// ───────────────────────────────────────────────────────────────────────
// permissions.extractPermissionTarget — parsing the body of a permission
// dialog to recover (tool, input) for allow/deny matching.
// ───────────────────────────────────────────────────────────────────────

// Tool-name line. The leading "Allow / Run / Approve" verbs are optional
// because some dialog variants drop them ("Bash command", "Edit file?").
//
// Tool names are matched with an OPTIONAL inner space so we catch both
// the camelCase API name and the display-form claude renders in dialogs:
//   API form:     WebSearch, WebFetch, MultiEdit, NotebookEdit, TodoWrite
//   Display form: "Web Search", "Web Fetch", "Multi Edit", "Notebook Edit", "Todo Write"
// Confirmed display-form on mycobeta 2026-05-12 — the WebSearch
// permission dialog body line was `   Web Search("Shenzhen weather…")`.
// Callers should strip whitespace from the captured tool name before
// matching against allow/deny patterns (which use the canonical API form).
//
// Keep this roster in sync with claude code's known tool set.
const PERMISSION_TOOL_RE =
  /^(?:Allow|Run|Approve)?\s*(Bash|Edit|Write|Read|Multi ?Edit|Glob|Grep|Web ?Fetch|Web ?Search|Notebook ?Edit|Todo ?Write|Task|Agent|SlashCommand)\b/i;

// Input/target line — claude shows the command/path on its own line
// prefixed by `>` (plain) or `❯` (highlighted cursor). The capture is the
// rest of the line. We pick the FIRST such line in the dialog body.
const PERMISSION_INPUT_RE = /^\s*[>❯]\s+(.+)$/;

// ───────────────────────────────────────────────────────────────────────
// pty.detectClaudeMode — reading claude's bottom-of-screen status hint
// to decide auto-toggle to accept-edits mode.
// ───────────────────────────────────────────────────────────────────────

// Observed status-bar variants (lower-cased, partial line matches OK):
//   "⏵⏵ accept edits on (shift+tab to cycle)"
//   "⏵⏵ auto-accept edits on (shift+tab to cycle)"
//   "⏵⏵ auto mode on (shift+tab to cycle)"           ← seen after picking the plan-confirm
//                                                       "Yes, and use auto mode" option
//   "⏸ plan mode on (shift+tab to cycle)"
//   "bypass permissions mode on (shift+tab to cycle)"  (only with the
//      `--dangerously-skip-permissions` flag — we don't use it under
//      root, but the line is harmless to recognise)
// The status bar can also carry trailing decorations like
// " · esc to interrupt", " IDE extension install failed",
// " You've used 76% of your weekly limit", and an "◉ xhigh · /effort"
// chip. None of those break the regexes since they're partial matches.
// Absence of any of these = default mode.
const MODE_ACCEPT_RE = /accept edits|auto-accept|auto edit|auto mode/i;
const MODE_PLAN_RE = /plan mode/i;
const MODE_BYPASS_RE = /bypass permissions/i;

// ───────────────────────────────────────────────────────────────────────
// Status / liveness indicators — useful for "is claude busy?" heuristics
// without parsing the JSONL transcript.
// ───────────────────────────────────────────────────────────────────────

// Claude renders a per-turn spinner that goes through two visible
// shapes:
//
//   ACTIVE (present-continuous, -ing):
//     "✽ Moonwalking…"  "· Thundering…"  "✽ Crunching…"
//     "✽ Working for 3s"  "· Cerebrating for 12s · ↓ 3.4k tokens"
//
//   DONE-WITH-PHASE (past-tense, -ed):
//     "✻ Brewed for 51s"  "✻ Baked for 15s"  "✻ Cooked for 13s"
//     "✻ Thought for 12s"
//
// Critically these two shapes are NOT equivalent for the typing
// indicator. The -ing form means claude is mid-turn and the wall
// clock is still advancing. The -ed form is a SUMMARY of a phase
// that just finished — it lingers above the input prompt for a
// while AFTER claude is fully idle, especially for long phases
// ("Brewed for 1m 25s"). Treating -ed as "still running" caused
// the typing dots to stick indefinitely after the turn ended.
//
// SPINNER_DURATION_RE / SPINNER_RUNNING_RE now match -ing only.
// They drive the "claude is busy NOW" signal that gates the typing
// indicator. The -ed shape is captured separately for future use
// (e.g., a "last phase took Xs" hint), but it does NOT extend the
// indicator's lifetime.
//
// Duration tail tolerates compound formats: "25s", "1m 25s", "2h 5m".
//
// Glyph class — covers the full set claude cycles through. The
// teardrop-asterisk (✢=U+2722) and friends were missing initially,
// so a turn like "✢ Writing exportRoutes…" never registered as a
// spinner and the chat-pane status went silent mid-phase. Sources:
//   - U+2731..U+273C dingbat asterisks  (✱ ✲ ✳ ✴ ✵ ✶ ✷ ✸ ✹ ✺ ✻ ✼)
//   - U+2722..U+2725 teardrop/balloon/club asterisks  (✢ ✣ ✤ ✥)
//   - U+273D..U+273F other dingbat stars/florets       (✽ ✾ ✿)
//   - Plus bullets/dots claude has used historically:   · • ▮ ⏳ ✦ ✺
const SPINNER_GLYPH_CLASS = '[✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿✢✣✤✥✦·•▮⏳]';
const SPINNER_DURATION_RE = new RegExp(`${SPINNER_GLYPH_CLASS}\\s*[A-Z][a-z]+ing\\s+for\\s+(?:\\d+h\\s+)?(?:\\d+m\\s+)?\\d+s\\b`);
const SPINNER_RUNNING_RE  = new RegExp(`${SPINNER_GLYPH_CLASS}\\s*[A-Z][a-z]+ing\\b`);
const SPINNER_DONE_RE     = new RegExp(`${SPINNER_GLYPH_CLASS}\\s*[A-Z][a-z]+ed\\s+for\\s+(?:\\d+h\\s+)?(?:\\d+m\\s+)?\\d+s\\b`);

// (Multi-line continuation block — ⎿ corner + indented checklist rows
// — was added then reverted: the chat-pane status strip only shows the
// top spinner line. The detail block is still visible to anyone who
// flips to the live xterm view.)

// Claude's welcome / resume banner (inside a box-drawn frame). We don't
// rely on this for routing yet, but it's handy when classifying snapshot
// dumps and for any future "session is fresh" heuristics.
const WELCOME_BANNER_RE =
  /Welcome (?:back|to Claude Code)/i;

// "You've used X% of your weekly limit · resets <date>" — surfaced in
// the bottom status bar. Useful for a future "rate limit warning"
// indicator. Not branched on yet.
const LIMIT_WARNING_RE =
  /You['’]ve used\s+\d+%\s+of your weekly limit/i;

// ───────────────────────────────────────────────────────────────────────
// In-dialog TUI key hints — visual instructions that claude code paints
// under interactive widgets. We don't want them ending up inside
// option labels OR being mistaken for option lines.
//   "Enter to confirm · Esc to cancel"
//   "ctrl-g to edit in Vim · ~/.claude/plans/<file>"
//   "shift+tab to approve with this feedback"
//   "Tab/Arrow keys to navigate"
//   "esc to interrupt"
// Currently unused at scan time but kept here for the next time we
// need to suppress TUI noise from a captured label.
// ───────────────────────────────────────────────────────────────────────
const TUI_KEY_HINT_RE =
  /^\s*(?:Enter\s+to|Esc\s+to|ctrl-[a-z]\s+to|shift\+tab\s+to|Tab\/Arrow\s+keys|esc\s+to interrupt)\b/i;

// ───────────────────────────────────────────────────────────────────────
// Plan-mode wizard tab bar — the multi-step picker claude code shows
// when it's interviewing the user before generating a plan.
//
//   ←  ☒ Feature  ☐ Stack  ✔ Submit  →
//
// Two reasons this needs its own pattern:
//
//   1. SIGNAL — when the bar is on screen, we KNOW a wizard is active.
//      The cursor `❯` on the wizard's review/submit step is NOT always
//      on the numbered-option line (claude places it on the active
//      breadcrumb item or on the ←/→ navigators), so the generic
//      MENU_CURSOR_RE guard rejects the run and the chat broadcast
//      misses the "Submit answers / Cancel" picker. Treating the tab
//      bar as a strong wizard signal lets us accept the numbered options
//      below it without requiring an option-line cursor.
//
//   2. FALSE-POSITIVE SAFETY — the cursor guard is there to reject
//      numbered prose ("1. set up DB schema  2. add bus …") inside a
//      regular assistant turn. The wizard tab bar is unmistakable —
//      `← / →` arrow nav + ☐/☒/✔ step glyphs + step labels — and
//      doesn't appear in prose, so it's safe to use as an alternative
//      menu signal.
//
// Glyph class covers the variants claude has been observed using for
// step state: ☐ (todo), ☒ (selected/done), ✔/✓ (committed), ◯/●,
// plus uppercase X for terminals that don't render ☒.
//
// Shape: `←` … `→` framing the bar, with the body containing AT LEAST
// TWO step glyphs (one is too easy — a stray ← Back arrow next to a
// status ☐ doesn't qualify). We don't anchor the glyphs to specific
// positions because claude code inserts a `❯` selection cursor at
// the active step (e.g. "←  ☒ Feature  ☐ Stack ❯ ✔ Submit  →"), and
// a strict label-after-glyph pattern would refuse to match across
// the cursor.
const WIZARD_TAB_BAR_RE =
  /←[^←→]*[☐☒✔✓◯●xX][^←→]*[☐☒✔✓◯●xX][^←→]*→/;

// ───────────────────────────────────────────────────────────────────────
// pty.handleMenuSubmit — arrow-navigating to the Submit row of a
// multi-select dialog. We must count the cursor → Submit row distance
// EXACTLY; an overshoot wraps in claude's TUI (cursor lands back on
// option 1) and the trailing Enter resolves the wrong row.
// ───────────────────────────────────────────────────────────────────────

// Cursor row in a multi-select dialog. The cursor glyph `❯` alone is
// not specific enough — under some redraw scenarios (e.g. plan-mode
// wizard breadcrumb with its own `❯` step pointer, or claude's TUI
// re-painting over a previous dialog without fully clearing the alt-
// screen) more than one `❯` is on the visible viewport, and the
// "first occurrence" heuristic latches onto whichever is highest, NOT
// onto the active option row. That inflates the cursor→Submit distance
// and the paced down-arrow burst overshoots.
//
// Anchor on what's distinctive about a multi-select OPTION row: it
// carries a `[ ]`/`[x]` checkbox after the cursor. The checkbox glyph
// class mirrors MENU_CHECKBOX_RE so a themed/CJK build that swaps in
// `[✔]` or `[●]` still matches.
const MULTI_SELECT_CURSOR_RE =
  /❯[^[\]]*\[\s*[xX✓✔●▪◉█* ]?\s*\]/;

// Submit row in a multi-select dialog. Tight anchor: the LINE must
// contain ONLY the submit-action label (with whitespace padding on
// either side). The old `\b(submit|done|…)\b\s*$/` shape also matched
// footer hint text like "Tab/Arrow keys to navigate · Enter to submit"
// — which ends in "submit" and gets the "last match wins" prize,
// pushing submitRow PAST the real Submit row by several lines. The
// nav burst then overshoots and the cursor wraps.
//
// `done`/`continue`/`finish`/`ok`/`next` are the labels Ink's
// SelectInput-style wizards have been observed using for the
// "advance from this question to the next" affordance. `next` is
// load-bearing: claude code's plan-mode interview wizard renders
// "Next" as the submit row of each multi-select question (verified
// 2026-05-13 on mycobeta demo010 — the Features question's submit
// row was the indented "Next" below option 5 "Type something").
// Without `next` in the alternation, _findSubmitNavCount fell back to
// the 6-row fixed count, the cursor wrapped past the actual Next row,
// and claude received the wrong row's Enter — interpreted as decline.
// If a future build packs Submit next to a separator ("Submit │
// Cancel"), this regex will NEED to be widened — intentionally not
// preemptively done so we don't reintroduce the footer-text
// false-positive.
const SUBMIT_ROW_RE =
  /^\s*(?:submit|done|continue|finish|ok|next)\s*$/i;

// ───────────────────────────────────────────────────────────────────────
// Tool invocation + corner-block chrome — exposed for future server-side
// consumers (owner tool-callout broadcast, error highlighter). Not yet
// scanned by any caller; the export is the wedge so the next patch only
// touches the consumer.
// ───────────────────────────────────────────────────────────────────────

// Tool-invocation header rendered above the result of each tool call:
//
//   "● Bash(npm test)"
//   "● Read(/wks/kkrazy/myco/server/src/pty.js)"
//   "● TaskCreate"
//   "● Web Search(\"Shenzhen weather…\")"
//   "● Agent(Map myco architecture for diagram)"
//
// Group 1 = tool name (camelCase API form, or display form with a space).
// Group 2 = argument blob (the original input verbatim; may contain
// quotes, slashes, parens-aware truncation downstream). The capturing
// parens-balance is intentionally cheap — we accept "(…)" of any
// contents up to the FIRST `)` because claude code's renderer never
// nests parens inside a tool invocation header (long args are truncated
// with `…)`).
//
// The leading "● " glyph is a U+25CF (BLACK CIRCLE). The `^\s*` anchor
// lets a future viewport-scan match this on indented lines too — claude
// indents continuation tools after the first when rendering a chain.
const TOOL_INVOCATION_RE =
  /^\s*●\s+([A-Z][A-Za-z ]+?)\(([^)]*)\)/;

// Corner-glyph status block rendered under a tool callout to deliver a
// terse summary. Observed labels:
//
//   "⎿  Error: Exit code 127"           ← bash failures, very common
//   "⎿  Tip: Use /memory to view…"      ← claude's nudges
//   "⎿  Did 1 search in 4s"             ← Web Search completion
//   "⎿  Note: only the first 5 entries" ← truncation notice
//   "⎿  Warning: file looks binary"     ← Read/Edit caveats
//   "⎿  Result: 3 files changed"        ← TaskCreate summary
//
// `⎿` is U+23BF (DRAWINGS LIGHT UP AND HORIZONTAL). The `\s+` after the
// glyph tolerates the customary 2-space indent that follows it but also
// matches when claude collapses to a single space (some terminals).
//
// Group 1 = label (Error/Tip/Did/Note/Warning/Result). Group 2 = body.
// `Did` is special — claude's Web Search uses "Did N <thing> in Xs"
// where the colon is missing. The alternation keeps both shapes; the
// optional `:` is consumed by the alternative branch.
const CORNER_BLOCK_RE =
  /^\s*⎿\s+(Error|Tip|Note|Warning|Result)(?::\s*(.*))?$|^\s*⎿\s+(Did)\s+(.*)$/;

// ───────────────────────────────────────────────────────────────────────
// Status-line decoration chrome — consumed by _extractStatus in pty.js
// to decompose the spinner line into structured fields. Each regex
// targets ONE dimension of the status bar so a viewer can render chips.
// ───────────────────────────────────────────────────────────────────────

// Token-volume trailer in the spinner line:
//
//   "✽ Cerebrating for 12s · ↓ 3.4k tokens"
//   "· Thundering… · ↑ 4.2k tokens"
//   "✽ Working for 47s · ↓ 7.6k tokens"
//   "✻ Brewed for 51s · ↓ 1.1k tokens"
//
// Group 1 = direction glyph (↑ U+2191 = uplink, ↓ U+2193 = downlink).
// Group 2 = numeric count. Group 3 = scale suffix (`k`/`m`/empty). The
// downstream caller multiplies to integer tokens. We accept either
// "tokens" or "token" (singular form rare but observed once).
const STATUS_TOKEN_TRAILER_RE =
  /([↑↓])\s*(\d+(?:\.\d+)?)\s*([km])?\s+tokens?/i;

// Interrupt-state trailer — present on the status bar ONLY while claude
// is mid-turn AND can be aborted:
//
//   "✽ Cerebrating for 12s · esc to interrupt"
//   "✻ Working for 3s · esc to interrupt"
//
// Distinguished from the menu-dialog hint `TUI_KEY_HINT_RE` by the
// preceding `·` middle-dot separator (U+00B7) — only the spinner-bar
// trailer uses the dot-bullet, dialog hints use newlines or sentence
// punctuation.
const STATUS_INTERRUPT_RE =
  /·\s*esc\s+to\s+interrupt/i;

// Effort chip rendered in the bottom-right of the status bar when the
// `/effort` setting is set:
//
//   "◉ xhigh · /effort"
//   "◉ medium"
//   "◉ high · /effort"
//
// Group 1 = effort level keyword (xhigh, high, medium, low). `◉` is
// U+25C9 (FISHEYE). The `· /effort` tail is decorative — claude renders
// it as a click hint on terminals that support mouse — and matches an
// optional non-capturing tail.
const EFFORT_CHIP_RE =
  /◉\s+([a-z]+)(?:\s*·\s*\/effort)?/i;

module.exports = {
  MENU_OPT_MARKER_RE,
  MENU_CHECKBOX_RE,
  MENU_CURSOR_RE,
  MENU_MAX_OPTION_GAP_LINES,
  MENU_QUESTION_TAIL_RE,
  MENU_QUESTION_VERB_RE,
  MENU_KIND_PERMISSION_RE,
  MENU_KIND_PLAN_RE,
  TRUST_DIALOG_RE,
  PERMISSION_TOOL_RE,
  PERMISSION_INPUT_RE,
  MODE_ACCEPT_RE,
  MODE_PLAN_RE,
  MODE_BYPASS_RE,
  SPINNER_DURATION_RE,
  SPINNER_RUNNING_RE,
  SPINNER_DONE_RE,
  WELCOME_BANNER_RE,
  LIMIT_WARNING_RE,
  TUI_KEY_HINT_RE,
  WIZARD_TAB_BAR_RE,
  MULTI_SELECT_CURSOR_RE,
  SUBMIT_ROW_RE,
  TOOL_INVOCATION_RE,
  CORNER_BLOCK_RE,
  STATUS_TOKEN_TRAILER_RE,
  STATUS_INTERRUPT_RE,
  EFFORT_CHIP_RE,
  MENU_OPT_LINE_RE,
};
