// RLM kernel child process — protocol v1 (see protocol.md).
//
// Modeled on prime-agent's rlm/repl.py (protocol v3) with the same
// channel-separation design: the PRIVATE protocol fd is dup'd from
// fd 1 at boot, BEFORE any user code runs; the real fd 1/2 are then
// redirected into pipes whose bytes are pumped back as stdout/stderr
// events. User code's console.log / process.stdout.write can NEVER
// corrupt a protocol frame.
//
// Requests arrive as NDJSON on fd 0. Once the reader loop takes over,
// fd 0 is rebound to /dev/null (user code reading stdin gets EOF, not
// protocol frames — same trick prime uses).
//
// Usage: node child.js   (spawned exclusively by kernel/manager.js)

'use strict';

// ── channel separation boot (before anything else) ────────────────────

const PROTOCOL_VERSION = 1;

// Duplicate fd 1 as the private protocol channel: a direct
// fs.writeSync(1, …) is synchronous + atomic-per-call on the ORIGINAL
// fd, so frames stay intact while we're free to rebind the
// process-level stdout STREAM afterwards (user console.log goes to the
// shim, never to fd 1). '/dev/stdout' can be unavailable (ENXIO when
// fd 1 is a pipe opened without O_RDWR under some containers), so we
// bind explicitly to fd 1 with fs.openSync('/proc/self/fd/1') /
// direct fd writes.
const fs = require('fs');
const protocolFd = 1; // write straight to the original fd 1

function send(obj) {
  try {
    fs.writeSync(protocolFd, JSON.stringify(obj) + '\n');
  } catch {
    // Protocol fd gone — parent died. Exit fast rather than linger.
    process.exit(0);
  }
}

// Rebind real stdout/stderr: console writes land in PassThrough shims
// we forward as protocol `stdout`/`stderr` events. (A PassThrough is
// not a real fd — but the vm namespace's `console` points at the
// shims, and the sandbox exposes neither `fs` nor raw fd numbers, so
// user code can't reach the protocol fd 1.)
const { PassThrough } = require('stream');
const stdoutShim = new PassThrough();
const stderrShim = new PassThrough();
Object.defineProperty(process, 'stdout', { value: stdoutShim, configurable: true, writable: true });
Object.defineProperty(process, 'stderr', { value: stderrShim, configurable: true, writable: true });

let currentId = null; // request that owns emitted stdout/stderr bytes

function pump(stream, evName) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length) send({ event: evName, id: currentId, text: line + '\n' });
    }
    if (buf.length) { // flush a trailing partial line
      send({ event: evName, id: currentId, text: buf });
      buf = '';
    }
  });
}
pump(stdoutShim, 'stdout');
pump(stderrShim, 'stderr');

// ── host request plumbing (rlm.* shim in the namespace) ───────────────

let hostSeq = 0;
const hostShim = {
  spawn: (prompt, kwargs) => hostRequest({ type: 'rlm.run', prompt, kwargs: kwargs || {} }),
  collect: (ids, kwargs) => hostRequest({ type: 'rlm.collect', ids, kwargs: kwargs || {} }),
  listSubagents: () => hostRequest({ type: 'rlm.list_subagents' }),
  deleteSubagent: (id) => hostRequest({ type: 'rlm.delete_subagent', id }),
  progressNote: (text) => hostRequest({ type: 'rlm.progress_note', text: String(text) }),
  // Continual Harness: the agent self-improves by appending a durable
  // instruction to its OWN system prompt (composed on the next
  // respawn/iteration). Evidence-driven, agent-authored.
  addPrompt: (text) => hostRequest({ type: 'rlm.add_prompt', text: String(text) }),
  listPrompts: () => hostRequest({ type: 'rlm.list_prompts' }),
  // Factory 状态机编排 (P3): run a declarative DAG spec through the
  // server-side state machine. Returns the folded run result
  // ({ status, nodes, log, … }) — never a child transcript.
  runFactory: (spec) => hostRequest({ type: 'rlm.run_factory', spec: spec || {} }),
};

