// fr-94 Phase 1: designate one main project per session workspace
// for _myco_/ storage.
//
// User-reported (verbatim, plan-item dispatch from @labxnow):
//   Problem:  Session workspaces support multiple projects but lack
//             a designated main project to anchor myco memory
//             storage.
//   Expected: Every session has exactly one main project (set during
//             session creation via clone or new local), and all myco
//             memory — including plan.json — is persisted under
//             main-project/_myco_/.
//   Actual:   No main project is assigned, so there is no canonical
//             location for _myco_ memory or plan.json.
//
// Phase 1 scope (confirmed via AskUserQuestion — Phase 1 plumbing +
// spawn-modal field; auto-detect migration deferred):
//   · rec.mainProject field on the session record. Stored relative
//     to rec.absCwd.
//   · resolveMycoDir(rec) in artifacts.js honors rec.mainProject when
//     set (the new explicit override); falls back to legacy auto-
//     detect (find first subdir with .git/) when unset.
//   · resolveMycoDir + findProjectRoot + MYCO_DIR promoted to public
//     exports so the three stragglers (agent-session.js, critique.js,
//     index.js diagrams) delegate to the helper instead of hand-
//     rolling `path.join(absCwd, '_myco_', ...)`.
//   · spawnSession accepts opts.gitCloneUrl OR opts.mainProjectName.
//     URL → clone into <absCwd>/<inferred-name>; plain text → mkdir
//     <absCwd>/<sanitized-name>. Either way, rec.mainProject is set
//     to the resulting dir name and spawnAgent's cwd is anchored at
//     that subdir (so process.cwd() for the agent matches the project
//     root, not the session-root wrapper).
//   · Spawn modal grows a single "Main project (optional — git URL
//     or new folder name)" field. app.js sniffs the value and
//     forwards as gitCloneUrl or mainProjectName.
//
// Test shape: static-grep guards across the layers.

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

console.log('── fr-94 Phase 1: mainProject + _myco_/ unification ──');

// ── artifacts.js: helper extended + promoted to public exports ──

