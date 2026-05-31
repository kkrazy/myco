// fr-87 (the second one — id-allocator reuse): Config page MVP — let
// regular users manage their own PATs via a web UI instead of typing
// /setpat in chat.
//
// User-reported (verbatim from the plan-item dispatch):
//   Problem: Regular users cannot access the config page, blocking
//            them from managing their own preferences.
//   Expected: Config page is available to regular users, exposing
//             only user-scoped config.
//   Context: Must hide/strip system-wide config controls for non-
//            admin users while keeping them for privileged roles.
//   Comment: User pat should be part of the config
//
// Scope locked (per user's MVP pick): "Just my PATs (smallest,
// anchored to your comment)". No notification prefs, no theme, no
// sysadmin section — only PAT management this round.
//
// UX shape locked (per user's pick): click the @login chip in the
// top-right status bar to open the config modal. Sign-out moves
// inside the modal (was a `confirm()` dialog on the chip click).
//
// Contract being locked:
//   - git-tokens.js exports:
//     · removeRepoToken(user, provider, owner, repo, alias) — deletes
//       the per-repo PAT slot. Idempotent (unknown user / unknown key
//       returns false, no throw).
//     · removeUserToken(user, provider) — deletes the user-level
//       OAuth-fallback PAT. Idempotent.
//     · listAllPats(user) — returns the full PAT inventory for a
//       user as { userLevel: {github: meta|null, gitee: meta|null},
//       perRepo: [{provider, owner, repo, alias, last4}, ...] }.
//       Aliased entries (fr-82) appear with their alias field set;
//       un-aliased entries have alias: null. NEVER returns raw token
//       values — only the masked last4.
//   - index.js wires 5 auth-required routes:
//     · GET    /config/pats                                       → listAllPats(req.user)
//     · PUT    /config/pats/user-level                            → setUserToken
//     · PUT    /config/pats/per-repo                              → setRepoToken
//     · DELETE /config/pats/user-level/:provider                  → removeUserToken
//     · DELETE /config/pats/per-repo/:provider/:owner/:repo       → removeRepoToken
//     The GET response must NEVER include a raw token value — only
//     `present: true|false` + `last4: 'XXXX'`.
//   - web/public/index.html declares a #config-modal element
//     containing PAT sections + an in-modal sign-out button.
//   - web/public/app.js #user-stamp click handler opens #config-modal
//     instead of running `confirm('Sign out?')`. Sign-out is now
//     bound to a button inside the modal.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ── Pure-logic helpers (mirror the prod code's shape) ──

function maskToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  return { present: true, last4: s.slice(-4) };
}

