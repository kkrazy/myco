// td-33 r2: critic context enrichment.
//
// User-reported (verbatim, plan-item comment from @kkrazy):
//   "should always make enough information is provided to the critic
//    for full assessment"
//
// Root cause: the pre-r2 prompt only contained the diff hunks. The
// surrounding file context (imports, related functions, type usages)
// was invisible to the critic — which is why Gemini repeatedly bailed
// with "INSUFFICIENT INFORMATION" on changes that would have been
// clear with full context.
//
// Fix:
//   · server/src/critique.js: two new helpers + matching caps.
//     - _buildFileContextBlock(changedEntries, recAbsCwd): reads each
//       changed file's FULL current content. 16 KB per-file cap +
//       64 KB aggregate cap to prevent prompt blowup. Truncation
//       marker when caps trip.
//     - _buildHistoryBlock(item): surfaces the plan item's recent
//       iteration history — last 3 runs (with status + summary) +
//       last 5 comments (truncated at 600 chars each). 16 KB block cap.
//   · The basePrompt is rewritten to acknowledge the new context
//     (instead of the pre-r2 "you can ONLY see the diff" language).
//   · attach.js passes opts.changedEntries through to
//     triggerGeminiCritique at BOTH invocation sites (final + stage
//     intermediate). retryLastCritique caches + forwards them too.
//
// Test shape: static-grep on the locked surface.

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

console.log('── td-33 r2: critic context enrichment (full files + plan-item history) ──');

// ── 1. Helpers + caps defined ──

t('server/src/critique.js: _buildFileContextBlock helper is defined', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/function\s+_buildFileContextBlock\s*\(/.test(src),
    '_buildFileContextBlock helper must be defined (td-33 r2 — builds the FULL FILE CONTEXT prompt block).');
});

t('server/src/critique.js: _buildHistoryBlock helper is defined', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/function\s+_buildHistoryBlock\s*\(/.test(src),
    '_buildHistoryBlock helper must be defined (td-33 r2 — builds the PLAN ITEM HISTORY prompt block).');
});

t('server/src/critique.js: prompt-budget caps are named constants with reasonable values', () => {
  const src = _read('server/src/critique.js');
  // FILE per-file cap: must be present + at least 4 KB (small enough
  // not to blow the prompt budget, big enough to fit most source files).
  const perFileMatch = src.match(/FILE_CONTEXT_MAX_PER_FILE\s*=\s*([\d_]+)/);
  assert.ok(perFileMatch, 'FILE_CONTEXT_MAX_PER_FILE must be a named constant.');
  const perFile = parseInt(perFileMatch[1].replace(/_/g, ''), 10);
  assert.ok(perFile >= 4_000 && perFile <= 64_000,
    `FILE_CONTEXT_MAX_PER_FILE must be in [4 KB, 64 KB] — got ${perFile}.`);
  // Total aggregate cap.
  const totalMatch = src.match(/FILE_CONTEXT_TOTAL_CAP\s*=\s*([\d_]+)/);
  assert.ok(totalMatch, 'FILE_CONTEXT_TOTAL_CAP must be a named constant.');
  const total = parseInt(totalMatch[1].replace(/_/g, ''), 10);
  assert.ok(total >= perFile && total <= 256_000,
    `FILE_CONTEXT_TOTAL_CAP must be >= per-file cap and <= 256 KB — got ${total}.`);
});

// ── 2. File context block — content + format ──

