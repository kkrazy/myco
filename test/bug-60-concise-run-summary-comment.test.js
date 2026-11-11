// bug-60 regression: the run-summary comment auto-posted to a plan
// item after a `[run:plan#X]` dispatch must be a SINGLE LINE — not
// the verbose multi-paragraph paste of outcome.result that pre-fix
// landed in item.comments[] (a4330fe and later).
//
// User report (2026-06-06):
//   "Result text appended to completed plan items is too long,
//    cluttering the plan view.
//    Expected: A concise one-line summary of how the item was fixed.
//    Actual: Verbose multi-paragraph output is appended to each plan item."
//
// Concrete data from this repo's _myco_/plan.json at report time:
// 105 run-summary comments, median 842 chars, top entries ~5,000
// chars / 30–67 lines. Plan view turned into a wall of text.
//
// Fix in attach.js:
//   · new _extractRunOutcomeSummaryLine(rawText) helper — first
//     non-empty line, strips leading markdown / glyph prefixes,
//     collapses whitespace, caps at 140 chars with `…` suffix.
//   · _stampPlanItemRunOutcome no longer composes the
//     `${headerBits}\n\n${resultBody}` two-paragraph block. It now
//     builds a single-line summary:
//       `${glyph} ${oneLineSummary} · ${durS} · ${costStr} · ${tokIn}↓/${tokOut}↑`
//   · item.runs[last].result still preserves up to 2000 chars of the
//     full text for drill-down — only the comment body shrinks.
//
// Test shape: static guards on attach.js + helper unit asserts +
// end-to-end _stampPlanItemRunOutcome call asserting the resulting
// comment is one line and ≤200 chars. Sub-second, framework-standard,
// runnable as `node test/bug-60-concise-run-summary-comment.test.js`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-60: run-summary comment must be a single line ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards on attach.js's new shape. Lock the fix
// so a future refactor can't silently re-bloat the comment body.
// ─────────────────────────────────────────────────────────────────

const ATTACH_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

t('helper _extractRunOutcomeSummaryLine is defined in attach.js', () => {
  assert.ok(/function\s+_extractRunOutcomeSummaryLine\s*\(\s*rawText\s*\)/.test(ATTACH_JS),
    'helper function _extractRunOutcomeSummaryLine(rawText) must exist in attach.js');
});

t('_stampPlanItemRunOutcome calls the helper and uses a single-line summaryText', () => {
  const m = ATTACH_JS.match(/function\s+_stampPlanItemRunOutcome\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '_stampPlanItemRunOutcome must be a top-level function declaration');
  const body = m[1];
  assert.ok(/_extractRunOutcomeSummaryLine\s*\(/.test(body),
    '_stampPlanItemRunOutcome must call _extractRunOutcomeSummaryLine to compute the concise summary');
  // Pre-fix double-newline template MUST be gone.
  assert.ok(!/\$\{headerBits\}\\n\\n\$\{resultBody\}/.test(body),
    'pre-fix `${headerBits}\\n\\n${resultBody}` template must be gone — that was the verbose multi-paragraph shape');
  // Pre-fix resultBody variable MUST be gone (it was the 800-char-
  // truncated paste of outcome.result).
  assert.ok(!/const\s+resultBody\s*=/.test(body),
    'pre-fix `resultBody` variable (800-char-truncated paste) must be gone');
});

t('attach.js exports _extractRunOutcomeSummaryLine + _stampPlanItemRunOutcome for testability', () => {
  // Match the export line. Just grep — the export block is a single
  // object literal so a token-presence check is enough.
  assert.ok(/_extractRunOutcomeSummaryLine\b/.test(ATTACH_JS.slice(ATTACH_JS.lastIndexOf('module.exports'))),
    'module.exports must include _extractRunOutcomeSummaryLine so the helper is unit-testable');
  assert.ok(/_stampPlanItemRunOutcome\b/.test(ATTACH_JS.slice(ATTACH_JS.lastIndexOf('module.exports'))),
    'module.exports must include _stampPlanItemRunOutcome so end-to-end assertions can call it');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Helper unit asserts. Set up env BEFORE requiring attach
// so sessions.js's module-load WORKSPACE/STATE_DIR reads pick up
// our tempdir.
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug60-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

// Drop any prior cached require of attach + transitive deps so the
// env overrides take effect on this fresh require.
for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|attach|agent-session|menu|btw|transcript|artifacts)\.js$/.test(k)) {
    delete require.cache[k];
  }
}
const attach = require('../server/src/attach');
const extract = attach._extractRunOutcomeSummaryLine;
const stamp = attach._stampPlanItemRunOutcome;
const sessions = require('../server/src/sessions');

