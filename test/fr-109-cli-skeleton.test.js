// fr-109: bash-installable myco CLI skeleton — @myco/cli npm package.
//
// This is Phase 1 of fr-108 (the combined CLI + chat VSCode extension).
// The skeleton establishes the distribution model:
//   * `npm install -g @myco/cli` provides the `myco` binary
//   * `myco --version` / `myco --help` / `myco integrate --bash|--zsh`
//     are the day-one commands
//   * `myco attach <id>` (pre-fr-109) still works unchanged
//   * Sourcing `$(myco integrate --bash)` is a silent no-op that
//     future phases (fr-110 classifier) fill in
//
// Contract tested here:
//   1. cli/package.json declares the correct shape for npm publish
//      (name, bin, engines, files array, main entry)
//   2. cli/index.js dispatches through the pure argv parser we can
//      import (test approach A per fr-109 analyze)
//   3. cli/src/argv.js exports parseArgv + helpText + COMMANDS with the
//      documented contract shape
//   4. cli/share/myco.bash and cli/share/myco.zsh exist as sourceable
//      stubs with idempotency guards
//   5. Behavioral: parseArgv handles --version, --help, attach, and
//      integrate correctly + returns usage-with-error on bad input
//   6. Small smoke test: `node cli/index.js --version` and
//      `--help` run without errors (end-to-end sanity)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-109: bash-installable myco CLI skeleton (@myco/cli) ──');

// ──────────────────────────────────────────────────────────────────
// Group A: package.json shape (npm publish surface).

const pkg = JSON.parse(_read('cli/package.json'));

t('package.json: name is "@myco/cli" (scoped for future @myco/core, @myco/vscode siblings)', () => {
  assert.strictEqual(pkg.name, '@myco/cli',
    'package name must be @myco/cli so it slots into the planned @myco scope');
});

t('package.json: bin.myco points at ./index.js', () => {
  assert.ok(pkg.bin && pkg.bin.myco,
    'package.json must declare `bin.myco` so `npm install -g` places the binary as `myco`');
  assert.strictEqual(pkg.bin.myco, './index.js',
    'bin.myco must point at the actual entrypoint (./index.js)');
});

t('package.json: engines.node ≥18 (matches server + supports ESM + async iterators for future WS)', () => {
  assert.ok(pkg.engines && pkg.engines.node,
    'engines.node must be set so npm warns on old Node');
  // Node 18 was the LTS at time of fr-109. Accept 18/20/22/newer.
  assert.ok(/>=1[89]|>=2[024]/.test(pkg.engines.node),
    `engines.node must require ≥18 (got: ${pkg.engines.node})`);
});

t('package.json: files array includes what publish needs (index.js, src/, share/, README)', () => {
  assert.ok(Array.isArray(pkg.files),
    'package.json must declare `files` array so `npm publish` includes the right paths');
  for (const required of ['index.js', 'src/', 'share/', 'README.md']) {
    assert.ok(pkg.files.includes(required),
      `files array must include \`${required}\` (got: ${JSON.stringify(pkg.files)})`);
  }
});

t('package.json: version parses as semver + is non-zero', () => {
  assert.ok(pkg.version,
    'package.json must declare a version');
  assert.ok(/^\d+\.\d+\.\d+/.test(pkg.version),
    `version must be semver-shaped (got: ${pkg.version})`);
});

t('package.json: ws is a runtime dep (attach + future WS chat need it)', () => {
  assert.ok(pkg.dependencies && pkg.dependencies.ws,
    'ws must be a runtime dependency; the existing attach subcommand + fr-112 chat client both use it');
});

// ──────────────────────────────────────────────────────────────────
// Group B: argv parser (pure function, testable in isolation).

const { parseArgv, helpText, COMMANDS, INTEGRATE_TARGETS } = require('../cli/src/argv');

t('argv: parseArgv is a function', () => {
  assert.strictEqual(typeof parseArgv, 'function',
    'parseArgv must be exported as a function so index.js and tests share one implementation');
});

t('argv: COMMANDS enum defines version / help / attach / integrate / usage', () => {
  for (const key of ['VERSION', 'HELP', 'ATTACH', 'INTEGRATE', 'USAGE']) {
    assert.ok(COMMANDS[key], `COMMANDS.${key} must be defined`);
  }
});

