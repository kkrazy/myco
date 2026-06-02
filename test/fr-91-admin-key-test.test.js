// fr-91: Add test key on API key to verify functionality.
//
// User-reported (verbatim, plan-item dispatch from @labxnow):
//   Problem: No way to validate that an API key is functional
//            before relying on it in production calls.
//   Expected: API key supports a test key / test-mode credential
//             that can be invoked to confirm the key works
//             end-to-end.
//   Actual: API keys are issued without any built-in verification
//           path, so breakage is only detected on real traffic.
//
// Scope confirmed via AskUserQuestion:
//   · Test buttons next to the FOUR admin API keys in the Config
//     modal: Anthropic / Gemini / OpenAI / Custom Critic. (NOT
//     per-repo PATs.)
//   · Click Test → server makes a minimal probe call to the
//     respective API → inline result shown next to the field.
//   · Inline warning on fail, Save proceeds regardless.
//
// Surface:
//   · Server: new `POST /api/admin/test-key` endpoint accepting
//     `{which: 'anthropic'|'gemini'|'openai'|'custom', key,
//     endpoint?, model?}`. Returns `{ok: true, name}` or
//     `{ok: false, error}`. requireAdmin gate (matches the
//     existing /api/admin/config pattern).
//   · Client: a Test button next to each key input in
//     index.html. Wired in app.js to read the current field
//     value, POST to /api/admin/test-key, render the result
//     inline next to the button.
//
// Test shape: static-grep guards on server/src/index.js (route +
// 4 probe handlers + requireAdmin), web/public/index.html (4 test
// buttons), and web/public/app.js (4 click handlers calling the
// endpoint). Pure routing + UI plumbing.

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

console.log('── fr-91: admin API key test buttons ──');

// ── server: POST /api/admin/test-key endpoint ──

