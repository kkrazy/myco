// fr-110: convert the myco repo root to an npm workspace so
// `npm install -g github:kkrazy/myco --workspace=@myco/cli` works from
// any git ref (no npm registry publish required).
//
// Scope A (per fr-110 analyze): only `cli` is declared as a workspace.
// The server intentionally stays OUT of the workspace list so its deps
// keep living in server/node_modules/ — that's what test.sh's
// ensure_server_deps + docker/Dockerfile both assume. Adding server as
// a workspace later is a mechanical follow-up if we ever want it.
//
// Contract tested here:
//   1. Root package.json declares `workspaces` as an array containing
//      `"cli"` (npm resolves --workspace=@myco/cli through this).
//   2. Root package.json has `private: true` so nobody accidentally
//      publishes the monorepo container itself.
//   3. Root package.json has a `name` (npm requires it when
//      `workspaces` is set — otherwise install errors).
//   4. Server is NOT in the workspaces list (guards against Scope B
//      creep without deliberate design).
//   5. Existing root deps + scripts are preserved verbatim (highlight.js
//      runtime, codemirror + playwright + esbuild dev deps, build:editor
//      script — all still there).
//   6. cli/package.json still declares its own package name as
//      `@myco/cli` — that's what --workspace=@myco/cli resolves to.
//   7. server/package.json remains valid.
//   8. test.sh's ensure_server_deps guard is unchanged (still checks
//      server/node_modules/.package-lock.json — the canary for "server
//      didn't get accidentally hoisted to root by workspaces").

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

console.log('── fr-110: root repo as npm workspace (cli-only) ──');

const rootPkg = _readJson('package.json');

// ──────────────────────────────────────────────────────────────────
// Group A: root package.json shape (the fr-110 fix).

t('root package.json: has `name` (npm requires it when workspaces is set)', () => {
  assert.ok(rootPkg.name,
    'root package.json must have a `name` field — npm ≥7 errors on install when workspaces are set without a root name');
  assert.strictEqual(typeof rootPkg.name, 'string');
  assert.ok(rootPkg.name.length > 0);
});

t('root package.json: name is "myco-monorepo" (distinct from mycod + @myco/cli)', () => {
  assert.strictEqual(rootPkg.name, 'myco-monorepo',
    'root name must be `myco-monorepo` — distinguishes the monorepo container from the server (mycod) and the CLI (@myco/cli). Makes intent obvious in `npm ls` output.');
});

t('root package.json: `private: true` (blocks accidental publish of the monorepo container)', () => {
  assert.strictEqual(rootPkg.private, true,
    'root must be private: true so `npm publish` at root errors instead of accidentally uploading the whole monorepo');
});

t('root package.json: workspaces is an array', () => {
  assert.ok(Array.isArray(rootPkg.workspaces),
    'workspaces must be an array — npm accepts either array form or object form {packages: [...]}; we use the array form for simplicity');
});

t('root package.json: workspaces contains "cli"', () => {
  assert.ok(rootPkg.workspaces.includes('cli'),
    'workspaces array must contain "cli" — this is what `npm install -g github:kkrazy/myco --workspace=@myco/cli` resolves through');
});

t('root package.json: workspaces does NOT contain "server" (Scope A boundary — server stays authoritative in server/node_modules)', () => {
  assert.ok(!rootPkg.workspaces.includes('server'),
    'workspaces must NOT contain "server" — that would break test.sh::ensure_server_deps (which looks for server/node_modules/.package-lock.json) by hoisting server deps to root. Scope B (adding server later) is a deliberate follow-up, not an accident.');
});

t('root package.json: existing dependencies preserved (highlight.js still there — web/ uses it)', () => {
  assert.ok(rootPkg.dependencies && rootPkg.dependencies['highlight.js'],
    'root dependencies.highlight.js must be preserved — web/public serves the vendored highlight.js from this package');
});

