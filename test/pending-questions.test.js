// bug-92: unanswered user questions must not be forgotten.
//
// Covers:
//   * pendingQuestions.js pure functions (add / dedup / markAnswered /
//     markFailed / requeue / canRetry cap / answered audit trim).
//   * attach.js wiring guards: the tracker is invoked on the
//     session.write forward, and a terminal agent-event listener marks
//     answered / failed-auto-rerun.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pq = require('../server/src/pendingQuestions');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function rec() {
  const r = {};
  pq.addQuestion(r, 'how do I deploy?', 'kkrazy', 'q1');
  return r;
}

const ATTACH_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── bug-92: unanswered-question tracker ──');

t('addQuestion appends a pending entry with status + dispatchCount', () => {
  const r = {};
  const e = pq.addQuestion(r, 'what is 2+2?', 'kkrazy', 'q1');
  assert.ok(e && e.qid === 'q1' && e.status === 'pending' && e.dispatchCount === 1,
    'entry must be pending with dispatchCount 1: ' + JSON.stringify(e));
  assert.strictEqual(pq.getState(r).counts.pending, 1);
});

t('addQuestion dedups an identical STILL-PENDING text (no duplicate row)', () => {
  const r = {};
  pq.addQuestion(r, 'deploy now?', 'kkrazy', 'qa');
  pq.addQuestion(r, 'deploy now?', 'kkrazy', 'qb');
  assert.strictEqual(pq.getState(r).list.length, 1, 'identical pending text must not duplicate');
});

t('markAnswered flips the EARLIEST pending→answered (FIFO)', () => {
  const r = {};
  pq.addQuestion(r, 'first?', 'kkrazy', 'q1');
  pq.addQuestion(r, 'second?', 'kkrazy', 'q2');
  const a = pq.markAnswered(r);
  assert.ok(a && a.qid === 'q1' && a.status === 'answered', 'head must be answered: ' + JSON.stringify(a));
  assert.strictEqual(pq.getState(r).list[0].status, 'answered');
  assert.strictEqual(pq.getState(r).list[1].status, 'pending');
});

t('markFailed flags the head pending (and getOpen surfaces it)', () => {
  const r = rec();
  const f = pq.markFailed(r);
  assert.ok(f && f.status === 'failed', 'head must become failed');
  assert.strictEqual(pq.getOpen(r).length, 1, 'failed question stays in the open set');
});

t('canRetry + requeue enforce the auto-rerun cap (MAX_QUESTION_RETRIES)', () => {
  const r = rec();                       // dispatchCount 1
  const e = pq.requeue(r, 'q1');         // → 2
  assert.ok(e && e.status === 'pending' && e.dispatchCount === 2, 'requeue bumps dispatchCount');
  assert.ok(pq.canRetry(pq.getState(r).list[0]) === false,
    'dispatchCount 2 must be past the retry budget (cap 2)');
});

t('answered list is trimmed to a bounded audit window', () => {
  const r = {};
  for (let i = 0; i < 30; i++) { pq.addQuestion(r, 'q' + i, 'kkrazy', 'q' + i); }
  for (let i = 0; i < 30; i++) { pq.markAnswered(r); }
  const answered = pq.getState(r).list.filter((e) => e.status === 'answered');
  assert.ok(answered.length <= 20, 'answered audit window must be bounded, got ' + answered.length);
});

t('removeQuestion: removes a single question by qid (单独清理)', () => {
  const r = rec();                     // q1 pending
  pq.addQuestion(r, 'second?', 'kkrazy', 'q2');
  assert.strictEqual(pq.removeQuestion(r, 'q1'), true, 'q1 removed');
  assert.strictEqual(pq.getState(r).list.length, 1, 'q2 remains');
  assert.strictEqual(pq.getState(r).list[0].qid, 'q2');
  assert.strictEqual(pq.removeQuestion(r, 'nope'), false, 'unknown qid → false');
});

