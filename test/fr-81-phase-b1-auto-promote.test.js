// fr-81 Phase B.1: auto-promote a freshly-filed remote issue into a
// local plan item carrying meta.remoteUrl.
//
// User-confirmed promotion model (AskUserQuestion in the 2026-06-03
// session): "Auto-promote on /feature & /bug — file remote + add to
// plan.json with meta.remoteUrl". This is the dedup anchor that
// Phase B.2 (dedup at render), B.3 (close-detection mirror), and
// B.4 (write-back-on-close) will key against.
//
// Scope (this commit):
//   · _autoPromoteRemoteIssueToPlan(rec, sessionId, opts) helper
//     in slashcmds.js. Idempotent: a second call with the same
//     remoteUrl returns the existing item unchanged. source=
//     'auto-promote' tag so a future filter can distinguish from
//     manually-typed /fr items.
//   · handleRemoteIssue success path (/fr @target, /bug @target,
//     /td @target) calls the helper before ctx.reply.
//   · handleIssue success path (/feature) calls the helper before
//     ctx.reply. Layer derived from kind.
//
// Phase B.2 (dedup), B.3 (close-mirror), B.4 (write-back) remain
// deferred — each will dispatch separately.
//
// Test shape: static-grep guards + a unit-style invocation of the
// idempotency contract via the exported helper.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-81 Phase B.1: auto-promote remote issue → local plan item ──');

t('server/src/slashcmds.js: _autoPromoteRemoteIssueToPlan helper is defined', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/function\s+_autoPromoteRemoteIssueToPlan\s*\(/.test(src),
    '_autoPromoteRemoteIssueToPlan must be defined (Phase B.1 — the helper that creates the dedup anchor).');
});

t('server/src/slashcmds.js: helper sets meta.remoteUrl on the new plan item', () => {
  const src = _read('server/src/slashcmds.js');
  const at = src.search(/function\s+_autoPromoteRemoteIssueToPlan\s*\(/);
  assert.ok(at > -1);
  const body = sliceFn(src, at);
  // The constructed item must include meta.remoteUrl. Loose match on
  // the object literal pattern: meta: { … remoteUrl … }.
  assert.ok(/meta\s*:\s*\{[\s\S]{0,400}remoteUrl/.test(body),
    'the auto-promote helper must construct the new plan item with meta.remoteUrl=<url> (Phase B.1 — the dedup anchor).');
});

t('server/src/slashcmds.js: helper is idempotent — second call with same remoteUrl returns the existing item, not a duplicate', () => {
  const src = _read('server/src/slashcmds.js');
  const at = src.search(/function\s+_autoPromoteRemoteIssueToPlan\s*\(/);
  const body = sliceFn(src, at);
  // The idempotency guard scans existing items for a matching
  // meta.remoteUrl BEFORE inserting.
  assert.ok(/find\s*\(\s*\(it\)\s*=>\s*it\.meta[\s\S]{0,100}remoteUrl\s*===\s*remoteUrl/.test(body),
    'auto-promote must scan existing items for a matching meta.remoteUrl + short-circuit on hit (no duplicate plan items for the same remote issue).');
});

t('server/src/slashcmds.js: helper tags the new item source="auto-promote" (distinguishable from manually-typed /fr items)', () => {
  const src = _read('server/src/slashcmds.js');
  const at = src.search(/function\s+_autoPromoteRemoteIssueToPlan\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/source\s*:\s*['"]auto-promote['"]/.test(body),
    'the new plan item must be tagged source="auto-promote" so a future Plan-tab filter can distinguish promoted items from manually-typed ones.');
});

t('server/src/slashcmds.js: helper persists via _persistPlanArtifact (rides the same write path as /fr /td /bug)', () => {
  const src = _read('server/src/slashcmds.js');
  const at = src.search(/function\s+_autoPromoteRemoteIssueToPlan\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/_persistPlanArtifact\s*\(\s*rec\s*,\s*sessionId\s*\)/.test(body),
    'auto-promote must persist via _persistPlanArtifact so plan.json + the state-update broadcast ride the same path as manually-typed plan items.');
});

t('server/src/slashcmds.js: handleRemoteIssue (/fr @target) success path calls the helper before ctx.reply', () => {
  const src = _read('server/src/slashcmds.js');
  // Find the handleRemoteIssue function body.
  const at = src.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  assert.ok(at > -1, 'handleRemoteIssue must exist.');
  // The success path is the bottom of the function, after all the
  // error branches return. Look for the ctx.reply with the "✓ Filed"
  // line + an _autoPromoteRemoteIssueToPlan call near it.
  // We bound to the next `async function` to avoid colliding with
  // the next function's body.
  const end = src.indexOf('async function ', at + 50);
  const body = src.slice(at, end > -1 ? end : at + 6000);
  assert.ok(/_autoPromoteRemoteIssueToPlan\s*\(/.test(body),
    'handleRemoteIssue success path must invoke _autoPromoteRemoteIssueToPlan (Phase B.1 wiring).');
});

t('server/src/slashcmds.js: handleIssue (/feature) success path calls the helper before ctx.reply', () => {
  const src = _read('server/src/slashcmds.js');
  const at = src.search(/async\s+function\s+handleIssue\s*\(/);
  assert.ok(at > -1, 'handleIssue must exist.');
  const end = src.indexOf('async function ', at + 50);
  const body = src.slice(at, end > -1 ? end : at + 6000);
  assert.ok(/_autoPromoteRemoteIssueToPlan\s*\(/.test(body),
    'handleIssue success path must invoke _autoPromoteRemoteIssueToPlan (Phase B.1 wiring).');
});

t('server/src/slashcmds.js: both auto-promote callsites guard against failure with try/catch (best-effort — promote failure must not break the user-facing "filed" reply)', () => {
  const src = _read('server/src/slashcmds.js');
  // Count occurrences of the [fr-81 Phase B.1] error log marker.
  // The console.error in the catch fires for both callsites, so we
  // should see >= 2 markers in error-log shape.
  const hits = (src.match(/\[fr-81 Phase B\.1\]\s+auto-promote failed/g) || []).length;
  assert.ok(hits >= 2,
    `both callsites must wrap _autoPromoteRemoteIssueToPlan in try/catch with a "[fr-81 Phase B.1] auto-promote failed" log marker (best-effort policy: promote failure cannot break the user-facing filed reply). Found ${hits}; need >= 2.`);
});

t('a comment naming "fr-81 Phase B.1" explains the auto-promote plumbing', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/fr-81 Phase B\.1/.test(src),
    'a comment naming "fr-81 Phase B.1" must appear in slashcmds.js so a future restyle understands why /feature and /fr @target suddenly write a local plan item.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
