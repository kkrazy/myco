// fr-82: per-target PAT aliases ("switch accounts"). One myco-user
// can stash multiple PATs per (provider, owner, repo) under named
// aliases (e.g. `work`, `personal`, `labxnow`), then pick which one
// to use per command via `--as <alias>`.
//
// User-confirmed shape (via AskUserQuestion):
//   • Per-target PAT selection (storage keyed by user/provider/owner/repo/alias)
//   • No identity model change in myco itself — aliases ride the
//     existing git-tokens.json structure with `#<alias>` keys
//
// Surface:
//   • /setpat @<target> [--as <alias>] <token>   ← store
//   • /fr|/bug|/td @<target> [--as <alias>] <text>   ← pick on use
//   • /listpat [@<target>]                        ← inspect

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function tAsync(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const TOKENS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'git-tokens.js'), 'utf8');

console.log('── fr-82: per-target PAT aliases + account switching ──');

// ──────────────────────────────────────────────────────────────────────
// Storage layer (git-tokens.js)
// ──────────────────────────────────────────────────────────────────────

t('git-tokens.js: getToken accepts optional 5th arg `alias` + scopes lookup to the aliased slot', () => {
  assert.ok(/function\s+getToken\s*\(\s*user\s*,\s*provider\s*,\s*owner\s*,\s*repo\s*,\s*alias\s*\)/.test(TOKENS_SRC),
    'getToken must accept (user, provider, owner, repo, alias)');
  // Aliased lookup path checks key `<p>/<owner>/<repo>#<alias>` and
  // does NOT silently fall back to the default or user-level.
  assert.ok(/aliasKey\s*=\s*[`'"]?\$\{p\}\/\$\{owner\}\/\$\{repo\}#\$\{alias\}/.test(TOKENS_SRC),
    'aliased lookup must use the `#<alias>` suffix on the storage key');
  assert.ok(/if\s*\(\s*alias\s*\)[\s\S]{0,400}return\s+entry\[aliasKey\]\s*\|\|\s*null/.test(TOKENS_SRC),
    'aliased lookup must return entry[aliasKey] || null (no fallback)');
});

t('git-tokens.js: setRepoToken accepts optional 6th arg `alias` + writes to the aliased slot', () => {
  assert.ok(/function\s+setRepoToken\s*\(\s*user\s*,\s*provider\s*,\s*owner\s*,\s*repo\s*,\s*token\s*,\s*alias\s*\)/.test(TOKENS_SRC),
    'setRepoToken must accept (user, provider, owner, repo, token, alias)');
  // Alias validation regex pins the safe character set.
  assert.ok(/\[a-z0-9_-\]\{1,32\}/i.test(TOKENS_SRC),
    'alias must be validated against [a-z0-9_-]{1,32}');
  // Aliased writes use the #alias-suffixed key; un-aliased writes use
  // the plain key (unchanged from pre-fr-82 behavior).
  assert.ok(/alias\s*\n\s*\?\s*[`'"]?\$\{p\}\/\$\{owner\}\/\$\{repo\}#\$\{alias\}/.test(TOKENS_SRC),
    'aliased write must use the `#<alias>` suffix on the storage key');
});

t('git-tokens.js: listAliases returns sorted alias names for (user, provider, owner, repo)', () => {
  assert.ok(/function\s+listAliases\s*\(\s*user\s*,\s*provider\s*,\s*owner\s*,\s*repo\s*\)/.test(TOKENS_SRC),
    'listAliases helper must be defined');
  assert.ok(/return\s+result\.sort\(\)/.test(TOKENS_SRC),
    'listAliases must return a sorted array');
  // Export — accept trailing comment / comma.
  assert.ok(/module\.exports\s*=\s*\{[\s\S]*?\blistAliases\b/.test(TOKENS_SRC),
    'listAliases must be exported from git-tokens');
});

// Async tests must be awaited in sequence; the trailing process.exit
// can fire before any pending async settles. Wrap in IIFE.
(async () => {

// Runtime end-to-end against a temp store. Confirms aliases coexist
// and unknown aliases return null.
await tAsync('git-tokens.js: runtime — default + multiple aliases coexist + unknown alias → null', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr82-tok-'));
  const prev = process.env.MYCO_STATE_DIR;
  process.env.MYCO_STATE_DIR = tmp;
  // Force-reload the module so the new MYCO_STATE_DIR takes effect.
  delete require.cache[require.resolve('../server/src/git-tokens.js')];
  const tokens = require('../server/src/git-tokens.js');
  try {
    tokens.setRepoToken('kk', 'github', 'kkrazy', 'myco', 'def');
    tokens.setRepoToken('kk', 'github', 'kkrazy', 'myco', 'wk',  'work');
    tokens.setRepoToken('kk', 'github', 'kkrazy', 'myco', 'pr',  'personal');
    assert.strictEqual(tokens.getToken('kk', 'github', 'kkrazy', 'myco'),            'def');
    assert.strictEqual(tokens.getToken('kk', 'github', 'kkrazy', 'myco', 'work'),    'wk');
    assert.strictEqual(tokens.getToken('kk', 'github', 'kkrazy', 'myco', 'personal'), 'pr');
    assert.strictEqual(tokens.getToken('kk', 'github', 'kkrazy', 'myco', 'nope'),    null,
      'unknown alias must return null (no silent fallback to default)');
    assert.deepStrictEqual(tokens.listAliases('kk', 'github', 'kkrazy', 'myco'),
      ['personal', 'work'], 'listAliases must return sorted names');
  } finally {
    if (prev) process.env.MYCO_STATE_DIR = prev; else delete process.env.MYCO_STATE_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/git-tokens.js')];
  }
});

t('git-tokens.js: setRepoToken rejects malformed alias (defensive)', () => {
  // Slot key is derived from alias — must be safe-charset.
  delete require.cache[require.resolve('../server/src/git-tokens.js')];
  const tokens = require('../server/src/git-tokens.js');
  let threw = false;
  try { tokens.setRepoToken('u', 'github', 'o', 'r', 'tok', 'bad alias with spaces'); }
  catch (e) { threw = true; assert.ok(/alias must match/i.test(e.message), e.message); }
  assert.ok(threw, 'must throw on aliases outside [a-z0-9_-]{1,32}');
});

// ──────────────────────────────────────────────────────────────────────
// Slash-command surface (slashcmds.js)
// ──────────────────────────────────────────────────────────────────────

t('slashcmds.js: handleSetPat parses --as <alias> after @<target>', () => {
  const idx = SRC.search(/async\s+function\s+handleSetPat\s*\(/);
  const win = sliceFn(SRC, idx);
  assert.ok(/aliasMatch\s*=\s*args\.match\(\s*\/\^--as\\s\+\(\[a-z0-9_-\]\+\)/i.test(win),
    'handleSetPat must parse a leading --as <alias> token (after the optional @target)');
  // Pass alias through to setRepoToken.
  assert.ok(/gitHosts\.setRepoToken\([\s\S]{0,200}token\s*,\s*alias\s*\)/.test(win),
    'handleSetPat must forward alias to gitHosts.setRepoToken');
  // Usage string mentions --as form.
  assert.ok(/--as\s+<alias>/.test(win),
    'usage hint must mention --as <alias>');
});

t('slashcmds.js: addPlanItem parses --as <alias> after @<target> + forwards to handleRemoteIssue', () => {
  const idx = SRC.search(/function\s+addPlanItem\s*\(/);
  const win = sliceFn(SRC, idx);
  assert.ok(/aliasMatch\s*=\s*remainder\.match\(\s*\/\^--as\\s\+\(\[a-z0-9_-\]\+\)/i.test(win),
    'addPlanItem must parse --as <alias> in the @<target> branch');
  // r5 added shouldRewrite as the 6th arg; alias stays as 5th. Accept
  // either signature width but require `alias` to be in the call.
  assert.ok(/return\s+handleRemoteIssue\(\s*ctx,\s*layer,\s*targetName,\s*remainder,\s*alias[\s,)]/.test(win),
    'addPlanItem must forward alias to handleRemoteIssue (5th arg; 6th = shouldRewrite added in r5)');
});

t('slashcmds.js: handleRemoteIssue accepts alias + passes to gitHosts.getToken', () => {
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  const win = sliceFn(SRC, idx);
  // fr-80 r5 added a 6th `shouldRewrite` arg after `alias`. Accept the
  // wider signature — what we're pinning is that `alias` is present.
  assert.ok(/async\s+function\s+handleRemoteIssue\s*\(\s*ctx\s*,\s*layer\s*,\s*targetName\s*,\s*description\s*,\s*alias\s*[,)]/.test(win),
    'handleRemoteIssue signature must include the alias parameter');
  assert.ok(/gitHosts\.getToken\(\s*ctx\.user\s*,\s*target\.provider\s*,\s*target\.owner\s*,\s*target\.repo\s*,\s*alias\s*\)/.test(win),
    'getToken call must pass alias through');
});

t('slashcmds.js: "no PAT for alias" error lists which aliases ARE stored', () => {
  // When the user asks for --as <alias> and that alias has no token,
  // listAliases() is called so the error can suggest the correct
  // alias name (catches typos).
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  const win = sliceFn(SRC, idx);
  assert.ok(/gitHosts\.listAliases\(/.test(win),
    'no-token-for-alias branch must call listAliases for the hint');
  assert.ok(/Aliases on file/i.test(win),
    'error message must say "Aliases on file: ..." with the list');
});

t('slashcmds.js: /listpat command registered + handleListPat defined', () => {
  assert.ok(/names:\s*\[['"]listpat['"]\]/.test(SRC),
    '/listpat command must be registered');
  assert.ok(/async\s+function\s+handleListPat\s*\(/.test(SRC),
    'handleListPat must be defined');
  const idx = SRC.search(/async\s+function\s+handleListPat\s*\(/);
  const win = sliceFn(SRC, idx);
  assert.ok(/gitHosts\.listAliases\(/.test(win),
    'handleListPat must call gitHosts.listAliases to enumerate stored aliases');
  // Accepts both session form + @<target> form.
  assert.ok(/REMOTE_TARGETS\[targetName\]/.test(win),
    '/listpat @<target> path must validate against REMOTE_TARGETS');
  assert.ok(/gitHosts\.detectHost\(/.test(win),
    '/listpat (no args) must auto-detect from the session\'s git remote');
});

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
