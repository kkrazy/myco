// fr-103: chat-mediated refresh of the Claude subscription credential.
//
// Contract:
//   - server/src/claude-auth.js exposes startLogin / hasPendingLogin /
//     getPendingLogin / feedCallback / cancelLogin.
//   - One pending login per session (startLogin throws if already pending).
//   - startLogin spawns `claude auth login --claudeai`, captures stdout +
//     stderr, fires onUrl(url) on first https URL, fires onResult on exit.
//   - URL_WAIT_MS (~30s) — if no URL prints in window, fires onUrl(null)
//     to surface the breakage to the user.
//   - DEFAULT_TIMEOUT_MS (~5 min) — overall cap; SIGTERMs the subprocess
//     and fires onResult({ok:false, exitCode:-2}).
//   - feedCallback writes the line + '\n' to subprocess stdin.
//   - cancelLogin SIGTERMs the subprocess (idempotent).
//
//   - /login slash command registered, owner+admin gated for `confirm` /
//     `cancel`. Bare /login warns. /login status open to everyone.
//   - attach.js handleChatMessage diverts NON-slash text from the login
//     owner into feedCallback when a login is pending.
//   - The pasted-back code is echoed into chat with meta.kind:'login-callback'
//     so cross-device clients see it but it doesn't go to claude.
//   - app.js tags chat rows with chat-msg-login-prompt / chat-msg-login-callback
//     classes for CSS theming.
//   - styles.css ships the two row classes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn, fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      throw new Error('async tests use deferred-handle pattern below, not direct await');
    }
    console.log('  ✓ ' + name); passed++;
  } catch (err) {
    console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err));
    failed++;
  }
}

// Async helper — returns a promise but reports a single pass/fail line.
function tAsync(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { console.log('  ✓ ' + name); passed++; },
    (err) => { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
  );
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-103: /login refresh Claude subscription credential ──');

// ──────────────────────────────────────────────────────────────────────
// Group A: claude-auth.js behavior with a mock subprocess.
//
// We mock child_process.spawn so the test never actually invokes
// `claude auth login`. The mock returns a fake child with writable
// stdin and EventEmitter-flavored stdout/stderr/close. Tests then drive
// the mock by calling its push() / exit() helpers.

const child_process = require('child_process');
const { EventEmitter } = require('events');
const realSpawn = child_process.spawn;

let _lastMockChild = null;
function _installMockSpawn() {
  child_process.spawn = function _mockSpawn(cmd, args) {
    const child = new EventEmitter();
    child._cmd = cmd;
    child._args = args;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      _written: [],
      write(chunk) { this._written.push(String(chunk)); return true; },
      end() {},
    };
    child.killed = false;
    child.kill = function(sig) {
      this.killed = true;
      // emit close async so callers can chain
      setImmediate(() => child.emit('close', -15));
    };
    // Test helpers (not part of the EventEmitter contract — only the
    // test uses them):
    child._pushStdout = function(s) { child.stdout.emit('data', Buffer.from(s)); };
    child._pushStderr = function(s) { child.stderr.emit('data', Buffer.from(s)); };
    child._exit = function(code) { child.emit('close', code); };
    child._error = function(err) { child.emit('error', err); };
    _lastMockChild = child;
    return child;
  };
}
function _uninstallMockSpawn() {
  child_process.spawn = realSpawn;
  _lastMockChild = null;
}

// Bust the require-cache so claude-auth.js picks up the mock spawn the
// first time it's required. Subsequent reloads reinitialize _pending.
function _freshClaudeAuth() {
  delete require.cache[require.resolve('../server/src/claude-auth')];
  return require('../server/src/claude-auth');
}

t('module exports the expected surface', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  for (const fn of ['hasPendingLogin', 'getPendingLogin', 'startLogin', 'feedCallback', 'cancelLogin']) {
    assert.strictEqual(typeof m[fn], 'function', `claude-auth must export ${fn}`);
  }
  assert.ok(typeof m.URL_WAIT_MS === 'number' && m.URL_WAIT_MS > 0, 'URL_WAIT_MS must be a positive number');
  assert.ok(typeof m.DEFAULT_TIMEOUT_MS === 'number' && m.DEFAULT_TIMEOUT_MS > 0, 'DEFAULT_TIMEOUT_MS must be a positive number');
  _uninstallMockSpawn();
});

t('startLogin spawns claude auth login --claudeai with the expected args', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  m.startLogin('sid-1', { owner: 'alice', onUrl() {}, onResult() {} });
  assert.ok(_lastMockChild, 'a child process must have been spawned');
  assert.strictEqual(_lastMockChild._cmd, 'claude', 'must spawn `claude`');
  assert.deepStrictEqual(_lastMockChild._args, ['auth', 'login', '--claudeai'],
    'must pass the documented headless args (verified against claude 2.1.159)');
  m.cancelLogin('sid-1');
  _uninstallMockSpawn();
});

