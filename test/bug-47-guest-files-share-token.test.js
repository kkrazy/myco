// bug-47: Guest users see empty file explorer despite having view permission.
//
// User-reported (verbatim, plan-item dispatch from @kkrazy):
//   Problem: A user invited to a shared session as a viewer can chat
//            and see the artifact pane, but the File Explorer tab is
//            empty — the directory listing never loads.
//   Expected: The file tree + "Changed files" section render the
//             same entries the owner sees (read-only).
//   Actual:   The pane is blank; the network request returns 401
//             because the client never forwards the share token.
//
// Root cause (investigated):
//   The viewer-tier file-API endpoints (GET /sessions/:id/files,
//   /files-changed, /files/diff, POST /files/reconsider) are gated by
//   fileApiPreamble('viewer'), which accepts ONE of:
//     · owner / admin / viewer (logged-in user listed on the session)
//     · ?s=<shareToken> query param matching the session id
//   The client's authedFetch only attaches the Bearer token — it never
//   appends `s=<state.shareToken>`. Guests who arrived via a share link
//   have state.shareToken but no state.token, so every file-API call
//   falls through every access tier in the preamble and returns 401.
//
// Fix:
//   Introduce a single `_withShareToken(url)` helper in app.js that
//   appends `s=<token>` (auto-picking `?` vs `&`) when state.shareToken
//   is set. Wrap each viewer-tier file-API URL with it. The helper is
//   no-op when state.shareToken is empty, so owned-session traffic is
//   unaffected (and the server's owner-tier check wins first anyway,
//   so a stray `s=` is benign even if a guest is also signed in).
//
// Test shape: static-grep guards on web/public/app.js for the helper
// definition + each file-API callsite wrapping its URL in
// _withShareToken(...).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-47: guest file-API share-token forwarding ──');

// ── helper definition ──

t('web/public/app.js defines _withShareToken(url) that appends ?s=/&s= when state.shareToken is set', () => {
  const app = _read('web/public/app.js');
  assert.ok(/function\s+_withShareToken\s*\(/.test(app),
    'app.js must define `function _withShareToken(url)` — the single place that decorates file-API URLs with the share token (bug-47).');
  // The helper body must reference state.shareToken — otherwise it
  // can't decide whether to decorate. ±400 chars after the function
  // header is a safe window.
  const at = app.search(/function\s+_withShareToken\s*\(/);
  const body = sliceFn(app, at);
  assert.ok(/state\.shareToken/.test(body),
    '_withShareToken must read state.shareToken to decide whether to decorate the URL (bug-47).');
  assert.ok(/encodeURIComponent\s*\(\s*state\.shareToken\s*\)/.test(body),
    '_withShareToken must encodeURIComponent(state.shareToken) before splicing it into the URL (bug-47).');
  // Must handle both query-present (`&s=`) and query-absent (`?s=`)
  // forms — `/files?path=...` already has a `?`, `/files-changed`
  // doesn't.
  assert.ok(/\?/.test(body) && /&/.test(body),
    '_withShareToken must pick `&s=` when the URL already has a `?`, otherwise `?s=` — both separators must appear in its body (bug-47).');
});

// ── file-API callsites all funnel through the helper ──

// Each file-API path that the guest's File Explorer triggers must wrap
// its URL with _withShareToken so the share token reaches the server.
const GUEST_FILE_API_PATHS = [
  '/files?path=',           // GET /sessions/:id/files          — loadFileTree
  '/files-changed',         // GET /sessions/:id/files-changed  — loadPlanChangedFiles + queue resume helpers
  '/files/diff?path=',      // GET /sessions/:id/files/diff     — inline diff in changed-files list + chrome batch
  '/files/reconsider',      // POST /sessions/:id/files/reconsider — viewer-readable
];

// Strip JS comments before the path search so the helper's own
// documentation (which mentions the route names verbatim) doesn't
// trip the guard. Block comments first (greedy stripper), then
// `//` to end-of-line.
function _stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

for (const p of GUEST_FILE_API_PATHS) {
  t(`every fetch to ${p} wraps its URL with _withShareToken(...) so guests can pass the viewer-tier gate`, () => {
    const app = _stripJsComments(_read('web/public/app.js'));
    // Find every occurrence of the path. For each, the surrounding
    // ±400 char window must contain a `_withShareToken(` call. This
    // is a loose contract — direct concatenation, template-literal,
    // or const-extracted url, as long as the helper is in the
    // neighborhood.
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    let m;
    let foundAny = false;
    while ((m = re.exec(app)) !== null) {
      foundAny = true;
      const win = app.slice(Math.max(0, m.index - 400), m.index + 400);
      assert.ok(/_withShareToken\s*\(/.test(win),
        `the fetch URL containing "${p}" near offset ${m.index} must be wrapped with _withShareToken(...) so guest users can pass the share-token gate (bug-47). Window: ${win.slice(0, 300)}…`);
    }
    assert.ok(foundAny,
      `expected to find at least one occurrence of "${p}" in app.js — the test contract assumes it exists.`);
  });
}

// ── marker comment ──

t('a comment naming bug-47 explains the share-token plumbing', () => {
  const app = _read('web/public/app.js');
  assert.ok(/bug-47/.test(app),
    'a comment naming bug-47 must appear in web/public/app.js so future restyles understand the share-token contract.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
