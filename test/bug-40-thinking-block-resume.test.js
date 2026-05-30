// bug-40 regression (user-reported): a prompt containing special chars
// (LaTeX backslashes, unicode — e.g. `$$\frac{100}{10-1}=11.\overline{1}
// \text{ 秒}$$`) triggers a hard 400 on the NEXT turn:
//
//   API Error: 400 messages.3.content.17: thinking or redacted_thinking
//   blocks in the latest assistant message cannot be modified. These
//   blocks must remain as they were in the original response.
//
// ROOT CAUSE (confirmed by inspecting ~/.claude/projects/<cwd>/): the
// fr-55 lean-ctx MCP sidecar runs an autonomous "compaction-sync" that
// REWRITES the Anthropic transcript JSONL in place (observed shrinking a
// transcript 59 MB → 305 KB and leaving <id>.jsonl.bak.<ts> backups; the
// backup held 1716 thinking blocks, the rewrite 17). That re-serialization
// changes the assistant messages byte-for-byte, breaking the immutability
// the Anthropic API enforces on thinking / redacted_thinking blocks — so
// the next `resume` 400s. Special chars make the affected messages
// re-serialize differently, which is why they correlate with the failure.
//
// FIX (two layers):
//   1. Prevention — spawn the lean-ctx sidecar with LEAN_CTX_AUTONOMY=false
//      so its autonomous compaction-sync never rewrites the transcript
//      (the ctx_* compression tools the agent uses still work).
//   2. Recovery (defense-in-depth) — _isThinkingBlockError(err) classifies
//      the 400; _ensureIteration treats it as a poisoned resume on BOTH the
//      init-error and stream-error paths (it surfaces on the stream path in
//      practice): clear sdkSessionId (in-memory + on-disk via saveStore),
//      re-stash the in-flight user turn so the fresh conversation still
//      processes it, and retry once without resume=. Mirrors the fr-44
//      resume-failure fallback; the `!!sdkOpts.resume` guard is one-shot so
//      it can't loop.
//
// Pre-fix this surfaces as `fatal` and — because every resume reloads the
// same poisoned transcript — the session is permanently wedged.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED behavior — mirrors agent-session.js _isThinkingBlockError +
// the poisoned-resume fallback branches in _ensureIteration.

function isThinkingBlockError(err) {
  if (!err) return false;
  const msg = String((err && err.message) || '');
  return /thinking or redacted_thinking blocks.*cannot be modified|must remain as they were in the original response/i.test(msg);
}

function isResumeFailure(err) {
  if (!err) return false;
  const msg = String((err && err.message) || '');
  return /session not found|invalid session.?id|could not load conversation|conversation not found|no such session|session expired/i.test(msg);
}

