// bug-54: critic-popover stays open after being handled on another
// device/user.
//
// User-reported (verbatim):
//   "Critic popover stays open after being handled on another
//    device/user. Problem: The critic popover can get stuck open
//    even after the underlying item has already been handled
//    elsewhere. Expected: Popover should auto-dismiss when the
//    critic is handled by another user or from another device.
//    Actual: Popover remains visible and actionable despite the
//    critic no longer being open."
//
// Root cause: pre-fix the four "resolving" button handlers (✗ Dismiss
// / ✗ Discard / ⚡ Ask Claude to Fix / ✓ Accept Claude) cleared LOCAL
// state.critiqueReview only — other attached devices stayed showing
// a now-stale verdict pane. The Discard/Fix/Accept paths DID hit the
// server (queue/resume + artifact updates), but their broadcasts
// (`runQueue` / artifact state-updates) didn't carry a signal that
// other clients could interpret as "clear the verdict pane."
// ✗ Dismiss was the worst: server was never notified at all.
//
// Fix:
//   · server/src/critique.js: exports resolveCritique(sessionId,
//     session, { itemId, reason }) — broadcasts
//     `state-update { kind: 'critique-resolved', itemId, reason }`
//     to every attached device.
//   · server/src/index.js: `POST /sessions/:id/critique/resolve`
//     route, viewer-gated, wires the helper.
//   · web/public/app.js: WS dispatcher handles
//     `kind: 'critique-resolved'` by clearing state.critiqueReview +
//     awaitingVerdict + re-rendering (guarded for idempotency —
//     the originating device receives its own broadcast too).
//   · web/public/app.js: each of the 4 resolving button handlers
//     fires a fire-and-forget POST /critique/resolve after its
//     primary action via a shared _broadcastCritiqueResolved helper.
//   · ↻ Retry and 💬 Ask Critic do NOT call resolve — they re-fire
//     the critique, which produces a fresh `critique-review`
//     broadcast that naturally replaces the old verdict.
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

console.log('── bug-54: cross-device verdict-pane sync (critique-resolved broadcast) ──');

// ── 1. Server-side helper + route ──

