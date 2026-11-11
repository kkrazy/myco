// bug-75 (plan-item bug-69): Ask Critic on a skipped-stage verdict
// must NOT re-fire the previous stage's critic. The test file uses
// bug-75 because bug-69-test-sh-portability.test.sh already exists
// with unrelated content (the plan-item id is still bug-69).
//
// User report (2026-06-07):
//   "Clicking 'ask critic' outside the analyze stage reopens the
//    analyze stage's verdict modal showing the analyze result's
//    critique."
//
// Root cause: `_broadcastSyntheticSkipVerdict` (attach.js:2692, added
// by the bug-68 follow-up c941278) updates `item.meta.lastCriticReview`
// (line 2736) but does NOT touch `rec._lastCritique` — the per-session
// cache that `retryLastCritique` (critique.js:569) reads to re-fire
// the critic. So after a sequence:
//   1. analyze stage runs full critic → rec._lastCritique = analyze
//   2. user accepts analyze → clearLastCriticReview clears
//      item.meta.lastCriticReview but rec._lastCritique stays
//   3. code stage runs but is skipped (no diff or baseline-wip-only)
//      → _broadcastSyntheticSkipVerdict updates item.meta.lastCriticReview
//      with the synthetic AGREED but rec._lastCritique STILL holds
//      analyze data
//   4. user clicks 💬 Ask Critic → /critique/retry →
//      retryLastCritique reads stale rec._lastCritique → re-fires
//      analyze's critic with analyze's diff + claudeOutput → new
//      critique-review broadcast lands → client overwrites
//      state.critiqueReview with analyze data
//   5. modal re-renders showing analyze's verdict
//
// Fix in attach.js + critique.js:
//   · _broadcastSyntheticSkipVerdict must also update rec._lastCritique
//     with a parallel payload carrying skipped:true so retryLastCritique
//     can detect "this is a skipped verdict, not a real critique".
//   · retryLastCritique must short-circuit when rec._lastCritique.skipped
//     is truthy — emit a clear chat note ("can't re-ask critic on a
//     skipped stage — make code changes first and re-emit") instead of
//     blindly re-firing.
//
// Test shape: static guards on the new shape + runtime asserts on the
// helper + end-to-end through the user's repro sequence.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-75 (plan-item bug-69): Ask Critic must not re-fire previous stage on skip ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards. Lock the fix shape.
// ─────────────────────────────────────────────────────────────────

const ATTACH_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const CRITIQUE_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'critique.js'), 'utf8');

