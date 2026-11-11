// Regression: refresh / session-switch losing the detailed steps.
// Three gaps this suite locks (all one root cause — durable history
// had no read path):
//   1. TOOL cards (Bash/Edit/Read) older than the 16 KB agent-replay
//      window: GET /sessions/:id/events paginates them from the live
//      buffer or the events.jsonl tail (server/src/agent-events-history.js).
//   2. Shared-board middle-column event feed: the team-info frame now
//      carries the full UI-relevant board log (board.js uiEventLog) so
//      reattach rebuilds it; agent-replay must NOT wipe it again.
//   3. Client wiring: _fetchOlderAgentEvents fires alongside the chat
//      load-older, prepends + _resortChatPaneByTs, and state._eventsHasMore
//      keeps the load-older button alive.
// Run: node test/refresh-history-backfill.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const ATTACH = fs.readFileSync(path.join(ROOT, 'server/src/attach.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const { agentEventsWindow } = require(path.join(ROOT, 'server/src/agent-events-history.js'));
const { DelmBoard } = require(path.join(ROOT, 'server/src/board.js'));

let passed = 0, failed = 0;
function t(name, fn) {
  const run = async () => {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
  };
  t._chain = (t._chain || Promise.resolve()).then(run);
}

process.on('exit', (code) => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0 && code === 0) process.exitCode = 1;
});

// ─── agent-events-history: functional windows ───

function seedBuffer(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push({ type: 'tool_use', seq: i, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), toolName: 'Bash' });
  }
  return out;
}

t('live buffer window: newest tail, oldest→newest order, hasMore truth table', () => {
  const buf = seedBuffer(300);
  const getSession = () => ({ buffer: buf });
  // No cursor → newest 100, oldest→newest.
  const first = agentEventsWindow('s1', { before: null, limit: 100 }, { getSession });
  assert.strictEqual(first.window.length, 100, 'default window must return 100 events');
  assert.strictEqual(first.window[0].seq, 201, 'window must start at seq 201 (oldest→newest within window)');
  assert.strictEqual(first.window[99].seq, 300, 'window must end at seq 300');
  assert.strictEqual(first.total, 300, 'total counts all seq-stamped rows');
  assert.strictEqual(first.hasMore, true, 'hasMore true when older events exist beyond the window');
  // Cursor walk: before=201 → 101..200.
  const second = agentEventsWindow('s1', { before: 201, limit: 100 }, { getSession });
  assert.strictEqual(second.window[0].seq, 101, 'before=201 window must start at seq 101');
  assert.strictEqual(second.window[99].seq, 200, 'before=201 window must end at seq 200');
  assert.strictEqual(second.hasMore, true, 'hasMore true — seq 1..100 still older');
  // Last window: before=101 → 1..100, hasMore false.
  const third = agentEventsWindow('s1', { before: 101, limit: 100 }, { getSession });
  assert.strictEqual(third.window[0].seq, 1, 'final window starts at seq 1');
  assert.strictEqual(third.hasMore, false, 'hasMore false at the head of history — the load-older button retires');
});

t('disk fallback: reaped session reads events.jsonl tail; malformed lines skipped', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evhist-'));
  const dir = path.join(tmp, 'proj', '_myco_');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 1; i <= 10; i++) lines.push(JSON.stringify({ type: 'tool_use', seq: i, ts: '2026-01-01T00:00:0' + (i % 10) + 'Z' }));
  lines.splice(4, 0, '{corrupt-line');   // truncated mid-file line
  lines.push('{"type":"tool_use","seq":11'); // truncated final line
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  const deps = {
    getSession: () => null,  // reaped — no live buffer
    getRecord: () => ({ cwd: path.join(tmp, 'proj') }),
    resolveMycoDir: () => null, // force the rec.cwd fallback path
  };
  const out = agentEventsWindow('s2', { before: null, limit: 5 }, deps);
  assert.strictEqual(out.total, 10, 'corrupt lines must be skipped, 10 valid rows parsed (seq 11 truncated line dropped)');
  assert.strictEqual(out.window.length, 5, 'limit respected on the disk tail');
  assert.strictEqual(out.window[4].seq, 10, 'window ends at the newest valid seq');
  assert.strictEqual(out.hasMore, true, 'older rows exist beyond the 5-row window');
  fs.rmSync(tmp, { recursive: true, force: true });
});

