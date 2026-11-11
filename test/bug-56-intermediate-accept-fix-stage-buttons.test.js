// bug-56: intermediate (stage-checkpoint) verdict pane missing
// ✓ Accept Stage + ⚡ Ask Claude to Fix Stage buttons.
//
// Pre-fix: intermediate state showed only ↻ Retry + ✓ Dismiss
// (+ 💬 Ask Critic from bug-53). No explicit "accept this stage"
// or "redo this stage" affordances. With the §9 3-stage methodology
// (analyze → accept → code → accept → verify → accept), each
// checkpoint needs its own accept/fix paths — Dismiss is semantically
// wrong (means "continue waiting for final critique"); Retry is for
// re-firing the critic.
//
// Fix:
//   1. ✓ Accept Stage button on intermediate verdict — sends Claude
//      a [stage-accept] chat message: "User accepted the {stage}
//      stage. Please proceed to the {next} stage." Routes via
//      sendChatMessage + broadcasts critique-resolved('accept-stage')
//      for cross-device sync. Does NOT call /run/done — only the
//      FINAL critique Accept ends the run (bug-57).
//   2. ⚡ Ask Claude to Fix Stage button on intermediate verdict —
//      sends Claude a [stage-fix] chat message with the critic's
//      flagged issues + "Please redo the {stage} stage."
//      Broadcasts critique-resolved('fix-stage'); does NOT call
//      /run/done (redoing a stage stays in the same run).
//   3. Stage lookup helper _nextStage({analyze:'code', code:'verify',
//      verify:null}) for the Accept-Stage chat message.
//   4. CSS rules for both buttons matching the visual family (green
//      for accept, lavender for fix-stage).
//
// Test shape: static-grep on the locked surface.

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

console.log('── bug-56: intermediate ✓ Accept Stage + ⚡ Ask Claude to Fix Stage buttons ──');

// ── 1. Button HTML in the intermediate actionsHtml branch ──

t('app.js: intermediate branch renders verdict-btn-accept-stage + verdict-btn-fix-stage buttons', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/else\s+if\s*\(\s*isIntermediate\s*\)/);
  assert.ok(at > -1, 'intermediate branch must exist in _renderVerdictPanel.');
  const body = src.slice(at, at + 3000);
  assert.ok(/verdict-btn-accept-stage/.test(body),
    'intermediate actionsHtml must include a verdict-btn-accept-stage button (bug-56 — the missing per-stage accept affordance).');
  assert.ok(/verdict-btn-fix-stage/.test(body),
    'intermediate actionsHtml must include a verdict-btn-fix-stage button (bug-56 — the missing per-stage redo affordance).');
});

t('app.js: Accept Stage button label is "✓ Accept Stage"', () => {
  const src = _read('web/public/app.js');
  assert.ok(/verdict-btn-accept-stage[^>]*>[^<]*✓\s*Accept Stage/.test(src),
    'verdict-btn-accept-stage button text must be "✓ Accept Stage" — clear semantic "accept this stage, proceed to next" (vs. final-state ✓ Accept Claude which ends the run).');
});

t('app.js: Fix Stage button label is "⚡ Ask Claude to Fix Stage"', () => {
  const src = _read('web/public/app.js');
  assert.ok(/verdict-btn-fix-stage[^>]*>[^<]*⚡\s*Ask Claude to Fix Stage/.test(src),
    'verdict-btn-fix-stage button text must be "⚡ Ask Claude to Fix Stage" — distinguishes from final-state ⚡ Ask Claude to Fix (which fixes the final-flagged issues).');
});

// ── 2. Click handlers — Accept Stage ──

