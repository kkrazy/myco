// team-stream-reattach-preserve — 2026-10-26 单列 content cleared on
// switch/refresh (user report: "单列展示切换session或者刷新 chat-messages会
// 内容清空不显示 / formatProgress 打印内容在单列显示不打印了").
//
// The 单列 (stream) view's board content lives as two DOM artifacts in
// #chat-messages: the per-lane card (.team-stream-board, rendered by
// _renderTeamStreamBoardCard — queue/claim/busy-tool, i.e. exactly the
// coordination/progress info formatProgress's heartbeat would print) and
// the one-line board-change notices (.team-ev-card, via
// _appendTeamStreamBoardNotice). Neither is re-shipped by the attach's
// agent-replay frame (they are not agent events), yet the agent-replay
// handler wiped ALL non-chat-msg children on every reattach — so a session
// switch or page refresh stripped both off 单列 and nothing repainted them:
// the 单列 view came back with its 看板/进度 content gone.
//
// The fix (all in web/public/app.js, the agent-replay handler):
//   1. the wipe PRESERVES .team-stream-board + .team-ev-card (skips them
//      with `continue` instead of removing).
//   2. after the replay event loop, the stream board card is RE-SEEDED for
//      every live lane from the authoritative rec.board snapshot it was
//      seeded from on the team-info attach frame — so a reattach also
//      refreshes any board progress missed while the device was detached.
//   3. the re-seed skips retired (ended) lanes so a finished run is never
//      repainted (couples with team-ended-cleanup's endedLanes bookkeeping).
//
// Static source-shape assertions (repo's UI regression convention), plus a
// tiny behavioural sandbox that exercises the wipe guard against a stubbed
// DOM so the preserve does not silently rot.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

// The agent-replay handler branch + the ~2 KB after it (the wipe →
// dedup loop → our re-seed block).
const at = src.indexOf("msg.t === 'agent-replay' && Array.isArray(msg.events)");
assert.ok(at >= 0, 'agent-replay handler branch present');
const window = src.slice(at, at + 5400);

console.log('── team-stream-reattach-preserve: 单列 board content survives reattach ──');

t('agent-replay wipe PRESERVES the 单列 board card + notices (does not strip them)', () => {
  assert.ok(
    /el\.classList\.contains\('team-stream-board'\) \|\| el\.classList\.contains\('team-ev-card'\)\) continue;/.test(window),
    'the wipe must `continue` past .team-stream-board and .team-ev-card — pre-fix it removed every non-chat-msg child, emptying the 单列 board after refresh'
  );
});

t('agent-replay re-seeds the stream board card for every LIVE lane after the replay loop', () => {
  assert.ok(/for \(const ev of deduped\) _appendAgentEvent\(ev\);/.test(window),
    'the replay event loop is still present (the base contract)');
  const reseedAt = window.indexOf('for (const ev of deduped) _appendAgentEvent(ev);');
  const tail = window.slice(reseedAt);
  assert.ok(/_teamLanesList\(\)/.test(tail) && /_renderTeamStreamBoardCard\(rec\.laneId\)/.test(tail),
    'after the event loop there must be a re-seed pass calling _renderTeamStreamBoardCard per lane (rec.board is authoritative)');
});

t('re-seed is stream-mode-only and skips retired/ended lanes', () => {
  const reseedAt = window.indexOf('for (const ev of deduped) _appendAgentEvent(ev);');
  const tail = window.slice(reseedAt);
  assert.ok(/state\.teamView\.mode !== 'split'/.test(tail),
    're-seed must not run in split mode (split panes own the board there)');
  assert.ok(/endedLanes\[rec\.laneId\]/ .test(tail) && /continue;/.test(tail),
    're-seed must skip a retired (ended) lane — a finished run is never repainted');
});

t('behavioural: the wipe guard retains .team-stream-board / .team-ev-card, removes other non-chat-msg', () => {
  // Extract the exact preserve-condition from the wipe loop and eval it in
  // a tiny sandbox against the three child classes we care about.
  const m = window.match(/el\.classList\.contains\('team-stream-board'\) \|\| el\.classList\.contains\('team-ev-card'\)/);
  assert.ok(m, 'preserve condition extractable');
  const cond = m[0];
  const cls = (c) => ({ classList: { contains: (k) => k === c } });
  assert.strictEqual(Function('el', 'return ' + cond)(cls('team-stream-board')), true,
    '.team-stream-board child must be preserved (not wiped)');
  assert.strictEqual(Function('el', 'return ' + cond)(cls('team-ev-card')), true,
    '.team-ev-card child must be preserved (not wiped)');
  assert.strictEqual(Function('el', 'return ' + cond)(cls('agent-card')), false,
    'a plain agent card is NOT preserved (it is re-appended by the replay)');
});

t('renderChatPane still preserves the 单列 board artifacts (belt + suspendres for the chat-history apply)', () => {
  // renderChatPane rebuilds the .chat-msg bubbles and re-merges every
  // non-chat-msg child — the board card + notices must fall in that set.
  const rcpAt = src.indexOf('function renderChatPane');
  const rcp = src.slice(rcpAt, rcpAt + 2200);
  assert.ok(/el\.classList && el\.classList\.contains\('chat-msg'\)\) continue;/.test(rcp),
    'renderChatPane must preserve (continue past) non-.chat-msg children — incl. the stream board card');
});

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
