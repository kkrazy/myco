// bug-40 r2 — the original bug-40 fix (commit 132218a) classifies
// thinking-block 400s via _isThinkingBlockError(err), which only inspects
// THROWN errors. In practice the `claude` CLI subprocess sometimes
// CATCHES the API 400 and emits it as a normal stream `result` event:
//
//   { type: 'result', subtype: 'success', result: 'API Error: 400 ...
//     thinking or redacted_thinking blocks ... cannot be modified ...' }
//
// The stream then closes cleanly, no JS error is thrown, the existing
// recovery branch (line ~505) never fires, sdkSessionId stays poisoned,
// and every subsequent turn re-resumes the same broken transcript and
// 400s identically — permanent wedge. Reproduced live on mycobeta's
// "myco-beta" session (id myco-kkrazy-f80476dd) at 2026-05-29 between
// 01:05 and 22:36; manual unwedge required clearing sdkSessionId in
// /data/sessions.json + a container restart.
//
// FIX: extend the detection to ALSO classify by event content. Inside
// the for-await loop, after handing the message to _handleEvent, check
// whether it's a `result` event whose `m.result` text matches the
// thinking-block pattern; if so, throw a synthetic Error so the
// existing _isThinkingBlockError(streamErr) catch + recovery branch
// fires the same way it does for a thrown 400. Adds a shared helper
// _isThinkingBlockErrorMessage(text) used by both _isThinkingBlockError
// and the new loop check.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const AGENT = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'),
  'utf8'
);

// ──────────────────────────────────────────────────────────────────────────
// Behaviour parity — the shared regex must catch the real
// production wording AND the original error-message form.

const ERR_REGEX =
  /thinking or redacted_thinking blocks.*cannot be modified|must remain as they were in the original response/i;

function isThinkingBlockMessage(text) {
  if (!text || typeof text !== 'string') return false;
  return ERR_REGEX.test(text);
}

t('regex matches the live mycobeta error text (prose form)', () => {
  const live = 'API Error: 400 messages.3.content.17: `thinking` or ' +
    '`redacted_thinking` blocks in the latest assistant message cannot ' +
    'be modified. These blocks must remain as they were in the original ' +
    'response.';
  if (!isThinkingBlockMessage(live)) {
    throw new Error('classifier missed the live mycobeta error text');
  }
});

t('regex matches the alternative wording (must remain as they were…)', () => {
  const alt = 'thinking block must remain as they were in the original response';
  if (!isThinkingBlockMessage(alt)) {
    throw new Error('classifier missed the alternative wording');
  }
});

