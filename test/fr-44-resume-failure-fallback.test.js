// fr-44 regression: when the SDK rejects `resume=sdkSessionId` because
// the upstream session is gone (container restart with a different SDK
// install wiped $HOME/.claude/projects/, sessionId corrupted on disk,
// transcript file deleted out from under us), the initial query() call
// throws. Pre-fix this surfaces as `fatal` and the AgentSession is dead
// until manually respawned. This is the bug-1 / post-redeploy resume-
// hang pattern.
//
// Fix:
//   - `_isResumeFailure(err)` recognises the resume-failed error class
//     (string match on "session not found", "invalid session_id",
//     "could not load conversation", "conversation not found").
//   - When detected on the FIRST attempt's init query() throw AND
//     sdkOpts.resume was set:
//       1. emit `resume_failed {prevSdkSessionId}`
//       2. clear this.sdkSessionId + rec.sdkSessionId (via
//          sessionsMod.saveStore())
//       3. CONTINUE the retry loop — next attempt has no `resume`
//          set in sdkOpts, so query() spawns a fresh SDK conversation
//   - Fresh session loses prior conversation context but the
//     iteration starts and the user can continue.
//   - On the retry attempt: if THAT also resume-fails (shouldn't,
//     because we just cleared sdkSessionId), treat as normal error
//     to avoid infinite loop.
//
// Multica precedent: `daemon/wakeup.go resolveSessionID()` does
// exactly this — catch resume failure, clear PriorSessionID, retry
// with fresh session.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED behavior — mirrors what agent-session.js _isResumeFailure
// + the resume-fallback branch in _ensureIteration must implement.

function isResumeFailure(err) {
  if (!err) return false;
  const msg = String((err && err.message) || '');
  // Conservative pattern set — the SDK's exact wording isn't
  // documented, but these phrases consistently appear when a resume
  // can't be loaded. New phrases that show up in production should
  // be added here.
  return /session not found|invalid session.?id|could not load conversation|conversation not found|no such session|session expired/i.test(msg);
}

