// deploy.sh post-deploy validation block.
//
// After verify_deploy confirms the new build is serving, post_deploy_checks
// runs 5 advisory checks (warnings only, never abort):
//   1. lean-ctx --version inside container (fr-55)
//   2. lean-ctx on PATH inside container (fr-55)
//   3. No lean-ctx errors in `docker logs --tail 200` (fr-55)
//   4. /USER_MANUAL.md serves HTTP 200 (sidebar book icon)
//   5. /vendor/codemirror.bundle.js serves HTTP 200 (fr-50)
//
// Static-grep guards on deploy.sh — no shell execution required.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const DEPLOY = fs.readFileSync(
  path.join(__dirname, '..', 'deploy.sh'), 'utf8');

console.log('── deploy.sh: post-deploy validation hooks ──');

// ──────────────────────────────────────────────────────────────────────
// Function + flag exist
// ──────────────────────────────────────────────────────────────────────

t('post_deploy_checks() function is defined', () => {
  assert.ok(/^post_deploy_checks\s*\(\)\s*\{/m.test(DEPLOY),
    'post_deploy_checks() must be defined in deploy.sh');
});

t('--skip-post-checks CLI flag parsed', () => {
  assert.ok(/--skip-post-checks\)\s*SKIP_POST_CHECKS=1/.test(DEPLOY),
    'parse_args must accept --skip-post-checks → SKIP_POST_CHECKS=1');
});

t('SKIP_POST_CHECKS defaults to 0', () => {
  assert.ok(/^SKIP_POST_CHECKS=0$/m.test(DEPLOY),
    'SKIP_POST_CHECKS=0 must be set in the config block (default: run the checks)');
});

t('main() invokes post_deploy_checks after verify_deploy', () => {
  // Look for the consecutive lines in main(); verify_deploy must come
  // first (it's a hard fail; we want to know the build is right
  // before doing the soft checks).
  assert.ok(/verify_deploy\s*\n\s*post_deploy_checks/.test(DEPLOY),
    'post_deploy_checks must run immediately after verify_deploy in main()');
});

// ──────────────────────────────────────────────────────────────────────
// Function body covers all 5 checks
// ──────────────────────────────────────────────────────────────────────

function _postChecksBody() {
  const start = DEPLOY.search(/^post_deploy_checks\s*\(\)\s*\{/m);
  assert.ok(start > -1, 'post_deploy_checks must exist');
  // Walk forward to the matching closing brace at column 0. The
  // function ends at `^}` on its own line.
  const after = DEPLOY.slice(start);
  const endMatch = after.match(/\n\}\n/);
  assert.ok(endMatch, 'post_deploy_checks must have a closing brace');
  return after.slice(0, endMatch.index + endMatch[0].length);
}

t('check 1: lean-ctx --version probe', () => {
  const body = _postChecksBody();
  assert.ok(/lean-ctx\s+--version/.test(body),
    'must run `lean-ctx --version` inside the container');
});

t('check 2: lean-ctx PATH resolution (which)', () => {
  const body = _postChecksBody();
  assert.ok(/which\s+lean-ctx/.test(body),
    'must run `which lean-ctx` to confirm PATH resolution');
});

t('check 3: docker logs scan for lean-ctx errors', () => {
  const body = _postChecksBody();
  assert.ok(/docker\s+logs[^|]*\|\s*grep[^|]*lean-ctx/.test(body) ||
            /grep[^|]*lean-ctx/.test(body),
    'must grep docker logs for lean-ctx error patterns');
  assert.ok(/(failed|error|ENOENT|ECONNREFUSED|ETIMEDOUT)/i.test(body),
    'must look for known error markers (failed/error/ENOENT/ECONNREFUSED/ETIMEDOUT)');
});

t('check 4: /USER_MANUAL.md HTTP probe', () => {
  const body = _postChecksBody();
  assert.ok(/USER_MANUAL\.md/.test(body),
    'must probe /USER_MANUAL.md');
  assert.ok(/curl[\s\S]{0,400}?USER_MANUAL\.md/.test(body),
    'must use curl to hit /USER_MANUAL.md');
});

t('check 5: /vendor/codemirror.bundle.js HTTP probe', () => {
  const body = _postChecksBody();
  assert.ok(/codemirror\.bundle\.js/.test(body),
    'must probe /vendor/codemirror.bundle.js (fr-50 editor bundle)');
});

// ──────────────────────────────────────────────────────────────────────
// Failure semantics: warnings (advisory), never abort
// ──────────────────────────────────────────────────────────────────────

t('checks emit warn() on failure, never die()', () => {
  const body = _postChecksBody();
  // die() aborts the script — wrong for post-deploy advisories. The
  // deploy is already done; we're reporting status, not gating.
  assert.ok(!/\bdie\s*"/.test(body) && !/\bdie\s+"/.test(body),
    'post_deploy_checks must NOT call die() — failures here are advisory');
  assert.ok(/\bwarn\s+"/.test(body),
    'post_deploy_checks must emit warnings via warn()');
});

t('counts + reports total warnings at the end', () => {
  const body = _postChecksBody();
  assert.ok(/warnings\s*=\s*0/.test(body),
    'must initialize warnings=0');
  assert.ok(/warnings\s*=\s*\$\(\(\s*warnings\s*\+\s*1\s*\)\)/.test(body) ||
            /warnings\+\+|warnings=\$\(\(warnings/.test(body),
    'must increment warnings counter on each failure');
  assert.ok(/post-deploy\s+warning/i.test(body),
    'must print the final warning count');
});

// ──────────────────────────────────────────────────────────────────────
// Domain plumbing: post_deploy_checks reuses verify_deploy's domain
// ──────────────────────────────────────────────────────────────────────

t('RESOLVED_DOMAIN global is declared + populated in verify_deploy', () => {
  assert.ok(/^RESOLVED_DOMAIN=""$/m.test(DEPLOY),
    'RESOLVED_DOMAIN="" must be declared at the top of the script');
  assert.ok(/RESOLVED_DOMAIN="\$domain"/.test(DEPLOY),
    'verify_deploy must assign RESOLVED_DOMAIN="$domain" after computing the domain');
});

t('post_deploy_checks reads RESOLVED_DOMAIN', () => {
  const body = _postChecksBody();
  assert.ok(/\$RESOLVED_DOMAIN/.test(body),
    'post_deploy_checks must reuse $RESOLVED_DOMAIN (don\'t re-derive — we want to probe the same host verify_deploy did)');
});

// ──────────────────────────────────────────────────────────────────────
// Skip behavior
// ──────────────────────────────────────────────────────────────────────

t('--skip-post-checks short-circuits the function', () => {
  const body = _postChecksBody();
  assert.ok(/SKIP_POST_CHECKS"?\s*=\s*"?1"?[\s\S]{0,200}?return/.test(body),
    'function must early-return when SKIP_POST_CHECKS=1');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