t('helper is exported as a function', () => {
  assert.strictEqual(typeof extract, 'function',
    'attach._extractRunOutcomeSummaryLine must be exported as a function for unit-testability');
});

t('helper: short single-line input passes through (trimmed)', () => {
  assert.strictEqual(
    extract('Fixed clone-pending race by guarding findProjectRoot.'),
    'Fixed clone-pending race by guarding findProjectRoot.');
  // Trims surrounding whitespace.
  assert.strictEqual(extract('  hello world  '), 'hello world');
});

t('helper: multi-paragraph input → first non-empty line only', () => {
  const input = 'Done.\n\nDetails:\n- Changed file A\n- Updated test B\n\nMore prose follows...';
  assert.strictEqual(extract(input), 'Done.');
  // Skips initial blank lines.
  assert.strictEqual(extract('\n\n   \n\nfirst real line\n\nthen more'), 'first real line');
});

t('helper: leading markdown / glyph prefixes are stripped', () => {
  // Real shapes from existing plan.json data — strip leading
  // heading + bullet + bold + check-mark glyph chains.
  assert.ok(!extract('# Heading').startsWith('#'), 'leading `# ` stripped');
  assert.ok(!extract('## Heading').startsWith('#'), 'leading `## ` stripped');
  assert.ok(!extract('- bullet').startsWith('-'), 'leading `- ` stripped');
  assert.ok(!extract('* bullet').startsWith('*'), 'leading `* ` stripped');
  assert.ok(!extract('> quoted').startsWith('>'), 'leading `> ` stripped');
  assert.ok(!extract('✅ done').startsWith('✅'), 'leading ✅ glyph stripped');
  assert.ok(!extract('❌ failed').startsWith('❌'), 'leading ❌ glyph stripped');
  // Stacked prefixes from the real top-5 entries.
  const out = extract('## ✅ **Shipped** in commit `abc123`');
  assert.ok(!out.startsWith('#') && !out.startsWith('✅') && !out.startsWith('*'),
    'stacked `## ✅ **` prefix must be stripped — produced: ' + JSON.stringify(out));
  assert.ok(out.includes('Shipped'), 'meaningful tail must survive — produced: ' + JSON.stringify(out));
});

t('helper: long line is truncated to ≤140 chars with `…` suffix', () => {
  const long = 'fixed thing '.repeat(50); // ~600 chars
  const out = extract(long);
  assert.ok(out.length <= 140, `output must be ≤140 chars (got ${out.length})`);
  assert.ok(out.endsWith('…'), 'truncated output must end with `…`');
});

t('helper: empty / null / whitespace input → placeholder, never throws', () => {
  assert.match(extract(null), /no summary/i);
  assert.match(extract(undefined), /no summary/i);
  assert.match(extract(''), /no summary/i);
  assert.match(extract('   \n\n\t  '), /no summary/i);
  // Non-string input (safety): coerces, doesn't crash.
  assert.doesNotThrow(() => extract(12345));
  assert.doesNotThrow(() => extract({}));
});

t('helper: internal whitespace runs collapsed to single space', () => {
  assert.strictEqual(extract('hello\t\tworld    foo'), 'hello world foo');
});

// ─────────────────────────────────────────────────────────────────
// PART C — End-to-end: _stampPlanItemRunOutcome must post a comment
// whose text is a SINGLE LINE and total ≤200 chars when the result
// is verbose. This is the assertion that catches the user's bug
// directly.
// ─────────────────────────────────────────────────────────────────

function withRec(id, item, work) {
  const rec = {
    id,
    user: 'tester',
    cwd: id,
    absCwd: path.join(process.env.MYCO_WORKSPACE, 'tester', id),
    artifacts: { plan: { items: [item] } },
  };
  fs.mkdirSync(rec.absCwd, { recursive: true });
  const store = sessions.loadStore();
  store.sessions[id] = rec;
  sessions.saveStore();
  try { work(rec); }
  finally { delete store.sessions[id]; sessions.saveStore(); }
}

