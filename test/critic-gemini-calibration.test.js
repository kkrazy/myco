// Critic infra calibration test (2026-06-02).
//
// Triggered by the bug-46 run dispatch returning:
//   "(Gemini call failed: models/gemini-1.5-pro is not found for API
//    version v1beta, or is not supported for generateContent.)"
//
// Three things land together here:
//   1. Model name: must NOT be a deprecated 1.5-family identifier
//      (gemini-1.5-pro / gemini-1.5-flash). Switched to the current
//      2.5-family.
//   2. Sampling config: explicit temperature + topP + maxOutputTokens
//      so the critic isn't running on Gemini's chat-tuned defaults
//      (temp 1.0 → invents things; topP 0.95 → tail confabulation;
//      max-tokens 8192 → long-tail hallucination surface).
//   3. System prompt: explicit "INSUFFICIENT INFORMATION:" opt-out
//      so the critic can admit uncertainty instead of rubber-stamping
//      when it can't tell from the diff alone.
//
// Test shape: static-grep guards on server/src/critics/gemini.js
// and server/src/critique.js.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── critic-gemini-calibration: 2.5 family + sampling + opt-out ──');

// ── model name ──

t('critics/gemini.js: model is NOT the deprecated gemini-1.5-pro / gemini-1.5-flash', () => {
  const src = _read('server/src/critics/gemini.js');
  // The deprecation is the trigger; lock the absence of the stale id.
  assert.ok(!/['"]gemini-1\.5-(pro|flash)['"]/.test(src),
    'critics/gemini.js must NOT reference the 1.5-family model identifiers — Google retired them on v1beta (404 NOT_FOUND on generateContent). Use 2.5-family instead.');
});

t('critics/gemini.js: model is on the 2.5-family or later', () => {
  const src = _read('server/src/critics/gemini.js');
  // Accept 2.x-family identifiers. If/when 3.x arrives, the test
  // should still pass and a future bump is one place to edit.
  assert.ok(/['"]gemini-(2\.\d|3\.\d|[0-9]+\.\d+)-(pro|flash)['"]/.test(src),
    'critics/gemini.js must reference a current Gemini family (≥ 2.x) for the critic model.');
});

t('critics/gemini.js: model identifier sits in a named constant (one place to edit on the next bump)', () => {
  const src = _read('server/src/critics/gemini.js');
  // Look for a top-level `const CRITIC_MODEL = '...';` declaration.
  // Don't lock the name itself — the value can drift across model
  // revisions; lock the shape so a future bump is one line.
  assert.ok(/const\s+CRITIC_MODEL\s*=\s*['"]gemini-\d/.test(src),
    'critics/gemini.js must declare the model id as `const CRITIC_MODEL = \'…\';` so future bumps + the regression test stay maintainable.');
});

// ── sampling config ──

t('critics/gemini.js: explicit sampling overrides the chat-tuned defaults (temperature, topP, maxOutputTokens)', () => {
  const src = _read('server/src/critics/gemini.js');
  // Sampling must be passed to generateContent — find a CRITIC_SAMPLING
  // constant or an inline config object that carries all three keys.
  // Look across the whole file (any of: CRITIC_SAMPLING const, inline
  // object in the API call). All three keys must appear.
  for (const key of ['temperature', 'topP', 'maxOutputTokens']) {
    const re = new RegExp(`${key}\\s*:`);
    assert.ok(re.test(src),
      `critics/gemini.js must declare ${key} in the sampling config (defaults are tuned for chat, not adversarial review).`);
  }
});

t('critics/gemini.js: temperature is conservative (≤ 0.4 — adversarial review wants determinism)', () => {
  const src = _read('server/src/critics/gemini.js');
  const m = src.match(/temperature:\s*([0-9.]+)/);
  assert.ok(m, 'temperature must be declared');
  const temp = parseFloat(m[1]);
  assert.ok(temp <= 0.4,
    `temperature must be ≤ 0.4 for adversarial code review — got ${temp}. Gemini's default 1.0 is creative-tuned and invents fake API methods; 0.0-0.3 keeps the critic deterministic.`);
});

t('critics/gemini.js: maxOutputTokens is declared with a sensible floor + ceiling', () => {
  const src = _read('server/src/critics/gemini.js');
  // fr-95 follow-up: the 2026-06-03 calibration bumped the cap from
  // 1024 → 8192 and moved it behind a named constant
  // CRITIC_MAX_OUTPUT_TOKENS = Math.max(4096, parseInt(env || '', 10)
  // || 8192). The original "≤ 2048" baseline-pin was the PRE-fix
  // value; pinning it now would re-introduce the truncation bug that
  // returned bare "✓ AGREED" preambles on large diffs. The CURRENT
  // contract: the cap must be HIGH enough to fit detailed verdicts
  // (so >= 4096) and not so high that it invites essay-length output
  // (so <= 65536, well below model's actual hard cap). Accept either
  // literal-digit assignment or the named constant.
  const litMatch = src.match(/maxOutputTokens:\s*(\d+)/);
  // For the constant form: anchor on the Math.max floor as the first
  // numeric argument. The full shape we expect (from the 2026-06-03
  // truncation fix):
  //   const CRITIC_MAX_OUTPUT_TOKENS = Math.max(
  //     4096,
  //     parseInt(process.env.MYCO_CRITIC_MAX_TOKENS || '', 10) || 8192,
  //   );
  // Capture the floor (the first numeric literal inside Math.max) +
  // the default (the trailing `|| <N>` fallback after the parseInt).
  // The floor is what gates "did we regress back to truncation?".
  const constMatch = src.match(/CRITIC_MAX_OUTPUT_TOKENS\s*=\s*Math\.max\s*\(\s*(\d+)/);
  const value = litMatch ? parseInt(litMatch[1], 10) : (constMatch ? parseInt(constMatch[1], 10) : null);
  assert.ok(value !== null,
    'maxOutputTokens must be declared (literal digit OR via CRITIC_MAX_OUTPUT_TOKENS named constant).');
  assert.ok(value >= 4096,
    `maxOutputTokens must be >= 4096 (the 2026-06-03 floor that fixed Gemini preamble truncation on large diffs) — got ${value}.`);
  assert.ok(value <= 65536,
    `maxOutputTokens must be <= 65536 — got ${value}. Beyond that we're inviting essay-length verdicts and hallucination surface.`);
});

// ── prompt INSUFFICIENT INFORMATION opt-out ──

t('critique.js: system prompt carries the INSUFFICIENT INFORMATION opt-out (critic must admit uncertainty)', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/INSUFFICIENT INFORMATION/.test(src),
    'critique.js system prompt must include an "INSUFFICIENT INFORMATION:" opt-out so the critic can admit it can\'t tell from the diff alone — without that, broad-instruction critics rubber-stamp confidently-wrong verdicts.');
});

t('critique.js: system prompt explicitly names the critic\'s input surface', () => {
  // bug-65 + td-33 r2 follow-up: the original phrasing was a NEGATIVE
  // "you can ONLY see the diff" to stop the critic from confabulating
  // context. td-33 r2 INVERTED that — the critic now HAS file context
  // and history, so the prompt names what the critic DOES have. bug-65
  // moved the prompt content to base.md. The original test's contract
  // (the critic shouldn't confabulate context) is still locked: now
  // satisfied by EXPLICITLY listing the critic's inputs so it doesn't
  // invent anything beyond them.
  const src = _read('server/src/critique.js');
  const md = (() => { try { return _read('server/src/critics/prompts/base.md'); } catch { return ''; } })();
  const haystack = src + '\n' + md;
  // The prompt must explicitly enumerate the critic's inputs so it
  // sticks to them.
  assert.ok(/three (blocks of )?evidence|THREE inputs|diff hunks|FULL CURRENT CONTENT|file context|PLAN ITEM HISTORY/i.test(haystack),
    'critique.js system prompt (inline OR base.md) must explicitly enumerate the critic\'s inputs (diff / file context / history) so it doesn\'t confabulate context beyond what it has.');
});

// ── exported name reflects the model ──

t('critics/gemini.js: exported `name` field reflects the actual model in use', () => {
  const src = _read('server/src/critics/gemini.js');
  // The exported `name` shows up in WS state-update frames as
  // `criticName` and in the UI. Must be in sync with CRITIC_MODEL.
  const modelMatch = src.match(/CRITIC_MODEL\s*=\s*['"]([^'"]+)['"]/);
  const nameMatch = src.match(/name:\s*['"]([^'"]+)['"]/);
  assert.ok(modelMatch, 'CRITIC_MODEL must be declared');
  assert.ok(nameMatch, 'exported name must be declared');
  const model = modelMatch[1];
  const name = nameMatch[1];
  // Loose check: the model's family (2.5 / 2.0 / etc.) should appear
  // in the name so the UI doesn't show "Gemini-1.5-Pro" while running
  // a 2.5 model.
  const familyMatch = model.match(/gemini-(\d+\.\d+)/);
  if (familyMatch) {
    const family = familyMatch[1];
    assert.ok(name.includes(family),
      `exported name "${name}" must include the model family "${family}" so the UI / WS frames don't show a stale name. Found model "${model}".`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
