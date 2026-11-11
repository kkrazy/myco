// bug-65: critic verdicts are generic QA review, not problem-solving
// validation against the plan-item.
//
// User-reported (verbatim): "the verdict must criticize if the
// proposed solution actually solves the fr/td/bug we are working on.
// right now it's just a general review of the diff, the analyze
// result and whether it solves the problem of the fr/td/bug should
// be our focus."
//
// User also asked: (a) analyze stage must consider item.comments
// not just item.text; (b) code stage must verify the diff matches
// the analyze plan; (c) prompts must be extracted to independent
// files for easy review.
//
// Fix: three paired changes.
//
// (1) PROMPT EXTRACTION: new server/src/critics/prompts/ directory
//     with base.md + stage-{analyze,code,verify,final}.md + index.js
//     loader. Specialty prompts also extracted to sibling .md files
//     (general.md, test-validity.md, perf-security.md) loaded by the
//     specialty .js shims via fs.readFileSync.
//
// (2) PROMPT CONTENT REWRITE: basePrompt reframed from "elite QA
//     auditor" (generic) to "plan-item-driven problem-solving
//     validator" — PRIMARY criterion is now does-it-solve-the-
//     problem. Stage-aware addenda tell the critic what to focus on
//     per stage:
//       · analyze: evaluate the PLAN against the problem +
//         comments; no diff to review; don't demand a test
//       · code: FIRST check diff matches analyze plan (in history),
//         THEN check it solves problem; would the test red-flip
//         against pre-fix code?
//       · verify: confirm regression net complete; test wired to
//         test.sh; would catch future re-introduction
//       · final: full-run verdict gating queue
//
// (3) USERPROMPT RESTRUCTURE: problem leads. New _buildProblemBlock
//     combines item.text + item.comments at the top. The td-33 r2
//     historyBlock moved comments OUT (they're problem-context, not
//     "what's been tried") and bumped per-run summary cap 800→2000
//     so the analyze plan fits in the previous-stage history entry
//     the code-stage critic reads.
//
// Test shape: structure + content locks on the new prompt files +
// the critique.js wiring.

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

console.log('── bug-65: problem-solving-focused critic prompts (extracted to .md files) ──');

// ── 1. Prompt extraction — directory + files exist ──

t('server/src/critics/prompts/ directory exists with the 5 .md files + index.js loader', () => {
  const promptsDir = path.join(__dirname, '..', 'server', 'src', 'critics', 'prompts');
  assert.ok(fs.existsSync(promptsDir), 'prompts/ directory must exist.');
  for (const name of ['base.md', 'stage-analyze.md', 'stage-code.md', 'stage-verify.md', 'stage-final.md', 'index.js']) {
    assert.ok(fs.existsSync(path.join(promptsDir, name)),
      `prompts/${name} must exist — bug-65 extraction.`);
  }
});

t('server/src/critics/prompts/index.js exports base + stageAnalyze + stageCode + stageVerify + stageFinal', () => {
  const prompts = require('../server/src/critics/prompts');
  assert.ok(typeof prompts.base === 'string' && prompts.base.length > 100,
    'prompts.base must be a non-empty string loaded from base.md.');
  assert.ok(typeof prompts.stageAnalyze === 'string' && prompts.stageAnalyze.length > 100,
    'prompts.stageAnalyze must be loaded from stage-analyze.md.');
  assert.ok(typeof prompts.stageCode === 'string' && prompts.stageCode.length > 100,
    'prompts.stageCode must be loaded from stage-code.md.');
  assert.ok(typeof prompts.stageVerify === 'string' && prompts.stageVerify.length > 100,
    'prompts.stageVerify must be loaded from stage-verify.md.');
  assert.ok(typeof prompts.stageFinal === 'string' && prompts.stageFinal.length > 100,
    'prompts.stageFinal must be loaded from stage-final.md.');
});

// ── 2. Specialty extraction ──

t('server/src/critics/specialties/{general,test-validity,perf-security}.md sibling files exist', () => {
  for (const name of ['general.md', 'test-validity.md', 'perf-security.md']) {
    const p = path.join(__dirname, '..', 'server', 'src', 'critics', 'specialties', name);
    assert.ok(fs.existsSync(p),
      `specialties/${name} must exist — bug-65 extraction of inline systemSuffix.`);
  }
});

