// bug-82: verdict modal + verdict-handled signal must reach all
// connected devices.
//
// User report (2026-06-10):
//   "Verdict flow is device-local instead of session-wide, leaving
//    other connected clients out of sync. Expected: verdict modal is
//    broadcast to every connected device so all can handle it, and
//    the verdict-handled signal is broadcast back so all devices can
//    move on together. Actual: verdict modal appears on only one
//    connected device, and the verdict-handled signal is not
//    broadcast to the rest."
//
// Root cause (analyze): the button-click resolve path correctly
// emits `state-update kind:'critique-resolved'` via critique.js
// resolveCritique (bug-54), reaching all attached devices via the
// session EventEmitter. The CHAT-ACCEPT path (bug-70's
// _maybeHandleChatAccept in attach.js) is a parallel acceptance
// surface that mirrors the stage-state transition + the
// _postAcceptStagePrompt synthetic-chat dispatch, but MISSES the
// cross-device resolve broadcast — both for the verify branch and
// the intermediate branch. Result: when user A types "accept" on
// their device, no `critique-resolved` ever fires, so:
//   · device A's own verdict pane stays open (no clear signal until
//     the next critique-review or until they manually dismiss)
//   · device B's verdict pane stays open (same reason)
//
// Fix: both branches of _maybeHandleChatAccept must
// session.emit('state-update', { kind:'critique-resolved', itemId,
// reason: 'chat-accept-verify' | 'chat-accept-stage' }). Reuses the
// existing bug-54 client-side handler — zero client change.
//
// Test shape: static guards on the two emit sites + a runtime test
// that wires three stub EventEmitter "devices" to one session, fires
// _maybeHandleChatAccept, and asserts all three received the
// critique-resolved event.

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

