// td-34: Caddyfile moved into docker/ folder.
//
// Caddyfile is deployment infrastructure config — the Caddy reverse-
// proxy definition. Its three consumers:
//   1. Build time: docker/Dockerfile COPY's it into /etc/caddy/Caddyfile
//      (the embedded fallback inside the image)
//   2. Deploy time: scripts/deploy.sh seed_caddyfile() scp's it to
//      $STATE_DIR/Caddyfile on first deploy if not already present
//   3. Runtime: bind-mount $STATE_DIR/Caddyfile → /etc/caddy/Caddyfile:ro
//      so operators can edit it without rebuilding the image
//
// Co-located with the Dockerfile (primary build-time consumer) under
// docker/ for symmetry with td-31's docker-entrypoint.sh placement.
//
// What this guard pins:
//   1. docker/Caddyfile exists at the new location
//   2. NO Caddyfile at the repo root (proves move, not copy)
//   3. docker/Dockerfile's COPY uses the new build-context-relative
//      path docker/Caddyfile
//   4. scripts/deploy.sh's scp source uses docker/Caddyfile
//   5. The actual Caddyfile content is preserved (still defines the
//      myco.labxnow.ai virtual host) — guards against accidental
//      content drift during the move

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

t('docker/Caddyfile exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docker', 'Caddyfile')),
    'docker/Caddyfile must exist after td-34 move');
});

t('No Caddyfile at repo root (proves move, not copy)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'Caddyfile')),
    'Caddyfile must be moved (not copied) — root-level Caddyfile must NOT exist');
});

t('docker/Dockerfile COPY references docker/Caddyfile', () => {
  const df = fs.readFileSync(path.join(ROOT, 'docker', 'Dockerfile'), 'utf8');
  assert.ok(/^COPY\s+docker\/Caddyfile\s+\/etc\/caddy\/Caddyfile/m.test(df),
    'docker/Dockerfile must `COPY docker/Caddyfile /etc/caddy/Caddyfile` ' +
    '(path is relative to the build context, which stays at repo root via `docker build -f docker/Dockerfile .`)');
});

t('scripts/deploy.sh scp source is docker/Caddyfile', () => {
  const dep = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.sh'), 'utf8');
  assert.ok(/remote_scp\s+docker\/Caddyfile\s+/.test(dep),
    'scripts/deploy.sh seed_caddyfile() must scp `docker/Caddyfile` (post-td-34 path) — was bare `Caddyfile` pre-td-34');
});

t('Caddyfile content preserved (myco.labxnow.ai virtual host)', () => {
  // Guards against accidental content corruption during the move.
  // The 10-line Caddyfile defines the prod virtual host + reverse
  // proxy target. If somebody accidentally clobbered it during the
  // git mv (e.g. by replacing with placeholder content), this catches
  // it before the next deploy ships a broken proxy config.
  const cf = fs.readFileSync(path.join(ROOT, 'docker', 'Caddyfile'), 'utf8');
  assert.ok(/myco\.labxnow\.ai\s*\{/.test(cf),
    'docker/Caddyfile must declare the `myco.labxnow.ai { ... }` virtual host');
  assert.ok(/reverse_proxy\s+localhost:3000/.test(cf),
    'docker/Caddyfile must `reverse_proxy localhost:3000` (the in-container mycod address)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