t('server/src/critique.js: _buildFileContextBlock reads files relative to recAbsCwd + per-file cap kicks in', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+_buildFileContextBlock\s*\(/);
  const body = sliceFn(src, at);
  assert.ok(/fs\.readFileSync\s*\(\s*path\.join\s*\(\s*recAbsCwd\s*,\s*entry\.path\s*\)/.test(body),
    '_buildFileContextBlock must read each file via fs.readFileSync(path.join(recAbsCwd, entry.path)) — the same resolution attach.js uses.');
  // The block must declare a "FULL FILE CONTEXT" header so the
  // critic can find it in the prompt.
  assert.ok(/FULL FILE CONTEXT/.test(body),
    '_buildFileContextBlock must emit a "FULL FILE CONTEXT" header so the critic prompt has a clear marker.');
  // Per-file cap enforcement — must reference the constant + slice
  // when over.
  assert.ok(/FILE_CONTEXT_MAX_PER_FILE/.test(body) && /\.slice\(/.test(body),
    '_buildFileContextBlock must enforce FILE_CONTEXT_MAX_PER_FILE via .slice() — no unbounded file reads.');
});

t('server/src/critique.js: _buildFileContextBlock returns an empty string when no entries are passed (intermediate-critique fallback)', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+_buildFileContextBlock\s*\(/);
  const body = sliceFn(src, at);
  // The first guard returns empty for non-array / empty entries.
  assert.ok(/changedEntries\s*\)\s*\|\|\s*changedEntries\.length\s*===\s*0[\s\S]{0,80}return\s*['"]['"]/.test(body) ||
            /!Array\.isArray\s*\(\s*changedEntries\s*\)[\s\S]{0,300}return\s*['"]['"]/.test(body),
    '_buildFileContextBlock must return "" when no entries are passed (so intermediate critiques without the entries plumbing fall back gracefully to pre-r2 behavior).');
});

// ── 3. History block — runs + comments ──

t('server/src/critique.js: _buildHistoryBlock reads item.runs + item.comments and includes both in the block', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+_buildHistoryBlock\s*\(/);
  // NOTE: same caveat as the HISTORY_*_MAX assertion below — the
  // runs handling lives in `_buildHistoryBlock`, the comments handling
  // is in the sibling helper right after it. Keep the 3500-char window
  // (don't migrate to sliceFn) so the `item.comments` assertion still
  // hits the sibling helper.
  const body = src.slice(at, at + 3500);
  assert.ok(/item\.runs/.test(body),
    '_buildHistoryBlock must read item.runs (td-33 r2 — most recent N for the critic to see what was tried).');
  assert.ok(/item\.comments/.test(body),
    '_buildHistoryBlock must read item.comments.');
  assert.ok(/PLAN ITEM HISTORY/.test(body),
    '_buildHistoryBlock must emit a "PLAN ITEM HISTORY" header so the critic prompt has a clear marker.');
});

t('server/src/critique.js: _buildHistoryBlock caps runs at HISTORY_RUNS_MAX (most recent first) + comments at HISTORY_COMMENTS_MAX', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+_buildHistoryBlock\s*\(/);
  // NOTE: this test deliberately scopes its body to a 3500-char window
  // that extends *past* the end of `_buildHistoryBlock` itself — the
  // runs cap lives inside that function but the comments cap is in a
  // sibling helper right after it. Do NOT migrate this site to
  // `sliceFn(...)`, which stops at the first column-0 `}` — the
  // `slice(-HISTORY_COMMENTS_MAX)` assertion below would then miss
  // its target (the comments helper).
  const body = src.slice(at, at + 3500);
  // Caps must be applied via slice with the named constants.
  assert.ok(/slice\s*\(\s*-\s*HISTORY_RUNS_MAX\s*\)/.test(body),
    '_buildHistoryBlock must take the LAST HISTORY_RUNS_MAX runs via runs.slice(-HISTORY_RUNS_MAX).');
  assert.ok(/slice\s*\(\s*-\s*HISTORY_COMMENTS_MAX\s*\)/.test(body),
    '_buildHistoryBlock must take the LAST HISTORY_COMMENTS_MAX comments via comments.slice(-HISTORY_COMMENTS_MAX).');
  // Most-recent-first ordering via .reverse().
  assert.ok(/\.reverse\s*\(\s*\)/.test(body),
    'history block must surface entries most-recent-first via .reverse() so the critic sees the LATEST context first.');
});

// ── 4. Wiring — userPrompt + attach.js + retryLastCritique ──

