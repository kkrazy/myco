// Per-session allow/deny lists for Claude's tool-use permission dialogs.
// When Claude pauses on a "Allow Bash command?" / "Allow Edit?" prompt,
// AgentSession.canUseTool / PreToolUse hook in agent-session.js calls
// into here to decide whether to auto-pick Yes (allow), auto-pick No
// (deny), or fall through to a chat broadcast for the user to /decide
// manually.
//
// Pattern syntax (subset of Claude Code's own settings.json convention):
//   "Read"             — any Read invocation
//   "Edit"             — any Edit invocation
//   "Bash(git)"        — any Bash that starts with `git`
//   "Bash(./test.sh)"  — any Bash that starts with `./test.sh`
//   "Bash(*)"          — any Bash (use sparingly)
//   "Bash(git:*)"      — alias for "Bash(git)" (Claude Code's "everything after" form)

// Late-bound: attach.js → permissions.js is part of a require cycle
// through sessions.js, so destructuring loadStore/saveStore at import
// time would capture `undefined`. Always reach through `sessionsMod.fn`
// at call time.
const sessionsMod = require('./sessions');
const loadStore = (...a) => sessionsMod.loadStore(...a);
const saveStore = (...a) => sessionsMod.saveStore(...a);

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

// Object.assign rather than `module.exports = {…}` so attach.js (which
// captures `const permissions = require('./permissions')` early in a
// circular chain via sessions.js → attach.js → permissions.js) sees the
// populated exports object. Replacing module.exports would leave the
// other side of the cycle holding the empty pre-cycle reference.
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
});
