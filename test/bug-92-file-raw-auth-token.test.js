// bug-92: fr-107 preview endpoints returned 401 {"error":"unauthorized"}
// on mycobeta because iframe/img/audio/video tag requests don't carry
// the Authorization: Bearer header that authedFetch sets — only cookies
// travel automatically. The /file/raw route is auth-gated by
// fileApiPreamble which calls userFromRequest(req); with no header and
// no cookie, req.user resolved to null and the preamble returned 401.
//
// Fix: append `?token=<state.token>` to the raw URL in the preview
// dispatcher (_renderPreviewByKind). Server-side compat already exists
// — userFromRequest in server/src/auth.js accepts `?token=<X>` as a
// fallback (line ~114 as of 2026-07). Share-token guests take
// precedence via _withShareToken.
//
// Contract tested:
//   1. app.js defines a _rawUrlWithToken helper.
//   2. The helper appends `?token=<encoded>` when state.token is set
//      and NO share-token is in play.
//   3. Share-token wins: when state.shareToken is set, _rawUrlWithToken
//      returns _withShareToken(url) — the Bearer token stays out of
//      the URL (guest flows should never leak the operator's token).
//   4. No-token / no-share-token → URL is returned unchanged.
//   5. Existing `?` in URL → helper switches to `&token=` join.
//   6. _renderPreviewByKind wraps the raw URL through _rawUrlWithToken
//      BEFORE handing it to any render helper — this is the fix site.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-92: fr-107 preview raw URL carries auth token ──');

// ──────────────────────────────────────────────────────────────────
// Group A: _rawUrlWithToken helper behavior via inline eval.
// Extract the two collaborating helpers (_withShareToken +
// _rawUrlWithToken) and drive them against a fake `state` global.

