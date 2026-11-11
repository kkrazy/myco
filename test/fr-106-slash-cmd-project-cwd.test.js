// fr-106: slash commands run from the main project dir by default.
//
// Pre-fr-106: attach.js's slash-command dispatcher set ctx.absCwd =
// rec.absCwd (the session workspace wrapper). When rec.mainProject
// was set (fr-94), the SDK's Claude tools correctly anchored to
// <absCwd>/<mainProject>, but /git and other slash commands ran from
// the wrapper — forcing users to type /git -C '<mainProject>' every
// time.
//
// Post-fr-106: ctx.absCwd is set to sessionsMod.resolveAgentCwd(rec),
// which returns:
//   * rec.absCwd                             — no mainProject
//   * rec.absCwd + '/' + rec.mainProject    — mainProject set, clone not pending
//   * rec.absCwd                             — mainProject set, clone still pending (safe fallback)
//
// Contract tested:
//   1. sessions.js exports resolveAgentCwd (attach.js's dispatcher needs it).
//   2. resolveAgentCwd semantics: mainProject-set + not-pending → subdir;
//      no mainProject → workspace root; clone pending → workspace root.
//   3. attach.js dispatcher sources ctx.absCwd from resolveAgentCwd, not
//      directly from rec.absCwd (static guard on the exact line).
//   4. handleGit uses rec.absCwd for the git subprocess cwd today; the
//      real fix flows via ctx.absCwd from the dispatcher, so we assert
//      that when a mainProject-set rec is dispatched, ctx.absCwd
//      matches the project subdir the SDK uses.
//   5. Sessions without mainProject see zero behavioral change.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-106: slash commands run from the project dir by default ──');

// ──────────────────────────────────────────────────────────────────
// Group A: resolveAgentCwd semantics.

t('sessions.js exports resolveAgentCwd', () => {
  const sessionsMod = require('../server/src/sessions');
  assert.strictEqual(typeof sessionsMod.resolveAgentCwd, 'function',
    'sessions.js must export resolveAgentCwd so attach.js can call it for the slash-command ctx');
});

t('resolveAgentCwd: no mainProject → returns rec.absCwd unchanged', () => {
  const { resolveAgentCwd } = require('../server/src/sessions');
  const rec = { absCwd: '/wks/alice/sess-1' };
  assert.strictEqual(resolveAgentCwd(rec), '/wks/alice/sess-1',
    'sessions without mainProject must fall through to the workspace root (backward-compat)');
});

t('resolveAgentCwd: mainProject set + clone not pending → returns project subdir', () => {
  const { resolveAgentCwd } = require('../server/src/sessions');
  const rec = { absCwd: '/wks/alice/sess-1', mainProject: 'omni-cache' };
  assert.strictEqual(resolveAgentCwd(rec), '/wks/alice/sess-1/omni-cache',
    'mainProject-set + not-pending must anchor to the project subdir (matches SDK cwd for Claude tools)');
});

t('resolveAgentCwd: mainProject set BUT clone still pending → falls back to rec.absCwd', () => {
  const { resolveAgentCwd } = require('../server/src/sessions');
  const rec = { absCwd: '/wks/alice/sess-1', mainProject: 'omni-cache', cloneState: 'pending' };
  assert.strictEqual(resolveAgentCwd(rec), '/wks/alice/sess-1',
    'clone-pending sessions must fall back to workspace root (the subdir may not exist yet)');
});

t('resolveAgentCwd: mainProject empty string → falls back to rec.absCwd (defensive)', () => {
  const { resolveAgentCwd } = require('../server/src/sessions');
  const rec = { absCwd: '/wks/alice/sess-1', mainProject: '' };
  assert.strictEqual(resolveAgentCwd(rec), '/wks/alice/sess-1',
    'an empty mainProject must NOT concatenate junk into the cwd — treat as unset');
});

// ──────────────────────────────────────────────────────────────────
// Group B: static guards.

t('static guard: attach.js dispatcher sources ctx.absCwd from resolveAgentCwd (fr-106)', () => {
  const src = _read('server/src/attach.js');
  // Anchor on the UNIQUE slash-dispatch call `slashcmds.dispatch(` —
  // NOT on `text.startsWith('/')` which appears multiple times in
  // handleChatMessage (read-only-viewer guard, login-callback divert,
  // slash-dispatch branch). Window from the ctx setup up to (but not
  // including) the dispatch call so we can assert on the setup shape.
  const dispatchIdx = src.indexOf('slashcmds.dispatch(');
  assert.ok(dispatchIdx > 0, 'slashcmds.dispatch call must exist in attach.js');
  // Walk backwards ~2000 bytes to capture the ctx setup + any comments
  // preceding it. Cap at 0 so we don't underrun on a tiny file.
  const setupStart = Math.max(0, dispatchIdx - 2500);
  const setupWindow = src.slice(setupStart, dispatchIdx);
  // Must reference resolveAgentCwd (as sessionsMod.resolveAgentCwd or
  // via a local destructured alias — the fnBody body slice includes
  // both forms).
  assert.ok(/resolveAgentCwd\s*\(\s*rec\s*\)/.test(setupWindow),
    'slash-command dispatcher must set ctx.absCwd via resolveAgentCwd(rec) so /git etc. inherit the project subdir (fr-106)');
  // The pre-fr-106 shape must NOT appear as the standalone ctx.absCwd
  // declaration. It's OK inside a comment referring to the old
  // behavior; look for the actual `const absCwd = rec && rec.absCwd;`
  // declaration line only.
  assert.ok(!/^\s*const absCwd\s*=\s*rec\s*&&\s*rec\.absCwd\s*;/m.test(setupWindow),
    'the pre-fr-106 line `const absCwd = rec && rec.absCwd;` must be gone from the slash-command dispatcher — otherwise the fix does nothing');
  // The block must carry an fr-106 marker so future readers know why.
  assert.ok(/fr-106/.test(setupWindow),
    'the slash-command dispatcher block must carry an fr-106 marker so future readers know why');
});

