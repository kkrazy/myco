// fr-80: `/fr @<target>`, `/bug @<target>`, `/td @<target>` route to a
// remote GitHub repo via the user's PAT instead of appending to the
// session's local plan.
//
// User-reported (kkrazy 2026-05-26):
//   "Slash commands `/fr @myco`, `/bug @myco`, and `/td @myco` rewrite
//    the user's note into a proper issue, submit it to
//    `github.com/kkrazy/myco`, and return a link for the user to
//    review/update."
//
// Implementation in server/src/slashcmds.js:
//   • REMOTE_TARGETS = { myco: { provider, owner, repo } }  registry
//   • addPlanItem detects `@<target>` prefix in args → routes to
//     handleRemoteIssue instead of adding a local plan item
//   • handleRemoteIssue reuses gitHosts.createIssue + getToken (same
//     auth path as /feature: per-repo PAT preferred, GitHub OAuth
//     fallback for github-hosted targets)
//   • Per-layer labels: Feature → enhancement, Bug → bug, Todo → todo
//
// Static-shape guards (no live HTTP — gitHosts.createIssue is an
// external boundary; integration testing belongs in a different
// suite).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');

console.log('── fr-80: /fr /bug /td @<target> remote issue routing ──');

t('slashcmds.js: REMOTE_TARGETS registry defines @myco → kkrazy/myco', () => {
  assert.ok(/const\s+REMOTE_TARGETS\s*=/.test(SRC),
    'REMOTE_TARGETS map must be declared');
  const idx = SRC.search(/const\s+REMOTE_TARGETS\s*=/);
  const win = SRC.slice(idx, idx + 600);
  assert.ok(/myco\s*:\s*\{[^}]*provider\s*:\s*['"]github['"]/.test(win),
    '@myco target must map to provider:github');
  assert.ok(/owner\s*:\s*['"]kkrazy['"]/.test(win),
    '@myco target owner must be kkrazy');
  assert.ok(/repo\s*:\s*['"]myco['"]/.test(win),
    '@myco target repo must be myco');
});

t('slashcmds.js: REMOTE_LABEL_BY_LAYER maps Feature/Bug/Todo to issue labels', () => {
  const idx = SRC.search(/const\s+REMOTE_LABEL_BY_LAYER\s*=/);
  assert.ok(idx > -1, 'REMOTE_LABEL_BY_LAYER must be declared');
  const win = SRC.slice(idx, idx + 400);
  assert.ok(/Feature\s*:\s*\[\s*['"]enhancement['"]/.test(win),
    'Feature → ["enhancement"]');
  assert.ok(/Bug\s*:\s*\[\s*['"]bug['"]/.test(win),
    'Bug → ["bug"]');
  assert.ok(/Todo\s*:\s*\[\s*['"]todo['"]/.test(win),
    'Todo → ["todo"]');
});

t('slashcmds.js: addPlanItem detects @<target> prefix + routes to handleRemoteIssue', () => {
  const idx = SRC.search(/function\s+addPlanItem\s*\(/);
  assert.ok(idx > -1);
  const win = SRC.slice(idx, idx + 3500);
  // The regex match for `@<target>`.
  assert.ok(/text\.match\(\s*\/\^@\(\[a-z0-9_-\]\+\)/i.test(win),
    'must match a leading @<target> token in args');
  // The route call.
  assert.ok(/return\s+handleRemoteIssue\(\s*ctx,\s*layer,\s*targetName,\s*remainder/.test(win),
    'must call handleRemoteIssue(ctx, layer, targetName, remainder) on match');
  // Unknown target bounces with a hint.
  assert.ok(/REMOTE_TARGETS\[targetName\]/.test(win),
    'must validate the target against REMOTE_TARGETS before routing');
  // Empty body after the target bounces with usage.
  assert.ok(/!remainder/.test(win),
    'must reject empty description after @target with a usage hint');
});

t('slashcmds.js: handleRemoteIssue is defined + uses gitHosts.{getToken,createIssue}', () => {
  assert.ok(/async\s+function\s+handleRemoteIssue\s*\(/.test(SRC),
    'handleRemoteIssue must be defined');
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  // r4 added the probe branch → bump again.
  const win = SRC.slice(idx, idx + 7500);
  assert.ok(/gitHosts\.getToken\(\s*ctx\.user/.test(win),
    'must call gitHosts.getToken(ctx.user, provider, owner, repo)');
  assert.ok(/gitHosts\.createIssue\(/.test(win),
    'must call gitHosts.createIssue to file the issue');
  // Per-layer labels via REMOTE_LABEL_BY_LAYER.
  assert.ok(/REMOTE_LABEL_BY_LAYER\[layer\]/.test(win),
    'must read labels from REMOTE_LABEL_BY_LAYER[layer]');
  // Returns a link on success.
  assert.ok(/result\.url/.test(win),
    'must include result.url in the success reply');
});

t('slashcmds.js: handleRemoteIssue title is the first line, capped at 80 chars', () => {
  // Long body lines shouldn't bleed into the issue title — the GitHub
  // issue list is scannable when titles stay short.
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  const win = SRC.slice(idx, idx + 3000);
  assert.ok(/firstLine\.length\s*>\s*80/.test(win),
    'must cap the title at 80 chars (truncate with ellipsis)');
  assert.ok(/split\(\s*\/\[\\r\\n\]\/,\s*1\)/.test(win),
    'must take only the first line (split on \\r or \\n, limit 1)');
});

t('slashcmds.js: handleRemoteIssue body includes user attribution + cmd marker', () => {
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  const win = SRC.slice(idx, idx + 3000);
  assert.ok(/Filed by/.test(win),
    'body must include "Filed by **@<user>**" attribution');
  assert.ok(/\/\$\{cmdName\} @\$\{targetName\}/.test(win),
    'body must cite the exact slash-command shape (e.g., `/fr @myco`)');
});

t('slashcmds.js: r2 — handleRemoteIssue 403 hint suggests re-sign-in FIRST (cheapest fix)', () => {
  // The login OAuth token is the default (gitHosts.getToken falls
  // back to it when no per-repo PAT is set). When that returns 403,
  // the cheapest fix is to re-sign-in (OAuth grants pre-dating the
  // `repo` scope addition won\'t carry issues:write). /setpat is the
  // last-resort override.
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  // r3+r4+fr-82 grew the function; bump window so the slice still
  // includes the `return;` boundary.
  const win = SRC.slice(idx, idx + 10000);
  assert.ok(/result\.status\s*===\s*403/.test(win),
    'must branch on the 403 status specifically');
  assert.ok(/Re-sign-in/i.test(win),
    '403 hint must mention "Re-sign-in" as the first fix');
  // Re-sign-in must be earlier in the message than /setpat (UX order).
  // Anchor on the branch boundary `return;` — earlier-text `);`
  // patterns inside strings make a `\);`-terminated slice unreliable.
  const m = win.match(/result\.status\s*===\s*403[\s\S]{0,5000}?return;/);
  assert.ok(m, '403 branch must be findable');
  const branchText = m[0];
  const signInIdx = branchText.search(/Re-sign-in/i);
  const setpatIdx  = branchText.search(/\/setpat/);
  assert.ok(signInIdx > -1 && setpatIdx > -1 && signInIdx < setpatIdx,
    '"Re-sign-in" must appear BEFORE the /setpat suggestion (cheapest-fix-first)');
  assert.ok(/OAuth/.test(branchText),
    '403 hint must explain that the OAuth login token was attempted (transparency about what we tried)');
});

t('slashcmds.js: r4 — empty-scopes path probes GET /user to distinguish revoked-grant vs dead-token', () => {
  // When X-OAuth-Scopes is empty, the cause is ambiguous between
  // "token still authenticates but the OAuth grant was revoked at
  // the user-app level" (probe succeeds) and "token is fully dead"
  // (probe fails). The 403 branch runs a follow-up GET /user probe
  // to disambiguate, and reports DIFFERENT fix paths per outcome.
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  const win = SRC.slice(idx, idx + 7500);
  // Probe is gated on "have === '(none reported)'" or empty.
  assert.ok(/none reported/.test(win) && /have/.test(win),
    'must check for empty scopes before probing');
  // Probe itself uses gitHosts.fetchUser.
  assert.ok(/gitHosts\.fetchUser\(\{\s*provider:\s*['"]github['"]/.test(win),
    'must probe via gitHosts.fetchUser(provider: github, token)');
  // Two-branch reporting: probe success → "alive but no scopes" hint;
  // probe failure → "token is dead, sign out + sign in".
  assert.ok(/alive/.test(win) && /revoked/i.test(win),
    'probe-success branch must mention token is alive + grant was revoked');
  assert.ok(/DEAD/.test(win) || /dead/.test(win),
    'probe-failure branch must mention the token is dead');
});

t('slashcmds.js: r3 — 403 hint surfaces the actual X-OAuth-Scopes from the response', () => {
  // GitHub returns X-OAuth-Scopes (what the token CAN do) and
  // X-Accepted-OAuth-Scopes (what the endpoint NEEDS) on every API
  // response. r3 captures both via git-hosts.js and surfaces them in
  // the 403 hint so the user sees literally what's missing instead
  // of guessing.
  const idx = SRC.search(/async\s+function\s+handleRemoteIssue\s*\(/);
  // fr-82 grew the function further; bump window from 5000 to 10000.
  const win = SRC.slice(idx, idx + 10000);
  // 403 branch reads result.scopes + result.acceptedScopes.
  assert.ok(/result\.scopes/.test(win),
    '403 branch must read result.scopes from the response');
  assert.ok(/result\.acceptedScopes/.test(win),
    '403 branch must read result.acceptedScopes from the response');
  // Branches on whether the token has `repo` (or `public_repo`) so the
  // hint is right whether the user needs to re-sign-in (no scope) or
  // dig into repo/org settings (has scope but still blocked).
  assert.ok(/hasRepo\s*=\s*\/[^/]*repo[^/]*\/[\s\S]{0,80}result\.scopes/.test(win),
    'must detect whether the token has a `repo`-family scope');
  // Issues-disabled is also mentioned (4th fix path) since that\'s
  // another common 403 cause that isn\'t about token scope at all.
  assert.ok(/Issues are enabled/i.test(win) || /Issues being disabled/i.test(win),
    'hint must mention "Issues enabled/disabled" as a 4th fix path (non-token cause)');
});

t('git-hosts.js: r3 — _httpsJson resolves with response headers', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'src', 'git-hosts.js'), 'utf8');
  // The resolve() call inside the success path includes a headers property.
  assert.ok(/resolve\(\s*\{\s*status:\s*res\.statusCode[\s\S]{0,200}headers:\s*res\.headers/.test(src),
    '_httpsJson success resolve must include headers: res.headers');
  // _createIssueGithub propagates scopes + acceptedScopes from the headers.
  assert.ok(/x-oauth-scopes/i.test(src),
    '_createIssueGithub must read x-oauth-scopes from result.headers');
  assert.ok(/x-accepted-oauth-scopes/i.test(src),
    '_createIssueGithub must read x-accepted-oauth-scopes from result.headers');
});

t('slashcmds.js: r2 — /setpat @<target> <token> path stores PAT without needing a session pointed at the target', () => {
  // Bootstrap fix: previously /setpat required `git remote get-url
  // origin` to point at the target repo. r2 lets the user paste a
  // PAT for a registered REMOTE_TARGETS entry from any session.
  const idx = SRC.search(/async\s+function\s+handleSetPat\s*\(/);
  const win = SRC.slice(idx, idx + 3500);
  // /setpat parses @<target> at the start of args.
  assert.ok(/args\.match\(\s*\/\^@\(\[a-z0-9_-\]\+\)/i.test(win),
    '/setpat must parse a leading @<target> token');
  // Validates against REMOTE_TARGETS (rejects unknown targets).
  assert.ok(/REMOTE_TARGETS\[targetName\]/.test(win),
    '/setpat must reject unknown @<target> values');
  // When target is set, host is built from REMOTE_TARGETS (no git remote detection).
  assert.ok(/host\s*=\s*\{\s*provider:\s*target\.provider/.test(win),
    'remote-target form must derive host from REMOTE_TARGETS (no git remote needed)');
  // Usage line mentions both forms (fr-82 added [--as <alias>] in the
  // remote-form variant — accept either with or without that segment).
  assert.ok(/Usage:\s*\/setpat\s*<token>[\s\S]{0,80}\/setpat\s*@<target>[\s\S]{0,80}<token>/.test(win),
    'usage hint must advertise both `<token>` and `@<target> [--as <alias>] <token>` forms');
});

t('slashcmds.js: command usage strings advertise @<target>', () => {
  // The /fr /bug /td registrations should hint at the remote-target
  // form in their usage line so the new path is discoverable from /help.
  const block = SRC.match(/names:\s*\[['"]fr['"]\][\s\S]{0,1500}/);
  assert.ok(block, 'fr/bug/td block must be findable');
  for (const cmd of ['fr', 'td', 'bug']) {
    const re = new RegExp(`usage:[^\\n]*${cmd}[^\\n]*@<target>`);
    assert.ok(re.test(SRC),
      `/${cmd} usage string must mention @<target> form`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
