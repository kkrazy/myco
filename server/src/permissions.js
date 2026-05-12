// Per-session allow/deny lists for Claude's tool-use permission dialogs.
// When Claude pauses on a "Allow Bash command?" / "Allow Edit?" prompt,
// the menu-interceptor in pty.js calls into here to decide whether to
// auto-pick Yes (allow), auto-pick No (deny), or fall through to a chat
// broadcast for the user to /decide manually.
//
// Pattern syntax (subset of Claude Code's own settings.json convention):
//   "Read"             — any Read invocation
//   "Edit"             — any Edit invocation
//   "Bash(git)"        — any Bash that starts with `git`
//   "Bash(./test.sh)"  — any Bash that starts with `./test.sh`
//   "Bash(*)"          — any Bash (use sparingly)
//   "Bash(git:*)"      — alias for "Bash(git)" (Claude Code's "everything after" form)

// Late-bound: pty.js → permissions.js is part of a require cycle through
// sessions.js, so destructuring loadStore/saveStore at import time would
// capture `undefined`. Always reach through `sessionsMod.fn` at call time.
const sessionsMod = require('./sessions');
const loadStore = (...a) => sessionsMod.loadStore(...a);
const saveStore = (...a) => sessionsMod.saveStore(...a);

// TUI-output regexes live in pty-patterns.js (one home so future tweaks
// for new claude-code rendering quirks all land in the same file).
const { PERMISSION_TOOL_RE, PERMISSION_INPUT_RE } = require('./pty-patterns');

// Conservative default — the user explicitly chose this baseline. Common
// safe-by-design tools plus a handful of build / test / git Bash families.
// Anything not on the list (and not on rec.denyList) is auto-denied; the
// user adds patterns at runtime via /allow.
const DEFAULT_ALLOW = Object.freeze([
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'TodoWrite',
  'NotebookEdit',
  'Bash(git)',
  'Bash(npm)',
  'Bash(yarn)',
  'Bash(node)',
  'Bash(pnpm)',
  'Bash(./test.sh)',
  'Bash(./deploy.sh)',
  'Bash(./test-browser.sh)',
  'Bash(ls)',
  'Bash(pwd)',
  'Bash(cat)',
  'Bash(echo)',
]);

const DEFAULT_DENY = Object.freeze([]);

// Backfill the lists on a session record. Called the first time a session
// is touched after this feature ships — existing sessions in the store
// won't have allowList/denyList until we set them.
function ensureSessionLists(rec) {
  if (!rec) return;
  if (!Array.isArray(rec.allowList)) rec.allowList = DEFAULT_ALLOW.slice();
  if (!Array.isArray(rec.denyList))  rec.denyList = DEFAULT_DENY.slice();
}

// Decide what to do with a (tool, input) pair on a given session.
// Returns 'allow' | 'deny' | 'ask'.
//   allow / deny → auto-respond, brief chat note
//   ask          → broadcast the full menu to chat, user picks via /decide
// We default unmatched tools to 'ask' (not auto-deny) so the user can
// actually decide per-dialog instead of having to /allow-then-retry
// every novel tool Claude wants to run.
function decide(rec, tool, input) {
  if (!rec || !tool) return 'ask';
  ensureSessionLists(rec);
  // deny wins over allow so the user can pin a denial even if a broader
  // allow rule would match.
  for (const p of rec.denyList) {
    if (matchesPattern(p, tool, input)) return 'deny';
  }
  for (const p of rec.allowList) {
    if (matchesPattern(p, tool, input)) return 'allow';
  }
  return 'ask';   // no match → user decides via /decide (or /allow + retry)
}

// Match a pattern against (tool, input). See module header for syntax.
function matchesPattern(pattern, tool, input) {
  const m = String(pattern || '').trim().match(/^([A-Za-z_]\w*)(?:\(([^)]*)\))?\s*$/);
  if (!m) return false;
  if (m[1].toLowerCase() !== String(tool).toLowerCase()) return false;
  const inner = m[2];
  if (inner == null) return true;                          // bare "Tool" matches all
  const stripped = inner.replace(/[:\s]?\*$/, '').trim();  // "git:*" → "git", "git" → "git"
  if (!stripped || stripped === '*') return true;          // "Tool()" / "Tool(*)" matches all
  const escaped = stripped.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '(?:\\s|$)');
  return re.test(String(input || '').trimStart());
}

// Mutators — called by /allow and /deny slash commands. Idempotent; also
// removes the pattern from the opposite list when added, so `/allow X`
// undoes a prior `/deny X` and vice versa.
function addAllow(rec, pattern) {
  ensureSessionLists(rec);
  rec.denyList = rec.denyList.filter((p) => p !== pattern);
  if (!rec.allowList.includes(pattern)) rec.allowList.push(pattern);
  saveStore();
}
function addDeny(rec, pattern) {
  ensureSessionLists(rec);
  rec.allowList = rec.allowList.filter((p) => p !== pattern);
  if (!rec.denyList.includes(pattern)) rec.denyList.push(pattern);
  saveStore();
}
function removePattern(rec, pattern) {
  ensureSessionLists(rec);
  rec.allowList = rec.allowList.filter((p) => p !== pattern);
  rec.denyList = rec.denyList.filter((p) => p !== pattern);
  saveStore();
}

function getSessionLists(sessionId) {
  const rec = loadStore().sessions[sessionId];
  if (!rec) return { allowList: DEFAULT_ALLOW.slice(), denyList: DEFAULT_DENY.slice() };
  ensureSessionLists(rec);
  return { allowList: rec.allowList.slice(), denyList: rec.denyList.slice() };
}

// Parse a Claude permission-dialog rawText (the menu's surrounding text)
// into the tool name and the input it wants to act on (Bash command, file
// path, etc.). Heuristic — patterns are loose because Claude Code's TUI
// varies slightly between dialog types.
function extractPermissionTarget(rawText) {
  if (!rawText) return null;
  const lines = String(rawText).split('\n');

  // Walk the lines looking for the tool name. Common patterns:
  //   "Allow Bash command?"
  //   "Bash command"
  //   "Edit file?"
  //   "Write file?"
  //   "Read file?"
  //   "Run Bash command?"
  let tool = null;
  for (const line of lines) {
    const m = line.trim().match(PERMISSION_TOOL_RE);
    // Normalise display-form tool names to their canonical no-space API
    // form ("Web Search" → "WebSearch") so they match the allow/deny
    // pattern syntax. See PERMISSION_TOOL_RE in pty-patterns.js.
    if (m) { tool = m[1].replace(/\s+/g, ''); break; }
  }
  if (!tool) return null;

  // The input is usually on a line prefixed with `>` or `❯`, or inside
  // the dialog box (sometimes the only non-decoration content above the
  // options). Take the first `>`-prefixed line; otherwise the longest
  // non-decoration line above the options.
  let input = '';
  for (const line of lines) {
    const m = line.match(PERMISSION_INPUT_RE);
    if (m) { input = m[1].trim(); break; }
  }
  return { tool, input };
}

// Object.assign rather than `module.exports = {…}` so pty.js (which captures
// `const permissions = require('./permissions')` early in a circular chain
// via sessions.js → pty.js → permissions.js) sees the populated exports
// object. Replacing module.exports would leave pty.js holding the empty
// pre-cycle reference.
Object.assign(module.exports, {
  DEFAULT_ALLOW,
  DEFAULT_DENY,
  ensureSessionLists,
  decide,
  matchesPattern,
  addAllow,
  addDeny,
  removePattern,
  getSessionLists,
  extractPermissionTarget,
});