t('server/src/index.js declares POST /api/admin/test-key with requireAdmin', () => {
  const src = _read('server/src/index.js');
  assert.ok(/app\.post\(\s*['"]\/api\/admin\/test-key['"]\s*,\s*requireAdmin/.test(src),
    'server/src/index.js must declare `app.post("/api/admin/test-key", requireAdmin, ...)` so only admins can probe keys (fr-91).');
});

t('server/src/index.js test-key endpoint branches on `which` covering all 4 admin keys', () => {
  const src = _read('server/src/index.js');
  // Find the test-key route + extract its handler body. The body
  // must reference all 4 keys.
  const routeAt = src.search(/app\.post\(\s*['"]\/api\/admin\/test-key['"]/);
  assert.ok(routeAt > -1, 'test-key route must exist');
  const window = src.slice(routeAt, routeAt + 3000);
  for (const which of ['anthropic', 'gemini', 'openai', 'custom']) {
    assert.ok(new RegExp(`['"]${which}['"]`).test(window),
      `test-key handler must reference the "${which}" key type so each of the 4 admin keys gets a probe (fr-91). Window: ${window.slice(0, 500)}`);
  }
});

t('server/src/index.js has probe helpers that hit the live APIs (anthropic / gemini / openai / custom)', () => {
  const src = _read('server/src/index.js');
  // Loose check: the file must reference each provider's actual
  // probe target. The exact endpoint can drift, but the marker
  // strings should be there.
  assert.ok(/api\.anthropic\.com/.test(src),
    'fr-91 probe must call api.anthropic.com somewhere — found no such reference. Either the route is missing or the probe is stubbed.');
  assert.ok(/api\.openai\.com/.test(src),
    'fr-91 probe must call api.openai.com somewhere for the OpenAI key check.');
  assert.ok(/GoogleGenAI|@google\/genai|generativelanguage\.googleapis\.com/.test(src),
    'fr-91 Gemini probe must use the GoogleGenAI SDK (or its endpoint) for the Gemini key check.');
});

// ── client: HTML buttons ──

t('web/public/index.html declares a Test button next to each of the 4 admin key inputs', () => {
  const html = _read('web/public/index.html');
  // The 4 key inputs are #input-anthropic-key, #input-gemini-key,
  // #input-openai-key, #input-critic-key. Each must have a sibling
  // test button. The simplest selector contract: an element with
  // id="btn-test-<which>" near each input.
  for (const which of ['anthropic', 'gemini', 'openai', 'critic']) {
    const re = new RegExp(`id\\s*=\\s*['"]btn-test-${which}['"]`);
    assert.ok(re.test(html),
      `index.html must include <button id="btn-test-${which}"> in the Config modal so the user can click Test next to the ${which} key (fr-91).`);
  }
});

t('fr-91 r3: Test buttons sit inside #config-admin-env-form (the live admin section in the Config modal)', () => {
  // r3 moved buttons from #admin-config-form (orphaned standalone
  // pane, deleted) to #config-admin-env-form (the live admin section
  // inside the Config modal, gated by the /api/admin/config 200 probe
  // so only admins see it).
  const html = _read('web/public/index.html');
  const formStart = html.indexOf('id="config-admin-env-form"');
  assert.ok(formStart > -1, 'index.html must declare <form id="config-admin-env-form"> (the live admin section).');
  const formEnd = html.indexOf('</form>', formStart);
  const formBody = html.slice(formStart, formEnd);
  for (const which of ['anthropic', 'gemini', 'openai', 'critic']) {
    assert.ok(new RegExp(`btn-test-${which}`).test(formBody),
      `btn-test-${which} must live inside #config-admin-env-form (not the deleted #admin-config-form) — fr-91 r3.`);
  }
});

t('fr-91 r3: orphaned #admin-wrap is gone, and the legacy #admin-config-form is gone with it', () => {
  const html = _read('web/public/index.html');
  // Only allow appearances in comments — strip those before checking.
  const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/id\s*=\s*['"]admin-wrap['"]/.test(stripped),
    'index.html must NOT declare id="admin-wrap" anymore — fr-91 r3 deleted the orphaned standalone admin pane per "one admin UI, role-based sections".');
  assert.ok(!/id\s*=\s*['"]admin-config-form['"]/.test(stripped),
    'index.html must NOT declare id="admin-config-form" anymore — fr-91 r3 deleted the orphaned form (it lived inside #admin-wrap).');
});

// ── client: JS click handlers ──

t('web/public/app.js wires each Test button to POST /api/admin/test-key', () => {
  const app = _read('web/public/app.js');
  // The 4 buttons must trigger a fetch/authedFetch to the test-key
  // endpoint. Look for a reference to '/api/admin/test-key' somewhere
  // in the file and for each btn-test-<which> id.
  assert.ok(/['"]\/api\/admin\/test-key['"]/.test(app),
    'app.js must reference the /api/admin/test-key endpoint URL (fr-91).');
  for (const which of ['anthropic', 'gemini', 'openai', 'critic']) {
    assert.ok(new RegExp(`btn-test-${which}`).test(app),
      `app.js must reference the btn-test-${which} button id to wire its click handler (fr-91).`);
  }
});

t('web/public/app.js click handler reads the current input value (not the saved env)', () => {
  const app = _read('web/public/app.js');
  // The handler must read the input field's `.value` so a freshly-
  // pasted key can be probed before Save. Loose proximity: any
  // `.value` reference within ±2000 chars of the test-key URL.
  const endpointAt = app.indexOf('/api/admin/test-key');
  assert.ok(endpointAt > -1, 'app.js must reference /api/admin/test-key');
  const win = app.slice(Math.max(0, endpointAt - 2000), endpointAt + 2000);
  assert.ok(/\.value\b/.test(win),
    'the test-key click handler must read the input field\'s `.value` so unsaved keys can be probed (fr-91). Window did not contain any `.value` reference.');
});

// ── marker comment ──

t('a comment naming fr-91 explains the test-key plumbing', () => {
  const server = _read('server/src/index.js');
  const html = _read('web/public/index.html');
  const app = _read('web/public/app.js');
  const re = /fr-91/;
  assert.ok(re.test(server) || re.test(html) || re.test(app),
    'a comment naming fr-91 must appear in at least one of server/src/index.js / web/public/index.html / web/public/app.js so future restyles understand the test-key contract.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
