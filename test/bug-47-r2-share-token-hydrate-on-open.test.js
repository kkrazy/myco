// bug-47 r2: rehydrate state.shareToken from localStorage when
// openSession(id) is called for a session whose share entry is
// already saved. The r1 fix (commit ef3cd80) added _withShareToken
// + wrapped the file-API URLs, BUT the helper only does anything
// when `state.shareToken` is set — and that variable is set in
// exactly one place (the URL-`?s=<token>` bootstrap at the top of
// app.js). Any subsequent visit without `?s=` (page refresh,
// clicking the sidebar card from a different tab, etc.) lands with
// state.shareToken empty even though the share is saved in
// localStorage. _withShareToken is then a no-op, the viewer-tier
// file-API endpoints 401, and the File Explorer renders the empty
// "Failed to list" state — exactly the user's @kkrazy re-dispatch
// of bug-47.
//
// Fix (this r2): in openSession(id), look up the share entry for
// this session id via loadShareTokens() and assign state.shareToken
// accordingly. For owned sessions, explicitly clear state.shareToken
// so a stray token from a previous shared-session visit doesn't get
// sent to endpoints that don't need it (server-side owner-tier
// check wins first anyway — this is hygiene).
//
// Test shape: static-grep guards on web/public/app.js — openSession
// must reference loadShareTokens() and assign state.shareToken
// within its body, plus a bug-47 marker comment in the hydration
// block.

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

console.log('── bug-47 r2: shareToken rehydrates on session open ──');

// Locate the openSession function body. Static-grep helpers that
// follow operate on a fixed window after the header so they don't
// trip on other state.shareToken assignments elsewhere in the file.
function _openSessionBody() {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+openSession\s*\(/);
  assert.ok(at > -1, 'openSession must exist (anchor for the hydration scan).');
  // openSession is ~150 lines / ~4500 chars. Read a generous window so
  // the assignment can sit anywhere reasonable inside the function.
  return sliceFn(app, at);
}

// ── hydration call ──

t('openSession() calls loadShareTokens() to look up this session\'s saved share entry', () => {
  const body = _openSessionBody();
  assert.ok(/loadShareTokens\s*\(\s*\)/.test(body),
    'openSession() must call loadShareTokens() so the share entry for the just-opened session can be looked up from localStorage (bug-47 r2). The r1 fix at app.js _withShareToken only works when state.shareToken is set; without this hydration it stays empty on every visit that didn\'t arrive via a `?s=<token>` URL.');
});

t('openSession() assigns state.shareToken (hydration target)', () => {
  const body = _openSessionBody();
  assert.ok(/state\.shareToken\s*=/.test(body),
    'openSession() must assign state.shareToken from the loadShareTokens() lookup so _withShareToken can append `?s=<token>` on subsequent file-API calls (bug-47 r2).');
});

t('openSession() hydration block keys the lookup by sessionId === id', () => {
  const body = _openSessionBody();
  // The lookup must filter by this session\'s id (the openSession
  // parameter). Match either array.find or filter with sessionId/id
  // equality so the right entry surfaces — random first-entry use would
  // mishandle the multi-share case.
  assert.ok(/sessionId\s*===\s*id|\.id\s*===\s*id|sessionId\s*===\s*\bid\b/.test(body),
    'the share-entry lookup in openSession() must key on `sessionId === id` so a user with multiple saved shares picks the entry that matches the just-opened session (bug-47 r2). A naïve `loadShareTokens()[0]` would send the wrong token.');
});

// ── marker comment ──

t('a comment naming bug-47 explains the rehydration block (r2 trail-marker)', () => {
  const body = _openSessionBody();
  assert.ok(/bug-47/.test(body),
    'a comment naming bug-47 must appear inside openSession() so a future restyle understands the rehydration contract (bug-47 r2).');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
