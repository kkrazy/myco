// utils/http-server.js — generic HTTP server plumbing shared by the benchmark
// harnesses (bench/hle/server.js, bench/tb4/server.js): a tiny concurrency
// pool, JSON body/response helpers, and graceful process-tree shutdown.
//
// Extracted verbatim (behavior-neutral) from bench/hle/server.js so each bench
// server keeps only its own routes + engine wiring.
'use strict';

const fs = require('fs');

// tiny concurrency pool (cap concurrent in-flight model calls)
function createPool(n) {
  let active = 0;
  const queue = [];
  function run(fn) {
    return new Promise((resolve, reject) => {
      const task = () => {
        active++;
        fn().then(resolve, reject).finally(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
      };
      if (active < n) task();
      else queue.push(task);
    });
  }
  return { run };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function respond(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Walk /proc to collect every descendant PID of `pid` (used to tear down the
// claude-agent-sdk worker subprocesses a server spawns). Only OUR OWN
// descendants are signalled, so a sibling bench server / the user's interactive
// claude / the main myco server can never be caught (the "误杀" guard).
function descendantPids(pid) {
  const seen = new Set();
  let frontier = [String(pid)];
  while (frontier.length) {
    const next = [];
    for (const p of frontier) {
      let kids = '';
      try { kids = fs.readFileSync(`/proc/${p}/task/${p}/children`, 'utf8'); } catch { continue; }
      for (const c of kids.trim().split(/\s+/)) {
        if (!c || seen.has(c)) continue;
        seen.add(c);
        next.push(c);
      }
    }
    frontier = next;
  }
  return [...seen].map(Number).filter((n) => n > 1);
}

// Graceful shutdown: TERM every SDK worker descendant, close the server, then
// hard-KILL stragglers so none orphans to init. Installs SIGINT/SIGTERM.
function installShutdown(server, log) {
  const logFn = log || ((...args) => console.log(...args));
  let shuttingDown = false;
  function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    const workers = descendantPids(process.pid);
    logFn(`[server] ${sig}: tearing down ${workers.length} SDK worker(s)`);
    for (const pid of workers) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    try { server.close(); } catch {}
    // Grace for in-flight models to flush, then hard-kill any stragglers so none
    // orphan to init.
    setTimeout(() => {
      for (const pid of descendantPids(process.pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      process.exit(0);
    }, 2000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createPool, readBody, respond, descendantPids, installShutdown };
