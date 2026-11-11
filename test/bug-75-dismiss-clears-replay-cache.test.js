// bug-75 (the NEW bug-75 plan item — not to be confused with the
// existing bug-75-ask-critic-scoped-to-current-stage.test.js which
// was filed against plan-item bug-69 in a prior cycle).
//
// User report (2026-06-07):
//   "Investigate why the verdict for bug-72 kept show up every time
//    i reconnect to the session."
//
// Reproduced in `_myco_/logs/mycod-2026-06-07.log:17:49-17:51` —
// three reconnects in 75 seconds, each fires
//   [fr-98] replayed pending critique-review on attach for item
//   bug-72 (stage=analyze, status=awaiting_accept)
// followed by a POST /critique/resolve from the user. ZERO `[fr-96]`
// transition logs anywhere, meaning every POST sent a reason that
// is NOT 'accept-stage' or 'fix-stage' (overwhelmingly likely
// 'dismiss' — that's the only "just close this" affordance on an
// intermediate verdict pane). Yet the pane comes back on every
// reconnect because:
//   1. fr-98 attach-replay (attach.js:1804) re-ships any pending
//      verdict on every WebSocket attach when stageState is
//      awaiting_verdict / awaiting_accept.
//   2. resolveCritique (critique.js:687) deliberately does NOT clear
//      lastCriticReview on reason='dismiss' — the documented intent
//      was "user wants to close the pane without a decision; state
//      stays at awaiting_accept" — so the persisted slot stays
//      populated for fr-98 to re-replay forever.
// Composition = infinite re-render loop on reconnect.
//
// Fix: extend resolveCritique to ALSO call clearLastCriticReview
// when reason='dismiss' (and 'discard'). The bug-72 client-side
// Reopen pill (already shipped) gives the user local recovery if
// they want the verdict back. stageState is still gated by
// accept-stage / fix-stage button clicks — Dismiss still does NOT
// transition stageState, matching the documented intent (the user
// hasn't made a decision yet). The only behavior change is the pane
// stops nagging on every reconnect.
//
// Test shape: static guard on the resolveCritique change + a
// runtime test that wires up sessions + a stub session, fires a
// resolveCritique(reason='dismiss'), and asserts
// item.meta.lastCriticReview is gone.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function tAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-75 (dismiss clears fr-98 replay cache) ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guard on resolveCritique
// ─────────────────────────────────────────────────────────────────

const CRITIQUE_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'critique.js'), 'utf8');

