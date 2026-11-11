// /model — now a POPUP-ONLY model-gateway switch command (fr:model-gateway
// supersedes fr-102's per-session `/model <id>` override, which is RETIRED).
//
// Contract:
//   - /model is the command that opens the gateway/model picker popover.
//       * bare /model (or ANY stray typed suffix, ignored) → reply naming
//         the ACTIVE gateway + its configured model, and emit
//         state-update kind:'model-picker' with the user's gateway list.
//         NOT gated. No modelOverride mutation, no 400 on a bad suffix.
//       * /model gw:default → gateways.deactivate (reset to system default)
//       * /model gw:<name>   → gateways.setActive (activate a saved profile)
//   - The per-session override (`rec.modelOverride` / `session.setModel`)
//     path is REMOVED. The effective model is governed by the ACTIVE gateway
//     profile's `model` (or the system .env default).
//   - SUPPORTED_MODELS exported, contains the three family aliases.
//   - Client surface (app.js): handler for state-update kind:'model-picker'
//     calls _openModelPicker, which renders gateway rows that dispatch
//     /model gw:<name> via sendChatMessage.
//   - Styles: .model-picker-backdrop / .model-picker-row exist in styles.css.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
// CLAUDE.md §10b — size function-body windows by the function's actual
// end, not a hand-picked N (the hand-picked one ages into a silent
// false-negative as soon as the function grows).
const { sliceFn, fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      // Async test — keep it sync-only here; tests below stay sync.
      throw new Error('async tests not supported in this runner');
    }
    console.log('  ✓ ' + name); passed++;
  } catch (err) {
    console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err));
    failed++;
  }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-102: /model session-model switch ──');

// ──────────────────────────────────────────────────────────────────────
// Group A: handleModel behavior (require slashcmds with sessionsMod stubbed).
//
// We swap require.cache for './sessions' BEFORE requiring slashcmds so
// the lazy lookups inside handleModel see the stub. We DO NOT touch the
// real sessions.js store — the stub is in-memory only.

const stub = {
  _rec: null,
  _saved: 0,
  _owners: new Set(),
  getSessionRecord(_id) { return this._rec; },
  isOwnerOrAdmin(_id, user) { return this._owners.has(user); },
  saveStore() { this._saved++; },
  setSessionStrict() { return false },         // unused, present for shape
  isSessionStrict() { return false },
};
require.cache[require.resolve('../server/src/sessions')] = {
  exports: stub,
  id: require.resolve('../server/src/sessions'),
  filename: require.resolve('../server/src/sessions'),
  loaded: true,
};

// Also stub the modules slashcmds.js touches at require-time so we don't
// drag the whole server runtime in. permissions / git-hosts have no
// references inside handleModel — empty-objects suffice.
require.cache[require.resolve('../server/src/permissions')] = {
  exports: { matchesPattern() { return false; } },
  id: require.resolve('../server/src/permissions'),
  filename: require.resolve('../server/src/permissions'),
  loaded: true,
};

// Stub ./gateways too — handleModel reads/writes the ACTIVE profile, and we
// don't want it touching a real $STATE_DIR gateways.json from this test.
const gwStub = {
  _active: null,
  _profiles: [],
  listProfiles(user) { return { active: this._active, profiles: this._profiles }; },
  getActive(user) { return this._active ? { name: this._active } : null; },
  // Per-session resolution path: /model validates the persisted profile by
  // name via getProfile (independent of the legacy global `active`).
  getProfile(user, name) { return this._profiles.find((p) => p.name === name) || null; },
  deactivate(user) { this._active = null; this._deactivated = (this._deactivated || 0) + 1; return true; },
  setActive(user, name) { this._active = name; (this._activated = this._activated || {})[name] = 1; return name; },
};
require.cache[require.resolve('../server/src/gateways')] = {
  exports: gwStub,
  id: require.resolve('../server/src/gateways'),
  filename: require.resolve('../server/src/gateways'),
  loaded: true,
};

const slashcmds = require('../server/src/slashcmds');