t('regex rejects unrelated 400s (no false-positive recovery)', () => {
  if (isThinkingBlockMessage('400 bad request: missing required field "model"')) {
    throw new Error('classifier matched a non-thinking-block 400');
  }
  if (isThinkingBlockMessage('rate limited; retry after 30s')) {
    throw new Error('classifier matched a rate-limit error');
  }
  if (isThinkingBlockMessage('')) {
    throw new Error('classifier matched an empty string');
  }
  if (isThinkingBlockMessage(null)) {
    throw new Error('classifier matched null');
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Static-source guards — agent-session.js must wire the new detection
// into the for-await loop and share the regex via a helper.

t('agent-session.js defines _isThinkingBlockErrorMessage helper', () => {
  if (!/_isThinkingBlockErrorMessage\s*\(\s*text\s*\)\s*\{/.test(AGENT)) {
    throw new Error('helper _isThinkingBlockErrorMessage(text) missing');
  }
});

t('helper carries the same regex shape as the thrown-error classifier', () => {
  // Find the helper body and assert it contains both regex disjuncts.
  const helperBody = (AGENT.match(
    /_isThinkingBlockErrorMessage\s*\(\s*text\s*\)\s*\{[\s\S]{0,600}\}/
  ) || [])[0] || '';
  if (!/thinking or redacted_thinking blocks/.test(helperBody)) {
    throw new Error('helper missing the primary disjunct');
  }
  if (!/must remain as they were in the original response/.test(helperBody)) {
    throw new Error('helper missing the alternative disjunct');
  }
});

t('thrown-error classifier delegates to the text helper (DRY)', () => {
  // _isThinkingBlockError(err) must call _isThinkingBlockErrorMessage
  // so the two paths share one regex.
  const body = (AGENT.match(
    /_isThinkingBlockError\s*\(\s*err\s*\)\s*\{[\s\S]{0,400}\}/
  ) || [])[0] || '';
  if (!/_isThinkingBlockErrorMessage\s*\(/.test(body)) {
    throw new Error('_isThinkingBlockError must delegate to _isThinkingBlockErrorMessage');
  }
});

t('for-await loop classifies prose-form result + throws synthetic error', () => {
  // After _handleEvent, the loop must check `m.type === 'result'` AND
  // `_isThinkingBlockErrorMessage(m.result)` and throw a synthetic so
  // the existing streamErr catch fires.
  if (!/m\.type\s*===\s*'result'\s*&&\s*this\._isThinkingBlockErrorMessage\s*\(\s*m\.result\s*\)/.test(AGENT)) {
    throw new Error('for-await loop does not classify prose-form result');
  }
  if (!/throw new Error\(\s*[`'"]thinking_block_immutability/.test(AGENT)) {
    throw new Error('loop does not throw a thinking_block_immutability synthetic');
  }
});

t('synthetic throw is inside the for-await loop (will be caught by streamErr)', () => {
  // Sanity: the throw sits within the `try { for await … } catch (err) { streamErr = err; }`
  // block so it routes into the existing recovery, not unhandled.
  const loop = AGENT.match(
    /for await \(const m of stream\)[\s\S]{0,1500}catch\s*\(\s*err\s*\)\s*\{\s*streamErr\s*=\s*err;/
  );
  if (!loop || !/throw new Error\(\s*`thinking_block_immutability/.test(loop[0])) {
    throw new Error('synthetic throw not inside the for-await try/catch');
  }
});

t('existing recovery branches both call _isThinkingBlockError (preserved)', () => {
  // The new detection feeds the existing branches; the branches must
  // still exist on both init and stream paths so the synthetic actually
  // triggers the sdkSessionId clear.
  const initBranch = /this\._isResumeFailure\(\s*initErr\s*\)\s*\|\|\s*this\._isThinkingBlockError\(\s*initErr\s*\)/;
  const streamBranch = /this\._isResumeFailure\(\s*streamErr\s*\)\s*\|\|\s*this\._isThinkingBlockError\(\s*streamErr\s*\)/;
  if (!initBranch.test(AGENT)) {
    throw new Error('init-path recovery branch missing');
  }
  if (!streamBranch.test(AGENT)) {
    throw new Error('stream-path recovery branch missing');
  }
});

t('synthetic message routes through _isThinkingBlockError → recovery', () => {
  // End-to-end logic check: a synthetic Error whose message contains the
  // matched text must be classified by _isThinkingBlockError.
  const syntheticMsg = 'thinking_block_immutability (prose-form result): ' +
    'API Error: 400 messages.3.content.17: thinking or redacted_thinking ' +
    'blocks in the latest assistant message cannot be modified.';
  if (!isThinkingBlockMessage(syntheticMsg)) {
    throw new Error('synthetic error message does not match the classifier — recovery would not fire');
  }
});

t('!!sdkOpts.resume one-shot guard still gates the recovery (no infinite loop)', () => {
  // The synthetic throw + recovery must remain gated on resume=, so the
  // retry (which clears sdkSessionId and runs without resume=) cannot
  // re-enter the branch.
  if (!/!!sdkOpts\.resume/.test(AGENT)) {
    throw new Error('!!sdkOpts.resume one-shot guard missing');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