t('disk fallback: empty/missing sources return an empty window, never throw', () => {
  const out = agentEventsWindow('s3', { before: null, limit: 100 }, {
    getSession: () => null,
    getRecord: () => null,   // unknown session
    resolveMycoDir: () => null,
  });
  assert.deepStrictEqual(out.window, [], 'unknown session → empty window');
  assert.strictEqual(out.hasMore, false, 'unknown session → hasMore false');
});

// ─── board.js uiEventLog: the middle-column history source ───

t('uiEventLog returns UI-relevant rows in order, filters read/wait/session', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boardlog-'));
  const persist = path.join(tmp, 'board.jsonl');
  const board = new DelmBoard({ actors: ['worker-A', 'worker-B'], persistPath: persist });
  board.append('worker-A', 'session', { actor: 'worker-A', state: 'running' });
  board.append('worker-A', 'read', {});
  board.append('worker-A', 'item', { id: 'i1', subject: 'deploy' });
  board.append('worker-B', 'wait', {});
  board.append('worker-B', 'claim', { item: 'i1' });
  board.append('worker-B', 'note', { id: 'n1', type: 'FAIL', text: 'boom' });
  board.append('worker-B', 'done', { item: 'i1', summary: 'ok' });
  const log = board.uiEventLog();
  assert.strictEqual(log.length, 4, 'read/wait/session rows must be filtered from the UI log');
  assert.deepStrictEqual(log.map((e) => e.kind), ['item', 'claim', 'note', 'done'], 'log order preserved');
  assert.ok(log.every((e) => typeof e.sequence === 'number' && e.actor), 'rows keep sequence + actor for the feed cards');
  fs.rmSync(tmp, { recursive: true, force: true });
});

t('uiEventLog survives a board rebuild from board.jsonl (reattach after lane death)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boardlog2-'));
  const persist = path.join(tmp, 'board.jsonl');
  const first = new DelmBoard({ actors: ['worker-A'], persistPath: persist });
  first.append('worker-A', 'item', { id: 'i9', subject: 'verify' });
  first.append('worker-A', 'done', { item: 'i9', summary: 'done' });
  // "Lane died" → reconstruct from the journal only, as attach's
  // ended-lane path does.
  const second = new DelmBoard({ actors: ['worker-A'], persistPath: persist });
  const log = second.uiEventLog();
  assert.deepStrictEqual(log.map((e) => e.kind), ['item', 'done'], 'journal replay rebuilds the UI event log');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── attach.js: team-info frames carry the events history ───

