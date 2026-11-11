#!/usr/bin/env node
// Regression guards for bench/hle/lib/engine.js single-agent stall config.
//
// Why this test exists (2026-10-31, run hle-20261031192356): the single-agent
// stall watchdog default was 120000ms (2min). HLE single's REAL successful
// latency on the glmmoedsa gateway measured p50=82s / p75=117s / p95=238s /
// max=761s, so 75% of successful calls produced their first assistant message
// within ~117s — RIGHT AT the 120s window. Every call whose first message
// landed a little late (120s+, still productive) was killed as a false "stall"
// (`no assistant output in 120000ms`): that run fell 54/94, 100% of the
// failures from the window, NOT from the model. Retrying is correctly disabled
// for these (see utils/test_orch.py), so a too-tight window = guaranteed loss.
// These guards keep the default window wide enough (above the measured max) so
// a producing call can never be mis-killed, and keep the per-call total timeout
// above the window so the watchdog is never a no-op.
//
// Run standalone:  node bench/hle/test_engine_config.js   (from repo root)
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ENGINE = fs.readFileSync(path.join(__dirname, 'lib', 'engine.js'), 'utf8');

// Single-agent stall watchdog default: must stay far above the old 120s (below
// real p75=117s). 900s covers the measured max (761s). Guard the floor at 600s
// so nobody can quietly roll it back toward 120s and revive the mis-kill bug.
function stallDefault() {
  const m = ENGINE.match(/HLE_STALL_MS\s*\|\|\s*(\d+)/);
  if (!m) throw new Error('HLE_STALL_MS default not found in engine.js');
  return Number(m[1]);
}
assert.strictEqual(stallDefault(), 900000,
  `HLE_STALL_MS default must be 900000 (measured single latency max=761s); got ${stallDefault()}`);
assert.ok(stallDefault() >= 600000,
  'HLE_STALL_MS default must stay >= 600000ms — 120s sat below real p75=117s and mis-killed 54/94 single answers');

// singleAsk total timeout default must stay ABOVE the stall window, or the
// watchdog would only fire after the whole call already timed out (no-op).
function singleTimeoutDefault() {
  const m = ENGINE.match(/timeoutMs:\s*timeoutMs\s*\|\|\s*(\d+)/);
  if (!m) throw new Error('singleAsk timeoutMs default not found in engine.js');
  return Number(m[1]);
}
assert.ok(singleTimeoutDefault() > stallDefault(),
  `singleAsk total timeout (${singleTimeoutDefault()}) must exceed stall window (${stallDefault()}) or the watchdog is a no-op`);

// buildN2Task must tell workers to write final_answer.txt via Bash (printf >),
// NOT the Write tool. Why (2026-11-02, runs hle-20261102103030 +
// hle-20261102143854): worker Write calls reported success with the proper
// absolute path while the file actually landed 2 dirs up
// (bench/hle-<stamp>/n2/<seq>/ instead of bench/hle/work/<stamp>/n2/<seq>/).
// Worker-A in n2/0245 independently discovered the Bash printf > workaround —
// this guard pins it into the prompt so the whole failure class stays dead
// even if the Write-redirect root cause is never fully explained.
const GUARDS = ['NOT the Write tool', 'final_answer.txt', 'verify with'];
// The prompt is an array of string literals, so phrases wrap across lines
// (`'...NOT the',\n'Write tool...'`). Splice those boundaries into spaces so
// the guards match the assembled prompt text, not the source formatting.
const PROMPT_FLAT = ENGINE.replace(/'\s*,?\s*\n\s*'/g, ' ');
for (const g of GUARDS) {
  assert.ok(PROMPT_FLAT.includes(g),
    `buildN2Task prompt defense missing "${g}" — workers may fall back to the Write tool, whose path silently redirects on this host`);
}

console.log('PASS: single stall window=900s > old-120s-guard, single total timeout > window, buildN2Task Write-tool guard present');

// ── n2 premature-completion guards (bug 2026-11-06) ─────────────────────
// User report: "还没结束，但是 n2 识别任务状态结束了" — a question was
// declared finished while work was still in flight. Root causes in n2Ask's
// settle wiring (bench/hle/lib/engine.js):
//   1. team-complete settled unconditionally, but TeamSession completes on
//      "queue all-done + workers idle" WITHOUT knowing about the answer
//      file — the answer often hadn't been written (or was a placeholder
//      about to be corrected by worker-B) at that moment.
//   2. a SINGLE worker 'exit' settled the whole question — one killed
//      worker ended the run while the other was still working.
//   3. GRACE_MS=50s killed worker-B's late overwrite: B is told to
//      independently solve and overwrite final_answer.txt; a correction
//      landing >50s after A's write raced the settle.
// Guards below lock the fixed shapes so a refactor can't quietly re-open
// the premature-completion path. They are static (source-shape) checks —
// the runtime settle path needs a live TeamSession + answer file and is
// covered by the wiring assertions + the GRACE_MS floor.

function n2SettleWiring() {
  const m = ENGINE.match(/lane\.on\('team-complete'[^;]*;/);
  if (!m) throw new Error("lane.on('team-complete') wiring not found in engine.js n2Ask");
  return m[0];
}
const settleWiring = n2SettleWiring();
assert.ok(/if\s*\(readFile\(\)\)\s*settle\(\)/.test(settleWiring),
  `team-complete must only settle when the answer file is non-empty — an unconditional settle declares unfinished tasks finished (bug 2026-11-06); got: ${settleWiring}`);

function n2ExitWiring() {
  const m = ENGINE.match(/lane\.on\('exit'[\s\S]*?\n    \}\);/);
  if (!m) throw new Error("lane.on('exit') wiring not found in engine.js n2Ask");
  return m[0];
}
const exitWiring = n2ExitWiring();
assert.ok(/exitCount \+= 1/.test(exitWiring) && /exitCount >= rosterSize/.test(exitWiring),
  `exit must count worker exits and only settle a no-answer question when ALL workers are gone — a single worker exit must not end the question; got: ${exitWiring}`);

function n2GraceDefault() {
  const m = ENGINE.match(/HLE_N2_GRACE_MS\)\s*\|\|\s*(\d+)/);
  if (!m) throw new Error('HLE_N2_GRACE_MS default not found in engine.js');
  return Number(m[1]);
}
assert.ok(n2GraceDefault() >= 120000,
  `answer-stability GRACE_MS default must be >= 120000ms (got ${n2GraceDefault()}) — 50s raced worker-B's instructed late overwrite of final_answer.txt and killed in-flight corrections (bug 2026-11-06)`);

console.log('PASS: n2 premature-completion guards — team-complete/exit settle only with an answer, GRACE_MS floor 120s');
