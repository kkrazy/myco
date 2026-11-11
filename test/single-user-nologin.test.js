// single-user default mode must not show the login modal.
//
// User report: "一进来就是登录界面 / why can't I just get in?" — in the
// single-user mode (no GitHub OAuth app configured, so `/auth/check`
// returns `{ ok:true, user:'default' }`), a fresh browser still got the
// login modal. Root cause: `tryToken()` short-circuited on a missing
// token (`if (!token) return false`) and never asked the server whether
// auth is even required — so the client forced `showLogin()` even though
// the server is in no-auth single-user mode.
//
// Fix: `tryToken` always calls `/auth/check`. In single-user mode the
// server answers `{ok:true, user:'default'}` without a token → `init()`;
// in multi-user mode it answers `{ok:false, required:true}` → the login
// modal still shows. This test locks the regression point: no
// `if (!token)` short-circuit, and the empty-token request still goes to
// the server.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const tryTokenBody = fnBody(PROD_APP, /async function\s+tryToken\s*\(/);

console.log('── single-user nologin: tryToken must not gate on a missing token ──');

t('tryToken is present and extracted', () => {
  assert.ok(tryTokenBody.length > 0, 'fnBody must find async function tryToken');
});

t('tryToken always consults the server via /auth/check', () => {
  assert.match(tryTokenBody, /fetch\('\/auth\/check'/,
    'tryToken must call /auth/check so the server (not empty localStorage) decides auth');
});

t('tryToken no longer short-circuits when token is missing', () => {
  // The original bug: `if (!token) return false` skipped the server call
  // and forced the login modal in single-user mode. Guard against it
  // returning early before the fetch.
  assert.doesNotMatch(tryTokenBody, /if\s*\(\s*!token\s*\)/,
    'tryToken must not early-return on a missing token; the server decides');
});

t('empty token sends no Authorization header but still calls the server', () => {
  assert.match(tryTokenBody, /headers:\s*token \? \{ Authorization: `Bearer \$\{token\}` \} : \{\}/,
    'with no token, tryToken must send an empty header set (not bail out)');
});

if (failed > 0) { console.error(`FAIL ${failed}/${passed + failed}`); process.exit(1); }
console.log(`PASS ${passed}`);