t('hasPendingLogin reflects the running flow + flips to false on exit', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  assert.strictEqual(m.hasPendingLogin('sid-2'), false);
  m.startLogin('sid-2', { owner: 'alice', onUrl() {}, onResult() {} });
  assert.strictEqual(m.hasPendingLogin('sid-2'), true);
  _lastMockChild._exit(0);
  // close is sync via EventEmitter.emit, so by now the entry is gone:
  assert.strictEqual(m.hasPendingLogin('sid-2'), false);
  _uninstallMockSpawn();
});

t('startLogin rejects a duplicate while one is already pending', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  m.startLogin('sid-3', { owner: 'alice', onUrl() {}, onResult() {} });
  assert.throws(
    () => m.startLogin('sid-3', { owner: 'alice', onUrl() {}, onResult() {} }),
    /already pending/i,
    'second startLogin without first settling must throw'
  );
  m.cancelLogin('sid-3');
  _uninstallMockSpawn();
});

tAsync('onUrl fires once when the subprocess prints an https URL', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  // Capture the child reference NOW — sync tests below run between the
  // promise's resolve points and uninstall the global mock, which would
  // null out the module-level _lastMockChild ref.
  return new Promise((resolve, reject) => {
    let urlCalls = 0;
    let captured = null;
    m.startLogin('sid-4', {
      owner: 'alice',
      onUrl: (url) => { urlCalls++; captured = url; },
      onResult: () => {},
    });
    const child = _lastMockChild;
    assert.ok(child, 'mock child must exist immediately after startLogin');
    child._pushStdout('Open this URL in your browser:\n');
    child._pushStdout('https://console.anthropic.com/oauth?state=abc\nawaiting code…\n');
    // give the microtask queue a tick
    setImmediate(() => {
      try {
        assert.strictEqual(urlCalls, 1, 'onUrl must fire exactly once');
        assert.strictEqual(captured, 'https://console.anthropic.com/oauth?state=abc',
          'must capture the first https URL printed');
        // A second push with another URL must NOT fire onUrl again.
        child._pushStdout('also https://other.example/\n');
        setImmediate(() => {
          try {
            assert.strictEqual(urlCalls, 1, 'onUrl must NOT fire again on subsequent URL prints');
            m.cancelLogin('sid-4');
            _uninstallMockSpawn();
            resolve();
          } catch (err) { _uninstallMockSpawn(); reject(err); }
        });
      } catch (err) { _uninstallMockSpawn(); reject(err); }
    });
  });
});

tAsync('onResult fires with ok=true when the subprocess exits 0', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  return new Promise((resolve, reject) => {
    m.startLogin('sid-5', {
      owner: 'alice',
      onUrl: () => {},
      onResult: ({ ok, exitCode }) => {
        try {
          assert.strictEqual(ok, true, 'exit 0 → ok=true');
          assert.strictEqual(exitCode, 0, 'exit code forwarded');
          assert.strictEqual(m.hasPendingLogin('sid-5'), false,
            'entry must be deleted from _pending after onResult');
          _uninstallMockSpawn();
          resolve();
        } catch (err) { _uninstallMockSpawn(); reject(err); }
      },
    });
    const child = _lastMockChild;
    assert.ok(child, 'mock child must exist immediately after startLogin');
    child._exit(0);
  });
});

tAsync('onResult fires with ok=false when the subprocess exits non-zero', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  return new Promise((resolve, reject) => {
    m.startLogin('sid-6', {
      owner: 'alice',
      onUrl: () => {},
      onResult: ({ ok, exitCode }) => {
        try {
          assert.strictEqual(ok, false, 'non-zero exit → ok=false');
          assert.strictEqual(exitCode, 7);
          _uninstallMockSpawn();
          resolve();
        } catch (err) { _uninstallMockSpawn(); reject(err); }
      },
    });
    const child = _lastMockChild;
    assert.ok(child, 'mock child must exist immediately after startLogin');
    child._pushStderr('auth: bad code\n');
    child._exit(7);
  });
});

t('feedCallback writes the line + newline to subprocess stdin', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  m.startLogin('sid-7', { owner: 'alice', onUrl() {}, onResult() {} });
  const ok = m.feedCallback('sid-7', '  abc-123-code  ');
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(_lastMockChild.stdin._written, ['abc-123-code\n'],
    'must trim + newline-terminate the line');
  m.cancelLogin('sid-7');
  _uninstallMockSpawn();
});

