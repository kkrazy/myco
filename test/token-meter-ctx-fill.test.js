// Token-meter ctx-fill regression (2026-10-21).
//
// User report: the context chip near the chat input sometimes shows
// an impossible value like "3.6M/200k ctx (100%)" — i.e. the fill
// EXCEEDS the model's context window.
//
// Root cause (two layers):
//  1. Server: the SDK `result` message's `usage` is CUMULATIVE across
//     every API request the turn made (~18 tool-iterations x a 200k
//     context ≈ 3.6M input tokens). The server shipped that raw on
//     turn_result, and the client used `usage.input_tokens` as the
//     context-window FILL — a category error (turn total ≠ current
//     context size).
//  2. Client: even for a genuine single request, a cached request's
//     input_tokens EXCLUDES the cached prefix, so fill must be
//     input + cache_read + cache_creation to reflect what the model
//     actually saw.
//
// Fix:
//  - server (agent-session.js): stash the per-request usage from each
//    `assistant` message (m.message.usage — the LAST one is the
//    current context state), compute ctxFill = input + cache_read +
//    cache_creation, ship it on turn_result.
//  - client (app.js _appendTurnFooter): prefer ev.ctxFill; fall back
//    to input + cache_read + cache_creation of the result usage.
//
// This test locks both layers: the server ships ctxFill computed
// from the last ASSISTANT usage (not the result usage), and the
// client meter reads ctxFill.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'public', 'app.js'), 'utf8');
const SESS = fs.readFileSync(path.join(ROOT, 'server', 'src', 'agent-session.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Server: must stash the per-request assistant usage
// ---------------------------------------------------------------------------
t('server stashes m.message.usage from assistant messages', () => {
  assert.ok(/_lastAssistantUsage\s*=\s*m\.message\.usage/.test(SESS),
    'agent-session.js must stash the per-request usage (m.message.usage) on every assistant message so the meter can use the LAST request\'s context, not the turn cumulative');
});

t('server resets _lastAssistantUsage on turn start', () => {
  assert.ok(/this\._lastAssistantUsage\s*=\s*null/.test(SESS),
    'agent-session.js must clear the usage stash when a new turn starts so a stale previous-turn fill can\'t be reported');
});

t('server emits ctxFill on turn_result', () => {
  assert.ok(/type:\s*'turn_result'[\s\S]{0,900}ctxFill:\s*this\._computeCtxFill\(/.test(SESS),
    'the turn_result emit must include ctxFill: this._computeCtxFill(...) so the client gets the current context fill');
});

// ---------------------------------------------------------------------------
// 2. Server: _computeCtxFill must sum input + cache_read + cache_creation
//    (behavioral: exercise the real method on the real class)
// ---------------------------------------------------------------------------
t('_computeCtxFill sums input + cache_read + cache_creation', () => {
  // Extract the method body and eval it against a fake `this`.
  // (2026-10-22: signature widened to _computeCtxFill(resultUsage, numTurns)
  // for the Huawei-gateway estimate fallback — the per-request path under
  // test here is unchanged and must still win over the estimate.)
  const at = SESS.search(/_computeCtxFill\s*\([^)]*\)\s*\{/);
  assert.ok(at > -1, '_computeCtxFill must exist on AgentSession');
  const rest = SESS.slice(at);
  const depth0 = rest.indexOf('{');
  let depth = 0, end = -1;
  for (let i = depth0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > -1, '_computeCtxFill body must be extractable');
  const body = rest.slice(depth0, end);
  const fakeThis = {
    _lastAssistantUsage: {
      input_tokens: 1200,                 // non-cached tail of the prompt
      cache_read_input_tokens: 150_000,   // cached prefix read this request
      cache_creation_input_tokens: 30_000, // prefix written to cache
      output_tokens: 500,
    },
  };
  const fill = new Function('return function ()' + body)().call(fakeThis);
  assert.strictEqual(fill, 181_200,
    'ctxFill must be input_tokens + cache_read + cache_creation = 181200 (a real fill inside the 200k window), got ' + fill);
});

t('_computeCtxFill returns null when no assistant usage AND no result usage was seen', () => {
  // Match the METHOD DEFINITION (name(args) {), not the call site inside
  // the turn_result emit — a bare /_computeCtxFill\(/ lands on the call
  // and the brace-walk then extracts the wrong body.
  const at = SESS.search(/_computeCtxFill\s*\([^)]*\)\s*\{/);
  const rest = SESS.slice(at);
  const depth0 = rest.indexOf('{');
  let depth = 0, end = -1;
  for (let i = depth0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const body = rest.slice(depth0, end);
  const fill = new Function('return function (resultUsage, numTurns)' + body)()
    .call({ _lastAssistantUsage: null }, null, null);
  assert.strictEqual(fill, null,
    'with no per-request usage stashed and no result usage, ctxFill must be null so the client falls back rather than reporting 0/undefined');
});

// ---------------------------------------------------------------------------
// 3b. Huawei-gateway regression (2026-10-22): the enterprise gateway ships
//     NO per-request assistant usage (verified live: 0 stashes across a
//     3.9M-token session), so _lastAssistantUsage stays null and the
//     client fallback used the CUMULATIVE result usage — reintroducing
//     "3.9m/200k ctx (100%)". The server must now estimate the fill as
//     cumulative usage ÷ number of API requests (numTurns).
// ---------------------------------------------------------------------------
t('huawei-gateway: no assistant usage → ctxFill averages cumulative usage by numTurns', () => {
  const at = SESS.search(/_computeCtxFill\s*\([^)]*\)\s*\{/);
  const rest = SESS.slice(at);
  const depth0 = rest.indexOf('{');
  let depth = 0, end = -1;
  for (let i = depth0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const body = rest.slice(depth0, end);
  // The user-reported shape: 3.9M cumulative input across ~20 requests,
  // no per-request assistant usage (Huawei gateway).
  const fakeThis = { _lastAssistantUsage: null };
  const fill = new Function('return function (resultUsage, numTurns)' + body)().call(fakeThis,
    { input_tokens: 3_942_266, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9430 },
    20);
  assert.ok(fill > 0 && fill <= 1_000_000,
    'huawei-gateway ctxFill must be a plausible per-request estimate (got ' + fill + '), not the 3.9M cumulative');
  assert.strictEqual(fill, Math.round(3_942_266 / 20),
    'ctxFill must be cumulative ÷ numTurns = 197113 for the 3.9M/20-request shape, got ' + fill);
});

// ---------------------------------------------------------------------------
// 3. Server: the fill must come from the ASSISTANT usage, not the result
//    usage — locked by simulating the event flow through the real handler
//    would need the SDK; the static assertions above (stash + emit +
//    compute) cover the wiring, this asserts the cumulative-result bug
//    shape can't silently return: ctxFill must NOT read from m.usage.
// ---------------------------------------------------------------------------
t('ctxFill computation does not use the cumulative result usage', () => {
  const at = SESS.search(/_computeCtxFill\s*\([^)]*\)\s*\{/);
  const rest = SESS.slice(at);
  const depth0 = rest.indexOf('{');
  let depth = 0, end = -1;
  for (let i = depth0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const body = rest.slice(depth0, end);
  assert.ok(!/m\.usage/.test(body),
    '_computeCtxFill must not read the cumulative result usage (the 3.6M-in-a-200k-window source of the bug)');
});

// ---------------------------------------------------------------------------
// 4. Client: _appendTurnFooter must prefer ev.ctxFill
// ---------------------------------------------------------------------------
t('client meter prefers ev.ctxFill over cumulative input_tokens', () => {
  const at = APP.search(/function\s+_appendTurnFooter\s*\(/);
  assert.ok(at > -1, '_appendTurnFooter must exist in app.js');
  const rest = APP.slice(at);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/ev\.ctxFill/.test(body),
    '_appendTurnFooter must read ev.ctxFill (the server-shipped current context fill) — without it the meter keeps using the turn-cumulative input_tokens and shows 3.6M/200k');
  assert.ok(/state\.turnTotals\.lastTurnInputTokens\s*=\s*\(typeof\s+ev\.ctxFill/.test(body),
    'lastTurnInputTokens must be assigned from ev.ctxFill when present');
  assert.ok(/fallbackFill\s*=\s*Math\.max\(1,\s*Math\.round\(\(inTok\s*\+\s*cacheR\s*\+\s*\(u\.cache_creation_input_tokens\s*\|\|\s*0\)\)\s*\/\s*requests\)\)/.test(body),
    'the fallback fill must sum input + cache_read + cache_creation averaged by request count (numTurns) — the raw cumulative sum is the "3.9m/200k" bug, and a plain sum can exceed the 200k window on multi-request turns');
});

t('client meter still renders fill/limit with pct (display format unchanged)', () => {
  const at = APP.search(/function\s+_renderTokenMeter\s*\(/);
  assert.ok(at > -1, '_renderTokenMeter must exist in app.js');
  const rest = APP.slice(at);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  assert.ok(/ctx\s*\(\$\{pct\}%\)/.test(body),
    'the chip format must stay "X / 200k ctx (N%)" — only the fill source changed, not the display contract');
});

// ---------------------------------------------------------------------------
// 5. Behavioral: simulate _appendTurnFooter + _renderTokenMeter against
//    the exact user-reported shape — a 3.6M cumulative turn on a 200k
//    model — and assert the chip can no longer exceed the limit.
// ---------------------------------------------------------------------------
t('behavioral: 3.6M-cumulative turn renders a fill within the window', () => {
  // Minimal harness: stub the DOM + state the two fns touch.
  const meterEl = {
    hidden: true, textContent: '', title: '',
    classList: { toggle() {} },
  };
  const document = { getElementById: () => meterEl };
  const state = {
    sdkModel: 'claude-sonnet-4-5',   // 200k window
    activeId: 's1',
    turnTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, lastTurnInputTokens: 0 },
  };
  const globalThis_ = { document, state };
  // Extract + eval the fns we need in ONE shared scope so
  // _appendTurnFooter can call _renderTokenMeter etc.
  const names = ['_humanizeTokens', '_modelTokenLimit', '_renderTokenMeter', '_appendTurnFooter'];
  // _modelTokenLimit references two module-level consts — prepend them.
  const consts = `
const TOKEN_LIMIT_DEFAULT = 200_000;
const TOKEN_LIMIT_1M_MODELS_RE = /(opus-4-7|sonnet-4-6)/i;
`;
  let factorySrc = '';
  for (const name of names) {
    const at2 = APP.search(new RegExp('function\\s+' + name + '\\s*\\('));
    assert.ok(at2 > -1, name + ' must exist in app.js');
    const rest2 = APP.slice(at2);
    const end2 = rest2.slice(1).search(/\nfunction\s+[A-Za-z_]/);
    let body2 = end2 === -1 ? rest2 : rest2.slice(0, end2 + 1);
    // Strip trailing blank line(s) left by the slice.
    body2 = body2.replace(/\n+$/, '\n');
    factorySrc += body2 + '\n';
  }
  const scopeFactory = new Function('document', 'state',
    consts + factorySrc + '\nreturn { _humanizeTokens, _modelTokenLimit, _renderTokenMeter, _appendTurnFooter };');
  const fns = scopeFactory(document, state);
  // The user-reported shape: turn_result with cumulative usage
  // (3.6M input across ~18 requests) BUT the server-shipped ctxFill
  // of the last request (~185k inside the window).
  fns._appendTurnFooter({
    usage: { input_tokens: 3_600_000, output_tokens: 5_000, cache_read_input_tokens: 900_000 },
    ctxFill: 185_000,
    totalCostUsd: 0.42,
  }, new Date().toISOString());
  fns._renderTokenMeter();
  assert.ok(!meterEl.hidden, 'meter must be visible after a turn');
  assert.ok(/185k \/ 200k ctx \(93%\)/.test(meterEl.textContent),
    'chip must show the ctxFill-based value "185k / 200k ctx (93%)", got: ' + meterEl.textContent);
  assert.ok(!/3\.6m/i.test(meterEl.textContent),
    'chip must NOT show the turn-cumulative 3.6m as context fill (the user-reported bug)');
});

// ---------------------------------------------------------------------------
// 5b. Behavioral regression (2026-10-22 user report "3.9m / 200k ctx (100%)"):
//     a turn_result with NO ctxFill — e.g. the Huawei gateway ships assistant
//     messages without per-request usage, so the server's _computeCtxFill()
//     returns null and ev.ctxFill is absent — must NOT fall back to the
//     turn-CUMULATIVE usage as the context fill. The old fallback
//     (inTok + cacheR + cacheCreation of the cumulative usage) is exactly
//     what produced the impossible "3.9m / 200k" readout.
// ---------------------------------------------------------------------------
t('behavioral: no-ctxFill turn_result never shows a fill above the window', () => {
  const meterEl = {
    hidden: true, textContent: '', title: '',
    classList: { toggle() {} },
  };
  const document = { getElementById: () => meterEl };
  const state = {
    sdkModel: 'claude-sonnet-4-5',   // 200k window
    activeId: 's1',
    turnTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, lastTurnInputTokens: 0 },
  };
  const names = ['_humanizeTokens', '_modelTokenLimit', '_renderTokenMeter', '_appendTurnFooter'];
  const consts = `
const TOKEN_LIMIT_DEFAULT = 200_000;
const TOKEN_LIMIT_1M_MODELS_RE = /(opus-4-7|sonnet-4-6)/i;
`;
  let factorySrc = '';
  for (const name of names) {
    const at2 = APP.search(new RegExp('function\\s+' + name + '\\s*\\('));
    assert.ok(at2 > -1, name + ' must exist in app.js');
    const rest2 = APP.slice(at2);
    const end2 = rest2.slice(1).search(/\nfunction\s+[A-Za-z_]/);
    let body2 = end2 === -1 ? rest2 : rest2.slice(0, end2 + 1);
    body2 = body2.replace(/\n+$/, '\n');
    factorySrc += body2 + '\n';
  }
  const scopeFactory = new Function('document', 'state',
    consts + factorySrc + '\nreturn { _humanizeTokens, _modelTokenLimit, _renderTokenMeter, _appendTurnFooter };');
  const fns = scopeFactory(document, state);
  // The exact user-reported shape: NO ctxFill (Huawei gateway — no
  // per-request assistant usage stashed server-side), cumulative usage
  // ≈ 3.9M across the whole turn, numTurns=20 (the fallback averages
  // by the request count so the estimate stays inside the window).
  fns._appendTurnFooter({
    usage: { input_tokens: 1_900_000, output_tokens: 5_000, cache_read_input_tokens: 1_900_000, cache_creation_input_tokens: 100_000 },
    numTurns: 20,
    totalCostUsd: 0.42,
  }, new Date().toISOString());
  fns._renderTokenMeter();
  const fill = state.turnTotals.lastTurnInputTokens;
  assert.ok(fill <= 200_000,
    'with no ctxFill, lastTurnInputTokens must never exceed the 200k window — got ' + fill +
    ' (the cumulative-usage fallback is the "3.9m/200k" bug)');
  assert.ok(!/3\.9m/i.test(meterEl.textContent),
    'chip must NOT show "3.9m / 200k" — got: ' + meterEl.textContent);
  assert.ok(!/100%/.test(meterEl.textContent) || /200k/.test(meterEl.textContent) && fill > 0,
    'a 100% readout is only legitimate when the fill is genuinely at the limit');
});

// Static lock: the fallback branch in _appendTurnFooter must NOT use the
// cumulative result usage as the fill when ctxFill is missing. This is the
// one-line guard that makes case 5b impossible to regress silently.
t('client fallback must not use cumulative usage as fill (no-ctxFill path)', () => {
  const at = APP.search(/function\s+_appendTurnFooter\s*\(/);
  assert.ok(at > -1, '_appendTurnFooter must exist in app.js');
  const rest = APP.slice(at);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = end === -1 ? rest : rest.slice(0, end + 1);
  // The buggy shape: fallbackFill assigned from inTok + cacheR (+ cacheC)
  // when ctxFill is absent. Any assignment of a fallback INTO
  // lastTurnInputTokens that derives from the cumulative usage is the bug.
  assert.ok(!/fallbackFill\s*=\s*inTok\s*\+/.test(body),
    '_appendTurnFooter must not derive a fill from the turn-cumulative usage (inTok + cacheR …) — ' +
    'with ctxFill missing (Huawei gateway / relayed child turns) that fallback renders "3.9m / 200k ctx (100%)"');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