// Simulates the poisoned-resume fallback in _ensureIteration. Each attempt
// drains _pendingPrePush into a fresh queue (the loop-top redelivery), then
// runs its outcome. A thinking-block error (or resume-failure) on an attempt
// that USED resume= clears sdkSessionId, re-stashes the in-flight user turn,
// and retries without resume=. Returns the event trail + the queue the
// terminating attempt actually delivered (to prove redelivery).
function simulatePoisonedResume({ initialSessionId, userEnvelope, outcomes }) {
  const rec = { sdkSessionId: initialSessionId };
  const events = [];
  let attempt = 0;
  let resumeUsed = !!rec.sdkSessionId;
  let pendingPrePush = [userEnvelope];   // cold-start stash from write()
  let lastUserEnvelope = userEnvelope;   // bug-40 redelivery field
  while (attempt < 3) {
    attempt++;
    // loop top: fresh queue, drain pre-push into it
    const queue = [];
    if (pendingPrePush && pendingPrePush.length) {
      for (const m of pendingPrePush) queue.push(m);
      pendingPrePush = null;
    }
    const outcome = outcomes[attempt - 1];
    events.push({ type: 'attempt_start', attempt, resumeUsed, delivered: queue.slice() });
    if (outcome === 'success') return { events, attempt, terminated: 'success', deliveredQueue: queue };
    if (outcome === 'abort') { events.push({ type: 'iteration_aborted' }); return { events, attempt, terminated: 'aborted', deliveredQueue: queue }; }
    // outcome is an Error
    const poisoned = isThinkingBlockError(outcome) || isResumeFailure(outcome);
    if (poisoned && resumeUsed) {
      events.push({
        type: 'resume_failed',
        reason: isThinkingBlockError(outcome) ? 'thinking_block_immutability' : 'resume_unavailable',
        prevSdkSessionId: rec.sdkSessionId,
      });
      rec.sdkSessionId = null;
      resumeUsed = false;
      if (lastUserEnvelope) pendingPrePush = [lastUserEnvelope];   // redeliver
      // NOTE: prod _ensureIteration also does `attempt--` so the free retry
      // doesn't burn a MAX_ATTEMPTS slot; this simulation indexes `outcomes`
      // by attempt #, so it advances the index normally instead (the
      // counter arithmetic is covered by the static guards, not here).
      continue;
    }
    events.push({ type: 'fatal', error: outcome.message });
    return { events, attempt, terminated: 'fatal', deliveredQueue: queue };
  }
  return { events, attempt, terminated: 'attempts_exhausted' };
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── bug-40: thinking-block immutability resume recovery ──');

// The exact error the user pasted.
const USER_REPORTED = new Error(
  'messages.3.content.17: thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.'
);

t('isThinkingBlockError: matches the user-reported 400 verbatim', () => {
  assert.strictEqual(isThinkingBlockError(USER_REPORTED), true);
});

t('isThinkingBlockError: matches the "cannot be modified" phrasing', () => {
  assert.strictEqual(
    isThinkingBlockError(new Error('thinking or redacted_thinking blocks in the latest assistant message cannot be modified')),
    true);
});

t('isThinkingBlockError: matches the "must remain as they were" phrasing', () => {
  assert.strictEqual(
    isThinkingBlockError(new Error('These blocks must remain as they were in the original response.')),
    true);
});

t('isThinkingBlockError: does NOT match resume-failure / network / generic errors', () => {
  assert.strictEqual(isThinkingBlockError(new Error('Session not found: abc')), false);
  assert.strictEqual(isThinkingBlockError(new Error('ECONNRESET')), false);
  assert.strictEqual(isThinkingBlockError(new Error('rate limit exceeded')), false);
  assert.strictEqual(isThinkingBlockError(new Error('Something else broke')), false);
  assert.strictEqual(isThinkingBlockError(null), false);
});

t('recovery: thinking-block 400 on attempt 1 → cleared + retried fresh → succeed', () => {
  const userEnvelope = { type: 'user', message: { role: 'user', content: '$$\\frac{100}{10-1}=11.\\overline{1}\\text{ 秒}$$' } };
  const res = simulatePoisonedResume({
    initialSessionId: 'sdk-poisoned',
    userEnvelope,
    outcomes: [USER_REPORTED, 'success'],
  });
  assert.strictEqual(res.terminated, 'success');
  assert.strictEqual(res.attempt, 2, 'fresh-session attempt succeeds');
  const ev = res.events.find((e) => e.type === 'resume_failed');
  assert.ok(ev, 'must emit resume_failed');
  assert.strictEqual(ev.reason, 'thinking_block_immutability',
    'reason must distinguish the thinking-block cause from a plain resume-failure');
  assert.strictEqual(ev.prevSdkSessionId, 'sdk-poisoned', 'event carries the poisoned id');
  const a2 = res.events.find((e) => e.type === 'attempt_start' && e.attempt === 2);
  assert.strictEqual(a2.resumeUsed, false, 'attempt 2 must run WITHOUT resume= (fresh conversation)');
});

t('recovery: in-flight user turn is REDELIVERED to the fresh conversation', () => {
  // The fresh query() has no transcript to replay the message from — bug-40
  // re-stashes _lastUserEnvelope so the user does NOT lose their message.
  const userEnvelope = { type: 'user', message: { role: 'user', content: 'compute 11.overline(1)' } };
  const res = simulatePoisonedResume({
    initialSessionId: 'sdk-poisoned',
    userEnvelope,
    outcomes: [USER_REPORTED, 'success'],
  });
  assert.strictEqual(res.terminated, 'success');
  assert.deepStrictEqual(res.deliveredQueue, [userEnvelope],
    'the fresh attempt must deliver the original user turn (no silent message loss)');
});

t('recovery: a SECOND thinking-block error after clearing → fatal (no infinite loop)', () => {
  const userEnvelope = { type: 'user', message: { role: 'user', content: 'x' } };
  const res = simulatePoisonedResume({
    initialSessionId: 'sdk-poisoned',
    userEnvelope,
    outcomes: [USER_REPORTED, USER_REPORTED],
  });
  // After attempt 1: cleared + resumeUsed=false. Attempt 2 sees the same
  // error but resumeUsed is false, so it is NOT treated as a fallback.
  assert.strictEqual(res.terminated, 'fatal');
  const resumeFailed = res.events.filter((e) => e.type === 'resume_failed');
  assert.strictEqual(resumeFailed.length, 1, 'recovery fires EXACTLY once — second is a true fatal');
});

t('recovery: never fires when no resume= was set (avoids looping a fresh session)', () => {
  const userEnvelope = { type: 'user', message: { role: 'user', content: 'x' } };
  const res = simulatePoisonedResume({
    initialSessionId: null,           // fresh conversation, no resume
    userEnvelope,
    outcomes: [USER_REPORTED],
  });
  assert.strictEqual(res.terminated, 'fatal');
  assert.strictEqual(res.events.find((e) => e.type === 'resume_failed'), undefined,
    'no resume_failed when there was no resume to drop');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards on prod sources.

const AGENT = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');

// ── Layer 1: prevention ──

t('PREVENTION: lean-ctx sidecar is spawned with LEAN_CTX_AUTONOMY=false', () => {
  const mcpIdx = AGENT.search(/mcpServers:\s*\{/);
  assert.ok(mcpIdx > -1, 'mcpServers block must exist');
  const block = AGENT.slice(mcpIdx, mcpIdx + 2500);
  assert.ok(/['"]lean-ctx['"]\s*:\s*\{/.test(block), 'lean-ctx server entry must exist');
  assert.ok(/LEAN_CTX_AUTONOMY:\s*['"]false['"]/.test(block),
    'lean-ctx env must set LEAN_CTX_AUTONOMY=false to disable the autonomous compaction-sync that rewrites the transcript JSONL');
  // The compression tooling must NOT be globally disabled — that would
  // defeat fr-55. Guard against an over-broad "just turn it off" fix.
  assert.ok(!/LEAN_CTX_DISABLED:\s*['"]?1['"]?/.test(block),
    'must NOT set LEAN_CTX_DISABLED=1 — that kills the ctx_* compression tools fr-55 relies on');
});

// ── Layer 2: recovery ──

t('RECOVERY: agent-session.js declares _isThinkingBlockError helper', () => {
  assert.match(AGENT, /_isThinkingBlockError\s*\(/,
    '_isThinkingBlockError(err) helper must exist');
});

t('RECOVERY: _isThinkingBlockError matches the documented 400 phrases', () => {
  assert.match(AGENT, /thinking or redacted_thinking blocks/i,
    'classifier must match "thinking or redacted_thinking blocks"');
  assert.match(AGENT, /cannot be modified/i, 'classifier must match "cannot be modified"');
  assert.match(AGENT, /must remain as they were in the original response/i,
    'classifier must match the "must remain as they were in the original response" phrasing');
});

t('RECOVERY: BOTH the init-error AND stream-error paths handle the thinking-block 400', () => {
  // The 400 surfaces during stream consumption in practice, but can also
  // throw at init — both branches must recover. The two branches reference
  // the error via distinct variable names, so both must appear.
  assert.match(AGENT, /_isThinkingBlockError\(initErr\)/,
    'init-error branch must classify initErr as a thinking-block error');
  assert.match(AGENT, /_isThinkingBlockError\(streamErr\)/,
    'stream-error branch must classify streamErr — this is where the 400 actually lands');
});

t('RECOVERY: emits resume_failed with a thinking_block_immutability reason', () => {
  assert.match(AGENT, /reason:\s*[^\n]*thinking_block_immutability/,
    'recovery must tag the resume_failed event so observers can tell the thinking-block cause apart');
});

t('RECOVERY: clears sdkSessionId and persists it (so a respawn does not re-poison)', () => {
  // Reuse the fr-44 contract: the cleared id must be persisted via saveStore.
  const idx = AGENT.indexOf('thinking_block_immutability');
  assert.ok(idx > -1);
  const window = AGENT.slice(Math.max(0, idx - 1200), idx + 1200);
  assert.ok(/this\.sdkSessionId\s*=\s*null/.test(window), 'must clear this.sdkSessionId near the recovery');
  assert.ok(/saveStore\s*\(/.test(window), 'must persist the cleared sdkSessionId via saveStore');
});

t('RECOVERY: redelivers the in-flight user turn (no silent message loss)', () => {
  // write() records the turn; result clears it; recovery re-stashes it.
  assert.match(AGENT, /this\._lastUserEnvelope\s*=\s*envelope/,
    'write() must record the in-flight user envelope');
  assert.match(AGENT, /this\._lastUserEnvelope\s*=\s*null/,
    'the result handler must clear _lastUserEnvelope once the turn completes');
  const restash = AGENT.match(/this\._pendingPrePush\s*=\s*\[\s*this\._lastUserEnvelope\s*\]/g) || [];
  assert.ok(restash.length >= 2,
    'BOTH recovery branches must re-stash _lastUserEnvelope into _pendingPrePush for redelivery (found ' + restash.length + ')');
});

t('RECOVERY: one-shot guard prevents an infinite fallback loop', () => {
  // After clearing sdkSessionId the next attempt sets no resume=, so the
  // `!!sdkOpts.resume` guard short-circuits the branch.
  assert.match(AGENT, /!!sdkOpts\.resume/,
    'recovery branches must guard on !!sdkOpts.resume so they fire at most once per poisoned resume');
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
