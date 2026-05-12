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
//   "⏸ plan mode on (shift+tab to cycle)"
//   "bypass permissions mode on (shift+tab to cycle)"  (only with the
//      `--dangerously-skip-permissions` flag — we don't use it under
//      root, but the line is harmless to recognise)
// Absence of any of these = default mode.
const MODE_ACCEPT_RE = /accept edits|auto-accept|auto edit/i;
const MODE_PLAN_RE = /plan mode/i;
const MODE_BYPASS_RE = /bypass permissions/i;

// ───────────────────────────────────────────────────────────────────────
// Status / liveness indicators — useful for "is claude busy?" heuristics
// without parsing the JSONL transcript.
// ───────────────────────────────────────────────────────────────────────

// Claude renders a per-turn spinner like "✻ Worked for 12s …" while a
// tool is running. The verb varies between releases ("Thinking",
// "Working", "Reading", "Searching", etc.); the "for <Ns>" tail is the
// stable signal.
const SPINNER_DURATION_RE =
  /[✻✦✺·•▮]\s*(?:Worked|Working|Thinking|Reading|Writing|Searching|Editing|Running|Generating|Considering)\s+for\s+\d+s\b/i;

// Claude's welcome / resume banner (inside a box-drawn frame). We don't
// rely on this for routing yet, but it's handy when classifying snapshot
// dumps and for any future "session is fresh" heuristics.
const WELCOME_BANNER_RE =
  /Welcome (?:back|to Claude Code)/i;

module.exports = {
  MENU_OPT_MARKER_RE,
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
  WELCOME_BANNER_RE,
};