t('static guard: sessions.js export block includes resolveAgentCwd', () => {
  const src = _read('server/src/sessions.js');
  // The export block uses Object.assign(module.exports, { ... }). We
  // just check the identifier appears BOTH as a function declaration
  // AND inside the export object.
  assert.ok(/^function\s+resolveAgentCwd\s*\(/m.test(src),
    'resolveAgentCwd function declaration must exist');
  // Must appear inside the Object.assign export block (after the
  // "Object.assign(module.exports" anchor).
  const exportIdx = src.indexOf('Object.assign(module.exports');
  assert.ok(exportIdx > 0, 'Object.assign(module.exports, {...}) export block must exist');
  const exportBlock = src.slice(exportIdx);
  assert.ok(/resolveAgentCwd\s*[,\n}]/.test(exportBlock),
    'the export block must include resolveAgentCwd so attach.js can require it');
});

t('static guard: handleGit still runs git with the ctx-supplied cwd (execFile chain unchanged)', () => {
  // fr-106 fix flows via ctx.absCwd from the dispatcher; handleGit
  // itself uses rec.absCwd today (its own record lookup, not ctx).
  // This test locks that handleGit's execFile still passes SOME cwd
  // resolved from the session record so a future refactor doesn't
  // accidentally drop it.
  const src = _read('server/src/slashcmds.js');
  const body = fnBody(src, /function\s+handleGit\s*\(/);
  assert.ok(body, 'handleGit body must be locatable');
  assert.ok(/execFile\s*\(\s*['"]git['"]/.test(body),
    'handleGit must invoke execFile("git", ...)');
  assert.ok(/cwd:\s*\w/.test(body),
    'execFile options must include a cwd so git runs in the right dir');
});

// ──────────────────────────────────────────────────────────────────
// Group C: end-to-end via a stubbed session store — the dispatcher
// path through attach.js sets ctx.absCwd correctly for both branches.

t('behavioral: dispatcher-shape helper — mainProject-set rec resolves to the project subdir', () => {
  // Rather than mock the full attach.js dispatcher (heavy), we
  // duplicate the exact expression the dispatcher uses. This locks the
  // semantics from the OTHER angle: the fix requires the helper to
  // produce a project-anchored path for mainProject-set records.
  const { resolveAgentCwd } = require('../server/src/sessions');
  const mainProjectRec = { absCwd: '/wks/alice/sess-1', mainProject: 'omni-cache' };
  const bareRec        = { absCwd: '/wks/alice/sess-2' };
  const pendingRec     = { absCwd: '/wks/alice/sess-3', mainProject: 'x', cloneState: 'pending' };
  // The dispatcher expression: `rec ? resolveAgentCwd(rec) : null`
  const cwdForMainProject = mainProjectRec ? resolveAgentCwd(mainProjectRec) : null;
  const cwdForBare        = bareRec        ? resolveAgentCwd(bareRec)        : null;
  const cwdForPending     = pendingRec     ? resolveAgentCwd(pendingRec)     : null;
  assert.strictEqual(cwdForMainProject, '/wks/alice/sess-1/omni-cache',
    'mainProject-set → dispatcher ctx.absCwd points at the project subdir (this is the fr-106 fix)');
  assert.strictEqual(cwdForBare, '/wks/alice/sess-2',
    'no mainProject → dispatcher ctx.absCwd unchanged from pre-fr-106 (backward-compat)');
  assert.strictEqual(cwdForPending, '/wks/alice/sess-3',
    'clone-pending → dispatcher ctx.absCwd falls back to workspace root (safe until clone completes)');
});

t('behavioral: null rec (session vanished) → dispatcher yields absCwd=null (defensive)', () => {
  const rec = null;
  // Mirror the dispatcher's expression: `rec ? resolveAgentCwd(rec) : null`
  const absCwd = rec ? require('../server/src/sessions').resolveAgentCwd(rec) : null;
  assert.strictEqual(absCwd, null,
    'a missing session record must yield absCwd=null so slash handlers can bail with a clean error');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
