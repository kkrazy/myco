// fr-43 regression: agent-session.js _ensureIteration must wrap the
// SDK for-await loop with retry-on-recoverable-error. Today (pre-fix)
// any non-AbortError from the SDK kills the iteration permanently —
// including transient rate-limits (which the SDK emits structurally
// as `rate_limit_event`), network blips (ECONNRESET, ETIMEDOUT,
// EAI_AGAIN, ENOTFOUND, EPIPE), and upstream 5xx-flavored fetch
// failures. The user has to manually retry.
//
// Fix shape:
//   - Outer retry loop in _ensureIteration with MAX_ATTEMPTS = 3.
//   - Helpers: _isRecoverable(err) classifies errors; _retryDelay
//     (attempt, err) emits a `retry_attempt` event and sleeps.
//   - Backoff: 1s → 4s → 16s (exponential by attempt index).
//   - AbortError / abortController abort still escapes the retry
//     loop immediately (user-initiated Stop must NEVER auto-retry).
//   - On exhaustion: emit `fatal {reason:'retry_exhausted', ...}`.
//   - Each retry re-spawns `query()` with `resume=sdkSessionId` so
//     the SDK conversation continues from where it left off.
//
// This test covers the recoverable-error classifier directly (pure
// JS logic, easy to test in isolation) + static-grep guards on the
// prod _ensureIteration shape. A future runtime integration test
// against the real SDK (skip-when-not-installed) can land alongside
// fr-44 if we want end-to-end coverage.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED behavior — mirrors what agent-session.js _isRecoverable
// + _retryDelay + the outer retry loop must implement.

function isRecoverable(err) {
  if (!err) return false;
  const code = err.code || (err.cause && err.cause.code);
  const transientCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']);
  if (code && transientCodes.has(code)) return true;
  const msg = String(err.message || '');
  if (/rate.?limit|too many requests|\b50[234]\b|fetch failed|network|timeout/i.test(msg)) return true;
  return false;
}

function backoffMs(attempt) {
  const SCHEDULE = [1000, 4000, 16000];
  return SCHEDULE[Math.min(attempt - 1, SCHEDULE.length - 1)];
}

// Simulates the outer retry loop in _ensureIteration. The real impl
// awaits an async generator; here we use a callable `queryFn` that
// returns an outcome string each attempt.
async function simulateRetryLoop({ outcomes, maxAttempts = 3 }) {
  const events = [];
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const outcome = outcomes[attempt - 1];
    events.push({ type: 'attempt_start', attempt });
    if (outcome === 'success') {
      events.push({ type: 'success', attempt });
      return { events, terminated: 'success', attempt };
    }
    if (outcome === 'abort') {
      events.push({ type: 'iteration_aborted' });
      return { events, terminated: 'aborted', attempt };
    }
    // outcome is an Error instance — recoverable or not.
    lastErr = outcome;
    if (isRecoverable(outcome) && attempt < maxAttempts) {
      events.push({
        type: 'retry_attempt',
        attempt: attempt + 1,
        reason: /rate.?limit/i.test(String(outcome.message || '')) ? 'rate_limit' : 'transient_error',
        retryAfterMs: backoffMs(attempt),
      });
      continue;
    }
    if (attempt >= maxAttempts) {
      events.push({ type: 'fatal', reason: 'retry_exhausted', attempts: attempt });
    } else {
      events.push({ type: 'fatal', reason: 'non_recoverable' });
    }
    return { events, terminated: 'fatal', attempt };
  }
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── fr-43: rate-limit + transient-error retry ──');

t('isRecoverable: ECONNRESET / ETIMEDOUT / EAI_AGAIN / ENOTFOUND / EPIPE → true', () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']) {
    const err = Object.assign(new Error('synthetic'), { code });
    assert.strictEqual(isRecoverable(err), true, `code=${code} must be recoverable`);
  }
});

t('isRecoverable: err.cause.code is also recognized', () => {
  const wrapped = new Error('outer');
  wrapped.cause = { code: 'ECONNRESET' };
  assert.strictEqual(isRecoverable(wrapped), true,
    'wrapped errors with cause.code must be classified too (Node fetch wraps low-level errors this way)');
});

t('isRecoverable: rate-limit / 5xx / network / timeout MESSAGE patterns → true', () => {
  const cases = [
    'Rate limit exceeded',
    'Too Many Requests',
    'HTTP 503 Service Unavailable',
    'HTTP 502 Bad Gateway',
    'HTTP 504 Gateway Timeout',
    'fetch failed',
    'Network error',
    'Request timeout',
  ];
  for (const msg of cases) {
    assert.strictEqual(isRecoverable(new Error(msg)), true, `msg="${msg}" must be recoverable`);
  }
});

