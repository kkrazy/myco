// bug-44: Config page not visible on mobile until a session is opened.
//
// User-reported (verbatim, plan-item dispatch):
//   Problem: On mobile, the config page is inaccessible from the
//            default view.
//   Expected: Config page should be reachable on mobile without
//             needing to open a session first.
//   Actual: Config page is hidden on mobile and only appears after
//           clicking into a session.
//
// Root cause (verified by reading the HTML + CSS):
//   - fr-87 wired the only Config-modal entry point to a click on
//     `#user-stamp` (the @login chip in `#status-bar`).
//   - `#status-bar` lives at the BOTTOM of `#sidebar` (last flex
//     child, sibling of `#sidebar-slogan`).
//   - On mobile (≤900px viewport) the sidebar IS the home page —
//     full-screen when no session is open. The chip is technically
//     visible at the bottom of that screen, BUT it sits below the
//     sidebar-slogan and inside a small status row that looks like
//     chrome metadata, not an actionable affordance. Discoverability
//     is poor enough that users (rightly) think the Config page is
//     gated until they pick a session.
//
// Fix:
//   - Add a dedicated `#btn-config` icon button to the sidebar
//     HEADER (next to the existing #btn-admin / #btn-manual icons).
//     Click → openConfigModal(). Visible whenever the user is
//     authenticated; hidden when not (mirrors showUserStamp's
//     state.chatUser gate). The header is always at the top of the
//     sidebar — one-tap from the mobile home view.
//   - The legacy `#user-stamp` click → openConfigModal stays as a
//     secondary entry (existing fr-87 behavior). Don't break it.
//
// Test shape: static-grep guards on index.html + app.js. Pure
// markup/binding change so no runtime behaviour test needed.

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

console.log('── bug-44: mobile Config entry (sidebar-header button) ──');

// ── index.html: button declared inside the sidebar header ──

t('index.html declares #btn-config as a sidebar-header button', () => {
  const html = _read('web/public/index.html');
  // Find the sidebar element + its header block.
  const sidebarAt = html.indexOf('<aside id="sidebar">');
  assert.ok(sidebarAt > 0, 'index.html must declare <aside id="sidebar">');
  const headerStart = html.indexOf('<header>', sidebarAt);
  const headerEnd = html.indexOf('</header>', headerStart);
  assert.ok(headerStart > 0 && headerEnd > headerStart, 'sidebar must contain a <header>…</header> block');
  const headerBody = html.slice(headerStart, headerEnd);
  assert.ok(/id\s*=\s*['"]btn-config['"]/.test(headerBody),
    '#btn-config must live INSIDE the sidebar header — that puts it at the top of the mobile home view, one tap from anywhere.');
});

t('#btn-config has an icon child + aria-label + title (a11y + restyle resilience)', () => {
  const html = _read('web/public/index.html');
  const btnAt = html.indexOf('id="btn-config"');
  assert.ok(btnAt > 0);
  // The button declaration runs through the closing > then any inner
  // content + </button>. Grab a generous slice.
  const sliceStart = html.lastIndexOf('<button', btnAt);
  const sliceEnd = html.indexOf('</button>', btnAt);
  const slice = html.slice(sliceStart, sliceEnd);
  assert.ok(/aria-label\s*=/.test(slice),
    '#btn-config must carry an aria-label for screen readers');
  assert.ok(/title\s*=/.test(slice),
    '#btn-config must carry a title tooltip so the click affordance is discoverable on hover (desktop) + long-press (mobile)');
  assert.ok(/<svg\b/.test(slice),
    '#btn-config must contain an SVG icon child (matches the sidebar-icon-svg pattern used by btn-admin + btn-manual)');
});

// ── app.js: click handler routes to openConfigModal ──

t('app.js binds #btn-config click to openConfigModal()', () => {
  const src = _read('web/public/app.js');
  // The binding can live anywhere — look for a getElementById('btn-config')
  // (or btn-config dataset use) paired with an addEventListener('click', …
  // → openConfigModal).
  const lookupAt = src.indexOf("getElementById('btn-config')");
  const altAt = src.indexOf('"btn-config"');
  assert.ok(lookupAt > 0 || altAt > 0,
    'app.js must reference #btn-config (via getElementById or dataset lookup) to wire its click handler');
  // Window around the lookup must contain both a click handler AND
  // a call to openConfigModal.
  const start = Math.max(lookupAt, altAt);
  const window = src.slice(Math.max(0, start - 200), start + 800);
  assert.ok(/openConfigModal/.test(window),
    '#btn-config click handler must call openConfigModal() — the same entry point fr-87 wired to the @login chip');
});

t('#btn-config visibility is gated on auth (mirrors showUserStamp pattern)', () => {
  const src = _read('web/public/app.js');
  // Either btn-config is hidden by default in HTML and revealed once
  // chatUser is set, OR the show/hide is decided in JS. We accept
  // either shape but require some auth gate so unauth\'d users don\'t
  // see a button that 401s on click.
  const lookupAt = src.indexOf("getElementById('btn-config')");
  const window = src.slice(Math.max(0, lookupAt - 200), lookupAt + 1200);
  assert.ok(/state\.chatUser|chatUser/.test(window) || /hidden\s*=\s*!state\.chatUser/.test(window) || /btn-config[^]*hidden/.test(_read('web/public/index.html')),
    '#btn-config show/hide must be tied to state.chatUser so unauth\'d users don\'t see a dead button (the Config endpoints all require auth and would 401).');
});

// ── bug-44 marker comment so future restyles preserve the affordance ──

t('a comment naming bug-44 explains why #btn-config exists', () => {
  const html = _read('web/public/index.html');
  const btnAt = html.indexOf('id="btn-config"');
  const window = html.slice(Math.max(0, btnAt - 500), btnAt + 500);
  assert.ok(/bug-44/.test(window),
    'a comment in index.html must name bug-44 near #btn-config so a future restyle does not silently drop the sidebar-header Config affordance and re-bury Config under the @login chip in #status-bar.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
