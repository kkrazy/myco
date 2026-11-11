// tb4/server.js — blocking POST service that drives myco's OWN engines
// (tool-capable single AgentSession / n2 TeamSession) to solve a Terminal-Bench
// task in a host workspace.
//
//   GET  /        -> service info + workRoot
//   POST /run     {mode:'single'|'n2', taskId, cwd, instruction, timeoutMs?}
//                  -> blocks until the agent finishes (or times out)
//                  -> {ok, mode, ms, error?}
//
// Workspace materialization + verification happen in Python (tb4/run.py +
// lib/workspace.py + lib/verify.py); this server only runs the agent in a
// pre-made `cwd`. model+proxy config is loaded from a myco state .env (utils/env).
// `--mock 1` returns canned results with no model calls (offline smoke test).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

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

const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.mock) process.env.TB4_MOCK = '1';
const { applyEnv, modelInfo } = require('../utils/env');
applyEnv(ARGS.env);
const { createPool, readBody, respond, installShutdown } = require('../utils/http-server');
const engine = require('./lib/engine');

// Local time stamp YYYYMMDDHHMMSS with `tb4-` prefix (distinct from hle-<stamp>).
function runStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `tb4-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
       + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// One timestamped work dir per run: work/tb4-<stamp>/ (workspaces + report are
// placed here by run.py). `--stamp` lets run_all.sh pin the same timestamp so
// run.py's report dir lands in the same folder as the workspaces.
const WORK_STAMP = path.join(__dirname, 'work', ARGS.stamp || runStamp());
fs.mkdirSync(WORK_STAMP, { recursive: true });
try {
  fs.writeFileSync(path.join(WORK_STAMP, '.server.pid'), String(process.pid) + '\n');
} catch {}

const PORT = Number(ARGS.port) || Number(process.env.TB4_PORT) || 8790;
const POOL_SIZE = Number(ARGS.concurrency) || 2;   // each task run is long; low default
const DEFAULT_TIMEOUT_MS = 7200000;                 // 2h default per agent run

const info = modelInfo(ARGS.env);
console.log(`[tb4-server] work root -> ${WORK_STAMP}`);
console.log(`[tb4-server] port=${PORT} mock=${!!ARGS.mock} concurrency=${POOL_SIZE}`);
console.log(`[tb4-server] model=${info.model || '(default)'} baseUrl=${info.baseUrl || '(default)'} hasToken=${info.hasToken}`);

// single (fast, one session) and n2 (slow, dual-worker) get SEPARATE pools so a
// long n2 run can never starve single-agent runs.
const poolSingle = createPool(Math.max(1, POOL_SIZE));
const poolN2 = createPool(Math.max(1, POOL_SIZE));

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      const i = modelInfo(ARGS.env);
      return respond(res, 200, { ok: true, service: 'myco-tb4-bench', model: i.model,
                                 baseUrl: i.baseUrl, mock: !!ARGS.mock, workRoot: WORK_STAMP });
    }
    if (req.method === 'POST' && url === '/run') {
      const body = await readBody(req);
      const mode = String(body.mode || 'single').toLowerCase();
      if (mode !== 'single' && mode !== 'n2') {
        return respond(res, 400, { ok: false, error: `mode must be single|n2, got ${body.mode}` });
      }
      if (!body.cwd || !body.instruction) {
        return respond(res, 400, { ok: false, error: 'cwd and instruction are required' });
      }
      const timeoutMs = Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const r = await (mode === 'n2' ? poolN2 : poolSingle).run(() =>
        engine.run(mode, {
          taskId: body.taskId ? String(body.taskId) : 'task',
          instruction: String(body.instruction),
          cwd: String(body.cwd),
          timeoutMs,
        }));
      return respond(res, r.ok ? 200 : 502, r);
    }
    return respond(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return respond(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[tb4-server] listening on :${PORT}`);
});

// graceful shutdown: never leak SDK worker subprocesses (see utils/http-server).
installShutdown(server);