function makeCtx(overrides) {
  const replies = [];
  const events = [];
  const ctx = {
    sessionId: 'fr-102-test-sid',
    user: 'alice',
    args: '',
    reply(msg) { replies.push(String(msg)); },
    session: {
      emit(kind, payload) { events.push({ kind, payload }); },
      setModel(id) { ctx.session._setModelCalls.push(id); return Promise.resolve(); },
      _setModelCalls: [],
    },
    ...(overrides || {}),
  };
  ctx._replies = replies;
  ctx._events = events;
  return ctx;
}

t('SUPPORTED_MODELS is exported and contains sonnet/opus/haiku aliases', () => {
  const list = slashcmds.SUPPORTED_MODELS;
  assert.ok(Array.isArray(list), 'SUPPORTED_MODELS must be exported as an array');
  const ids = list.map((m) => m && m.id);
  for (const required of ['sonnet', 'opus', 'haiku']) {
    assert.ok(ids.includes(required),
      `SUPPORTED_MODELS must include the "${required}" alias (got: ${ids.join(', ')})`);
  }
  // Each row must have an id, a label, and a desc (for the picker UI).
  for (const row of list) {
    assert.ok(row && typeof row.id === 'string' && row.id, 'row.id required');
    assert.ok(typeof row.desc === 'string' && row.desc, `row "${row.id}" must have a desc`);
  }
});

t('/model is registered in COMMANDS + listed in /commands', () => {
  const cmds = slashcmds.listCommands();
  const m = cmds.find((c) => c.name === 'model');
  assert.ok(m, '/model must appear in listCommands');
  assert.ok(m.usage && m.usage.includes('/model'), 'usage string must include /model');
  assert.ok(m.summary && m.summary.toLowerCase().includes('model'),
    'summary must mention "model"');
});

function resetGw() { gwStub._active = null; gwStub._profiles = []; gwStub._deactivated = 0; gwStub._activated = {}; }

t('bare /model: names the SESSION active gateway + emits model-picker (NOT gated)', () => {
  stub._rec = { user: 'alice', modelOverride: null, activeGw: 'lab' };
  resetGw();
  gwStub._profiles = [{ name: 'lab', baseUrl: 'http://x', model: 'DS-V4-0731', tokenSet: true }];
  const ctx = makeCtx({ user: 'bob', args: '' });   // bare → anyone attached can open
  slashcmds.handleModel(ctx);
  assert.strictEqual(ctx._replies.length, 1, 'must emit one reply');
  assert.ok(/active gateway/i.test(ctx._replies[0]), 'reply must name the active gateway');
  assert.ok(/DS-V4-0731/.test(ctx._replies[0]), 'reply must show the configured model ("按设置显示")');
  const evt = ctx._events.find((e) => e.kind === 'state-update' &&
    e.payload && e.payload.kind === 'model-picker');
  assert.ok(evt, 'must emit state-update kind:model-picker');
  assert.strictEqual(evt.payload.current, null, 'current is always null (override retired)');
  assert.ok(Array.isArray(evt.payload.supported) && evt.payload.supported.length > 0,
    'supported list must be forwarded');
  assert.ok(Array.isArray(evt.payload.gateway.profiles) && evt.payload.gateway.profiles.length === 1,
    'picker payload must carry the user gateway profiles');
  // The picker's ✓ must reflect the SESSION's choice (rec.activeGw), not the
  // legacy per-user global `active` — new sessions default to `default`.
  assert.strictEqual(evt.payload.gateway.active, 'lab',
    'picker active must come from rec.activeGw (per-session), so a new session shows `default`');
});

t('bare /model on a NEW session (no activeGw) shows `default` + system model', () => {
  // User bug: "每个新开的 session 都用系统默认" — a brand-new session must
  // report `default` even if the user has saved profiles, until they switch.
  stub._rec = { user: 'alice', modelOverride: null, activeGw: null };
  resetGw();
  gwStub._profiles = [{ name: 'lab', baseUrl: 'http://x', model: 'DS-V4-0731', tokenSet: true }];
  const ctx = makeCtx({ user: 'alice', args: '' });
  slashcmds.handleModel(ctx);
  assert.ok(/`default`/.test(ctx._replies[0]),
    'a new session with no activeGw must report `default` (system), not a saved profile');
  const evt = ctx._events.find((e) => e.kind === 'state-update' &&
    e.payload && e.payload.kind === 'model-picker');
  assert.strictEqual(evt.payload.gateway.active, null,
    'a new session picker must mark `default` as active (activeGw null)');
});

