// ryan-blues bug regression: creating a new session must not leave the
// plan view showing stale data from the previously selected session.
//
// Root cause (pre-fix): state.artifacts was a flat map keyed only by
// artifact type ({ plan, test, arch }). When the user switched
// sessions, the cache wasn't cleared — loadArtifact('plan') for the
// new session would short-circuit on the cached plan from the prior
// session and render its items.
//
// Fix shape: state.artifacts becomes { sessionId, byType: {...} }.
// loadArtifact's cache lookup compares state.artifacts.sessionId
// against state.activeId; mismatch → cache miss → falls through to
// the HTTP GET against the correct session.
//
// This test inlines minimal versions of the fixed cache helpers and
// static-grep-guards the prod implementation in app.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED helpers — the contract this test locks in.

function makeState() {
  return {
    activeId: null,
    artifacts: { sessionId: null, byType: {} },
  };
}

// _getCachedArtifact(state, type) — returns the cached artifact only
// when the cache's sessionId matches state.activeId. Otherwise null.
function _getCachedArtifact(state, type) {
  if (!state || !state.artifacts) return null;
  if (state.artifacts.sessionId !== state.activeId) return null;
  if (!state.artifacts.byType) return null;
  return state.artifacts.byType[type] || null;
}

function _setCachedArtifact(state, type, artifact) {
  if (state.artifacts.sessionId !== state.activeId) {
    state.artifacts = { sessionId: state.activeId, byType: {} };
  }
  state.artifacts.byType[type] = artifact;
}

// Simulates the artifacts-init WS frame — replaces the cache wholesale
// + binds it to the current state.activeId.
function _applyArtifactsInit(state, artifacts) {
  state.artifacts = { sessionId: state.activeId, byType: artifacts || {} };
}

