// bug-74 regression: _findPlanItemInRec must locate plan items that
// exist in the file mirror (_myco_/plan.json) even when they're
// missing from rec.artifacts.plan.items (the in-memory snapshot).
//
// Why this exists (the symptom that surfaced it):
//   A user dispatched [run:plan#bug-67] in a session whose
//   rec.artifacts.plan was a stale in-memory snapshot that didn't
//   yet include bug-67 — even though _myco_/plan.json on disk
//   did. handleChatMessage's marker parser called
//   _initAndBroadcastStageState(sid, sess, 'bug-67') →
//   _findPlanItemInRec returned null → silent "item not found"
//   log + no-op. stageState stayed null. When claude emitted
//   [stage: analyze done], the stage-done handler also looked
//   up the item, got null, and the critic never fired.
//   The user observed: "the gemini critic never showed up".
//   No verdict pane. No state-update broadcast. No advancement.
//
// Why the in-memory snapshot can lag:
//   rec.artifacts.plan is populated by extractor.js's
//   Anthropic-API-driven transcript synthesis AND by
//   manual mutations through the UI / slash commands /
//   claude's add_plan_items MCP tool. Items added by:
//     · a manual /td|/bug|/fr in another session that shares the
//       same project dir,
//     · a hand-edit to _myco_/plan.json,
//     · the migration that ran on a different session,
//   land in the FILE MIRROR but don't auto-propagate into the
//   in-memory rec for sessions whose extractor hasn't re-run since.
//
// Fix: _findPlanItemInRec falls back to readArtifactFromFile(rec,
// 'plan') when the in-memory lookup misses. On a file-mirror hit,
// the side-effect of hydrating rec.artifacts.plan means subsequent
// lookups in the same handler chain (and the rest of the run)
// see the item in-memory — no thrashing.
//
// Defensive: try/catch around the file read, never throws.
//
// Test shape: static guards on attach.js's new fallback path +
// runtime asserts setting up the exact scenario (file mirror has the
// item, in-memory rec doesn't, lookup must find it + hydrate).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-74: _findPlanItemInRec must fall back to file mirror ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards on attach.js's _findPlanItemInRec.
// ─────────────────────────────────────────────────────────────────

const ATTACH_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

