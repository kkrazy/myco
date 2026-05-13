// pty.js — _extractMode + 'mode-change' emit semantics.
//
// The mode regexes in pty-patterns.js scan the bottom-of-screen mode
// bar. _extractMode classifies; _checkMenu (called every 750ms) compares
// against this._lastMode and emits a 'mode-change' event on transitions
// only. First scan establishes baseline silently — no spurious "entered
// default" pill on reconnect.
//
// This test exercises the transition state machine directly. Spawning
// a real PTY would require a claude binary, so we stub the PtySession
// internals (headless terminal + EventEmitter parts) the same way
// menu-broadcast.test.js does.

const assert = require('assert');
const { EventEmitter } = require('events');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// ─── Fake headless terminal ───────────────────────────────────────────
// pty.js _extractMode only uses headless.rows + headless.buffer.active.
// {viewportY, getLine(y).translateToString(true)}. Same shim shape used
// by menu-broadcast.test.js.
function fakeHeadless(text) {
  const lines = text.split('\n');
  return {
    rows: lines.length,
    buffer: {
      active: {
        viewportY: 0,
        getLine: (y) => ({ translateToString: () => lines[y] || '' }),
      },
    },
  };
}

// ─── Driver: instantiate JUST the mode-tracking parts of PtySession ───
// We avoid `new PtySession()` because the constructor spawns a real PTY.
// Instead we build a minimal object with the helper functions bound and
// drive _checkMenu's mode-change branch directly.
function makeMonitor() {
  const { MODE_ACCEPT_RE, MODE_PLAN_RE, MODE_BYPASS_RE } = require('../server/src/pty-patterns');
  const emitter = new EventEmitter();
  const state = {
    headless: null,
    _lastMode: null,
    _extractMode() {
      if (!this.headless || !this.headless.buffer) return 'default';
      try {
        const buf = this.headless.buffer.active;
        const rows = this.headless.rows;
        for (let i = rows - 1; i >= Math.max(0, rows - 10); i--) {
          const line = buf.getLine(buf.viewportY + i);
          if (!line) continue;
          const text = line.translateToString(true).trim();
          if (!text) continue;
          if (MODE_BYPASS_RE.test(text)) return 'bypass';
          if (MODE_PLAN_RE.test(text)) return 'plan';
          if (MODE_ACCEPT_RE.test(text)) return 'accept';
        }
      } catch {}
      return 'default';
    },
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    tick() {
      const mode = this._extractMode();
      if (this._lastMode == null) {
        this._lastMode = mode;
      } else if (mode !== this._lastMode) {
        const from = this._lastMode;
        this._lastMode = mode;
        this.emit('mode-change', { from, to: mode, ts: new Date().toISOString() });
      }
    },
  };
  return { state, emitter };
}

// ─── Tests ────────────────────────────────────────────────────────────

t('first scan establishes baseline silently (no emit)', () => {
  const { state, emitter } = makeMonitor();
  let emitted = 0;
  emitter.on('mode-change', () => emitted++);
  state.headless = fakeHeadless('⏸ plan mode on (shift+tab to cycle)');
  state.tick();
  assert.strictEqual(emitted, 0, 'baseline tick must NOT emit');
  assert.strictEqual(state._lastMode, 'plan');
});

t('transition default → plan emits one mode-change', () => {
  const { state, emitter } = makeMonitor();
  const events = [];
  emitter.on('mode-change', (e) => events.push(e));
  state.headless = fakeHeadless('idle prompt');         // tick 1: baseline = default
  state.tick();
  state.headless = fakeHeadless('⏸ plan mode on (shift+tab to cycle)');
  state.tick();                                          // tick 2: default → plan
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].from, 'default');
  assert.strictEqual(events[0].to, 'plan');
});

t('identical-state ticks do NOT emit', () => {
  const { state, emitter } = makeMonitor();
  let emitted = 0;
  emitter.on('mode-change', () => emitted++);
  state.headless = fakeHeadless('⏵⏵ accept edits on (shift+tab to cycle)');
  state.tick();   // baseline
  state.tick();   // still accept
  state.tick();   // still accept
  assert.strictEqual(emitted, 0, 'no transitions ⇒ no emits');
});

t('multi-step trajectory default → plan → accept → default emits 3 events', () => {
  const { state, emitter } = makeMonitor();
  const events = [];
  emitter.on('mode-change', (e) => events.push(`${e.from}→${e.to}`));
  state.headless = fakeHeadless('idle prompt');
  state.tick();   // baseline = default
  state.headless = fakeHeadless('⏸ plan mode on');
  state.tick();
  state.headless = fakeHeadless('⏵⏵ accept edits on');
  state.tick();
  state.headless = fakeHeadless('idle prompt');
  state.tick();
  assert.deepStrictEqual(events, ['default→plan', 'plan→accept', 'accept→default']);
});

t('bypass-permissions banner classifies as bypass (not plan/accept)', () => {
  const { state, emitter } = makeMonitor();
  const events = [];
  emitter.on('mode-change', (e) => events.push(e));
  state.headless = fakeHeadless('idle');
  state.tick();
  state.headless = fakeHeadless('bypass permissions mode on (shift+tab to cycle)');
  state.tick();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].to, 'bypass');
});

t('payload carries ISO timestamp', () => {
  const { state, emitter } = makeMonitor();
  let evt = null;
  emitter.on('mode-change', (e) => { evt = e; });
  state.headless = fakeHeadless('idle');
  state.tick();
  state.headless = fakeHeadless('⏸ plan mode on');
  state.tick();
  assert.ok(evt && evt.ts);
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(evt.ts), `expected ISO ts, got ${evt.ts}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
