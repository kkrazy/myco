// fr-87 r2: merge system-wide admin config into the user Config modal
// for users with admin access.
//
// User-reported (verbatim, plan-item dispatch comment):
//   "System config and user config should merge when user has admin
//    access"
//
// Context: fr-87 r1 shipped a Config modal exposing user-scoped PATs.
// Origin's f71495f shipped a separate sysadmin pane (#admin-wrap +
// #btn-admin) with system-wide env config + allowlist management,
// gated by requireAdmin (hardcoded login list labxnow|kkrazy|ryan-
// blues). The comment asks: an admin shouldn't have to bounce between
// the Config modal and the standalone admin pane. The single Config
// entry point should expand for admin users.
//
// MVP scope confirmed via question: add an Admin section to the
// Config modal (allowlist + env config), visible to admins only
// (probed via /api/admin/config 200 vs 403). Keep the standalone
// #admin-wrap + #btn-admin as parallel access (no retirement this
// round).
//
// Contract being locked:
//   - index.html: #config-modal contains a #config-admin-section
//     element, positioned between #config-pats-section and
//     #config-account-section.
//   - The admin section uses a `config-admin-` ID prefix so its
//     form fields don't collide with the standalone admin pane's
//     same-named fields (e.g. #input-anthropic-key vs
//     #config-admin-anthropic-key).
//   - app.js openConfigModal calls GET /api/admin/config and toggles
//     #config-admin-section based on the response (200 → show + load
//     values, 403/anything else → hide).
//   - Save handler POSTs to /api/admin/config (reuses the existing
//     route).
//   - Allowlist GET/Add/Delete wire to /api/admin/allowlist.
//   - A comment in index.html or app.js names fr-87 r2 (or 'fr-87 r2'
//     / 'admin merge') so a future restyle doesn't silently regress.

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

console.log('── fr-87 r2: Admin merge into Config modal ──');

// ── index.html: section structure + positioning ──

