// User reports (kkrazy 2026-05-27):
//   r3 first comment: "make the chat to display the diagram with
//                      proper size limit"
//   r3 follow-up:    "currently the diagram is not visible at all
//                      in the chat"
//
// Two related issues in the same surface — fix together.
//
// Issue A (visibility — load-bearing):
//   Inserted markdown is `![diagram](/sessions/<id>/diagrams/<file>.svg)`.
//   The browser fetches that via a plain `<img src=...>` request,
//   which does NOT carry our Bearer token (the auth header we add
//   to fetch() calls in authedFetch). The original GET route used
//   fileApiPreamble(req, res, 'viewer') which returns 401 when
//   neither Bearer nor share-token is present → image blank.
//   Fix: drop the Bearer-auth gate. Security boundary becomes
//   {session-id, filename} — both unguessable (session-id is the
//   random session record id; filename is YYYYMMDDTHHMMSSZ-<8hex>.svg
//   = 32 bits of randomness on top of the session-id itself). Same
//   model as share-link tokens.
//
// Issue B (size cap):
//   Diagram <img> inherits the generic `.chat-msg .chat-text img
//   { max-width: 100% }` rule, which sizes it to the bubble's full
//   width (~600-700 px) — way too big for an inline preview. Add
//   a tighter pixel cap scoped to img[alt="diagram"] only, so
//   user-pasted screenshots / agent images still respect the
//   bubble.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
const SERVER = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');

console.log('── fr-84 r3: diagram visibility + size cap in chat ──');

// ── Issue A: GET route is no longer Bearer-auth-gated ─────────────

t('server: GET /sessions/:id/diagrams/:filename does NOT use fileApiPreamble', () => {
  // The auth gate has to go — `<img src>` can't send a Bearer token.
  const idx = SERVER.search(/app\.get\(['"]\/sessions\/:id\/diagrams\/:filename['"]/);
  assert.ok(idx > -1, 'GET /sessions/:id/diagrams/:filename route must be registered');
  // Slice the route body up to the closing `});` of the handler.
  const win = SERVER.slice(idx, idx + 1500);
  assert.ok(!/fileApiPreamble\(/.test(win),
    'GET route must NOT call fileApiPreamble — browser <img> requests have no Bearer header, so the gate causes blank renders. Use {session-id, filename} as the unguessable security boundary instead.');
});

t('server: GET route still validates session exists + filename shape (containment guard)', () => {
  const idx = SERVER.search(/app\.get\(['"]\/sessions\/:id\/diagrams\/:filename['"]/);
  // r3 expanded the route comment + body, so widen the slice past it.
  const win = SERVER.slice(idx, idx + 3000);
  // Session record lookup — return 404 for unknown sessions so an
  // attacker can't enumerate via random session-ids.
  assert.ok(/getSessionRecord\(/.test(win),
    'GET route must lookup the session record (404 on unknown session)');
  // Filename whitelist still blocks path traversal.
  assert.ok(/DIAGRAM_FILENAME_RE/.test(win),
    'GET route must validate filename against DIAGRAM_FILENAME_RE (no path traversal)');
  // Proper content type is still set.
  assert.ok(/image\/svg\+xml/.test(win),
    'GET route must serve image/svg+xml');
});

// ── Issue B: pixel-bounded preview size in chat ───────────────────

t('css: .chat-msg .chat-text img[alt="diagram"] declares a pixel max-width', () => {
  const re = /\.chat-msg\s+\.chat-text\s+img\[alt="diagram"\]\s*\{[^}]*max-width:\s*(\d+)px/;
  const m = CSS.match(re);
  assert.ok(m, '.chat-msg .chat-text img[alt="diagram"] rule with pixel max-width must exist');
  const px = parseInt(m[1], 10);
  // Reasonable range — not a thumbnail, not full bubble width.
  assert.ok(px >= 280 && px <= 560,
    `diagram preview max-width should be 280–560 px (got ${px}px)`);
});

t('css: diagram rule also caps max-height so tall (vertical) diagrams don\'t blow up', () => {
  const idx = CSS.search(/\.chat-msg\s+\.chat-text\s+img\[alt="diagram"\]\s*\{/);
  assert.ok(idx > -1, 'diagram image rule must exist (precondition for max-height check)');
  const win = CSS.slice(idx, idx + 600);
  const mhM = win.match(/max-height:\s*(\d+)px/);
  assert.ok(mhM, 'rule must declare max-height in pixels');
  const px = parseInt(mhM[1], 10);
  assert.ok(px >= 200 && px <= 500,
    `diagram preview max-height should be 200–500 px (got ${px}px)`);
});

t('css: rule preserves aspect ratio (height: auto)', () => {
  const idx = CSS.search(/\.chat-msg\s+\.chat-text\s+img\[alt="diagram"\]\s*\{/);
  const win = CSS.slice(idx, idx + 600);
  assert.ok(/height:\s*auto/.test(win),
    'rule must include height:auto so the cap preserves aspect ratio');
});

t('css: generic `.chat-msg .chat-text img` 100% rule still exists for other images', () => {
  // Don't regress the broader rule — non-diagram images (user
  // screenshots, agent images) still need to scale to the bubble.
  assert.ok(
    /\.chat-msg\s+\.chat-text\s+img\s*\{[^}]*max-width:\s*100%/.test(CSS),
    'generic .chat-msg .chat-text img { max-width: 100% } rule must remain for non-diagram images'
  );
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