t('attach: _shipTeamInfoOnAttach carries events on all three frame paths', () => {
  // Real agent-n2 session path.
  assert.ok(/events:\s*typeof session\.board\.uiEventLog[\s\S]{0,80}\? session\.board\.uiEventLog\(\)/.test(ATTACH),
    'agent-n2 team-info frame must ship board.uiEventLog() — refresh rehydrates the feed');
  // Lane paths: since a6d379d (2026-10-22 multi-lane registry) ended +
  // live lanes ship from ONE loop — one `events: _laneUiEventLog(laneRec)`
  // site covers both lane kinds. The loop must iterate the full lanes
  // list (no `ended` filter on the fresh-attach path) so ended AND live
  // lanes both rehydrate the feed.
  const uses = (ATTACH.match(/events:\s*_laneUiEventLog\(laneRec\)/g) || []).length;
  assert.strictEqual(uses, 1,
    'the per-lane team-info frame must carry events: _laneUiEventLog(laneRec) — one loop ships both ended AND live lanes (multi-lane registry)');
  assert.ok(/for \(const laneRec of lanes\) \{[\s\S]{0,400}events:\s*_laneUiEventLog\(laneRec\)/.test(ATTACH),
    'the single _laneUiEventLog site must sit INSIDE the for-lanes loop (covers ended + live alike)');
  assert.ok(/function _laneUiEventLog\(laneRec\)/.test(ATTACH), '_laneUiEventLog helper must exist (dead-lane safe)');
});

// ─── index.js: the /events route exists and gates viewer-tier ───

t('index: GET /sessions/:id/events route registered with pagination + viewer gate', () => {
  assert.ok(/app\.get\('\/sessions\/:id\/events'/.test(INDEX), 'route must be registered');
  assert.ok(/fileApiPreamble\(req, res, 'viewer'\)/.test(INDEX.slice(INDEX.indexOf("app.get('/sessions/:id/events'"))),
    'route must gate viewer-tier like /chat/history');
  assert.ok(INDEX.slice(INDEX.indexOf("app.get('/sessions/:id/events'")).slice(0, 2500).includes('agentEventsWindow'),
    'route must delegate to agentEventsWindow');
});

// ─── client: wiring guards ───

t('app.js: _fetchOlderAgentEvents prepends, dedups, resorts, and keeps the button via hasMore', () => {
  assert.ok(/function _fetchOlderAgentEvents\(\)/.test(APP), 'backfill fn must exist');
  const body = APP.slice(APP.indexOf('function _fetchOlderAgentEvents'));
  assert.ok(body.includes('before=${oldestSeq}'), 'cursor = oldest rendered data-seq');
  assert.ok(body.includes('renderedSeqs'), 'dedup against rendered cards (reconnect replay overlap)');
  assert.ok(body.includes('_resortChatPaneByTs()'), 'chat-persistence contract §4: MUST resort after append');
  assert.ok(body.includes('state._eventsHasMore = Boolean(data.hasMore)'), 'hasMore tracked for button keep-alive');
  assert.ok(body.slice(0, 3000).includes('_ensureAgentLogPane = () => frag'), 'detached render via pane swap (no scroll/HUD side effects)');
});

t('app.js: load-older fires BOTH backfills (chat rows + tool cards)', () => {
  const at = APP.indexOf('function _revealOlderChat');
  const body = APP.slice(at, at + 3000);
  assert.ok(body.includes('_fetchOlderChatFromServer'), 'chat backfill still fires');
  assert.ok(body.includes('_fetchOlderAgentEvents'), 'events backfill fires in the same interaction');
});

t('app.js: _enforceChatHistoryCap keeps the button when events have more history', () => {
  const at = APP.indexOf('state._eventsHasMore ? 1 : 0');
  assert.ok(at > 0, 'cap total must include the events hasMore signal');
  const at2 = APP.indexOf('function _resetUiForNewSession');
  const resetBody = APP.slice(at2, at2 + 3000);
  assert.ok(resetBody.includes('state._eventsHasMore = false'), 'session switch resets the per-session events cursor state');
});

t('app.js: team-info events rebuild the mid-column feed; agent-replay must NOT wipe it', () => {
  // sliceFn walks to the next column-0 `}` — the multi-lane registry
  // (2026-10-22) grew _handleTeamInfoFrame past the old fixed 3500-byte
  // window and the events-consumption block fell off the end.
  const { sliceFn } = require('./_lib/fn-body');
  const at = APP.indexOf('function _handleTeamInfoFrame');
  const body = sliceFn(APP, at);
  assert.ok(/Array\.isArray\(msg\.events\)/.test(body), 'team-info frame events array consumed');
  // 2026-10-23 row redesign: the feed is lane-scoped — the id carries the
  // lane key and _appendTeamBoardEvent takes (laneId, ev).
  assert.ok(body.includes('feed.replaceChildren()') && body.includes('_appendTeamBoardEvent(rec.laneId, ev)'),
    'feed rebuilt from the server-shipped history (lane-scoped id + call)');
  // The replay wipe must no longer clear the lane-scoped board feeds.
  // 2026-10-23: the wipe walks per-lane worker COLUMN bodies
  // (team-col-<lane>-<worker>) — the only getElementById calls inside
  // the wipe block. The mid feed ids (team-mid-events-*) must never
  // appear as a wipe target.
  const replayAt = APP.indexOf('// team-split-view: replay re-appends every worker-tagged event');
  const replayBody = APP.slice(replayAt, replayAt + 1600);
  const wipeCalls = replayBody.match(/getElementById\([^)]*\)/g) || [];
  assert.ok(wipeCalls.length > 0, 'replay wipe block found (per-lane column bodies)');
  assert.ok(wipeCalls.every((c) => /'team-col-'/.test(c)),
    'agent-replay wipe must only clear lane column bodies (team-col-<lane>-<worker>) — wiping a team-mid-events-* feed would erase the just-backfilled board feed');
});

// ─── orphan-guard: dead code stays dead ───

t('index.js: no leftover inline agentEventsWindow/_readEventsJsonlTail duplicates', () => {
  assert.ok(!/function agentEventsWindow\(sessionId/.test(INDEX), 'inline helper must be gone (moved to agent-events-history.js)');
  assert.ok(!/function _readEventsJsonlTail/.test(INDEX), 'inline jsonl reader must be gone');
});