t('index.html: #config-modal contains a #config-admin-section element', () => {
  const html = _read('web/public/index.html');
  const modalAt = html.indexOf('id="config-modal"');
  assert.ok(modalAt > 0, 'index.html must declare #config-modal (from fr-87 r1)');
  // Modal closes ~4KB later; check the admin section appears within.
  const modalEnd = html.indexOf('<!-- fr-50', modalAt);   // next modal in the file
  const modalBody = html.slice(modalAt, modalEnd > 0 ? modalEnd : modalAt + 8000);
  assert.ok(/id\s*=\s*['"]config-admin-section['"]/.test(modalBody),
    '#config-modal must contain an element with id="config-admin-section"');
});

t('index.html: #config-admin-section is positioned between PATs and Account', () => {
  const html = _read('web/public/index.html');
  const patsAt = html.indexOf('id="config-pats-section"');
  const adminAt = html.indexOf('id="config-admin-section"');
  const acctAt = html.indexOf('id="config-account-section"');
  assert.ok(patsAt > 0 && adminAt > 0 && acctAt > 0,
    'all three Config modal sections must exist (pats, admin, account)');
  assert.ok(patsAt < adminAt && adminAt < acctAt,
    'admin section must be positioned BETWEEN pats and account, in that order. ' +
    `Got offsets: pats=${patsAt} admin=${adminAt} account=${acctAt}`);
});

t('index.html: admin section is hidden by default', () => {
  const html = _read('web/public/index.html');
  const adminAt = html.indexOf('id="config-admin-section"');
  // Walk back to the opening tag.
  const tagOpen = html.lastIndexOf('<', adminAt);
  const tagClose = html.indexOf('>', adminAt);
  const tag = html.slice(tagOpen, tagClose + 1);
  assert.ok(/\bhidden\b/.test(tag),
    '#config-admin-section must declare the hidden attribute so non-admins don\'t see a flash of the form on page load.');
});

// ── ID prefix collision safety ──

t('admin section uses config-admin- prefix to avoid collision with standalone admin pane', () => {
  const html = _read('web/public/index.html');
  // The standalone admin pane uses ids like #input-anthropic-key,
  // #input-critic-endpoint, #admin-config-form. The Config modal's
  // admin section MUST NOT duplicate those ids — that would break
  // form field lookups for both surfaces.
  const adminAt = html.indexOf('id="config-admin-section"');
  // Slice the admin section body (next 6 KB is enough).
  const sectionEnd = html.indexOf('id="config-account-section"', adminAt);
  const sectionBody = html.slice(adminAt, sectionEnd > 0 ? sectionEnd : adminAt + 6000);
  // No bare #input-* IDs in the new section.
  const collisions = sectionBody.match(/id\s*=\s*['"]input-[a-z-]+['"]/g) || [];
  // The standalone pane uses these exact ids; the new section must avoid them.
  const standalonePaneIds = ['input-anthropic-key', 'input-gemini-key', 'input-openai-key',
    'input-critic-endpoint', 'input-critic-key', 'input-critic-model',
    'input-http-proxy', 'input-https-proxy', 'input-no-proxy', 'input-tls-insecure'];
  for (const id of standalonePaneIds) {
    assert.ok(!sectionBody.includes(`id="${id}"`),
      `the new Config-modal admin section must NOT reuse #${id} — that id already belongs to the standalone admin pane (#admin-wrap). Use a config-admin- prefix to avoid DOM-id collision.`);
  }
});

// ── app.js: probe + show/hide + save wiring ──

t('app.js openConfigModal probes /api/admin/config + toggles admin section', () => {
  const src = _read('web/public/app.js');
  const fnAt = src.indexOf('async function openConfigModal');
  assert.ok(fnAt > 0 || src.indexOf('function openConfigModal') > 0,
    'app.js must define openConfigModal (from fr-87 r1)');
  // Look for the admin-probe call within a generous window.
  const lookFrom = Math.max(0, fnAt);
  const window = src.slice(lookFrom, lookFrom + 5000);
  const probesAdmin = /\/api\/admin\/config/.test(window) || /_refreshConfigAdmin/.test(window) || /openConfigModal[\s\S]{0,500}admin/.test(window);
  assert.ok(probesAdmin,
    'openConfigModal (or a helper it calls) must reference /api/admin/config so the admin section show/hide is driven by the user\'s actual admin status (not a hardcoded client-side login check).');
});

t('app.js wires admin save → POST /api/admin/config', () => {
  const src = _read('web/public/app.js');
  assert.ok(/method\s*:\s*['"]POST['"][\s\S]{0,200}\/api\/admin\/config/.test(src)
         || /\/api\/admin\/config[\s\S]{0,200}method\s*:\s*['"]POST['"]/.test(src),
    'app.js must POST to /api/admin/config to save admin env config (reuses the existing route from f71495f).');
});

t('app.js wires allowlist GET + Add + Remove to /api/admin/allowlist', () => {
  const src = _read('web/public/app.js');
  assert.ok(/\/api\/admin\/allowlist/.test(src),
    'app.js must reference /api/admin/allowlist for the Add/Remove allowlist controls in the Config modal admin section');
});

// ── never-leak-the-secret invariant carried over from fr-87 r1 ──

t('app.js does NOT echo raw env-key values back into chat / state.chatMessages', () => {
  const src = _read('web/public/app.js');
  // Sanity: the modal\'s admin save shouldn\'t store the raw token in
  // any global state. We accept this as a static guard: no assignment
  // of `state.something = ANTHROPIC_API_KEY-shaped values`.
  // This is a weak guard — the real protection is at the network
  // layer (HTTPS) + the masking server-side. But we lock the absence
  // of obvious bad patterns.
  assert.ok(!/state\.[a-zA-Z]+\s*=\s*['"]sk-/.test(src),
    'app.js must not assign raw API-key-shaped literals to state.* — secrets only flow client→server, never back into long-lived client state.');
});

// ── marker comment ──

t('a comment naming fr-87 r2 (or admin-merge) explains the new section', () => {
  const html = _read('web/public/index.html');
  const app = _read('web/public/app.js');
  // Comment can live in either file — we just want SOMETHING that
  // tells the next reader why the admin section exists in the Config
  // modal and shouldn\'t be silently removed.
  const marker = /fr-87\s*r2|admin\s*merge|merge admin into config|admin section.*config modal/i;
  assert.ok(marker.test(html) || marker.test(app),
    'a comment must name fr-87 r2 (or "admin merge") so a future restyle / cleanup doesn\'t silently regress the merge by removing the admin section from the Config modal.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