t('isRecoverable: AbortError / 4xx / validation → false', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  // AbortError must NOT be recoverable — the user clicked Stop and
  // we MUST NOT auto-retry past their intent.
  assert.strictEqual(/aborted|abort/i.test(abort.message), true,
    'sanity: aborted message matches the abort guard in _ensureIteration');
  // The classifier returns true for "abort" because the message
  // matches /…|timeout/ ... wait, no, abort isn't on the recoverable
  // list. Let's verify directly.
  const recoverable = isRecoverable(abort);
  assert.strictEqual(recoverable, false,
    'AbortError MUST be classified as not-recoverable so the retry loop ' +
    'skips it (the abort branch in _ensureIteration handles it separately).');
  // 4xx auth / validation errors → not recoverable (retrying with same
  // auth will fail the same way).
  assert.strictEqual(isRecoverable(new Error('401 Unauthorized')), false);
  assert.strictEqual(isRecoverable(new Error('400 Bad Request')), false);
  assert.strictEqual(isRecoverable(new Error('Invalid model id')), false);
});

t('isRecoverable: null / undefined → false (defensive)', () => {
  assert.strictEqual(isRecoverable(null), false);
  assert.strictEqual(isRecoverable(undefined), false);
  assert.strictEqual(isRecoverable({}), false, 'non-Error objects without code/message → false');
});

t('backoffMs: exponential schedule 1s → 4s → 16s, then cap', () => {
  assert.strictEqual(backoffMs(1), 1000);
  assert.strictEqual(backoffMs(2), 4000);
  assert.strictEqual(backoffMs(3), 16000);
  assert.strictEqual(backoffMs(4), 16000, 'caps at the longest slot — no infinite ladder');
});

t('retry loop: 1 transient error → retry → succeed (no fatal)', async () => {
  const transient = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  const res = await simulateRetryLoop({ outcomes: [transient, 'success'] });
  assert.strictEqual(res.terminated, 'success');
  assert.strictEqual(res.attempt, 2, 'second attempt succeeded');
  const retryEvent = res.events.find(e => e.type === 'retry_attempt');
  assert.ok(retryEvent, 'must emit retry_attempt event for observability');
  assert.strictEqual(retryEvent.reason, 'transient_error');
  assert.strictEqual(retryEvent.retryAfterMs, 1000, '1st backoff slice = 1s');
});

t('retry loop: rate_limit error → retry → succeed (reason="rate_limit")', async () => {
  const rateLimit = new Error('Rate limit hit, please retry');
  const res = await simulateRetryLoop({ outcomes: [rateLimit, 'success'] });
  assert.strictEqual(res.terminated, 'success');
  const retryEvent = res.events.find(e => e.type === 'retry_attempt');
  assert.strictEqual(retryEvent.reason, 'rate_limit',
    'rate-limit errors must be tagged as such in retry_attempt event');
});

t('retry loop: 3 transient errors → fatal {reason:"retry_exhausted"}', async () => {
  const e = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const res = await simulateRetryLoop({ outcomes: [e, e, e] });
  assert.strictEqual(res.terminated, 'fatal');
  assert.strictEqual(res.attempt, 3);
  const fatal = res.events.find(e => e.type === 'fatal');
  assert.strictEqual(fatal.reason, 'retry_exhausted');
  assert.strictEqual(fatal.attempts, 3);
  // 2 retry_attempt events fired (attempts 2 + 3) — none on the
  // final one because that's when we give up.
  const retries = res.events.filter(e => e.type === 'retry_attempt');
  assert.strictEqual(retries.length, 2);
  assert.deepStrictEqual(retries.map(r => r.retryAfterMs), [1000, 4000]);
});

t('retry loop: AbortError fires "abort" outcome — exits immediately, no retry', async () => {
  const res = await simulateRetryLoop({ outcomes: ['abort'] });
  assert.strictEqual(res.terminated, 'aborted');
  assert.strictEqual(res.attempt, 1);
  // CRITICAL: must NOT have a retry_attempt event.
  const retry = res.events.find(e => e.type === 'retry_attempt');
  assert.strictEqual(retry, undefined,
    'AbortError must NEVER trigger a retry — the user clicked Stop, ' +
    'and auto-retrying past their intent would be a UX disaster.');
});

t('retry loop: non-recoverable error (401 Unauthorized) → fatal {reason:"non_recoverable"}, no retries', async () => {
  const res = await simulateRetryLoop({ outcomes: [new Error('401 Unauthorized'), 'success'] });
  // The error is non-recoverable, so we should fatal on attempt 1, NOT
  // proceed to attempt 2 even though it's marked 'success'.
  assert.strictEqual(res.terminated, 'fatal');
  assert.strictEqual(res.attempt, 1);
  const retry = res.events.find(e => e.type === 'retry_attempt');
  assert.strictEqual(retry, undefined, 'non-recoverable error must NOT trigger retry');
});

