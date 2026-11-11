// fr-102: per-session model switch via the /model slash command.
//
// Contract:
//   - rec.modelOverride: string | null  (persisted on the session record)
//   - sessions.spawnSession + ensureLiveSession forward modelOverride
//     to AgentSession via opts.modelOverride.
//   - AgentSession.setModel(id) mutates this.modelOverride AND calls
//     Query.setModel on the live stream if present (best-effort).
//   - sdkOpts.model is only set when this.modelOverride is truthy
//     (left unset → SDK default).
//   - /model slash command:
//       * bare /model → reply with current + supported, emit
//         state-update kind:'model-picker'. NOT gated.
//       * /model <id> → owner+admin only; persist rec.modelOverride,
//         call session.setModel, emit refreshed state-update.
//       * /model default | reset | clear | none → clear override.
//       * Idempotent: re-pick of current → "no change" reply.
//   - SUPPORTED_MODELS exported, contains the three family aliases.
//   - Client surface (app.js): handler for state-update kind:'model-picker'
//     calls _openModelPicker, which renders rows that dispatch /model <id>
//     via sendChatMessage.
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

t('bare /model: replies with current + supported, emits state-update model-picker', () => {
  stub._rec = { user: 'alice', modelOverride: null };
  stub._owners = new Set();   // bare /model is NOT gated — emptiness is fine
  const ctx = makeCtx({ user: 'bob', args: '' });
  slashcmds.handleModel(ctx);
  assert.strictEqual(ctx._replies.length, 1, 'must emit one reply');
  assert.ok(/current model/i.test(ctx._replies[0]), 'reply must mention current model');
  assert.ok(/sonnet/.test(ctx._replies[0]), 'reply must list sonnet');
  const evt = ctx._events.find((e) => e.kind === 'state-update' &&
    e.payload && e.payload.kind === 'model-picker');
  assert.ok(evt, 'must emit state-update kind:model-picker');
  assert.strictEqual(evt.payload.current, null, 'current must be null when no override set');
  assert.ok(Array.isArray(evt.payload.supported) && evt.payload.supported.length > 0,
    'supported list must be forwarded');
});

t('/model haiku from owner+admin: persists rec.modelOverride + calls session.setModel', () => {
  stub._rec = { user: 'alice', modelOverride: null };
  stub._saved = 0;
  stub._owners = new Set(['alice']);
  const ctx = makeCtx({ user: 'alice', args: 'haiku' });
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.modelOverride, 'haiku', 'rec.modelOverride must be set to haiku');
  assert.strictEqual(stub._saved, 1, 'saveStore must be called exactly once');
  assert.deepStrictEqual(ctx.session._setModelCalls, ['haiku'],
    'session.setModel must be called once with the new id');
  assert.ok(ctx._replies.some((r) => /set to/i.test(r) && /haiku/.test(r)),
    'reply must confirm haiku');
});

t('/model haiku from non-owner viewer: REFUSED, no mutation', () => {
  stub._rec = { user: 'alice', modelOverride: null };
  stub._saved = 0;
  stub._owners = new Set(['alice']);
  const ctx = makeCtx({ user: 'eve', args: 'haiku' });
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.modelOverride, null, 'rec.modelOverride must NOT change');
  assert.strictEqual(stub._saved, 0, 'saveStore must NOT be called');
  assert.deepStrictEqual(ctx.session._setModelCalls, [],
    'session.setModel must NOT be called for a denied user');
  assert.ok(ctx._replies.some((r) => /owner-or-admin/i.test(r) || /owner\+admin/i.test(r)),
    'reply must explain the gate');
});

t('/model default clears the override', () => {
  stub._rec = { user: 'alice', modelOverride: 'haiku' };
  stub._saved = 0;
  stub._owners = new Set(['alice']);
  const ctx = makeCtx({ user: 'alice', args: 'default' });
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.modelOverride, null, 'rec.modelOverride must be null after default');
  assert.strictEqual(stub._saved, 1, 'saveStore must be called for the clear');
  assert.deepStrictEqual(ctx.session._setModelCalls, [null],
    'session.setModel must be called once with null to clear the live override');
});

t('/model reset and /model clear are accepted as clear-aliases', () => {
  for (const arg of ['reset', 'clear', 'none', 'DEFAULT']) {
    stub._rec = { user: 'alice', modelOverride: 'opus' };
    stub._saved = 0;
    stub._owners = new Set(['alice']);
    const ctx = makeCtx({ user: 'alice', args: arg });
    slashcmds.handleModel(ctx);
    assert.strictEqual(stub._rec.modelOverride, null, `arg "${arg}" must clear the override`);
    assert.strictEqual(stub._saved, 1, `arg "${arg}" must persist`);
  }
});

t('/model X when current is already X: no-op + replies "no change"', () => {
  stub._rec = { user: 'alice', modelOverride: 'opus' };
  stub._saved = 0;
  stub._owners = new Set(['alice']);
  const ctx = makeCtx({ user: 'alice', args: 'opus' });
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.modelOverride, 'opus', 'idempotent — no change');
  assert.strictEqual(stub._saved, 0, 'saveStore must NOT be called on no-op');
  assert.deepStrictEqual(ctx.session._setModelCalls, [],
    'session.setModel must NOT be called on no-op');
  assert.ok(ctx._replies.some((r) => /no change/i.test(r)), 'reply must say no change');
});

t('/model <full-id> passes through verbatim (no whitelist)', () => {
  stub._rec = { user: 'alice', modelOverride: null };
  stub._saved = 0;
  stub._owners = new Set(['alice']);
  const ctx = makeCtx({ user: 'alice', args: 'claude-sonnet-4-7' });
  slashcmds.handleModel(ctx);
  assert.strictEqual(stub._rec.modelOverride, 'claude-sonnet-4-7',
    'full IDs must be accepted verbatim — no client-side whitelist');
});

// ──────────────────────────────────────────────────────────────────────
// Group B: static guards on the prod source.

t('static guard: agent-session.js reads opts.modelOverride and sets sdkOpts.model conditionally', () => {
  const src = _read('server/src/agent-session.js');
  assert.ok(/this\.modelOverride\s*=\s*opts\.modelOverride/.test(src),
    'AgentSession constructor must read opts.modelOverride');
  assert.ok(/if\s*\(\s*this\.modelOverride\s*\)\s*sdkOpts\.model/.test(src),
    'sdkOpts.model must be set ONLY when this.modelOverride is truthy ' +
    '(unset → SDK default)');
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
  const respawnBody = fnBody(src, /async\s+function\s+ensureLiveSession\s*\(/);
  assert.ok(respawnBody, 'ensureLiveSession body must be locatable');
  assert.ok(/modelOverride:\s*rec\.modelOverride/.test(respawnBody),
    'ensureLiveSession must forward rec.modelOverride on respawn');
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
