// Two root-cause fixes that produced false-positive critique loops
// repeatedly in the 2026-06-03 session:
//
//   1. CRITIC TRUNCATION — server/src/critics/gemini.js capped
//      maxOutputTokens at 1024. On a 53k-char diff the model's
//      preamble ("Overall Assessment: …") consumed the whole budget
//      and the verdict line (✓ AGREED / flagged-issues) was NEVER
//      written. Three times in one session, fr-94 Phase 2 + bug-51
//      + fr-81 Phase A critiques came back as truncated preambles
//      that LOOKED like flagged issues but were just unfinished
//      buffers. Fix: raise to 8192 + env override
//      MYCO_CRITIC_MAX_TOKENS + 4096 floor.
//
//   2. DISPATCH-LABEL DRIFT — server/src/attach.js's critique gate
//      fed `listChangedFiles(rec.absCwd)` to Gemini, which returns
//      ALL uncommitted changes including pre-existing WIP. When a
//      `[run:plan#X]` dispatch fired on an already-done plan item
//      (e.g. bug-51 already shipped) while UNRELATED WIP sat in
//      the working tree (e.g. fr-81 Phase A uncommitted), the
//      critique attached the WIP to the wrong label and Gemini
//      reported a mismatch — a fake "issues flagged" notice. Fix:
//      snapshot dirty paths + HEAD when the run starts, filter the
//      critique diff to changes-since-baseline only, skip critique
//      entirely when the filtered diff is empty.
//
// Test shape: static-grep guards (both files are small + the contract
// is structural).

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

console.log('── critic truncation + dispatch-label-drift (2026-06-03 root-cause fixes) ──');

// ── 1. Critic truncation ──

t('server/src/critics/gemini.js: maxOutputTokens is at least 4096 (was 1024 — the source of the truncation bug)', () => {
  const src = _read('server/src/critics/gemini.js');
  // Locate the CRITIC_SAMPLING block or the CRITIC_MAX_OUTPUT_TOKENS
  // constant — the fix uses a named constant so a test can grep it.
  assert.ok(/CRITIC_MAX_OUTPUT_TOKENS/.test(src),
    'critics/gemini.js must declare CRITIC_MAX_OUTPUT_TOKENS as a named constant (the fix pulls the cap out of the inline object literal so tests can grep + ops can override).');
  // Extract the numeric default (the right-hand side of the constant
  // declaration). Accept either `|| 8192`, `|| 4096` etc., or a bare
  // literal. The floor enforcement is asserted separately below.
  const m = src.match(/CRITIC_MAX_OUTPUT_TOKENS\s*=\s*([^;]+);/);
  assert.ok(m, 'must be able to extract the CRITIC_MAX_OUTPUT_TOKENS expression.');
  const numbers = (m[1].match(/\d{4,}/g) || []).map((s) => parseInt(s, 10));
  const maxLiteral = numbers.length ? Math.max(...numbers) : 0;
  assert.ok(maxLiteral >= 4096,
    `CRITIC_MAX_OUTPUT_TOKENS default must be >= 4096 to fit a verdict on a 40k+ char diff; got literals ${JSON.stringify(numbers)} from ${m[1].trim()}.`);
});

t('server/src/critics/gemini.js: floor enforcement so a low env override cannot regress to truncation', () => {
  const src = _read('server/src/critics/gemini.js');
  // The Math.max(4096, …) guard prevents an operator from
  // accidentally setting MYCO_CRITIC_MAX_TOKENS=512 + reintroducing
  // the truncation failure mode.
  assert.ok(/Math\.max\s*\(\s*4096/.test(src),
    'critics/gemini.js must floor the effective max-output-tokens with Math.max(4096, …) so a misconfigured env override cannot regress the truncation bug.');
});

t('server/src/critics/gemini.js: env override MYCO_CRITIC_MAX_TOKENS lets ops bump higher without a code change', () => {
  const src = _read('server/src/critics/gemini.js');
  assert.ok(/process\.env\.MYCO_CRITIC_MAX_TOKENS/.test(src),
    'critics/gemini.js must read process.env.MYCO_CRITIC_MAX_TOKENS so ops can raise the cap further without re-deploying.');
});

// ── 2. Dispatch-label drift — snapshot at run start ──

t('server/src/attach.js: _snapshotRunBaseline helper exists and captures dirty paths + HEAD via execFileSync', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/function\s+_snapshotRunBaseline\s*\(/.test(src),
    '_snapshotRunBaseline must be defined (dispatch-drift fix — captures baseline state at run-start).');
  const at = src.search(/function\s+_snapshotRunBaseline\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/execFileSync/.test(body),
    '_snapshotRunBaseline must use execFileSync — sync because it runs on the chat-message hot path and async would race the upcoming turn_result.');
  assert.ok(/git[\s\S]{0,80}rev-parse/.test(body),
    '_snapshotRunBaseline must capture the HEAD SHA via `git rev-parse HEAD`.');
  assert.ok(/status[\s\S]{0,80}--porcelain/.test(body),
    '_snapshotRunBaseline must capture dirty paths via `git status --porcelain` (the snapshot we filter against at critique time).');
  // Defensive: each git invocation must have a timeout so a hung
  // repo (e.g. corrupt index) cannot freeze the chat path forever.
  assert.ok(/timeout\s*:\s*\d/.test(body),
    '_snapshotRunBaseline must pass a timeout to execFileSync (the snapshot is on the chat-message hot path — a hung git cannot block it).');
});