// Simulates the resume-fallback branch in _ensureIteration:
//   - first attempt: query() with resume=sdkSessionId throws ResumeFailure
//   - fix: clear sdkSessionId, emit resume_failed, continue
//   - retry attempt: query() with no resume= set, succeeds
async function simulateResumeFallback({ initialSessionId, outcomes }) {
  const rec = { sdkSessionId: initialSessionId };
  const events = [];
  let attempt = 0;
  let resumeUsed = !!rec.sdkSessionId;
  while (attempt < 3) {
    attempt++;
    const outcome = outcomes[attempt - 1];
    events.push({ type: 'attempt_start', attempt, resumeUsed });
    if (outcome === 'success') return { events, attempt, terminated: 'success' };
    if (outcome === 'abort') { events.push({ type: 'iteration_aborted' }); return { events, attempt, terminated: 'aborted' }; }
    // outcome is an Error
    if (isResumeFailure(outcome) && resumeUsed) {
      const prev = rec.sdkSessionId;
      events.push({ type: 'resume_failed', prevSdkSessionId: prev });
      rec.sdkSessionId = null;
      resumeUsed = false;
      continue;
    }
    // Non-resume-failure: fatal
    events.push({ type: 'fatal', error: outcome.message });
    return { events, attempt, terminated: 'fatal' };
  }
  return { events, attempt, terminated: 'attempts_exhausted' };
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── fr-44: resume-failure fallback ──');

t('isResumeFailure: matches "session not found"', () => {
  assert.strictEqual(isResumeFailure(new Error('Session not found: abc123')), true);
});

t('isResumeFailure: matches "invalid session_id"', () => {
  assert.strictEqual(isResumeFailure(new Error('Invalid session_id provided')), true);
});

t('isResumeFailure: matches "could not load conversation"', () => {
  assert.strictEqual(isResumeFailure(new Error('Could not load conversation for resume')), true);
});

t('isResumeFailure: matches "conversation not found"', () => {
  assert.strictEqual(isResumeFailure(new Error('Conversation not found: 1234')), true);
});

t('isResumeFailure: matches "session expired"', () => {
  assert.strictEqual(isResumeFailure(new Error('Session expired upstream')), true);
});

t('isResumeFailure: does NOT match network errors (different recovery path)', () => {
  assert.strictEqual(isResumeFailure(new Error('ECONNRESET')), false);
  assert.strictEqual(isResumeFailure(new Error('fetch failed')), false);
  assert.strictEqual(isResumeFailure(new Error('rate limit exceeded')), false);
});

t('isResumeFailure: does NOT match generic errors / null', () => {
  assert.strictEqual(isResumeFailure(new Error('Something broke')), false);
  assert.strictEqual(isResumeFailure(null), false);
  assert.strictEqual(isResumeFailure(undefined), false);
});

t('resume-fallback: stale sdkSessionId on attempt 1 → cleared + retried with fresh session → succeed', async () => {
  const resumeErr = new Error('Session not found: abc-stale');
  const res = await simulateResumeFallback({
    initialSessionId: 'abc-stale',
    outcomes: [resumeErr, 'success'],
  });
  assert.strictEqual(res.terminated, 'success');
  assert.strictEqual(res.attempt, 2, 'fresh session attempt succeeds');
  const resumeFailedEvent = res.events.find(e => e.type === 'resume_failed');
  assert.ok(resumeFailedEvent, 'must emit resume_failed event');
  assert.strictEqual(resumeFailedEvent.prevSdkSessionId, 'abc-stale',
    'event carries the stale id so observers can correlate');
  // The 2nd attempt had resumeUsed=false (sdkSessionId was cleared).
  const attempt2 = res.events.find(e => e.type === 'attempt_start' && e.attempt === 2);
  assert.strictEqual(attempt2.resumeUsed, false,
    'attempt 2 must run WITHOUT resume= so the SDK spawns a fresh conversation');
});

t('resume-fallback: no sdkSessionId set → resume_failure path never fires', async () => {
  const someErr = new Error('Session not found');
  const res = await simulateResumeFallback({
    initialSessionId: null,                // no resume was attempted
    outcomes: [someErr],
  });
  // With no sdkSessionId, the same error is treated as a generic
  // fatal (not a resume-fallback). Otherwise we'd loop forever.
  assert.strictEqual(res.terminated, 'fatal');
  const resumeFailedEvent = res.events.find(e => e.type === 'resume_failed');
  assert.strictEqual(resumeFailedEvent, undefined,
    'no resume_failed event when there was no resume to begin with');
});

t('resume-fallback: second resume-failure on retry attempt → fatal (no infinite loop)', async () => {
  // After clearing sdkSessionId, the retry SHOULDN\'T get another
  // resume failure (no resume= field). If it somehow does, treat as
  // a normal error so we don't loop indefinitely.
  const e1 = new Error('Session not found');
  const e2 = new Error('Session not found again');
  const res = await simulateResumeFallback({
    initialSessionId: 'abc',
    outcomes: [e1, e2],
  });
  // After attempt 1: resume_failed emitted, sdkSessionId cleared.
  // Attempt 2: resumeUsed=false, error is "Session not found" but
  // we treat it as fatal (not another resume-fallback).
  assert.strictEqual(res.terminated, 'fatal');
  const resumeFailedEvents = res.events.filter(e => e.type === 'resume_failed');
  assert.strictEqual(resumeFailedEvents.length, 1,
    'resume_failed fires EXACTLY once — second occurrence is a true fatal, not another fallback');
});

t('resume-fallback: AbortError exits before resume-fallback can fire', async () => {
  const res = await simulateResumeFallback({
    initialSessionId: 'abc',
    outcomes: ['abort'],
  });
  assert.strictEqual(res.terminated, 'aborted');
  const resumeFailedEvent = res.events.find(e => e.type === 'resume_failed');
  assert.strictEqual(resumeFailedEvent, undefined,
    'AbortError must escape — no resume fallback in that path');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards.

const PROD_AGENT = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');

t('agent-session.js declares _isResumeFailure helper', () => {
  assert.match(PROD_AGENT, /_isResumeFailure\s*\(/,
    '_isResumeFailure(err) helper must exist — classifies resume-failed errors distinctly from transient network errors');
});

t('agent-session.js _isResumeFailure matches documented phrases', () => {
  // Pin the actual regex-source phrases so a future "clean up regex"
  // edit can't silently narrow the match set. The source TEXT contains
  // the regex pattern literally — escape metacharacters in the
  // assertion regex so we match the source chars.
  assert.match(PROD_AGENT, /session not found/i, 'must match "session not found"');
  assert.match(PROD_AGENT, /invalid session\.\?id/i,
    'must contain the regex `invalid session.?id` (matches "invalid session_id" / "invalid sessionId" / "invalid session id")');
  assert.match(PROD_AGENT, /could not load conversation/i, 'must match "could not load conversation"');
});

t('agent-session.js _ensureIteration clears sdkSessionId + retries on resume failure', () => {
  // The init-error branch in _ensureIteration must call _isResumeFailure
  // and react by clearing sdkSessionId. Verify both signals appear in
  // the function body.
  const fnStart = PROD_AGENT.search(/async\s+_ensureIteration\s*\(/);
  assert.ok(fnStart > -1, '_ensureIteration must exist');
  const rest = PROD_AGENT.slice(fnStart);
  const nextFn = rest.slice(1).search(/\n\s{2}\w[\w$]*\s*\(/);
  const body = nextFn === -1 ? rest : rest.slice(0, nextFn + 1);
  assert.ok(/_isResumeFailure\s*\(/.test(body),
    '_ensureIteration must call _isResumeFailure() on the init-error path');
  // After detection: must clear sdkSessionId AND emit resume_failed.
  assert.ok(/this\.sdkSessionId\s*=\s*null/.test(body),
    'resume-failure path must clear this.sdkSessionId so the next attempt has no resume=');
  assert.ok(/resume_failed/.test(body),
    'must emit a resume_failed event so observers can see the fallback fire');
});

t('agent-session.js resume-fallback persists the cleared sdkSessionId to rec via saveStore', () => {
  // The on-disk rec.sdkSessionId must also be cleared so a respawn
  // doesn\'t re-attempt the same stale resume. Look for saveStore
  // alongside the resume_failed handling.
  const idx = PROD_AGENT.indexOf('resume_failed');
  assert.ok(idx > -1, 'resume_failed must exist');
  const window = PROD_AGENT.slice(Math.max(0, idx - 800), idx + 800);
  assert.ok(/saveStore\s*\(/.test(window) || /sessionsMod\.saveStore/.test(window),
    'resume-fallback must persist the cleared sdkSessionId via saveStore so a respawn sees the fresh state');
});

t('agent-session.js resume-fallback only fires once per iteration (no infinite loop guard)', () => {
  // Look for some form of one-shot guard near the resume_failed
  // handling. Acceptable shapes: a boolean flag named like
  // `resumeFailureRetried`, `resumeFallbackUsed`, OR a check that the
  // current attempt\'s sdkOpts had resume=true (so on attempt 2 we
  // wouldn\'t enter the fallback again because resume= would be unset).
  assert.match(PROD_AGENT,
    /resumeFailureRetried|resumeFallbackUsed|!!sdkOpts\.resume|sdkOpts\.resume\s*&&/,
    'must have a one-shot guard so resume-fallback doesn\'t loop indefinitely on repeated "session not found" errors');
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
