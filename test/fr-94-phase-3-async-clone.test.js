// fr-94 Phase 3: async clone with progress streaming.
//
// Plan-item dispatch (closing the "deferred Phase 3 item" line from
// the Phase 2 run summary):
//   Problem:  Phase 1's spawnSync clone pinned the /sessions POST
//             for up to 2 min on large repos / flaky networks — the
//             user sat staring at a hung spawn modal. Phase 1 r1
//             added a timeout to bound the worst case but didn't
//             remove the block.
//   Expected: POST /sessions returns sessionId immediately. The
//             clone runs in the background, streams `git clone
//             --progress` lines into the chat pane, and posts a
//             final ✓/✗ verdict that mutates rec.cloneState.
//   Implementation:
//             · _kickoffGitCloneAsync(sessionId, absCwd, gitUrl)
//               pre-creates the empty project dir, returns the
//               inferred name, and kicks off a setImmediate-deferred
//               background clone.
//             · _runGitCloneInBackground uses child_process.spawn
//               (NOT spawnSync). stderr — where --progress writes —
//               is split by line, throttled to ~500ms, and piped
//               into appendChatMessage with meta.kind = 'fr-94/
//               clone-progress' so the chat pane renders it.
//             · _emitCloneMsg dual-pipes: appendChatMessage persists
//               to rec.chat (catches up users on a fresh attach) AND
//               attachMod.getSession(id).emit('chat', msg) reaches
//               live-attached WS clients.
//             · rec.cloneState ∈ {'pending', 'success', 'failed'},
//               rec.cloneUrl preserves the URL for diagnostics.
//             · CLAUDE.md inject is deferred until after clone
//               success — pre-clone the project dir must stay empty
//               or `git clone <url> <dir>` fails.
//             · A 10-min hard SIGTERM bounds runaway clones (same
//               intent as Phase 1 r1's timeout, just enforced via
//               process.kill since spawn() has no built-in).
//
// Test shape: static-grep on the locked surface.

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

console.log('── fr-94 Phase 3: async clone with progress streaming ──');

t('server/src/sessions.js: _kickoffGitCloneAsync defined and returns synchronously (no `await` in body)', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/function\s+_kickoffGitCloneAsync\s*\(/);
  assert.ok(at > -1, '_kickoffGitCloneAsync must be defined.');
  // Function body span — grab a generous window.
  const body = sliceFn(src, at);
  // The helper must NOT be async (it returns the projectName
  // immediately so spawnSession's caller doesn't await a clone).
  assert.ok(!/async\s+function\s+_kickoffGitCloneAsync/.test(src.slice(at - 20, at + 80)),
    '_kickoffGitCloneAsync must NOT be `async` — the whole point of Phase 3 is to return the project name immediately so the /sessions POST does not block on the clone.');
  // The clone work is deferred via setImmediate.
  assert.ok(/setImmediate\s*\(/.test(body),
    '_kickoffGitCloneAsync must defer the clone work via setImmediate so spawnSession can finish putSession + spawnAgent + _registerExternalSession before the first progress line tries to broadcast (Phase 3).');
});