t('server/src/critique.js: resolveCritique(sessionId, session, opts) helper exists + exported', () => {
  const src = _read('server/src/critique.js');
  assert.ok(/function\s+resolveCritique\s*\(/.test(src),
    'critique.js must declare a resolveCritique helper (the single source of truth for the cross-device sync broadcast).');
  assert.ok(/module\.exports\s*=\s*\{[\s\S]{0,800}resolveCritique/.test(src),
    'critique.js must export resolveCritique so server/src/index.js can wire the route.');
});

t('server/src/critique.js: resolveCritique emits state-update with kind:"critique-resolved" + itemId + reason', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/function\s+resolveCritique\s*\(/);
  const body = src.slice(at, at + 1500);
  assert.ok(/session\.emit\s*\(\s*['"]state-update['"]/.test(body),
    'resolveCritique must call session.emit("state-update", ...) — that\'s the WS broadcast hook every attached client listens on.');
  assert.ok(/kind:\s*['"]critique-resolved['"]/.test(body),
    'the broadcast must carry kind: "critique-resolved" — that\'s the discriminator the client switches on.');
  assert.ok(/itemId/.test(body),
    'the broadcast must include itemId so the client can confirm it\'s the same critique it\'s showing.');
  assert.ok(/reason/.test(body),
    'the broadcast must include `reason` (dismiss/discard/fix/accept) for audit + future debugging.');
});

t('server/src/index.js: POST /sessions/:id/critique/resolve route exists, viewer-gated, calls resolveCritique', () => {
  const src = _read('server/src/index.js');
  assert.ok(/app\.post\s*\(\s*['"]\/sessions\/:id\/critique\/resolve['"]/.test(src),
    'index.js must declare app.post("/sessions/:id/critique/resolve", ...) — the new route bug-54 adds.');
  // Locate the handler body to assert auth + wiring.
  const at = src.search(/app\.post\s*\(\s*['"]\/sessions\/:id\/critique\/resolve['"]/);
  const body = src.slice(at, at + 1500);
  assert.ok(/fileApiPreamble\s*\(\s*req\s*,\s*res\s*,\s*['"]viewer['"]\s*\)/.test(body),
    '/critique/resolve handler must auth via fileApiPreamble(req, res, "viewer") — same tier as /critique/retry; touching the verdict pane is a per-device interaction.');
  assert.ok(/critique\.resolveCritique\s*\(/.test(body),
    '/critique/resolve handler must call critique.resolveCritique(...) — keeps the broadcast logic centralized in critique.js.');
});

// ── 2. Client-side WS dispatcher ──

t('web/public/app.js: WS dispatcher handles `kind: "critique-resolved"` by clearing local verdict pane state', () => {
  const src = _read('web/public/app.js');
  // The handler must look like:
  //   if (msg.kind === 'critique-resolved') {
  //     if (state.awaitingVerdict || state.critiqueReview) {
  //       state.awaitingVerdict = false;
  //       state.critiqueReview = null;
  //       _renderVerdictPanel();
  //       ...
  //     }
  //     return;
  //   }
  assert.ok(/msg\.kind\s*===\s*['"]critique-resolved['"]/.test(src),
    'app.js WS dispatcher must branch on msg.kind === "critique-resolved" — that\'s the cross-device sync handler.');
  // Locate the branch body to assert the guarded clear.
  const at = src.search(/msg\.kind\s*===\s*['"]critique-resolved['"]/);
  const body = src.slice(at, at + 1500);
  assert.ok(/state\.awaitingVerdict\s*=\s*false/.test(body) && /state\.critiqueReview\s*=\s*null/.test(body),
    'critique-resolved handler must clear both state.awaitingVerdict and state.critiqueReview — those are the two flags _renderVerdictPanel reads to decide pane visibility.');
  assert.ok(/_renderVerdictPanel\s*\(\s*\)/.test(body),
    'critique-resolved handler must call _renderVerdictPanel() to hide the pane after clearing state.');
});

t('web/public/app.js: critique-resolved handler is idempotent — guards the clear on `state.awaitingVerdict || state.critiqueReview` being truthy', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/msg\.kind\s*===\s*['"]critique-resolved['"]/);
  const body = src.slice(at, at + 1500);
  // The originating device receives its own broadcast — without a
  // guard, the second clear + re-render is wasted work (or worse,
  // could cause flicker).
  assert.ok(/if\s*\(\s*state\.awaitingVerdict\s*\|\|\s*state\.critiqueReview\s*\)/.test(body),
    'critique-resolved handler must guard the clear on `if (state.awaitingVerdict || state.critiqueReview)` — makes the originating device\'s own broadcast a no-op (idempotency).');
});

// ── 3. Client-side button wiring — 4 resolving buttons fire the helper ──

t('web/public/app.js: _broadcastCritiqueResolved helper exists + POSTs to /critique/resolve with { itemId, reason }', () => {
  const src = _read('web/public/app.js');
  assert.ok(/const\s+_broadcastCritiqueResolved\s*=/.test(src),
    'app.js must declare a _broadcastCritiqueResolved helper inside _renderVerdictPanel so the 4 resolving buttons share one POST shape (DRY).');
  const at = src.search(/const\s+_broadcastCritiqueResolved\s*=/);
  const body = src.slice(at, at + 1500);
  assert.ok(/\/critique\/resolve/.test(body),
    '_broadcastCritiqueResolved must POST to /critique/resolve.');
  assert.ok(/method:\s*['"]POST['"]/.test(body),
    '_broadcastCritiqueResolved must use method: "POST".');
  assert.ok(/itemId:\s*review\.itemId/.test(body),
    '_broadcastCritiqueResolved must include itemId: review.itemId in the POST body so the broadcast can identify which critique was resolved.');
  assert.ok(/reason/.test(body),
    '_broadcastCritiqueResolved must include `reason` in the POST body — passed by each caller (dismiss/discard/fix/accept).');
});

t('web/public/app.js: all 4 resolving buttons (Dismiss / Discard / Fix / Accept) call _broadcastCritiqueResolved with the correct reason', () => {
  const src = _read('web/public/app.js');
  // Each reason string must appear exactly once as a helper-invocation
  // argument, demonstrating all 4 buttons wired.
  const reasons = ['dismiss', 'discard', 'fix', 'accept'];
  for (const reason of reasons) {
    const re = new RegExp(`_broadcastCritiqueResolved\\s*\\(\\s*['"]${reason}['"]\\s*\\)`);
    assert.ok(re.test(src),
      `the ${reason}-button handler must call _broadcastCritiqueResolved('${reason}') so other devices clear their pane when this device handles the verdict (bug-54).`);
  }
});

t('web/public/app.js: ↻ Retry / 💬 Ask Critic do NOT call _broadcastCritiqueResolved (they re-fire the critique, which produces a new broadcast)', () => {
  const src = _read('web/public/app.js');
  // The total number of _broadcastCritiqueResolved sites:
  //   1 helper declaration
  // + 4 final-state buttons (bug-54: dismiss, discard, fix, accept)
  // + 2 intermediate-state buttons (bug-56: accept-stage, fix-stage)
  // = 7 occurrences.
  // ↻ Retry and 💬 Ask Critic still must NOT call this (they re-fire
  // the critique, producing a new critique-review broadcast).
  // bug-56 follow-up: count bumped from 5 to 7 when bug-56 added the
  // intermediate ✓ Accept Stage + ⚡ Ask Claude to Fix Stage buttons
  // — both legitimately broadcast critique-resolved for cross-device
  // sync (the bug-54 surface still works; just two more callers).
  const occurrences = (src.match(/_broadcastCritiqueResolved/g) || []).length;
  assert.strictEqual(occurrences, 7,
    `expected exactly 7 _broadcastCritiqueResolved references (1 helper decl + 4 final-state callers + 2 intermediate-stage callers). Got ${occurrences}. If higher, ↻ Retry or 💬 Ask Critic may have crept in — they should NOT call resolve.`);
});

// ── 4. Marker comments anchor future restyles ──

t('a comment naming "bug-54" appears in critique.js, index.js, and app.js', () => {
  const c = _read('server/src/critique.js');
  const i = _read('server/src/index.js');
  const a = _read('web/public/app.js');
  assert.ok(/bug-54/.test(c), 'critique.js must carry a bug-54 marker (resolveCritique helper).');
  assert.ok(/bug-54/.test(i), 'index.js must carry a bug-54 marker (POST /critique/resolve route).');
  assert.ok(/bug-54/.test(a), 'app.js must carry a bug-54 marker (WS handler + helper + 4 button callers).');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
