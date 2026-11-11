// Regression: user report (2026-10-30) —
//   "有些时候，任务都完成了，界面打印（完成），但是共享看板任务有些
//    还没打勾，很奇怪"
//   ("sometimes all the tasks are finished and the UI prints completion,
//    but some shared-board [Plan tab] items are still unticked — weird")
//
// Root cause: the run-completion path (_stampPlanItemRunOutcome in
// attach.js, driven by the turn_result agent-event) stamped runs[] and a
// run-summary comment but NEVER set item.done = true. The ONLY code that
// set done was the manual Close button (POST /artifact/mark →
// artifacts.js) and the fr-81 remote-issue mirror. So a successfully
// dispatched + completed plan item kept its open state (⚪/📌 chip, no
// `is-done` class) even though the work was verifiably complete — the
// user had to hand-tick each finished item.
//
// Fix in attach.js `_stampPlanItemRunOutcome`:
//   · on subtype === 'success' and !item.done → item.done = true +
//     item.doneAt stamp (idempotent; failed/aborted runs leave it open).
//   · the stamped artifact is also mirrored to <cwd>/_myco_/plan.json
//     so the tick survives restarts / migrates to teammates (the same
//     persistence-race class bug-16 documented).
//
// Test shape mirrors test/bug-60-concise-run-summary-comment.test.js:
// static guards + end-to-end _stampPlanItemRunOutcome calls asserting
// done flips (and does NOT flip on error). Sub-second, runnable as
// `node test/plan-run-done-autotick.test.js`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── plan-run-done-autotick: successful runs must tick the plan item ──');

// PART A — Static guards on attach.js's new shape.

const ATTACH_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

t('static: _stampPlanItemRunOutcome flips item.done on success', () => {
  const m = ATTACH_JS.match(/function\s+_stampPlanItemRunOutcome\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_stampPlanItemRunOutcome must be a top-level function declaration');
  const body = m[1];
  assert.ok(/subtype\s*===\s*'success'/.test(body) && /item\.done\s*=\s*true/.test(body),
    '_stampPlanItemRunOutcome must set item.done = true on a success turn_result — this is the auto-tick that keeps the shared board in sync with completed runs');
  // The flip must be guarded on !item.done (idempotent, preserve
  // existing doneAt / closedUpstreamAt bookkeeping).
  assert.ok(/!item\.done/.test(body),
    'the done flip must be guarded on !item.done so an already-closed item (reopen path, fr-81 mirror) is not re-stamped');
});

t('static: stamped artifact is mirrored to the _myco_/plan.json file', () => {
  const m = ATTACH_JS.match(/function\s+_stampPlanItemRunOutcome\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = m && m[1];
  assert.ok(body && /writeArtifactToFile\(rec,\s*'plan',\s*planArtifact\)/.test(body),
    '_stampPlanItemRunOutcome must mirror the stamped plan artifact to <cwd>/_myco_/plan.json so the tick survives restarts and migrates to teammates (bug-16 persistence-race class)');
});

// PART B — End-to-end: success run ticks the item; error run does not.

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-autotick-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|attach|agent-session|menu|btw|transcript|artifacts)\.js$/.test(k)) {
    delete require.cache[k];
  }
}
const attach = require('../server/src/attach');
const stamp = attach._stampPlanItemRunOutcome;
const sessions = require('../server/src/sessions');

function withRec(id, item, work) {
  const rec = {
    id,
    user: 'tester',
    cwd: id,
    // absCwd needs a .git/ dir so artifacts.findProjectRoot recognizes
    // the session cwd as the project root (the _myco_/ mirror anchor).
    absCwd: path.join(process.env.MYCO_WORKSPACE, 'tester', id),
    artifacts: { plan: { items: [item] } },
  };
  fs.mkdirSync(path.join(rec.absCwd, '.git'), { recursive: true });
  const store = sessions.loadStore();
  store.sessions[id] = rec;
  sessions.saveStore();
  try { work(rec); }
  finally { delete store.sessions[id]; sessions.saveStore(); }
}

t('end-to-end: successful run ticks the plan item (done=true + doneAt)', () => {
  const item = { id: 'p1', text: 'Ship the feature', runs: [], comments: [], done: false };
  withRec('myco-tester-tick01', item, () => {
    stamp('myco-tester-tick01', 'p1', {
      subtype: 'success',
      result: 'Shipped the feature in commit abc123.',
      durationMs: 4200,
      usage: { input_tokens: 100, output_tokens: 50 },
    }, new Date().toISOString());
    const planItem = sessions.getSessionRecord('myco-tester-tick01').artifacts.plan.items[0];
    assert.strictEqual(planItem.done, true,
      'a SUCCESS run outcome must set item.done=true — the shared board must tick when the task is verifiably complete (user-reported bug)');
    assert.ok(planItem.doneAt, 'item.doneAt must be stamped with the completion time');
  });
});

t('end-to-end: the tick lands in the _myco_/plan.json file mirror too', () => {
  const item = { id: 'p2', text: 'Mirror me', runs: [], comments: [], done: false };
  withRec('myco-tester-tick02', item, () => {
    stamp('myco-tester-tick02', 'p2', {
      subtype: 'success',
      result: 'Done.',
      durationMs: 100,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, null);
    const rec = sessions.getSessionRecord('myco-tester-tick02');
    const mirror = JSON.parse(fs.readFileSync(path.join(rec.absCwd, '_myco_', 'plan.json'), 'utf8'));
    const mirrored = mirror.items.find((it) => it.id === 'p2');
    assert.ok(mirrored && mirrored.done === true,
      '_myco_/plan.json on disk must carry done=true after a successful run — otherwise the tick is lost on reload and teammates never see it');
  });
});

t('end-to-end: error run does NOT tick the item (stays open for re-dispatch)', () => {
  const item = { id: 'p3', text: 'Failing run', runs: [], comments: [], done: false };
  withRec('myco-tester-tick03', item, () => {
    stamp('myco-tester-tick03', 'p3', {
      subtype: 'error',
      result: null,
      durationMs: 50,
      usage: { input_tokens: 1, output_tokens: 0 },
    }, null);
    const planItem = sessions.getSessionRecord('myco-tester-tick03').artifacts.plan.items[0];
    assert.strictEqual(planItem.done, false,
      'an ERROR run outcome must leave item.done=false — a failed item must stay open for re-dispatch, not auto-close');
  });
});

t('end-to-end: re-running an already-done item keeps done=true and does not clobber doneAt', () => {
  const origDoneAt = '2026-10-01T00:00:00.000Z';
  const item = { id: 'p4', text: 'Re-run of a closed item', runs: [], comments: [], done: true, doneAt: origDoneAt };
  withRec('myco-tester-tick04', item, () => {
    stamp('myco-tester-tick04', 'p4', {
      subtype: 'success',
      result: 'Re-verified.',
      durationMs: 100,
      usage: { input_tokens: 1, output_tokens: 1 },
    }, null);
    const planItem = sessions.getSessionRecord('myco-tester-tick04').artifacts.plan.items[0];
    assert.strictEqual(planItem.done, true, 'item stays done after a re-run');
    assert.strictEqual(planItem.doneAt, origDoneAt,
      'the idempotent guard must not re-stamp doneAt on an already-done item (preserve original close time)');
  });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
