// fr-87 r4: single config icon.
//
// User-reported (verbatim):
//   "System config and user config should merge and both bring up
//    using the config icon, remove the user config icon"
//
// Background: fr-87 r2 merged the admin pane's settings into the
// user-facing Config modal (#config-modal). Until r4 there were TWO
// sidebar-header icons that both led to "config":
//   · #btn-admin (gear)     — opened the standalone #admin-wrap pane
//   · #btn-config (user-cog) — opened the Config modal (bug-44 fix)
// The user wants one icon. #btn-config (the user-cog) is removed;
// the gear (#btn-admin) is repurposed to be THE config icon — it
// now opens the Config modal (which carries the unified PATs +
// admin merge), and is visible to any authenticated user (not just
// admins, because the modal\'s PAT section is for everyone).
//
// The standalone #admin-wrap pane is intentionally orphaned by this
// change (no UI entry). Markup stays for now; a future cleanup pass
// can yank it. Calling that out so a refactorer doesn\'t panic at
// the dead code.

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

console.log('── fr-87 r4: single config icon ──');

// ── #btn-config is gone ──

t('index.html: #btn-config is removed', () => {
  const html = _read('web/public/index.html');
  assert.ok(!/id\s*=\s*['"]btn-config['"]/.test(html),
    'index.html must NOT declare #btn-config — fr-87 r4 retired it in favour of #btn-admin as the single config icon.');
});

t('app.js: showUserStamp no longer references btn-config', () => {
  const src = _read('web/public/app.js');
  const fnAt = src.indexOf('function showUserStamp');
  assert.ok(fnAt > 0);
  const window = src.slice(fnAt, fnAt + 1500);
  assert.ok(!/btn-config/.test(window),
    'showUserStamp must NOT reference btn-config anymore — that element was removed in fr-87 r4 and the click target moved to #btn-admin.');
});

// ── #btn-admin repurposed as the single config icon ──

t('index.html: #btn-admin tooltip/aria-label mentions Config (not just Admin Settings)', () => {
  const html = _read('web/public/index.html');
  const btnAt = html.indexOf('id="btn-admin"');
  assert.ok(btnAt > 0);
  const sliceStart = html.lastIndexOf('<button', btnAt);
  const sliceEnd = html.indexOf('</button>', btnAt);
  const slice = html.slice(sliceStart, sliceEnd + 1);
  // Either title or aria-label must now mention "Config" since the
  // gear now opens the Config modal (PATs + admin merge), not the
  // legacy "Admin Settings" pane.
  assert.ok(/title\s*=\s*['"][^'"]*[Cc]onfig[^'"]*['"]/.test(slice)
         || /aria-label\s*=\s*['"][^'"]*[Cc]onfig[^'"]*['"]/.test(slice),
    '#btn-admin\'s title or aria-label must mention "Config" so the affordance reflects what it actually opens (Config modal, not standalone admin pane).');
});

t('app.js: #btn-admin click handler calls openConfigModal (not toggleAdminPane)', () => {
  const src = _read('web/public/app.js');
  // Find every reference to btn-admin in app.js. The CURRENT click
  // binding must call openConfigModal. We accept either an inline
  // click handler that includes openConfigModal, or a binding via
  // a function name that\'s clearly the config opener.
  const adminClickAt = src.search(/btn-admin[\s\S]{0,1000}addEventListener\s*\(\s*['"]click['"]/);
  assert.ok(adminClickAt > -1, 'app.js must wire a click handler on #btn-admin');
  const window = src.slice(adminClickAt, adminClickAt + 800);
  assert.ok(/openConfigModal/.test(window),
    '#btn-admin click handler must call openConfigModal so clicking the gear opens the Config modal (the single merged surface for both user PATs and system-wide admin settings).');
  // Defensive: the same handler MUST NOT also call toggleAdminPane
  // (which is the standalone #admin-wrap entry). Allow the function
  // toggleAdminPane to still EXIST in the file — orphaned but not
  // breaking anything — but the gear must not invoke it.
  assert.ok(!/toggleAdminPane\s*\(/.test(window),
    '#btn-admin click handler must NOT call toggleAdminPane — the standalone #admin-wrap pane is orphaned by fr-87 r4 and the gear should route to the merged Config modal instead.');
});

t('app.js: #btn-admin visibility tied to state.chatUser (any authed user)', () => {
  const src = _read('web/public/app.js');
  // Find the place that toggles btn-admin\'s hidden attribute. It
  // must be driven by auth status (state.chatUser) — NOT by the
  // hardcoded admin login list, because the Config modal\'s PAT
  // section is for every authenticated user.
  // Budget 1500: the bindAdminUi rewrite carries an explanatory
  // comment block (~700 chars) between the getElementById('btn-admin')
  // and the first `hidden` reference. The literal distance is ~950
  // chars currently; 1500 gives headroom for future comments.
  const adminVisibleAt = src.search(/btn-admin[\s\S]{0,1500}hidden/);
  assert.ok(adminVisibleAt > -1, 'app.js must have a place that toggles #btn-admin\'s hidden attribute');
  const window = src.slice(Math.max(0, adminVisibleAt - 200), adminVisibleAt + 1500);
  assert.ok(/state\.chatUser|chatUser/.test(window),
    '#btn-admin\'s visibility must be tied to state.chatUser so it shows for any authenticated user (not just the hardcoded labxnow|kkrazy|ryan-blues admin set — that gate now only governs the admin section INSIDE the Config modal, via the server\'s /api/admin/config 200 vs 403 probe).');
});

// ── #admin-wrap is orphaned (no remaining UI entry) ──

t('app.js: no other UI element opens #admin-wrap pane after r4', () => {
  const src = _read('web/public/app.js');
  // toggleAdminPane may still exist as a function (orphaned), but no
  // OTHER click binding should call it (other than maybe inside
  // toggleAdminPane\'s own body).
  // We look for click handlers that call toggleAdminPane.
  const clickAdminPaneRefs = src.match(/addEventListener\s*\(\s*['"]click['"][\s\S]{0,200}toggleAdminPane/g) || [];
  assert.ok(clickAdminPaneRefs.length === 0,
    'no addEventListener(\'click\', …) handler should call toggleAdminPane after fr-87 r4 — the standalone admin pane is orphaned. Found bindings: ' + clickAdminPaneRefs.length);
});

// ── marker comment ──

t('a comment naming fr-87 r4 explains the single-icon consolidation', () => {
  const html = _read('web/public/index.html');
  const app = _read('web/public/app.js');
  const marker = /fr-87\s*r4|single config icon|btn-admin.*opens.*config modal/i;
  assert.ok(marker.test(html) || marker.test(app),
    'a comment must name fr-87 r4 (or "single config icon" / "btn-admin opens Config modal") so a future restyle understands why btn-admin\'s tooltip says "Config" and #btn-config was removed.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