t('app.js: Accept Stage click handler sends a [stage-accept] chat message + broadcasts critique-resolved', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/const\s+btnAcceptStage\s*=\s*panel\.querySelector\s*\(\s*['"]\.verdict-btn-accept-stage['"]\s*\)/);
  assert.ok(at > -1, 'app.js must query .verdict-btn-accept-stage via panel.querySelector.');
  const body = src.slice(at, at + 2500);
  assert.ok(/\[stage-accept\]/.test(body),
    'Accept Stage click handler must compose a [stage-accept] chat message — that\'s the explicit advance signal Claude reads on the next turn (bug-56).');
  assert.ok(/sendChatMessage\s*\(/.test(body),
    'Accept Stage handler must call sendChatMessage(...) to dispatch the prompt.');
  assert.ok(/_broadcastCritiqueResolved\s*\(\s*['"]accept-stage['"]\s*\)/.test(body),
    'Accept Stage handler must broadcast critique-resolved(\'accept-stage\') for cross-device sync (bug-54 surface).');
});

t('app.js: Accept Stage handler does NOT call _broadcastRunDone (intermediate accept stays in same run)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/const\s+btnAcceptStage\s*=/);
  // Tight slice — just the Accept Stage handler. A wider window
  // would overlap the Fix Stage handler (no _broadcastRunDone) AND
  // the Discard handler (DOES call _broadcastRunDone, legitimately
  // on final state). Cap at 1500 chars so we stay within Accept
  // Stage's body.
  const body = src.slice(at, at + 1500);
  // bug-57's _broadcastRunDone ends the run + advances the queue.
  // Intermediate accept must NOT trigger that — the run continues to
  // the next stage. Only the FINAL critique Accept ends the run.
  assert.ok(!/_broadcastRunDone\s*\(/.test(body),
    'Accept Stage handler must NOT call _broadcastRunDone — that would prematurely end the multi-stage run. Only the FINAL critique Accept ends the run (bug-57).');
});

// ── 3. Click handlers — Fix Stage ──

t('app.js: Fix Stage click handler sends a [stage-fix] chat message with the critic verdict + broadcasts critique-resolved', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/const\s+btnFixStage\s*=\s*panel\.querySelector\s*\(\s*['"]\.verdict-btn-fix-stage['"]\s*\)/);
  assert.ok(at > -1, 'app.js must query .verdict-btn-fix-stage via panel.querySelector.');
  const body = src.slice(at, at + 2500);
  assert.ok(/\[stage-fix\]/.test(body),
    'Fix Stage click handler must compose a [stage-fix] chat message (bug-56).');
  // The chat message must INCLUDE the critic's verdict — otherwise
  // Claude wouldn't know what to fix.
  assert.ok(/review\.critique/.test(body),
    'Fix Stage handler must include review.critique in the prompt so Claude sees the specific flagged issues.');
  assert.ok(/sendChatMessage\s*\(/.test(body),
    'Fix Stage handler must call sendChatMessage(...) to dispatch the prompt.');
  assert.ok(/_broadcastCritiqueResolved\s*\(\s*['"]fix-stage['"]\s*\)/.test(body),
    'Fix Stage handler must broadcast critique-resolved(\'fix-stage\') for cross-device sync (bug-54).');
});

t('app.js: Fix Stage handler does NOT call _broadcastRunDone (redoing a stage stays in same run)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/const\s+btnFixStage\s*=/);
  // Tight slice — just the handler body. A wider window (2500 chars)
  // overlaps the Discard handler which DOES call _broadcastRunDone
  // (legitimately, on the final state). Cap at 900 chars so we only
  // see this handler's body.
  const body = src.slice(at, at + 900);
  assert.ok(!/_broadcastRunDone\s*\(/.test(body),
    'Fix Stage handler must NOT call _broadcastRunDone — redoing a stage is "stay in the same run." Only the FINAL critique Accept ends the run.');
});

// ── 4. _nextStage helper for the chat message ──

t('app.js: _nextStage helper exists with the analyze → code → verify → null mapping', () => {
  const src = _read('web/public/app.js');
  // The helper must encode the 3-stage progression.
  assert.ok(/_nextStage\s*=\s*\([\s\S]{0,100}\{\s*analyze:\s*['"]code['"]\s*,\s*code:\s*['"]verify['"]\s*,\s*verify:\s*null/.test(src),
    '_nextStage helper must encode { analyze: "code", code: "verify", verify: null } — the 3-stage methodology progression (bug-56). null on verify means "no next stage" — the final critique fires from turn_result.');
});

// ── 5. CSS for the new buttons ──

t('styles.css: .verdict-btn-accept-stage rule exists with green family (matches verdict-btn-accept)', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/\.verdict-btn-accept-stage\s*\{/.test(css),
    '.verdict-btn-accept-stage CSS rule must exist.');
  const at = css.search(/\.verdict-btn-accept-stage\s*\{/);
  const block = css.slice(at, at + 500);
  // The green family is rgba(46, 160, 67, ...) — same as
  // .verdict-btn-accept. Slightly less saturated alpha is fine.
  assert.ok(/rgba\s*\(\s*46\s*,\s*160\s*,\s*67/.test(block),
    '.verdict-btn-accept-stage must use the rgba(46, 160, 67, ...) green family — visually consistent with .verdict-btn-accept so users recognize it as the accept-class action.');
});

t('styles.css: .verdict-btn-fix-stage rule exists with lavender family (matches verdict-btn-fix)', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/\.verdict-btn-fix-stage\s*\{/.test(css),
    '.verdict-btn-fix-stage CSS rule must exist.');
  const at = css.search(/\.verdict-btn-fix-stage\s*\{/);
  const block = css.slice(at, at + 500);
  // The lavender family is rgba(192, 132, 252, ...) — same as
  // .verdict-btn-fix.
  assert.ok(/rgba\s*\(\s*192\s*,\s*132\s*,\s*252/.test(block),
    '.verdict-btn-fix-stage must use the rgba(192, 132, 252, ...) lavender family — visually consistent with .verdict-btn-fix (the claude-directed-action color).');
});

// ── 6. Marker comments ──

t('a comment naming "bug-56" appears in app.js + styles.css', () => {
  const app = _read('web/public/app.js');
  const css = _read('web/public/styles.css');
  assert.ok(/bug-56/.test(app),
    'app.js must carry a bug-56 marker so a future restyle knows the intermediate buttons are intentional.');
  assert.ok(/bug-56/.test(css),
    'styles.css must carry a bug-56 marker for the .verdict-btn-accept-stage + .verdict-btn-fix-stage rulesets.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