t('root package.json: existing devDependencies preserved (playwright, esbuild, codemirror bundle)', () => {
  assert.ok(rootPkg.devDependencies,
    'root devDependencies section must exist');
  for (const dep of ['playwright', 'esbuild', 'codemirror', '@codemirror/state', '@codemirror/view', '@codemirror/theme-one-dark']) {
    assert.ok(rootPkg.devDependencies[dep],
      `root devDependencies.${dep} must be preserved (used by tools/codemirror-entry.mjs build path)`);
  }
});

t('root package.json: build:editor script preserved (esbuild bundle for CodeMirror on web/public)', () => {
  assert.ok(rootPkg.scripts && rootPkg.scripts['build:editor'],
    'root scripts.build:editor must be preserved — this bundles web/public/vendor/codemirror.bundle.js from tools/codemirror-entry.mjs');
  assert.ok(/esbuild.*codemirror-entry\.mjs/.test(rootPkg.scripts['build:editor']),
    'build:editor script content preserved verbatim');
});

// ──────────────────────────────────────────────────────────────────
// Group B: workspace target integrity — the thing --workspace=@myco/cli resolves to.

t('cli/package.json: name is "@myco/cli" — this is what --workspace=<name> targets', () => {
  const cliPkg = _readJson('cli/package.json');
  assert.strictEqual(cliPkg.name, '@myco/cli',
    'cli/package.json must declare name `@myco/cli` — npm resolves --workspace=@myco/cli by matching this exact package name against the workspace paths');
});

t('cli/package.json: still has bin.myco (workspace conversion must not break the CLI shape)', () => {
  const cliPkg = _readJson('cli/package.json');
  assert.ok(cliPkg.bin && cliPkg.bin.myco,
    'cli/package.json must still declare bin.myco so global installs place the binary');
});

// ──────────────────────────────────────────────────────────────────
// Group C: server integrity — the piece we deliberately left OUT.

t('server/package.json: still valid + still declares mycod (workspaces did NOT drag server in)', () => {
  const serverPkg = _readJson('server/package.json');
  assert.strictEqual(typeof serverPkg.name, 'string');
  assert.ok(serverPkg.name.length > 0,
    'server/package.json still has a name');
  assert.ok(serverPkg.dependencies,
    'server dependencies section intact');
});

t('test.sh::ensure_server_deps still probes server/node_modules/.package-lock.json (canary for "server not hoisted")', () => {
  const src = _readText('test/test.sh');
  const body = fnBody(src, /^ensure_server_deps\s*\(\s*\)\s*\{/m);
  assert.ok(body, 'ensure_server_deps must be locatable in test.sh');
  assert.ok(/server\/node_modules\/\.package-lock\.json/.test(body),
    'ensure_server_deps must still check server/node_modules/.package-lock.json — if this check moved to root/node_modules/ it means server got accidentally hoisted by workspaces, which fr-110 explicitly avoids');
  assert.ok(/cd server.*npm install/.test(body),
    'ensure_server_deps must still `cd server && npm install` — server install path unchanged by fr-110');
});

// ──────────────────────────────────────────────────────────────────
// Group D: Dockerfile invariance — proves fr-110 doesn't ripple into deploy.

t('Dockerfile: still COPY server/package.json (server-scoped install, independent of source-repo layout)', () => {
  const src = _readText('docker/Dockerfile');
  assert.ok(/COPY\s+server\/package\.json/.test(src),
    'Dockerfile must still COPY server/package.json — the container build context is independent of the source repo\'s workspace configuration. If this check ever needs to change, that means Scope A→B was silently accepted.');
});

// ──────────────────────────────────────────────────────────────────
// Group E: workspaces array is minimal (guards against Scope B creep).

t('root workspaces array has exactly one entry — cli (guards against silent Scope B creep)', () => {
  assert.strictEqual(rootPkg.workspaces.length, 1,
    `root workspaces array must have exactly 1 entry ("cli") — got: ${JSON.stringify(rootPkg.workspaces)}. Adding more entries (like "server") is a deliberate Scope B change requiring test infra updates. If you're adding another workspace, update this assertion count AND ensure_server_deps in test.sh.`);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