function listAllPats(store, user) {
  const entry = store[user];
  if (!entry || typeof entry !== 'object') {
    return { userLevel: { github: null, gitee: null }, perRepo: [] };
  }
  const out = {
    userLevel: {
      github: entry.github ? maskToken(entry.github) : null,
      gitee:  entry.gitee  ? maskToken(entry.gitee)  : null,
    },
    perRepo: [],
  };
  for (const key of Object.keys(entry)) {
    // Per-repo keys: "github/owner/repo" or "github/owner/repo#alias"
    const m = key.match(/^([a-z]+)\/([^/]+)\/(.+?)(?:#(.+))?$/);
    if (!m) continue;
    const [, provider, owner, repo, alias] = m;
    if (!['github', 'gitee'].includes(provider)) continue;
    out.perRepo.push({
      provider,
      owner,
      repo,
      alias: alias || null,
      last4: maskToken(entry[key]).last4,
    });
  }
  out.perRepo.sort((a, b) => (a.provider + a.owner + a.repo + (a.alias || '')).localeCompare(b.provider + b.owner + b.repo + (b.alias || '')));
  return out;
}

function removeUserToken(store, user, provider) {
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return false;
  if (!(provider in entry)) return false;
  delete entry[provider];
  return true;
}

function removeRepoToken(store, user, provider, owner, repo, alias) {
  const entry = store[user];
  if (!entry || typeof entry !== 'object') return false;
  const key = alias
    ? `${provider}/${owner}/${repo}#${alias}`
    : `${provider}/${owner}/${repo}`;
  if (!(key in entry)) return false;
  delete entry[key];
  return true;
}

console.log('── fr-87: Config page (PATs MVP) ──');

// ── maskToken: NEVER expose the raw token ──

t('maskToken returns metadata only (present + last4) — never the raw value', () => {
  // Synthetic fixture — NOT a real PAT. github_pat_FAKE_… is invalid
  // by construction so the secret-scanning protection doesn't flag this
  // line on push. Length doesn't matter to maskToken; only the last 4
  // chars are inspected.
  const m = maskToken('github_pat_FAKE_FIXTURE_DO_NOT_USE_test_test_test_1234');
  assert.strictEqual(m.present, true);
  assert.strictEqual(m.last4, '1234');                   // slice(-4) → 4 trailing chars
  // Sanity: the masked shape must not contain any prefix of the original
  // beyond the trailing 4 chars.
  assert.ok(!m.raw, 'maskToken must NOT include a "raw" field');
  assert.ok(!m.token, 'maskToken must NOT include a "token" field');
  assert.ok(!m.value, 'maskToken must NOT include a "value" field');
});

t('maskToken on empty / null / non-string → null', () => {
  assert.strictEqual(maskToken(null), null);
  assert.strictEqual(maskToken(undefined), null);
  assert.strictEqual(maskToken(''), null);
  assert.strictEqual(maskToken('   '), null);
  assert.strictEqual(maskToken(123), null);
});

// ── listAllPats inventory shape ──

t('listAllPats on empty user → empty inventory (no throw)', () => {
  assert.deepStrictEqual(listAllPats({}, 'nobody'), {
    userLevel: { github: null, gitee: null },
    perRepo: [],
  });
});

t('listAllPats surfaces user-level + per-repo + aliased entries', () => {
  const store = {
    kkrazy: {
      github: 'ghp_user_level_token_ends_AAAA',
      gitee:  'gitee_user_level_token_ends_BBBB',
      'github/kkrazy/myco': 'ghp_repo_pat_ends_CCCC',
      'github/kkrazy/myco#work': 'ghp_aliased_pat_ends_DDDD',
    },
  };
  const out = listAllPats(store, 'kkrazy');
  assert.strictEqual(out.userLevel.github.last4, 'AAAA');
  assert.strictEqual(out.userLevel.gitee.last4, 'BBBB');
  assert.strictEqual(out.perRepo.length, 2,
    'aliased entry MUST appear as its own row (fr-82) — not folded into the non-aliased one');
  // The aliased entry's `repo` field MUST be "myco" — not "myco#work";
  // alias is its own field. Locks that the regex correctly splits the key.
  const aliased = out.perRepo.find((r) => r.alias === 'work');
  assert.ok(aliased, 'must find the aliased row');
  assert.strictEqual(aliased.repo, 'myco',
    'aliased row\'s repo MUST be just "myco" — alias is its own field, not concatenated');
  assert.strictEqual(aliased.last4, 'DDDD');
  const unaliased = out.perRepo.find((r) => r.alias === null);
  assert.ok(unaliased);
  assert.strictEqual(unaliased.repo, 'myco');
  assert.strictEqual(unaliased.last4, 'CCCC');
});

t('listAllPats output NEVER contains the raw token value at any nested key', () => {
  const store = {
    kkrazy: {
      github: 'ghp_THIS_IS_SECRET_must_not_leak',
      'github/kkrazy/myco': 'ghp_ANOTHER_SECRET_must_not_leak',
    },
  };
  const out = listAllPats(store, 'kkrazy');
  const serialized = JSON.stringify(out);
  assert.ok(!/SECRET/.test(serialized),
    'serialized listAllPats output must NOT contain any substring of any raw token value. Got: ' + serialized);
});

// ── remove helpers ──

t('removeUserToken deletes the right key + is idempotent', () => {
  const store = { kkrazy: { github: 'tok1', gitee: 'tok2' } };
  assert.strictEqual(removeUserToken(store, 'kkrazy', 'github'), true);
  assert.strictEqual(store.kkrazy.github, undefined);
  assert.strictEqual(store.kkrazy.gitee, 'tok2', 'sibling provider must be untouched');
  // Second call → no-op
  assert.strictEqual(removeUserToken(store, 'kkrazy', 'github'), false);
});

t('removeUserToken on unknown user / provider → false (no throw)', () => {
  const store = { kkrazy: { github: 'tok1' } };
  assert.strictEqual(removeUserToken(store, 'nobody', 'github'), false);
  assert.strictEqual(removeUserToken(store, 'kkrazy', 'unknown-provider'), false);
});

t('removeRepoToken deletes the right keyed slot (with and without alias)', () => {
  const store = {
    kkrazy: {
      'github/kkrazy/myco': 'default-tok',
      'github/kkrazy/myco#work': 'work-tok',
      'github/kkrazy/myco#personal': 'personal-tok',
    },
  };
  // Remove the default (no alias) — aliased siblings must survive.
  assert.strictEqual(removeRepoToken(store, 'kkrazy', 'github', 'kkrazy', 'myco', null), true);
  assert.strictEqual(store.kkrazy['github/kkrazy/myco'], undefined);
  assert.strictEqual(store.kkrazy['github/kkrazy/myco#work'], 'work-tok',
    'removing the default repo entry must NOT affect aliased entries on the same repo');
  // Remove one alias — the other survives.
  assert.strictEqual(removeRepoToken(store, 'kkrazy', 'github', 'kkrazy', 'myco', 'work'), true);
  assert.strictEqual(store.kkrazy['github/kkrazy/myco#work'], undefined);
  assert.strictEqual(store.kkrazy['github/kkrazy/myco#personal'], 'personal-tok');
});

t('removeRepoToken on unknown key → false (no throw)', () => {
  const store = { kkrazy: { 'github/kkrazy/myco': 'tok' } };
  assert.strictEqual(removeRepoToken(store, 'kkrazy', 'github', 'other', 'repo', null), false);
});

// ── Static-grep guards on prod source ──

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: git-tokens.js defines + exports the 3 new functions', () => {
  const src = _read('server/src/git-tokens.js');
  for (const fn of ['removeRepoToken', 'removeUserToken', 'listAllPats']) {
    assert.ok(new RegExp(`function\\s+${fn}\\s*\\(`).test(src),
      `git-tokens.js must define function ${fn}(...)`);
  }
  // Module exports block must mention each.
  const exportsAt = src.lastIndexOf('module.exports');
  const exportsWindow = src.slice(exportsAt);
  for (const fn of ['removeRepoToken', 'removeUserToken', 'listAllPats']) {
    assert.ok(new RegExp(`\\b${fn}\\b`).test(exportsWindow),
      `git-tokens.js module.exports must include ${fn}`);
  }
});