t('clearOpen: clears pending + failed (unanswered), keeps answered history', () => {
  const r = {};
  pq.addQuestion(r, 'a', 'kkrazy', 'a'); pq.markAnswered(r);   // answered
  pq.addQuestion(r, 'b', 'kkrazy', 'b');                       // pending
  pq.addQuestion(r, 'c', 'kkrazy', 'c');
  pq.markFailed(r);                                           // b → failed
  const removed = pq.clearOpen(r);
  assert.strictEqual(removed, 2, 'pending b + failed c dropped');
  const list = pq.getState(r).list;
  assert.strictEqual(list.length, 1, 'answered history kept');
  assert.strictEqual(list[0].status, 'answered');
});

t('artifacts.js: per-item + one-click unanswered-question routes exist (owner/admin gated)', () => {
  const A = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
  assert.match(A, /app\.post\(\s*['"`]\/sessions\/:id\/questions\/clear['"`]/,
    'POST /sessions/:id/questions/clear (一键清空) must exist');
  assert.match(A, /app\.post\(\s*['"`]\/sessions\/:id\/questions\/:qid\/rerun['"`]/,
    'POST /sessions/:id/questions/:qid/rerun (单独重试) must exist');
  assert.match(A, /app\.post\(\s*['"`]\/sessions\/:id\/questions\/:qid\/clear['"`]/,
    'POST /sessions/:id/questions/:qid/clear (单独清理) must exist');
  assert.match(A, /pendingQuestions\.clearOpen\(ctx\.rec\)/, 'clear route must call clearOpen');
  assert.match(A, /pendingQuestions\.removeQuestion\(ctx\.rec, qid\)/, 'per-qid clear must call removeQuestion');
});

t('app.js + styles.css render per-chip and one-click buttons for the unanswered strip', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
  for (const fn of ['onPendingQuestionRerun', 'onPendingQuestionClear', 'onPendingQuestionsClear']) {
    assert.ok(new RegExp('function\\s+' + fn).test(APP), fn + ' must be defined in app.js');
  }
  assert.match(APP, /questions\/\$\{encodeURIComponent\(qid\)\}\/rerun/, 'per-qid rerun endpoint wired');
  assert.match(APP, /questions\/\$\{encodeURIComponent\(qid\)\}\/clear/, 'per-qid clear endpoint wired');
  for (const cls of ['.pq-rerun-one', '.pq-clear-one', '.pq-clear-all']) {
    assert.ok(CSS.indexOf(cls) !== -1, 'styles.css must style ' + cls);
  }
});

t('attach.js: _trackPendingQuestion runs before the session.write forward', () => {
  // The bug-92 tracker is hooked at the normal-forward point so a plain
  // question to claude is always captured before dispatch.
  const idx = ATTACH_SRC.search(/function\s+_trackPendingQuestion\s*\(/);
  assert.ok(idx > -1, '_trackPendingQuestion must be defined in attach.js');
  const fwdIdx = ATTACH_SRC.indexOf('session.write(input)');
  const pre = ATTACH_SRC.slice(fwdIdx - 600, fwdIdx);
  assert.ok(/trackPendingQuestion/.test(pre),
    'the tracker call must sit right before session.write(input)');
});

t('attach.js: a terminal agent-event listener marks answered (non-run success) / failed (abort) / rerun (fatal)', () => {
  const idx = ATTACH_SRC.search(/bug-92: pending-question terminal listener/);
  assert.ok(idx > -1, 'bug-92 terminal listener block must exist');
  const win = ATTACH_SRC.slice(idx, idx + 1800);
  assert.ok(/markAnswered/.test(win), 'terminal handler must call markAnswered on a successful non-run turn');
  assert.ok(/ev\.type === ['"]fatal['"]/.test(win) && /_maybeRerunPendingQuestion/.test(win),
    'terminal handler must auto-rerun on fatal');
  assert.ok(/ev\.type === ['"]iteration_aborted['"]/.test(win) &&
            (/\bmarkFailed/.test(win) || /markFailed/.test(win)),
    'terminal handler must mark failed on iteration_aborted (surfaced, not auto-rerun)');
});

t('attach.js: pending-questions state ships on attach + is broadcast as a state-update kind', () => {
  assert.ok(/kind: ['"]pending-questions['"]/.test(ATTACH_SRC),
    'attach.js must emit state-update kind=pending-questions');
  assert.ok(/pending-questions init failed/.test(ATTACH_SRC),
    'attach-snapshot must ship pending-questions on attach');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