t('server/src/sessions.js: _runGitCloneInBackground uses child_process.spawn (NOT spawnSync) for the actual clone', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/function\s+_runGitCloneInBackground\s*\(/);
  assert.ok(at > -1, '_runGitCloneInBackground must be defined (the background driver).');
  const body = sliceFn(src, at);
  assert.ok(/require\s*\(\s*['"]child_process['"]\s*\)/.test(body) && /\{\s*spawn\s*\}/.test(body),
    '_runGitCloneInBackground must destructure `spawn` from require("child_process") — Phase 3 replaces the blocking spawnSync with the async spawn.');
  assert.ok(/spawn\s*\(\s*['"]git['"]\s*,\s*\[[^\]]*['"]clone['"]/.test(body),
    '_runGitCloneInBackground must invoke `spawn("git", ["clone", ...], ...)` — git is the only supported clone backend.');
  assert.ok(/--progress/.test(body),
    "_runGitCloneInBackground must pass git's --progress flag so stderr yields one progress line per tick (Phase 3 — streamable to chat).");
  // Negative guard: no spawnSync anywhere in the background driver.
  assert.ok(!/spawnSync/.test(body),
    'spawnSync must not appear anywhere in _runGitCloneInBackground — Phase 3 is async-only.');
});

t('server/src/sessions.js: background driver streams stderr to appendChatMessage', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/function\s+_runGitCloneInBackground\s*\(/);
  const body = sliceFn(src, at);
  // The handler must consume the child's stderr stream and route the
  // lines through _emitCloneMsg (which in turn calls
  // appendChatMessage). The throttle + line-split machinery is the
  // diff from the pre-Phase-3 sync path.
  assert.ok(/child\.stderr\.on\s*\(\s*['"]data['"]/.test(body),
    "_runGitCloneInBackground must attach a 'data' handler on the child's stderr stream — that's where git's --progress writes (Phase 3).");
  assert.ok(/_emitCloneMsg\s*\(/.test(body),
    '_runGitCloneInBackground must route progress lines through _emitCloneMsg so each line is persisted + broadcast (Phase 3).');
});

t('server/src/sessions.js: _emitCloneMsg dual-pipes via appendChatMessage AND attach module getSession().emit("chat", msg)', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/function\s+_emitCloneMsg\s*\(/);
  assert.ok(at > -1, '_emitCloneMsg must be defined.');
  const body = sliceFn(src, at);
  assert.ok(/appendChatMessage\s*\(/.test(body),
    '_emitCloneMsg must call appendChatMessage so the row persists to rec.chat (chat-history catch-up on fresh attach — Phase 3).');
  assert.ok(/require\s*\(\s*['"]\.\/attach['"]\s*\)/.test(body),
    '_emitCloneMsg must lazy-require ./attach to look up the live AgentSession by id (Phase 3 — live broadcast).');
  assert.ok(/getSession\s*\(/.test(body) && /\.emit\s*\(\s*['"]chat['"]/.test(body),
    '_emitCloneMsg must call attachMod.getSession(sessionId).emit("chat", msg) so already-attached WS clients see the row without a reattach (Phase 3 — live broadcast).');
});

t('server/src/sessions.js: spawnSession sets rec.cloneState="pending" + rec.cloneUrl on the gitCloneUrl branch', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/async\s+function\s+spawnSession\s*\(/);
  assert.ok(at > -1, 'spawnSession must exist.');
  const body = sliceFn(src, at);
  assert.ok(/cloneState\s*=\s*['"]pending['"]/.test(body),
    "spawnSession must set cloneState='pending' for the gitCloneUrl branch — clients use this to render \"⏳ Cloning…\" until the background driver flips to 'success' / 'failed' (Phase 3).");
  assert.ok(/record\.cloneUrl\s*=/.test(body) || /cloneUrl\s*=\s*opts\.gitCloneUrl/.test(body),
    'spawnSession must persist rec.cloneUrl so diagnostics + a future "retry clone" UX can recover the URL after a restart (Phase 3).');
});

t('server/src/sessions.js: spawnSession skips pre-spawn CLAUDE.md inject when cloneState is pending (so the empty project dir can host git clone)', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/async\s+function\s+spawnSession\s*\(/);
  const body = sliceFn(src, at);
  // The inject call must be guarded by a cloneState check — without
  // it, git clone would fail on "destination not empty" because
  // CLAUDE.md would already be in the project dir.
  assert.ok(/cloneState\s*!==?\s*['"]pending['"][\s\S]{0,200}injectBestPracticesIntoClaudeMd/.test(body) ||
            /if\s*\([^)]*cloneState[^)]*\)\s*\{[\s\S]{0,300}injectBestPracticesIntoClaudeMd/.test(body),
    'spawnSession must guard injectBestPracticesIntoClaudeMd behind a cloneState check (skip when "pending") so the empty project dir survives until git clone fills it (Phase 3).');
  // And the success branch in _runGitCloneInBackground must re-call
  // the inject post-clone so the next iteration sees CLAUDE.md.
  const bgAt = src.search(/function\s+_runGitCloneInBackground\s*\(/);
  const bgBody = sliceFn(src, bgAt);
  assert.ok(/injectBestPracticesIntoClaudeMd\s*\(/.test(bgBody),
    '_runGitCloneInBackground must call injectBestPracticesIntoClaudeMd on the success branch so the post-clone iteration picks up the best-practices block (Phase 3 — the pre-spawn inject is skipped, so the post-clone inject is the only one that runs).');
});

t('a comment naming "fr-94 Phase 3" explains the async-clone plumbing in sessions.js', () => {
  const src = _read('server/src/sessions.js');
  assert.ok(/fr-94 Phase 3/.test(src),
    'a comment naming "fr-94 Phase 3" must appear in sessions.js so a future restyle understands why the clone helper looks so different from the other Phase 1 spawn helpers.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
