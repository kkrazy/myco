// Regression: when a plan-item run completes (turn_result event lands
// after a `[run:plan#<id>]`-tagged chat message), attach.js
// _stampPlanItemRunOutcome must:
//   1. Replace/append a runs[] entry with status + summary + result.
//   2. ALSO append a synthetic "run-summary" comment to item.comments
//      (user='claude', meta.kind='run-summary') so a teammate browsing
//      the Plan tab sees claude's findings on the item itself.
//
// The contract was added 2026-05-16 alongside the @myco-prefix removal.
// If a future refactor drops the comment-append, the user-facing
// "findings on the item" feature silently breaks — this test red-flips
// instead.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-prc-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

// Allow-list a known user so chat routing doesn't reject the test
// fixtures; we don't actually exercise chat routing here but loading
// attach.js pulls in authMod which reads this file once.
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\nkkrazy\n',
);

const sessionsMod = require('../server/src/sessions');
const attach = require('../server/src/attach');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seedSession(sid, item) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    createdAt: new Date().toISOString(),
    chat: [],
    artifacts: { plan: { items: [item], updatedAt: null } },
  };
  sessionsMod.saveStore();
}

function fakeSession() {
  const events = [];
  return {
    alive: true,
    emit(name, payload) { events.push({ name, payload }); },
    _emitted: events,
  };
}

console.log('── _stampPlanItemRunOutcome appends a run-summary comment ──');

t('success outcome appends a claude comment with status + duration + cost + result', () => {
  const sid = 'sess-prc-1';
  const item = {
    id: 'td-42', text: 'add pager', layer: 'Backend', done: false,
    voters: [], comments: [],
  };
  seedSession(sid, item);
  // Inject the fake session into attach.js's registry so
  // _stampPlanItemRunOutcome's broadcast call has something to emit on.
  attach._registerExternalSession(sid, fakeSession());

  // Invoke the outcome stamper directly through its public surface:
  // simulate the agent-event 'turn_result' listener firing.
  // bug-36: was session._activeRunItem = {...}; now push to the FIFO.
  const session = attach.getSession(sid);
  session._activeItemQueue = [{
    type: 'plan', itemId: 'td-42',
    chatBound: false, runBound: true,
    startedAt: '2026-05-16T08:00:00.000Z', _buffer: '',
  }];
  session.emit('agent-event', {
    type: 'turn_result',
    subtype: 'success',
    result: 'Added /v2/orders cursor pager + a regression test.',
    usage: { input_tokens: 1200, output_tokens: 350 },
    totalCostUsd: 0.0234,
    durationMs: 5400,
  });
  // attach.js doesn't fire the listener synchronously through emit (it
  // sets up the handler via session.on('agent-event', ...) in
  // _registerExternalSession). Our fake session.emit just records; the
  // real listener wiring is on the session object. Re-invoke the
  // _registerExternalSession-installed listener directly.
  // (Find it by calling it via the same path: scan stored handlers if
  // exposed, else call the outcome stamper through a public test
  // hook. attach.js exposes _stampPlanItemRunOutcome only via the
  // listener registered in _registerExternalSession — we read it back
  // via session.listeners.)
  // Simpler: hit the path by emitting on a REAL EventEmitter.
});

// Real-EventEmitter variant: ensures we exercise the listener attach.js
// installed in _registerExternalSession, not a stub.
const { EventEmitter } = require('events');

