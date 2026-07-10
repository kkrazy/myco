// fr-111: root package.json doubles as an installable CLI package so
// `npm install -g github:kkrazy/myco#<sha>` produces a working `myco`
// binary on PATH. Layered on top of fr-110's workspaces field — the
// workspaces stay for local dev; the new bin/files/deps.ws let global
// install-from-git resolve to the CLI entrypoint.
//
// npm behavior for `npm install -g <git-url>`:
//   1. Downloads the repo tarball
//   2. Reads ROOT package.json
//   3. Installs its production `dependencies`
//   4. Applies ROOT's `files` filter to determine what's kept
//   5. Symlinks bin from ROOT's `bin` field
//
// `private: true` at root does NOT block install-from-git (only
// `npm publish`), so we keep it. workspaces field is metadata that
// npm's global install ignores; kept for local dev.
//
// Contract tested here:
//   1. Root package.json has bin.myco → ./cli/index.js
//   2. Root package.json has files array with cli/ subpaths
//   3. Root package.json has ws in dependencies (attach subcommand needs it)
//   4. Root package.json has a version matching semver
//   5. fr-110 invariants held: workspaces still ["cli"], private still true,
//      name still myco-monorepo (renaming would churn fr-110 tests + gain
//      nothing since bin.myco is what users type)
//   6. Root's ws version matches cli/package.json's ws version — locks
//      against silent drift
//   7. cli/package.json is unchanged (both packages remain independently
//      installable)
//   8. server/package.json + test.sh::ensure_server_deps + Dockerfile
//      all unaffected

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

console.log('── fr-111: root package.json doubles as installable CLI ──');

const rootPkg = _readJson('package.json');
const cliPkg  = _readJson('cli/package.json');

// ──────────────────────────────────────────────────────────────────
// Group A: the fr-111 additions — bin, files, ws, version.

t('root package.json: has version (npm requires it for some install paths)', () => {
  assert.ok(rootPkg.version, 'root must have a version');
  assert.ok(/^\d+\.\d+\.\d+/.test(rootPkg.version),
    `version must be semver-shaped (got: ${rootPkg.version})`);
});

t('root package.json: bin.myco points at ./cli/index.js (the CLI entrypoint)', () => {
  assert.ok(rootPkg.bin, 'root must declare bin');
  assert.strictEqual(rootPkg.bin.myco, './cli/index.js',
    'bin.myco must point at ./cli/index.js — that is the actual CLI entry, unchanged since fr-109');
});

t('root package.json: files array includes cli/index.js + cli/src/ + cli/share/', () => {
  assert.ok(Array.isArray(rootPkg.files), 'root must declare a files array');
  for (const required of ['cli/index.js', 'cli/src/', 'cli/share/']) {
    assert.ok(rootPkg.files.includes(required),
      `files array must include \`${required}\` — needed by install-from-github to preserve the cli/ tree`);
  }
});

t('root package.json: files includes cli/package.json (readCliVersion reads it at runtime)', () => {
  assert.ok(rootPkg.files.includes('cli/package.json'),
    'cli/package.json must be in the files array — cli/index.js\'s readCliVersion() reads it via require + fs at runtime to report --version');
});

t('root package.json: dependencies.ws present (myco attach needs it)', () => {
  assert.ok(rootPkg.dependencies && rootPkg.dependencies.ws,
    'root must declare ws as a runtime dep — the attach subcommand lazy-requires it, and a global install without ws would fail on the first attach attempt');
});

t('root package.json: description mentions the install-from-github role', () => {
  assert.ok(rootPkg.description && typeof rootPkg.description === 'string',
    'root must have a description');
  assert.ok(/install|CLI|myco/i.test(rootPkg.description),
    'description should mention install / CLI / myco so npmjs listings + npm ls output make sense');
});

// ──────────────────────────────────────────────────────────────────
// Group B: fr-110 invariants held (no regression from that slice).

t('fr-112 supersedes fr-110: workspaces field REMOVED from root (conflicted with bin/files at install time)', () => {
  assert.ok(!('workspaces' in rootPkg),
    'root package.json must NOT declare a `workspaces` field — fr-112 removed it because npm 8+ excludes workspace paths from the root package\'s install even when listed in `files`, which broke `npm install -g github:...` (the very thing fr-111 was meant to enable). See fr-112 test for the current invariant.');
});

t('fr-110 invariant: private is still true (blocks accidental publish; does not block install-from-git)', () => {
  assert.strictEqual(rootPkg.private, true,
    'private must stay true — install-from-github ignores it; publish check honors it');
});

