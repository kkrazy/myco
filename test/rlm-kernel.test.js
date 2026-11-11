// RLM hard implementation — REPL kernel (agents/rlm/kernel/*).
// myco-rlm-design.md §4.1 / §7: a REAL kernel child process per RLM
// session speaking protocol v1 over NDJSON with channel separation —
// user console.log can never corrupt protocol frames.
//
// These tests spawn the actual child (node kernel/child.js) and drive
// it through ReplKernelManager — the same surface mcp.js uses. Timing:
// handshake + execute are awaited promises (no sleeps); the whole file
// finishes in ~1–2s standalone.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReplKernelManager } = require('../server/src/agents/rlm/kernel/manager');

let passed = 0, failed = 0;
const mgrs = [];
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { console.log('  ✓ ' + name); passed++; })
    .catch((err) => { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; });
}

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-kernel-'));
}

function newManager(sessionId, hostHandler) {
  const m = new ReplKernelManager({ sessionId, cwd: tmpCwd(), hostHandler });
  mgrs.push(m);
  return m;
}

const tests = [];
const T = (name, fn) => tests.push([name, fn]);

console.log('── RLM hard impl: REPL kernel (protocol v1) ──');

T('handshake: kernel child boots with a ready event (protocol 1, no banner)', async () => {
  const m = newManager('k-handshake');
  await m.kernel(); // resolves only after the ready frame
  assert.ok(m.ready, 'manager.ready must be true after kernel() resolves');
  assert.strictEqual(m._kernel.protocol, 1, 'protocol version must be 1');
});

T('execute round-trip: tail-expression repr comes back as resultText', async () => {
  const m = newManager('k-exec');
  const r = await m.execute("state.task = 'find refs'; 'hello ' + 'kernel'");
  assert.strictEqual(r.resultText, '"hello kernel"',
    'the tail expression repr must be the resultText');
});

T('top-level await works inside cells', async () => {
  const m = newManager('k-await');
  const r = await m.execute('await new Promise((res) => setTimeout(() => res("waited"), 50))');
  assert.strictEqual(r.resultText, '"waited"', 'top-level await must resolve into the result');
});

T('namespace persists across cells (prompt-as-a-variable as CODE)', async () => {
  const m = newManager('k-persist');
  await m.execute("state.done = []; state.done.push('step1'); const counter = 41;");
  const r2 = await m.execute('counter + 1');
  assert.strictEqual(r2.resultText, '42',
    'a top-level const in cell 1 must be readable in cell 2 (transformCell persistence)');
  const r3 = await m.execute('JSON.stringify(state)');
  assert.ok(r3.resultText.includes('step1'),
    'state.* written in cell 1 must survive into cell 3');
});

T('stdout channel separation: console.log arrives as stdout, never corrupts frames', async () => {
  const m = newManager('k-stdout');
  const r = await m.execute("console.log('USER CODE OUTPUT'); 'ok'");
  assert.ok(r.stdout && r.stdout.includes('USER CODE OUTPUT'),
    'console.log must surface as the folded stdout field');
  assert.strictEqual(r.resultText, '"ok"',
    'the protocol result frame must still parse cleanly after user prints');
  // Heavy printing — many frames, protocol must stay intact.
  const r2 = await m.execute('for (let i = 0; i < 50; i++) console.log("line " + i); "done"');
  assert.strictEqual(r2.resultText, '"done"',
    '50 console.log lines must not corrupt the protocol stream');
  assert.ok((r2.stdout.match(/line /g) || []).length === 50,
    'all 50 stdout events must be captured');
});

T('user-code error is FOLDED (not thrown): error {ename, evalue, traceback}', async () => {
  const m = newManager('k-error');
  const r = await m.execute('missingSymbol.foo');
  assert.ok(r.error, 'a user-code error must arrive as ev.error');
  assert.strictEqual(r.error.ename, 'ReferenceError',
    'ename must identify the error class');
  assert.ok(/missingSymbol/.test(r.error.evalue), 'evalue names the missing symbol');
  // Kernel stays usable after the error.
  const r2 = await m.execute("'still alive'");
  assert.strictEqual(r2.resultText, '"still alive"',
    'kernel must remain usable after a user-code error');
});