console.log('── bug-82: cross-device chat-accept critique-resolved broadcast ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards on attach.js
// ─────────────────────────────────────────────────────────────────

const ATTACH_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

t('_maybeHandleChatAccept verify branch emits critique-resolved', () => {
  const at = ATTACH_JS.search(/function\s+_maybeHandleChatAccept\s*\(/);
  assert.ok(at > -1, '_maybeHandleChatAccept must exist');
  const body = sliceFn(ATTACH_JS, at);
  // Verify branch: code path under `if (stage === 'verify')`. Anchor
  // on the literal + look forward into the branch body for the
  // critique-resolved emit. The branch is ~30 lines pre-fix; allowing
  // 2000 chars catches comment churn.
  const verifyAt = body.search(/if\s*\(\s*stage\s*===\s*['"]verify['"]\s*\)/);
  assert.ok(verifyAt > -1, 'verify branch must exist');
  // Find end of verify branch — the `return true;` that exits it,
  // followed by the intermediate branch comment.
  const verifyEnd = body.indexOf('// Intermediate stage', verifyAt);
  assert.ok(verifyEnd > verifyAt, 'intermediate stage comment must anchor the end of verify branch');
  const verifyBody = body.slice(verifyAt, verifyEnd);
  assert.ok(/session\.emit\(\s*['"]state-update['"]/.test(verifyBody),
    'bug-82: the verify branch of _maybeHandleChatAccept must call session.emit(\'state-update\', …) — without it, the chat-acceptor\'s own verdict pane AND every other attached device\'s verdict pane stays open after a typed "accept". Mirrors the button-click path\'s critique-resolved broadcast (critique.js:675).');
  assert.ok(/critique-resolved/.test(verifyBody),
    'bug-82: the emit in the verify branch must carry kind:"critique-resolved" so the existing bug-54 client handler clears the pane on every device.');
});

t('_maybeHandleChatAccept intermediate branch emits critique-resolved', () => {
  const at = ATTACH_JS.search(/function\s+_maybeHandleChatAccept\s*\(/);
  const body = sliceFn(ATTACH_JS, at);
  // Intermediate branch is everything after the "// Intermediate
  // stage" comment.
  const interStart = body.indexOf('// Intermediate stage');
  assert.ok(interStart > -1, 'intermediate stage comment must exist');
  const interBody = body.slice(interStart);
  assert.ok(/session\.emit\(\s*['"]state-update['"]/.test(interBody),
    'bug-82: the intermediate branch of _maybeHandleChatAccept must call session.emit(\'state-update\', …) for the same reason as the verify branch. Without it, chat-acceptance of an intermediate stage (analyze/code) leaves every device\'s verdict pane open until something else fires.');
  assert.ok(/critique-resolved/.test(interBody),
    'bug-82: the emit in the intermediate branch must carry kind:"critique-resolved" so the existing bug-54 client handler clears the pane on every device.');
});

t('_maybeHandleChatAccept reason field distinguishes chat-accept from button-click', () => {
  const at = ATTACH_JS.search(/function\s+_maybeHandleChatAccept\s*\(/);
  const body = sliceFn(ATTACH_JS, at);
  // Reason strings make audit trails decipherable — the existing
  // button paths use 'accept-stage'/'accept-verify'/'dismiss'/'fix-stage'.
  // The new chat path should distinguish itself: 'chat-accept-*'
  // tells future log readers exactly which surface fired the resolve.
  assert.ok(/chat-accept-(verify|stage)/.test(body),
    'bug-82: the resolve broadcasts from _maybeHandleChatAccept must use reasons like "chat-accept-verify" / "chat-accept-stage" so logs distinguish the chat-acceptance surface from the button-click resolveCritique path. Future log readers can tell at a glance which surface fired.');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime: wire multiple "devices" + fire chat-accept
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug82-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|attach|stageState|critique|artifacts)\.js$/.test(k)) {
    delete require.cache[k];
  }
}

// Seed a session + plan item with stageState=awaiting_accept.
function seedSession(sid, itemId, stage) {
  const sessions = require('../server/src/sessions');
  const absCwd = path.join(process.env.MYCO_WORKSPACE, 'tester', sid);
  fs.mkdirSync(absCwd, { recursive: true });
  const item = {
    id: itemId,
    text: 'bug-82 test item',
    layer: 'Bug',
    voters: [], comments: [], runs: [],
    meta: {
      stageState: {
        stage,
        status: 'awaiting_accept',
        updatedAt: new Date().toISOString(),
        history: [],
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
  return { sessions, item };
}

// Register N stub "devices" as session.on('state-update', ...) +
// session.on('chat', ...) — mirrors what each WS attach does.
// Returns an array of `{ stateUpdates, chats }` accumulators.
function attachStubDevices(session, n) {
  const devices = [];
  for (let i = 0; i < n; i++) {
    const stateUpdates = [];
    const chats = [];
    session.on('state-update', (payload) => stateUpdates.push(payload));
    session.on('chat', (msg) => chats.push(msg));
    devices.push({ stateUpdates, chats });
  }
  return devices;
}

t('runtime: chat-accept on verify stage broadcasts critique-resolved to ALL attached devices', () => {
  const { EventEmitter } = require('events');
  const attach = require('../server/src/attach');
  const sid = 'myco-tester-bug82verify';
  seedSession(sid, 'bug-82-v', 'verify');
  const session = new EventEmitter();
  attach._registerExternalSession(sid, session);
  // Mark the active run item so _maybeHandleChatAccept finds it.
  session._activeRunItem = { itemId: 'bug-82-v', startedAt: new Date().toISOString() };

  // Attach 3 stub devices.
  const devices = attachStubDevices(session, 3);

  const handled = attach._maybeHandleChatAccept(sid, session, 'tester', 'accept');
  assert.strictEqual(handled, true,
    'sanity: _maybeHandleChatAccept must return true when stageState is awaiting_accept + phrase matches');

  // Every device must have received exactly one critique-resolved
  // state-update for the run item.
  for (let i = 0; i < devices.length; i++) {
    const resolves = devices[i].stateUpdates.filter(p => p && p.kind === 'critique-resolved');
    assert.strictEqual(resolves.length, 1,
      `bug-82: device ${i} must receive exactly one critique-resolved broadcast on chat-accept (verify stage). Got ${resolves.length}. All state-updates received by this device:\n${JSON.stringify(devices[i].stateUpdates.map(p => p && p.kind), null, 2)}`);
    assert.strictEqual(resolves[0].itemId, 'bug-82-v',
      `bug-82: device ${i}'s critique-resolved payload must carry itemId='bug-82-v'. Got ${JSON.stringify(resolves[0].itemId)}.`);
    assert.ok(/chat-accept/.test(String(resolves[0].reason || '')),
      `bug-82: device ${i}'s critique-resolved reason must distinguish the chat-accept surface (e.g. 'chat-accept-verify'). Got ${JSON.stringify(resolves[0].reason)}.`);
  }
});

t('runtime: chat-accept on intermediate stage (code) broadcasts critique-resolved to ALL attached devices', () => {
  const { EventEmitter } = require('events');
  const attach = require('../server/src/attach');
  const sid = 'myco-tester-bug82inter';
  seedSession(sid, 'bug-82-i', 'code');
  const session = new EventEmitter();
  attach._registerExternalSession(sid, session);
  session._activeRunItem = { itemId: 'bug-82-i', startedAt: new Date().toISOString() };

  const devices = attachStubDevices(session, 3);

  const handled = attach._maybeHandleChatAccept(sid, session, 'tester', 'accept');
  assert.strictEqual(handled, true,
    'sanity: chat-accept on intermediate stage with awaiting_accept must be handled');

  for (let i = 0; i < devices.length; i++) {
    const resolves = devices[i].stateUpdates.filter(p => p && p.kind === 'critique-resolved');
    assert.strictEqual(resolves.length, 1,
      `bug-82: device ${i} must receive exactly one critique-resolved on intermediate chat-accept. Got ${resolves.length}.`);
    assert.strictEqual(resolves[0].itemId, 'bug-82-i',
      `bug-82: device ${i}'s critique-resolved payload must carry the right itemId. Got ${JSON.stringify(resolves[0].itemId)}.`);
  }
});

console.log(`── bug-82: ${passed} passed, ${failed} failed ──`);
process.exit(failed === 0 ? 0 : 1);
