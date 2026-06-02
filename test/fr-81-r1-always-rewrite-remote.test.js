// fr-81 r1: remote-issue path always rewrites, regardless of word
// count.
//
// User-reported (verbatim, @kkrazy comment on fr-81):
//   "the issue creation works now, but it's not rewriting it to
//    proper format before submitting the issue"
//
// State before this fix:
//   The remote-target branch in handleAddPlanItem (slashcmds.js)
//   computed `shouldRewrite = forceRewrite || wordCount >
//   PLAN_ITEM_REWRITE_WORD_THRESHOLD` — the same policy as local
//   plan items. Short remote captures (`/fr @myco Add foo` — 3
//   words, no `!`) skipped the rewrite and shipped to GitHub
//   verbatim. The local-plan-item policy was "quick captures stay
//   quick"; the user is pointing out that the trade-off flips for
//   remote (a short issue on a public bug tracker still wants
//   Problem/Expected/Actual shape).
//
// Fix: in the remote branch ONLY, set `shouldRewrite = true`
// unconditionally. The local-plan-item branch a few lines below
// keeps the threshold so local quick captures still stay quick.
//
// Test shape: static-grep guard on the remote branch of
// handleAddPlanItem.

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

console.log('── fr-81 r1: remote issues always rewrite ──');

t('server/src/slashcmds.js: remote branch passes shouldRewrite=true (not the word-count threshold) to handleRemoteIssue', () => {
  const src = _read('server/src/slashcmds.js');
  // Find the `return handleRemoteIssue(...)` call site and inspect
  // the assignment to `shouldRewrite` that precedes it.
  const callAt = src.search(/return\s+handleRemoteIssue\s*\(/);
  assert.ok(callAt > -1, 'handleRemoteIssue call must exist in slashcmds.js.');
  // Walk backwards from the call site ~1000 chars looking for the
  // `const shouldRewrite = ...` assignment that immediately precedes
  // it. Lock that it equals `true` (not the threshold expression).
  const win = src.slice(Math.max(0, callAt - 1500), callAt);
  const shouldRewriteAssign = win.match(/const\s+shouldRewrite\s*=\s*([^;\n]+);/g);
  assert.ok(shouldRewriteAssign && shouldRewriteAssign.length > 0,
    'a `const shouldRewrite = ...;` assignment must precede the handleRemoteIssue call.');
  const lastAssign = shouldRewriteAssign[shouldRewriteAssign.length - 1];
  // The value must be a bare `true` literal — not the threshold
  // expression (which would be `forceRewrite || wordCount > …`).
  assert.ok(/=\s*true\s*;/.test(lastAssign),
    `the shouldRewrite assignment immediately before handleRemoteIssue must be \`true\` (fr-81 r1 — @kkrazy reported short captures weren't being rewritten on the remote). Got: ${lastAssign}`);
  assert.ok(!/wordCount\s*>/.test(lastAssign),
    `the remote shouldRewrite must NOT use the word-count threshold anymore (the threshold is the LOCAL-only policy; remote always rewrites). Got: ${lastAssign}`);
});

t('server/src/slashcmds.js: LOCAL plan-item branch still uses the word-count threshold (fr-81 r1 did not regress quick captures)', () => {
  const src = _read('server/src/slashcmds.js');
  // After the remote branch returns, the local branch computes
  // shouldRewrite again. That assignment must STILL use the
  // threshold so quick local captures stay quick.
  const callAt = src.search(/return\s+handleRemoteIssue\s*\(/);
  assert.ok(callAt > -1, 'handleRemoteIssue call must exist.');
  // Look AFTER the return for the next const shouldRewrite assignment.
  const after = src.slice(callAt, callAt + 4000);
  const localAssign = after.match(/const\s+shouldRewrite\s*=\s*([^;\n]+);/);
  assert.ok(localAssign,
    'the local-path shouldRewrite assignment must still exist after the handleRemoteIssue branch returns.');
  assert.ok(/wordCount\s*>/.test(localAssign[0]) || /PLAN_ITEM_REWRITE_WORD_THRESHOLD/.test(localAssign[0]),
    `the LOCAL-branch shouldRewrite must still use the word-count threshold (or PLAN_ITEM_REWRITE_WORD_THRESHOLD constant) so quick captures stay quick locally. fr-81 r1 only flips the REMOTE branch. Got: ${localAssign[0]}`);
});

t('a comment naming fr-81 r1 explains the always-rewrite-remote intent', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/fr-81/i.test(src),
    'a comment naming fr-81 (the dispatch this r1 is responding to) must appear in slashcmds.js so a future restyle understands why the remote-branch shouldRewrite is unconditional.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