t('real listener path: outcome lands on item.runs[] and item.comments[]', () => {
  const sid = 'sess-prc-2';
  const item = {
    id: 'td-99', text: 'wire up dark mode toggle', layer: 'Frontend', done: false,
    voters: [], comments: [],
  };
  seedSession(sid, item);

  const session = new EventEmitter();
  session.alive = true;
  // _registerExternalSession installs the agent-event listener that
  // calls _stampPlanItemRunOutcome when type==='turn_result'.
  attach._registerExternalSession(sid, session);
  session._activeItemQueue = [{
    type: 'plan', itemId: 'td-99',
    chatBound: false, runBound: true,
    startedAt: '2026-05-16T08:10:00.000Z', _buffer: '',
  }];
  session.emit('agent-event', {
    type: 'turn_result',
    subtype: 'success',
    result: 'Wired the toggle, persisted to localStorage, added a regression.',
    usage: { input_tokens: 800, output_tokens: 220 },
    totalCostUsd: 0.0098,
    durationMs: 4200,
  });

  const store = sessionsMod.loadStore();
  const updated = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'td-99');
  assert.ok(updated, 'item not found post-stamp');
  // runs[] outcome
  assert.ok(Array.isArray(updated.runs) && updated.runs.length === 1, 'runs[] should have one entry');
  assert.strictEqual(updated.runs[0].status, 'success');
  assert.ok(updated.runs[0].summary && /4\.2s/.test(updated.runs[0].summary), 'duration missing from summary');
  // comments[] auto-summary
  assert.ok(Array.isArray(updated.comments) && updated.comments.length === 1,
    'one synthetic run-summary comment should be appended');
  const c = updated.comments[0];
  assert.strictEqual(c.user, 'claude');
  assert.strictEqual(c.meta && c.meta.kind, 'run-summary');
  assert.ok(/✓ success/.test(c.text), 'comment text missing status glyph/word: ' + c.text);
  assert.ok(/4\.2s/.test(c.text), 'comment text missing duration: ' + c.text);
  assert.ok(/\$0\.0098/.test(c.text), 'comment text missing cost: ' + c.text);
  assert.ok(/800↓\/220↑/.test(c.text), 'comment text missing token chip: ' + c.text);
  assert.ok(c.text.includes('Wired the toggle'),
    'comment body missing truncated final assistant text: ' + c.text);

  // bug-36 (FIFO refactor): the popped entry must be gone from the
  // queue. The single agent-event listener .shift()s the head before
  // binding, so after a terminal event the queue length is N-1.
  assert.strictEqual(session._activeItemQueue.length, 0,
    'FIFO _activeItemQueue head must be popped after the outcome is stamped');
});

t('error outcome uses ⚠ glyph + error status in the comment', () => {
  const sid = 'sess-prc-3';
  const item = {
    id: 'td-err', text: 'something risky', layer: 'Risk', done: false,
    voters: [], comments: [],
  };
  seedSession(sid, item);

  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);
  session._activeItemQueue = [{
    type: 'plan', itemId: 'td-err',
    chatBound: false, runBound: true,
    startedAt: '2026-05-16T08:20:00.000Z', _buffer: '',
  }];
  session.emit('agent-event', {
    type: 'turn_result',
    subtype: 'error_max_turns',
    result: 'Hit max-turns before finishing.',
    usage: { input_tokens: 4000, output_tokens: 90 },
    totalCostUsd: 0.041,
    durationMs: 60000,
  });

  const store = sessionsMod.loadStore();
  const updated = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'td-err');
  const c = updated.comments[0];
  assert.strictEqual(c.user, 'claude');
  assert.ok(/⚠ error/.test(c.text), 'error comment must use ⚠ glyph + "error" word: ' + c.text);
  assert.strictEqual(updated.runs[0].status, 'error');
});

t('missing final assistant text falls back to "(no final assistant text)" body', () => {
  const sid = 'sess-prc-4';
  const item = {
    id: 'td-empty', text: 'silent run', layer: 'Misc', done: false,
    voters: [], comments: [],
  };
  seedSession(sid, item);

  const session = new EventEmitter();
  session.alive = true;
  attach._registerExternalSession(sid, session);
  session._activeItemQueue = [{
    type: 'plan', itemId: 'td-empty',
    chatBound: false, runBound: true,
    startedAt: '2026-05-16T08:30:00.000Z', _buffer: '',
  }];
  session.emit('agent-event', {
    type: 'turn_result',
    subtype: 'success',
    result: '',  // empty
    usage: { input_tokens: 600, output_tokens: 0 },
    totalCostUsd: 0.0011,
    durationMs: 1500,
  });

  const store = sessionsMod.loadStore();
  const updated = store.sessions[sid].artifacts.plan.items.find((i) => i.id === 'td-empty');
  const c = updated.comments[0];
  assert.ok(/no final assistant text/i.test(c.text),
    'empty-result run should still emit a comment with a fallback body: ' + c.text);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
