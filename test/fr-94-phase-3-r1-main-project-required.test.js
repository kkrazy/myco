// fr-94 Phase 3 r1: the spawn-modal "Main project" field is REQUIRED.
//
// User-reported (verbatim):
//   "the main project shouldn't be optional"
//
// Why: Phase 1 introduced the field as optional so legacy clients
// (pre-fr-94) wouldn't break. Now that fr-94 has shipped through
// Phase 3, every NEW session must designate one main project up
// front — _myco_/ (plan.json, critic.md, events.jsonl, diagrams)
// needs a canonical home from the very first event, not "set later
// via lazy migration after the user hits attach." Legacy sessions
// with no rec.mainProject keep working via Phase 2's lazy auto-
// migration on WS attach; the required-field gate applies ONLY to
// NEW spawns through the spawn modal.
//
// Implementation (locked here):
//   1. web/public/index.html — spawn-main-project <input> has the
//      `required` attribute; the label says "required" not "optional".
//   2. web/public/app.js doSpawn — empty mainProjectRaw shows an
//      inline error and aborts before the POST.
//   3. server/src/index.js POST /sessions — 400 reject when neither
//      gitCloneUrl nor mainProjectName is provided (defense-in-depth
//      against a stale client).
//
// Test shape: static-grep across all three layers.

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

console.log('── fr-94 Phase 3 r1: main project is required ──');

t('web/public/index.html: spawn-main-project <input> carries the `required` attribute', () => {
  const html = _read('web/public/index.html');
  // Locate the <input id="spawn-main-project" …> tag and assert that
  // `required` is one of its attributes. Whitespace-tolerant match
  // (the tag may have many attrs in any order).
  const inputMatch = html.match(/<input[^>]*\bid\s*=\s*['"]spawn-main-project['"][^>]*>/);
  assert.ok(inputMatch, 'spawn-main-project <input> must exist (fr-94 Phase 1 plumbing).');
  assert.ok(/\brequired\b/.test(inputMatch[0]),
    'spawn-main-project <input> must carry the `required` attribute so the browser blocks empty form submissions (fr-94 Phase 3 r1).');
});

t('web/public/index.html: spawn-main-project label says "required" (not "optional")', () => {
  const html = _read('web/public/index.html');
  // The label text in the same <label> that wraps spawn-main-project
  // must reflect the new required-ness. Negative assertion blocks
  // accidental revert to "optional".
  const labelBlock = html.match(/<label>[^<]*Main project[^<]*[\s\S]{0,400}?spawn-main-project/);
  assert.ok(labelBlock, 'Main project <label> must wrap the spawn-main-project input.');
  assert.ok(/required/i.test(labelBlock[0]),
    'Main project <label> must say "required" so the user understands the field is mandatory (fr-94 Phase 3 r1).');
  assert.ok(!/optional/i.test(labelBlock[0]),
    'Main project <label> must NOT contain the word "optional" — the field is now required (fr-94 Phase 3 r1).');
});

t('web/public/app.js: doSpawn aborts with an inline error when the main-project field is empty', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/async\s+function\s+doSpawn\s*\(/);
  assert.ok(at > -1, 'doSpawn() must exist.');
  const body = sliceFn(app, at);
  // The body must read mainProjectRaw and short-circuit on empty
  // BEFORE the POST. Loose-match the empty check + error path.
  assert.ok(/mainProjectRaw/.test(body),
    'doSpawn() must read the mainProjectRaw value to validate it (fr-94 Phase 1 plumbing).');
  // The empty-check guard + early return must appear before the POST.
  const postAt = body.search(/authedFetch\s*\(\s*['"]\/sessions['"]/);
  assert.ok(postAt > -1, 'doSpawn() must POST to /sessions.');
  const beforePost = body.slice(0, postAt);
  assert.ok(/if\s*\(\s*!\s*mainProjectRaw\s*\)/.test(beforePost),
    'doSpawn() must check `if (!mainProjectRaw)` BEFORE the POST so empty submissions never reach the server (fr-94 Phase 3 r1 — client-side guard for faster feedback).');
  assert.ok(/Main project is required/i.test(beforePost),
    'doSpawn() must surface a "Main project is required" inline error in the empty branch (fr-94 Phase 3 r1).');
});

t('server/src/index.js: POST /sessions rejects with 400 when neither gitCloneUrl nor mainProjectName is provided', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/app\.post\(\s*['"]\/sessions['"]/);
  assert.ok(at > -1, 'POST /sessions route must exist.');
  const body = src.slice(at, at + 2500);
  // The handler must validate both inputs + return a 400 with a
  // helpful error message BEFORE calling spawnSession.
  assert.ok(/res\.status\(400\)/.test(body),
    'POST /sessions must return 400 when validation fails (fr-94 Phase 3 r1).');
  assert.ok(/Main project is required/i.test(body),
    'POST /sessions must include "Main project is required" in the 400 error message so a stale client surfaces a clear failure (fr-94 Phase 3 r1).');
  // The guard must fire BEFORE spawnSession is called — otherwise
  // we'd leak a half-spawned session.
  const guardAt = body.search(/res\.status\(400\)[^;]*Main project is required/);
  const spawnAt = body.search(/spawnSession\s*\(/);
  assert.ok(guardAt > -1 && spawnAt > -1 && guardAt < spawnAt,
    'POST /sessions must reject with 400 BEFORE calling spawnSession — otherwise a session would be half-spawned then abandoned (fr-94 Phase 3 r1).');
});

t('a comment naming "fr-94 Phase 3 r1" explains the required-field gate', () => {
  const files = [
    'web/public/index.html',
    'web/public/app.js',
    'server/src/index.js',
  ];
  let found = 0;
  for (const f of files) {
    if (/fr-94 Phase 3 r1/.test(_read(f))) found++;
  }
  assert.ok(found >= 2,
    `at least 2 of the touched files must carry a "fr-94 Phase 3 r1" marker comment so a future restyle understands the required-field gate — found in ${found}.`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