t('feedCallback returns false when no login is pending', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  assert.strictEqual(m.feedCallback('sid-nonexistent', 'foo'), false);
  _uninstallMockSpawn();
});

t('cancelLogin SIGTERMs the subprocess + clears pending state', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  m.startLogin('sid-8', { owner: 'alice', onUrl() {}, onResult() {} });
  assert.strictEqual(m.hasPendingLogin('sid-8'), true);
  const killed = m.cancelLogin('sid-8');
  assert.strictEqual(killed, true);
  assert.strictEqual(_lastMockChild.killed, true, 'mock child killed flag set');
  // The mock fires close async, but cancel returns true synchronously.
  _uninstallMockSpawn();
});

t('cancelLogin is idempotent when nothing is pending', () => {
  _installMockSpawn();
  const m = _freshClaudeAuth();
  assert.strictEqual(m.cancelLogin('sid-nonexistent'), false);
  _uninstallMockSpawn();
});

// ──────────────────────────────────────────────────────────────────────
// Group B: /login slash command behavior.
//
// We swap require.cache for './sessions' BEFORE re-requiring slashcmds
// so handleLogin's lazy lookups see the stub. Slashcmds was already
// loaded by the fr-102 test if both run in the same process, so we
// must reload it AFTER the stub is in place.

t('slashcmd group: /login is registered + listed in /commands', () => {
  // Fresh module load with sessions stubbed.
  const stub = {
    _rec: null,
    _owners: new Set(),
    getSessionRecord(_id) { return this._rec; },
    isOwnerOrAdmin(_id, user) { return this._owners.has(user); },
    saveStore() {},
    appendChatMessage() {},
  };
  require.cache[require.resolve('../server/src/sessions')] = {
    exports: stub,
    id: require.resolve('../server/src/sessions'),
    filename: require.resolve('../server/src/sessions'),
    loaded: true,
  };
  require.cache[require.resolve('../server/src/permissions')] = {
    exports: { matchesPattern() { return false; } },
    id: require.resolve('../server/src/permissions'),
    filename: require.resolve('../server/src/permissions'),
    loaded: true,
  };
  delete require.cache[require.resolve('../server/src/slashcmds')];
  const slashcmds = require('../server/src/slashcmds');
  const cmds = slashcmds.listCommands();
  const loginCmd = cmds.find((c) => c.name === 'login');
  assert.ok(loginCmd, '/login must be in COMMANDS');
  assert.ok(/owner|admin/i.test(loginCmd.summary), 'summary must mention the gate');
  assert.ok(/confirm/.test(loginCmd.usage), 'usage must mention `confirm`');
});

t('bare /login (no arg) replies with a warning, does NOT spawn anything', () => {
  _installMockSpawn();
  const slashcmds = require('../server/src/slashcmds');
  const replies = [];
  const ctx = {
    sessionId: 'sid-warn',
    user: 'alice',
    args: '',
    reply: (msg) => replies.push(String(msg)),
    session: { emit() {} },
  };
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  slashcmds.handleLogin(ctx);
  assert.ok(replies.length >= 1, 'must reply');
  assert.ok(/refresh.*credential|whole container|container-wide/i.test(replies.join('\n')),
    'warning must explain the container-wide effect');
  assert.ok(/confirm/.test(replies.join('\n')),
    'warning must tell the user how to proceed (/login confirm)');
  assert.strictEqual(_lastMockChild, null, 'NO subprocess must spawn on bare /login');
  _uninstallMockSpawn();
});

t('/login confirm from non-owner viewer is REFUSED, no spawn', () => {
  _installMockSpawn();
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  const replies = [];
  const ctx = {
    sessionId: 'sid-viewer',
    user: 'eve',
    args: 'confirm',
    reply: (msg) => replies.push(String(msg)),
    session: { emit() {} },
  };
  slashcmds.handleLogin(ctx);
  assert.ok(/owner|admin/i.test(replies.join('\n')), 'denial must mention the gate');
  assert.strictEqual(_lastMockChild, null, 'NO subprocess spawned for denied user');
  _uninstallMockSpawn();
});

t('/login status from non-owner viewer is OPEN (read-only)', () => {
  _installMockSpawn();
  const slashcmds = require('../server/src/slashcmds');
  const sessionsMod = require('../server/src/sessions');
  sessionsMod._rec = { user: 'alice' };
  sessionsMod._owners = new Set(['alice']);
  const replies = [];
  const ctx = {
    sessionId: 'sid-status',
    user: 'eve',
    args: 'status',
    reply: (msg) => replies.push(String(msg)),
    session: { emit() {} },
  };
  slashcmds.handleLogin(ctx);
  assert.ok(replies.length >= 1, 'status must reply for any user');
  assert.ok(/no login.*progress|in progress/i.test(replies.join('\n')),
    'status reply must mention the pending state');
  _uninstallMockSpawn();
});

