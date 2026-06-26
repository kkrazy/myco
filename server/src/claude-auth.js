// fr-103: chat-mediated refresh of the Claude subscription credential.
//
// The credential file (`~/.claude/.credentials.json`) is shared across
// every SDK invocation in the container — refresh-from-chat lets the
// operator re-auth WITHOUT ssh'ing in. The mechanism is intentionally
// thin: spawn `claude auth login --claudeai` as a child process, capture
// the OAuth URL it prints, surface it in chat as a clickable link,
// listen for the user's callback code as a follow-up chat message,
// pipe it to the subprocess's stdin, and report success/failure.
//
// State model
// ─────────────────────────────────────────────────────────────────────
// One pending login per session (a deliberate scope cap — multiplexing
// across sessions for the same container would race on the credential
// file). The active subprocess is stored in `_pending` keyed by
// sessionId. `cancel` kills it. `feedCallback` pipes a line to stdin.
//
// G2 confirmation gate (analyze-stage A4)
// ─────────────────────────────────────────────────────────────────────
// Refreshing affects EVERY session in the container, not just the one
// running /login. The slash handler enforces a two-step `/login confirm`
// pattern (see handleLogin in slashcmds.js). This module is gate-
// agnostic — it just runs whatever the handler tells it to run.

const { spawn } = require('child_process');

// Map<sessionId, { proc, owner, startTs, stdoutBuf, stderrBuf, postedUrl, settled }>
const _pending = new Map();

// Auth URLs claude-cli prints look like https://console.anthropic.com/…
// or https://claude.ai/oauth/… or similar — we grep for the first https
// URL in the captured stdout/stderr. This is intentionally permissive:
// the auth-CLI output format isn't part of a stable public contract, so
// over-specific regexes would break on minor CLI revs. Anything with an
// https:// prefix and no whitespace counts. The first match wins.
const URL_RE = /https?:\/\/[^\s)>"']+/;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;     // 5-minute browser/paste window
const URL_WAIT_MS = 30 * 1000;                // print the URL by this point

/**
 * Returns true if a login subprocess is currently running for the
 * session, false otherwise. The slash handler uses this to short-
 * circuit duplicate `/login confirm` invocations.
 */
function hasPendingLogin(sessionId) {
  return _pending.has(sessionId);
}

/**
 * Returns the pending login entry (or null). The chat-routing hook in
 * attach.js uses this to detect "the next user text from the login
 * owner is the callback code, not a normal chat message."
 */
function getPendingLogin(sessionId) {
  return _pending.get(sessionId) || null;
}

/**
 * Spawn `claude auth login --claudeai` for a session. Returns the
 * pending entry. Callbacks (onUrl, onResult) are how the slash handler
 * surfaces the OAuth URL + the success/failure result to chat.
 *
 * onUrl(url): fires once when the subprocess prints any https URL.
 * onResult({ ok, exitCode, stdout, stderr }): fires once when the
 *   subprocess exits (or times out / is killed).
 */
