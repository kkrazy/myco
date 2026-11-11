// 2026-06-03 root-cause fix: boot-time loader for $MYCO_STATE_DIR/.env.
//
// Root cause (user-reported, verbatim: "why the critic is not kicked off?"):
//   The deployed container's /data/.env held GEMINI_API_KEY (set via
//   the admin-config UI), but server/src/index.js had no boot-time
//   loader — only an admin-UI POST handler that wrote both the file
//   AND process.env in the same request. Result: every container
//   restart wiped process.env back to whatever `docker run -e ...`
//   set, GEMINI_API_KEY went undefined, the gemini critic returned
//   the literal placeholder "(Gemini API key missing…)" string, and
//   every /run dispatch's critique broadcast was effectively dead.
//
//   Reproduced live on mycodev: `docker exec myco node -e \"…runCritique('test')\"`
//   returned the placeholder. The truncation + dispatch-drift fixes
//   shipped earlier today were real but moot — without the key
//   reaching the process, the critic never had a chance.
//
// Fix shape (locked here):
//   · Top of server/src/index.js, BEFORE the global-agent bootstrap +
//     any other require that reads process.env at module-load time.
//   · Vanilla parser, no new dependency.
//   · Honors `KEY=value` lines, `#` comments, blank lines, surrounding
//     "double" or 'single' quotes around the value.
//   · Skips malformed lines (no `=`, bad key shape) silently — admin
//     UI writes well-formed lines; a hand-edit typo must not crash.
//   · NEVER overwrites a pre-existing process.env value — docker -e
//     and the host env win, preserving the ops escape hatch.
//   · Logs `[boot] loaded N env var(s) from <path>` on success.

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

console.log('── boot-time .env loader (2026-06-03 critic-key-missing root-cause fix) ──');

// ── 1. Static-grep on the source ──

t('server/src/index.js: _loadStateDirEnvAtBoot IIFE exists and runs before global-agent/bootstrap', () => {
  const src = _read('server/src/index.js');
  // Loader must be defined.
  const loaderAt = src.search(/_loadStateDirEnvAtBoot/);
  assert.ok(loaderAt > -1,
    '_loadStateDirEnvAtBoot loader must exist in index.js (root-cause fix for "why the critic is not kicked off?").');
  // The loader's IIFE invocation must precede the global-agent
  // bootstrap line. If it loaded AFTER, the global-agent might read
  // proxy env vars from the wrong (pre-load) state.
  const globalAgentAt = src.search(/require\(['"]global-agent\/bootstrap['"]\)/);
  assert.ok(globalAgentAt > -1, 'global-agent bootstrap must still be required.');
  assert.ok(loaderAt < globalAgentAt,
    'the .env loader IIFE must run BEFORE global-agent/bootstrap so proxy env vars from .env are honored by the request agent.');
});

t('server/src/index.js: loader honors MYCO_STATE_DIR override (matches the admin-UI code path at line ~1442)', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/_loadStateDirEnvAtBoot/);
  // The loader body is right after the function name. Grab a window.
  const body = src.slice(at, at + 2500);
  assert.ok(/MYCO_STATE_DIR/.test(body),
    'the loader must consult process.env.MYCO_STATE_DIR before falling back to a default — symmetric with admin-config (line ~1442).');
});

t('server/src/index.js: loader explicitly preserves docker -e / host env (does NOT overwrite a pre-set key)', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/_loadStateDirEnvAtBoot/);
  const body = src.slice(at, at + 2500);
  // The defensive check is `if (process.env[key] != null) continue;`
  // or close to that shape. Loose-match.
  assert.ok(/process\.env\[\s*key\s*\]\s*!=\s*null/.test(body) ||
            /process\.env\[\s*key\s*\]\s*!==?\s*undefined/.test(body),
    'the loader must short-circuit on already-set keys so docker -e + host env continue to win (preserves the ops escape hatch).');
});

t('server/src/index.js: loader logs the success count so post-deploy diagnostics can find it', () => {
  const src = _read('server/src/index.js');
  const at = src.search(/_loadStateDirEnvAtBoot/);
  const body = src.slice(at, at + 2500);
  assert.ok(/\[boot\][^\n]*loaded/.test(body),
    'the loader must emit a "[boot] loaded N env var(s) from <path>" log so a post-deploy log scan can confirm the fix is wired and counting the keys correctly.');
});

// ── 2. Runtime: load + parse + don't-overwrite in a sub-Node process ──

t('runtime: loader populates process.env from a temp .env, skips comments, strips surrounding quotes, never overwrites a pre-set key', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'env-loader-'));
  try {
    fs.writeFileSync(path.join(tmpDir, '.env'),
      [
        '# a comment',
        '',
        'GEMINI_API_KEY=test-gemini-key-123',
        'QUOTED_VALUE="hello world"',
        "SINGLE_QUOTED='single'",
        '=NOKEY',                       // malformed
        '123_INVALID=skip',             // unsafe key shape (starts with digit)
        'WAS_PRESET=NEW_VALUE',         // must NOT overwrite WAS_PRESET=ORIGINAL
      ].join('\n'));
    // Extract the loader's source from the actual file so we test the
    // SAME code that boots. Static-grep tests above lock its shape;
    // this runtime test exercises behaviour.
    const idxSrc = _read('server/src/index.js');
    const m = idxSrc.match(/\(function\s+_loadStateDirEnvAtBoot[\s\S]*?\}\)\(\);/);
    assert.ok(m, 'must be able to extract the loader IIFE source from index.js for the runtime smoke test.');
    const probe = `
      ${m[0]}
      console.log(JSON.stringify({
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        QUOTED_VALUE: process.env.QUOTED_VALUE,
        SINGLE_QUOTED: process.env.SINGLE_QUOTED,
        NOKEY: process.env.NOKEY,
        WAS_PRESET: process.env.WAS_PRESET,
      }));
    `;
    const out = execFileSync('node', ['-e', probe], {
      env: { ...process.env, MYCO_STATE_DIR: tmpDir, WAS_PRESET: 'ORIGINAL', GEMINI_API_KEY: '' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    // The probe output may have a "[boot] loaded N env var(s)" log
    // line before the JSON. Take the LAST non-empty line as the JSON.
    const jsonLine = out.trim().split('\n').filter(Boolean).pop();
    const parsed = JSON.parse(jsonLine);
    // GEMINI_API_KEY was set to '' (empty string) in the env. `!= null`
    // semantics treat '' as set, so the loader should SKIP it.
    // The point of this assertion: the loader's don't-overwrite check
    // is the actual gate (not a sloppy `!process.env[key]` truthy
    // check that would have overwritten the empty-string sentinel).
    assert.strictEqual(parsed.GEMINI_API_KEY, '',
      'loader must NOT overwrite an explicitly empty-string env (the gate is "not null", not "not truthy" — empty strings are still "set").');
    assert.strictEqual(parsed.QUOTED_VALUE, 'hello world',
      'loader must strip surrounding double-quotes from the value.');
    assert.strictEqual(parsed.SINGLE_QUOTED, 'single',
      'loader must strip surrounding single-quotes from the value.');
    assert.strictEqual(parsed.NOKEY, undefined,
      'malformed line "=NOKEY" must be skipped (no key to assign to).');
    assert.strictEqual(parsed.WAS_PRESET, 'ORIGINAL',
      'pre-set keys must not be overwritten (docker -e / host env wins).');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