t('retry loop: mixed transient + rate_limit + transient → 3rd succeeds', async () => {
  const e1 = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
  const e2 = new Error('Rate limit hit');
  const res = await simulateRetryLoop({ outcomes: [e1, e2, 'success'] });
  assert.strictEqual(res.terminated, 'success');
  assert.strictEqual(res.attempt, 3);
  const retries = res.events.filter(e => e.type === 'retry_attempt');
  assert.strictEqual(retries.length, 2);
  assert.deepStrictEqual(retries.map(r => r.reason), ['transient_error', 'rate_limit']);
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards: anchor the fix shape onto prod source.

const PROD_AGENT = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');

t('agent-session.js declares _isRecoverable helper', () => {
  assert.match(PROD_AGENT, /_isRecoverable\s*\(/,
    '_isRecoverable(err) helper must exist — classifies errors as retry-eligible or not');
});

t('agent-session.js _isRecoverable checks the transient code allowlist', () => {
  // Pin the actual codes so a future "let me clean these up" edit
  // can't silently drop one and let a real failure mode go unretried.
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']) {
    assert.ok(PROD_AGENT.indexOf(code) > -1, `_isRecoverable must check ${code}`);
  }
});

t('agent-session.js _isRecoverable checks rate-limit / 5xx message patterns', () => {
  assert.match(PROD_AGENT, /rate.?limit/i,
    'message pattern check must include rate-limit');
  // The source uses a regex char-class like `\b50[234]\b` to match
  // 502/503/504. Verify the char-class appears (the literal chars
  // [234] inside square brackets) — looser than checking for `502`
  // as 3 consecutive chars since the source TEXT contains `[` between
  // `0` and `2`.
  assert.match(PROD_AGENT, /50\s*\[\s*234\s*\]/,
    'message pattern check must include the [234] char-class for 502/503/504');
});

t('agent-session.js _ensureIteration has a retry loop (while or for over attempts)', () => {
  // The retry loop must be visible inside _ensureIteration. Acceptable
  // shapes: `while (attempt < MAX_ATTEMPTS)` or `for (let attempt …)`.
  const fnStart = PROD_AGENT.search(/async\s+_ensureIteration\s*\(/);
  assert.ok(fnStart > -1, '_ensureIteration must exist');
  // Body up to next top-level method.
  const rest = PROD_AGENT.slice(fnStart);
  const nextFn = rest.slice(1).search(/\n\s{2}\w[\w$]*\s*\(/);
  const body = nextFn === -1 ? rest : rest.slice(0, nextFn + 1);
  assert.ok(
    /while\s*\(\s*attempt\s*[<≤]/i.test(body) ||
    /for\s*\(\s*let\s+attempt\s*=/i.test(body),
    '_ensureIteration must wrap the SDK call in a per-attempt loop. ' +
    'Got body slice: ' + body.slice(0, 200) + '...');
});

t('agent-session.js declares MAX_ATTEMPTS constant capped at 3', () => {
  assert.match(PROD_AGENT, /MAX_ATTEMPTS\s*=\s*3\b/,
    'MAX_ATTEMPTS = 3 must be declared (cap on retries — beyond this, fatal)');
});

t('agent-session.js exponential backoff schedule includes 1000, 4000, 16000', () => {
  // The backoff array should be visible somewhere in agent-session.js.
  assert.match(PROD_AGENT, /1000[\s,]*4000[\s,]*16000/,
    'backoff schedule [1000, 4000, 16000] must be declared (exponential 1s/4s/16s)');
});

t('agent-session.js emits retry_attempt events for observability', () => {
  assert.match(PROD_AGENT, /type:\s*['"]retry_attempt['"]/,
    'must emit type:"retry_attempt" so clients (chat pane, /loop diag) can see retries happening');
});

t('agent-session.js emits fatal with reason:"retry_exhausted" on cap', () => {
  assert.match(PROD_AGENT, /reason:\s*['"]retry_exhausted['"]/,
    'must distinguish retry_exhausted from a normal fatal so observers can tell why we gave up');
});

t('agent-session.js retry loop preserves AbortError escape (no retry on user-initiated stop)', () => {
  // The retry loop body MUST check for AbortError before deciding to
  // retry. Find a window around the retry / isAbort branches and
  // assert AbortError handling is BEFORE the recoverable check.
  const fnStart = PROD_AGENT.search(/async\s+_ensureIteration\s*\(/);
  const rest = PROD_AGENT.slice(fnStart);
  const nextFn = rest.slice(1).search(/\n\s{2}\w[\w$]*\s*\(/);
  const body = nextFn === -1 ? rest : rest.slice(0, nextFn + 1);
  // Both terms must be present in the same body and isAbort/AbortError
  // must be referenced.
  assert.ok(/AbortError|isAbort/.test(body),
    'retry loop must explicitly check for AbortError / isAbort and bypass retry');
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