// ──────────────────────────────────────────────────────────────────────
// Group C: static guards on the prod source.

t('static guard: attach.js diverts non-slash chat from the login owner to feedCallback', () => {
  const src = _read('server/src/attach.js');
  // The hook must (1) require claude-auth, (2) check getPendingLogin
  // for the current sessionId, (3) gate on owner === user + !text.startsWith('/'),
  // (4) call feedCallback. Use §10b helper to slice the function body so
  // the assertion grows with the function.
  const body = fnBody(src, /function\s+handleChatMessage\s*\(/);
  assert.ok(body, 'handleChatMessage must be locatable');
  assert.ok(/require\s*\(\s*['"]\.\/claude-auth['"]\s*\)/.test(body),
    'handleChatMessage must require ./claude-auth');
  assert.ok(/getPendingLogin\s*\(/.test(body),
    'handleChatMessage must call getPendingLogin');
  assert.ok(/feedCallback\s*\(/.test(body),
    'handleChatMessage must call feedCallback to pipe the user code to stdin');
  assert.ok(/owner\s*===\s*user/.test(body),
    'feedCallback gate must check pending.owner === user (only the login owner pipes)');
  assert.ok(/login-callback/.test(body),
    'the user echo must be tagged meta.kind:"login-callback"');
  // Ordering: the divert MUST happen BEFORE the slash dispatcher, so a
  // typed code doesn't trip a slash command accidentally. The string
  // `text.startsWith('/')` appears in multiple places in handleChatMessage
  // (read-only guard, slash-dispatch branch); anchor on the actual
  // dispatch call (`slashcmds.dispatch(`) which is unique.
  const divertIdx = body.indexOf('feedCallback');
  const slashIdx = body.indexOf('slashcmds.dispatch(');
  assert.ok(divertIdx > 0, 'handleChatMessage must contain a feedCallback divert');
  assert.ok(slashIdx > 0, 'handleChatMessage must contain a slashcmds.dispatch call');
  assert.ok(slashIdx > divertIdx,
    'feedCallback divert must come BEFORE slashcmds.dispatch — otherwise a typed callback code could trigger a slash command accidentally');
});

t('static guard: slashcmds.js exports handleLogin + /login is owner+admin for mutate', () => {
  const src = _read('server/src/slashcmds.js');
  assert.ok(/names:\s*\[\s*['"]login['"]/.test(src), '/login must be in COMMANDS');
  assert.ok(/function\s+handleLogin\s*\(/.test(src), 'handleLogin must be defined');
  const body = fnBody(src, /function\s+handleLogin\s*\(/);
  assert.ok(body, 'handleLogin body must be locatable');
  assert.ok(/isOwnerOrAdmin\s*\(/.test(body),
    'handleLogin must call isOwnerOrAdmin for the confirm/cancel gate');
  assert.ok(/startLogin\s*\(/.test(body),
    'handleLogin must call claudeAuth.startLogin on /login confirm');
  assert.ok(/cancelLogin\s*\(/.test(body),
    'handleLogin must call cancelLogin on /login cancel');
  assert.ok(/hasPendingLogin\s*\(/.test(body),
    'handleLogin must call hasPendingLogin for /login status');
});

t('static guard: app.js tags chat rows with chat-msg-login-prompt / chat-msg-login-callback', () => {
  const src = _read('web/public/app.js');
  assert.ok(/chat-msg-login-prompt/.test(src),
    'app.js must tag login-prompt rows for CSS theming');
  assert.ok(/chat-msg-login-callback/.test(src),
    'app.js must tag login-callback rows for CSS theming');
});

t('static guard: styles.css ships the login-prompt + login-callback row styles', () => {
  const src = _read('web/public/styles.css');
  assert.ok(/\.chat-msg-login-prompt\b/.test(src),
    '.chat-msg-login-prompt class must be styled');
  assert.ok(/\.chat-msg-login-callback\b/.test(src),
    '.chat-msg-login-callback class must be styled');
});

// ──────────────────────────────────────────────────────────────────────
// Wait for all async tests + exit.

Promise.resolve().then(async () => {
  // Brief grace window for any pending async tests above. Each tAsync
  // resolves a promise on completion, so this loop yields until none
  // are left in flight.
  await new Promise((r) => setTimeout(r, 50));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
