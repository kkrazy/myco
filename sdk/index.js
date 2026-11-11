// sdk/index.js — library API wrapping myco's single-agent and run-n2 engines.
//
// This is the ONLY new logic in the SDK: a small, stable interface over the
// engines that already power myco. The engines themselves are reused verbatim
// from bench/hle (which in turn requires myco's own server/src modules
// in-process):
//
//   - single-agent  -> bench/hle/lib/engine.js `answer('single', …)`  => myco's
//                      server/src/local-claude.js `callLocalClaude`
//   - run-n2        -> bench/hle/lib/engine.js `answer('n2', …)`      => myco's
//                      server/src/team-session.js `TeamSession`
//   - judge         -> bench/hle/lib/judge.js `judge(engine, …)`      => the same
//                      engines used as a strict grader
//
// Consumer usage:
//   const sdk = require('./sdk')   // or require('<path>/sdk')
//   const info = sdk.init()        // load model+proxy config from myco state .env
//   await sdk.answer('single', { question })
//   await sdk.runN2({ question })
//   await sdk.judge('single', { question, answer, truth })
//
// The bench engine resolves its `@anthropic-ai/claude-agent-sdk` / `zod`
// deps via NODE_PATH=bench/hle/node_modules (set by start.sh / launchers).
'use strict';

const path = require('path');

// The bench/hle lib directory that owns the (reused) engines. Override with
// MYCO_BENCH_LIB if the bench tree lives elsewhere.
function libRoot() {
  if (process.env.MYCO_BENCH_LIB) return process.env.MYCO_BENCH_LIB;
  return path.join(__dirname, '..', 'bench', 'hle', 'lib');
}

const _libRoot = libRoot();

const engine = require(path.join(_libRoot, 'engine'));
const judgeMod = require(path.join(_libRoot, 'judge'));
const config = require(path.join(_libRoot, 'config'));

// ── config / lifecycle ──────────────────────────────────────────────────────
// Load the model + proxy config myco itself uses (state .env) into
// process.env so the SDK talks to the SAME model gateway as deployed myco.
// Returns the resolved (non-sensitive) model info.
function init(envPath) {
  return config.applyEnv(envPath);
}
function info(envPath) {
  return config.modelInfo(envPath);
}

// ── engine entry points ─────────────────────────────────────────────────────
// Answer a single question. mode: 'single' | 'n2'. Returns
// { ok, mode, answer, ms, durationMs, error? }.
//
// The underlying engine calls the model gateway through the Claude Agent SDK,
// which on this machine can transiently fail to spawn its bundled claude
// binary (the instance may be under process/load pressure from other agents).
// A fast (< ~2s) `ok:false` is almost always that transient spawn failure, so
// we retry a couple of times before giving up. Across-process retry counters
// come from the `MYCO_SDK_RETRIES` env (default 2) or `opts.retries`.
async function answer(mode, opts = {}) {
  const retries = Number(process.env.MYCO_SDK_RETRIES) || (opts && opts.retries != null ? opts.retries : 2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await engine.answer(mode, opts);
    if (last && last.ok) return last;
    if (attempt < retries) await sleep(attempt ? 1200 : 400);
  }
  return last;
}

function runSingle(opts = {}) {
  return engine.answer('single', opts);
}

function runN2(opts = {}) {
  return engine.answer('n2', opts);
}

// Cross-judge a candidate answer against the ground truth using one of the
// myco engines as a strict grader. engineName: 'single' | 'n2'. Returns
// { ok, engine, correct, extracted, answer, ms }.
function judge(engineName, opts = {}) {
  return judgeMod.judge(engineName, opts);
}

// ── convenience re-exports (from the reused engine) ────────────────────────
// Default "answer the question" system prompt, and the work-root helper.
const SYSTEM_ANSWER = engine.SYSTEM_ANSWER;
const setWorkRoot = engine.setWorkRoot;
const buildN2Task = engine.buildN2Task;

module.exports = {
  // lifecycle/config
  init,
  info,
  libRoot: _libRoot,
  // engine calls
  answer,
  runSingle,
  runN2,
  judge,
  // constants/helpers from the reused engine
  SYSTEM_ANSWER,
  setWorkRoot,
  buildN2Task,
  // the underlying (reused) modules, exposed for advanced callers
  engine,
  judgeMod,
};