// Simulates _resetUiForNewSession's relevant slice — sets activeId AND
// resets the cache so a stale prior-session entry can never be served.
function _switchSession(state, newId) {
  state.activeId = newId;
  state.artifacts = { sessionId: newId, byType: {} };
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── ryan-blues bug: plan view stale across session switch ──');

t('repro: lookup after session switch must NOT return prior session\'s plan', () => {
  const state = makeState();
  // 1. User on session A, A's plan cached.
  state.activeId = 'sid-A';
  _applyArtifactsInit(state, {
    plan: { items: [{ id: 'td-A1', text: 'A todo' }] },
  });
  assert.deepStrictEqual(
    _getCachedArtifact(state, 'plan').items.map(x => x.id),
    ['td-A1'],
    'sanity: A\'s plan is cached and visible when activeId=A',
  );
  // 2. User spawns session B. activeId switches BEFORE the new
  //    artifacts-init arrives. The bug fired here: stale A-cache served.
  state.activeId = 'sid-B';
  // 3. Plan tab click → loadArtifact('plan') → cache lookup
  const stale = _getCachedArtifact(state, 'plan');
  assert.strictEqual(stale, null,
    'session-switch made the prior session\'s cache invalid — lookup MUST return null so the loader falls through to HTTP/WS for the new session');
});

t('artifacts-init for new session replaces the cache (no cross-session leak)', () => {
  const state = makeState();
  state.activeId = 'sid-A';
  _applyArtifactsInit(state, {
    plan: { items: [{ id: 'td-A1' }] },
    arch: { markdown: '# Session A arch' },
  });
  // Switch to B, receive its artifacts-init (with an empty plan).
  state.activeId = 'sid-B';
  _applyArtifactsInit(state, { plan: { items: [] } });
  assert.strictEqual(_getCachedArtifact(state, 'plan').items.length, 0,
    'B\'s empty plan is now what the cache returns');
  // The cache no longer holds A's arch — it was replaced wholesale.
  assert.strictEqual(_getCachedArtifact(state, 'arch'), null,
    'A\'s arch must not survive into B\'s cache');
});

t('_switchSession resets the cache (belt-and-suspenders for lookup guard)', () => {
  const state = makeState();
  state.activeId = 'sid-A';
  _applyArtifactsInit(state, { plan: { items: [{ id: 'td-A1' }] } });
  // simulate _resetUiForNewSession switching to B
  _switchSession(state, 'sid-B');
  // The cache should be empty for B; lookup returns null regardless
  // of which type is requested.
  assert.strictEqual(_getCachedArtifact(state, 'plan'), null);
  assert.strictEqual(_getCachedArtifact(state, 'arch'), null);
  assert.strictEqual(_getCachedArtifact(state, 'test'), null);
});

t('lookup with matching sessionId still works (no regression on the happy path)', () => {
  const state = makeState();
  state.activeId = 'sid-A';
  _applyArtifactsInit(state, { plan: { items: [{ id: 'td-A1' }, { id: 'td-A2' }] } });
  const cached = _getCachedArtifact(state, 'plan');
  assert.ok(cached, 'happy-path cache lookup returns the artifact');
  assert.strictEqual(cached.items.length, 2);
});

t('_setCachedArtifact rebinds the cache when sessionId drifted', () => {
  const state = makeState();
  // Initial state: cache says A, activeId says B. _setCachedArtifact
  // must drop the stale A-tagged cache and start a fresh B cache.
  state.activeId = 'sid-B';
  state.artifacts = { sessionId: 'sid-A', byType: { plan: { items: [{ id: 'td-A1' }] } } };
  _setCachedArtifact(state, 'plan', { items: [{ id: 'td-B1' }] });
  assert.strictEqual(state.artifacts.sessionId, 'sid-B', 'cache rebound to current activeId');
  assert.strictEqual(state.artifacts.byType.plan.items[0].id, 'td-B1', 'B\'s data overwrote A\'s');
  assert.ok(!state.artifacts.byType.plan.items.some(x => x.id === 'td-A1'),
    'A\'s entries did not survive into B\'s cache');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards: pin the prod implementation to the contract.

t('static guard: app.js state.artifacts has the { sessionId, byType } shape', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // Init line: `artifacts: { sessionId: null, byType: {} },` or close variant.
  assert.ok(/artifacts:\s*\{[\s\S]{0,80}sessionId[\s\S]{0,80}byType/.test(src),
    'state init must declare artifacts as { sessionId, byType }');
});

t('static guard: artifacts-init WS handler tags the cache with activeId', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  // The handler block around `t === 'artifacts-init'` must assign a
  // structure that includes sessionId tied to state.activeId.
  const initStart = src.indexOf("'artifacts-init'");
  assert.ok(initStart > 0, "artifacts-init handler must exist");
  // Look in the ~400 chars following the handler discriminator.
  const window = src.slice(initStart, initStart + 600);
  assert.ok(/sessionId\s*:\s*state\.activeId/.test(window),
    'artifacts-init handler must bind cache.sessionId to state.activeId so a later session-switch invalidates it');
});

t('static guard: loadArtifact cache lookup includes a session-id check', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const loadStart = src.indexOf('async function loadArtifact');
  assert.ok(loadStart > 0, 'loadArtifact must exist');
  const loadEnd = src.indexOf('\nasync function ', loadStart + 1);
  const body = src.slice(loadStart, loadEnd > 0 ? loadEnd : loadStart + 2000);
  // The fixed code compares state.artifacts.sessionId against the
  // active session id (`sid` is the local name used in this function).
  assert.ok(/state\.artifacts\.sessionId\s*===\s*sid/.test(body) ||
            /sid\s*===\s*state\.artifacts\.sessionId/.test(body),
    'loadArtifact must compare state.artifacts.sessionId === sid before serving the cache');
});

t('static guard: session-switch path resets the artifact cache', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const resetStart = src.indexOf('function _resetUiForNewSession');
  assert.ok(resetStart > 0, '_resetUiForNewSession must exist');
  const resetEnd = src.indexOf('\nfunction ', resetStart + 1);
  const body = src.slice(resetStart, resetEnd > 0 ? resetEnd : resetStart + 2000);
  // The fix re-initializes state.artifacts (so a stale cache from the
  // previous session never serves the new one even if the lookup guard
  // is bypassed for any reason).
  assert.ok(/state\.artifacts\s*=\s*\{[\s\S]{0,80}sessionId/.test(body),
    '_resetUiForNewSession must reset state.artifacts with the new sessionId');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
