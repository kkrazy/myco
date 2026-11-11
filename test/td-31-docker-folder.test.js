// td-31: Docker files consolidated under docker/ folder.
//
// User pain point: Docker-related files were scattered across the repo
// root (Dockerfile, docker-entrypoint.sh) making them hard to locate
// and maintain. Expected layout: all Docker files under a single
// `docker/` folder so a future contributor running `ls docker/` sees
// every Docker artifact at once.
//
// Exception: `.dockerignore` MUST stay at the build-context root
// because Docker's CLI only honors it there (this is a docker-cli
// convention, not a myco choice).
//
// What this guard pins:
//   1. docker/Dockerfile exists at the new location
//   2. docker/docker-entrypoint.sh exists at the new location
//   3. NO Dockerfile at the repo root (proves the move happened, not
//      a copy)
//   4. NO docker-entrypoint.sh at the repo root (same)
//   5. Dockerfile's internal COPY references the entrypoint's new
//      docker/-prefixed path (the path is relative to build context,
//      not relative to the Dockerfile itself)
//   6. deploy.sh's docker build invocation uses -f docker/Dockerfile
//   7. .dockerignore is still at the repo root (Docker requires it
//      there)

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

t('docker/Dockerfile exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docker', 'Dockerfile')),
    'docker/Dockerfile must exist after td-31 move');
});

t('docker/docker-entrypoint.sh exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docker', 'docker-entrypoint.sh')),
    'docker/docker-entrypoint.sh must exist after td-31 move');
});

t('No Dockerfile at repo root (proves move, not copy)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'Dockerfile')),
    'Dockerfile must be moved (not copied) — root-level Dockerfile must NOT exist');
});

t('No docker-entrypoint.sh at repo root (proves move, not copy)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'docker-entrypoint.sh')),
    'docker-entrypoint.sh must be moved (not copied) — root-level docker-entrypoint.sh must NOT exist');
});

t('Dockerfile COPY references docker/docker-entrypoint.sh (relative to build context)', () => {
  const df = fs.readFileSync(path.join(ROOT, 'docker', 'Dockerfile'), 'utf8');
  assert.ok(/^COPY\s+docker\/docker-entrypoint\.sh\s+\/docker-entrypoint\.sh/m.test(df),
    'Dockerfile must `COPY docker/docker-entrypoint.sh /docker-entrypoint.sh` ' +
    '(build context stays at repo root via `docker build -f docker/Dockerfile .`)');
});

t('deploy.sh uses -f docker/Dockerfile when building', () => {
  const dep = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
  assert.ok(/docker build [^\n]*-f docker\/Dockerfile/.test(dep),
    'deploy.sh must invoke `docker build ... -f docker/Dockerfile .` so the moved Dockerfile is found');
});

t('.dockerignore stays at repo root (Docker convention)', () => {
  // Docker CLI only honors .dockerignore at the build-context root.
  // Moving it under docker/ would silently disable the ignore rules
  // and cause node_modules / _myco_/ / etc. to be sent to the daemon.
  assert.ok(fs.existsSync(path.join(ROOT, '.dockerignore')),
    '.dockerignore must remain at the repo root (build-context root) — Docker CLI does not honor it elsewhere');
});

t('test/test.sh greps docker/Dockerfile (not root Dockerfile)', () => {
  // test.sh lives at test/test.sh post-td-32; the status-bar test inside
  // it asserts /build.txt is written by the Dockerfile. After td-31,
  // that grep must target docker/Dockerfile.
  const ts = fs.readFileSync(path.join(ROOT, 'test', 'test.sh'), 'utf8');
  assert.ok(/grep -q '\/build\\\.txt' docker\/Dockerfile/.test(ts),
    'test/test.sh must grep docker/Dockerfile for the /build.txt write (post-td-31 path)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
