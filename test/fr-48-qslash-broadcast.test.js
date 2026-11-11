// fr-48 follow-up: queue slash commands (/queue /qcancel /qclear
// /qresume) must broadcast state-update via the session passed in
// ctx.session — not via a lazy require('./attach').getSession()
// lookup. User-reported: "the queue display is not update after sent
// /qcancel".
//
// The dispatcher (attach.js handleChatMessage) already puts the live
// session on ctx as `ctx.session` (see attach.js dispatch wiring).
// Slash commands should use that directly instead of re-discovering
// the session via attachMod.getSession(ctx.sessionId) which (a) does
// a redundant Map lookup and (b) failed silently when attachMod
// resolved to a half-loaded require cycle.
//
// Static guards on the handler bodies — they MUST reference
// ctx.session.emit somewhere in the broadcast path.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const PROD_SLASHCMDS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');

console.log('── fr-48 follow-up: queue slash commands broadcast via ctx.session ──');

function _grabHandler(src, fnName) {
  const start = src.search(new RegExp('function\\s+' + fnName + '\\s*\\('));
  if (start === -1) return null;
  const rest = src.slice(start);
  const next = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

for (const fn of ['handleQueue', 'handleQCancel', 'handleQClear', 'handleQResume']) {
  t(`${fn} uses ctx.session.emit for state-update broadcast`, () => {
    const body = _grabHandler(PROD_SLASHCMDS, fn);
    assert.ok(body, `${fn} must exist in slashcmds.js`);
    // Must reference ctx.session somewhere — direct .emit OR via a
    // shared helper that takes session as arg.
    assert.ok(/ctx\.session/.test(body),
      `${fn} must reference ctx.session (passed in by the dispatcher) instead of looking up via attachMod.getSession`);
    // Must NOT re-discover via attachMod.getSession — that path
    // silently failed on the user's /qcancel test.
    assert.ok(!/attachMod\.getSession|require\(['"]\.\/attach['"]\)\.getSession/.test(body),
      `${fn} must NOT call attachMod.getSession / require('./attach').getSession — use ctx.session passed in by the dispatcher`);
  });
}

t('handleQCancel emits state-update {kind:"runQueue"} after removal', () => {
  const body = _grabHandler(PROD_SLASHCMDS, 'handleQCancel');
  assert.ok(body);
  // Verify the emit appears AFTER the removeFromQueue call (otherwise
  // we'd broadcast pre-mutation state). Simple positional check.
  const removeIdx = body.indexOf('removeFromQueue');
  const emitIdx = body.search(/\.emit\s*\(\s*['"`]state-update['"`]/);
  assert.ok(removeIdx > -1, 'handleQCancel must call removeFromQueue');
  assert.ok(emitIdx > -1, 'handleQCancel must emit state-update');
  assert.ok(emitIdx > removeIdx,
    'emit state-update must come AFTER removeFromQueue so the broadcast carries the post-removal state');
});

t('handleQClear emits state-update after clearQueue', () => {
  const body = _grabHandler(PROD_SLASHCMDS, 'handleQClear');
  assert.ok(body);
  const clearIdx = body.indexOf('clearQueue');
  const emitIdx = body.search(/\.emit\s*\(\s*['"`]state-update['"`]/);
  assert.ok(clearIdx > -1, 'handleQClear must call clearQueue');
  assert.ok(emitIdx > -1, 'handleQClear must emit state-update');
  assert.ok(emitIdx > clearIdx,
    'emit must come AFTER clearQueue so the broadcast carries the post-clear state');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
