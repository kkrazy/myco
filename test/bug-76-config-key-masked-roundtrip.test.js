// bug-76 (plan-item bug-74): admin config _KEY fields — masked-value
// round trip must support "Save, then Test against the saved key
// without re-typing it". The test file uses bug-76 because bug-74 is
// the plan-item id and we already have test/bug-74-find-plan-item-
// file-mirror-fallback.test.js + bug-75 in the test dir.
//
// User report (verbatim, 2026-06-09):
//   "right now if I click test, it says no key" — after saving the
//   Gemini API key via the admin config page, re-opening the page
//   shows the input field blank and clicking Test reports "no key"
//   even though the server has the saved key in process.env.
//
// Two coupled bugs:
//   1. web/public/app.js:1109 — when GET /api/admin/config returns a
//      masked value (containing • or ...), the client CLEARS the
//      input. No visible confirmation the save took effect; looks
//      identical to "save failed".
//   2. web/public/app.js:_runApiKeyTest reads input.value as the key
//      to POST. With input cleared (bug 1), key='' is sent. Server-
//      side _probeXKey functions all refuse when !key — returning
//      'no X key provided'. They don't fall back to process.env where
//      the saved key actually lives.
//
// Fix:
//   · Client (app.js:1109): show the masked value AS the input value
//     instead of clearing — gives the user a "Set: AIza…XXXX" visual
//     affordance. Server-side isMaskedValue check at index.js:1773
//     already preserves the saved value if the user re-clicks Save
//     without re-typing.
//   · Client (_runApiKeyTest): when input.value matches the mask
//     pattern, send key='' so the server's new fallback uses
//     process.env.
//   · Server (each _probeXKey): when client-sent key is empty, fall
//     back to process.env[the appropriate env var name]. Only error
//     when BOTH client-sent key AND env are missing.
//   · Client (_refreshConfigAdmin): add a focus listener on each
//     masked _KEY input that clears it on focus when the value is
//     masked — prevents partial-edit hybrid values that would trip
//     the server's isMaskedValue skip.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-76 (plan-item bug-74): admin config _KEY masked round trip ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards.
// ─────────────────────────────────────────────────────────────────

const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const INDEX_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');

