// server.js — blocking POST endpoints backed by myco's OWN engine modules.
//
//   GET  /           -> service info
//   POST /answer     {mode:'single'|'n2', question, system?, timeoutMs?}
//                    -> blocks until the myco engine answers -> {ok,mode,answer,ms,error?}
//   POST /judge      {engine:'single'|'n2', question, answer, truth, timeoutMs?}
//                    -> blocks until the myco engine judges -> {ok,engine,correct,extracted,ms,error?}
//
// model+proxy config is loaded from a myco state .env (see ../utils/env.js).
// `--mock 1` makes the engine return canned results (no model calls) so the
// HTTP + orchestration plumbing can be smoke-tested offline.
'use strict';

const http = require('http');
const fs = require('fs');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    if (k === '--mock') { a.mock = '1'; continue; }
    a[k.slice(2)] = argv[i + 1];
    i++;
  }
  return a;
}

// Parse args + set env BEFORE loading engine.js, which reads BENCH_MOCK at
// require time. `applyEnv` must also run before the engine touches the model.
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.mock) process.env.BENCH_MOCK = '1';
const { applyEnv, modelInfo } = require('../utils/env');
applyEnv(ARGS.env);
const { createPool, readBody, respond, installShutdown } = require('../utils/http-server');
const engine = require('./lib/engine');
const judge = require('./lib/judge');

// One timestamped work dir per server process (= per test run): all n2 worker
// workdirs land under work/<YYYYMMDDHHMMSS>/. `--stamp <YYYYMMDDHHMMSS>` lets a
// launcher (run_all.sh) pin the same timestamp so run.py's report directory
// (work/<stamp>/result) lands in the SAME timestamped dir as the workers.
const WORK_STAMP = engine.setWorkRoot(ARGS.stamp);
console.log(`[hle-server] work root -> ${WORK_STAMP}`);

// Write our PID so the launcher (run_all.sh) can group-kill THIS run's whole
// tree. The launcher starts us with `setsid`, making the server its own session
// leader (PGID == process.pid, in the fork case too). It reads this file and
// does `kill -- -<pid>` to tear down the server plus every SDK worker it spawns
// — nothing else. `$!` is NOT reliable (setsid may fork), hence the pidfile.
try {
  fs.writeFileSync(`${WORK_STAMP}/.server.pid`, String(process.pid) + '\n');
} catch {}

const PORT = Number(ARGS.port) || Number(process.env.HLE_PORT) || 8787;
const DEFAULT_TIMEOUT_MS = Number(ARGS.timeout) || 600000;
const POOL_SIZE = Number(ARGS.concurrency) || 4;

const info = modelInfo(ARGS.env);
console.log(`[hle-server] port=${PORT} mock=${!!ARGS.mock} concurrency=${POOL_SIZE}`);
console.log(`[hle-server] model=${info.model || '(default)'} baseUrl=${info.baseUrl || '(default)'} hasToken=${info.hasToken}`);

// Single-agent (fast, one SDK call) and n2 (slow, dual-worker) get SEPARATE
// pools so a long-running n2 problem can never starve single-agent requests,
// and n2's many in-flight worker model calls are still bounded (each pool is
// POOL_SIZE deep) instead of hammering the upstream with unbounded concurrency.
const poolSingle = createPool(Math.max(1, POOL_SIZE));
const poolN2 = createPool(Math.max(1, POOL_SIZE));

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      const i = modelInfo(ARGS.env);
      // workRoot lets run.py align its own --out to the SAME timestamped dir
      // the server uses for worker artifacts (work/<stamp>/result).
      return respond(res, 200, { ok: true, service: 'myco-hle-bench', model: i.model, baseUrl: i.baseUrl, mock: !!ARGS.mock, workRoot: WORK_STAMP });
    }
    if (req.method === 'POST' && url === '/answer') {
      const body = await readBody(req);
      const mode = String(body.mode || 'single').toLowerCase();
      if (mode !== 'single' && mode !== 'n2') return respond(res, 400, { ok: false, error: `mode must be single|n2, got ${body.mode}` });
      if (!body.question) return respond(res, 400, { ok: false, error: 'question is required' });
      const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const r = await (mode === 'n2' ? poolN2 : poolSingle).run(() => engine.answer(mode, {
        question: String(body.question),
        system: body.system ? String(body.system) : engine.SYSTEM_ANSWER,
        timeoutMs,
        id: body.id,
        seq: body.seq,
        persist: true,   // persist this answer's work/ dir (judge does NOT persist)
      }));
      return respond(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && url === '/judge') {
      const body = await readBody(req);
      const en = String(body.engine || 'single').toLowerCase();
      if (en !== 'single' && en !== 'n2') return respond(res, 400, { ok: false, error: `engine must be single|n2, got ${body.engine}` });
      if (body.question === undefined || body.answer === undefined || body.truth === undefined) {
        return respond(res, 400, { ok: false, error: 'question, answer, truth are required' });
      }
      const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const r = await (en === 'n2' ? poolN2 : poolSingle).run(() => judge.judge(en, {
        question: String(body.question),
        answer: String(body.answer),
        truth: String(body.truth),
        timeoutMs,
        id: body.id,
        seq: body.seq,
      }));
      return respond(res, r.ok ? 200 : 502, r);
    }
    return respond(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return respond(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[hle-server] listening on :${PORT}`);
});

// ── graceful shutdown: never leak SDK worker subprocesses ───────────────────
// Every in-flight /answer or /judge makes the Claude Agent SDK spawn a bundled
// `claude` CLI worker. If this server is killed mid-request and we don't send
// them down with us, those workers get reparented to init and leak (~2.4GB for
// a handful). installShutdown only signals OUR OWN descendants (walked via
// /proc), so a sibling bench server, the user's interactive claude, or the main
// myco server can never be caught (the "误杀" guard).
installShutdown(server);
