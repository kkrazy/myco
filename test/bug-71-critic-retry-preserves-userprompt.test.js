// bug-71: Critic model retry drops user question on rate-limit/error.
//
// User report (2026-06-07):
//   "When the critic model fails (e.g., rate limit), the retry path
//    loses the original user question. Retry after a critic-model
//    error should preserve and resubmit the original user question."
//
// Root cause: triggerGeminiCritique caches diff / claudeOutput /
// changedEntries on rec._lastCritique so retryLastCritique can re-fire
// the same review — but does NOT cache the userPrompt (the user's
// follow-up question typed into the verdict pane's textarea via the
// bug-52 / bug-53 wiring). The verdict pane's textarea is rendered
// empty on every fresh `critique-review` broadcast (the pane fully
// re-renders), so when the user clicks ↻ Retry after a Gemini 503 /
// rate-limit error, the client reads an empty textarea + POSTs
// userPrompt:'' to /critique/retry. retryLastCritique forwards the
// empty value to triggerGeminiCritique → critic re-fires WITHOUT the
// original question → user's question silently dropped.
//
// Fix (server-side, two halves):
//   · triggerGeminiCritique caches userPrompt in rec._lastCritique
//     alongside diff / claudeOutput / changedEntries.
//   · retryLastCritique falls back to last.userPrompt when
//     opts.userPrompt is missing or empty. Explicit non-empty
//     opts.userPrompt still wins (so a user can re-ask with a
//     different question by typing it before clicking ↻ Retry or
//     💬 Ask Critic).
//
// Why server-side fallback (not client-side textarea pre-population)?
// The server is the authoritative source; the cache survives any
// client-side UI quirk (re-render race, late-attaching device, etc.).
// Client-side would also conflict with bug-53's disabled-when-empty
// affordance for 💬 Ask Critic. Server-side is one branch in one
// function.
//
// Test shape: static guards on the fix shape + a runtime test that
// monkey-patches the gemini critic to simulate the rate-limit then a
// successful retry, asserting the second critic call carries the
// original question even though opts.userPrompt is empty.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function tAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-71: critic retry preserves the original user question ──');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards. Lock the fix shape.
// ─────────────────────────────────────────────────────────────────

const CRITIQUE_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'critique.js'), 'utf8');

