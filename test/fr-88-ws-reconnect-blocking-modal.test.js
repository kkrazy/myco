// fr-88: full-viewport blocking modal during WS reconnect.
//
// Pre-fr-88 the #conn-overlay was a floating pill scoped to
// #terminal-pane with `pointer-events:none` — visible but not blocking,
// so the user could keep clicking the chat input + sidebar while the
// session was actually offline (queued frames would silently buffer
// or get dropped depending on the action). Per user request the
// reconnect window now shows a full-viewport dimmed modal that blocks
// all interaction until the WS comes back. Initial-connect UX
// (page load / session switch) keeps the lighter floating pill.
//
// Contract:
//   - showConnOverlay accepts a 4th `blocking` arg (default false).
//   - When blocking=true, #conn-overlay gets the `.blocking` class.
//   - hideConnOverlay() removes `.blocking` so a subsequent non-
//     blocking show doesn't inherit a stuck backdrop.
//   - styles.css defines #conn-overlay.blocking with: position:fixed,
//     a backdrop color, pointer-events:auto (block clicks), and a
//     high z-index so it sits above the rest of the chrome.
//   - The WS close→reconnect call site passes blocking=true.
//   - The two initial-connect call sites do NOT pass blocking (so
//     first-page-load / session-switch still see the lighter pill).
//
// Test shape mirrors admin-delegation.test.js / fr-87-share-slash-
// command.test.js: pure-logic + static-grep guards on prod sources.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ── Pure-logic helper: a minimal DOM mock that mirrors the surface
// showConnOverlay / hideConnOverlay touch (classList toggle/remove,
// hidden attr). Lets us verify the blocking arg flips the class
// correctly without spinning up jsdom. ──

function makeFakeOverlay() {
  const classes = new Set();
  return {
    hidden: true,
    classList: {
      toggle(cls, force) {
        const want = (typeof force === 'boolean') ? force : !classes.has(cls);
        if (want) classes.add(cls); else classes.delete(cls);
        return want;
      },
      remove(cls) { classes.delete(cls); },
      contains(cls) { return classes.has(cls); },
    },
    querySelector() { return { textContent: '', classList: { toggle() {} } }; },
    // Helper: introspect for assertions
    _classes: () => Array.from(classes).sort(),
  };
}

// Re-implementation of show/hide that the prod code follows. Lets us
// exercise the show/hide contract without requiring jsdom or webpack.
function showOverlay(overlay, text, kind, sub, blocking) {
  if (!overlay) return;
  overlay.classList.toggle('blocking', !!blocking);
  overlay.hidden = false;
}
function hideOverlay(overlay) {
  if (!overlay) return;
  overlay.classList.remove('blocking');
  overlay.hidden = true;
}

console.log('── fr-88: WS reconnect blocking modal ──');

t('showOverlay(blocking=false) does NOT add .blocking class', () => {
  const o = makeFakeOverlay();
  showOverlay(o, 'Connecting', null, 'Establishing…');           // default: blocking omitted
  assert.strictEqual(o.hidden, false);
  assert.deepStrictEqual(o._classes(), []);
});

t('showOverlay(blocking=true) adds .blocking class', () => {
  const o = makeFakeOverlay();
  showOverlay(o, 'Reconnecting', null, 'Restoring…', true);
  assert.strictEqual(o.hidden, false);
  assert.deepStrictEqual(o._classes(), ['blocking']);
});

t('hideOverlay() removes .blocking class (clears stuck backdrop)', () => {
  const o = makeFakeOverlay();
  showOverlay(o, 'Reconnecting', null, 'Restoring…', true);
  assert.deepStrictEqual(o._classes(), ['blocking']);             // sanity
  hideOverlay(o);
  assert.strictEqual(o.hidden, true);
  assert.deepStrictEqual(o._classes(), []);                       // class gone
});

t('show→hide→show(non-blocking) does not leak the blocking class', () => {
  const o = makeFakeOverlay();
  showOverlay(o, 'Reconnecting', null, 'Restoring…', true);
  hideOverlay(o);
  showOverlay(o, 'Connecting', null, 'Establishing…');            // blocking omitted
  assert.strictEqual(o.hidden, false);
  assert.deepStrictEqual(o._classes(), []);                       // no leaked .blocking
});

t('showOverlay(blocking=false) explicitly removes a prior .blocking class', () => {
  const o = makeFakeOverlay();
  // Simulate stale .blocking class left over from a prior show
  o.classList.toggle('blocking', true);
  showOverlay(o, 'Connecting', null, 'Establishing…', false);
  assert.deepStrictEqual(o._classes(), []);                       // toggle(false) removed it
});

