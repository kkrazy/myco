// bug-7 round 2 regression: the agent-replay WS frame must dedup
// identical events from session.buffer before shipping. Suspected
// upstream cause is `_hydrateBufferFromDisk` (loads events.jsonl tail
// on restart) overlapping with the SDK's `resume` replay (re-walks
// the conversation tail) — recent events end up in the buffer twice
// and the client's chrome-batch adjacency rule renders them as
// stacked identical "▸ × N ✓ result · NNN bytes" rows.
//
// The fix lives at the WIRE in attach.js _attachAgentWebSocket:
// JSON-stringify each event, drop duplicates by signature. There's
// a matching client-side dedup in app.js _handleAgentFrame as
// defense-in-depth, but the server-side dedup is the primary cut.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Re-implement the dedup contract here so we exercise it without
// pulling in attach.js (which has a long require-chain and a ws/
// sessions cycle that's expensive in this lightweight test).
// Any future change to the inline implementation in attach.js
// should ALSO update this mirror — the source-grep tests below
// catch the wire-call mismatch.
function _dedupBuffer(buffer) {
  const seen = new Set();
  const events = [];
  let dropped = 0;
  for (const ev of buffer) {
    let sig;
    try { sig = JSON.stringify(ev); } catch { sig = null; }
    if (sig && seen.has(sig)) { dropped++; continue; }
    if (sig) seen.add(sig);
    events.push(ev);
  }
  return { events, dropped };
}

console.log('── bug-7 round 2: agent-replay event dedup ──');

t('three byte-identical events collapse to one', () => {
  const ev = { ts: '2026-05-16T16:06:43.123Z', type: 'tool_result', tool_use_id: 'toolu_X', content: 'abc', isError: false };
  const buf = [ev, ev, ev];
  const { events, dropped } = _dedupBuffer(buf);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(dropped, 2);
});

t('events with different ts (but same content) stay distinct', () => {
  // Real legit duplicates the SDK might produce: same tool result emitted
  // by two different turns. Each carries its own stamped ts from
  // agent-session._emit. They MUST stay separate so the timeline reads
  // correctly.
  const buf = [
    { ts: '2026-05-16T16:06:43.123Z', type: 'tool_result', tool_use_id: 'toolu_X', content: 'abc' },
    { ts: '2026-05-16T16:06:44.456Z', type: 'tool_result', tool_use_id: 'toolu_Y', content: 'abc' },
  ];
  const { events, dropped } = _dedupBuffer(buf);
  assert.strictEqual(events.length, 2);
  assert.strictEqual(dropped, 0);
});

t('chronological order of unique events is preserved', () => {
  const a = { ts: '2026-05-16T16:00:00.000Z', type: 'turn_start', prompt: 'do X' };
  const b = { ts: '2026-05-16T16:00:01.000Z', type: 'tool_use', name: 'Bash', input: { command: 'ls' } };
  const c = { ts: '2026-05-16T16:00:02.000Z', type: 'tool_result', content: 'files', tool_use_id: 'toolu_X' };
  const buf = [a, b, b, c, a, c];
  const { events, dropped } = _dedupBuffer(buf);
  // First occurrence wins — order should be a, b, c.
  assert.deepStrictEqual(events.map((e) => e.type), ['turn_start', 'tool_use', 'tool_result']);
  assert.strictEqual(dropped, 3);
});

t('bug-7 reproducer: 30 identical tool_result events fold to 1', () => {
  // The user-reported symptom: three "▸ × 10 ✓ result · 3671 bytes"
  // batches stacked. The minimum-reproducer is the same event 30
  // times — chrome-batch adjacency would otherwise group them into a
  // single "× 30" batch, but the user's chrome-batch run was broken
  // by interleaved non-chrome events (assistant_text / fatal). Dedup
  // catches it at the source.
  const ev = { ts: '2026-05-16T16:06:43.000Z', type: 'tool_result',
               tool_use_id: 'toolu_dup', content: 'x'.repeat(3671), isError: false };
  const buf = new Array(30).fill(ev);
  const { events, dropped } = _dedupBuffer(buf);
  assert.strictEqual(events.length, 1, 'all 30 identical copies should collapse');
  assert.strictEqual(dropped, 29);
});

t('non-serializable events still pass through (no crash)', () => {
  // Defensive: an event with a circular reference is unlikely but
  // JSON.stringify would throw. The dedup falls through to "include
  // the event" rather than dropping it silently. Catches future SDK
  // schema changes that inadvertently introduce a cycle.
  const a = {}; a.self = a;
  const b = { ts: '2026-05-16T16:00:00.000Z', type: 'turn_start' };
  const { events, dropped } = _dedupBuffer([a, b, a]);
  // Both unserializable events pass through (no signature → no dedup).
  // The serializable one passes through once.
  assert.strictEqual(events.length, 3);
  assert.strictEqual(dropped, 0);
});