t('server/src/critique.js: userPrompt template includes ${fileContextBlock} and ${historyBlock}', () => {
  const src = _read('server/src/critique.js');
  // The string-literal interpolation must reference both blocks.
  assert.ok(/\$\{fileContextBlock\}/.test(src),
    'userPrompt template must interpolate ${fileContextBlock} so the FULL FILE CONTEXT lands in the critic prompt (td-33 r2).');
  assert.ok(/\$\{historyBlock\}/.test(src),
    'userPrompt template must interpolate ${historyBlock} so the PLAN ITEM HISTORY lands in the critic prompt (td-33 r2).');
});

t('server/src/critique.js: basePrompt is rewritten to acknowledge the new context (no longer says "you can ONLY see the diff")', () => {
  // bug-65 follow-up: the basePrompt content was moved out of
  // critique.js (inline template string) and into
  // server/src/critics/prompts/base.md (loaded via the
  // criticPrompts loader). The contract this test locks (basePrompt
  // mentions file-context + history) is now satisfied by base.md
  // content; check the .md file too.
  const src = _read('server/src/critique.js');
  const md = (() => { try { return _read('server/src/critics/prompts/base.md'); } catch { return ''; } })();
  const haystack = src + '\n' + md;
  assert.ok(/td-33 r2/.test(haystack),
    'basePrompt (or its provenance in critique.js) must reference "td-33 r2" so a future restyle knows the context-enrichment iteration is intentional.');
  assert.ok(/FULL CURRENT CONTENT|file context|surrounding code/i.test(haystack),
    'basePrompt (inline OR loaded from base.md) must mention the file-context input so the critic knows it has surrounding-code context to work with.');
  assert.ok(/iteration history|plan item.*history|PLAN ITEM HISTORY|history/i.test(haystack),
    'basePrompt (inline OR loaded from base.md) must mention the iteration-history input so the critic knows it has prior-run context.');
});

t('server/src/critique.js: rec._lastCritique cache stores changedEntries so retry preserves the enrichment', () => {
  const src = _read('server/src/critique.js');
  // The cache assignment must include changedEntries.
  const at = src.search(/rec\._lastCritique\s*=\s*\{/);
  assert.ok(at > -1);
  const body = src.slice(at, at + 800);
  assert.ok(/changedEntries\s*:/.test(body),
    'rec._lastCritique must cache changedEntries so retryLastCritique can re-fire with the same file context (td-33 r2).');
});

t('server/src/critique.js: retryLastCritique forwards changedEntries to triggerGeminiCritique', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/async\s+function\s+retryLastCritique\s*\(/);
  assert.ok(at > -1);
  const body = sliceFn(src, at);
  assert.ok(/changedEntries\s*:/.test(body),
    'retryLastCritique must forward changedEntries through to triggerGeminiCritique so retries get the same context (td-33 r2).');
});

t('server/src/attach.js: BOTH invocation sites (final + stage-intermediate) pass opts.changedEntries', () => {
  const src = _read('server/src/attach.js');
  // There are TWO triggerGeminiCritique calls in attach.js — one in
  // the stage-done subscriber (intermediate) and one in the
  // critique-gate IIFE (final). Both must pass changedEntries.
  // Count: changedEntries should appear in BOTH calls' opts.
  const matches = src.match(/triggerGeminiCritique\([^;]+\)/g) || [];
  let withChangedEntries = 0;
  for (const m of matches) {
    if (/changedEntries\s*:/.test(m)) withChangedEntries++;
  }
  assert.ok(withChangedEntries >= 2,
    `BOTH triggerGeminiCritique invocations in attach.js must pass opts.changedEntries — only ${withChangedEntries} of ${matches.length} do (td-33 r2).`);
});

// ── 5. Marker comment ──

t('a comment naming "td-33 r2" appears in both critique.js and attach.js', () => {
  const c = _read('server/src/critique.js');
  const a = _read('server/src/attach.js');
  assert.ok(/td-33 r2/.test(c), 'critique.js must carry a td-33 r2 marker (context-enrichment plumbing).');
  assert.ok(/td-33 r2/.test(a), 'attach.js must carry a td-33 r2 marker (changedEntries pass-through).');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
