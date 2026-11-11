// ReplKernelManager — one kernel child process per RLM session.
//
// Mirrors prime-agent's pa-core kernel manager: spawn / handshake /
// execute / interrupt / snapshot / restore / shutdown lifecycle over
// the protocol-v1 NDJSON channels (see kernel/protocol.md).
//
// The manager owns:
//   - child_process.spawn('node', [child.js]) with piped stdio;
//   - a per-id event multiplexer (result/error/stdout/stderr/done);
//   - the host_request routing: child events of type host_request are
//     forwarded to the opts.hostHandler callback (host.js router) and
//     the reply is written back as a host_reply request on the same id.
//
// Lifecycle contract: callers (agents/rlm/index.js facade) wire
// `manager.shutdown()` into the AgentSession 'exit' path so a killed
// session never leaks its kernel process.

'use strict';

const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const CHILD_PATH = path.join(__dirname, 'child.js');
const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000;

class ReplKernel extends EventEmitter {
  constructor({ sessionId, cwd, hostHandler }) {
    super();
    this.sessionId = sessionId;
    this.cwd = cwd || process.cwd();
    this.hostHandler = hostHandler || null;
    this.ready = false;
    this.dead = false;
    this.protocol = null;
    this._seq = 0;
    this._pending = new Map();   // id -> {resolve, reject, timer, events[]}
    this._stdoutBuf = '';
    this._stderrBuf = '';
    this._proc = null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start() {
    this._proc = spawn(process.execPath, [CHILD_PATH], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RLM_KERNEL_SESSION: this.sessionId },
    });
    this._proc.stdout.setEncoding('utf8');
    this._proc.stdout.on('data', (chunk) => this._onProtocolBytes(chunk));
    this._proc.stderr.setEncoding('utf8');
    this._proc.stderr.on('data', (chunk) => {
      // stderr of the CHILD PROCESS itself (pre-boot crash etc.)
      this._stderrBuf += chunk;
      this.emit('child-stderr', chunk);
    });
    this._proc.on('exit', (code, signal) => {
      this.dead = true;
      const err = new Error(`rlm kernel exited (code=${code} signal=${signal})`);
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this._pending.clear();
      this.emit('exit', { code, signal });
    });
    this._proc.on('error', (err) => {
      this.dead = true;
      this.emit('error', err);
    });
    // Handshake: poll for the ready event (no fixed sleep — the
    // protocol reader resolves it, with a hard timeout guard).
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.ready) return;
        reject(new Error(`rlm kernel handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms` +
          (this._stderrBuf ? ` stderr: ${this._stderrBuf.slice(0, 2000)}` : '')));
      }, HANDSHAKE_TIMEOUT_MS);
      this.once('_ready', (info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  _onProtocolBytes(chunk) {
    this._stdoutBuf += chunk;
    let idx;
    while ((idx = this._stdoutBuf.indexOf('\n')) >= 0) {
      const line = this._stdoutBuf.slice(0, idx);
      this._stdoutBuf = this._stdoutBuf.slice(idx + 1);
      const s = line.trim();
      if (!s) continue;
      let ev;
      try { ev = JSON.parse(s); } catch {
        // Frame corruption would mean channel separation broke.
        this.emit('protocol-garbage', line);
        continue;
      }
      this._onEvent(ev);
    }
  }

  _onEvent(ev) {
    if (ev.event === 'ready') {
      this.protocol = ev.protocol;
      this.ready = true;
      this.emit('_ready', ev);
      this.emit('ready', ev);
      return;
    }
    if (ev.event === 'host_request') {
      this._onHostRequest(ev);
      return;
    }
    if (ev.event === 'stdout') { this.emit('stdout', ev); return; }
    if (ev.event === 'stderr') { this.emit('stderr', ev); return; }
    if (ev.event === 'result' || ev.event === 'error') {
      const p = this._pending.get(ev.id);
      if (p) p.events.push(ev);
      // `error` here is a PROTOCOL event (user-code failure), not a
      // Node error — emitting it on the EE 'error' channel would be an
      // unhandled-error crash. Route protocol errors through the
      // 'cell-error' channel instead; transport failures (child died)
      // use the regular 'error' channel via the proc error handler.
      this.emit(ev.event === 'error' ? 'cell-error' : 'result', ev);
      return;
    }
    if (ev.event === 'done') {
      const p = this._pending.get(ev.id);
      if (!p) return;
      this._pending.delete(ev.id);
      clearTimeout(p.timer);
      if (ev.status === 'error') {
        const errEv = p.events.find((e) => e.event === 'error') ||
          { ename: 'Error', evalue: `request failed with status=error` };
        p.reject(new KernelError(errEv.ename, errEv.evalue, errEv.traceback || []));
      } else {
        const resEv = p.events.find((e) => e.event === 'result');
        p.resolve({ text: resEv ? resEv.text : undefined, events: p.events });
      }
      this.emit('done', ev);
    }
  }

  async _onHostRequest(ev) {
    this.emit('host_request', ev);
    let data = { result: { __error: `no hostHandler wired for kernel ${this.sessionId}` } };
    if (typeof this.hostHandler === 'function') {
      try {
        const result = await this.hostHandler(ev.data, this);
        data = { result };
      } catch (err) {
        data = { result: { __error: err && err.message ? err.message : String(err) } };
      }
    }
    if (!this.dead) this._write({ type: 'host_reply', id: ev.id, data });
  }

  _write(obj) {
    if (this.dead || !this._proc || !this._proc.stdin.writable) {
      throw new Error('rlm kernel is not writable (dead?)');
    }
    this._proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _nextId() { return `c${++this._seq}`; }

  // ── requests ─────────────────────────────────────────────────────────

  _request(payload, timeoutMs = DEFAULT_EXECUTE_TIMEOUT_MS) {
    if (this.dead) return Promise.reject(new Error('rlm kernel is dead'));
    const id = payload.id || (payload.id = this._nextId());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`rlm kernel request ${payload.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, events: [] });
      try { this._write(payload); }
      catch (err) { clearTimeout(timer); this._pending.delete(id); reject(err); }
    });
  }

  // Execute a code cell in the persistent namespace. Resolves with
  // {text} (the tail-expression repr) once `done status=ok` arrives.
  execute(code, { timeoutMs } = {}) {
    return this._request({ type: 'execute', code }, timeoutMs);
  }

  interrupt() { try { this._write({ type: 'interrupt' }); } catch {} }

  snapshot(filePath, maxVarBytes) {
    return this._request({ type: 'snapshot', path: filePath, maxVarBytes });
  }

  restore(filePath) {
    return this._request({ type: 'restore', path: filePath });
  }

  listNames() {
    return this._request({ type: 'list_names' }, 10_000);
  }

  shutdown() {
    if (this.dead) return;
    try { this._write({ type: 'shutdown' }); } catch {}
    // Hard kill after a grace period so a wedged child can't linger.
    const proc = this._proc;
    setTimeout(() => {
      try { if (proc && proc.exitCode === null) proc.kill('SIGKILL'); } catch {}
    }, 1500).unref();
  }

  kill() {
    if (this.dead) return;
    this.dead = true;
    try { this._proc && this._proc.kill('SIGKILL'); } catch {}
  }
}

class KernelError extends Error {
  constructor(ename, evalue, traceback) {
    super(`${ename}: ${evalue}`);
    this.name = 'KernelError';
    this.ename = ename;
    this.evalue = evalue;
    this.traceback = traceback;
  }
}

// Manager — one instance per RLM session (facade index.js creates one
// via `new ReplKernelManager({ sessionId, cwd })`). Wraps the single
// ReplKernel for that session and exposes the per-session API the rlm
// MCP server (mcp.js) drives: execute / listNames / snapshot / restore
// / shutdown, plus `cwd` for path resolution. The kernel child spawns
// LAZILY on first use (a session that never calls rlm_eval pays
// nothing) and is torn down by shutdown().
class ReplKernelManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sessionId = opts.sessionId || null;
    this.cwd = opts.cwd || process.cwd();
    this.hostHandler = opts.hostHandler || null;
    this._kernel = null;
    this._starting = null;
  }

  // Get (or lazily start) the kernel child. Concurrent callers share
  // the same start promise.
  async kernel() {
    if (this._kernel && !this._kernel.dead) return this._kernel;
    if (this._starting) return this._starting;
    const k = new ReplKernel({ sessionId: this.sessionId, cwd: this.cwd,
                               hostHandler: this.hostHandler });
    k.on('stdout', (ev) => this.emit('stdout', ev));
    k.on('stderr', (ev) => this.emit('stderr', ev));
    k.on('host_request', (ev) => this.emit('host_request', ev));
    k.on('exit', (info) => {
      if (this._kernel === k) this._kernel = null;
      this.emit('kernel-exit', info);
    });
    this._starting = k.start().then(() => {
      this._kernel = k;
      this._starting = null;
      return k;
    }).catch((err) => {
      this._starting = null;
      throw err;
    });
    return this._starting;
  }

  // ── per-session request surface (used by mcp.js) ─────────────────────

  // Execute a code cell. Resolves with a folded event object:
  //   { stdout, stderr, error, resultText } — the shape
  //   mcp._formatExecuteResult consumes. Rejects only on transport
  //   failures (dead kernel / timeout), NOT on user-code errors — a
  //   user error arrives as { error: {ename, evalue, traceback} } with
  //   isError surfaced by the MCP tool.
  async execute(code, opts = {}) {
    const k = await this.kernel();
    const stdout = [], stderr = [];
    const onData = (list) => (ev) => { if (ev.id != null || ev.text) list.push(ev.text); };
    const onOut = onData(stdout), onErr = onData(stderr);
    k.on('stdout', onOut); k.on('stderr', onErr);
    try {
      const res = await k.execute(code, opts);
      return {
        stdout: stdout.join('') || undefined,
        stderr: stderr.join('') || undefined,
        resultText: res.text,
      };
    } catch (err) {
      if (err instanceof KernelError) {
        // User-code error: fold as a normal result (isError upstream).
        return {
          stdout: stdout.join('') || undefined,
          stderr: stderr.join('') || undefined,
          error: { ename: err.ename, evalue: err.evalue, traceback: err.traceback || [] },
        };
      }
      throw err;
    } finally {
      k.off('stdout', onOut); k.off('stderr', onErr);
    }
  }

  async listNames() {
    const k = await this.kernel();
    const res = await k.listNames();
    try { return JSON.parse(res.text); } catch { return []; }
  }

  // Snapshot the namespace. Resolves { variables, pruned, bytes }.
  async snapshot(filePath, opts = {}) {
    const k = await this.kernel();
    const res = await k.snapshot(filePath, opts.maxVarBytes);
    try {
      const info = JSON.parse(res.text);
      return { variables: info.vars, pruned: info.truncated || 0, bytes: info.bytes };
    } catch { return { variables: 0, pruned: 0, bytes: 0 }; }
  }

  // Restore the namespace. Resolves { variables }.
  async restore(filePath) {
    const k = await this.kernel();
    const res = await k.restore(filePath);
    try { return { variables: JSON.parse(res.text).vars }; }
    catch { return { variables: 0 }; }
  }

  interrupt() { if (this._kernel) this._kernel.interrupt(); }

  // Teardown: flush + kill the kernel child. Idempotent.
  shutdown() {
    if (this._kernel) { try { this._kernel.shutdown(); } catch {} this._kernel = null; }
    if (this._starting) { try { this._starting.then((k) => k.shutdown()).catch(() => {}); } catch {} this._starting = null; }
  }

  get ready() { return !!(this._kernel && this._kernel.ready); }
  get dead() { return !(this._kernel && !this._kernel.dead); }

  list() { return this._kernel ? [{ sessionId: this.sessionId, ready: this._kernel.ready }] : []; }
}

// A process-wide registry so the host router (host.js) can find the
// manager for a session when a kernel host_request arrives.
const globalManagers = new Map();

function registerManager(sessionId, manager) { globalManagers.set(sessionId, manager); }
function getManager(sessionId) { return globalManagers.get(sessionId) || null; }
function shutdownAll() {
  for (const [, m] of globalManagers) { try { m.shutdown(); } catch {} }
  globalManagers.clear();
}
process.on('exit', shutdownAll);

module.exports = {
  ReplKernel,
  KernelError,
  ReplKernelManager,
  registerManager,
  getManager,
  shutdownAll,
  CHILD_PATH,
  HANDSHAKE_TIMEOUT_MS,
};