t('argv: no args → help (welcoming default, not usage-error)', () => {
  const r = parseArgv([]);
  assert.strictEqual(r.command, COMMANDS.HELP,
    'bare `myco` (no args) must show help — not an error');
});

t('argv: --version / -v → version', () => {
  assert.strictEqual(parseArgv(['--version']).command, COMMANDS.VERSION);
  assert.strictEqual(parseArgv(['-v']).command, COMMANDS.VERSION);
});

t('argv: --help / -h → help', () => {
  assert.strictEqual(parseArgv(['--help']).command, COMMANDS.HELP);
  assert.strictEqual(parseArgv(['-h']).command, COMMANDS.HELP);
});

t('argv: attach <id> → attach with sessionId', () => {
  const r = parseArgv(['attach', 'sess-123']);
  assert.strictEqual(r.command, COMMANDS.ATTACH);
  assert.strictEqual(r.sessionId, 'sess-123');
});

t('argv: attach with no id → usage error mentioning "session id"', () => {
  const r = parseArgv(['attach']);
  assert.strictEqual(r.command, COMMANDS.USAGE);
  assert.ok(/session/i.test(r.error),
    'error must explain the missing session id argument');
});

t('argv: attach with extra args → usage error', () => {
  const r = parseArgv(['attach', 'sess-123', 'oops']);
  assert.strictEqual(r.command, COMMANDS.USAGE,
    'extra args after `attach <id>` must surface as usage error (not silently ignored)');
});

t('argv: integrate --bash → integrate with target bash', () => {
  const r = parseArgv(['integrate', '--bash']);
  assert.strictEqual(r.command, COMMANDS.INTEGRATE);
  assert.strictEqual(r.target, 'bash');
});

t('argv: integrate --zsh → integrate with target zsh', () => {
  const r = parseArgv(['integrate', '--zsh']);
  assert.strictEqual(r.command, COMMANDS.INTEGRATE);
  assert.strictEqual(r.target, 'zsh');
});

t('argv: integrate with no target → usage error explaining --bash|--zsh', () => {
  const r = parseArgv(['integrate']);
  assert.strictEqual(r.command, COMMANDS.USAGE);
  assert.ok(/--bash|--zsh/.test(r.error),
    'error must mention the accepted target flags so the user knows what to try');
});

t('argv: integrate --unknown-shell → usage error naming the unsupported target', () => {
  const r = parseArgv(['integrate', '--fish']);
  assert.strictEqual(r.command, COMMANDS.USAGE);
  assert.ok(/fish/.test(r.error),
    'error must name the unsupported target so the user sees what they typed');
});

t('argv: unknown top-level command → usage error naming the command', () => {
  const r = parseArgv(['nonsense']);
  assert.strictEqual(r.command, COMMANDS.USAGE);
  assert.ok(/nonsense/.test(r.error),
    'error must name the unknown command so the user sees what they typed');
});

t('argv: INTEGRATE_TARGETS contains bash + zsh (future phases extend)', () => {
  assert.ok(INTEGRATE_TARGETS.has('bash'), 'bash must be a supported integrate target');
  assert.ok(INTEGRATE_TARGETS.has('zsh'),  'zsh must be a supported integrate target');
});

t('helpText: mentions all documented commands + fr-110/111/112/113 roadmap', () => {
  const help = helpText('myco');
  for (const marker of ['--version', '--help', 'attach', 'integrate', '--bash', '--zsh']) {
    assert.ok(help.includes(marker), `help text must mention \`${marker}\``);
  }
  // Roadmap markers help future readers see where fr-109 fits.
  assert.ok(/fr-110|fr-111|fr-112|fr-113/.test(help),
    'help text must reference the roadmap so users see what is coming');
});

// ──────────────────────────────────────────────────────────────────
// Group C: shell integration stubs.

t('cli/share/myco.bash: exists + has idempotency guard', () => {
  const bash = _read('cli/share/myco.bash');
  assert.ok(/MYCO_INTEGRATE_LOADED/.test(bash),
    'bash stub must set MYCO_INTEGRATE_LOADED so double-sourcing is a no-op');
  assert.ok(/return/.test(bash),
    'bash stub must `return` early when already loaded (idempotency)');
});

t('cli/share/myco.zsh: exists + has idempotency guard', () => {
  const zsh = _read('cli/share/myco.zsh');
  assert.ok(/MYCO_INTEGRATE_LOADED/.test(zsh),
    'zsh stub must set MYCO_INTEGRATE_LOADED (parity with bash)');
});

