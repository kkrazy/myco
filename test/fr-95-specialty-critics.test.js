// fr-95: specialized Test-Validity + Perf/Security critics with
// cache-optimized prompt layout.
//
// User-asked (plan-item, verbatim):
//   "Add specialized Test-Validity and Perf/Security critics with
//    cache-optimized prompts"
//   "Two additional critics alongside the general one"
//   "Prompts structured so the shared/static prefix is maximized for
//    prefix caching (stable system/instruction content first,
//    variable inputs last)"
//
// Design (from analyze stage):
//   · Specialties are an orthogonal axis from model wrappers
//     (server/src/critics/{gemini,codex,custom}.js are MODELS;
//     server/src/critics/specialties/*.js are DOMAINS).
//   · Each specialty exports {id, name, systemSuffix}. The shared
//     base prompt + project critic.md rules form the STABLE PREFIX;
//     specialty.systemSuffix is appended at the TAIL of the system
//     instruction. The user prompt (diff + file context + history)
//     is bit-for-bit identical across the fan-out — that's the cache
//     reuse opportunity.
//   · FINAL critiques fan out across all three specialties.
//   · INTERMEDIATE critiques (stage-done) fire general-only to keep
//     the 3-stage methodology cheap (would otherwise be 3 stages × 3
//     specialties = 9 calls per plan item).
//   · GENERAL critic gates the run queue (its ✓ AGREED decides
//     pause/advance); specialty verdicts are INFORMATIONAL.
//
// Test shape: static-grep that the locked surface is present.

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

console.log('── fr-95: specialized Test-Validity + Perf/Security critics ──');

// ── 1. Specialty modules exist + export the right shape ──