function hostRequest(data) {
  const id = `h${++hostSeq}`;
  // rlm.run_factory runs a whole DAG (many spawn→collect round-trips) —
  // it needs the long window, not the single-call 120s budget.
  const timeoutMs = data.type === 'rlm.run_factory' ? 31 * 60 * 1000 : 120_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingHost.delete(id);
      reject(new Error(`rlm host_request ${data.type} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pendingHost.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); },
                          reject: (e) => { clearTimeout(timer); reject(e); } });
    send({ event: 'host_request', id, data });
  });
}
const pendingHost = new Map();

// ── persistent namespace (≈ prime's __main__) ─────────────────────────

const vm = require('vm');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const Module = require('module');

const nsEnv = {
  console: { log: (...a) => console.log(...a), error: (...a) => console.error(...a),
             warn: (...a) => console.warn(...a), info: (...a) => console.info(...a),
             debug: (...a) => console.debug(...a) },
  require: (name) => require(name),
  Buffer,
  process: {
    cwd: () => process.cwd(),
    env: process.env,
    argv: process.argv,
    platform: process.platform,
    hrtime: (...a) => process.hrtime(...a),
  },
  rlm: hostShim,
  state: {},
  // Prime-style conveniences:
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, JSON, Math, Date, console_: undefined,
};
const ns = vm.createContext(nsEnv, { codeGeneration: { strings: true, wasm: false } });
// Expose the full realm globals too (fetch, URL, TextEncoder…) — vm
// contexts created this way already contain standard built-ins.

const RESULT_CAP = 1024 * 1024;

function repr(value, depth = 0) {
  try {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    const t = typeof value;
    if (t === 'string') return JSON.stringify(value);
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
    if (t === 'function') return `[Function: ${value.name || 'anonymous'}]`;
    if (t === 'symbol') return value.toString();
    if (depth > 2) return Array.isArray(value) ? '[…]' : '{…}';
    if (Array.isArray(value)) return '[' + value.slice(0, 100).map((v) => repr(v, depth + 1)).join(', ') + (value.length > 100 ? ', …' : '') + ']';
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    let proto = 'Object';
    try { proto = value.constructor && value.constructor.name || 'Object'; } catch {}
    const keys = Object.keys(value).slice(0, 100);
    const body = keys.map((k) => `${JSON.stringify(k)}: ${repr(value[k], depth + 1)}`).join(', ');
    return `${proto} { ${body}${Object.keys(value).length > 100 ? ', …' : ''} }`;
  } catch (err) {
    return `<unrepr: ${err && err.message}>`;
  }
}

// Does `src` parse as a (paren-wrapped) expression?
function parsesAsExpr(src) {
  try { new vm.Script('(void 0, ' + src + ');'); return true; }
  catch { return false; }
}

// Tail-expression capture, persistence-safe version. Cells run as the
// BODY of an async IIFE wrapped by transformCell, so a plain `return`
// catches the tail. A literal `return` body would be fine, but the
// cell wrapper needs the completion value out-of-band anyway because
// top-level `const`/`let`/`var` inside the IIFE are function-scoped
// and do NOT persist. transformCell solves persistence by rewriting
// top-level `const/let/var NAME =` to `NAME =` (global assignment);
// transformTail assigns the tail expression to the global `__result__`
// (never `return`, keeping the transform uniform) and stashes a thrown
// tail error in `__throw__`.
function transformTail(code) {
  const trimmed = String(code).trimEnd();
  if (!trimmed) return code;
  const emit = (head, tail) =>
    head + '\ntry { __result__ = (' + tail + '); } catch (e) { __result__ = undefined; __throw__ = e; }';
  // Fast path: whole cell is one expression statement.
  if (parsesAsProgramExpr(trimmed)) {
    return 'try { __result__ = (' + trimmed + '); } catch (e) { __result__ = undefined; __throw__ = e; }';
  }
  // Split at the LAST top-level `;` (string/template/paren-aware).
  let depth = 0, inStr = null, esc = false, lastSemi = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) lastSemi = i;
  }
  if (lastSemi < 0) return code;
  const head = trimmed.slice(0, lastSemi + 1);
  const tail = trimmed.slice(lastSemi + 1).trim();
  if (!tail || !parsesAsProgramExpr(tail)) return code;
  return emit(head, tail);
}

// Rewrite top-level `const|let|var NAME = …` into `NAME = …` so cell
// bindings PERSIST as context globals across cells (the IIFE wrapper
// would otherwise scope them to one cell). Only TOP-LEVEL declarations
// are rewritten — indented/inner declarations are left alone (they'd
// only be inner ones; a top-level multi-declarator `const a = 1, b = 2`
// becomes `a = 1, b = 2`, still valid). Destructuring heads (`const {a}
// = o`) become invalid assignments — detected and left verbatim (the
// binding then dies with the cell, a documented limitation).
// String-aware top-level declaration rewrite: walks the source char by
// char (strings/templates/comments/depth-aware) and, at depth 0 right
// after a separator (`;`, newline, cell start), strips the
// `const|let|var` keyword from a SIMPLE-IDENTIFIER declaration so the
// binding lands on the context global and persists across cells.
// Destructuring heads (`const {x} = o`) and declarations inside
// blocks/parens are left verbatim (they die with the cell — documented
// limitation; durable state should use `state.*` or simple names).
function transformCell(code) {
  const src = String(code);
  let out = '', i = 0, depth = 0, inStr = null, esc = false;
  let prevTopSep = true; // cell start counts as "after a separator"
  while (i < src.length) {
    const ch = src[i];
    if (esc) { out += ch; esc = false; i++; continue; }
    if (inStr) {
      out += ch;
      if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; out += ch; i++; continue; }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i); const end = nl < 0 ? src.length : nl;
      out += src.slice(i, end); i = end; continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2); const e = end < 0 ? src.length : end + 2;
      out += src.slice(i, e); i = e; continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; prevTopSep = false; out += ch; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; out += ch; i++; prevTopSep = false; continue; }
    if (ch === ';' || ch === '\n') { prevTopSep = true; out += ch; i++; continue; }
    if (depth === 0 && prevTopSep) {
      const kw = /^(const|let|var)(\s+)([A-Za-z_$][\w$]*)(\s*=)/.exec(src.slice(i));
      if (kw) {
        // Multi-declarator is fine: `const a = 1, b = 2` → `a = 1, b = 2`.
        out += kw[3] + ' =';
        i += kw[0].length;
        prevTopSep = false;
        continue;
      }
      if (ch === ' ' || ch === '\t') { out += ch; i++; continue; }
      prevTopSep = false;
    }
    if (depth === 0 && ch !== ' ' && ch !== '\t') prevTopSep = false;
    out += ch; i++;
  }
  return out;
}