T('listNames lists user variables, not injected builtins', async () => {
  const m = newManager('k-names');
  await m.execute('var myVar = 1; state.x = 2;');
  const names = await m.listNames();
  assert.ok(names.includes('myVar'), 'user var must be listed');
  assert.ok(names.includes('state'), 'state must be listed');
  assert.ok(!names.includes('rlm'), 'the injected rlm shim must NOT be listed');
  assert.ok(!names.includes('console'), 'builtins must NOT be listed');
});

T('snapshot → kill → restart → restore: variables survive process death', async () => {
  const m = newManager('k-snap');
  const cwd = m.cwd;
  await m.execute("state.task = 'survive me'; durable = { n: 7 };");
  const snapPath = path.join(cwd, 'snap.json');
  const snap = await m.snapshot(snapPath);
  assert.ok(snap.variables >= 2, 'snapshot must record the variables (got ' + snap.variables + ')');
  // Hard-kill the child (simulates reaper / container restart).
  m._kernel.kill();
  m._kernel = null;
  // A NEW manager + child on the same cwd, restoring the snapshot.
  const m2 = new ReplKernelManager({ sessionId: 'k-snap-2', cwd });
  mgrs.push(m2);
  const res = await m2.restore(snapPath);
  assert.ok(res.variables >= 2, 'restore must load the variables');
  const r = await m2.execute('typeof durable === "object" ? durable.n : "lost"');
  assert.strictEqual(r.resultText, '7',
    'durable must survive snapshot → process kill → restore');
  const r2 = await m2.execute('state.task');
  assert.strictEqual(r2.resultText, '"survive me"',
    'state.task must survive snapshot → process kill → restore');
});

T('host_request round-trip: rlm.listSubagents inside a cell reaches the host handler', async () => {
  const calls = [];
  const m = newManager('k-host', async (data) => {
    calls.push(data.type);
    if (data.type === 'rlm.list_subagents') return { subagents: [{ rlmChildId: 'c1', name: 'finder' }] };
    if (data.type === 'rlm.run') return { rlmChildId: 'c9', name: 'child9' };
    return { ok: false };
  });
  const r = await m.execute('const rost = await rlm.listSubagents(); rost.subagents.length');
  assert.strictEqual(r.resultText, '1',
    'the host handler reply must resolve the in-cell await');
  assert.deepStrictEqual(calls, ['rlm.list_subagents'],
    'the hostHandler must see the typed host_request');
  // spawn shim carries the prompt + kwargs.
  const r2 = await m.execute('const h = await rlm.spawn("do X", { name: "n1" }); h.rlmChildId');
  assert.strictEqual(r2.resultText, '"c9"', 'rlm.spawn handle must round-trip');
  assert.ok(calls.includes('rlm.run'), 'rlm.run must reach the host handler');
});

T('host handler errors reject the in-cell promise (kernel stays alive)', async () => {
  const m = newManager('k-host-err', async () => { throw new Error('DepthLimitError: too deep'); });
  const r = await m.execute('await rlm.listSubagents()');
  assert.ok(r.error && /DepthLimitError/.test(r.error.evalue),
    'a throwing host handler must surface as the cell error');
  const r2 = await m.execute("'alive after host error'");
  assert.strictEqual(r2.resultText, '"alive after host error"',
    'kernel must stay usable after a host error');
});

T('shutdown stops the child process (no zombie kernels)', async () => {
  const m = newManager('k-shutdown');
  await m.kernel();
  const proc = m._kernel._proc;
  const pid = proc.pid;
  m.shutdown();
  await new Promise((res) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      try { process.kill(pid, 0); }
      catch { return res(); } // process gone
      if (Date.now() > deadline) throw new Error('kernel child did not exit within 5s');
      setTimeout(poll, 50);
    };
    poll();
  });
  assert.ok(true, 'child exited after shutdown (poll, no sleep)');
});

T('protocol version constant: child.js and protocol.md agree (static)', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server/src/agents/rlm/kernel/child.js'), 'utf8');
  const doc = fs.readFileSync(path.join(__dirname, '..', 'server/src/agents/rlm/kernel/protocol.md'), 'utf8');
  const mChild = src.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  assert.ok(mChild, 'child.js must define PROTOCOL_VERSION');
  assert.ok(/protocol:\s*1\b/.test(doc) || /Protocol v1\b/.test(doc) || /protocol v1/i.test(doc),
    'protocol.md must document version 1');
  assert.strictEqual(mChild[1], '1', 'PROTOCOL_VERSION must be 1 (v1)');
});

(async () => {
  for (const [name, fn] of tests) await t(name, fn);
  for (const m of mgrs) { try { m.shutdown(); } catch {} }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
