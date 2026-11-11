// bug-47 r3: unify the access-tier check.
//
// User-reported (verbatim, plan-item re-dispatch from @kkrazy):
//   "user 'labxnow' still getting forbidden error when accessing the
//    file explorer on mycobeta"
//
// Confirmed on mycobeta:
//   · labxnow is logged in (auth-sessions.json has their bearer).
//   · labxnow CAN see the session in the sidebar + attach to the WS
//     — they have access EVERYWHERE except the file API.
//   · labxnow is NOT in rec.viewers[] or rec.admins[] for any session
//     in /data/sessions.json (so the explicit ACL doesn't grant them
//     viewer tier).
//   · But sessions.js isOwnerAdminOrViewer() has a hardcoded carve-out
//     at the top of the function: it returns true for any user whose
//     login is in {labxnow, kkrazy, ryan-blues}. That's why labxnow
//     gets in everywhere — and ONLY through that helper.
//   · index.js fileApiPreamble('viewer') re-implements the access
//     check INLINE (rec.user === req.user, rec.admins.includes, etc.)
//     — it doesn't call isOwnerAdminOrViewer, so the carve-out
//     doesn't apply. Hence 403 on /files for labxnow.
//
// Two implementations of the same "is this user allowed?" concept ⇒
// drift. The fix is to extract resolveAccessTier(sessionId, user)
// → 'owner' | 'viewer' | null as the single source of truth, and
// make both isOwnerAdminOrViewer (boolean) and fileApiPreamble (tier
// + access object) consume it. The carve-out lives in exactly one
// place and applies uniformly.
//
// Test shape: static-grep guards on server/src/sessions.js (the new
// helper is exported + isOwnerAdminOrViewer delegates to it + the
// carve-out lives inside the new helper) and server/src/index.js
// (fileApiPreamble references the new helper).

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

// Strip JS comments before counting the carve-out / scanning exports
// — the helper's own doc-comment mentions the three usernames in
// prose, which would otherwise inflate the duplicate-check count.
function _stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

console.log('── bug-47 r3: access-tier check unified ──');

// ── sessions.js: new helper + delegation ──

t('server/src/sessions.js exports resolveAccessTier(sessionId, user)', () => {
  const src = _read('server/src/sessions.js');
  assert.ok(/function\s+resolveAccessTier\s*\(/.test(src),
    'sessions.js must define `function resolveAccessTier(sessionId, user)` as the single source of truth for owner/viewer/null access decisions (bug-47 r3).');
  // Must be in the module.exports block. The sessions.js export
  // pattern is `Object.assign(module.exports, { ... resolveAccessTier,
  // ... })`, so the symbol shows up in the LAST chunk after the final
  // `module.exports` mention (parts[2]+ of the split — parts[1] is
  // the explanatory comment between the two mentions).
  const parts = src.split('module.exports');
  const exportsTail = parts.slice(1).join('module.exports');
  assert.ok(/\bresolveAccessTier\s*[,}]/.test(exportsTail),
    'resolveAccessTier must appear in module.exports so index.js can require it (bug-47 r3).');
});

t('server/src/sessions.js resolveAccessTier returns the three documented values', () => {
  const src = _read('server/src/sessions.js');
  // Find the function body and check it can return 'owner', 'viewer',
  // and null (or end-of-function fall-through).
  const at = src.search(/function\s+resolveAccessTier\s*\(/);
  assert.ok(at > -1, 'resolveAccessTier must exist.');
  const body = sliceFn(src, at);
  assert.ok(/['"`]owner['"`]/.test(body),
    "resolveAccessTier must be able to return 'owner' (bug-47 r3).");
  assert.ok(/['"`]viewer['"`]/.test(body),
    "resolveAccessTier must be able to return 'viewer' (bug-47 r3).");
  assert.ok(/return\s+null/.test(body),
    'resolveAccessTier must `return null` for users with no access (bug-47 r3).');
});

t('server/src/sessions.js isOwnerAdminOrViewer delegates to resolveAccessTier', () => {
  const src = _read('server/src/sessions.js');
  const at = src.search(/function\s+isOwnerAdminOrViewer\s*\(/);
  assert.ok(at > -1, 'isOwnerAdminOrViewer must still exist (used by other callers).');
  const body = sliceFn(src, at);
  assert.ok(/resolveAccessTier\s*\(/.test(body),
    'isOwnerAdminOrViewer must delegate to resolveAccessTier so the carve-out + ACL rules stay in ONE place (bug-47 r3). Two duplicate implementations drift — this was the original bug.');
});

t('server/src/sessions.js hardcoded labxnow/kkrazy/ryan-blues carve-out lives ONLY inside resolveAccessTier', () => {
  // Strip comments first — the helper\'s own doc-block mentions the
  // three usernames in prose, which would otherwise inflate the
  // duplicate count. We care that the CODE-level carve-out (a string
  // literal or Set entry) appears once, not how often the comment
  // explains it.
  const src = _stripJsComments(_read('server/src/sessions.js'));
  const carveOuts = src.match(/labxnow[^/]*?kkrazy[^/]*?ryan-blues|labxnow[^/]*?ryan-blues[^/]*?kkrazy|kkrazy[^/]*?labxnow[^/]*?ryan-blues|ryan-blues[^/]*?labxnow[^/]*?kkrazy/g) || [];
  assert.ok(carveOuts.length <= 1,
    `the labxnow/kkrazy/ryan-blues hardcoded carve-out must live in exactly one code-level place (resolveAccessTier) — found ${carveOuts.length} occurrences in non-comment portions of sessions.js. Duplicates drift (bug-47 r3).`);
  // Sanity: the carve-out must still EXIST somewhere in code —
  // otherwise we regressed labxnow's intended global access.
  assert.ok(/['"]labxnow['"]/.test(src),
    'the labxnow carve-out must still exist somewhere in code in sessions.js (preserves the user\'s intent that labxnow has global access; bug-47 r3 unifies the rule, doesn\'t remove it).');
});

// ── index.js: fileApiPreamble uses the new helper ──

t('server/src/index.js fileApiPreamble references resolveAccessTier', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/function\s+fileApiPreamble\s*\(/);
  assert.ok(at > -1, 'fileApiPreamble must exist.');
  const body = sliceFn(src, at);
  assert.ok(/resolveAccessTier\s*\(/.test(body),
    'fileApiPreamble must call resolveAccessTier instead of its own inline access check — that\'s the WHOLE POINT of bug-47 r3 (single source of truth so labxnow + future carve-outs apply uniformly).');
});

// ── marker comment ──

t('a comment naming bug-47 r3 explains the unification', () => {
  const sessions = _read('server/src/sessions.js');
  const index = _read('server/src/index.js');
  const re = /bug-47\s*r3|bug-47.*r3/i;
  assert.ok(re.test(sessions) || re.test(index),
    'a bug-47 r3 marker comment must appear in at least one of server/src/sessions.js / server/src/index.js so a future restyle knows why both files reference resolveAccessTier.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