function _extractHelpers() {
  const src = _read('web/public/app.js');
  const shareBody = fnBody(src, /function\s+_withShareToken\s*\(/);
  const rawBody = fnBody(src, /function\s+_rawUrlWithToken\s*\(/);
  assert.ok(shareBody, '_withShareToken must be locatable');
  assert.ok(rawBody, '_rawUrlWithToken must be locatable');
  // Wrap both in a scope with a fake `state` so we can drive the
  // helper deterministically. `state` shadows the app.js global.
  const wrapper = `(function(fakeState) {
    const state = fakeState;
    ${shareBody}
    ${rawBody}
    return { _withShareToken, _rawUrlWithToken };
  })`;
  // eslint-disable-next-line no-eval
  return eval(wrapper);
}

t('_rawUrlWithToken: state.token set, no share-token → appends ?token=<encoded>', () => {
  const withState = _extractHelpers();
  const { _rawUrlWithToken } = withState({ token: 'abc/xyz+123', shareToken: '' });
  const out = _rawUrlWithToken('/sessions/s1/file/raw?path=foo.pdf');
  assert.ok(/[?&]token=abc%2Fxyz%2B123/.test(out),
    `URL must include token=<url-encoded token>. Got: ${out}`);
  assert.ok(/&token=/.test(out),
    'URL already had a `?` (path=…), so token must join with `&`');
});

t('_rawUrlWithToken: no `?` in URL → joins with `?token=`', () => {
  const { _rawUrlWithToken } = _extractHelpers()({ token: 'abc', shareToken: '' });
  const out = _rawUrlWithToken('/sessions/s1/file/raw');
  assert.ok(/\?token=abc$/.test(out),
    `bare URL must join with '?'. Got: ${out}`);
});

t('_rawUrlWithToken: state.shareToken wins over Bearer token (guest flow)', () => {
  const { _rawUrlWithToken } = _extractHelpers()({ token: 'operator-bearer', shareToken: 'guest-share-tok' });
  const out = _rawUrlWithToken('/sessions/s1/file/raw?path=foo.pdf');
  assert.ok(/[?&]s=guest-share-tok/.test(out),
    `share-token must appear in the URL. Got: ${out}`);
  assert.ok(!/token=operator-bearer/.test(out),
    'operator Bearer token must NEVER appear when a share-token is in play (guest URL would leak it)');
});

t('_rawUrlWithToken: no token AND no share-token → URL returned unchanged', () => {
  const { _rawUrlWithToken } = _extractHelpers()({ token: '', shareToken: '' });
  const url = '/sessions/s1/file/raw?path=foo.pdf';
  assert.strictEqual(_rawUrlWithToken(url), url,
    'when neither auth mechanism has anything to add, URL passes through unchanged');
});

t('_rawUrlWithToken: state undefined → URL returned unchanged (defensive)', () => {
  const { _rawUrlWithToken } = _extractHelpers()(undefined);
  const url = '/sessions/s1/file/raw?path=foo.pdf';
  assert.strictEqual(_rawUrlWithToken(url), url,
    'when state is null/undefined (pre-init calls), URL must pass through without crashing');
});

t('_rawUrlWithToken: token with special URL chars → encodeURIComponent applied', () => {
  const { _rawUrlWithToken } = _extractHelpers()({ token: 'a=b&c d', shareToken: '' });
  const out = _rawUrlWithToken('/sessions/s1/file/raw');
  // Encoded form of 'a=b&c d': a%3Db%26c%20d
  assert.ok(/token=a%3Db%26c%20d/.test(out),
    `token must be URL-encoded to survive '?' / '&' / space. Got: ${out}`);
});

// ──────────────────────────────────────────────────────────────────
// Group B: static guards on the fix site.

t('static guard: app.js defines _rawUrlWithToken with a bug-92 marker', () => {
  const src = _read('web/public/app.js');
  assert.ok(/function\s+_rawUrlWithToken\s*\(/.test(src),
    '_rawUrlWithToken helper must be defined');
  const body = fnBody(src, /function\s+_rawUrlWithToken\s*\(/);
  assert.ok(body, 'helper body must be locatable');
  assert.ok(/state\.token/.test(body),
    'helper must read state.token (the Bearer session token)');
  assert.ok(/encodeURIComponent/.test(body),
    'helper must URL-encode the token so `?` / `&` / space chars survive');
  // The share-token precedence must be honored so guest URLs never
  // leak the operator Bearer token.
  assert.ok(/_withShareToken|shareToken/.test(body),
    'helper must consult share-token state (guest flow precedence)');
});

t('static guard: _renderPreviewByKind wraps the raw URL through _rawUrlWithToken (the fix site)', () => {
  const src = _read('web/public/app.js');
  const body = fnBody(src, /function\s+_renderPreviewByKind\s*\(/);
  assert.ok(body, '_renderPreviewByKind body must be locatable');
  assert.ok(/_rawUrlWithToken\s*\(/.test(body),
    '_renderPreviewByKind must route the raw URL through _rawUrlWithToken so iframe/img/audio/video requests carry the token (bug-92 fix)');
  // Ordering: the token-wrap must happen BEFORE any render helper is
  // called, so all four downstream helpers receive an authenticated
  // URL. Loose check: _rawUrlWithToken must appear before the first
  // _render*Preview call.
  const wrapIdx = body.indexOf('_rawUrlWithToken');
  const firstRenderIdx = body.search(/_render(?:Iframe|Pdf|Image|Media)Preview\s*\(/);
  assert.ok(wrapIdx > 0 && firstRenderIdx > wrapIdx,
    'the token-wrap must precede all _render*Preview calls so every render helper gets an authenticated URL');
});

t('static guard: bug-92 marker appears in app.js near the fix site', () => {
  const src = _read('web/public/app.js');
  assert.ok(/bug-92/.test(src),
    'the fix must carry a bug-92 marker so a future reader can grep-back to the empirical failure that motivated it');
});

t('static guard: server userFromRequest still accepts ?token= as a fallback (server-side compat)', () => {
  // This isn't a bug-92 change but locks the SERVER-side contract the
  // client-side fix depends on. If a future refactor drops query-token
  // support in userFromRequest, this test will surface it before the
  // preview endpoints regress.
  const src = _read('server/src/auth.js');
  const body = fnBody(src, /function\s+userFromRequest\s*\(/);
  assert.ok(body, 'userFromRequest body must be locatable');
  assert.ok(/req\.query.*token|queryTok|\.token\b/.test(body),
    'userFromRequest must accept a `?token=<X>` query fallback (auth.js contract that bug-92 client fix depends on)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
