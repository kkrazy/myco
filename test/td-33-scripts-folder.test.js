// td-33: Deployment / ops scripts consolidated under scripts/ folder
// + legacy non-Docker server launchers (start.sh, myco.service, mycod)
// deleted because the only documented deploy recipe is Docker via
// scripts/deploy.sh.
//
// What this guard pins:
//   1. scripts/deploy.sh exists
//   2. scripts/collect-logs.sh exists
//   3. scripts/install-tls.sh exists
//   4. scripts/install-renewal-hook.sh exists
//   5. NONE of the four exist at the repo root (proves move, not copy)
//   6. NONE of the deleted legacy trio (start.sh, myco.service, mycod)
//      exists anywhere
//   7. scripts/deploy.sh anchors CWD to repo root (so docker/Dockerfile,
//      ./test/test.sh, server/, web/ paths inside it still resolve)
//   8. scripts/collect-logs.sh anchors LOGS_DIR via `pwd)/..` so
//      _myco_/logs/ resolves at the repo root, not at scripts/
//   9. scripts/deploy.sh's pre-flight test invocation uses ./test/test.sh
//  10. The user-facing `myco` CLI launcher STAYS at the repo root
//      (idiomatic CLI placement + server's MYCO_BIN constant points there)

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Ops scripts at the new location ────────────────────────────────────
t('scripts/deploy.sh exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'deploy.sh')),
    'scripts/deploy.sh must exist after td-33 move');
});

t('scripts/collect-logs.sh exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'collect-logs.sh')),
    'scripts/collect-logs.sh must exist after td-33 move');
});

t('scripts/install-tls.sh exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'install-tls.sh')),
    'scripts/install-tls.sh must exist after td-33 move');
});

t('scripts/install-renewal-hook.sh exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'install-renewal-hook.sh')),
    'scripts/install-renewal-hook.sh must exist after td-33 move');
});

// None at the repo root (move, not copy) ──────────────────────────────
t('No deploy.sh at repo root', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'deploy.sh')),
    'deploy.sh must be moved (not copied) — root-level deploy.sh must NOT exist');
});

t('No collect-logs.sh at repo root', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'collect-logs.sh')),
    'collect-logs.sh must be moved (not copied) — root-level collect-logs.sh must NOT exist');
});

t('No install-tls.sh at repo root', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'install-tls.sh')),
    'install-tls.sh must be moved (not copied) — root-level install-tls.sh must NOT exist');
});

t('No install-renewal-hook.sh at repo root', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'install-renewal-hook.sh')),
    'install-renewal-hook.sh must be moved (not copied) — root-level install-renewal-hook.sh must NOT exist');
});

// Legacy non-Docker trio deleted ──────────────────────────────────────
t('start.sh deleted (legacy systemd launcher)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'start.sh')),
    'start.sh must be deleted — Docker via ./scripts/deploy.sh is the only deploy recipe');
});

t('myco.service deleted (legacy systemd unit)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'myco.service')),
    'myco.service must be deleted — Docker via ./scripts/deploy.sh is the only deploy recipe');
});

t('mycod deleted (legacy non-Docker launcher)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'mycod')),
    'mycod must be deleted — Docker via ./scripts/deploy.sh is the only deploy recipe');
});

// CWD anchors in moved scripts ────────────────────────────────────────
const CWD_ANCHOR_RE = /cd "[^\n]*\bdirname\b[^\n]*BASH_SOURCE[^\n]*\/\.\."/;

t('scripts/deploy.sh anchors CWD to repo root', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
  assert.ok(CWD_ANCHOR_RE.test(sh),
    'scripts/deploy.sh must cd to one level above its own location so relative paths (docker/Dockerfile, ./test/test.sh, server/, web/) still resolve from repo root post-td-33');
});

t('scripts/collect-logs.sh DIR resolves to repo root (one above scripts/)', () => {
  const sh = fs.readFileSync(path.join(ROOT, 'scripts', 'collect-logs.sh'), 'utf8');
  // Anchor is computed into DIR (not via cd) so the script can use
  // ${DIR}/_myco_/logs without changing pwd. After td-33, that DIR
  // must point at the repo root — not at scripts/.
  assert.ok(/DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)\/\.\."/.test(sh),
    'scripts/collect-logs.sh DIR must end in `/..` so ${DIR}/_myco_/logs resolves to repo-root/_myco_/logs (not scripts/_myco_/logs)');
});

// Deploy.sh test-step invocation ──────────────────────────────────────
t('scripts/deploy.sh pre-flight invokes ./test/test.sh', () => {
  const dep = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
  assert.ok(/^\s*\.\/test\/test\.sh\s*$/m.test(dep),
    'scripts/deploy.sh must invoke `./test/test.sh` as its pre-flight test step (paths still resolve from repo root because of the cwd anchor)');
});

// User-facing myco CLI stays at root ──────────────────────────────────
t('myco CLI launcher stays at repo root', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'myco')),
    'The user-facing `myco` CLI launcher must STAY at the repo root — server/src/index.js MYCO_BIN points at ../../myco and the .vscode/tasks.json template writes `myco attach <id>` expecting it on PATH or at the project root');
});

t('server/src/index.js MYCO_BIN still resolves to repo-root myco', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/MYCO_BIN\s*=\s*path\.resolve\(__dirname,\s*['"]\.\.\/\.\.\/myco['"]\)/.test(idx),
    'server/src/index.js must keep MYCO_BIN = path.resolve(__dirname, "../../myco") — the runtime path to the CLI launcher. If you move myco/ into cli/, update this constant too.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