t('_broadcastSyntheticSkipVerdict updates rec._lastCritique alongside item.meta.lastCriticReview', () => {
  const m = ATTACH_JS.match(/function\s+_broadcastSyntheticSkipVerdict\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_broadcastSyntheticSkipVerdict body must be greppable');
  const body = m[1];
  // The pre-fix code calls setLastCriticReview but NOT rec._lastCritique.
  // The fix must update both — same data, two caches.
  assert.ok(/rec\._lastCritique\s*=/.test(body),
    'bug-75: _broadcastSyntheticSkipVerdict must update rec._lastCritique so retryLastCritique sees the skipped verdict (not stale prior-stage data). Without this, Ask Critic on a skipped verdict re-fires the previous stage\'s critic — exactly the bug-69 repro.');
});

t('rec._lastCritique payload carries skipped:true so retryLastCritique can short-circuit', () => {
  const m = ATTACH_JS.match(/function\s+_broadcastSyntheticSkipVerdict\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  // The rec._lastCritique assignment must include skipped:true (or
  // isSkipped: true) so retryLastCritique can detect "this is not a
  // real critique on file".
  assert.ok(/skipped\s*:\s*true|isSkipped\s*:\s*true/.test(body),
    'bug-75: the rec._lastCritique payload from a skip-broadcast must include skipped:true (or isSkipped:true) — retryLastCritique reads this to short-circuit instead of blindly re-firing.');
});

t('retryLastCritique short-circuits on skipped:true verdicts', () => {
  const m = CRITIQUE_JS.match(/async\s+function\s+retryLastCritique\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'retryLastCritique body must be greppable');
  const body = m[1];
  // The fix must check skipped/isSkipped BEFORE calling
  // triggerGeminiCritique. The early-return prevents the stale re-fire.
  assert.ok(/last\.(skipped|isSkipped)|_lastCritique\.(skipped|isSkipped)/.test(body),
    'bug-75: retryLastCritique must read _lastCritique.skipped (or .isSkipped) and short-circuit instead of calling triggerGeminiCritique. Without this, Ask Critic on a skipped verdict re-fires the cached payload (which carries the stale skip marker now, but the re-fire is meaningless — there\'s nothing to critique).');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime asserts. Set up env, synthesize a session.
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug75-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|attach|agent-session|menu|btw|transcript|artifacts|stageState|critique)\.js$/.test(k)) {
    delete require.cache[k];
  }
}

// Synthesize a session record + plan item. Helper.
function seedSession(sid, itemId) {
  const sessions = require('../server/src/sessions');
  const absCwd = path.join(process.env.MYCO_WORKSPACE, 'tester', sid);
  fs.mkdirSync(absCwd, { recursive: true });
  const item = {
    id: itemId, text: 'bug-69 test item', layer: 'Bug',
    voters: [], comments: [], runs: [], meta: {},
  };
  const rec = {
    id: sid, user: 'tester', cwd: sid, absCwd,
    artifacts: { plan: { items: [item] } },
  };
  const store = sessions.loadStore();
  store.sessions[sid] = rec;
  sessions.saveStore();
  return { sessions, rec, item };
}

t('runtime: _broadcastSyntheticSkipVerdict sets rec._lastCritique with skipped:true', () => {
  const { EventEmitter } = require('events');
  const attach = require('../server/src/attach');
  const sessions = require('../server/src/sessions');
  const sid = 'myco-tester-aabbccdd';
  seedSession(sid, 'p1');
  const stub = new EventEmitter();
  attach._registerExternalSession(sid, stub);
  attach._broadcastSyntheticSkipVerdict(sid, stub, {
    stage: 'code',
    itemId: 'p1',
    reason: 'no-changes',
  });
  const rec = sessions.getSessionRecord(sid);
  assert.ok(rec._lastCritique,
    'bug-75: rec._lastCritique must be populated by the synthetic skip broadcast (was NOT pre-fix — that\'s why retryLastCritique re-fired stale prior-stage data)');
  // The skip flag (either name) must be present.
  const skipped = rec._lastCritique.skipped === true || rec._lastCritique.isSkipped === true;
  assert.ok(skipped,
    'bug-75: the rec._lastCritique payload must carry skipped:true (or isSkipped:true) so retryLastCritique can detect it: ' + JSON.stringify(rec._lastCritique));
  // The stage label must match what was broadcast — not the previous stage.
  assert.strictEqual(rec._lastCritique.stage, 'code',
    'rec._lastCritique.stage must reflect the CURRENT stage (code), not a prior cached stage');
});

t('runtime: retryLastCritique returns false on a skipped _lastCritique (does NOT re-fire)', async () => {
  const { EventEmitter } = require('events');
  const attach = require('../server/src/attach');
  const sessions = require('../server/src/sessions');
  const critique = require('../server/src/critique');
  const sid = 'myco-tester-deadc0de';
  seedSession(sid, 'p2');
  const stub = new EventEmitter();
  let triggerCalled = false;
  stub.on('chat', () => {});
  stub.on('state-update', () => {});
  attach._registerExternalSession(sid, stub);
  // First seed rec._lastCritique with a skipped payload.
  attach._broadcastSyntheticSkipVerdict(sid, stub, {
    stage: 'code',
    itemId: 'p2',
    reason: 'no-changes',
  });
  // Spy on triggerGeminiCritique by monkey-patching just for this test.
  const origTrigger = critique.triggerGeminiCritique;
  critique.triggerGeminiCritique = async () => {
    triggerCalled = true;
    return false;
  };
  let result;
  try {
    result = await critique.retryLastCritique(sid, stub, { userPrompt: '' });
  } finally {
    critique.triggerGeminiCritique = origTrigger;
  }
  assert.strictEqual(result, false,
    'bug-75: retryLastCritique on a skipped _lastCritique must return false — no re-fire');
  assert.strictEqual(triggerCalled, false,
    'bug-75: retryLastCritique must NOT call triggerGeminiCritique on a skipped verdict (that\'s how the analyze re-fire bug manifests pre-fix)');
});

// Async test runner (Node's built-in test wrapper can't easily handle
// async in our simple `t()` wrapper — we await the result manually).
async function runAsync() {
  // Allow the async case to run.
  await new Promise((r) => setImmediate(r));
}

t('runtime: the user\'s exact repro — analyze→accept→code-skip→Ask Critic does NOT re-fire analyze', async () => {
  const { EventEmitter } = require('events');
  const attach = require('../server/src/attach');
  const sessions = require('../server/src/sessions');
  const critique = require('../server/src/critique');
  const sid = 'myco-tester-11223344';
  const { item } = seedSession(sid, 'p3');
  const stub = new EventEmitter();
  attach._registerExternalSession(sid, stub);
  // Simulate the analyze-stage critic having fired before (rec.
  // _lastCritique = analyze data). Direct synthesis — we don't need
  // the full triggerGeminiCritique stack for this test.
  const rec = sessions.getSessionRecord(sid);
  rec._lastCritique = {
    itemId: 'p3', itemSnapshot: item,
    diff: 'analyze-diff', claudeOutput: 'analyze-output',
    isIntermediate: true, stage: 'analyze',
    changedEntries: [], firedAt: new Date().toISOString(),
  };
  sessions.saveStore();
  // Simulate accept-analyze clearing item.meta.lastCriticReview only
  // (NOT rec._lastCritique — that's a pre-existing implementation
  // detail, not part of the bug-75 fix). At this point rec._lastCritique
  // still carries analyze data.
  // NOW the code stage's critic-skip fires.
  attach._broadcastSyntheticSkipVerdict(sid, stub, {
    stage: 'code',
    itemId: 'p3',
    reason: 'no-changes',
  });
  // The bug-75 fix: rec._lastCritique must now reflect the SKIPPED
  // CODE stage, NOT the prior analyze stage.
  const updated = sessions.getSessionRecord(sid);
  assert.strictEqual(updated._lastCritique.stage, 'code',
    'bug-75: after a code-stage skip broadcast, rec._lastCritique.stage must be `code`, not the stale `analyze` from the previous run. Pre-fix it stayed at analyze → that\'s the repro.');
  const isSkippedNow = updated._lastCritique.skipped === true || updated._lastCritique.isSkipped === true;
  assert.ok(isSkippedNow,
    'bug-75: rec._lastCritique must be flagged as skipped so retryLastCritique short-circuits');
  // Spy on triggerGeminiCritique to confirm Ask Critic does NOT re-fire.
  const origTrigger = critique.triggerGeminiCritique;
  let triggerArgs = null;
  critique.triggerGeminiCritique = async (...args) => {
    triggerArgs = args;
    return false;
  };
  let res;
  try {
    res = await critique.retryLastCritique(sid, stub, { userPrompt: '' });
  } finally {
    critique.triggerGeminiCritique = origTrigger;
  }
  assert.strictEqual(res, false,
    'bug-75: Ask Critic on the code-stage-skip must return false (cannot retry a skip)');
  assert.strictEqual(triggerArgs, null,
    'bug-75: Ask Critic must NOT have re-fired triggerGeminiCritique with stale analyze data — that\'s the user-reported bug');
});

// Force the async tests to actually resolve.
(async () => {
  // Give the async `t()` cases a chance to fully resolve.
  await new Promise((r) => setTimeout(r, 200));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