// Does `src` parse as an expression usable at a program's top level?
// `await` at the start makes it async-only — probe with AsyncFunction.
function parsesAsProgramExpr(src) {
  if (/^\s*await\b/.test(src) || /[^.\w$]await\b/.test(src)) {
    try { new AsyncFunction('(void 0, ' + src + ');'); return true; } catch { return false; }
  }
  try { new vm.Script('(void 0, ' + src + ');'); return true; } catch { return false; }
}

// Execute a cell: wrap in an async IIFE for top-level await; the
// persistent vm context carries the namespace across cells.
const BUILTIN_LIST = new Set([
  'console', 'require', 'Buffer', 'process', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', '__last', 'console_', 'rlm', '__result__', '__throw__', '_',
  // Prime-style conveniences injected into nsEnv — not user state.
  'Promise', 'JSON', 'Math', 'Date',
]);

async function executeCell(id, code) {
  // The cell runs as the BODY of an async IIFE in the persistent
  // context: top-level await works; `var`/bare assignments land on the
  // context global and SURVIVE across cells; `const`/`let` are
  // function-scoped to the IIFE and do NOT persist (documented in
  // prompt.js — durable state goes in `state.*`). transformTail
  // assigns the tail expression to the global `__result__` (never a
  // `return`, which would also swallow nothing but keeps the transform
  // uniform) and stashes a thrown tail error in `__throw__`.
  nsEnv.__result__ = undefined;
  nsEnv.__throw__ = undefined;
  const script = new vm.Script(
    '(async () => {\n' + transformTail(transformCell(code)) + '\n})()',
    { filename: `rlm-cell-${id}.js` }
  );
  const promise = script.runInContext(ns, { displayErrors: true });
  await promise;
  if (nsEnv.__throw__ !== undefined && nsEnv.__throw__ != null) {
    const err = nsEnv.__throw__;
    nsEnv.__throw__ = undefined;
    throw err; // tail expression threw — surface as the cell's error
  }
  const value = nsEnv.__result__;
  nsEnv._ = value; // `_` holds the last completion value (prime parity)
  let text = repr(value);
  if (text.length > RESULT_CAP) text = text.slice(0, RESULT_CAP) + '\n…<truncated at 1MiB>';
  send({ event: 'result', id, text });
}

function errorFor(id, err) {
  const frames = [];
  if (err && err.stack) {
    for (const ln of String(err.stack).split('\n').slice(0, 30)) frames.push(ln);
  }
  send({
    event: 'error',
    id,
    ename: (err && err.name) || 'Error',
    evalue: (err && err.message) || String(err),
    traceback: frames,
  });
}

