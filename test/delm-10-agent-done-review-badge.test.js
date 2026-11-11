// delm-10 stale-working-badge fix regression: "有时候对话都结束了
// session 的 working 图标还在" — the user reported the sidebar's
// "● working" badge lingering after the conversation ended. The
// requested UX: work done → flip to "to review"; user viewed it and
// nothing new → show no icon at all.
//
// Contract (each layer asserted below):
//   1. server: AgentSession stamps this._lastDoneAt on every terminal
//      agent event (turn_result / iteration_aborted / fatal).
//   2. server: GET /sessions enriches owned sessions with
//      s.agentHasReview = (doneAt && seenAt < doneAt).
//   3. server: POST /sessions/:id/viewed stamps rec.agentSeenAt and
//      persists (saveStore); attach (_registerExternalSession) stamps
//      it too — opening the session IS the review.
//   4. client: renderSessionList emits a steady .session-review-badge
//      ("to review", no symbol prefix — redesigned 2026-10-22) when
//      s.agentHasReview is set and NOT busy; the
//      busy badge wins when both are true (a new turn is already
//      running). openSession POSTs /sessions/:id/viewed; a live
//      turn_result on the attached session clears the flag locally.
//   5. styles.css defines .session-review-badge (steady, amber — not
//      the pulsing green working chip).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// 1. AgentSession stamps _lastDoneAt on terminal events (runtime).
const SDK_INSTALLED = (() => {
  try { require.resolve('@anthropic-ai/claude-agent-sdk'); return true; }
  catch { return false; }
})();
let AgentSession = null;
if (SDK_INSTALLED) {
  ({ AgentSession } = require('../server/src/agent-session'));
} else {
  console.log('  ~ _lastDoneAt runtime checks skipped: @anthropic-ai/claude-agent-sdk not installed');
}

if (AgentSession) {
t('_lastDoneAt starts null and is stamped by a turn_result emit', () => {
  const s = new AgentSession('myco-review-test-1');
  assert.strictEqual(s._lastDoneAt, null,
    '_lastDoneAt must start null — no terminal event has landed yet, so no "to review" badge can fire');
  const before = Date.now();
  s._emit({ type: 'turn_result', subtype: 'success' });
  assert.ok(typeof s._lastDoneAt === 'number' && s._lastDoneAt >= before,
    '_emit({type:"turn_result"}) must stamp this._lastDoneAt with Date.now() — this is what GET /sessions reads as doneAt');
});

t('_lastDoneAt is also stamped by iteration_aborted and fatal', () => {
  const s = new AgentSession('myco-review-test-2');
  s._emit({ type: 'assistant_text', text: 'x' });
  assert.strictEqual(s._lastDoneAt, null,
    'non-terminal events (assistant_text) must NOT stamp _lastDoneAt — only turn_result / iteration_aborted / fatal end work');
  s._emit({ type: 'iteration_aborted', reason: 'kill_mid_stream' });
  assert.ok(typeof s._lastDoneAt === 'number',
    'iteration_aborted must stamp _lastDoneAt — an interrupted turn also needs reviewing');
  s._lastDoneAt = null;
  s._emit({ type: 'fatal', error: 'x' });
  assert.ok(typeof s._lastDoneAt === 'number',
    'fatal must stamp _lastDoneAt — a failed turn also needs reviewing');
});
}

// 2-3. Server: GET /sessions enrichment + POST /sessions/:id/viewed.
const indexSrc = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
t('GET /sessions enriches owned sessions with s.agentHasReview (doneAt > seenAt)', () => {
  assert.ok(/s\.agentHasReview\s*=\s*!!\(\s*doneAt\s*&&\s*seenAt\s*<\s*doneAt\s*\)/.test(indexSrc),
    'index.js must set s.agentHasReview = !!(doneAt && seenAt < doneAt) next to the agentBusy enrichment');
});
t('POST /sessions/:id/viewed stamps rec.agentSeenAt + saveStore', () => {
  assert.ok(/app\.post\('\/sessions\/:id\/viewed'/.test(indexSrc),
    'index.js must register POST /sessions/:id/viewed — the client\'s "user opened the session" stamp');
  const route = indexSrc.slice(indexSrc.indexOf("app.post('/sessions/:id/viewed'"));
  assert.ok(/rec\.agentSeenAt\s*=\s*Date\.now\(\)/.test(route),
    'the /viewed route must stamp rec.agentSeenAt = Date.now()');
  assert.ok(/saveStore\(\)/.test(route),
    'the /viewed route must saveStore() so agentSeenAt survives a server restart');
});
t('attach.js stamps rec.agentSeenAt on _registerExternalSession (open = review)', () => {
  const attachSrc = fs.readFileSync(path.join(ROOT, 'server/src/attach.js'), 'utf8');
  assert.ok(/agentSeenAt/.test(attachSrc),
    'attach.js must stamp rec.agentSeenAt when a client attaches — opening the chat IS the review');
});

// 4. Client renders the badge + clears it.
const appSrc = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
t('renderSessionList emits .session-review-badge from s.agentHasReview when not busy', () => {
  assert.ok(/s\.agentHasReview/.test(appSrc),
    'app.js must read s.agentHasReview in renderSessionList');
  assert.ok(/class="session-review-badge"/.test(appSrc),
    'app.js must render the badge with class session-review-badge');
  // Busy wins: the review chip only renders when NOT busy. a8f49c8
  // moved the inline `s.agentBusy ? … : (s.agentHasReview …)` ternary
  // into renderSessionBusyBadge(s) — the precedence contract is the
  // helper's early-return order: the busy branch returns BEFORE the
  // review branch, so a session that is BOTH done-unreviewed and
  // newly working shows "working".
  const helperAt = appSrc.indexOf('function renderSessionBusyBadge(s)');
  assert.ok(helperAt > -1, 'renderSessionBusyBadge helper must exist (a8f49c8 refactor of the inline ternary)');
  const helperSrc = appSrc.slice(helperAt, helperAt + 800);
  const busyBranch = helperSrc.indexOf('if (s.agentBusy)');
  const reviewBranch = helperSrc.indexOf('if (s.agentHasReview)');
  assert.ok(busyBranch > -1 && reviewBranch > busyBranch,
    'inside renderSessionBusyBadge the busy branch must come BEFORE the review branch — a session that is BOTH done-unreviewed and newly working must show "working"');
});
t('openSession POSTs /sessions/:id/viewed so opening clears the badge', () => {
  assert.ok(/\/viewed/.test(appSrc),
    'app.js must POST /sessions/:id/viewed from openSession');
});
t('live turn_result on the attached session clears agentHasReview locally', () => {
  const m = appSrc.match(/if \(cur && cur\.agentHasReview\) \{ cur\.agentHasReview = false; renderSessionList\(\); \}/);
  assert.ok(m,
    'a turn_result arriving on the attached session must clear agentHasReview — the user watched the turn end, no "to review" flip');
});

// 5. CSS.
const cssSrc = fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');
t('styles.css defines the steady amber .session-review-badge', () => {
  assert.ok(/\.session-review-badge\s*\{/.test(cssSrc),
    'styles.css must define .session-review-badge');
  const block = cssSrc.slice(cssSrc.indexOf('.session-review-badge'));
  assert.ok(!/animation:/.test(block.slice(0, block.indexOf('}'))),
    '.session-review-badge must be steady (no pulse animation) — the work is DONE, this is an inbox-style marker, not an activity indicator');
});

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} passed`);
process.exit(failed ? 1 : 0);