t('server/src/critics/specialties/general.js exports {id:"general", name, systemSuffix}', () => {
  const src = _read('server/src/critics/specialties/general.js');
  assert.ok(/id:\s*['"]general['"]/.test(src),
    'general specialty must export id:"general".');
  assert.ok(/name:\s*['"][^'"]+['"]/.test(src),
    'general specialty must export a name string.');
  assert.ok(/systemSuffix:/.test(src),
    'general specialty must export a systemSuffix string (the focus suffix appended to the shared system prompt).');
  // bug-65 follow-up: the SPECIALTY FOCUS header content was moved
  // OUT of the .js (inline systemSuffix template string) and INTO a
  // sibling general.md file (loaded via fs.readFileSync). The
  // contract this test locks (the suffix mentions "SPECIALTY
  // FOCUS") is now satisfied by the .md content; check both
  // locations for forward compat.
  const md = (() => {
    try { return _read('server/src/critics/specialties/general.md'); }
    catch { return ''; }
  })();
  assert.ok(/SPECIALTY FOCUS/.test(src) || /SPECIALTY FOCUS/.test(md),
    'general systemSuffix (either inline in general.js OR loaded from general.md sibling) must contain a "SPECIALTY FOCUS" header so the critic can find its instructions.');
});

t('server/src/critics/specialties/test-validity.js exports {id:"test-validity", name, systemSuffix}', () => {
  const src = _read('server/src/critics/specialties/test-validity.js');
  assert.ok(/id:\s*['"]test-validity['"]/.test(src),
    'test-validity specialty must export id:"test-validity".');
  assert.ok(/systemSuffix:/.test(src),
    'test-validity specialty must export a systemSuffix string.');
  // bug-65 follow-up: domain content was moved to test-validity.md
  // sibling (loaded via fs.readFileSync in the .js). Check both
  // locations for forward compat.
  const md = (() => { try { return _read('server/src/critics/specialties/test-validity.md'); } catch { return ''; } })();
  const haystack = src + '\n' + md;
  assert.ok(/[Tt]autologic|[Ww]ould have CAUGHT|wrong[- ]layer|[Mm]issing[- ]coverage/i.test(haystack),
    'test-validity systemSuffix (inline in .js OR loaded from .md sibling) must mention what the critic is checking (tautological tests, would-have-caught, wrong layer, missing coverage).');
});

t('server/src/critics/specialties/perf-security.js exports {id:"perf-security", name, systemSuffix}', () => {
  const src = _read('server/src/critics/specialties/perf-security.js');
  assert.ok(/id:\s*['"]perf-security['"]/.test(src),
    'perf-security specialty must export id:"perf-security".');
  assert.ok(/systemSuffix:/.test(src),
    'perf-security specialty must export a systemSuffix string.');
  // bug-65 follow-up: domain content was moved to perf-security.md
  // sibling. Check both locations.
  const md = (() => { try { return _read('server/src/critics/specialties/perf-security.md'); } catch { return ''; } })();
  const haystack = src + '\n' + md;
  assert.ok(/O\(N|n\+1|sync.?fs|unbounded/i.test(haystack),
    'perf-security systemSuffix (inline OR .md) must mention concrete perf patterns (O(N²), n+1, sync-fs, unbounded).');
  assert.ok(/PAT|token|secret|injection|sanitiz|CSRF|CORS|innerHTML|child_process/i.test(haystack),
    'perf-security systemSuffix (inline OR .md) must mention concrete security patterns (secrets logged, injection, etc.).');
});

// ── 2. Specialty registry wires the fan-out order + intermediate-only-general gate ──

t('server/src/critics/specialties/index.js exports FINAL_SPECIALTIES and INTERMEDIATE_SPECIALTIES', () => {
  const src = _read('server/src/critics/specialties/index.js');
  assert.ok(/FINAL_SPECIALTIES/.test(src),
    'specialties/index.js must export FINAL_SPECIALTIES (the ordered list for FINAL critiques).');
  assert.ok(/INTERMEDIATE_SPECIALTIES/.test(src),
    'specialties/index.js must export INTERMEDIATE_SPECIALTIES (the ordered list for stage-done checkpoints).');
});

t('FINAL_SPECIALTIES contains [general, test-validity, perf-security] in that order — general is first because its verdict gates the queue', () => {
  const src = _read('server/src/critics/specialties/index.js');
  // The general specialty must be the first entry in FINAL_SPECIALTIES.
  // Lock the order by requiring the array literal to start with general.
  const finalMatch = src.match(/const\s+FINAL_SPECIALTIES\s*=\s*\[([^\]]+)\]/);
  assert.ok(finalMatch, 'FINAL_SPECIALTIES must be defined as a literal array.');
  const body = finalMatch[1];
  // First entry must be the general specialty.
  assert.ok(/^\s*general/.test(body),
    'FINAL_SPECIALTIES must list general FIRST — the general critic\'s verdict is what gates the run queue (fr-95 contract).');
  // All three must be present.
  assert.ok(/general/.test(body) && /[Tt]est[Vv]alidity|test.?validity/i.test(body) && /[Pp]erf[Ss]ecurity|perf.?security/i.test(body),
    'FINAL_SPECIALTIES must include general, test-validity, and perf-security.');
});

t('INTERMEDIATE_SPECIALTIES contains general only — fan-out is FINAL-only to keep checkpoints cheap', () => {
  const src = _read('server/src/critics/specialties/index.js');
  const intMatch = src.match(/const\s+INTERMEDIATE_SPECIALTIES\s*=\s*\[([^\]]+)\]/);
  assert.ok(intMatch, 'INTERMEDIATE_SPECIALTIES must be defined as a literal array.');
  const body = intMatch[1].trim();
  assert.ok(/^general\s*,?\s*$/.test(body),
    `INTERMEDIATE_SPECIALTIES must contain ONLY [general] — fan-out × 3 stages × 3 specialties = 9 calls per item would be too aggressive at checkpoints. Got: [${body}].`);
});

// ── 3. critique.js wires the fan-out + cache-friendly layout ──

t('server/src/critique.js imports FINAL_SPECIALTIES + INTERMEDIATE_SPECIALTIES from critics/specialties', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/require\s*\(\s*['"]\.\/critics\/specialties['"]\s*\)/.test(src),
    'critique.js must require("./critics/specialties").');
  assert.ok(/FINAL_SPECIALTIES/.test(src) && /INTERMEDIATE_SPECIALTIES/.test(src),
    'critique.js must destructure FINAL_SPECIALTIES + INTERMEDIATE_SPECIALTIES so it can fan out per the gating contract.');
});

t('critique.js builds a STABLE PREFIX (basePrompt + projectCriticRules) ONCE and appends specialty.systemSuffix per call — cache-friendly layout', () => {
  const src = _read('server/src/critique.js');
  // The stable prefix must be a single named variable that gets the
  // specialty suffix appended per-call inside the fan-out loop.
  assert.ok(/systemPromptPrefix/.test(src),
    'critique.js must define a systemPromptPrefix variable for the stable head shared across the fan-out — without it, every specialty call repeats the full prompt and prefix caching can\'t work.');
  // The per-call assembly must show the suffix being appended at the TAIL.
  assert.ok(/systemPromptPrefix\s*\+\s*specialty\.systemSuffix/.test(src),
    'critique.js must compose per-call system prompt as `systemPromptPrefix + specialty.systemSuffix` — appending the VARIABLE part at the TAIL keeps the stable prefix bit-for-bit identical across the fan-out (prefix-cache hit on calls 2 + 3).');
});

t('critique.js builds userPrompt ONCE before the fan-out — bit-for-bit identical user prompt across specialty calls', () => {
  const src = _read('server/src/critique.js');
  // userPrompt must be declared ONCE (single `const userPrompt =` assignment).
  const userPromptDecls = (src.match(/const\s+userPrompt\s*=/g) || []).length;
  assert.strictEqual(userPromptDecls, 1,
    `userPrompt must be assigned exactly ONCE before the specialty fan-out (cache reuse depends on the user prompt being IDENTICAL across all specialty calls). Found ${userPromptDecls} assignments.`);
});

t('critique.js fan-out loop iterates over the resolved specialty list and runs critic.runCritique per specialty', () => {
  const src = _read('server/src/critique.js');
  // The loop must iterate over the chosen specialty array (FINAL or
  // INTERMEDIATE) and pass per-specialty system prompts into runCritique.
  assert.ok(/for\s*\(\s*const\s+specialty\s+of\s+specialties\s*\)/.test(src),
    'critique.js must contain a `for (const specialty of specialties)` fan-out loop.');
  assert.ok(/critic\.runCritique\s*\(\s*userPrompt\s*,/.test(src),
    'critique.js must call critic.runCritique(userPrompt, ...) inside the fan-out — same userPrompt across all specialties (cache reuse).');
});

t('critique.js selects specialties = isIntermediate ? INTERMEDIATE_SPECIALTIES : FINAL_SPECIALTIES', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/isIntermediate\s*\?\s*INTERMEDIATE_SPECIALTIES\s*:\s*FINAL_SPECIALTIES/.test(src),
    'critique.js must gate the fan-out: intermediate critiques use INTERMEDIATE_SPECIALTIES (general-only); finals use FINAL_SPECIALTIES (all three).');
});

t('critique.js queue gating uses the GENERAL critic\'s verdict only — specialty verdicts are informational', () => {
  const src = _read('server/src/critique.js');
  // The pause-queue block must use generalIsError/generalIsAgreed (not
  // the last specialty's verdict).
  assert.ok(/generalIsAgreed|generalIsError/.test(src),
    'critique.js must track generalIsAgreed / generalIsError separately so the run-queue gate uses the GENERAL critic\'s verdict, not whatever the last specialty returned.');
  // The pause block remains gated on !isError && !isIntermediate, where
  // isError comes from the general verdict (preserved variable names).
  assert.ok(/if\s*\(\s*rec\s*&&\s*!isIntermediate\s*&&\s*!isError\s*\)/.test(src),
    'critique.js queue-pause must remain gated on !isIntermediate && !isError (where isError = generalIsError).');
});

t('critique.js concatenates verdicts under markdown section headers when fan-out > 1; flat render when only 1 specialty', () => {
  const src = _read('server/src/critique.js');
  // The 1-specialty branch must short-circuit to the bare verdict (so
  // intermediate critiques look identical to pre-fr-95 in the pane).
  assert.ok(/sectionVerdicts\.length\s*===\s*1/.test(src),
    'critique.js must short-circuit to a flat verdict when only 1 specialty ran (intermediate path) — preserves pre-fr-95 checkpoint rendering.');
  // The fan-out branch must concatenate with section headers.
  assert.ok(/##\s*\$\{specialty\.name\}/.test(src),
    'critique.js must concatenate fan-out verdicts under markdown "## <Specialty Name> critic" section headers so the user can tell which critic said what.');
});

t('critique.js broadcasts a single critique-review WS frame with per-specialty metadata in `specialties` field', () => {
  const src = _read('server/src/critique.js');
  // The fr-95 invariant is "the critique-review broadcast carries a
  // `specialties` field." Pre-fr-98 the test pinned the LITERAL form
  // `session.emit('state-update', { ... kind:'critique-review' ... })`
  // — but fr-98 refactored the broadcast to assign the payload to
  // `broadcastPayload` first (so setLastCriticReview can persist it),
  // then emit. The semantic invariant is unchanged: the
  // critique-review broadcast still carries the same specialties
  // field. Locate the kind:'critique-review' marker (which appears
  // exactly once in critique.js — at the broadcast payload) and
  // assert specialties shows up adjacent to it.
  const at = src.search(/kind:\s*['"]critique-review['"]/);
  assert.ok(at > -1, 'critique-review broadcast (kind:"critique-review") must exist.');
  // Widen the search window in both directions — the field can appear
  // before or after the kind: marker depending on object-literal order.
  const before = src.slice(Math.max(0, at - 500), at);
  const after = src.slice(at, at + 1500);
  assert.ok(/specialties:/.test(before) || /specialties:/.test(after),
    'critique-review broadcast must include a `specialties` field carrying per-specialty {id, name, isError, isAgreed} so a future client can render per-section badges.');
  // Also verify the emit still fires — the broadcast must reach
  // session.emit somewhere (whether via inline literal or via a
  // captured variable).
  assert.ok(/session\.emit\s*\(\s*['"]state-update['"]/.test(src),
    "critique.js must emit a 'state-update' event (the live WS broadcast that the verdict pane subscribes to).");
});

// ── 4. Marker comments anchor future restyles ──

t('a comment naming "fr-95" appears in critique.js and all three specialty modules', () => {
  const c = _read('server/src/critique.js');
  const g = _read('server/src/critics/specialties/general.js');
  const tv = _read('server/src/critics/specialties/test-validity.js');
  const ps = _read('server/src/critics/specialties/perf-security.js');
  const reg = _read('server/src/critics/specialties/index.js');
  assert.ok(/fr-95/.test(c), 'critique.js must carry a fr-95 marker so a future restyle knows the fan-out is intentional.');
  assert.ok(/fr-95/.test(g), 'general.js must carry a fr-95 marker.');
  assert.ok(/fr-95/.test(tv), 'test-validity.js must carry a fr-95 marker.');
  assert.ok(/fr-95/.test(ps), 'perf-security.js must carry a fr-95 marker.');
  assert.ok(/fr-95/.test(reg), 'specialties/index.js must carry a fr-95 marker.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
