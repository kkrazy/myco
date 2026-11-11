// stream-idle-watchdog-env (2026-11-09, fec-n2-37 postmortem) — regression.
//
// User-visible failure: the 0b1beffc /run-n2 run sat silent for 66 minutes
// (06:45:46 → 07:51:53) on a hung gateway request with nothing to break the
// stall — the "✅ /run-n2 完成" line only fired when the gateway's socket
// happened to die. Root cause: Claude Code's CLI ships a built-in per-request
// stream-idle watchdog (abort + internal retry when a streaming response
// delivers no SSE chunks), but it is only armed for the CLI's own --bg
// sessions via CLAUDE_ENABLE_STREAM_WATCHDOG=1 — SDK-direct sessions (our
// AgentSession shape) leave it OFF.
//
// Fix: agent-session.js streamIdleWatchdogEnv() overlays
//   CLAUDE_ENABLE_STREAM_WATCHDOG=1
//   CLAUDE_STREAM_IDLE_TIMEOUT_MS=<ms>
// into sdkOpts.env on every _ensureIteration. Default 15 min; a caller-set
// CLAUDE_STREAM_IDLE_TIMEOUT_MS (from $STATE_DIR/.env via process.env) is
// honored but clamped to a 10-min floor (2026-11-09 decision: floor 10 min,
// env default 15 min).
//
// This test locks the logic in isolation (mirroring the fr-43/fr-44
// inlined-behavior pattern — the real streamIdleWatchdogEnv is module-
// private, so we (a) static-grep the prod file for the wiring and
// (b) re-verify the clamp arithmetic against the same constants).
//
// Run: node test/stream-idle-watchdog-env.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const SRC = path.join(__dirname, '..', 'server', 'src', 'agent-session.js');
const src = fs.readFileSync(SRC, 'utf8');

// Inlined FIXED behavior — mirrors streamIdleWatchdogEnv's contract.
const DEFAULT_MS = 15 * 60 * 1000;
const FLOOR_MS = 10 * 60 * 1000;
function resolveIdleMs(envValue) {
  const raw = Number(envValue);
  return Number.isFinite(raw) && raw > 0 ? Math.max(raw, FLOOR_MS) : DEFAULT_MS;
}

async function main() {
  console.log('── stream-idle-watchdog-env: CLI stream watchdog armed per iteration ──');

  t('prod file defines the env helper + 15-min default + 10-min floor', () => {
    assert.ok(/function streamIdleWatchdogEnv\(\)/.test(src),
      'agent-session.js must define streamIdleWatchdogEnv() — it builds the watchdog env overlay');
    assert.ok(/CLAUDE_ENABLE_STREAM_WATCHDOG/.test(src),
      'agent-session.js must reference CLAUDE_ENABLE_STREAM_WATCHDOG (the CLI-internal arming switch)');
    assert.ok(/CLAUDE_STREAM_IDLE_TIMEOUT_MS/.test(src),
      'agent-session.js must reference CLAUDE_STREAM_IDLE_TIMEOUT_MS (the watchdog window)');
    assert.ok(/15 \* 60 \* 1000/.test(src),
      'default window must be 15 min (2026-11-09 decision: env default 15 min)');
    assert.ok(/10 \* 60 \* 1000/.test(src),
      'hard floor must be 10 min (2026-11-09 decision: floor 10 min)');
  });

  t('sdkOpts.env overlays streamIdleWatchdogEnv() LAST (operator override still wins pre-floor)', () => {
    const at = src.search(/env: \{ \.\.\.process\.env, \.\.\.gwEnv/);
    assert.ok(at > 0, 'sdkOpts.env spread with process.env/gwEnv must exist');
    const line = src.slice(at, src.indexOf('\n', at));
    assert.ok(/streamIdleWatchdogEnv\(\)/.test(line),
      'sdkOpts.env must spread streamIdleWatchdogEnv() — got: ' + line);
    // Ordering check: the helper spread must come after process.env so an
    // operator-set CLAUDE_STREAM_IDLE_TIMEOUT_MS in $STATE_DIR/.env flows
    // through process.env into the helper's own resolution path.
    const m = line.match(/\.\.\.process\.env.*\.\.\.streamIdleWatchdogEnv\(\)/);
    assert.ok(m, 'streamIdleWatchdogEnv() must overlay AFTER ...process.env: ' + line);
  });

  t('unset env → 15-min default', () => {
    assert.strictEqual(resolveIdleMs(undefined), 15 * 60 * 1000,
      'no CLAUDE_STREAM_IDLE_TIMEOUT_MS in env must resolve to the 15-min default');
  });

  t('operator sets 30 min → honored (above floor)', () => {
    assert.strictEqual(resolveIdleMs(String(30 * 60 * 1000)), 30 * 60 * 1000,
      'a valid above-floor override must pass through unchanged');
  });

  t('operator sets 2 min → clamped to the 10-min floor', () => {
    assert.strictEqual(resolveIdleMs(String(2 * 60 * 1000)), 10 * 60 * 1000,
      'below-floor values must clamp to 10 min — an over-aggressive watchdog would retry-loop a buffering gateway');
  });

  t('garbage env (non-numeric) → 15-min default, never NaN', () => {
    assert.strictEqual(resolveIdleMs('yes'), 15 * 60 * 1000,
      'non-numeric CLAUDE_STREAM_IDLE_TIMEOUT_MS must fall back to the default, not NaN');
    assert.strictEqual(resolveIdleMs('0'), 15 * 60 * 1000,
      '0 must fall back to the default (0 means unset, not "instant fire")');
  });

  t('deploy.sh: --set-stream-idle-timeout flag + helper + full-deploy seed', () => {
    const dep = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');
    assert.ok(/--set-stream-idle-timeout/.test(dep),
      'deploy.sh must parse --set-stream-idle-timeout');
    assert.ok(/^set_stream_idle_timeout_in_env\(\)/m.test(dep),
      'deploy.sh must define set_stream_idle_timeout_in_env()');
    assert.ok(/set_stream_idle_timeout_in_env 15/.test(dep),
      'full deploys must seed the 15-min default (idempotent, operator value preserved)');
    assert.ok(/\[ "\$minutes" -ge 10 \]/.test(dep),
      'deploy.sh must reject --set-stream-idle-timeout below the 10-min floor');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