t('/model <stray suffix> is IGNORED (no modelOverride, no 400, still opens picker)', () => {
  // The user typed `/model 用法和介绍要改一下` — it must NOT be treated as a
  // model name or error; the picker just opens.
  stub._rec = { user: 'alice', modelOverride: null };
  stub._saved = 0;
  resetGw();
  const ctx = makeCtx({ user: 'alice', args: '用法和介绍要改一下' });
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.modelOverride, null, 'modelOverride must NOT be set from a suffix');
  assert.strictEqual(stub._saved, 0, 'saveStore must NOT be called');
  assert.deepStrictEqual(ctx.session._setModelCalls, [],
    'session.setModel must NOT be called for a non-gw suffix');
  assert.strictEqual(gwStub._deactivated, 0, 'no gateway switch on a non-gw suffix');
  const evt = ctx._events.find((e) => e.kind === 'state-update' &&
    e.payload && e.payload.kind === 'model-picker');
  assert.ok(evt, 'a stray suffix must still open the picker (popup-only)');
});

t('/model purges BOTH rec.modelOverride AND the live instance copy', () => {
  // User bug: "sdk=a383c5cb · model=ds 半天没反应" — a stale modelOverride
  // from the retired per-session /model feature was stuck on the running
  // AgentSession and forced model "ds" on every query, overriding both the
  // gateway profile model and the system default → wrong model + slow/
  // erroring replies. handleModel must clear the live instance's copy too,
  // not just rec.modelOverride (rec sits in sessions; the instance snapshot
  // lives separately and survives a rec purge until respawn).
  stub._rec = { user: 'alice', modelOverride: 'ds' };
  stub._saved = 0;
  resetGw();
  const ctx = makeCtx({ user: 'alice', args: '' });
  ctx.session.modelOverride = 'ds';   // simulate the live instance snapshot
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.modelOverride, null, 'rec.modelOverride must be cleared');
  assert.strictEqual(ctx.session.modelOverride, null,
    'the live AgentSession instance copy must ALSO be cleared (rec purge alone is not enough)');
  assert.strictEqual(stub._saved, 1, 'a dirty rec must trigger saveStore once');
});

t('/model gw:default resets THIS SESSION to the system default (rec.activeGw + live instance)', () => {
  stub._rec = { user: 'alice', modelOverride: null, activeGw: 'lab' };
  stub._saved = 0;
  resetGw();
  const ctx = makeCtx({ user: 'alice', args: 'gw:default' });
  ctx.session.activeGw = 'lab';            // simulate the live AgentSession mirror
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.activeGw, null, 'rec.activeGw must clear → system default');
  assert.strictEqual(ctx.session.activeGw, null,
    'the live AgentSession instance must mirror the reset (else next query keeps the old profile)');
  assert.strictEqual(stub._saved, 1, 'a per-session reset must persist via saveStore');
  assert.ok(ctx._replies.some((r) => /reset to system default/i.test(r)),
    'reply must confirm the reset');
});

t('/model gw:<name> opts THIS SESSION into a saved profile (rec.activeGw + live instance)', () => {
  stub._rec = { user: 'alice', modelOverride: null, activeGw: null };
  stub._saved = 0;
  resetGw();
  gwStub._profiles = [{ name: 'lab', baseUrl: 'http://x', model: 'DS-V4-0731', tokenSet: true }];
  const ctx = makeCtx({ user: 'alice', args: 'gw:lab' });
  ctx.session.activeGw = null;
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.activeGw, 'lab', 'rec.activeGw must be set to the chosen profile');
  assert.strictEqual(ctx.session.activeGw, 'lab',
    'the live AgentSession instance must mirror the switch (next query uses the profile)');
  assert.strictEqual(stub._saved, 1, 'the per-session choice must persist via saveStore');
  assert.ok(ctx._replies.some((r) => /set to `lab`/i.test(r) || /set to .lab./i.test(r)),
    'reply must confirm the activation');
});