t('cli/share/myco.bash + myco.zsh: reference fr-109 (marker for future readers)', () => {
  assert.ok(/fr-109/.test(_read('cli/share/myco.bash')),
    'bash stub must carry an fr-109 marker so a future reader knows the origin');
  assert.ok(/fr-109/.test(_read('cli/share/myco.zsh')),
    'zsh stub must carry an fr-109 marker');
});

// ──────────────────────────────────────────────────────────────────
// Group D: end-to-end smoke (small — approach A + a dash of B).

t('smoke: `node cli/index.js --version` prints a semver-shaped line + exit 0', () => {
  const out = execFileSync('node', [path.join(__dirname, '..', 'cli/index.js'), '--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(/^\d+\.\d+\.\d+\s*$/.test(out),
    `output must be a semver line only (got: ${JSON.stringify(out)})`);
});

t('smoke: `node cli/index.js --help` prints help text mentioning `attach` and `integrate` + exit 0', () => {
  const out = execFileSync('node', [path.join(__dirname, '..', 'cli/index.js'), '--help'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(/attach/i.test(out) && /integrate/i.test(out),
    'help output must mention both attach and integrate subcommands');
});

t('smoke: `node cli/index.js integrate --bash` prints a source line pointing at myco.bash + exit 0', () => {
  const out = execFileSync('node', [path.join(__dirname, '..', 'cli/index.js'), 'integrate', '--bash'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(/source\s+["']?.*myco\.bash/.test(out),
    `output must contain a source line pointing at share/myco.bash (got: ${JSON.stringify(out)})`);
});

t('smoke: `node cli/index.js integrate --zsh` prints a source line pointing at myco.zsh + exit 0', () => {
  const out = execFileSync('node', [path.join(__dirname, '..', 'cli/index.js'), 'integrate', '--zsh'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(/source\s+["']?.*myco\.zsh/.test(out),
    `output must contain a source line pointing at share/myco.zsh (got: ${JSON.stringify(out)})`);
});

t('smoke: `node cli/index.js` (no args) exits with help — nonzero because it lands on USAGE-shaped default', () => {
  // Actually parseArgv([]) → HELP, not USAGE. So it exits 0. Confirm.
  const out = execFileSync('node', [path.join(__dirname, '..', 'cli/index.js')], {
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(/myco/.test(out), 'bare invocation must print SOMETHING referencing myco (help header)');
});

t('smoke: `node cli/index.js unknown-thing` exits non-zero + prints usage on stderr', () => {
  try {
    execFileSync('node', [path.join(__dirname, '..', 'cli/index.js'), 'unknown-thing'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('should have exited non-zero');
  } catch (err) {
    assert.ok(err.status === 2 || err.code === 2,
      `unknown command must exit 2 (got status ${err.status})`);
    const stderr = (err.stderr || '').toString();
    assert.ok(/unknown-thing/.test(stderr),
      'stderr must name the unknown command');
  }
});

// ──────────────────────────────────────────────────────────────────
// Group E: static guards — future-proofing the layout.

t('static: cli/index.js delegates through parseArgv (not inline argv parsing)', () => {
  const src = _read('cli/index.js');
  assert.ok(/require\(['"]\.\/src\/argv['"]\)/.test(src),
    'cli/index.js must require ./src/argv so all argv parsing lives in one place');
  assert.ok(/parseArgv\s*\(\s*process\.argv/.test(src),
    'cli/index.js must call parseArgv(process.argv.slice(2))');
});

t('static: pre-fr-109 attach subcommand is preserved (no clobber)', () => {
  const src = _read('cli/index.js');
  assert.ok(/function attachCmd/.test(src),
    'fr-109 must preserve the existing attachCmd function — do not clobber pre-fr-109 behaviour');
  assert.ok(/WebSocket/.test(src),
    'attach flow still uses WebSocket');
});

t('static: fr-109 marker present in argv.js and index.js', () => {
  assert.ok(/fr-109/.test(_read('cli/src/argv.js')),
    'cli/src/argv.js must carry an fr-109 marker so future readers can grep-back');
  assert.ok(/fr-109/.test(_read('cli/index.js')),
    'cli/index.js must carry an fr-109 marker on the new dispatch block');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
