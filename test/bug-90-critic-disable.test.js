// bug-90: graceful degradation when the critic model errors —
// disable the critic for the session and continue execution.
//
// Contract:
//   - server/src/critics/index.js registers a 'none' critic (4 critics
//     total: gemini, codex, custom, none).
//   - getCritic('none') returns the no-op plugin (NOT the gemini fallback).
//   - The 'none' plugin carries a `disabled: true` marker.
//   - critique.js triggerGeminiCritique short-circuits when
//     critic.disabled === true: calls _broadcastSyntheticSkipVerdict
//     with reason='critic-disabled', transitions awaiting_accept,
//     returns BEFORE touching Gemini.
//   - attach.js _broadcastSyntheticSkipVerdict renders the critic-disabled
//     reason with a distinct "🔕 Critic disabled" title (NOT a fake
//     "✓ AGREED" — per A4 audit-trail discipline).
//   - critique.js bug-68 critic-error chat note mentions the new
//     escape hatch (🔕 Disable critic / /critic off).
//   - slashcmds.js exports handleCritic + registers /critic. Status open;
//     on/off owner+admin gated.
//   - app.js renders a 🔕 Disable critic button on error verdict panes
//     and wires it to POST /sessions/<id>/critic { modelId: 'none' }.
//   - styles.css ships .verdict-btn-disable-critic styling.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody, sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-90: disable critic gracefully when critic model errors ──');

// ──────────────────────────────────────────────────────────────────────
// Group A: critic registry behavior.

t('critic registry exports a "none" critic in addition to gemini/codex/custom', () => {
  const { critics, getCritic } = require('../server/src/critics');
  const ids = critics.map((c) => c.id).sort();
  assert.deepStrictEqual(ids, ['codex', 'custom', 'gemini', 'none'].sort(),
    `expected registry to expose [codex, custom, gemini, none] (got ${JSON.stringify(ids)})`);
  // getCritic('none') must return the no-op plugin, NOT the gemini fallback.
  const noneCritic = getCritic('none');
  assert.ok(noneCritic, 'getCritic("none") must return a plugin');
  assert.strictEqual(noneCritic.id, 'none', 'id must be "none" (not gemini fallback)');
  assert.strictEqual(noneCritic.disabled, true,
    'the "none" plugin must carry disabled:true so critique.js can short-circuit on it');
});

t('the "none" plugin runCritique is a guardrail — function body throws on invoke', () => {
  // The short-circuit in critique.js should mean runCritique is NEVER
  // called for 'none'. But if a future refactor forgets the check, the
  // plugin throws with a clear regression message rather than hanging.
  // Sync check: parse the runCritique source body for the throw + the
  // bug-90 mention. Avoids the test-runner's sync/async impedance
  // mismatch on an async-throw assertion.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/src/critics/none.js'), 'utf8');
  assert.ok(/async\s+runCritique\s*\(/.test(src),
    'none.js must declare runCritique as async');
  assert.ok(/throw new Error/.test(src),
    'runCritique must throw on invocation (guardrail)');
  assert.ok(/bug-90/.test(src),
    'guardrail message must mention bug-90 so a future debug ties back');
});

// ──────────────────────────────────────────────────────────────────────
// Group B: /critic slash command.

t('slashcmd: /critic is registered + listed in /commands', () => {
  // Stub sessions + permissions so slashcmds.js can be required.
  const stub = {
    _rec: null, _owners: new Set(),
    getSessionRecord(_id) { return this._rec; },
    isOwnerOrAdmin(_id, user) { return this._owners.has(user); },
    saveStore() {},
    appendChatMessage() {},
  };
  require.cache[require.resolve('../server/src/sessions')] = {
    exports: stub,
    id: require.resolve('../server/src/sessions'),
    filename: require.resolve('../server/src/sessions'),
    loaded: true,
  };
  require.cache[require.resolve('../server/src/permissions')] = {
    exports: { matchesPattern() { return false; } },
    id: require.resolve('../server/src/permissions'),
    filename: require.resolve('../server/src/permissions'),
    loaded: true,
  };
  delete require.cache[require.resolve('../server/src/slashcmds')];
  const slashcmds = require('../server/src/slashcmds');
  const cmds = slashcmds.listCommands();
  const criticCmd = cmds.find((c) => c.name === 'critic');
  assert.ok(criticCmd, '/critic must be in COMMANDS');
  assert.ok(/critic/i.test(criticCmd.summary));
  assert.ok(/off/.test(criticCmd.usage) && /on/.test(criticCmd.usage),
    'usage must mention on + off variants');
});

t('/critic status is OPEN to all users (read-only)', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice', criticModel: 'gemini' };
  sessionsMod._owners = new Set(['alice']);
  const replies = [];
  const ctx = {
    sessionId: 'sid-1', user: 'eve', args: 'status',
    reply: (m) => replies.push(String(m)),
    session: { emit() {} },
  };
  slashcmds.handleCritic(ctx);
  assert.ok(replies.length === 1, 'must reply');
  assert.ok(/enabled|disabled/i.test(replies[0]),
    'status reply must say enabled or disabled');
});