t('/model gw:<name> does NOT re-open the picker (selection stays closed)', () => {
  // User bug: "Enter 确定后弹窗没有完全关闭" — a `gw:` selection sent the
  // switch command AND the server re-emitted a model-picker update, which
  // popped the just-closed picker straight back open. A selection is a
  // CHOICE: it must not re-open the popup (only the bare /model command
  // opens it, so the client's close on click/Enter holds).
  stub._rec = { user: 'alice', modelOverride: null };
  resetGw();
  gwStub._profiles = [{ name: 'lab', baseUrl: 'http://x', model: 'DS-V4-0731', tokenSet: true }];
  const ctx = makeCtx({ user: 'alice', args: 'gw:lab' });
  slashcmds.handleModel(ctx);
  const pickerEvts = ctx._events.filter((e) => e.kind === 'state-update' &&
    e.payload && e.payload.kind === 'model-picker');
  assert.strictEqual(pickerEvts.length, 0,
    'a gw:<name> selection must NOT emit a model-picker update (would re-open the popup)');
  assert.ok(ctx._replies.some((r) => /set to `lab`/i.test(r) || /set to .lab./i.test(r)),
    'the selection reply must still confirm the activation');
});

t('/model gw:<missing> replies "no such profile" (no throw)', () => {
  stub._rec = { user: 'alice', modelOverride: null, activeGw: null };
  resetGw();   // no profiles → getProfile('alice','nope') returns null
  const ctx = makeCtx({ user: 'alice', args: 'gw:nope' });
  slashcmds.handleModel(ctx);
  assert.ok(ctx._replies.some((r) => /no such saved gateway profile/i.test(r)),
    'reply must explain the missing profile');
  assert.strictEqual(stub._rec.activeGw, null, 'a failed switch must NOT set activeGw');
});

// ──────────────────────────────────────────────────────────────────────
// Group B: static guards on the prod source.

t('static guard: agent-session.js model resolution = gateway then system .env default', () => {
  // The retired per-session /model override is NO LONGER in the sdkOpts
  // resolution (a stale value was the "model=ds" pollution bug). The model
  // must come from the active gateway profile, else the system default
  // ANTHROPIC_MODEL from state/.env — so `default` uses the configured glm
  // model, not the SDK's hardcoded default. ModelOverride must NOT gate it.
  const src = _read('server/src/agent-session.js');
  assert.ok(!/if\s*\(\s*this\.modelOverride\s*\)\s*sdkOpts\.model/.test(src),
    'sdkOpts.model must NOT be gated on this.modelOverride (retired feature)');
  assert.ok(/if\s*\(\s*gw\s*&&\s*gw\.model\s*\)\s*sdkOpts\.model\s*=\s*gw\.model\s*;\s*else\s+if\s*\(\s*process\.env\.ANTHROPIC_MODEL\s*\)\s*sdkOpts\.model\s*=\s*process\.env\.ANTHROPIC_MODEL/.test(src),
    'model resolution must be: gateway profile model, else system .env ANTHROPIC_MODEL');
});

t('static guard: agent-session.js captures _currentQuery and clears on iteration end', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/this\._currentQuery\s*=\s*stream/.test(src),
    'must capture the Query handle after query(...) returns');
  // The clear must appear in the iteration-end block. Loose check —
  // body of _ensureIteration sets _currentQuery back to null after
  // _iterating=false.
  assert.ok(/this\._currentQuery\s*=\s*null/.test(src),
    'must clear _currentQuery to null after the iteration ends');
});

t('static guard: agent-session.js exposes setModel as a public method', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/async\s+setModel\s*\(/.test(src),
    'AgentSession.prototype.setModel must be an async method');
  // Slice the actual setModel body via the standard helper — robust
  // against the function growing.
  const body = fnBody(src, /async\s+setModel\s*\(/);
  assert.ok(body, 'setModel body must be locatable');
  assert.ok(/this\.modelOverride\s*=/.test(body),
    'setModel must mutate this.modelOverride for the next iteration');
  assert.ok(/this\._currentQuery\s*\.\s*setModel/.test(body)
    || /this\._currentQuery\.setModel/.test(body),
    'setModel must call Query.setModel on the live stream when available');
});