t('end-to-end: verbose multi-paragraph result → single-line comment ≤200 chars', () => {
  const item = { id: 'p1', text: 'Fix the thing', runs: [], comments: [] };
  withRec('myco-tester-cafef00d', item, (rec) => {
    const verboseResult = [
      '## ✅ **Shipped** in commit `abc123def456` — fix(bug-X): the thing is fixed now and the chat pane',
      '',
      'Details:',
      '- Changed file A.js (added the guard at line 42, removed the dead branch at lines 80-95).',
      '- Updated test B.js to cover the new edge case where the helper returns null during pending.',
      '- Re-ran full ./test/test.sh — 717 passed, 0 failed, 2 skipped (docker-environmental).',
      '',
      '### Notes for reviewer',
      'The fix uses option (a) from the analyze stage — first-line strategy.',
      'Tested on mycobeta deployment, no regressions observed.',
    ].join('\n');
    stamp('myco-tester-cafef00d', 'p1', {
      subtype: 'success',
      result: verboseResult,
      durationMs: 6400,
      totalCostUsd: 0.0312,
      usage: { input_tokens: 1234, output_tokens: 567 },
    }, new Date().toISOString());
    const updated = sessions.getSessionRecord('myco-tester-cafef00d');
    const planItem = updated.artifacts.plan.items[0];
    const comment = planItem.comments[planItem.comments.length - 1];
    assert.ok(comment, 'a comment must have been appended');
    assert.strictEqual(comment.meta && comment.meta.kind, 'run-summary',
      'comment must be tagged meta.kind=run-summary');
    // The actual user-reported pain: lines + total length.
    const lines = comment.text.split(/\r?\n/).length;
    assert.strictEqual(lines, 1,
      `comment.text must be EXACTLY ONE line (got ${lines} lines): ${JSON.stringify(comment.text)}`);
    assert.ok(comment.text.length <= 200,
      `comment.text must be ≤200 chars (got ${comment.text.length}): ${JSON.stringify(comment.text)}`);
    // The first informative line "Shipped in commit..." should survive
    // in some form — assert a substring witness so a future refactor
    // that drops content entirely fails loudly.
    assert.ok(/Shipped/i.test(comment.text),
      'first-line content witness — "Shipped" from the input must survive into the summary: ' + JSON.stringify(comment.text));
    // Metrics tail still present.
    assert.ok(/6\.4s/.test(comment.text), 'duration must be in the tail');
    assert.ok(/\$0\.0312/.test(comment.text), 'cost must be in the tail');
  });
});

t('end-to-end: outcome.runs[last].result still preserves the FULL text (≤2000) for drill-down', () => {
  const item = { id: 'p2', text: 'Another fix', runs: [], comments: [] };
  withRec('myco-tester-deadc0de', item, (rec) => {
    const verboseResult = 'A'.repeat(1500) + '\nB'.repeat(400);
    stamp('myco-tester-deadc0de', 'p2', {
      subtype: 'success',
      result: verboseResult,
      durationMs: 1000,
      usage: { input_tokens: 10, output_tokens: 20 },
    }, new Date().toISOString());
    const updated = sessions.getSessionRecord('myco-tester-deadc0de');
    const planItem = updated.artifacts.plan.items[0];
    const lastRun = planItem.runs[planItem.runs.length - 1];
    assert.ok(lastRun, 'a run record must have been appended');
    // The run-record's result field is the drill-down. It KEEPS the
    // full text (capped at 2000 chars, unchanged from pre-bug-60).
    // This is the contract the comment-trim should NOT touch.
    assert.ok(lastRun.result && lastRun.result.length > 200,
      `runs[last].result must still hold the full result text (>200 chars), not the trimmed comment shape. Got len=${lastRun.result && lastRun.result.length}`);
    assert.ok(lastRun.result.length <= 2000,
      'runs[last].result is capped at 2000 chars — drill-down ceiling unchanged');
  });
});

t('end-to-end: error / no-result case still posts a comment (placeholder body)', () => {
  const item = { id: 'p3', text: 'Failing run', runs: [], comments: [] };
  withRec('myco-tester-11223344', item, (rec) => {
    stamp('myco-tester-11223344', 'p3', {
      subtype: 'error',
      result: null,
      durationMs: 500,
      usage: { input_tokens: 5, output_tokens: 0 },
    }, new Date().toISOString());
    const updated = sessions.getSessionRecord('myco-tester-11223344');
    const planItem = updated.artifacts.plan.items[0];
    const comment = planItem.comments[planItem.comments.length - 1];
    assert.ok(comment, 'a comment must be appended even on error / null result');
    // Still single-line.
    assert.strictEqual(comment.text.split(/\r?\n/).length, 1,
      'error/no-result comment must still be single-line: ' + JSON.stringify(comment.text));
    // ⚠ glyph signals error.
    assert.ok(/^⚠\s/.test(comment.text),
      'error comment must lead with ⚠ glyph: ' + JSON.stringify(comment.text));
  });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
