// bug-72: no way to reopen verdict modal after clicking ✗ Dismiss.
//
// User report (2026-06-07):
//   "Once the verdict modal is dismissed, there's no affordance to
//    bring it back. Expected: a control to re-open the verdict modal
//    after dismissal. Actual: clicking Dismiss closes the modal
//    permanently with no way to reopen it."
//
// Root cause: the btnDismiss handler (app.js ~L8243) sets
// `state.critiqueReview = null` and re-renders an empty
// `#composer-verdict-pane` — the local verdict body is gone with no
// way to recover it short of a page refresh (which would trigger
// fr-98's attach-replay if stageState is still pending; that's the
// only escape hatch today, and it's neither discoverable nor live).
//
// Server side: NO CHANGES NEEDED. Both rec._lastCritique (the retry
// cache) and item.meta.lastCriticReview (fr-98 persistence) survive
// a Dismiss — resolveCritique in critique.js only clears them for
// accept-stage / fix-stage. So the data is already there; we just
// need a client-side affordance to bring back the LOCAL copy we
// captured at Dismiss time.
//
// Fix (client-side only):
//   1. Dismiss handler snapshots `state.lastDismissedVerdict = review`
//      BEFORE nulling `state.critiqueReview`.
//   2. `_renderVerdictPanel` renders a compact `↻ Reopen verdict`
//      pill inside `#composer-verdict-pane` when `lastDismissedVerdict`
//      is set AND `critiqueReview` is null (instead of hiding the
//      panel entirely).
//   3. Pill click handler restores `state.critiqueReview =
//      state.lastDismissedVerdict`, calls `_renderVerdictPanel()`,
//      clears `state.lastDismissedVerdict`.
//   4. The `critique-review` WS message handler (where
//      `state.critiqueReview = msg` is set on a fresh broadcast) also
//      clears `state.lastDismissedVerdict` — a newer verdict makes
//      the prior dismissed one stale.
//
// Test shape: static-grep guards on app.js. Mirrors bug-53 / bug-71's
// approach for client-side wiring tests (no JSDOM, no browser
// runtime — tests are pure source-string asserts).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-72: reopen dismissed verdict modal ──');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

// ── 1. Dismiss handler snapshots the verdict before nulling ──

