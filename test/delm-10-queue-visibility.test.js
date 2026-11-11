// delm-10 regression: the run-queue must not "disappear" when the user
// switches sessions. User report: "还有任务队列，不能session切换了，就没有了".
//
// Reality: the queue IS persisted per-session (rec.runQueue in
// /data/sessions.json via server/src/runQueue.js) and re-shipped on
// every attach (attach.js _sendAttachSnapshot → {kind:'runQueue'}).
// The perceived loss is a VISIBILITY gap: the queue chip strip lives
// in the chat pane and only reflects the ATTACHED session, and the
// sidebar had no queue signal at all — switch away and nothing tells
// you session A still has 3 tasks queued.
//
// Contract (static shape + pure-function checks):
//   1. server: GET /sessions enriches each owned session with
//      s.queueOpen (pending+running count) and s.queueRunning.
//   2. client: renderSessionList emits a .session-queue-badge chip
//      when s.queueOpen > 0, so the 3s sidebar poll keeps queued work
//      visible across switches.
//   3. client: the queue chip strip state (state.runQueue) is cleared
//      on switch (bug-27) AND repopulated from the attach snapshot —
//      the runQueue frame handler must set state.runQueue and
//      re-render the strip.
//   4. server: the attach snapshot still ships the full queue state
//      (kind:'runQueue') for the newly attached session.
//   5. runQueue module: pending/running entries survive no-op reads
//      (getQueueState must not mutate) — the store is the source of
//      truth across switches and restarts.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const attachSrc = fs.readFileSync(path.join(ROOT, 'server/src/attach.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// 1. GET /sessions queue enrichment.
t('GET /sessions enriches sessions with s.queueOpen + s.queueRunning', () => {
  assert.ok(/s\.queueOpen\s*=/.test(indexSrc),
    'index.js must set s.queueOpen (open run-queue entries: pending+running) in the /sessions enrichment loop — the sidebar badge depends on it');
  assert.ok(/s\.queueRunning\s*=/.test(indexSrc),
    'index.js must set s.queueRunning so the badge tooltip can distinguish running from merely queued');
  const m = indexSrc.match(/status === 'pending'\s*\|\|\s*e\.status === 'running'/);
  assert.ok(m,
    'queueOpen must count exactly pending + running entries (terminal entries are history, not open work)');
});

// 2. Sidebar badge.
t('renderSessionList emits a .session-queue-badge when s.queueOpen > 0', () => {
  assert.ok(/const queueBadge = .*s\.queueOpen[\s\S]{0,400}?class="session-queue-badge"/.test(appSrc),
    'app.js must compute queueBadge from s.queueOpen and render class session-queue-badge');
  assert.ok(/Number\.isFinite\(s\.queueOpen\)\s*&&\s*s\.queueOpen\s*>\s*0/.test(appSrc),
    'the badge must render only for a finite, positive queueOpen — absent/zero must show nothing');
  assert.ok(/\$\{queueBadge\}/.test(appSrc),
    'queueBadge must be interpolated into the session-title HTML next to busyBadge');
});

t('styles.css defines .session-queue-badge', () => {
  assert.ok(/\.session-queue-badge\s*\{/.test(cssSrc),
    'styles.css must style .session-queue-badge or the chip renders as unstyled text');
});

// 3. Chip strip: cleared on switch, repopulated from frames.
t('runQueue frame handler keeps repopulating the strip', () => {
  const at = appSrc.indexOf("msg.kind === 'runQueue'");
  assert.ok(at !== -1, 'app.js must handle the runQueue state-update frame');
  const { sliceFn } = require('./_lib/fn-body');
  const body = sliceFn(appSrc, at);
  assert.ok(/state\.runQueue\s*=\s*msg\.state/.test(body),
    'the handler must cache msg.state into state.runQueue');
  assert.ok(/_renderRunQueueStrip\(\)/.test(body),
    'the handler must re-render the strip — a cache without re-render never repaints after a switch');
});

t('_resetUiForNewSession clears state.runQueue on switch (no stale leak)', () => {
  const at = appSrc.indexOf('function _resetUiForNewSession');
  const { sliceFn } = require('./_lib/fn-body');
  const body = sliceFn(appSrc, at);
  assert.ok(/state\.runQueue\s*=\s*null/.test(body),
    'switching must null state.runQueue (bug-27) so session A\'s entries can\'t render while attached to session B — the attach snapshot reships the correct queue');
});

// 4. Attach snapshot ships the queue.
t('attach snapshot ships {kind:\'runQueue\'} for the attached session', () => {
  assert.ok(/kind:\s*'runQueue',\s*state:\s*runQueue\.getQueueState\(rec\)/.test(attachSrc),
    '_sendAttachSnapshot must ship runQueue.getQueueState(rec) so switch-back repopulates the strip on the FIRST frame');
});

// 5. runQueue module: reads don't mutate; pending+running survive.
const runQueue = require('../server/src/runQueue');
t('getQueueState does not mutate the record (queue survives reads)', () => {
  const rec = {};
  runQueue.addToQueue(rec, 'td-1', 'plan', 'alice');
  runQueue.addToQueue(rec, 'td-2', 'plan', 'alice');
  const st = runQueue.getQueueState(rec);
  assert.strictEqual(st.counts.pending, 2,
    'both entries must count as pending');
  const st2 = runQueue.getQueueState(rec);
  assert.strictEqual(st2.counts.pending, 2,
    'a second read must not consume/mutate entries — the queue is the persistent source of truth across session switches');
});

t('pending + running entries are non-terminal and stay open across reads', () => {
  const rec = {};
  runQueue.addToQueue(rec, 'fr-1', 'plan', 'bob');
  runQueue.markRunning(rec, 'fr-1');
  const st = runQueue.getQueueState(rec);
  assert.strictEqual(st.counts.running, 1,
    'markRunning must flip the entry to running');
  assert.strictEqual(runQueue.TERMINAL_STATUSES.has('running'), false,
    'running must NOT be terminal — an in-flight task is open work the sidebar badge must keep showing');
  assert.strictEqual(runQueue.TERMINAL_STATUSES.has('pending'), false,
    'pending must NOT be terminal');
});

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