t('server/src/attach.js: the [run:…#id] handler attaches baselineDirty + baselineHead to session._activeRunItem', () => {
  const src = _read('server/src/attach.js');
  // The [run:…#id] regex match handler is where the run is dispatched.
  const at = src.search(/text\.match\(\s*\/\\\[run:/);
  assert.ok(at > -1, 'the [run:…#id] regex matcher in attach.js must exist (dispatch entry point).');
  const body = src.slice(at, at + 2000);
  assert.ok(/_snapshotRunBaseline\s*\(/.test(body),
    'the [run:…#id] handler must call _snapshotRunBaseline before stashing _activeRunItem (dispatch-drift fix — baseline captured BEFORE the run is allowed to mutate the tree).');
  assert.ok(/baselineDirty\s*:/.test(body),
    'session._activeRunItem must carry baselineDirty so the critique gate can filter pre-existing WIP.');
  assert.ok(/baselineHead\s*:/.test(body),
    'session._activeRunItem must carry baselineHead so the critique gate can log the baseline SHA on skip (useful for diagnosing future drift).');
});

// ── 2b. Dispatch-label drift — critique-time filter ──

t('server/src/attach.js: critique gate filters changedInfo.entries against baselineDirty', () => {
  const src = _read('server/src/attach.js');
  // The critique gate is the (async () => { … })() block inside the
  // turn_result handler. Search for the listChangedFiles call inside
  // attach.js — there's only one site.
  const at = src.search(/listChangedFiles\s*\(\s*rec\.absCwd\s*\)/);
  assert.ok(at > -1, 'listChangedFiles(rec.absCwd) call in the critique gate must exist.');
  const body = src.slice(at, at + 3000);
  assert.ok(/baselineDirty/.test(body),
    'the critique gate must reference baselineDirty when computing the filtered diff (dispatch-drift fix).');
  assert.ok(/\.filter\s*\(/.test(body),
    'the critique gate must apply a .filter on changedInfo.entries to exclude pre-existing WIP paths.');
});

t('server/src/attach.js: critique gate SKIPS the Gemini call when the filtered diff is empty', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/listChangedFiles\s*\(\s*rec\.absCwd\s*\)/);
  const body = src.slice(at, at + 3000);
  // The empty-filtered-diff branch logs the skip reason + does NOT
  // call triggerGeminiCritique. Static-grep that triggerGeminiCritique
  // is gated INSIDE a non-empty-newEntries block.
  assert.ok(/newEntries\.length\s*===\s*0[\s\S]{0,400}Skipping critique/i.test(body),
    'the critique gate must explicitly skip the Gemini invocation when the filtered diff is empty (dispatch-drift fix — fixes the false-positive "Gemini flagged issues" loops on already-done plan-item dispatches).');
});

// ── marker comment ──

t('a comment naming "Dispatch-label-drift fix" + "2026-06-03" appears in attach.js (so a future restyle understands the snapshot model)', () => {
  const src = _read('server/src/attach.js');
  assert.ok(/Dispatch-label-drift fix.*2026-06-03|2026-06-03.*Dispatch-label-drift fix/i.test(src),
    'a comment naming the dispatch-label-drift fix + the date 2026-06-03 must appear so a future restyle understands why the [run:…#id] handler suddenly grew a git snapshot side effect.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