t('app.js: btnDismiss click handler snapshots state.lastDismissedVerdict BEFORE nulling state.critiqueReview', () => {
  // Find the btnDismiss click handler — it's the .verdict-btn-dismiss
  // handler inside _renderVerdictPanel. Locate it by position
  // (avoiding the §10.b hand-picked-N anti-pattern — comments can
  // push the handler body past any fixed window).
  const renderAt = APP_JS.search(/function\s+_renderVerdictPanel\s*\(\)/);
  assert.ok(renderAt > -1, '_renderVerdictPanel must exist');
  const body = sliceFn(APP_JS, renderAt);
  // Anchor on the btnDismiss addEventListener('click', ...) call.
  const handlerAt = body.search(/btnDismiss\.addEventListener\(\s*['"]click['"]/);
  assert.ok(handlerAt > -1, 'btnDismiss click handler must be greppable');
  // Look for the next btnAcceptStage anchor as the upper bound — that's
  // the next nested handler block. Falls back to a wide tail if absent.
  const nextHandlerAt = body.indexOf('btnAcceptStage', handlerAt);
  const dismissBody = body.slice(handlerAt, nextHandlerAt > -1 ? nextHandlerAt : handlerAt + 4000);
  // Both assignments must appear, and the snapshot must precede the null.
  const snapAt = dismissBody.search(/state\.lastDismissedVerdict\s*=/);
  const nullAt = dismissBody.search(/state\.critiqueReview\s*=\s*null/);
  assert.ok(snapAt > -1,
    'bug-72: btnDismiss handler must assign state.lastDismissedVerdict = review (or equivalent) so the Reopen pill has something to restore. Without this snapshot, the verdict body is gone the instant the user clicks ✗ Dismiss.');
  assert.ok(nullAt > -1, 'state.critiqueReview = null assignment must still exist');
  assert.ok(snapAt < nullAt,
    'bug-72: state.lastDismissedVerdict assignment MUST happen BEFORE state.critiqueReview = null — otherwise the snapshot reads the already-nulled value and the Reopen pill gets nothing to restore.');
});

// ── 2. _renderVerdictPanel renders a pill when there's a dismissed
//      verdict and no active review ──

t('app.js: _renderVerdictPanel renders a verdict-reopen-pill when state.lastDismissedVerdict && !state.critiqueReview', () => {
  const renderAt = APP_JS.search(/function\s+_renderVerdictPanel\s*\(\)/);
  assert.ok(renderAt > -1);
  const body = sliceFn(APP_JS, renderAt);
  // Must reference both the dismissed-verdict cache AND a pill HTML
  // class so the static guard is robust against minor template
  // changes.
  assert.ok(/state\.lastDismissedVerdict/.test(body),
    'bug-72: _renderVerdictPanel must read state.lastDismissedVerdict to decide whether to render the Reopen pill.');
  assert.ok(/verdict-reopen-pill/.test(body),
    'bug-72: _renderVerdictPanel must render an element with the verdict-reopen-pill class — this is the visible Reopen affordance the user clicks to bring the dismissed verdict back.');
});

t('app.js: the Reopen pill shows stage + itemId so the user knows WHICH verdict they\'re restoring', () => {
  const renderAt = APP_JS.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = sliceFn(APP_JS, renderAt);
  // Find the pill HTML block (the innerHTML / template string that
  // contains verdict-reopen-pill).
  const pillMatch = body.match(/verdict-reopen-pill[\s\S]{0,800}/);
  assert.ok(pillMatch, 'pill HTML block must be greppable');
  const pillHtml = pillMatch[0];
  // Stage (CHECKPOINT: code, etc.) AND itemId should be visible in
  // the pill so the user knows which verdict will come back.
  assert.ok(/stage|stageLabel|CHECKPOINT/i.test(pillHtml),
    'bug-72: the Reopen pill must surface the verdict\'s stage so the user knows which checkpoint they\'re reopening (analyze / code / verify / final).');
  assert.ok(/itemId/.test(pillHtml),
    'bug-72: the Reopen pill must include the itemId — when multiple plan items have run in the session, the user needs to know which item\'s verdict they\'re bringing back.');
});

// ── 3. Pill click handler restores the verdict + re-renders ──

t('app.js: clicking the Reopen pill restores state.critiqueReview from state.lastDismissedVerdict', () => {
  const renderAt = APP_JS.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = sliceFn(APP_JS, renderAt);
  // Find the reopen click handler — search for verdict-reopen-pill
  // selector followed by an addEventListener('click', ...).
  const reopenMatch = body.match(/verdict-reopen-pill[\s\S]{0,2000}?addEventListener\(\s*['"]click['"][\s\S]{0,800}?\}/);
  assert.ok(reopenMatch,
    'bug-72: there must be a click handler wired to the verdict-reopen-pill element. Without a handler, the pill is dead UI.');
  const handler = reopenMatch[0];
  // The handler must do the inverse of Dismiss:
  //   - Restore state.critiqueReview = state.lastDismissedVerdict
  //   - Set state.awaitingVerdict = true (Dismiss cleared this too)
  //   - Re-render
  //   - Clear state.lastDismissedVerdict (consumed)
  assert.ok(/state\.critiqueReview\s*=\s*state\.lastDismissedVerdict/.test(handler) ||
            /state\.critiqueReview\s*=\s*[a-zA-Z_$]+;[\s\S]{0,200}lastDismissedVerdict/.test(handler) ||
            /lastDismissedVerdict[\s\S]{0,200}state\.critiqueReview\s*=/.test(handler),
    'bug-72: the Reopen click handler must restore state.critiqueReview from the cached state.lastDismissedVerdict.');
  assert.ok(/state\.awaitingVerdict\s*=\s*true/.test(handler),
    'bug-72: the Reopen click handler must re-set state.awaitingVerdict = true — Dismiss cleared it, and _renderVerdictPanel hides the pane when awaitingVerdict is falsy.');
  assert.ok(/_renderVerdictPanel\s*\(/.test(handler),
    'bug-72: the Reopen click handler must call _renderVerdictPanel() to actually paint the restored pane.');
  assert.ok(/state\.lastDismissedVerdict\s*=\s*null/.test(handler),
    'bug-72: the Reopen click handler must clear state.lastDismissedVerdict after consuming it — otherwise a future Dismiss would leave a stale pill.');
});

// ── 4. The critique-review broadcast handler clears the dismissed
//      cache so a newer verdict doesn't leave a stale pill ──

t('app.js: the critique-review msg handler clears state.lastDismissedVerdict on a fresh broadcast', () => {
  // Anchor on the state.critiqueReview = msg assignment in the
  // broadcast handler. Then look within a generous window AROUND it
  // for the lastDismissedVerdict clear. Wide window deliberately —
  // future comment churn shouldn't break this (§10.b lesson).
  const wideIdx = APP_JS.search(/state\.critiqueReview\s*=\s*msg;/);
  assert.ok(wideIdx > -1,
    'state.critiqueReview = msg assignment must exist in the broadcast handler');
  const window_ = APP_JS.slice(Math.max(0, wideIdx - 400), wideIdx + 1500);
  assert.ok(/state\.lastDismissedVerdict\s*=\s*null/.test(window_),
    'bug-72: the critique-review handler must clear state.lastDismissedVerdict when a fresh broadcast lands. A newer verdict makes the prior dismissed one stale; leaving the pill around would let the user "reopen" something that\'s been superseded.');
});

// ── 5. CSS: the pill has its own ruleset (visible affordance, not a
//      blob of unstyled HTML) ──

t('styles.css: .verdict-reopen-pill has a ruleset distinct from .verdict-btn-* (compact pill, not a full button)', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
  assert.ok(/\.verdict-reopen-pill\s*\{/.test(css),
    'bug-72: .verdict-reopen-pill must have a CSS ruleset so the affordance has a defined visual style — without it the pill renders as unstyled HTML and users will miss it.');
});

// ── 6. Marker comment present in app.js for provenance ──

t('app.js: a "bug-72" comment marker appears so future refactors can trace the change back', () => {
  assert.ok(/bug-72/.test(APP_JS),
    'bug-72: at least one comment in app.js must name "bug-72" so a future refactor or restyle can trace these additions back to the user report.');
});

console.log(`── bug-72: ${passed} passed, ${failed} failed ──`);
process.exit(failed === 0 ? 0 : 1);