t('server/src/artifacts.js: resolveMycoDir + findProjectRoot are public exports (not just __test:)', () => {
  const src = _read('server/src/artifacts.js');
  // Match top-level module.exports references. Anchor on the line
  // `module.exports = {` then verify the names appear OUTSIDE the
  // `__test: { … }` sub-namespace.
  const at = src.search(/module\.exports\s*=\s*\{/);
  assert.ok(at > -1, 'module.exports object must exist.');
  // Slice from module.exports through the start of `__test:` so we
  // only look at the top-level export block.
  const top = src.slice(at, src.indexOf('__test:', at));
  for (const sym of ['resolveMycoDir', 'findProjectRoot', 'MYCO_DIR']) {
    assert.ok(new RegExp(`\\b${sym}\\b`).test(top),
      `${sym} must appear in the TOP-LEVEL module.exports of artifacts.js (not just __test:) so other server modules can import it without poking into the test-only namespace (fr-94 Phase 1).`);
  }
});

t('server/src/artifacts.js: findProjectRoot honors rec.mainProject before falling back to auto-detect', () => {
  const src = _read('server/src/artifacts.js');
  // The function body must reference rec.mainProject. Anchor on the
  // findProjectRoot definition + look for the field name within ±800
  // chars (the function body).
  const at = src.search(/function\s+findProjectRoot\s*\(/);
  assert.ok(at > -1, 'findProjectRoot must still exist.');
  const body = sliceFn(src, at);
  assert.ok(/rec\.mainProject/.test(body),
    'findProjectRoot must read rec.mainProject and use it as the project root when set (fr-94 Phase 1 — explicit override beats auto-detect).');
});

// ── stragglers refactored to use the helper ──

t('server/src/critique.js: imports resolveMycoDir from artifacts (no hand-rolled _myco_ path.join)', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/require\s*\(\s*['"]\.\/artifacts['"]\s*\)/.test(src) ||
            /from\s+['"]\.\/artifacts['"]/.test(src),
    "critique.js must require('./artifacts') to import resolveMycoDir (fr-94 Phase 1 — single source of truth for _myco_/ path resolution).");
  assert.ok(/resolveMycoDir/.test(src),
    'critique.js must reference resolveMycoDir to resolve the critic.md path (fr-94 Phase 1).');
});

t('server/src/agent-session.js: imports resolveMycoDir from artifacts for events.jsonl path', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/require\s*\(\s*['"]\.\/artifacts['"]\s*\)/.test(src),
    "agent-session.js must require('./artifacts') to get resolveMycoDir (fr-94 Phase 1 — events.jsonl no longer hand-rolled at session-root).");
  assert.ok(/resolveMycoDir/.test(src),
    'agent-session.js must reference resolveMycoDir to resolve events.jsonl path (fr-94 Phase 1).');
});

t('server/src/index.js: diagrams routes use resolveMycoDir for the _myco_/diagrams path', () => {
  const src = _read('server/src/index.js');
  assert.ok(/_resolveMycoDir|resolveMycoDir/.test(src),
    'index.js must import resolveMycoDir for the diagrams routes (fr-94 Phase 1).');
});

// ── sessions.js: spawnSession accepts mainProject ──

t('server/src/sessions.js: spawnSession handles opts.gitCloneUrl + opts.mainProjectName', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/async\s+function\s+spawnSession\s*\(/);
  assert.ok(at > -1, 'spawnSession must exist.');
  const body = sliceFn(src, at);
  assert.ok(/opts\.gitCloneUrl/.test(body),
    'spawnSession body must read opts.gitCloneUrl (fr-94 Phase 1 — URL → git clone path).');
  assert.ok(/opts\.mainProjectName/.test(body),
    'spawnSession body must read opts.mainProjectName (fr-94 Phase 1 — plain text → mkdir path).');
  assert.ok(/mainProject/.test(body),
    'spawnSession body must compute + persist rec.mainProject (fr-94 Phase 1).');
});

t('server/src/sessions.js: helper functions _kickoffGitCloneAsync + _spawnViaNewDir defined', () => {
  const src = _read('server/src/sessions.js');
  // fr-94 Phase 3 renamed _spawnViaGitClone (blocking spawnSync) to
  // _kickoffGitCloneAsync (returns immediately + clone runs in the
  // background). The Phase 3 test file locks the async contract;
  // this case just confirms the helper still exists alongside the
  // still-sync _spawnViaNewDir (new-local-dir path is fast enough
  // not to need async).
  assert.ok(/function\s+_kickoffGitCloneAsync\s*\(/.test(src),
    '_kickoffGitCloneAsync helper must be defined (fr-94 Phase 3 — non-blocking git clone into the inferred project subdir).');
  assert.ok(/function\s+_spawnViaNewDir\s*\(/.test(src),
    '_spawnViaNewDir helper must be defined (fr-94 Phase 1 — mkdir for plain-name path).');
});

// ── server route forwards the spawn-modal fields ──

t('server/src/index.js: POST /sessions forwards gitCloneUrl + mainProjectName to spawnSession', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/app\.post\(\s*['"]\/sessions['"]/);
  assert.ok(at > -1, 'POST /sessions route must exist.');
  const body = src.slice(at, at + 1500);
  for (const field of ['gitCloneUrl', 'mainProjectName']) {
    assert.ok(new RegExp(`req\\.body\\.${field}`).test(body),
      `POST /sessions must read req.body.${field} from the spawn modal payload and pass it to spawnSession (fr-94 Phase 1).`);
  }
});

// ── spawn modal HTML + JS ──

t('web/public/index.html: spawn modal has a "Main project" input field', () => {
  const html = _read('web/public/index.html');
  // The field id is spawn-main-project. Locate the <input> tag.
  assert.ok(/id\s*=\s*['"]spawn-main-project['"]/.test(html),
    'spawn modal must declare <input id="spawn-main-project"> for the main-project field (fr-94 Phase 1).');
});

t('web/public/app.js: doSpawn reads the main-project field and sniffs URL vs name', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/async\s+function\s+doSpawn\s*\(/);
  assert.ok(at > -1, 'doSpawn() must exist.');
  const body = sliceFn(app, at);
  assert.ok(/spawn-main-project/.test(body),
    'doSpawn() must read the #spawn-main-project field value (fr-94 Phase 1).');
  assert.ok(/gitCloneUrl/.test(body) && /mainProjectName/.test(body),
    'doSpawn() must forward both gitCloneUrl AND mainProjectName in the POST body (fr-94 Phase 1 — server picks based on which is set).');
});

// ── r1 critique response: safety guards ──

t('artifacts.js r1: findProjectRoot returns null + logs warning when rec.mainProject exists but the directory does not', () => {
  // Critique flagged: pre-r1 a stale rec.mainProject (e.g. user
  // renamed the dir or hand-edited sessions.json incorrectly) silently
  // fell through to auto-detect, which on a multi-repo workspace
  // could land plan.json/critic.md/events.jsonl in a completely
  // different project than the user designated. r1 short-circuits:
  // returns null + warns instead of guessing.
  const src = _read('server/src/artifacts.js');
  const at = src.search(/function\s+findProjectRoot\s*\(/);
  assert.ok(at > -1, 'findProjectRoot must exist.');
  const body = sliceFn(src, at);
  // The body must have a `return null;` immediately after a console.warn
  // referencing rec.mainProject (the missing-dir branch).
  assert.ok(/console\.warn\([^)]*mainProject/i.test(body),
    'findProjectRoot must console.warn when rec.mainProject is set but the dir is missing (r1 critique response — silent fall-through was unsafe).');
  // And the `return null` must follow the warn in the same function
  // (the missing-dir branch should NOT fall through to auto-detect).
  const warnAt = body.search(/console\.warn\([^)]*mainProject/i);
  const afterWarn = body.slice(warnAt, warnAt + 500);
  assert.ok(/return\s+null\s*;/.test(afterWarn),
    'findProjectRoot must `return null` after the mainProject-missing console.warn (r1 — block silent fall-through to auto-detect).');
});

t('sessions.js r1 → Phase 3 supersession: gitCloneUrl branch no longer pins the /sessions POST (Phase 3 made the clone async, so the spawnSync timeout guard is moot)', () => {
  // Phase 1 r1 guarded against a hung sync clone via a spawnSync
  // timeout. Phase 3 removed sync clone entirely — the gitCloneUrl
  // branch in spawnSession calls _kickoffGitCloneAsync which returns
  // immediately and runs the clone in the background. The Phase 3
  // contract is locked in test/fr-94-phase-3-async-clone.test.js;
  // this case just verifies spawnSession's gitCloneUrl branch
  // doesn't ever block on a sync clone again.
  const src = _read('server/src/sessions.js');
  const at = src.search(/async\s+function\s+spawnSession\s*\(/);
  assert.ok(at > -1, 'spawnSession must exist.');
  const body = sliceFn(src, at);
  // The branch dispatching on opts.gitCloneUrl must NOT call any
  // spawnSync-shaped helper. The async helper is the only allowed
  // dispatcher.
  assert.ok(!/spawnSync/.test(body),
    'spawnSession must not call spawnSync anywhere in its body (fr-94 Phase 3 — async clone replaces the sync path that the r1 timeout was guarding).');
  assert.ok(/_kickoffGitCloneAsync\s*\(/.test(body),
    'spawnSession must dispatch the gitCloneUrl branch through _kickoffGitCloneAsync (fr-94 Phase 3 — non-blocking).');
});

// ── marker comment ──

t('a comment naming fr-94 explains the mainProject plumbing in at least one file', () => {
  const files = [
    'server/src/artifacts.js',
    'server/src/sessions.js',
    'server/src/critique.js',
    'server/src/agent-session.js',
    'server/src/index.js',
    'web/public/index.html',
    'web/public/app.js',
  ];
  let found = 0;
  for (const f of files) {
    if (/fr-94/.test(_read(f))) found++;
  }
  assert.ok(found >= 3,
    `at least 3 of the touched files must carry a fr-94 marker comment so a future restyle understands the mainProject plumbing — found in ${found}.`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