t('static guard: sessions.js forwards modelOverride at spawn AND respawn', () => {
  const src = _read('server/src/sessions.js');
  // Both spawnSession (fresh spawn) and ensureLiveSession (respawn
  // after container restart / reaper) must propagate rec.modelOverride
  // through to AgentSession. Use the §10b helper so the body window
  // grows with the function.
  const spawnBody = fnBody(src, /async\s+function\s+spawnSession\s*\(/);
  assert.ok(spawnBody, 'spawnSession body must be locatable');
  assert.ok(/modelOverride:\s*record\.modelOverride/.test(spawnBody),
    'spawnSession must forward record.modelOverride into spawnAgent opts');
  assert.ok(/activeGw:\s*record\.activeGw/.test(spawnBody),
    'spawnSession must forward record.activeGw (per-session gateway) or null → system default');
  const respawnBody = fnBody(src, /async\s+function\s+ensureLiveSession\s*\(/);
  assert.ok(respawnBody, 'ensureLiveSession body must be locatable');
  assert.ok(/modelOverride:\s*rec\.modelOverride/.test(respawnBody),
    'ensureLiveSession must forward rec.modelOverride on respawn');
  assert.ok(/activeGw:\s*rec\.activeGw/.test(respawnBody),
    'ensureLiveSession must forward rec.activeGw on respawn so the per-session choice survives restarts');
});

t('static guard: app.js handles state-update kind:"model-picker"', () => {
  const src = _read('web/public/app.js');
  assert.ok(/msg\.kind\s*===\s*['"]model-picker['"]/.test(src),
    'app.js must branch _applyStateUpdate on kind:"model-picker"');
  assert.ok(/function\s+_openModelPicker\s*\(/.test(src),
    'app.js must define _openModelPicker(currentId, supported)');
  // The picker must dispatch /model <id> via sendChatMessage on row click.
  // Slice via the §10b helper so the body window grows with the function.
  const body = fnBody(src, /function\s+_openModelPicker\s*\(/);
  assert.ok(body, '_openModelPicker body must be locatable');
  assert.ok(/sendChatMessage\s*\(\s*[`'"]\/model/.test(body)
    || /sendChatMessage\s*\(\s*id\s*\?/.test(body),
    'row click handler must call sendChatMessage with a /model <id> command');
});

t('static guard: styles.css ships .model-picker-backdrop + .model-picker-row', () => {
  const src = _read('web/public/styles.css');
  assert.ok(/\.model-picker-backdrop\b/.test(src),
    '.model-picker-backdrop class must be styled');
  assert.ok(/\.model-picker-row\b/.test(src),
    '.model-picker-row class must be styled');
  assert.ok(/\.model-picker-row\.active\b/.test(src),
    '.model-picker-row.active must be styled (the ✓-current state)');
});

t('static guard: sdk.d.ts compatibility — SDK accepts `model` as a string option', () => {
  // The session-model switch depends on the SDK accepting a `model`
  // string in query() options + exposing Query.setModel for live
  // switching. Sanity-check that the SDK we depend on still has those
  // surfaces — guards against an SDK minor-bump regressing the API.
  // (We don't pin a specific model alias here — the SDK is allowed to
  // shift its allowed alias set; we only require the option SHAPE.)
  let sdkPath = null;
  // Multiple possible install paths; pick the first one that resolves.
  for (const candidate of [
    '../server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts',
    '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts',
  ]) {
    try {
      const full = path.join(__dirname, candidate);
      if (fs.existsSync(full)) { sdkPath = full; break; }
    } catch {}
  }
  if (!sdkPath) {
    // SDK isn't installed in this checkout (CI without node_modules).
    // Skip rather than fail — fr-45 already enforces the option name.
    console.log('    (skipped — claude-agent-sdk not installed at known paths)');
    return;
  }
  const src = fs.readFileSync(sdkPath, 'utf8');
  assert.ok(/model\?:\s*string/.test(src),
    'sdk.d.ts must declare `model?: string` on the query options');
  assert.ok(/setModel\s*\(\s*model\??:\s*string/.test(src),
    'sdk.d.ts must expose Query.setModel(model?: string) for live switching');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