t('/critic off from owner persists rec.criticModel="none" + broadcasts state-update', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice', criticModel: 'gemini' };
  sessionsMod._owners = new Set(['alice']);
  const events = [];
  const ctx = {
    sessionId: 'sid-2', user: 'alice', args: 'off',
    reply() {},
    session: { emit: (kind, payload) => events.push({ kind, payload }) },
  };
  slashcmds.handleCritic(ctx);
  assert.strictEqual(sessionsMod._rec.criticModel, 'none', 'rec.criticModel must flip to "none"');
  const evt = events.find((e) => e.kind === 'state-update' &&
    e.payload && e.payload.kind === 'critic-model-changed');
  assert.ok(evt, 'must broadcast state-update kind:"critic-model-changed"');
  assert.strictEqual(evt.payload.modelId, 'none', 'broadcast payload must carry the new modelId');
});

t('/critic off from non-owner viewer is REFUSED — rec.criticModel unchanged', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice', criticModel: 'gemini' };
  sessionsMod._owners = new Set(['alice']);
  const replies = [];
  const ctx = {
    sessionId: 'sid-3', user: 'eve', args: 'off',
    reply: (m) => replies.push(String(m)),
    session: { emit() {} },
  };
  slashcmds.handleCritic(ctx);
  assert.strictEqual(sessionsMod._rec.criticModel, 'gemini',
    'rec.criticModel must NOT change for a denied user');
  assert.ok(replies.some((r) => /owner/i.test(r)), 'denial must mention the gate');
});

t('/critic on restores rec.criticModel="gemini"', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice', criticModel: 'none' };
  sessionsMod._owners = new Set(['alice']);
  const ctx = {
    sessionId: 'sid-4', user: 'alice', args: 'on',
    reply() {},
    session: { emit() {} },
  };
  slashcmds.handleCritic(ctx);
  assert.strictEqual(sessionsMod._rec.criticModel, 'gemini',
    '/critic on must restore the default "gemini"');
});

t('/critic on/off is idempotent — same value → no change, no broadcast', () => {
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice', criticModel: 'gemini' };
  sessionsMod._owners = new Set(['alice']);
  const events = [];
  const ctx = {
    sessionId: 'sid-5', user: 'alice', args: 'on',
    reply() {},
    session: { emit: (kind, payload) => events.push({ kind, payload }) },
  };
  slashcmds.handleCritic(ctx);
  assert.strictEqual(events.length, 0, 'no broadcast on no-op');
});

// ──────────────────────────────────────────────────────────────────────
// Group C: static guards on the prod source.