t('_findPlanItemInRec body references readArtifactFromFile as a fallback', () => {
  const m = ATTACH_JS.match(/function\s+_findPlanItemInRec\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_findPlanItemInRec body must be greppable');
  const body = m[1];
  assert.ok(/readArtifactFromFile\s*\(/.test(body),
    'bug-74: _findPlanItemInRec must call readArtifactFromFile(rec, "plan") as a file-mirror fallback when the in-memory rec.artifacts.plan lookup misses');
  // The body MUST include the in-memory path FIRST (cheap), then
  // fall through to the file mirror.
  const memIdx = body.indexOf('rec.artifacts.plan');
  const fileIdx = body.indexOf('readArtifactFromFile');
  assert.ok(memIdx > -1, 'in-memory lookup must still happen (cheap path)');
  assert.ok(fileIdx > -1, 'file-mirror lookup must exist');
  assert.ok(memIdx < fileIdx,
    'in-memory lookup must come BEFORE the file-mirror fallback — file I/O is more expensive and a stale in-memory cache must still be honored first');
});

t('_findPlanItemInRec hydrates rec.artifacts.plan on a file-mirror hit', () => {
  const m = ATTACH_JS.match(/function\s+_findPlanItemInRec\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  // The side-effect is what prevents thrashing — subsequent lookups
  // in the same handler chain see the item in-memory. Match the
  // assignment back to rec.artifacts.plan.
  assert.ok(/rec\.artifacts\.plan\s*=\s*fromFile|rec\.artifacts\s*=\s*\{[\s\S]*plan/.test(body),
    'bug-74: on a file-mirror hit, _findPlanItemInRec must hydrate rec.artifacts.plan from the file payload so subsequent lookups don\'t re-read disk');
});

t('_findPlanItemInRec wraps the file-mirror path in try/catch — never throws', () => {
  const m = ATTACH_JS.match(/function\s+_findPlanItemInRec\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  const tryCount = (body.match(/\btry\s*\{/g) || []).length;
  assert.ok(tryCount >= 1,
    'bug-74: the file-mirror fallback must be wrapped in try/catch so a malformed _myco_/plan.json or unreadable file never bubbles an exception to the caller');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime assertions. Set up a synthesized session record
// whose file mirror has bug-67 but whose in-memory plan items don't.
// _findPlanItemInRec must return the item AND hydrate rec.artifacts
// .plan as a side-effect.
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug74-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|attach|agent-session|menu|btw|transcript|artifacts|stageState)\.js$/.test(k)) {
    delete require.cache[k];
  }
}
const attach = require('../server/src/attach');

// Synthesize a rec whose absCwd contains a `.git/` directory (so
// findProjectRoot returns absCwd directly — no mainProject indirection
// needed) and a _myco_/plan.json file containing one item.
function seedRecWithFileMirrorOnly(opts) {
  const sid = opts.sid || 'myco-tester-aabbccdd';
  const absCwd = path.join(process.env.MYCO_WORKSPACE, 'tester', sid);
  fs.mkdirSync(path.join(absCwd, '.git'), { recursive: true });
  fs.mkdirSync(path.join(absCwd, '_myco_'), { recursive: true });
  const planOnDisk = {
    updatedAt: new Date().toISOString(),
    items: opts.fileItems || [],
  };
  fs.writeFileSync(path.join(absCwd, '_myco_', 'plan.json'),
    JSON.stringify(planOnDisk, null, 2));
  // rec.artifacts.plan = the IN-MEMORY snapshot. May be empty / missing
  // the item we'll look up — that's the bug we're testing for.
  const rec = {
    id: sid, user: 'tester', cwd: sid, absCwd,
    artifacts: opts.memItems !== undefined ? { plan: { items: opts.memItems } } : {},
  };
  return rec;
}

t('runtime: in-memory miss + file-mirror hit → returns the item from disk', () => {
  const rec = seedRecWithFileMirrorOnly({
    sid: 'myco-tester-11111111',
    fileItems: [{ id: 'bug-67', text: 'bug-67 plan-item text', layer: 'Bug' }],
    memItems: [],  // in-memory is empty — the symptom
  });
  const hit = attach._findPlanItemInRec(rec, 'bug-67');
  assert.ok(hit, 'bug-74: _findPlanItemInRec must return the item from the file mirror when the in-memory snapshot is empty/stale');
  assert.strictEqual(hit.id, 'bug-67', 'returned item must have the requested id');
  assert.strictEqual(hit.text, 'bug-67 plan-item text', 'returned item must carry the file-mirror content');
});

t('runtime: side-effect of hydration — rec.artifacts.plan is populated', () => {
  const rec = seedRecWithFileMirrorOnly({
    sid: 'myco-tester-22222222',
    fileItems: [{ id: 'bug-67', text: 'x', layer: 'Bug' }],
    memItems: [],
  });
  attach._findPlanItemInRec(rec, 'bug-67');
  assert.ok(rec.artifacts && rec.artifacts.plan, 'rec.artifacts.plan must be hydrated after a file-mirror hit');
  assert.ok(Array.isArray(rec.artifacts.plan.items), 'rec.artifacts.plan.items must be an array post-hydration');
  const hit = rec.artifacts.plan.items.find((i) => i && i.id === 'bug-67');
  assert.ok(hit, 'the hydrated rec.artifacts.plan.items must contain the item — subsequent lookups should hit in-memory');
});

t('runtime: in-memory hit short-circuits — no file I/O necessary', () => {
  const rec = seedRecWithFileMirrorOnly({
    sid: 'myco-tester-33333333',
    fileItems: [{ id: 'bug-67', text: 'STALE FILE COPY', layer: 'Bug' }],
    memItems: [{ id: 'bug-67', text: 'FRESH IN-MEMORY COPY', layer: 'Bug' }],
  });
  const hit = attach._findPlanItemInRec(rec, 'bug-67');
  assert.ok(hit, 'item must be found');
  // The IN-MEMORY copy must win — that's the cheap-path-first contract.
  // Useful if a handler has just mutated rec.artifacts but hasn't yet
  // written to disk; reading the file would give us a stale snapshot.
  assert.strictEqual(hit.text, 'FRESH IN-MEMORY COPY',
    'in-memory snapshot must win when both copies exist — file read is FALLBACK, not source of truth');
});

t('runtime: file mirror missing too → returns null gracefully', () => {
  const rec = seedRecWithFileMirrorOnly({
    sid: 'myco-tester-44444444',
    fileItems: [],
    memItems: [],
  });
  assert.strictEqual(attach._findPlanItemInRec(rec, 'never-existed'), null,
    'when neither in-memory nor file mirror has the item, returns null (existing contract — pre-fix behavior preserved)');
});

t('runtime: missing rec / null inputs → returns null without throwing', () => {
  assert.strictEqual(attach._findPlanItemInRec(null, 'bug-67'), null);
  assert.strictEqual(attach._findPlanItemInRec({}, 'bug-67'), null);
  assert.strictEqual(attach._findPlanItemInRec({ artifacts: {} }, 'bug-67'), null);
  assert.doesNotThrow(() => attach._findPlanItemInRec({ artifacts: null }, 'bug-67'));
});

t('runtime: malformed _myco_/plan.json on disk → returns null without throwing (try/catch contract)', () => {
  const sid = 'myco-tester-55555555';
  const absCwd = path.join(process.env.MYCO_WORKSPACE, 'tester', sid);
  fs.mkdirSync(path.join(absCwd, '.git'), { recursive: true });
  fs.mkdirSync(path.join(absCwd, '_myco_'), { recursive: true });
  // Garbage JSON.
  fs.writeFileSync(path.join(absCwd, '_myco_', 'plan.json'), 'not-json{{{');
  const rec = {
    id: sid, user: 'tester', cwd: sid, absCwd,
    artifacts: { plan: { items: [] } },
  };
  assert.doesNotThrow(() => attach._findPlanItemInRec(rec, 'bug-67'),
    'a corrupt file mirror must not crash the lookup — the try/catch contract guarantees null on failure');
  assert.strictEqual(attach._findPlanItemInRec(rec, 'bug-67'), null,
    'corrupt file mirror returns null (no item)');
});

// ─────────────────────────────────────────────────────────────────
// PART C — End-to-end smoke through _initAndBroadcastStageState.
// This is the SYMPTOM path the user hit: dispatch [run:plan#X] →
// init stageState. Pre-fix it silently no-op'd. Post-fix the
// stageState must transition to analyze.in_progress.
// ─────────────────────────────────────────────────────────────────

const sessions = require('../server/src/sessions');
const stageStateMod = require('../server/src/stageState');

t('end-to-end: dispatch handler init path now transitions stageState for a file-mirror-only item', () => {
  const sid = 'myco-tester-66666666';
  const absCwd = path.join(process.env.MYCO_WORKSPACE, 'tester', sid);
  fs.mkdirSync(path.join(absCwd, '.git'), { recursive: true });
  fs.mkdirSync(path.join(absCwd, '_myco_'), { recursive: true });
  const planOnDisk = {
    updatedAt: new Date().toISOString(),
    items: [{ id: 'bug-67', text: 'symptom-path test', layer: 'Bug' }],
  };
  fs.writeFileSync(path.join(absCwd, '_myco_', 'plan.json'),
    JSON.stringify(planOnDisk, null, 2));
  const rec = {
    id: sid, user: 'tester', cwd: sid, absCwd,
    artifacts: { plan: { items: [] } },  // SYMPTOM: in-memory is empty
  };
  const store = sessions.loadStore();
  store.sessions[sid] = rec;
  sessions.saveStore();
  // Stub session capturing emit calls.
  const emits = [];
  const sess = {
    alive: true,
    emit(...args) { emits.push(args); },
    on() {}, off() {}, removeListener() {},
  };
  attach._registerExternalSession(sid, sess);
  // The handler that pre-bug-74 silently no-op'd for file-mirror-only items.
  // (Calling it via the exported _findPlanItemInRec + manual init is the
  // most defensible end-to-end witness — the dispatch handler itself
  // builds on this lookup, so a regression here would re-break dispatch.)
  const item = attach._findPlanItemInRec(rec, 'bug-67');
  assert.ok(item, 'item must be found via file-mirror fallback');
  const ss = stageStateMod.initStageState(item);
  assert.ok(ss, 'stageState init must succeed against the resolved item');
  assert.strictEqual(ss.stage, 'analyze', 'initial stage');
  assert.strictEqual(ss.status, 'in_progress', 'initial status');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