t('triggerGeminiCritique caches userPrompt in rec._lastCritique alongside diff/claudeOutput/changedEntries', () => {
  const at = CRITIQUE_JS.search(/async\s+function\s+triggerGeminiCritique\s*\(/);
  assert.ok(at > -1, 'triggerGeminiCritique must exist');
  const body = sliceFn(CRITIQUE_JS, at);
  // Find the rec._lastCritique = {...} literal inside the function body.
  const cacheMatch = body.match(/rec\._lastCritique\s*=\s*\{([\s\S]*?)\n\s*\}\s*;/);
  assert.ok(cacheMatch, 'rec._lastCritique = { ... } cache literal must be greppable in triggerGeminiCritique');
  const cacheBody = cacheMatch[1];
  assert.ok(/userPrompt\s*:/.test(cacheBody),
    'bug-71: triggerGeminiCritique must cache userPrompt in rec._lastCritique. Without it, retryLastCritique has nothing to fall back to when the user clicks ↻ Retry on an error verdict (the verdict pane textarea is rendered EMPTY on every critique-review broadcast, so the click sends userPrompt:"" — the cache is the only remaining source of truth for the original question).');
});

t('retryLastCritique falls back to last.userPrompt when opts.userPrompt is empty', () => {
  const at = CRITIQUE_JS.search(/async\s+function\s+retryLastCritique\s*\(/);
  assert.ok(at > -1, 'retryLastCritique must exist');
  const body = sliceFn(CRITIQUE_JS, at);
  // The fix must reference last.userPrompt — either as a fallback in
  // the forwarded userPrompt expression, or as a separate read with
  // explicit precedence. Either shape is acceptable; the contract is
  // "cached value is used when opts.userPrompt is empty/missing."
  assert.ok(/last\.userPrompt/.test(body),
    'bug-71: retryLastCritique must read last.userPrompt as the fallback when opts.userPrompt is empty/missing. Pre-fix the forwarded userPrompt was unconditionally taken from opts — empty in (client sends empty textarea) → empty out → original question lost.');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime. Monkey-patch gemini.runCritique to simulate a
// rate-limit then a success. Assert the retry's prompt carries the
// original question even when the client posts userPrompt:''.
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug71-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|attach|agent-session|menu|btw|transcript|artifacts|stageState|critique|critics|runQueue)\.js$/.test(k)) {
    delete require.cache[k];
  }
}

// Seed a session record + plan item, mirroring the bug-75 helper.
function seedSession(sid, itemId) {
  const sessions = require('../server/src/sessions');
  const absCwd = path.join(process.env.MYCO_WORKSPACE, 'tester', sid);
  fs.mkdirSync(absCwd, { recursive: true });
  const item = {
    id: itemId,
    text: 'bug-71 test item — retry must preserve the question',
    layer: 'Bug',
    voters: [], comments: [], runs: [], meta: {},
  };
  const rec = {
    id: sid, user: 'tester', cwd: sid, absCwd,
    artifacts: { plan: { items: [item] } },
  };
  const store = sessions.loadStore();
  store.sessions[sid] = rec;
  sessions.saveStore();
  return { sessions, rec, item };
}

(async () => {
  await tAsync('runtime: triggerGeminiCritique caches userPrompt → retry with empty opts.userPrompt re-uses it', async () => {
    const { EventEmitter } = require('events');
    const sessions = require('../server/src/sessions');
    const critique = require('../server/src/critique');
    const gemini = require('../server/src/critics/gemini');

    const sid = 'myco-tester-bug71aaaa';
    const { item } = seedSession(sid, 'bug-71-runtime');

    const stub = new EventEmitter();
    // Swallow chat/state-update broadcasts so the emit() calls don't
    // throw on missing listeners.
    const broadcasts = [];
    stub.on('chat', (m) => { broadcasts.push({ type: 'chat', m }); });
    stub.on('state-update', (m) => { broadcasts.push({ type: 'state-update', m }); });

    // Capture every prompt passed to the critic.
    const calls = [];
    const origRun = gemini.runCritique;
    gemini.runCritique = async (userPrompt, systemPrompt) => {
      calls.push({ userPrompt, systemPrompt });
      // First call: simulate Gemini rate-limit (looks-like-critic-error
      // matches /failed|...rate.?limit|.../i on a "(...)" envelope).
      if (calls.length === 1) {
        return '(Gemini call failed: rate limit exceeded — quota reached)';
      }
      // Second call: simulate a healthy verdict.
      return '✓ AGREED — reviewed the change and it solves the user-reported problem.';
    };

    try {
      const originalQuestion = 'did you check the offline case? bug-71 cares about this exact text.';

      // ── First fire: user types the question + clicks 💬 Ask Critic ──
      await critique.triggerGeminiCritique(sid, stub, item, '+ console.log("x");', 'I added a log line', {
        isIntermediate: true,
        stage: 'code',
        userPrompt: originalQuestion,
        changedEntries: [],
      });

      // Sanity: first call's prompt must carry the original question.
      assert.strictEqual(calls.length, 1, 'first triggerGeminiCritique must have fired exactly 1 critic call (general-only intermediate)');
      assert.ok(calls[0].userPrompt.includes(originalQuestion),
        'sanity: the first critic-call prompt must include the original question');

      // The first broadcast must be an error verdict carrying the
      // original userPrompt so the verdict pane can render `💬 You
      // asked: ...` above the error body (bug-69 behavior).
      const firstBroadcast = broadcasts.filter(b => b.type === 'state-update' && b.m.kind === 'critique-review').pop();
      assert.ok(firstBroadcast, 'first triggerGeminiCritique must emit a critique-review state-update');
      assert.strictEqual(firstBroadcast.m.isError, true,
        'simulated rate-limit verdict must broadcast isError:true');
      assert.strictEqual(firstBroadcast.m.userPrompt, originalQuestion,
        'first broadcast must surface the original userPrompt for the verdict pane to render the `💬 You asked:` block');

      // ── The fix: rec._lastCritique caches userPrompt ──
      const rec = sessions.getSessionRecord(sid);
      assert.ok(rec && rec._lastCritique, 'rec._lastCritique must be populated after triggerGeminiCritique');
      assert.strictEqual(rec._lastCritique.userPrompt, originalQuestion,
        'bug-71: rec._lastCritique.userPrompt must hold the original question so retryLastCritique can fall back to it when the ↻ Retry click sends an empty textarea (textarea is always re-rendered empty per the bug-53 wiring).');

      // ── Second fire: user clicks ↻ Retry with EMPTY textarea ──
      // This is the exact bug repro: the broadcast's verdict pane was
      // re-rendered fresh (textarea empty), the user clicked ↻ Retry,
      // the client read the empty textarea + POSTed userPrompt:''.
      const result = await critique.retryLastCritique(sid, stub, { userPrompt: '' });
      assert.strictEqual(result, true,
        'retryLastCritique must succeed when there is a valid (non-skipped) cached critique');

      // The retry's critic call must include the ORIGINAL question,
      // recovered from the cache.
      assert.strictEqual(calls.length, 2, 'retryLastCritique must fire exactly 1 additional critic call (general-only intermediate)');
      assert.ok(calls[1].userPrompt.includes(originalQuestion),
        `bug-71: the retry's critic-call prompt must carry the ORIGINAL question recovered from rec._lastCritique.userPrompt. The user typed it once on the first ↻ Ask Critic; the textarea is empty on re-render after the error verdict; the cache is the only surviving source. Pre-fix the retry prompt did NOT contain the question — that's the exact user-reported bug. Got prompt: ${calls[1].userPrompt.slice(0, 200)}`);

      // The retry broadcast must also carry the original userPrompt so
      // the verdict pane re-renders the `💬 You asked:` block.
      const retryBroadcast = broadcasts.filter(b => b.type === 'state-update' && b.m.kind === 'critique-review').pop();
      assert.ok(retryBroadcast && retryBroadcast !== firstBroadcast,
        'retry must emit a fresh critique-review state-update');
      assert.strictEqual(retryBroadcast.m.userPrompt, originalQuestion,
        'bug-71: retry broadcast must surface the recovered userPrompt so the verdict pane still renders the `💬 You asked:` block on the successful retry verdict');
      assert.strictEqual(retryBroadcast.m.isError, false,
        'retry broadcast (simulated success) must NOT be flagged isError');
    } finally {
      gemini.runCritique = origRun;
    }
  });

  await tAsync('runtime: explicit non-empty opts.userPrompt OVERRIDES the cached value (user can re-ask with a different question)', async () => {
    const { EventEmitter } = require('events');
    const sessions = require('../server/src/sessions');
    const critique = require('../server/src/critique');
    const gemini = require('../server/src/critics/gemini');

    const sid = 'myco-tester-bug71bbbb';
    const { item } = seedSession(sid, 'bug-71-runtime-override');

    const stub = new EventEmitter();
    stub.on('chat', () => {});
    stub.on('state-update', () => {});

    const calls = [];
    const origRun = gemini.runCritique;
    gemini.runCritique = async (userPrompt) => {
      calls.push(userPrompt);
      return '✓ AGREED — looks fine.';
    };

    try {
      // Seed _lastCritique with an OLD question.
      await critique.triggerGeminiCritique(sid, stub, item, '+ a;', 'first turn', {
        isIntermediate: true, stage: 'code',
        userPrompt: 'old question that should NOT survive an explicit retry',
        changedEntries: [],
      });
      const rec = sessions.getSessionRecord(sid);
      assert.ok(rec._lastCritique.userPrompt.includes('old question'), 'sanity: cached');

      // User types a NEW question + clicks 💬 Ask Critic.
      await critique.retryLastCritique(sid, stub, {
        userPrompt: 'NEW QUESTION — the explicit value must win over the cached old one',
      });
      assert.strictEqual(calls.length, 2, 'two critic calls (first fire + retry)');
      assert.ok(calls[1].includes('NEW QUESTION'),
        'bug-71: explicit non-empty opts.userPrompt must override the cached last.userPrompt — otherwise a user who wants to re-ask with a different question would be stuck with the old one');
      assert.ok(!calls[1].includes('old question'),
        'bug-71: when the user explicitly provides a new userPrompt, the OLD cached question must NOT appear in the retry prompt');
    } finally {
      gemini.runCritique = origRun;
    }
  });

  // Final summary + exit code.
  console.log(`── bug-71: ${passed} passed, ${failed} failed ──`);
  process.exit(failed === 0 ? 0 : 1);
})();