t('static guard: critique.js short-circuits triggerGeminiCritique when critic.disabled === true', () => {
  const src = _read('server/src/critique.js');
  const body = fnBody(src, /async\s+function\s+triggerGeminiCritique\s*\(/);
  assert.ok(body, 'triggerGeminiCritique body must be locatable');
  // The check must look at critic.disabled, call _broadcastSyntheticSkipVerdict
  // with reason critic-disabled, transition awaiting_accept, AND return.
  assert.ok(/critic\.disabled\s*===\s*true|critic\s*&&\s*critic\.disabled/.test(body),
    'short-circuit must gate on critic.disabled');
  assert.ok(/_broadcastSyntheticSkipVerdict/.test(body),
    'short-circuit must reuse _broadcastSyntheticSkipVerdict (existing skip plumbing)');
  assert.ok(/critic-disabled/.test(body),
    'reason passed to skip-verdict must be "critic-disabled" (for distinct rendering)');
  assert.ok(/_transitionStageState/.test(body),
    'short-circuit must transition stage state to awaiting_accept so user can Accept');
  // Ordering: the disabled check must come BEFORE the basePrompt /
  // model call, so we don't waste a Gemini quota probe on a disabled
  // critic. Loose anchor: check critic-disabled appears before any
  // mention of "basePrompt".
  const disabledIdx = body.indexOf('critic-disabled');
  const basePromptIdx = body.indexOf('basePrompt');
  assert.ok(disabledIdx > 0, 'disabled branch must exist');
  assert.ok(basePromptIdx > disabledIdx,
    'disabled short-circuit must come BEFORE basePrompt construction (no wasted network call)');
});

t('static guard: attach.js _broadcastSyntheticSkipVerdict renders critic-disabled distinctly (NOT fake AGREED)', () => {
  const src = _read('server/src/attach.js');
  const body = fnBody(src, /function\s+_broadcastSyntheticSkipVerdict\s*\(/);
  assert.ok(body, '_broadcastSyntheticSkipVerdict body must be locatable');
  // The reason map must include 'critic-disabled' with explanatory text.
  assert.ok(/'critic-disabled'/.test(body) || /"critic-disabled"/.test(body),
    'reasonExplain map must include critic-disabled');
  // Distinct title — must use 🔕 Critic disabled, NOT the AGREED title.
  assert.ok(/🔕 Critic disabled/.test(body),
    'critic-disabled branch must render with "🔕 Critic disabled" title (per A4: not a fake AGREED)');
  // Branch must mention /critic on as the re-enable path.
  assert.ok(/\/critic on/.test(body),
    'critic-disabled body must mention /critic on as the re-enable path');
});

t('static guard: critique.js bug-68 error chat note mentions the disable affordance (A5)', () => {
  const src = _read('server/src/critique.js');
  // Find the bug-68 error-chat-note text. Loose anchor: the note has
  // "Critic call for" + a "** stage)" or similar. Use a window slice.
  const noteIdx = src.indexOf('⚠️ Critic call for');
  assert.ok(noteIdx > 0, 'bug-68 critic-error chat note must exist');
  const noteWindow = src.slice(noteIdx, noteIdx + 2000);
  assert.ok(/Disable critic/i.test(noteWindow) || /\/critic off/.test(noteWindow),
    'bug-68 error note must mention 🔕 Disable critic OR /critic off (A5 graceful-degradation hint)');
});

t('static guard: slashcmds.js exports handleCritic + /critic is owner+admin for on/off', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/names:\s*\[\s*['"]critic['"]/.test(src), '/critic must be in COMMANDS');
  assert.ok(/function\s+handleCritic\s*\(/.test(src), 'handleCritic must be defined');
  const body = fnBody(src, /function\s+handleCritic\s*\(/);
  assert.ok(body, 'handleCritic body must be locatable');
  assert.ok(/isOwnerOrAdmin\s*\(/.test(body),
    'handleCritic must call isOwnerOrAdmin to gate on/off');
  // Sets rec.criticModel to 'none' or 'gemini'.
  assert.ok(/criticModel\s*=\s*next|criticModel\s*=\s*'none'|next === 'none'/.test(body),
    'handleCritic must persist rec.criticModel based on the arg');
  assert.ok(/critic-model-changed/.test(body),
    'handleCritic must broadcast state-update kind:"critic-model-changed" so the config admin panel updates');
});

t('static guard: app.js renders 🔕 Disable critic button on error verdicts + wires the POST', () => {
  const src = _read('web/public/app.js');
  // Button class must appear in the error-branch innerHTML.
  assert.ok(/verdict-btn-disable-critic/.test(src),
    'app.js must render a button with class verdict-btn-disable-critic on error verdicts');
  assert.ok(/🔕 Disable critic/.test(src),
    'button label must be "🔕 Disable critic"');
  // The click handler must POST /critic with modelId 'none'. Anchor on
  // the unique querySelector lookup (the click wire's actual entry point),
  // not on the button HTML render which appears first in the file and
  // would cause us to slice into UNRELATED handlers (Retry/Discard/etc).
  const queryIdx = src.search(/querySelector\s*\(\s*['"]\.verdict-btn-disable-critic['"]/);
  assert.ok(queryIdx > 0,
    'must wire a click handler via querySelector(".verdict-btn-disable-critic")');
  const window = src.slice(queryIdx, queryIdx + 2000);
  assert.ok(/addEventListener\s*\(\s*['"]click['"]/.test(window),
    'must add a click listener on the disable-critic button');
  assert.ok(/POST/.test(window) && /\/critic/.test(window),
    'click handler must POST to /sessions/<id>/critic');
  assert.ok(/modelId.*['"]none['"]/.test(window) || /['"]none['"].*modelId/.test(window),
    'click handler must send modelId:"none" in the body');
});

t('static guard: styles.css ships .verdict-btn-disable-critic styling', () => {
  const src = _read('web/public/styles.css');
  assert.ok(/\.verdict-btn-disable-critic\b/.test(src),
    '.verdict-btn-disable-critic class must be styled');
  assert.ok(/\.verdict-btn-disable-critic:hover\b/.test(src),
    '.verdict-btn-disable-critic:hover must be styled');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
