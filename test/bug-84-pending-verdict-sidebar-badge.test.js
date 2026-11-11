// bug-84: verdict modals triggered while the user is working in a
// different session are silently lost.
//
// User report (2026-06-10):
//   "Verdict modal should surface (or be queued/replayed) so the
//    critic stage proceeds without user intervention. Modal never
//    shows up; iteration stalls at 'ready' until the user types
//    'continue', which resumes into Stage 3: Verify."
//
// Root cause: there's no cross-session DISCOVERY surface. The verdict
// is correctly persisted at item.meta.lastCriticReview (fr-98) and
// will replay on next attach to that session — but the user has no
// visible indicator that session A has a pending verdict while they
// work in session B. By the time they notice or switch back, they
// often type "continue" out of impatience instead of waiting for the
// fr-98 replay; "continue" routes to claude (or matches chat-accept)
// and silently advances stages without the user ever seeing the
// verdict modal.
//
// Fix: add a `pendingVerdict` flag to each session record in the
// `GET /sessions` response (polled every 3s by the sidebar). Flag is
// true when ANY plan item has lastCriticReview set AND stageState is
// awaiting_verdict OR awaiting_accept — exactly the condition fr-98
// uses for attach-replay, so the badge and the replay are guaranteed
// to agree. Client renders a distinctive badge in renderSessionList
// when the flag is true. Click navigates to the session (existing
// openSession handler) and fr-98 replays the modal on the fresh
// attach.
//
// Test shape: static guards on the server enrichment + the client
// render + the CSS rule, plus a runtime test that seeds two sessions
// (one with a pending verdict, one without) and asserts the
// enrichment helper produces the right flags.

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

console.log('── bug-84: pending-verdict sidebar badge ──');

const INDEX_JS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const STYLES_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards
// ─────────────────────────────────────────────────────────────────

