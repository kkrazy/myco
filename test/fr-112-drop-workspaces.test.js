// fr-112: drop the `workspaces` field from root package.json so
// `npm install -g github:kkrazy/myco#<sha>` produces a working
// `myco` binary.
//
// Root cause of the fr-110/fr-111 install failure: npm 8+ treats
// workspace paths as excluded from the root package's install tarball
// even when explicitly listed in the root `files` array. Empirical:
// user's `npm install -g github:kkrazy/myco#main` reported "added 3
// packages" but /opt/homebrew/lib/node_modules/myco-monorepo/cli/
// was empty — bin symlink at /opt/homebrew/bin/myco pointed at a
// nonexistent target, zsh dropped it from PATH hash, `myco` came back
// as "command not found."
//
// fr-112 fix: remove the workspaces field. Root becomes a pure
// installable-CLI package. Local dev uses `cd cli && npm install` (the
// fr-109-documented path) instead of `npm install` at root. Small
// friction; git-URL install works again.
//
// Contract tested here:
//   1. Root package.json does NOT declare a `workspaces` field
//      (the core fr-112 change)
//   2. fr-110's other additions still preserved (name, private) —
//      those weren't the problem, workspaces was
//   3. fr-111's install-CLI shape intact (bin.myco, files, ws dep,
//      version, description) — this is what makes the git-URL
//      install produce a functional myco binary
//   4. cli/package.json unchanged (still standalone-installable via
//      the fr-109 `cd cli && npm install -g .` path)
//   5. cli/index.js unchanged (dispatch through parseArgv, ws lazy in
//      attachCmd) — fr-109 invariants preserved
//   6. server + docker + test.sh untouched (single-source truth for
//      the "root workspaces don't leak into server or deploy" boundary)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
}
function _readText(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-112: drop workspaces from root (unbreaks npm install -g github:...) ──');

const rootPkg = _readJson('package.json');
const cliPkg  = _readJson('cli/package.json');

// ──────────────────────────────────────────────────────────────────
// Group A: the fr-112 change itself.

t('root package.json: workspaces field is ABSENT (fr-112 removed it)', () => {
  assert.ok(!('workspaces' in rootPkg),
    'root package.json must NOT declare a `workspaces` field — npm 8+\'s workspace semantics excluded workspace paths from the root install even when listed in `files`, breaking install-from-github. Removing workspaces restores the install path.');
});

t('root package.json: still valid npm shape (no orphaned commas, no broken JSON)', () => {
  // If the removal left broken JSON, JSON.parse in _readJson would throw
  // BEFORE this test runs. This assertion is belt-and-braces: verify
  // the parsed shape still has the expected top-level fields.
  const requiredFields = ['name', 'version', 'private', 'bin', 'files', 'dependencies', 'devDependencies', 'scripts'];
  for (const f of requiredFields) {
    assert.ok(f in rootPkg,
      `root package.json must retain \`${f}\` field after workspaces removal`);
  }
});

// ──────────────────────────────────────────────────────────────────
// Group B: fr-110's OTHER additions preserved (name, private).
// These were fine — only workspaces was the problem.

t('fr-110 preserved: name is still "myco-monorepo"', () => {
  assert.strictEqual(rootPkg.name, 'myco-monorepo',
    'root name unchanged — bin.myco is what users type, name is metadata');
});

t('fr-110 preserved: private is still true (blocks accidental publish)', () => {
  assert.strictEqual(rootPkg.private, true,
    'private must stay true — install-from-github ignores it, publish check honors it');
});

// ──────────────────────────────────────────────────────────────────
// Group C: fr-111 install-CLI shape intact.
// This is what makes `npm install -g github:kkrazy/myco#<sha>`
// produce a functional myco binary. All these fields must survive
// the workspaces removal.

t('fr-111 preserved: bin.myco → ./cli/index.js', () => {
  assert.ok(rootPkg.bin && rootPkg.bin.myco,
    'root must still declare bin.myco');
  assert.strictEqual(rootPkg.bin.myco, './cli/index.js',
    'bin.myco must point at ./cli/index.js — the CLI entrypoint');
});

t('fr-111 preserved: files array includes cli/index.js + cli/src/ + cli/share/ + cli/package.json', () => {
  assert.ok(Array.isArray(rootPkg.files),
    'root must still declare files array');
  for (const required of ['cli/index.js', 'cli/src/', 'cli/share/', 'cli/package.json']) {
    assert.ok(rootPkg.files.includes(required),
      `files array must include \`${required}\` — CRITICAL for install-from-github because now that workspaces is gone, files is the ONLY thing telling npm to pack the cli/ tree into the tarball`);
  }
});

t('fr-111 preserved: dependencies.ws (attach subcommand needs it)', () => {
  assert.ok(rootPkg.dependencies && rootPkg.dependencies.ws,
    'root must still declare ws as a runtime dep for the attach subcommand');
});

t('fr-111 preserved: version + description', () => {
  assert.ok(rootPkg.version && /^\d+\.\d+\.\d+/.test(rootPkg.version),
    'root version must be semver-shaped');
  assert.ok(rootPkg.description && typeof rootPkg.description === 'string',
    'root description must be present (surfaced by npmjs listings)');
});

t('fr-111 preserved: dependencies.highlight.js (fr-110-era dep for web/)', () => {
  assert.ok(rootPkg.dependencies['highlight.js'],
    'highlight.js dep must survive workspaces removal — web/ uses it');
});

t('fr-111 preserved: existing devDependencies + build:editor script', () => {
  for (const dep of ['playwright', 'esbuild', 'codemirror']) {
    assert.ok(rootPkg.devDependencies && rootPkg.devDependencies[dep],
      `devDependencies.${dep} must survive workspaces removal`);
  }
  assert.ok(rootPkg.scripts && rootPkg.scripts['build:editor'],
    'scripts.build:editor must survive workspaces removal');
});

// ──────────────────────────────────────────────────────────────────
// Group D: cli/package.json + cli/index.js unchanged.
// The fr-109 clone-and-install path (`cd cli && npm install -g .`)
// must still work as an alternative to the git-URL install.

t('cli/package.json: name is still "@myco/cli" (standalone install path unchanged)', () => {
  assert.strictEqual(cliPkg.name, '@myco/cli',
    'cli/package.json must still declare @myco/cli — fr-109 clone-install path still works as a fallback');
});

t('cli/package.json: still declares its own ws dep (parity with root)', () => {
  assert.ok(cliPkg.dependencies && cliPkg.dependencies.ws,
    'cli/package.json must still declare ws — required for the standalone `cd cli && npm install -g .` install path');
  assert.strictEqual(rootPkg.dependencies.ws, cliPkg.dependencies.ws,
    `ws version must match between root and cli/package.json (currently root=${rootPkg.dependencies.ws} cli=${cliPkg.dependencies.ws}). If you bump one, bump both.`);
});

t('cli/index.js: dispatch through parseArgv preserved (fr-109 invariant)', () => {
  const src = _readText('cli/index.js');
  assert.ok(/require\(['"]\.\/src\/argv['"]\)/.test(src),
    'cli/index.js must still require ./src/argv — fr-112 does not change dispatch');
});

t('cli/index.js: ws still lazy-required inside attachCmd (fr-109 fix preserved)', () => {
  const src = _readText('cli/index.js');
  const body = fnBody(src, /function attachCmd\s*\(/);
  assert.ok(body, 'attachCmd body must be locatable');
  assert.ok(/require\(['"]ws['"]\)/.test(body),
    'ws must remain lazy-required inside attachCmd — top-level require would break --version/--help/integrate in a fresh checkout without npm install');
});

// ──────────────────────────────────────────────────────────────────
// Group E: server + Dockerfile + test.sh unchanged.
// The "root workspaces don't leak into deploy" boundary held under
// fr-110 and stays held now that workspaces is gone.

t('server/package.json: unchanged (fr-112 does NOT touch server)', () => {
  const serverPkg = _readJson('server/package.json');
  assert.ok(serverPkg.name && serverPkg.dependencies,
    'server package.json must remain valid');
});

t('test.sh::ensure_server_deps: still probes server/node_modules/.package-lock.json (canary held)', () => {
  const src = _readText('test/test.sh');
  const body = fnBody(src, /^ensure_server_deps\s*\(\s*\)\s*\{/m);
  assert.ok(body, 'ensure_server_deps must exist');
  assert.ok(/server\/node_modules\/\.package-lock\.json/.test(body),
    'ensure_server_deps must still probe server/node_modules/.package-lock.json — the fr-110-established canary held under both fr-111 and fr-112');
});

t('docker/Dockerfile: still COPY server/package.json (independent of root workspace changes)', () => {
  const src = _readText('docker/Dockerfile');
  assert.ok(/COPY\s+server\/package\.json/.test(src),
    'Dockerfile must still COPY server/package.json — build context is independent of root package.json shape');
});

// ──────────────────────────────────────────────────────────────────
// Group F: fr-110's test file is gone (housekeeping — the assertions
// no longer apply and stale tests are worse than deleted ones).

t('housekeeping: fr-110\'s test file has been removed (its assertions no longer apply)', () => {
  const p = path.join(__dirname, 'fr-110-npm-workspaces.test.js');
  assert.ok(!fs.existsSync(p),
    'test/fr-110-npm-workspaces.test.js must be removed — its "workspaces still exists" assertions were superseded by fr-112. The fr-110 commit stays in git history.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