function startLogin(sessionId, { owner, onUrl, onResult, claudeBin = 'claude', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (_pending.has(sessionId)) {
    throw new Error(`a login flow is already pending for ${sessionId} — /login cancel to abort first`);
  }

  // `claude auth login --claudeai` is the documented headless entry
  // (verified against claude 2.1.159). `--claudeai` selects the
  // subscription flow (vs. `--console` for API-billing). The CLI's
  // stdout/stderr split isn't reliable, so we tee both.
  const proc = spawn(claudeBin, ['auth', 'login', '--claudeai'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  const entry = {
    proc,
    owner: owner || null,
    startTs: Date.now(),
    stdoutBuf: '',
    stderrBuf: '',
    postedUrl: false,
    settled: false,
    timeoutHandle: null,
    urlTimeoutHandle: null,
  };
  _pending.set(sessionId, entry);

  function _maybePostUrl() {
    if (entry.postedUrl) return;
    const combined = entry.stdoutBuf + '\n' + entry.stderrBuf;
    const m = combined.match(URL_RE);
    if (!m) return;
    entry.postedUrl = true;
    try { onUrl && onUrl(m[0]); } catch (err) { console.error(`[fr-103] onUrl threw: ${err.message}`); }
  }

  function _settle(ok, exitCode) {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timeoutHandle) clearTimeout(entry.timeoutHandle);
    if (entry.urlTimeoutHandle) clearTimeout(entry.urlTimeoutHandle);
    _pending.delete(sessionId);
    try {
      onResult && onResult({
        ok,
        exitCode,
        stdout: entry.stdoutBuf.slice(-2000),    // tail — full buffer can be large
        stderr: entry.stderrBuf.slice(-2000),
        durationMs: Date.now() - entry.startTs,
      });
    } catch (err) {
      console.error(`[fr-103] onResult threw: ${err.message}`);
    }
  }

  proc.stdout.on('data', (chunk) => {
    entry.stdoutBuf += chunk.toString('utf8');
    _maybePostUrl();
  });
  proc.stderr.on('data', (chunk) => {
    entry.stderrBuf += chunk.toString('utf8');
    _maybePostUrl();
  });
  proc.on('error', (err) => {
    entry.stderrBuf += `\n[spawn error] ${err && err.message ? err.message : err}\n`;
    _settle(false, -1);
  });
  proc.on('close', (code) => {
    _settle(code === 0, code);
  });

  // Overall timeout — user opened browser, walked away, didn't paste back.
  entry.timeoutHandle = setTimeout(() => {
    if (entry.settled) return;
    entry.stderrBuf += `\n[fr-103] login timed out after ${timeoutMs}ms — killing subprocess.\n`;
    try { proc.kill('SIGTERM'); } catch {}
    _settle(false, -2);
  }, timeoutMs);

  // URL-wait window — if no URL printed in the first 30s, something is
  // wrong (auth path totally broken, CLI silent, etc.). Surface that
  // explicitly to the user instead of leaving them staring at a dead
  // /login. The subprocess itself stays alive until the broader
  // timeout — _settle is gated on entry.settled so the close handler
  // can still fire normally.
  entry.urlTimeoutHandle = setTimeout(() => {
    if (entry.settled || entry.postedUrl) return;
    try {
      onUrl && onUrl(null);    // signal "no URL was printed in window"
    } catch (err) {
      console.error(`[fr-103] onUrl(null) threw: ${err.message}`);
    }
  }, URL_WAIT_MS);

  return entry;
}

/**
 * Pipe a callback code (or any line) to the pending subprocess's stdin.
 * Returns true if a pending subprocess accepted the write, false if
 * none was pending. Appends `\n` so the CLI's readline-style prompt
 * sees a complete line.
 */
function feedCallback(sessionId, line) {
  const entry = _pending.get(sessionId);
  if (!entry || entry.settled || !entry.proc || !entry.proc.stdin) return false;
  try {
    entry.proc.stdin.write(String(line || '').trim() + '\n');
    return true;
  } catch (err) {
    console.error(`[fr-103] feedCallback write failed: ${err.message}`);
    return false;
  }
}

/**
 * Kill a pending login. Used by `/login cancel` and on session reaper.
 * Idempotent — returns true if something was killed, false otherwise.
 */
function cancelLogin(sessionId) {
  const entry = _pending.get(sessionId);
  if (!entry || entry.settled) return false;
  try {
    entry.proc.kill('SIGTERM');
  } catch (err) {
    console.error(`[fr-103] cancelLogin SIGTERM failed: ${err.message}`);
  }
  // The close handler will fire and _settle the entry. If for some
  // reason the kill didn't take, manually settle so /login can be
  // retried.
  setTimeout(() => {
    if (_pending.has(sessionId) && !_pending.get(sessionId).settled) {
      const e = _pending.get(sessionId);
      e.stderrBuf += '\n[fr-103] cancelLogin: SIGTERM did not settle; forcing.\n';
      e.settled = true;
      _pending.delete(sessionId);
    }
  }, 2000);
  return true;
}

module.exports = {
  hasPendingLogin,
  getPendingLogin,
  startLogin,
  feedCallback,
  cancelLogin,
  // Exposed for testing.
  _pending,
  URL_WAIT_MS,
  DEFAULT_TIMEOUT_MS,
};