t('server/src/index.js: GET /sessions enriches each owned session with pendingVerdict', () => {
  // Find the GET /sessions route + enrichment loop.
  const at = INDEX_JS.search(/app\.get\(\s*['"]\/sessions['"]/);
  assert.ok(at > -1, 'GET /sessions route must exist');
  // Look in a wide window after the route opener for both pendingVerdict
  // assignment and the helper that computes it.
  const body = INDEX_JS.slice(at, at + 4000);
  assert.ok(/pendingVerdict/.test(body),
    'bug-84: GET /sessions must enrich each session with a pendingVerdict flag — that\'s the signal the sidebar polls every 3s. Without it, the user has no cross-session indicator that a verdict is waiting.');
});

t('server/src/index.js: pendingVerdict flag mirrors fr-98\'s attach-replay condition', () => {
  // The flag must be true when the same condition fr-98 uses for
  // replay is true — otherwise the badge and the replay would
  // disagree (badge shows but no modal appears on click, or vice
  // versa). fr-98 condition: lastCriticReview set AND stageState
  // status === 'awaiting_verdict' OR 'awaiting_accept'.
  const at = INDEX_JS.search(/pendingVerdict/);
  assert.ok(at > -1);
  // Look at the surrounding ±2000 chars for the helper that computes
  // the flag.
  const window = INDEX_JS.slice(Math.max(0, at - 2000), at + 2000);
  assert.ok(/getLastCriticReview|lastCriticReview/.test(window),
    'bug-84: the pendingVerdict computation must check lastCriticReview (matches fr-98\'s replay precondition).');
  assert.ok(/awaiting_verdict|awaiting_accept/.test(window),
    'bug-84: the pendingVerdict computation must check stageState.status against awaiting_verdict OR awaiting_accept (matches fr-98\'s replay precondition).');
});

t('web/public/app.js: renderSessionList renders a verdict-pending badge when s.pendingVerdict is true', () => {
  // Locate renderSessionList and confirm it references pendingVerdict
  // + produces a distinctive selector for the badge.
  const at = APP_JS.search(/function\s+renderSessionList\s*\(/);
  assert.ok(at > -1, 'renderSessionList must exist');
  const body = sliceFn(APP_JS, at);
  assert.ok(/pendingVerdict/.test(body),
    'bug-84: renderSessionList must read s.pendingVerdict to decide whether to render the badge.');
  assert.ok(/verdict-pending|session-verdict-pending/.test(body),
    'bug-84: renderSessionList must render an element with `verdict-pending` (or `session-verdict-pending`) class — that\'s the visible affordance the user clicks to navigate to the waiting session.');
});

t('web/public/styles.css: .session-verdict-pending (or .verdict-pending) has its own ruleset', () => {
  assert.ok(/\.(session-verdict-pending|verdict-pending)\b\s*\{/.test(STYLES_CSS),
    'bug-84: the verdict-pending badge must have a CSS rule — otherwise it renders as unstyled HTML and the user misses it.');
});

t('a "bug-84" comment marker appears in index.js and app.js for provenance', () => {
  assert.ok(/bug-84/.test(INDEX_JS),
    'bug-84: at least one comment in index.js must name "bug-84" so a future refactor can trace these additions back to the user report.');
  assert.ok(/bug-84/.test(APP_JS),
    'bug-84: at least one comment in app.js must name "bug-84" so a future refactor can trace the renderer addition back to the user report.');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Runtime: seed two sessions and verify the flag matrix
// ─────────────────────────────────────────────────────────────────

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug84-'));
process.env.MYCO_WORKSPACE = path.join(TMP_ROOT, 'wks');
process.env.MYCO_STATE_DIR = path.join(TMP_ROOT, 'state');
process.env.HOME = path.join(TMP_ROOT, 'home');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });

for (const k of Object.keys(require.cache)) {
  if (/server\/src\/(sessions|stageState|attach|critique|artifacts)\.js$/.test(k)) {
    delete require.cache[k];
  }
}

// The helper that computes the flag should be exported from sessions.js
// (or another shared spot) so the GET /sessions route can call it +
// future code can reuse it. Test directly.
t('runtime: hasPendingVerdict helper returns true when item has lastCriticReview + stageState.awaiting_*', () => {
  const sessions = require('../server/src/sessions');
  const helper = sessions.hasPendingVerdict;
  assert.ok(typeof helper === 'function',
    'bug-84: sessions.hasPendingVerdict(rec) must be exported — it computes the pendingVerdict flag used by GET /sessions and is shared with fr-98 for consistency.');
  const rec = {
    id: 'myco-test-pendingyes',
    artifacts: {
      plan: {
        items: [{
          id: 'p1',
          meta: {
            stageState: { stage: 'code', status: 'awaiting_accept', updatedAt: '2026-06-10T00:00:00Z', history: [] },
            lastCriticReview: { kind: 'critique-review', critique: '...', isIntermediate: true },
          },
        }],
      },
    },
  };
  assert.strictEqual(helper(rec), true,
    'bug-84: hasPendingVerdict must return true when an item has lastCriticReview set AND stageState.status is awaiting_accept (mirrors fr-98 replay precondition).');
});

t('runtime: hasPendingVerdict returns true for awaiting_verdict too', () => {
  const sessions = require('../server/src/sessions');
  const rec = {
    artifacts: {
      plan: {
        items: [{
          id: 'p1',
          meta: {
            stageState: { stage: 'analyze', status: 'awaiting_verdict', updatedAt: '...', history: [] },
            lastCriticReview: { kind: 'critique-review' },
          },
        }],
      },
    },
  };
  assert.strictEqual(sessions.hasPendingVerdict(rec), true,
    'bug-84: hasPendingVerdict must return true for awaiting_verdict status too (the brief window between sentinel emit and critic verdict arrival).');
});

t('runtime: hasPendingVerdict returns false when stageState is in_progress', () => {
  const sessions = require('../server/src/sessions');
  const rec = {
    artifacts: {
      plan: {
        items: [{
          id: 'p1',
          meta: {
            stageState: { stage: 'code', status: 'in_progress', updatedAt: '...', history: [] },
            lastCriticReview: { kind: 'critique-review' },
          },
        }],
      },
    },
  };
  assert.strictEqual(sessions.hasPendingVerdict(rec), false,
    'bug-84: hasPendingVerdict must return false when stageState is in_progress — the critique was already resolved or the next stage is underway; no verdict is pending.');
});

t('runtime: hasPendingVerdict returns false when lastCriticReview is absent', () => {
  const sessions = require('../server/src/sessions');
  const rec = {
    artifacts: {
      plan: {
        items: [{
          id: 'p1',
          meta: {
            stageState: { stage: 'analyze', status: 'awaiting_accept', updatedAt: '...', history: [] },
            // no lastCriticReview
          },
        }],
      },
    },
  };
  assert.strictEqual(sessions.hasPendingVerdict(rec), false,
    'bug-84: hasPendingVerdict must return false when lastCriticReview is missing — fr-98 has nothing to replay, so the badge would be misleading.');
});

t('runtime: hasPendingVerdict returns false for a session with no plan items', () => {
  const sessions = require('../server/src/sessions');
  const rec = { artifacts: { plan: { items: [] } } };
  assert.strictEqual(sessions.hasPendingVerdict(rec), false,
    'bug-84: hasPendingVerdict must return false on an empty plan (no items to scan).');
});

t('runtime: hasPendingVerdict returns false for a session with no artifacts', () => {
  const sessions = require('../server/src/sessions');
  assert.strictEqual(sessions.hasPendingVerdict({}), false,
    'bug-84: hasPendingVerdict must tolerate missing artifacts entirely (defensive — old sessions might not have a plan).');
  assert.strictEqual(sessions.hasPendingVerdict(null), false,
    'bug-84: hasPendingVerdict must tolerate null (defensive).');
});

t('runtime: hasPendingVerdict scans ALL plan items, not just the first', () => {
  const sessions = require('../server/src/sessions');
  const rec = {
    artifacts: {
      plan: {
        items: [
          { id: 'first', meta: { stageState: { stage: 'verify', status: 'in_progress' } } },  // no pending
          { id: 'second', meta: {
            stageState: { stage: 'code', status: 'awaiting_accept' },
            lastCriticReview: { kind: 'critique-review' },
          } },                                                                                 // pending
          { id: 'third', meta: {} },
        ],
      },
    },
  };
  assert.strictEqual(sessions.hasPendingVerdict(rec), true,
    'bug-84: hasPendingVerdict must scan ALL items so a pending verdict on any item flips the flag — not just the first item.');
});

console.log(`── bug-84: ${passed} passed, ${failed} failed ──`);
process.exit(failed === 0 ? 0 : 1);
