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

// bug-44 contract: "Config page must be reachable from the mobile
// home view (sidebar header) without opening a session first." The
// IMPLEMENTATION of that contract moved across rounds:
//   · bug-44 original (commit be3eb91): #btn-config (user-cog)
//   · fr-87 r4 (commit TBD): #btn-config retired; gear #btn-admin
//     is now the single Config icon (per user request to merge the
//     user-config and admin-config icons).
// The contract is unchanged; the guards below track the current
// shape (#btn-admin in the sidebar header, click opens Config modal,
// visibility gated on auth).

t('index.html declares a sidebar-header Config affordance (post-r4: #btn-admin)', () => {
  const html = _read('web/public/index.html');
  const sidebarAt = html.indexOf('<aside id="sidebar">');
  assert.ok(sidebarAt > 0, 'index.html must declare <aside id="sidebar">');
  const headerStart = html.indexOf('<header>', sidebarAt);
  const headerEnd = html.indexOf('</header>', headerStart);
  assert.ok(headerStart > 0 && headerEnd > headerStart, 'sidebar must contain a <header>…</header> block');
  const headerBody = html.slice(headerStart, headerEnd);
  // Either #btn-admin (post-fr-87 r4 single icon) OR #btn-config
  // (legacy bug-44 shape). The contract is "an icon in the sidebar
  // header opens Config" — selector specifics moved across rounds.
  assert.ok(/id\s*=\s*['"]btn-admin['"]/.test(headerBody) || /id\s*=\s*['"]btn-config['"]/.test(headerBody),
    'sidebar header must contain a Config-icon button (#btn-admin post-fr-87 r4, or legacy #btn-config) — that puts the affordance at the top of the mobile home view, one tap from anywhere.');
});

t('the Config-icon button has an icon child + aria-label + title (a11y + restyle resilience)', () => {
  const html = _read('web/public/index.html');
  // Find whichever button id is the live Config affordance.
  const btnIdMatch = html.match(/id="(btn-admin|btn-config)"/);
  assert.ok(btnIdMatch, 'one of #btn-admin or #btn-config must exist in index.html as the Config-icon button');
  const btnAt = html.indexOf(btnIdMatch[0]);
  const sliceStart = html.lastIndexOf('<button', btnAt);
  const sliceEnd = html.indexOf('</button>', btnAt);
  const slice = html.slice(sliceStart, sliceEnd);
  assert.ok(/aria-label\s*=/.test(slice),
    'the Config-icon button must carry an aria-label for screen readers');
  assert.ok(/title\s*=/.test(slice),
    'the Config-icon button must carry a title tooltip so the click affordance is discoverable on hover + long-press');
  assert.ok(/<svg\b/.test(slice),
    'the Config-icon button must contain an SVG icon child (matches the sidebar-icon-svg pattern)');
});

t('app.js binds the Config-icon click to openConfigModal()', () => {
  const src = _read('web/public/app.js');
  // Find the SOMEWHERE in app.js that wires a click on the Config
  // icon → openConfigModal. We accept either btn-admin OR btn-config
  // as the selector.
  const adminClick = src.match(/btn-admin[\s\S]{0,2000}addEventListener\s*\(\s*['"]click['"][\s\S]{0,500}openConfigModal/);
  const configClick = src.match(/btn-config[\s\S]{0,2000}addEventListener\s*\(\s*['"]click['"][\s\S]{0,500}openConfigModal/);
  assert.ok(adminClick || configClick,
    'app.js must wire a click handler on the Config-icon button (#btn-admin or #btn-config) that calls openConfigModal()');
});

t('the Config-icon visibility is gated on auth (state.chatUser)', () => {
  const src = _read('web/public/app.js');
  // The visibility logic must reference state.chatUser somewhere
  // adjacent to the Config-icon binding. We're tolerant about which
  // button id is used.
  const adminGate = /btn-admin[\s\S]{0,2000}state\.chatUser/.test(src);
  const configGate = /btn-config[\s\S]{0,2000}state\.chatUser/.test(src);
  assert.ok(adminGate || configGate,
    'Config-icon visibility must be tied to state.chatUser so unauth\'d users don\'t see a dead button (the Config endpoints all require auth and would 401).');
});

t('a comment naming bug-44 or fr-87 r4 explains why the sidebar-header Config affordance exists', () => {
  const html = _read('web/public/index.html');
  // Either bug-44 (original) OR fr-87 r4 (current shape) must be
  // named near the Config-icon button — the marker survives future
  // restyles so a refactor doesn\'t silently drop the affordance.
  assert.ok(/bug-44|fr-87\s*r4/i.test(html),
    'a comment in index.html must name bug-44 or fr-87 r4 near the sidebar-header Config affordance so a future restyle does not silently drop it and re-bury Config under the @login chip in #status-bar.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
