// td-32: test.sh + test-browser.sh consolidated under test/ folder.
//
// User pain point: shell scripts at the repo root were scattered. The
// td-31 commit moved Docker artifacts under docker/. This commit does
// the same for the test runners — both shell scripts that drive the
// test/ directory's .test.js files belong inside test/ alongside the
// tests they run.
//
// What this guard pins:
//   1. test/test.sh exists at the new location
//   2. test/test-browser.sh exists at the new location
//   3. NO test.sh at the repo root (proves move, not copy)
//   4. NO test-browser.sh at the repo root (proves move, not copy)
//   5. test/test.sh has the cwd-anchor `cd "$(dirname "$0")/.."` so its
//      many `grep -q ... web/public/app.js` style checks resolve from
//      repo root regardless of caller CWD
//   6. test/test-browser.sh has the same cwd-anchor (its cd line was
//      `cd "$(dirname "$0")"` before — needed updating for the move)
//   7. deploy.sh invokes ./test/test.sh (not ./test.sh)
//   8. CLAUDE.md "ALWAYS run the FULL" pre-commit rule names ./test/test.sh

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

t('test/test.sh exists at new location', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'test.sh')),
    'test/test.sh must exist after td-32 move');
});

t('test/test-browser.sh exists at new location', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'test-browser.sh')),
    'test/test-browser.sh must exist after td-32 move');
});

t('No test.sh at repo root (proves move, not copy)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'test.sh')),
    'test.sh must be moved (not copied) — root-level test.sh must NOT exist');
});

t('No test-browser.sh at repo root (proves move, not copy)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'test-browser.sh')),
    'test-browser.sh must be moved (not copied) — root-level test-browser.sh must NOT exist');
});

// Matches either form of the CWD anchor:
//   - Simple lexical:  cd "$(dirname "$0")/.."
//   - Robust w/ BASH_SOURCE + double-cd-then-pwd:
//       cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/.."
// The substantive contract is "this script puts CWD one level above
// its own location," not the exact incantation. Regex matches any cd
// command whose argument involves `dirname` of either $0 or BASH_SOURCE
// and ends with `/..` — the `.` (rather than `[^"]`) allows the nested
// quotes of the robust form to pass through.
const CWD_ANCHOR_RE = /cd "[^\n]*\bdirname\b[^\n]*(?:\$0|BASH_SOURCE)[^\n]*\/\.\."/;

t('test/test.sh anchors CWD to repo root', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'test', 'test.sh'), 'utf8');
  assert.ok(CWD_ANCHOR_RE.test(sh),
    'test/test.sh must cd one level above its own location so its relative-path checks (grep web/public/app.js, etc.) work regardless of caller CWD');
});

t('test/test-browser.sh anchors CWD to repo root', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'test', 'test-browser.sh'), 'utf8');
  assert.ok(CWD_ANCHOR_RE.test(sh),
    'test/test-browser.sh must cd one level above its own location so `node server/src/index.js` + `node test/browser/render.test.js` resolve from repo root');
});

t('scripts/deploy.sh invokes ./test/test.sh (not ./test.sh)', () => {
  // After td-33, deploy.sh lives at scripts/deploy.sh.
  const dep = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
  assert.ok(/^\s*\.\/test\/test\.sh\s*$/m.test(dep),
    'deploy.sh must invoke `./test/test.sh` (post-td-32 path) as its pre-flight test step');
  // And the legacy path must NOT appear as a live invocation. (A grep
  // for `./test.sh` would false-positive on `./test/test.sh`, so we
  // anchor the whole line.)
  assert.ok(!/^\s*\.\/test\.sh\s*$/m.test(dep),
    'deploy.sh must NOT invoke the legacy ./test.sh path');
});

t('CLAUDE.md pre-commit rule names ./test/test.sh', () => {
  const md = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  // The "ALWAYS run the FULL ./test/test.sh before committing" rule.
  // Future reorgs that leave the doc stale would mislead new contributors.
  assert.ok(/ALWAYS run the FULL `\.\/test\/test\.sh`/.test(md),
    'CLAUDE.md must say "ALWAYS run the FULL `./test/test.sh`" in the Pre-Commit section');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
