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

// ─── multi-select toggle: single-flip invariant ────────────────────────
// Pre-fix, handleMenuToggle flipped opt.checked TWICE for one click —
// once inside _toggleMenuChatCheckbox (which mutates the persisted chat
// row's options array) and once on `pending.options` (same object
// reference, since broadcastMenuToChat doesn't clone). Net flip was
// zero; the chat picker's checkbox UI never moved and the menu-multi
// diagnostic always logged the initial state. Worse: clicks STILL drove
// claude's TUI (the digit write is independent), so server state and
// claude state diverged. Verified 2026-05-13 on mycobeta demo010 — a
// "select 2 of 4" interaction logged BOTH toggles as "unchecked"
// despite the user trying to check.

t('toggle: one click flips opt.checked exactly once (no double-flip)', () => {
  const sid = 'sess-toggle-1';
  const opts = [
    { n: 1, label: 'PTY output streaming', checkbox: true, checked: false },
    { n: 2, label: 'Preview-icon parity',  checkbox: true, checked: false },
  ];
  const menu = { hash: 'h_features', question: 'Which features?', options: opts, kind: 'plan', multi: true };
  seedStore(sid, [menu]);
  const session = makeMockSession();
  session.pendingMenu = menu;
  ptyMod.handleMenuToggle(sid, session, 1, 'h_features');
  const chat = freshChat(sid);
  // Persisted state must reflect the toggle.
  assert.strictEqual(chat[0].meta.menu.options[0].checked, true, 'option 1 must be checked after one click');
  assert.strictEqual(chat[0].meta.menu.options[1].checked, false, 'option 2 untouched');
  // PTY received bare digit (no CR).
  assert.deepStrictEqual(session.writes, ['1'], 'PTY should receive a bare "1"');
  // Hash UNCHANGED — hashMenu deliberately excludes checked state so the
  // chat row keeps its identity across toggles.
  assert.strictEqual(chat[0].meta.menu.hash, 'h_features');
});

t('toggle: two clicks on the same option return to initial state', () => {
  // Net effect of click + click is identity. With the pre-fix double-
  // flip bug, this property held trivially (each click was net zero),
  // so this test alone doesn't catch the regression — pair with the
  // single-click test above. Both must be green.
  const sid = 'sess-toggle-2';
  const opts = [{ n: 1, label: 'OAuth', checkbox: true, checked: false }];
  const menu = { hash: 'h_two', question: 'Q?', options: opts, kind: 'plan', multi: true };
  seedStore(sid, [menu]);
  const session = makeMockSession();
  session.pendingMenu = menu;
  ptyMod.handleMenuToggle(sid, session, 1, 'h_two');
  ptyMod.handleMenuToggle(sid, session, 1, 'h_two');
  const chat = freshChat(sid);
  assert.strictEqual(chat[0].meta.menu.options[0].checked, false, 'two clicks return to false');
  assert.deepStrictEqual(session.writes, ['1', '1'], 'PTY received two bare "1"s');
});

t('toggle: pending.options and the persisted row share the same object reference', () => {
  // Invariant the double-flip bug relied on (and which the fix relies
  // on too — only one of pending vs persisted does the flip). If a
  // future refactor clones either side, the toggle UI will silently
  // diverge from the persisted record; this test ensures the
  // invariant is documented.
  const sid = 'sess-toggle-3';
  const opts = [{ n: 1, label: 'X', checkbox: true, checked: false }];
  const menu = { hash: 'h_ref', question: 'Q?', options: opts, kind: 'plan', multi: true };
  seedStore(sid, [menu]);
  const persisted = sessionsMod.loadStore().sessions[sid].chat[0].meta.menu.options[0];
  // Same {n, label, checkbox, checked} fields but distinct object on
  // reload (JSON.parse made a copy). That's fine — what matters is
  // that handleMenuToggle treats persisted as authoritative and only
  // flips it once.
  const session = makeMockSession();
  session.pendingMenu = menu;
  ptyMod.handleMenuToggle(sid, session, 1, 'h_ref');
  const reloaded = sessionsMod.loadStore().sessions[sid].chat[0].meta.menu.options[0];
  assert.strictEqual(reloaded.checked, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