t('specialty .js files load their systemSuffix from .md siblings via fs.readFileSync', () => {
  for (const name of ['general.js', 'test-validity.js', 'perf-security.js']) {
    const src = _read(`server/src/critics/specialties/${name}`);
    assert.ok(/require\s*\(\s*['"]fs['"]\s*\)/.test(src),
      `specialties/${name} must require('fs') (bug-65 — loads .md sibling).`);
    // The actual call is fs.readFileSync(path.join(__dirname, 'X.md'), 'utf8')
    // where path.join has its own parens. Multiline match: readFileSync
    // call followed by the corresponding .md sibling name in the same
    // statement. Just check both bits are present in proximity.
    const mdName = name.replace(/\.js$/, '.md');
    assert.ok(/readFileSync/.test(src),
      `specialties/${name} must call fs.readFileSync (loads sibling .md).`);
    assert.ok(new RegExp(mdName).test(src),
      `specialties/${name} must reference '${mdName}' (its sibling .md file) in the readFileSync call.`);
  }
});

t('specialty exports still match the {id, name, systemSuffix} shape after extraction', () => {
  const g = require('../server/src/critics/specialties/general');
  const tv = require('../server/src/critics/specialties/test-validity');
  const ps = require('../server/src/critics/specialties/perf-security');
  for (const [label, mod] of [['general', g], ['test-validity', tv], ['perf-security', ps]]) {
    assert.strictEqual(typeof mod.id, 'string', `${label}.id must be a string.`);
    assert.strictEqual(typeof mod.name, 'string', `${label}.name must be a string.`);
    assert.ok(typeof mod.systemSuffix === 'string' && mod.systemSuffix.length > 100,
      `${label}.systemSuffix must be a non-empty string (loaded from sibling .md).`);
  }
});

// ── 3. base.md content — problem-solving framing ──

t('base.md frames the critic as a "plan-item-driven problem-solving validator" (NOT generic QA auditor)', () => {
  const md = _read('server/src/critics/prompts/base.md');
  // The new framing must elevate the user-reported problem as the
  // PRIMARY criterion. Look for the key phrases.
  assert.ok(/PRIMARY/i.test(md) && /problem/i.test(md),
    'base.md must elevate "PRIMARY" + "problem" as the framing — does claude\'s work solve the user-reported problem? (bug-65).');
  // The old "elite, independent QA and security auditor" framing
  // must be GONE — that's the generic-review framing bug-65
  // explicitly replaces.
  assert.ok(!/elite,\s*independent\s+QA\s+and\s+security\s+auditor/i.test(md),
    'base.md must NOT use the pre-bug-65 "elite, independent QA and security auditor" framing — that\'s the generic-review framing the user complained about.');
});

t('base.md instructs the critic to use both ✓ AGREED and ✗ DISAGREE sentinels', () => {
  const md = _read('server/src/critics/prompts/base.md');
  assert.ok(/✓\s*AGREED/.test(md),
    'base.md must document the ✓ AGREED sentinel (detection regex relies on it).');
  assert.ok(/✗\s*DISAGREE/.test(md),
    'base.md must document the ✗ DISAGREE sentinel (bug-65 adds explicit disagree marker for unambiguous parsing; preserves bug-52 reasoning-required contract).');
});

// ── 4. Stage-specific addenda content ──

t('stage-analyze.md: no diff yet — evaluate the PLAN against the problem + comments', () => {
  const md = _read('server/src/critics/prompts/stage-analyze.md');
  // Must explicitly tell the critic the diff is empty and to
  // evaluate the PLAN.
  assert.ok(/no\s+diff|ZERO\s+source|empty/i.test(md),
    'stage-analyze.md must tell the critic there is no diff yet (per §9 ZERO source edits during analyze).');
  assert.ok(/[Pp]lan/.test(md),
    'stage-analyze.md must direct the critic to evaluate "the PLAN" (the analyze stage produces a plan, not a diff).');
  assert.ok(/comments|discussion|clarifications/i.test(md),
    'stage-analyze.md must mention plan-item comments / discussion — user-asked: "analyze stage need to consider all of the comments on the plan item".');
});

t('stage-code.md: FIRST verify diff matches analyze plan (in history), THEN check it solves problem', () => {
  const md = _read('server/src/critics/prompts/stage-code.md');
  // User-asked: "code stage need to make sure it matches the
  // analyze result."
  assert.ok(/analyze[- ]stage\s*plan|analyze\s*plan|analyze-stage/i.test(md),
    'stage-code.md must reference the "analyze plan" / "analyze-stage plan" so the critic knows to compare diff against it (user-asked: "need to make sure it matches the analyze result").');
  assert.ok(/PLAN ITEM HISTORY|recent\s+entry|previous\s+(stage|run)/i.test(md),
    'stage-code.md must tell the critic WHERE to find the analyze plan (the most recent entry in PLAN ITEM HISTORY = analyze-stage run summary).');
  // Must also still check problem-solving.
  assert.ok(/red[- ]flipped|red\s*flip|pre-fix|user-reported/i.test(md),
    'stage-code.md must require the critic to check whether the new test would have red-flipped against pre-fix code AND covers the user-reported failure mode.');
});

t('stage-verify.md: confirm regression net complete + test.sh wiring + future-proof', () => {
  const md = _read('server/src/critics/prompts/stage-verify.md');
  assert.ok(/test\.sh/.test(md),
    'stage-verify.md must require the critic to confirm the new test is wired into test.sh (§9 verify done-criteria).');
  assert.ok(/regression|future|catch.*next|re-broke|re-introduc/i.test(md),
    'stage-verify.md must require the critic to mentally simulate a future regression — would the test red-flip on a re-introduction?');
});

t('stage-final.md: full-run verdict that gates the queue', () => {
  const md = _read('server/src/critics/prompts/stage-final.md');
  assert.ok(/gate|queue|accept|discard/i.test(md),
    'stage-final.md must explain that this verdict gates the queue (final critique on turn_result success).');
});

// ── 5. critique.js wiring — loader + structure ──

t('critique.js uses the criticPrompts loader (NOT inline basePrompt template)', () => {
  const src = _read('server/src/critique.js');
  // Must require the prompts module.
  assert.ok(/require\s*\(\s*['"]\.\/critics\/prompts['"]\s*\)/.test(src),
    'critique.js must require("./critics/prompts") — the loader for the extracted .md files.');
  // Must assign basePrompt FROM the loader.
  assert.ok(/basePrompt\s*=\s*criticPrompts\.base/.test(src),
    'critique.js must assign basePrompt from criticPrompts.base (loaded from base.md) — not an inline template string.');
  // The pre-bug-65 inline "elite, independent QA and security
  // auditor" template-string assignment must be GONE.
  assert.ok(!/basePrompt\s*=\s*`You are an elite, independent QA and security auditor/.test(src),
    'critique.js must NOT contain the pre-bug-65 inline basePrompt template string (it was extracted to base.md).');
});

t('critique.js builds stageAddendum based on stage value', () => {
  const src = _read('server/src/critique.js');
  // Must reference all 4 stage prompts.
  assert.ok(/criticPrompts\.stageAnalyze/.test(src),
    'critique.js must reference criticPrompts.stageAnalyze for analyze-stage critique.');
  assert.ok(/criticPrompts\.stageCode/.test(src),
    'critique.js must reference criticPrompts.stageCode for code-stage critique.');
  assert.ok(/criticPrompts\.stageVerify/.test(src),
    'critique.js must reference criticPrompts.stageVerify for verify-stage critique.');
  assert.ok(/criticPrompts\.stageFinal/.test(src),
    'critique.js must reference criticPrompts.stageFinal for the final (non-intermediate) critique.');
});

// ── 6. _buildProblemBlock + _buildHistoryBlock split ──

t('critique.js: _buildProblemBlock(item) helper exists + combines item.text + item.comments', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/function\s+_buildProblemBlock\s*\(\s*item\s*\)/.test(src),
    'critique.js must define _buildProblemBlock(item) — bug-65 helper that builds the USER-REPORTED PROBLEM block.');
  const at = src.search(/function\s+_buildProblemBlock\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/item\.text/.test(body),
    '_buildProblemBlock must read item.text (the original plan-item description).');
  assert.ok(/item\.comments/.test(body),
    '_buildProblemBlock must read item.comments (user discussion + clarifications — user-asked: "consider all of the comments on the plan item").');
  assert.ok(/USER-REPORTED PROBLEM/.test(body),
    '_buildProblemBlock must emit a "USER-REPORTED PROBLEM" header so the critic finds the criterion easily.');
});

t('critique.js: _buildHistoryBlock no longer includes item.comments (moved to _buildProblemBlock)', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+_buildHistoryBlock\s*\(/);
  // Tight slice — stop at the NEXT `function` declaration so we
  // don't accidentally include _buildProblemBlock's body (which
  // legitimately references item.comments — that's where comments
  // moved TO).
  const after = src.slice(at + 30);                       // skip the declaration itself
  const nextFnAt = after.search(/\nfunction\s+/);
  let body = nextFnAt > -1
    ? src.slice(at, at + 30 + nextFnAt)
    : sliceFn(src, at);
  // Strip JS line + block comments before grepping. The body has a
  // bug-65 explanatory comment that LEGITIMATELY mentions
  // `item.comments` while documenting what was MOVED OUT. Comment
  // text shouldn't count against the no-comments-in-history
  // contract.
  body = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/item\.comments/.test(body),
    '_buildHistoryBlock body (code only, comments stripped) must NOT reference item.comments — bug-65 moved comments to _buildProblemBlock. Without this split, the comments would appear in BOTH blocks (duplicated content) or the analyze critic would miss them entirely.');
});

t('critique.js: HISTORY_RUN_SUMMARY_CAP bumped to 2000 (was 800) so analyze plans fit', () => {
  const src = _read('server/src/critique.js');
  // bug-65 bumped the per-run summary cap from 800 to 2000 chars so
  // the analyze-stage plan fits when the code-stage critic reads it
  // via the history block.
  assert.ok(/HISTORY_RUN_SUMMARY_CAP\s*=\s*2000/.test(src),
    'critique.js must define HISTORY_RUN_SUMMARY_CAP = 2000 (bumped from 800) so the analyze-stage plan fits in the previous-stage history entry the code-stage critic reads (bug-65).');
});

// ── 7. userPrompt structure ──

t('critique.js userPrompt restructure: stageAddendum + problemBlock lead, claude/diff/context follow', () => {
  const src = _read('server/src/critique.js');
  // Find the userPrompt assignment.
  const at = src.search(/const\s+userPrompt\s*=\s*`/);
  assert.ok(at > -1, 'userPrompt assignment must exist.');
  const body = src.slice(at, at + 2000);
  // stageAddendum + problemBlock must appear in the userPrompt
  // template.
  assert.ok(/\$\{stageAddendum\}/.test(body),
    'userPrompt template must interpolate ${stageAddendum} — bug-65 stage-aware addendum precedes the problem block.');
  assert.ok(/\$\{problemBlock\}/.test(body),
    'userPrompt template must interpolate ${problemBlock} — bug-65 problem block (item.text + comments) leads as the verdict criterion.');
  // The pre-bug-65 "Task to accomplish: ${item.text}" inline form
  // must be GONE.
  assert.ok(!/Task to accomplish:\s*\$\{item\.text\}/.test(body),
    'userPrompt must NOT use the pre-bug-65 "Task to accomplish: ${item.text}" inline form — bug-65 replaced it with the structured problemBlock.');
});

// ── 8. bug-65 markers ──

t('bug-65 marker comments appear in critique.js + all new .md files', () => {
  const c = _read('server/src/critique.js');
  assert.ok(/bug-65/.test(c), 'critique.js must carry a bug-65 marker (the prompt loader wiring + helper functions).');
  for (const name of ['base.md', 'stage-analyze.md', 'stage-code.md', 'stage-verify.md', 'stage-final.md']) {
    const md = _read(`server/src/critics/prompts/${name}`);
    assert.ok(/bug-65/.test(md),
      `prompts/${name} must carry a bug-65 marker — anchors the provenance for the extraction.`);
  }
  for (const name of ['general.md', 'test-validity.md', 'perf-security.md']) {
    const md = _read(`server/src/critics/specialties/${name}`);
    assert.ok(/bug-65/.test(md),
      `specialties/${name} must carry a bug-65 marker — anchors the provenance for the systemSuffix extraction.`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
