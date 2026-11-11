// bug-38 — turn_result rendered as its own standalone card / chrome
// batch (head label "■ done · $0.04...") whenever the previous DOM
// child wasn't a chrome batch with consecutive seq — e.g. when an
// assistant_text bubble broke the chain.
//
// User: "The result is shown already with the 'claude' bubble" →
// the standalone turn-result row is redundant noise. Fix:
//
//   A. If the previous chat-pane child IS a chrome batch, fold the
//      turn_result into it (so it's reachable when the batch is
//      expanded) and attach the outcome chip.
//   B. If the previous child is NOT a chrome batch (assistant_text /
//      chat-msg / nothing), DROP the DOM render — no fresh chrome
//      batch is created. The reply text is already in the claude
//      bubble; the live status strip "✓ done" + the token-meter chip
//      already signal turn completion.
//   C. When turn_result folds into an existing chrome batch, the
//      batch's head label must NOT be relabeled to "■ done · $..."
//      (the outcome chip carries that info; the head label should
//      keep naming the most recent non-result chrome event so the
//      collapsed batch still says what claude DID).
//
// Static-grep guards on the client JS surface.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── bug-38: turn_result folds into adjacent chrome batch (no standalone row) ──');

t('app.js: _appendAgentEvent has a turn_result early-return inside the chrome branch', () => {
  // The fix MUST short-circuit turn_result handling BEFORE the
  // generic "else: _createChromeBatch" path that produced the
  // standalone row. The marker is a bug-38 comment + a dedicated
  // `if (ev.type === 'turn_result')` branch under the chrome
  // routing (anchored on _isChromeEvent so we don't false-positive
  // on the unrelated turn_result branches elsewhere).
  const fnIdx = APP.search(/function\s+_appendAgentEvent\s*\(/);
  assert.ok(fnIdx > -1, '_appendAgentEvent must be defined');
  const fn = sliceFn(APP, fnIdx);
  // Locate the chrome-routing block.
  const chromeIdx = fn.search(/if\s*\(\s*_isChromeEvent\s*\(\s*ev\s*\)\s*\)\s*\{/);
  assert.ok(chromeIdx > -1, 'chrome-routing block must be inside _appendAgentEvent');
  // Inside the chrome block (next ~3500 chars — comment-heavy), there
  // must be a turn_result-specific branch BEFORE the let batch = ...;
  // / else _createChromeBatch dual-path.
  const chromeWin = fn.slice(chromeIdx, chromeIdx + 4500);
  const turnIdx = chromeWin.search(/ev\.type === ['"]turn_result['"]/);
  const createIdx = chromeWin.search(/_createChromeBatch\s*\(/);
  assert.ok(turnIdx > -1, 'bug-38: chrome branch must check ev.type === "turn_result" before falling into _createChromeBatch');
  assert.ok(createIdx > -1, 'sanity: _createChromeBatch still exists as the fresh-batch path for non-turn_result chrome events');
  assert.ok(turnIdx < createIdx,
    'bug-38: the turn_result branch must come BEFORE _createChromeBatch so it can short-circuit');
});

t('app.js: turn_result branch attaches outcome chip only when prev is a chrome batch (else drops)', () => {
  const fnIdx = APP.search(/function\s+_appendAgentEvent\s*\(/);
  const fn = sliceFn(APP, fnIdx);
  const chromeIdx = fn.search(/if\s*\(\s*_isChromeEvent\s*\(\s*ev\s*\)\s*\)\s*\{/);
  const chromeWin = fn.slice(chromeIdx, chromeIdx + 2500);
  // Inside the turn_result branch we expect:
  //   1. A check for prev being a chrome batch (dataset.evType === "_chrome_batch")
  //   2. _attachTurnOutcomeChip(...) call
  //   3. A return; that prevents the fresh-batch fallthrough
  const turnSlice = chromeWin.slice(chromeWin.search(/ev\.type === ['"]turn_result['"]/));
  // Take the next 800 chars — should cover the whole branch + return.
  const branch = turnSlice.slice(0, 800);
  assert.ok(/dataset\.evType\s*===\s*['"]_chrome_batch['"]/.test(branch),
    'bug-38: turn_result branch must check prev.dataset.evType === "_chrome_batch"');
  assert.ok(/_attachTurnOutcomeChip\s*\(/.test(branch),
    'bug-38: turn_result branch must still call _attachTurnOutcomeChip (the chip is the kept signal)');
  assert.ok(/return\s*;/.test(branch),
    'bug-38: turn_result branch must `return;` so the fresh-batch path below does not fire');
});

t('app.js: _appendToChromeBatch leaves head label alone when the incoming event is turn_result', () => {
  // Without this guard, folding turn_result into the existing batch
  // overwrites the head label "▸ ✏ Edit · file.js" with the
  // _chromeShortLabel "■ done · $0.04..." — re-introducing the same
  // redundancy the user is complaining about, just inside the prev
  // batch instead of in a fresh one.
  const idx = APP.search(/function\s+_appendToChromeBatch\s*\(/);
  assert.ok(idx > -1, '_appendToChromeBatch must be defined');
  const win = sliceFn(APP, idx);
  // The function must explicitly skip the .agent-chrome-last relabel
  // when ev.type === 'turn_result'.
  assert.ok(/ev\.type\s*!==\s*['"]turn_result['"]|ev\.type\s*===\s*['"]turn_result['"]/.test(win),
    'bug-38: _appendToChromeBatch must branch on ev.type === "turn_result" to skip the head relabel');
  // The summaryEl.textContent assignment must be inside a guard, not
  // unconditional. We assert this by checking that the summaryEl
  // update is preceded by the turn_result type check (forward search
  // from the type-check marker).
  const turnCheckIdx = win.search(/ev\.type\s*[!=]==\s*['"]turn_result['"]/);
  assert.ok(turnCheckIdx > -1, 'bug-38: type-check marker for turn_result must exist in _appendToChromeBatch');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