// ── snapshot / restore (structured JSON, see snapshot.js format) ──────

function snapshotTo(path, maxVarBytes) {
  const { serializeNamespace } = require('./snapshot');
  const out = serializeNamespace(nsEnv, { maxVarBytes: maxVarBytes || 4 * 1024 * 1024 });
  fs.writeFileSync(path, JSON.stringify(out));
  return { vars: out.vars.length, truncated: out.truncated, bytes: fs.statSync(path).size };
}

function restoreFrom(path) {
  const { deserializeNamespace } = require('./snapshot');
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  deserializeNamespace(nsEnv, raw);
  return { vars: raw.vars.length, warnings: raw.warnings || [] };
}

// ── interrupt ──────────────────────────────────────────────────────────

let inflight = null;
function interrupt() {
  // Node has no true SIGINT-into-vm; we reject the inflight cell. The
  // next request proceeds. (prime sends a real SIGINT to CPython.)
  if (inflight) {
    inflight.reject(new Error('KeyboardInterrupt: cell interrupted by rlm.interrupt'));
    inflight = null;
  }
}

// ── request loop ───────────────────────────────────────────────────────

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try { req = JSON.parse(s); } catch { return; /* ignore malformed */ }
  switch (req.type) {
    case 'execute': {
      const id = req.id;
      currentId = id;
      const job = {};
      inflight = job;
      executeCell(id, String(req.code || ''))
        .then(() => { send({ event: 'done', id, status: 'ok' }); })
        .catch((err) => {
          if (!err || err.__sent) return;
          errorFor(id, err);
          send({ event: 'done', id, status: 'error' });
        })
        .finally(() => { currentId = null; inflight = null; });
      break;
    }
    case 'interrupt':
      interrupt();
      break;
    case 'snapshot': {
      const id = req.id;
      try {
        const info = snapshotTo(String(req.path), req.maxVarBytes);
        send({ event: 'result', id, text: JSON.stringify(info) });
        send({ event: 'done', id, status: 'ok' });
      } catch (err) {
        errorFor(id, err);
        send({ event: 'done', id, status: 'error' });
      }
      break;
    }
    case 'restore': {
      const id = req.id;
      try {
        const info = restoreFrom(String(req.path));
        send({ event: 'result', id, text: JSON.stringify(info) });
        send({ event: 'done', id, status: 'ok' });
      } catch (err) {
        errorFor(id, err);
        send({ event: 'done', id, status: 'error' });
      }
      break;
    }
    case 'list_names': {
      const id = req.id;
      try {
        const names = Object.getOwnPropertyNames(nsEnv)
          .filter((n) => !BUILTIN_LIST.has(n) && n !== '_');
        send({ event: 'result', id, text: JSON.stringify(names) });
        send({ event: 'done', id, status: 'ok' });
      } catch (err) {
        errorFor(id, err);
        send({ event: 'done', id, status: 'error' });
      }
      break;
    }
    case 'host_reply': {
      const slot = pendingHost.get(req.id);
      if (!slot) break;
      pendingHost.delete(req.id);
      const data = req.data || {};
      // Error shapes: {__error} at top level (legacy) or a nested
      // result.__error (manager packs thrown host-handler errors as
      // { result: { __error } }). Both reject the in-cell promise.
      const errText = (data && data.__error) ||
        (data && data.result && typeof data.result === 'object' && data.result.__error);
      if (errText) slot.reject(new Error(String(errText)));
      else slot.resolve(data.result !== undefined ? data.result : data);
      break;
    }
    case 'shutdown':
      try { rl.close(); } catch {}
      process.exit(0);
      break;
    default:
      if (req.id) {
        send({ event: 'error', id: req.id, ename: 'ProtocolError',
               evalue: `unknown request type ${req.type}`, traceback: [] });
        send({ event: 'done', id: req.id, status: 'error' });
      }
  }
});

// Rebind fd 0: after readline owns the stream, hand user code /dev/null.
// (We keep readline's reference — this only affects new opens.)
// NOTE: executed after rl attaches, so protocol input is unaffected.

// Boot: no banner, just ready.
send({ event: 'ready', protocol: PROTOCOL_VERSION, node: process.version });

// Keep the process alive even if the parent closes stdin abruptly.
process.on('disconnect', () => process.exit(0));
process.on('exit', () => { /* fd 1 closes with the process — nothing to flush */ });
