// slash-run-explore — /run-explore handler wiring, WITHOUT spawning real
// lanes. startExploreLane / startProgressHeartbeat / onLaneTerminal are
// monkey-patched so handleRunExplore's parse + guard + assembly logic is
// exercised in isolation (mirrors slash-n2-compare.test.js's stub style).

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const slash = require(path.join(ROOT, 'server/src/slashcmds.js'));
const cl = require(path.join(ROOT, 'server/src/compare-lanes.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Capture ctx: records every reply so assertions can check the usage /
// guard messages, and exposes a stubbed alive session.
function captureCtx(args, extra = {}) {
  const replies = [];
  return {
    args,
    sessionId: extra.sessionId || 'sess-explore',
    session: extra.session !== undefined ? extra.session : { alive: true, cwd: '/tmp/x', emit: () => {} },
    user: 'tester',
    absCwd: extra.absCwd || '/tmp/x',
    reply: (text) => replies.push(String(text)),
    replies,
  };
}

async function main() {
  console.log('── slash-run-explore: /run-explore parse + wiring ──');

  // Stub the lane layer BEFORE any handler call.
  const origStart = cl.startExploreLane;
  const origHeartbeat = cl.startProgressHeartbeat;
  const origTerminal = cl.onLaneTerminal;
  const started = [];
  cl.startExploreLane = (o) => {
    started.push(o);
    return {
      lane: new (require('events').EventEmitter)(),
      id: 'shadow', laneId: 'n2-x', roster: [],
      boardFile: 'b.jsonl', dir: '/tmp/x/dir', startedAt: Date.now(),
      harnessKey: 'explore-task-test',
    };
  };
  cl.startProgressHeartbeat = () => () => {};
  cl.onLaneTerminal = () => {};
  try {

    await t('no args → usage message, no lane started', () => {
      const ctx = captureCtx('');
      slash.handleRunExplore(ctx);
      assert.ok(ctx.replies.length >= 1, 'replied');
      assert.ok(ctx.replies[0].includes('Usage: `/run-explore'), 'usage text shown');
      assert.strictEqual(started.length, 0, 'no lane started');
    });

    await t('bare task → default N=4', () => {
      started.length = 0;
      const ctx = captureCtx('design a better compression algorithm');
      slash.handleRunExplore(ctx);
      assert.strictEqual(started.length, 1, 'lane started');
      assert.strictEqual(started[0].nPaths, 4, 'default 4 paths');
      assert.ok(started[0].task.includes('compression algorithm'), 'task text passed through');
    });

    await t('leading N parsed and stripped from the task', () => {
      started.length = 0;
      const ctx = captureCtx('6 solve the hard problem with evidence');
      slash.handleRunExplore(ctx);
      assert.strictEqual(started[0].nPaths, 6, 'N=6 parsed');
      assert.strictEqual(started[0].task, 'solve the hard problem with evidence', 'N stripped from task');
    });

    await t('N out of range rejected (1 and 513)', () => {
      started.length = 0;
      const ctx1 = captureCtx('1 only one path');
      slash.handleRunExplore(ctx1);
      assert.ok(ctx1.replies.some((r) => r.includes('N must be 2..512')), 'N=1 rejected with range message');
      const ctx513 = captureCtx('513 too many paths task');
      slash.handleRunExplore(ctx513);
      assert.ok(ctx513.replies.some((r) => r.includes('N must be 2..512')), 'N=513 rejected with range message');
      assert.strictEqual(started.length, 0, 'no lane started for out-of-range N');
    });

    await t('3-digit N within range parsed (500)', () => {
      started.length = 0;
      const ctx = captureCtx('500 explore this broadly');
      slash.handleRunExplore(ctx);
      assert.strictEqual(started[0].nPaths, 500, 'N=500 parsed');
      assert.strictEqual(started[0].task, 'explore this broadly', 'N stripped from task');
    });

    await t('N without task text rejected', () => {
      started.length = 0;
      const ctx = captureCtx('5');
      slash.handleRunExplore(ctx);
      assert.ok(ctx.replies.some((r) => r.includes('N must be followed by the task text')),
        'bare N rejected with explanation');
      assert.strictEqual(started.length, 0, 'no lane started');
    });

    await t('dead session → guard message, no lane', () => {
      started.length = 0;
      const ctx = captureCtx('some task', { session: { alive: false } });
      slash.handleRunExplore(ctx);
      assert.ok(ctx.replies.some((r) => r.includes('session not running')), 'guard message');
      assert.strictEqual(started.length, 0, 'no lane started');
    });

    await t('numeric-looking task text is NOT misparsed as N when too large', () => {
      started.length = 0;
      const ctx = captureCtx('12345 make this id the subject'); // 5 digits → not 1-2 → task text
      slash.handleRunExplore(ctx);
      assert.strictEqual(started.length, 1, 'lane started');
      assert.strictEqual(started[0].nPaths, 4, 'default N (leading token treated as task text)');
      assert.ok(started[0].task.startsWith('12345'), 'task keeps the leading token');
    });

  } finally {
    cl.startExploreLane = origStart;
    cl.startProgressHeartbeat = origHeartbeat;
    cl.onLaneTerminal = origTerminal;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