// ── Static-grep guards on prod source ──

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: styles.css defines #conn-overlay.blocking with full-viewport + click-blocking properties', () => {
  const src = _read('web/public/styles.css');
  const rule = src.indexOf('#conn-overlay.blocking');
  assert.ok(rule > 0, 'styles.css must define #conn-overlay.blocking');
  const window = src.slice(rule, rule + 700);
  assert.ok(/position:\s*fixed/.test(window),
    '#conn-overlay.blocking must use position:fixed (full viewport, not scoped to parent)');
  assert.ok(/pointer-events:\s*auto/.test(window),
    '#conn-overlay.blocking must set pointer-events:auto so clicks on the backdrop are intercepted');
  assert.ok(/background:|rgba\(/.test(window),
    '#conn-overlay.blocking must paint a backdrop color (dim) so the modal reads as blocking');
  assert.ok(/z-index/.test(window),
    '#conn-overlay.blocking must set a high z-index so the modal sits above other chrome');
});

t('static guard: app.js showConnOverlay signature accepts the blocking arg', () => {
  const src = _read('web/public/app.js');
  assert.ok(/function\s+showConnOverlay\s*\(\s*text\s*,\s*kind\s*,\s*sub\s*,\s*blocking\s*\)/.test(src),
    'showConnOverlay must declare (text, kind, sub, blocking) signature');
});

t('static guard: showConnOverlay toggles the .blocking class', () => {
  const src = _read('web/public/app.js');
  const fnStart = src.indexOf('function showConnOverlay');
  const fnEnd = src.indexOf('function hideConnOverlay');
  const body = src.slice(fnStart, fnEnd);
  assert.ok(/classList\.toggle\(\s*['"]blocking['"]\s*,\s*!!blocking\s*\)/.test(body),
    "showConnOverlay must call overlay.classList.toggle('blocking', !!blocking)");
});

t('static guard: hideConnOverlay clears the .blocking class', () => {
  const src = _read('web/public/app.js');
  const fnStart = src.indexOf('function hideConnOverlay');
  const fnEnd = fnStart + 600;
  const body = src.slice(fnStart, fnEnd);
  assert.ok(/classList\.remove\(\s*['"]blocking['"]\s*\)/.test(body),
    "hideConnOverlay must call overlay.classList.remove('blocking') so subsequent non-blocking shows don't inherit it");
});

t('static guard: close→reconnect site passes blocking=true', () => {
  const src = _read('web/public/app.js');
  // Find the close handler in the connect closure
  const closeAt = src.indexOf("ws.addEventListener('close'");
  assert.ok(closeAt > 0, 'app.js must wire ws.addEventListener("close", …)');
  // Window covers the whole close handler. Bumped from 800 → 2400 in
  // fr-88r: that fix added a ~25-line bailout block (handshake-failure
  // detection + non-blocking "Cannot connect" overlay) BEFORE the
  // Reconnecting-overlay call, pushing the relevant `, true)` past the
  // old 800-char window. The new size covers the full handler body
  // (~1900 chars currently) with headroom for future inserts.
  const window = src.slice(closeAt, closeAt + 2400);
  assert.ok(/showConnOverlay\([^)]*Reconnecting[^)]*,\s*true\s*\)/.test(window),
    'The close→reconnect call site must pass blocking=true to showConnOverlay (look for the "Reconnecting" call specifically — fr-88r added a separate non-blocking "Cannot connect" call EARLIER in the handler for the handshake-failure bailout, but that one MUST stay false to allow recovery)');
  assert.ok(/Reconnecting/.test(window),
    'The close→reconnect call site must still use the "Reconnecting" label');
});

t('static guard: initial-connect call sites do NOT pass blocking=true (preserve floating-pill UX)', () => {
  const src = _read('web/public/app.js');
  // The two initial-connect sites are: (1) the openSession-level show
  // before connect() is invoked; (2) the show at the top of connect()
  // itself. Both currently read showConnOverlay('Connecting', null, 'Establishing session…').
  // Make sure NEITHER is followed by a `, true`.
  const matches = [...src.matchAll(/showConnOverlay\('Connecting'[^)]*\)/g)];
  assert.ok(matches.length >= 2,
    `expected ≥2 initial-connect showConnOverlay('Connecting', …) call sites; found ${matches.length}`);
  for (const m of matches) {
    assert.ok(!/,\s*true\s*\)$/.test(m[0]),
      `initial-connect call site must NOT pass blocking=true (got: ${m[0]})`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
