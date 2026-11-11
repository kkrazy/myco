// fr-92: auto-open the user manual on first page load per browser.
//
// User request: "for first time user, e.g. first time login, pop up
//  the user manual automatically."
//
// Implementation:
//   • _maybeShowFirstTimeManual() in web/public/app.js
//   • Tracks "have I shown the manual to this browser?" via
//     localStorage key `myco_manual_seen` ('1' = yes).
//   • Skips viewer-mode visitors (share-link landings) since they're
//     not the session owner and don't need onboarding.
//   • Sets the flag BEFORE the setTimeout that opens the modal so a
//     failed `openManualModal` (modal element missing) doesn't trap
//     the user in an "always-open" loop next reload.
//   • Wired into init() after the rest of the UI is bound so the
//     modal opens over a populated UI.
//
// No jsdom on the project — static-shape guards on the function +
// its wiring carry the contract.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr-92: first-time-user manual auto-open ──');

t('app.js: _maybeShowFirstTimeManual function defined', () => {
  assert.ok(/function\s+_maybeShowFirstTimeManual\s*\(/.test(APP),
    '_maybeShowFirstTimeManual must be defined');
});

t('app.js: _maybeShowFirstTimeManual uses localStorage key myco_manual_seen', () => {
  const idx = APP.search(/function\s+_maybeShowFirstTimeManual\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/myco_manual_seen/.test(win),
    'must persist the seen flag under localStorage key myco_manual_seen');
  assert.ok(/localStorage\.getItem/.test(win) && /localStorage\.setItem/.test(win),
    'must both READ + WRITE localStorage to remember the user');
});

t('app.js: _maybeShowFirstTimeManual skips viewer-mode (share-link landings)', () => {
  const idx = APP.search(/function\s+_maybeShowFirstTimeManual\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/state\.viewerMode/.test(win),
    'must early-return when state.viewerMode is true (share-link visitors don\'t need onboarding)');
});

t('app.js: _maybeShowFirstTimeManual calls openManualModal', () => {
  const idx = APP.search(/function\s+_maybeShowFirstTimeManual\s*\(/);
  const win = sliceFn(APP, idx);
  assert.ok(/openManualModal\(/.test(win),
    'must invoke the existing openManualModal helper');
});

t('app.js: _maybeShowFirstTimeManual sets seen flag BEFORE opening modal', () => {
  // Failure mode this prevents: if openManualModal throws (modal DOM
  // missing, etc.), an "open-then-set-flag" order would never set the
  // flag and trap the user in an "always opens on every reload" loop.
  const idx = APP.search(/function\s+_maybeShowFirstTimeManual\s*\(/);
  const win = sliceFn(APP, idx);
  const setIdx = win.indexOf('localStorage.setItem');
  const openIdx = win.indexOf('openManualModal');
  assert.ok(setIdx > -1 && openIdx > -1,
    'function must contain both setItem and openManualModal');
  assert.ok(setIdx < openIdx,
    'localStorage.setItem must come BEFORE openManualModal (so a thrown openManualModal does not trap the user in an open-on-every-reload loop)');
});

t('app.js: init() invokes _maybeShowFirstTimeManual after the rest of UI binds', () => {
  const idx = APP.search(/async\s+function\s+init\s*\(/);
  assert.ok(idx > -1, 'init() must exist');
  const win = sliceFn(APP, idx);
  assert.ok(/_maybeShowFirstTimeManual\(/.test(win),
    'init() must call _maybeShowFirstTimeManual()');
  // Must come after showBuildStamp / showUserStamp / bindChatUi —
  // wiring those first means the modal opens over a populated UI.
  const callIdx = win.indexOf('_maybeShowFirstTimeManual');
  const userStampIdx = win.indexOf('showUserStamp');
  assert.ok(callIdx > userStampIdx,
    'auto-open must fire AFTER showUserStamp so the modal lands on a populated UI');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
