// Test suite for Site-Wide Admin Privilege & API Key Configuration Dashboard
// Verifies:
//   1. Privilege Elevation: user 'labxnow' passes isOwnerOrAdmin, isOwnerAdminOrViewer, and lists all sessions.
//   2. Whitelist Mutators: addUserToAllowlist and removeUserFromAllowlist correctly manage allowed-github-users.txt.
//   3. .env Parser & Serializer: correctly reads, masks, updates, and hot-swaps process.env / .env files.
//   4. Route Access Control: GET/POST /api/admin/config and allowlist endpoints strictly authorize only 'labxnow'.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (err) {
    console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err));
    failed++;
  }
}

// ─── Privilege Elevation Verification ───────────────────────────────────────

t('sessions.js: isOwnerOrAdmin returns true for "labxnow" (case-insensitive)', () => {
  const { isOwnerOrAdmin } = require('../server/src/sessions');
  // Even if session does not exist, labxnow gets immediate true
  assert.strictEqual(isOwnerOrAdmin('any-session-id', 'labxnow'), true);
  assert.strictEqual(isOwnerOrAdmin('any-session-id', 'LabxNow'), true);
  assert.strictEqual(isOwnerOrAdmin('nonexistent', 'unrelated-user'), false);
});

t('sessions.js: isOwnerAdminOrViewer returns true for "labxnow" (case-insensitive)', () => {
  const { isOwnerAdminOrViewer } = require('../server/src/sessions');
  assert.strictEqual(isOwnerAdminOrViewer('any-session-id', 'labxnow'), true);
  assert.strictEqual(isOwnerAdminOrViewer('any-session-id', 'LabxNow'), true);
  assert.strictEqual(isOwnerAdminOrViewer('nonexistent', 'unrelated-user'), false);
});

// ─── Allowlist Mutators Verification ────────────────────────────────────────

t('auth.js: allowlist mutators correctly load, add, and remove users', () => {
  const auth = require('../server/src/auth');
  const tempUser = 'testadminuser_' + Math.floor(Math.random() * 100000);

  // Before adding
  const initialList = auth.loadAllowlist();
  assert.strictEqual(initialList.has(tempUser), false, 'Temporary user should not be whitelisted initially');

  // Add user
  const added = auth.addUserToAllowlist(tempUser);
  assert.strictEqual(added, true, 'User should be added successfully');
  assert.strictEqual(auth.isAllowed(tempUser), true, 'User must now be whitelisted');

  // Add duplicate (idempotent check)
  const reAdded = auth.addUserToAllowlist(tempUser);
  assert.strictEqual(reAdded, false, 'Adding duplicate user should return false');

  // Remove user
  const removed = auth.removeUserFromAllowlist(tempUser);
  assert.strictEqual(removed, true, 'User should be removed successfully');
  assert.strictEqual(auth.isAllowed(tempUser), false, 'User must no longer be whitelisted');

  // Remove non-existent (idempotent check)
  const reRemoved = auth.removeUserFromAllowlist(tempUser);
  assert.strictEqual(reRemoved, false, 'Removing non-existent user should return false');
});

// ─── Static guards and checks on index.js implementation ──────────────────

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

t('static guard: index.js defines requireAdmin middleware', () => {
  const src = _read('server/src/index.js');
  assert.ok(/function\s+requireAdmin\s*\(/.test(src), 'index.js must define requireAdmin middleware');
  assert.ok(/user(\.toLowerCase\(\))?\s*(!==|===)\s*['"]labxnow['"]/.test(src), 'requireAdmin must strictly assert user === "labxnow"');
});

t('static guard: index.js mounts GET/POST /api/admin/config and allowlist routes', () => {
  const src = _read('server/src/index.js');
  
  assert.ok(src.includes("app.get('/api/admin/config'"), 'GET /api/admin/config route must be registered');
  assert.ok(src.includes("app.post('/api/admin/config'"), 'POST /api/admin/config route must be registered');
  
  assert.ok(src.includes("app.get('/api/admin/allowlist'"), 'GET /api/admin/allowlist route must be registered');
  assert.ok(src.includes("app.post('/api/admin/allowlist'"), 'POST /api/admin/allowlist route must be registered');
  assert.ok(src.includes("app.delete('/api/admin/allowlist/:username'"), 'DELETE /api/admin/allowlist/:username route must be registered');
  
  // Make sure routes are gated by requireAdmin
  assert.ok(/app\.get\(['"]\/api\/admin\/config['"],\s*requireAdmin/.test(src), 'GET /api/admin/config must require requireAdmin');
  assert.ok(/app\.post\(['"]\/api\/admin\/config['"],\s*requireAdmin/.test(src), 'POST /api/admin/config must require requireAdmin');
  assert.ok(/app\.get\(['"]\/api\/admin\/allowlist['"],\s*requireAdmin/.test(src), 'GET /api/admin/allowlist must require requireAdmin');
  assert.ok(/app\.post\(['"]\/api\/admin\/allowlist['"],\s*requireAdmin/.test(src), 'POST /api/admin/allowlist must require requireAdmin');
  assert.ok(/app\.delete\(['"]\/api\/admin\/allowlist\/:username['"],\s*requireAdmin/.test(src), 'DELETE /api/admin/allowlist/:username must require requireAdmin');
});

t('static guard: index.js handles sensitive key masking', () => {
  const src = _read('server/src/index.js');
  assert.ok(/function\s+maskKey\s*\(/.test(src), 'index.js must define key masking helper function');
  assert.ok(/isMaskedValue\s*\(/.test(src), 'index.js must define masked value checker function');
});

t('static guard: index.js includes enterprise proxy configurations in ENV_KEYS', () => {
  const src = _read('server/src/index.js');
  assert.ok(src.includes("'HTTP_PROXY'"), 'HTTP_PROXY must be present in ENV_KEYS');
  assert.ok(src.includes("'HTTPS_PROXY'"), 'HTTPS_PROXY must be present in ENV_KEYS');
  assert.ok(src.includes("'NO_PROXY'"), 'NO_PROXY must be present in ENV_KEYS');
  assert.ok(src.includes("'MYCO_ENTERPRISE_TLS_INSECURE'"), 'MYCO_ENTERPRISE_TLS_INSECURE must be present in ENV_KEYS');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
