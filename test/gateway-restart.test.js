// fr:model-gateway — a `/model gw:<name>` switch must take effect on the
// NEXT reply, not silently never apply.
//
// Root cause: the Agent SDK's streaming-input `query()` lives for the whole
// session (multiple user turns share one iteration), and base_url / auth_token
// are baked into sdkOpts at iteration START. A mid-iteration `/model gw:` only
// set this.activeGw; the live query kept hitting the OLD gateway — "切换模型
// 没有及时生效" (the agent still self-identifies as the old model, e.g. replied
// "I'm Claude" instead of the switched DS model).
//
// Fix (server agent-session.js): record _activeGwAtIteration at iteration
// start; in .write(), if the gateway changed since then, cold-start a fresh
// query (resume=sdkSessionId) instead of hot-pushing into the live old-gateway
// query. The drain→idle hook re-invokes _ensureIteration with the new gwEnv.
// Plus a display fix (slashcmds gateway-changed broadcast + client cache) so
// the "▶ session" card no longer shows the stale model/base.
//
// Static-grep guards (browser + core-loop behaviour, not unit-runnable here).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const SESSION = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
const SLASH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr:model-gateway — switch applies on the next reply ──');

t('agent-session: _activeGwAtIteration recorded at iteration start (gw snapshot)', () => {
  // Must capture which gateway the current iteration was built with so the
  // .write() path can detect a mid-iteration switch.
  const ctorAt = SESSION.indexOf('this._activeGwAtIteration = this.activeGw;');
  assert.ok(ctorAt > -1, 'constructor must init _activeGwAtIteration');
  const iterAt = SESSION.indexOf('// Record which gateway this iteration was built with');
  assert.ok(iterAt > -1, 'iteration start must record _activeGwAtIteration');
});

t('agent-session: .write() hot path cold-starts on a gateway change (not just push)', () => {
  const idx = SESSION.search(/write\(text\)\s*\{/);
  assert.ok(idx > -1, '.write() must exist');
  const win = sliceFn(SESSION, idx);
  assert.ok(/this\.activeGw\s*!==\s*this\._activeGwAtIteration/.test(win),
    '.write() must compare activeGw against _activeGwAtIteration');
  assert.ok(/this\._pendingGwRestart\s*=\s*true/.test(win),
    '.write() must flag _pendingGwRestart so the drain→idle hook cold-starts');
  assert.ok(/this\._abortController\.abort\(\)/.test(win) && /this\._msgQueue\.close\(\)/.test(win),
    '.write() must tear down the old old-gateway iteration (abort + close)');
  // The unconditional hot push must still exist for the no-change case.
  assert.ok(/this\._msgQueue\.push\(envelope\)/.test(win),
    'unchanged-gateway hot path must still push into the live queue');
});

t('agent-session: idle hook cold-starts a fresh iteration when _pendingGwRestart', () => {
  const idx = SESSION.indexOf('fr:model-gateway — deferred gateway-switch restart');
  assert.ok(idx > -1, 'idle-hook gateway-restart comment must exist');
  const win = SESSION.slice(idx, idx + 900);
  assert.ok(/_pendingGwRestart\s*=\s*false/.test(win),
    'idle hook must clear _pendingGwRestart');
  assert.ok(/this\._ensureIteration\(\)/.test(win),
    'idle hook must re-invoke _ensureIteration to cold-start with the new gwEnv');
  // Must NOT null sdkSessionId (unlike /clear new) — conversation resumes.
  assert.ok(!/this\.sdkSessionId\s*=\s*null/.test(win),
    'gateway restart must preserve sdkSessionId (conversation resumes on new gateway)');
});

t('slashcmds: handleModel gw: branches broadcast gateway-changed', () => {
  assert.ok(/function\s+_emitGatewayChanged\s*\(/.test(SLASH),
    '_emitGatewayChanged helper must be defined');
  assert.ok(/kind:\s*['"]gateway-changed['"]/.test(SLASH),
    '_emitGatewayChanged must emit state-update kind="gateway-changed"');
  // Both the default-reset and the named-profile branches must broadcast.
  const defIdx = SLASH.search(/Active gateway set to/);
  assert.ok(defIdx > -1, 'named-profile branch must exist');
  const defWin = SLASH.slice(defIdx - 400, defIdx);
  assert.ok(/_emitGatewayChanged\(ctx\.session,\s*rec\)/.test(defWin),
    'named-profile branch must call _emitGatewayChanged');
});

t('app.js: _applyStateUpdate refreshes the cached gateway model/base on gateway-changed', () => {
  const idx = APP.search(/msg\.kind === ['"]gateway-changed['"]/);
  assert.ok(idx > -1, '_applyStateUpdate must handle kind === "gateway-changed"');
  const win = APP.slice(idx, idx + 500);
  assert.ok(/_activeGatewayModel\s*=\s*msg\.model/.test(win),
    'must refresh _activeGatewayModel from msg.model');
  assert.ok(/_activeGatewayBase\s*=\s*msg\.baseUrl/.test(win),
    'must refresh _activeGatewayBase from msg.baseUrl');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