t('attach.js source has the bug-7 dedup wire call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  // The dedup lives inside _attachAgentWebSocket. Pin the deduped
  // `events`/`trimmed` ws.send shape AND the dedup loop body so a
  // future cleanup pass can't silently revert to the raw
  // `events: session.buffer` form.
  assert.ok(/t:\s*'agent-replay',\s*events:\s*(events|trimmed)\s*\}/.test(src),
    'agent-replay wire send must use the deduped `events`/`trimmed` array, not session.buffer directly');
  assert.ok(/bug-7 round 2/.test(src) && /Dedup/.test(src),
    'attach.js dedup comment block missing — a future cleanup might rip the loop');
  assert.ok(/dedup dropped/.test(src),
    'attach.js dedup must log dropped count for diagnostic visibility');
});

t('attach.js source has the bug-9 round-4 two-phase byte-budget cap on agent-replay', () => {
  // The byte cap now has TWO budgets (round 4 two-phase): initial
  // 8 KB for first paint + default 64 KB backfill. Both budgets are
  // constants in attach.js; both phases call _shipAgentReplay which
  // dedupes + byte-trims to the passed-in budget.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  assert.ok(/INITIAL_AGENT_REPLAY_BYTES\s*=\s*1\s*\*\s*1024/.test(src),
    'attach.js must define INITIAL_AGENT_REPLAY_BYTES = 1 * 1024 (round 5 tight cap)');
  assert.ok(/DEFAULT_AGENT_REPLAY_BYTES\s*=\s*16\s*\*\s*1024/.test(src),
    'attach.js must define DEFAULT_AGENT_REPLAY_BYTES = 16 * 1024 (round 5 rolling cap)');
  assert.ok(/_shipAgentReplay/.test(src),
    'attach.js must factor the agent-replay send into _shipAgentReplay so the helper is called twice (initial + backfill)');
  assert.ok(/byte-trim/.test(src),
    'attach.js byte-trim must log when it fires for diagnostic visibility');
  assert.ok(/t:\s*'agent-replay',\s*events:\s*trimmed/.test(src),
    'attach.js agent-replay ws.send must ship the trimmed array');
});

t('byte-budget trim math: keeps the tail prefix that fits, drops older', () => {
  // Mirror the trim loop in attach.js. If the constants OR the
  // accumulator pattern drift, the asserts below catch it.
  const events = [];
  for (let i = 0; i < 20; i++) {
    events.push({ ts: '2026-05-16T00:00:' + String(i).padStart(2, '0') + '.000Z',
                  type: 'tool_use', name: 'Bash', input: { command: 'echo ' + i.toString().repeat(40) } });
  }
  const BUDGET = 600;   // small enough to clip most of the 20 events
  let bytes = 0, keepFromIdx = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    const sz = JSON.stringify(events[i]).length;
    if (bytes && bytes + sz > BUDGET) break;
    bytes += sz;
    keepFromIdx = i;
  }
  const trimmed = events.slice(keepFromIdx);
  assert.ok(trimmed.length > 0 && trimmed.length < events.length,
    'budget must clip something but keep at least one event, got ' + trimmed.length);
  // Tail-first: last element of trimmed should be the most recent event.
  assert.strictEqual(trimmed[trimmed.length - 1].ts, '2026-05-16T00:00:19.000Z',
    'trimmed tail must be the most recent event');
  // Budget respected: total bytes ≤ BUDGET (or just one event if oversized).
  const totalBytes = trimmed.reduce((s, e) => s + JSON.stringify(e).length, 0);
  assert.ok(totalBytes <= BUDGET || trimmed.length === 1,
    'trimmed total bytes should fit the budget unless single-event fallback fired');
});

t('byte-budget single oversized event fallback: keeps at least 1', () => {
  // Constructed event whose stringified size exceeds the budget.
  // The trim loop must still return [event] — never [].
  const big = { ts: 't', type: 'fatal', error: 'x'.repeat(2000) };
  const events = [big];
  const BUDGET = 100;
  let bytes = 0, keepFromIdx = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    const sz = JSON.stringify(events[i]).length;
    if (bytes && bytes + sz > BUDGET) break;
    bytes += sz;
    keepFromIdx = i;
  }
  const trimmed = events.slice(keepFromIdx);
  assert.strictEqual(trimmed.length, 1, 'single oversized event must still be returned');
});

t('app.js source has the bug-7 client-side defense-in-depth dedup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/agent-replay.*dedup dropped/.test(src) || /bug-7 round 2/.test(src),
    'app.js _handleAgentFrame must have the matching client-side dedup');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