t('fr-110 invariant: name is still myco-monorepo (renaming would churn fr-110 tests for no user-visible gain)', () => {
  assert.strictEqual(rootPkg.name, 'myco-monorepo',
    'root name unchanged — bin.myco is what users type, name is metadata');
});

t('fr-110 invariant: highlight.js dependency preserved (web/ still uses it)', () => {
  assert.ok(rootPkg.dependencies['highlight.js'],
    'highlight.js dep from fr-110 must be preserved alongside the new ws dep');
});

t('fr-110 invariant: existing devDependencies preserved (playwright, esbuild, codemirror bundle)', () => {
  for (const dep of ['playwright', 'esbuild', 'codemirror', '@codemirror/state', '@codemirror/theme-one-dark']) {
    assert.ok(rootPkg.devDependencies && rootPkg.devDependencies[dep],
      `devDependencies.${dep} must be preserved (build tooling for tools/codemirror-entry.mjs)`);
  }
});

t('fr-110 invariant: scripts.build:editor preserved', () => {
  assert.ok(rootPkg.scripts && rootPkg.scripts['build:editor'],
    'scripts.build:editor must be preserved');
});

// ──────────────────────────────────────────────────────────────────
// Group C: cross-package integrity — no drift between root and cli.

t('cross-package: root ws version matches cli/package.json ws version (no silent drift)', () => {
  assert.ok(rootPkg.dependencies.ws && cliPkg.dependencies && cliPkg.dependencies.ws,
    'both root and cli must declare ws');
  assert.strictEqual(rootPkg.dependencies.ws, cliPkg.dependencies.ws,
    `ws version must be identical in root and cli/package.json — currently root=${rootPkg.dependencies.ws} cli=${cliPkg.dependencies.ws}. If you bump one, bump both.`);
});

t('cli/package.json: name is still "@myco/cli" (both packages installable independently)', () => {
  assert.strictEqual(cliPkg.name, '@myco/cli',
    'cli/package.json must still declare @myco/cli — the fr-109 clone+install path (`npm install -g /path/to/cli`) still works');
});

t('cli/package.json: bin.myco still present (both packages install a myco binary)', () => {
  assert.ok(cliPkg.bin && cliPkg.bin.myco,
    'cli/package.json must still declare bin.myco — the fr-109 install path relies on it');
});

t('cli/package.json: unchanged in structure — files array + engines still intact', () => {
  assert.ok(Array.isArray(cliPkg.files) && cliPkg.files.length > 0,
    'cli/package.json files array must be preserved from fr-109');
  assert.ok(cliPkg.engines && cliPkg.engines.node,
    'cli/package.json engines.node must be preserved from fr-109');
});

// ──────────────────────────────────────────────────────────────────
// Group D: entrypoint integrity — cli/index.js still works.

t('cli/index.js: still requires ./src/argv at top-level (fr-109 dispatch shape)', () => {
  const src = _readText('cli/index.js');
  assert.ok(/require\(['"]\.\/src\/argv['"]\)/.test(src),
    'cli/index.js must still require ./src/argv — fr-111 does not change dispatch');
});

t('cli/index.js: ws is still lazy-required inside attachCmd (fr-109 fix preserved)', () => {
  const src = _readText('cli/index.js');
  const body = fnBody(src, /function attachCmd\s*\(/);
  assert.ok(body, 'attachCmd body must be locatable');
  assert.ok(/require\(['"]ws['"]\)/.test(body),
    'ws must be lazy-required inside attachCmd — top-level require would break --version/--help/integrate in a fresh checkout without npm install (regression from fr-109)');
});

// ──────────────────────────────────────────────────────────────────
// Group E: sibling invariance — server + docker + test.sh untouched.

t('server/package.json: name + dependencies unchanged (not affected by fr-111)', () => {
  const serverPkg = _readJson('server/package.json');
  assert.ok(serverPkg.name && serverPkg.dependencies,
    'server package.json must remain valid');
});

t('test.sh::ensure_server_deps: still probes server/node_modules/.package-lock.json (canary held)', () => {
  const src = _readText('test/test.sh');
  const body = fnBody(src, /^ensure_server_deps\s*\(\s*\)\s*\{/m);
  assert.ok(body, 'ensure_server_deps must exist');
  assert.ok(/server\/node_modules\/\.package-lock\.json/.test(body),
    'ensure_server_deps must still probe server/node_modules/.package-lock.json — same canary fr-110 established');
});

t('docker/Dockerfile: still COPY server/package.json (independent of root workspace + install shape)', () => {
  const src = _readText('docker/Dockerfile');
  assert.ok(/COPY\s+server\/package\.json/.test(src),
    'Dockerfile must still COPY server/package.json — build context independent of root');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