t('resolveCritique handles reason="dismiss" + "discard" by clearing lastCriticReview', () => {
  const at = CRITIQUE_JS.search(/function\s+resolveCritique\s*\(/);
  assert.ok(at > -1, 'resolveCritique must exist');
  const body = sliceFn(CRITIQUE_JS, at);
  // The fix must reference 'dismiss' (and/or 'discard') alongside a
  // clearLastCriticReview call. The acceptance criterion is "Dismiss
  // stops the fr-98 replay loop" — clearing lastCriticReview is the
  // mechanism. The shape can be either an extended condition in the
  // existing accept-stage/fix-stage branch, or a separate branch.
  assert.ok(/['"]dismiss['"]/.test(body),
    'bug-75: resolveCritique must reference reason=\'dismiss\' (currently it has NO branch handling dismiss — that\'s the bug).');
  assert.ok(/clearLastCriticReview\s*\(/.test(body),
    'bug-75: resolveCritique must call clearLastCriticReview so fr-98 attach-replay no longer re-ships the verdict on reconnect.');
  // The dismiss branch must call clearLastCriticReview. Approximate
  // by checking they're within ~600 chars of each other (any
  // reasonable code shape).
  const dismissAt = body.search(/['"]dismiss['"]/);
  const clearAt = body.search(/clearLastCriticReview\s*\(/);
  assert.ok(Math.abs(dismissAt - clearAt) < 1500,
    `bug-75: the dismiss reference and clearLastCriticReview call must be in the same code block (within ~1500 chars). dismissAt=${dismissAt}, clearAt=${clearAt}.`);
});

t('resolveCritique still does NOT transition stageState for dismiss (preserves "no decision" contract)', () => {
  const at = CRITIQUE_JS.search(/function\s+resolveCritique\s*\(/);
  const body = sliceFn(CRITIQUE_JS, at);
  // The intent: Dismiss continues to NOT transition stageState (it's
  // not an accept-stage). Only lastCriticReview gets cleared so the
  // attach-replay loop stops. The state machine stays at
  // awaiting_accept — claude's [stage: X done] sentinel is still
  // blocked by bug-61 until the user explicitly accepts. The
  // bug-72 Reopen pill is the recovery path if the user changes
  // their mind.
  //
  // Check: the _transitionStageState call sites must still be gated
  // on reason==='accept-stage' or 'fix-stage', NOT on 'dismiss'.
  const transitionMatches = [...body.matchAll(/_transitionStageState\s*\(/g)];
  for (const m of transitionMatches) {
    // Walk backwards from each call site looking for the nearest
    // enclosing reason check.
    const ctxStart = Math.max(0, m.index - 800);
    const ctxBefore = body.slice(ctxStart, m.index);
    // The closest reason gating SHOULD be accept-stage or fix-stage.
    // Even if there's a separate dismiss branch above, the transition
    // calls themselves should NOT live under a dismiss reason check.
    const lastReasonMatch = [...ctxBefore.matchAll(/reason\s*===\s*['"]([a-z-]+)['"]/g)].pop();
    if (lastReasonMatch) {
      assert.ok(lastReasonMatch[1] !== 'dismiss',
        'bug-75: _transitionStageState calls must NOT live under a `reason === "dismiss"` branch. Dismiss must not advance the state machine — only clear lastCriticReview. Found a transition call directly gated by dismiss.');
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime: wire up a real session + plan item + verify
// the dismiss path clears item.meta.lastCriticReview
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug75dismiss-'));
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

function seedSession(sid, itemId) {
  const sessions = require('../server/src/sessions');
  const stageStateMod = require('../server/src/stageState');
  const absCwd = path.join(process.env.MYCO_WORKSPACE, 'tester', sid);
  fs.mkdirSync(absCwd, { recursive: true });
  const item = {
    id: itemId,
    text: 'bug-75 dismiss test item',
    layer: 'Bug',
    voters: [], comments: [], runs: [],
    meta: {
      stageState: {
        stage: 'analyze',
        status: 'awaiting_accept',
        updatedAt: new Date().toISOString(),
        history: [],
      },
      lastCriticReview: {
        // Looks like a real persisted broadcast payload — what fr-98
        // ships back to the client on attach.
        kind: 'critique-review',
        itemId,
        critique: '## Analyze stage critique\n\nLooks fine, ship it.',
        isIntermediate: true,
        stage: 'analyze',
        hasDisagreement: false,
        isError: false,
        firedAt: new Date().toISOString(),
      },
    },
  };
  const rec = {
    id: sid, user: 'tester', cwd: sid, absCwd,
    artifacts: { plan: { items: [item] } },
  };
  const store = sessions.loadStore();
  store.sessions[sid] = rec;
  sessions.saveStore();
  return { sessions, stageStateMod, rec, item };
}

(async () => {
  await tAsync('runtime: resolveCritique(reason="dismiss") clears item.meta.lastCriticReview', async () => {
    const { EventEmitter } = require('events');
    const { sessions, stageStateMod, item } = seedSession('myco-tester-bug75aaaa', 'bug-75-runtime');
    const sid = 'myco-tester-bug75aaaa';
    const critique = require('../server/src/critique');

    // Sanity: starting state — lastCriticReview is populated, stageState
    // is awaiting_accept.
    assert.ok(stageStateMod.getLastCriticReview(item),
      'sanity: pre-dismiss lastCriticReview must be populated');
    const ssBefore = stageStateMod.getStageState(item);
    assert.strictEqual(ssBefore.status, 'awaiting_accept',
      'sanity: pre-dismiss stageState.status must be awaiting_accept');

    // Fire the resolveCritique with reason='dismiss' — what the client
    // POSTs when the user clicks ✗ Dismiss.
    const stub = new EventEmitter();
    stub.on('state-update', () => {});
    critique.resolveCritique(sid, stub, { itemId: 'bug-75-runtime', reason: 'dismiss' });

    // Post-fix expectation:
    //   1. lastCriticReview cleared (fr-98 replay finds nothing → no loop)
    //   2. stageState UNCHANGED (still awaiting_accept — Dismiss doesn't decide)
    const reviewAfter = stageStateMod.getLastCriticReview(item);
    assert.ok(!reviewAfter,
      'bug-75: after resolveCritique(reason="dismiss"), item.meta.lastCriticReview MUST be gone. This is what stops the fr-98 attach-replay loop. Pre-fix it stayed populated → every reconnect re-shipped the same verdict pane → user trapped (logged in mycod-2026-06-07.log:17:49-17:51, three reconnects in 75 seconds, each replaying bug-72\'s pane).');
    const ssAfter = stageStateMod.getStageState(item);
    assert.strictEqual(ssAfter.status, 'awaiting_accept',
      'bug-75: Dismiss MUST NOT transition stageState — that\'s a separate decision (accept-stage / fix-stage). Pre-fix and post-fix stageState should both stay at awaiting_accept; only the persisted verdict pane is cleared.');
  });

  await tAsync('runtime: resolveCritique(reason="discard") also clears item.meta.lastCriticReview', async () => {
    // Discard fires on the final-verdict pane and means "abort this
    // work entirely." The fr-98 replay loop bug applies symmetrically:
    // if discard didn't clear lastCriticReview, a reconnect would
    // re-pop the final verdict the user explicitly threw away.
    // (clearActiveRunItem clears stageState entirely on discard, which
    // already short-circuits fr-98's replay condition; but belt-and-
    // braces — make the explicit clear happen at resolveCritique time
    // too so the contract is "any resolution that doesn't carry the
    // verdict forward should clear the persisted slot.")
    const { EventEmitter } = require('events');
    const { sessions, stageStateMod, item } = seedSession('myco-tester-bug75bbbb', 'bug-75-discard');
    const sid = 'myco-tester-bug75bbbb';
    const critique = require('../server/src/critique');
    const stub = new EventEmitter();
    stub.on('state-update', () => {});
    critique.resolveCritique(sid, stub, { itemId: 'bug-75-discard', reason: 'discard' });
    const reviewAfter = stageStateMod.getLastCriticReview(item);
    assert.ok(!reviewAfter,
      'bug-75: resolveCritique(reason="discard") must also clear item.meta.lastCriticReview. Without this, a reconnect after Discard re-pops the verdict pane for work the user has explicitly thrown away.');
  });

  console.log(`── bug-75 (dismiss): ${passed} passed, ${failed} failed ──`);
  process.exit(failed === 0 ? 0 : 1);
})();