t('static guard: index.js wires GET /config/pats + the 4 mutation routes', () => {
  const src = _read('server/src/index.js');
  assert.ok(/app\.get\(\s*['"]\/config\/pats['"]/.test(src),
    'index.js must register GET /config/pats');
  assert.ok(/app\.put\(\s*['"]\/config\/pats\/user-level['"]/.test(src),
    'index.js must register PUT /config/pats/user-level');
  assert.ok(/app\.put\(\s*['"]\/config\/pats\/per-repo['"]/.test(src),
    'index.js must register PUT /config/pats/per-repo');
  assert.ok(/app\.delete\(\s*['"]\/config\/pats\/user-level\/:provider['"]/.test(src),
    'index.js must register DELETE /config/pats/user-level/:provider');
  assert.ok(/app\.delete\(\s*['"]\/config\/pats\/per-repo\/:provider\/:owner\/:repo['"]/.test(src),
    'index.js must register DELETE /config/pats/per-repo/:provider/:owner/:repo');
});

t('static guard: /config/pats routes are auth-required (use requireAuth middleware)', () => {
  const src = _read('server/src/index.js');
  // The 5 routes must use requireAuth so a non-auth\'d request 401s.
  const configBlockStart = src.search(/app\.(get|put|delete)\(\s*['"]\/config\/pats/);
  assert.ok(configBlockStart > 0);
  // Verify the GET route's signature includes requireAuth.
  const getMatch = src.match(/app\.get\(\s*['"]\/config\/pats['"]\s*,\s*requireAuth/);
  assert.ok(getMatch,
    'GET /config/pats must include requireAuth in its signature so a missing/bad token 401s instead of leaking');
});

t('static guard: GET /config/pats handler calls listAllPats — NOT setUserToken/setRepoToken', () => {
  const src = _read('server/src/index.js');
  const getAt = src.indexOf("app.get('/config/pats'");
  assert.ok(getAt > 0);
  // Window must reach the end of the GET handler (~400 chars is enough).
  const window = src.slice(getAt, getAt + 600);
  assert.ok(/listAllPats/.test(window),
    'GET /config/pats handler must call listAllPats(user) so the response shape is the safe masked one');
  // Defensive: GET handler must NEVER call getToken (raw value)
  assert.ok(!/getToken\s*\(/.test(window),
    'GET /config/pats must NOT call getToken — that returns the raw token, which would leak it through the API');
});

t('static guard: a comment in index.js cites fr-87 + the security intent', () => {
  const src = _read('server/src/index.js');
  // The comment block for the config routes must explain WHY raw
  // tokens are masked, so a future reader does not "simplify" by
  // returning the raw value.
  const m = src.match(/fr-87[\s\S]{0,2000}(?:never|NEVER|mask|last4|raw)/);
  assert.ok(m,
    'index.js must have a comment naming fr-87 that explains the never-leak-raw-token invariant');
});

t('static guard: index.html declares #config-modal', () => {
  const src = _read('web/public/index.html');
  assert.ok(/id\s*=\s*['"]config-modal['"]/.test(src),
    'index.html must declare an element with id="config-modal"');
  // It must be hidden by default (modal pattern used by the rest of the app).
  const modalAt = src.indexOf('id="config-modal"');
  const window = src.slice(modalAt, modalAt + 200);
  assert.ok(/hidden/.test(window),
    '#config-modal must be hidden by default so it doesn\'t flash on first page load');
});

t('static guard: app.js #user-stamp click handler opens config modal (NOT confirm sign-out)', () => {
  const src = _read('web/public/app.js');
  // showUserStamp must wire the chip\'s click to open #config-modal
  // instead of running the legacy confirm(\'Sign out?\') flow.
  const fnAt = src.indexOf('function showUserStamp');
  assert.ok(fnAt > 0);
  const window = src.slice(fnAt, fnAt + 1200);
  assert.ok(/config-modal/.test(window),
    'showUserStamp click handler must reference config-modal so clicking the @login chip opens the config UI');
  // The legacy confirm-signout text must NOT be the chip\'s click body
  // anymore (it should live on a separate sign-out button inside the
  // modal — that\'s tested by a separate guard below).
  assert.ok(!/confirm\(['"]Sign out/.test(window),
    'the @login chip click MUST NOT call confirm("Sign out…") directly anymore — sign-out moved INTO the config modal');
});

t('static guard: sign-out moved INTO the config modal (handled by a button inside it)', () => {
  const html = _read('web/public/index.html');
  // Find the config-modal element and confirm it contains a sign-out
  // affordance (button or link).
  const modalStart = html.indexOf('id="config-modal"');
  const modalEndMarker = html.indexOf('</div>', modalStart + 200);   // crude but workable for this guard
  // Walk forward a few KB to capture the modal body.
  const window = html.slice(modalStart, modalStart + 4000);
  assert.ok(/sign.?out|signout|log.?out|logout/i.test(window),
    '#config-modal must contain a sign-out button/link — moved out of the legacy confirm() prompt');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
