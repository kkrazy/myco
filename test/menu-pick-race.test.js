// Regression for the menu-pick race condition.
//
// Setup: two menus broadcast back-to-back (hash_A, hash_B), claude
// already moved on so session.pendingMenu == menu_B. User clicks menu_A
// (the older callout still visible in chat).
//
// Pre-fix (`handleMenuPick(sessionId, session, n)`):
//   - persist marks the LATEST unanswered chat row → menu_B gets stamped
//     with the user's pick from menu_A (wrong).
//   - PTY write happens because n is valid in menu_B's options too →
//     answers the wrong question.
//
// Post-fix (`handleMenuPick(sessionId, session, n, hash)`):
//   - persist locates the chat row by `meta.menu.hash === hash` and
//     stamps menu_A correctly.
//   - PTY write is DROPPED because pending.hash !== clicked hash.
//   - menu_B stays unanswered until the user clicks IT specifically.
//
// Also covers the back-compat path (no hash supplied) to make sure
// older clients still work in the simple single-menu case.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect the sessions-store path BEFORE requiring pty/sessions so the
// real /data/sessions.json isn't touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pick-race-'));
process.env.MYCO_STATE_DIR = tmp;
process.env.MYCO_WORKSPACE = path.join(tmp, 'wks');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');
const ptyMod = require('../server/src/pty');

let passed = 0;
let failed = 0;

function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// Mock session: just enough for handleMenuPick.
function makeMockSession() {
  return {
    alive: true,
    pendingMenu: null,
    writes: [],
    write(chunk) { this.writes.push(chunk); },
  };
}

function seedStore(sessionId, menus) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sessionId] = {
    id: sessionId,
    user: 'kkrazy',
    cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    claudeSessionId: null,
    createdAt: new Date().toISOString(),
    chat: menus.map((mn) => ({
      ts: new Date().toISOString(),
      user: 'claude',
      text: '🤔 menu',
      meta: { kind: 'menu', menu: mn, answered: false },
    })),
  };
  sessionsMod.saveStore();
}

function freshChat(sessionId) {
  return sessionsMod.loadStore().sessions[sessionId].chat;
}

console.log('── menu-pick race condition ──');

t('back-compat: no hash supplied → falls back to latest unanswered + PTY write', () => {
  const sid = 'sess-compat-1';
  const opts = [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }];
  const menuA = { hash: 'h_A', question: 'A?', options: opts, kind: 'plan' };
  seedStore(sid, [menuA]);
  const session = makeMockSession();
  session.pendingMenu = menuA;
  ptyMod.handleMenuPick(sid, session, 1, null);  // legacy frame: no hash
  const chat = freshChat(sid);
  assert.strictEqual(chat[0].meta.answered, true, 'menu A should be marked answered');
  assert.strictEqual(chat[0].meta.pickedN, 1);
  assert.deepStrictEqual(session.writes, ['1\r'], 'PTY should receive 1\\r');
  assert.strictEqual(session.pendingMenu, null, 'pendingMenu cleared after write');
});

t('hash path: stale click on menu A drops PTY write but persists A correctly', () => {
  const sid = 'sess-race-1';
  const opts = [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }];
  const menuA = { hash: 'h_A_stale', question: 'A?', options: opts, kind: 'plan' };
  const menuB = { hash: 'h_B_active', question: 'B?', options: opts, kind: 'plan' };
  seedStore(sid, [menuA, menuB]);                  // chat has both rows
  const session = makeMockSession();
  session.pendingMenu = menuB;                     // TUI is on B now
  ptyMod.handleMenuPick(sid, session, 1, 'h_A_stale');
  const chat = freshChat(sid);
  // Row A should be marked answered with user's pick
  assert.strictEqual(chat[0].meta.answered, true, 'menu A row should be answered');
  assert.strictEqual(chat[0].meta.pickedN, 1);
  // Row B should remain UNANSWERED — the user did not actually click it
  assert.strictEqual(chat[1].meta.answered, false, 'menu B row must NOT be answered');
  assert.strictEqual(chat[1].meta.pickedN, undefined);
  // PTY must NOT receive the digit — landing 1 on menu B would answer the wrong question
  assert.deepStrictEqual(session.writes, [], 'PTY write should be dropped for stale click');
  assert.strictEqual(session.pendingMenu, menuB, 'pendingMenu untouched (B still active)');
});

t('hash path: click on the currently-active menu B writes to PTY', () => {
  const sid = 'sess-race-2';
  const opts = [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }];
  const menuA = { hash: 'h_A2', question: 'A?', options: opts, kind: 'plan' };
  const menuB = { hash: 'h_B2', question: 'B?', options: opts, kind: 'plan' };
  seedStore(sid, [menuA, menuB]);
  const session = makeMockSession();
  session.pendingMenu = menuB;
  ptyMod.handleMenuPick(sid, session, 2, 'h_B2');
  const chat = freshChat(sid);
  assert.strictEqual(chat[0].meta.answered, false, 'menu A row stays unanswered');
  assert.strictEqual(chat[1].meta.answered, true, 'menu B row marked answered');
  assert.strictEqual(chat[1].meta.pickedN, 2);
  assert.deepStrictEqual(session.writes, ['2\r']);
  assert.strictEqual(session.pendingMenu, null);
});

t('hash path: post-restart click (pendingMenu cleared) still persists on the right row', () => {
  const sid = 'sess-race-3';
  const opts = [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }];
  const menuA = { hash: 'h_A3', question: 'A?', options: opts, kind: 'plan' };
  const menuB = { hash: 'h_B3', question: 'B?', options: opts, kind: 'plan' };
  seedStore(sid, [menuA, menuB]);
  const session = makeMockSession();
  session.pendingMenu = null;                      // server restarted, in-memory state gone
  ptyMod.handleMenuPick(sid, session, 1, 'h_A3');
  const chat = freshChat(sid);
  assert.strictEqual(chat[0].meta.answered, true, 'menu A row stamped even with no live pendingMenu');
  assert.strictEqual(chat[0].meta.pickedN, 1);
  assert.strictEqual(chat[1].meta.answered, false, 'menu B row untouched');
  assert.deepStrictEqual(session.writes, [], 'PTY write skipped — claude is past the menu');
});

t('hash path: unknown hash → no row stamped, no PTY write', () => {
  const sid = 'sess-race-4';
  const opts = [{ n: 1, label: 'Yes' }];
  const menuA = { hash: 'real_hash', question: '?', options: opts, kind: 'plan' };
  seedStore(sid, [menuA]);
  const session = makeMockSession();
  session.pendingMenu = menuA;
  ptyMod.handleMenuPick(sid, session, 1, 'fictitious_hash');
  const chat = freshChat(sid);
  assert.strictEqual(chat[0].meta.answered, false, 'unknown-hash click should not mark anything');
  // PTY write is also dropped — pending.hash !== clicked hash.
  assert.deepStrictEqual(session.writes, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
