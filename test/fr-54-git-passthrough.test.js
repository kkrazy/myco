// fr-54: /git <args> — pass-through to the git CLI in the session workspace.
//
// Owner+admin only; full passthrough (no allowlist, no PAT injection);
// 60s timeout; 1MB stdout / 16KB stderr cap; output rendered as a
// markdown code-fenced block.
//
// Tests:
//   - shlex-style arg splitter (whitespace, double/single quotes, escapes)
//   - command registration (/git in COMMANDS, handler is handleGit)
//   - handler guards: owner/admin gate, empty-args usage, session-cwd check
//   - end-to-end behavior on a real tempdir git repo (status, log, etc.)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const SLASH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');

console.log('── fr-54: /git pass-through ──');

// ──────────────────────────────────────────────────────────────────────
// Arg splitter — _parseShellArgs
// ──────────────────────────────────────────────────────────────────────

const { _parseShellArgs } = require('../server/src/slashcmds');

t('arg splitter: simple whitespace split', () => {
  assert.deepStrictEqual(_parseShellArgs('status'), ['status']);
  assert.deepStrictEqual(_parseShellArgs('log --oneline -5'), ['log', '--oneline', '-5']);
});

t('arg splitter: collapses runs of whitespace', () => {
  assert.deepStrictEqual(_parseShellArgs('  log    --oneline    '),
    ['log', '--oneline']);
});

t('arg splitter: double-quoted phrase becomes one arg', () => {
  assert.deepStrictEqual(_parseShellArgs('commit -m "fix: bug X"'),
    ['commit', '-m', 'fix: bug X']);
});

t('arg splitter: single-quoted phrase becomes one arg', () => {
  assert.deepStrictEqual(_parseShellArgs("commit -m 'fix: bug X'"),
    ['commit', '-m', 'fix: bug X']);
});

t('arg splitter: backslash-escape inside double quotes', () => {
  assert.deepStrictEqual(_parseShellArgs('commit -m "say \\"hi\\""'),
    ['commit', '-m', 'say "hi"']);
});

t('arg splitter: empty input → empty array', () => {
  assert.deepStrictEqual(_parseShellArgs(''), []);
  assert.deepStrictEqual(_parseShellArgs('   '), []);
});

t('arg splitter: mixed quoted + unquoted', () => {
  assert.deepStrictEqual(
    _parseShellArgs('log --format="%h %s" -n 3'),
    ['log', '--format=%h %s', '-n', '3']);
});

// ──────────────────────────────────────────────────────────────────────
// Command registration
// ──────────────────────────────────────────────────────────────────────

t('slashcmds.js registers /git with handleGit handler', () => {
  assert.ok(/names:\s*\[\s*['"]git['"]\s*\]/.test(SLASH),
    'COMMANDS must include {names: ["git"], ...}');
  assert.ok(/handler:\s*handleGit/.test(SLASH),
    'the /git entry must point at handleGit');
});

t('handleGit function exists in slashcmds.js', () => {
  assert.ok(/function\s+handleGit\s*\(/.test(SLASH),
    'handleGit must be defined');
});

// ──────────────────────────────────────────────────────────────────────
// Handler guards (static-grep)
// ──────────────────────────────────────────────────────────────────────

function _handleGitBody() {
  const start = SLASH.search(/function\s+handleGit\s*\(/);
  assert.ok(start > -1);
  const rest = SLASH.slice(start);
  const end = rest.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

t('handleGit gates on owner/admin (matches /queue precedent)', () => {
  const body = _handleGitBody();
  assert.ok(/isOwnerOrAdmin\s*\(\s*ctx\.sessionId\s*,\s*ctx\.user\s*\)/.test(body),
    'handleGit must call sessionsMod.isOwnerOrAdmin to gate guests');
});

t('handleGit runs git in the session workspace (rec.absCwd)', () => {
  const body = _handleGitBody();
  assert.ok(/cwd:\s*rec\.absCwd/.test(body),
    'must spawn git with cwd: rec.absCwd so it runs in the session workspace');
});

t('handleGit uses execFile (no shell interpolation)', () => {
  const body = _handleGitBody();
  assert.ok(/execFile\s*\(\s*['"]git['"]/.test(body),
    'must use child_process.execFile (not exec) to avoid shell-injection');
});

t('handleGit caps stdout / sets timeout / disables credential prompt', () => {
  const body = _handleGitBody();
  assert.ok(/timeout:\s*60000/.test(body),
    'must set timeout: 60000 (60s)');
  assert.ok(/maxBuffer:\s*1024\s*\*\s*1024/.test(body),
    'must cap stdout at 1 MB via maxBuffer');
  assert.ok(/GIT_TERMINAL_PROMPT:\s*['"]0['"]/.test(body),
    'must set GIT_TERMINAL_PROMPT=0 so git never blocks on a credential prompt');
});

t('handleGit replies with usage when args are empty', () => {
  const body = _handleGitBody();
  assert.ok(/Usage:\s*[`'"]?\/git/.test(body),
    'empty-args branch must show usage');
});

t('handleGit response includes exit code on success + error path', () => {
  const body = _handleGitBody();
  assert.ok(/exit code|exit 0/i.test(body),
    'reply must surface the exit code so the user can branch on it');
  assert.ok(/timed out/i.test(body),
    'reply must distinguish the timeout case');
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end behavior on a real tempdir git repo
// ──────────────────────────────────────────────────────────────────────

// async tests below — wrapped in an IIFE so they finish before the report.

(async () => {

await ta('end-to-end: git status runs in the given cwd + returns clean output', async () => {
  // Create a tempdir, init a repo, then invoke git status the same way
  // handleGit would (execFile in the cwd). This exercises the
  // execFile contract end-to-end without involving the WS chat plane.
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fr-54-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'fr54@test'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'fr54'], { cwd: tmp });
    const { execFile } = require('child_process');
    const result = await new Promise((resolve) => {
      execFile('git', ['status', '--porcelain'], {
        cwd: tmp, timeout: 5000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
    assert.strictEqual(result.err, null, 'git status should succeed in a fresh repo');
    assert.strictEqual(String(result.stdout || '').trim(), '',
      'porcelain status of fresh repo should be empty');
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

await ta('end-to-end: stderr is captured separately from stdout', async () => {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fr-54-'));
  try {
    // Run git in a non-repo dir; expect non-zero exit + stderr message.
    const { execFile } = require('child_process');
    const result = await new Promise((resolve) => {
      execFile('git', ['log', '-1'], {
        cwd: tmp, timeout: 5000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
    assert.ok(result.err, 'git log in non-repo should error');
    assert.ok(/not a git repository|fatal/i.test(String(result.stderr || '')),
      'stderr should carry the git-side error message');
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

})();