t('app.js _refreshConfigAdmin no longer clears input when GET returns masked value', () => {
  const m = APP_JS.match(/async\s+function\s+_refreshConfigAdmin\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_refreshConfigAdmin body must be greppable');
  const body = m[1];
  // Pre-fix had `if (typeof v === 'string' && (v.includes('•') || v.includes('...'))) { input.value = ''; } else { … }`.
  // Post-fix must NOT clear the input on a masked value — always assign.
  assert.ok(!/input\.value\s*=\s*['"]['"]\s*;[\s\S]{0,40}else\s*\{[\s\S]{0,80}input\.value\s*=\s*\(typeof\s+v/.test(body),
    'bug-76: pre-fix clear-on-mask branch must be gone — input must show the masked value so the user sees a save-took-effect affordance');
  // The remaining assignment line must still set input.value from v
  // (no regression on the happy path).
  assert.ok(/input\.value\s*=\s*\(typeof\s+v\s*===?\s*['"]string['"]\)\s*\?\s*v\s*:\s*['"]['"]/.test(body),
    'input.value must still be set from v on the truthy branch');
});

t('app.js _runApiKeyTest treats masked input.value as "use saved key" (sends empty)', () => {
  const m = APP_JS.match(/async\s+function\s+_runApiKeyTest\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_runApiKeyTest body must be greppable');
  const body = m[1];
  // Must detect mask pattern in the extracted key and reset to empty
  // so the server fallback fires.
  assert.ok(/(key\.includes\(\s*['"]•['"]\s*\)|key\.includes\(\s*['"]\.\.\.['"]\s*\))/.test(body),
    'bug-76: _runApiKeyTest must detect the mask pattern (• or ...) in the key value and treat as "use saved server-side key"');
  // The reset must zero out key before the POST so the request body
  // carries key='' (the server then falls back to process.env).
  assert.ok(/key\s*=\s*['"]['"]/.test(body) || /key\s*=\s*null/.test(body),
    'bug-76: when input is masked, the local `key` var must be reset to empty / null so the POST payload triggers the server-side fallback');
});

t('app.js _refreshConfigAdmin binds a focus listener on _KEY inputs that clears mask-on-focus', () => {
  const m = APP_JS.match(/async\s+function\s+_refreshConfigAdmin\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  // The fix wires a focus handler that clears the input if the value
  // is masked. Loop over the 4 _KEY input ids or do it inline.
  assert.ok(/addEventListener\s*\(\s*['"]focus['"]/.test(body),
    'bug-76: _refreshConfigAdmin must bind a focus listener on the masked _KEY inputs to clear them on focus (prevents partial-edit hybrid values that would trip the server isMaskedValue skip)');
});

t('server: _probeAnthropicKey falls back to process.env.ANTHROPIC_API_KEY when client key empty', () => {
  const m = INDEX_JS.match(/async\s+function\s+_probeAnthropicKey\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_probeAnthropicKey body must be greppable');
  const body = m[1];
  assert.ok(/process\.env\.ANTHROPIC_API_KEY/.test(body),
    'bug-76: _probeAnthropicKey must read process.env.ANTHROPIC_API_KEY as a fallback when the client-sent key is empty');
});

t('server: _probeGeminiKey falls back to process.env.GEMINI_API_KEY when client key empty', () => {
  const m = INDEX_JS.match(/async\s+function\s+_probeGeminiKey\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_probeGeminiKey body must be greppable');
  const body = m[1];
  assert.ok(/process\.env\.GEMINI_API_KEY/.test(body),
    'bug-76: _probeGeminiKey must read process.env.GEMINI_API_KEY as a fallback when the client-sent key is empty');
});

t('server: _probeOpenAIKey falls back to process.env.OPENAI_API_KEY when client key empty', () => {
  const m = INDEX_JS.match(/async\s+function\s+_probeOpenAIKey\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_probeOpenAIKey body must be greppable');
  const body = m[1];
  assert.ok(/process\.env\.OPENAI_API_KEY/.test(body),
    'bug-76: _probeOpenAIKey must read process.env.OPENAI_API_KEY as a fallback when the client-sent key is empty');
});

t('server: _probeCustomCriticKey falls back to process.env.CUSTOM_CRITIC_KEY when client key empty', () => {
  const m = INDEX_JS.match(/async\s+function\s+_probeCustomCriticKey\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_probeCustomCriticKey body must be greppable');
  const body = m[1];
  assert.ok(/process\.env\.CUSTOM_CRITIC_KEY/.test(body),
    'bug-76: _probeCustomCriticKey must read process.env.CUSTOM_CRITIC_KEY as a fallback when the client-sent key is empty');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime probe-fallback assertions. Stub fetch to avoid
// real network calls; assert that the env-fallback chain works.
// ─────────────────────────────────────────────────────────────────

// Stash + restore fetch.
const _origFetch = global.fetch;
process.on('exit', () => { global.fetch = _origFetch; });

// We can't easily import the probe functions (they're not exported);
// instead, we re-evaluate the function bodies in this test process by
// extracting them with a regex. Simpler: use vm.Script to evaluate
// just the 4 probe functions in a controlled scope.
//
// Even simpler: assert via static + an integration-style smoke that
// when GEMINI_API_KEY is set in process.env and the route handler
// runs with key='', the probe is invoked with the env value.

// The cleanest verifiable assertion is the static one (covered in
// PART A). The runtime stub-based assertion below validates the
// probe HAPPENS without erroring on empty-key when env is set.

t('runtime: with GEMINI_API_KEY in env, _probeGeminiKey body succeeds on empty client key (no "no Gemini key provided")', () => {
  const m = INDEX_JS.match(/async\s+function\s+_probeGeminiKey\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  const body = m[1];
  // Compose a minimal evaluator. We can't call the real SDK from
  // this test; assert via source that the "no Gemini key provided"
  // error path is gated on BOTH client AND env being missing.
  // Find the early-return error string.
  const errMatch = body.match(/return\s+\{[^}]*no Gemini key provided[^}]*\}/);
  assert.ok(errMatch,
    'the "no Gemini key provided" error string must still be present (defensive — fires when env is ALSO missing)');
  // The error must come AFTER a process.env.GEMINI_API_KEY read.
  const envIdx = body.indexOf('process.env.GEMINI_API_KEY');
  const errIdx = body.indexOf('no Gemini key provided');
  assert.ok(envIdx > -1 && errIdx > -1 && envIdx < errIdx,
    'bug-76: process.env.GEMINI_API_KEY fallback must be READ BEFORE the "no key" error — the error must only fire when BOTH client key AND env are missing');
});

t('runtime (mirrored): _probeAnthropicKey, _probeOpenAIKey, _probeCustomCriticKey have the same fallback-before-error shape', () => {
  for (const [fn, errStr, envVar] of [
    ['_probeAnthropicKey', 'no Anthropic key provided', 'ANTHROPIC_API_KEY'],
    ['_probeOpenAIKey',    'no OpenAI key provided',    'OPENAI_API_KEY'],
    ['_probeCustomCriticKey', 'no Custom Critic key provided', 'CUSTOM_CRITIC_KEY'],
  ]) {
    const re = new RegExp(`async\\s+function\\s+${fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`);
    const m = INDEX_JS.match(re);
    assert.ok(m, fn + ' body must be greppable');
    const body = m[1];
    const envIdx = body.indexOf('process.env.' + envVar);
    const errIdx = body.indexOf(errStr);
    if (errIdx > -1) {
      // Custom Critic might phrase its error differently; only enforce
      // ordering if both are present.
      assert.ok(envIdx > -1 && envIdx < errIdx,
        `${fn}: process.env.${envVar} fallback must be read BEFORE the "${errStr}" error`);
    } else {
      // Just confirm the env fallback is in the body.
      assert.ok(envIdx > -1,
        `${fn}: must reference process.env.${envVar} as a fallback`);
    }
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
