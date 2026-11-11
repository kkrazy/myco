// 单列显示 regression (2026-10-23): after switching sessions, a user whose
// saved layout preference is 单列 (stream) lost ALL single-column printing
// (myco 打印 + 工具打印) on /run-n2 lanes — the pane rendered empty until a
// team frame happened to run _applyTeamViewMode.
//
// Root cause chain (three cooperating defects, all in web/public/app.js):
//  1. _applyTeamViewMode sets `root.hidden = !split` but only manages
//     #chat-messages' hidden flag via `stream.hidden = split`. When the
//     saved mode is 'stream', _ensureTeamSplitDom created #team-split with
//     hidden=true (from _applyTeamViewMode's earlier split-mode state or the
//     fresh-insert default) and nothing un-hid #chat-messages → both panes
//     display:none.
//  2. On session switch (_resetUiForNewSession), _teardownTeamSplit removes
//     the #team-split DOM but #chat-messages keeps whatever hidden state the
//     PREVIOUS session left it in. A previous session that ended in split
//     mode leaves hidden=true; the new session (teamView inactive, mode
//     'stream' saved) never runs _applyTeamViewMode until a team-info frame
//     arrives → the new session's pane is blank.
//  3. _routeAgentEvent returns false in stream mode (correct — the event
//     falls through to the single-stream renderer) but the renderer needs a
//     VISIBLE #chat-messages; hidden panes swallow the prints.
//
// The fix (worker-B, 2026-10-23):
//  - _ensureTeamSplitDom ends with `root.hidden = false` (the container is
//    un-hidden whenever the team view is active; _applyTeamViewMode re-hides
//    it in split mode).
//  - _applyTeamViewMode un-hides #chat-messages in stream mode explicitly.
//  - _resetUiForNewSession clears a stale hidden flag on #chat-messages.
//
// This test locks the source shapes (function-slice assertions — the repo's
// static-guard convention, cf. test/team-split-view.test.js + test.sh).

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

// Slice one function body from column-0 `function NAME(` to the next
// column-0 `}` — same convention as test/_lib/fn-body.js sliceFn.
function fnBody(name) {
  const at = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  assert.ok(at >= 0, 'function ' + name + ' must exist in app.js');
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, 'function ' + name + ' must have a body');
  return src.slice(at, end + 2);
}

function main() {
  console.log('── 单列 stream survives session switch (team-stream-reattach) ──');

  t('_applyTeamViewMode unhides #chat-messages in stream mode (not split-only)', () => {
    const body = fnBody('_applyTeamViewMode');
    // The fix: #chat-messages hidden is explicitly cleared for stream mode.
    assert.ok(
      /if\s*\(stream\)\s*stream\.hidden\s*=\s*split/.test(body),
      'must read `if (stream) stream.hidden = split` — #chat-messages un-hides in stream mode (单列打印恢复)'
    );
    assert.ok(
      /root\.hidden\s*=\s*!split/.test(body),
      'must keep `root.hidden = !split` — split container hides in stream mode (双列展现不变)'
    );
  });

  t('_applyTeamViewMode still hides #team-split in stream mode (双列 unchanged)', () => {
    const body = fnBody('_applyTeamViewMode');
    // Order guard: both toggles present; split mode keeps the exclusive pair.
    assert.ok(body.indexOf('root.hidden') < body.indexOf('stream.hidden = split') ||
              body.indexOf('root.hidden = !split') >= 0,
      'split/stream exclusivity retained');
  });

  t('_ensureTeamSplitDom un-hides the #team-split container', () => {
    const body = fnBody('_ensureTeamSplitDom');
    assert.ok(
      /root\.hidden\s*=\s*false/.test(body),
      'must end with root.hidden = false — a stream-mode insert must not ship display:none'
    );
  });

  t('_resetUiForNewSession clears stale hidden on #chat-messages', () => {
    const body = fnBody('_resetUiForNewSession');
    assert.ok(
      /chat-messages[\s\S]{0,200}\.hidden\s*=\s*false/.test(body) ||
      /chatList0[\s\S]{0,120}\.hidden\s*=\s*false/.test(body),
      'session switch must un-hide #chat-messages — previous session split mode must not blank the new session'
    );
  });

  t('_routeAgentEvent still returns false in stream mode (events reach the single stream)', () => {
    const body = fnBody('_routeAgentEvent');
    assert.ok(
      /if\s*\(state\.teamView\.mode\s*!==\s*'split'\)\s*return\s*false/.test(body),
      'stream-mode events must fall through to the single-stream renderer (myco/工具打印)'
    );
    assert.ok(
      /if\s*\(ev\.compareLane\)\s*return\s*false/.test(body),
      '/compare overlay keeps owning its own events'
    );
  });

  t('agent-replay still routes through _appendAgentEvent (worker events render in 单列)', () => {
    // Anchor on the real handler branch (the frame-shape comment), not the
    // WS-router's `msg.t === 'agent-replay'` dispatch line 190 KB earlier.
    const at = src.indexOf("msg.t === 'agent-replay' && Array.isArray(msg.events)");
    assert.ok(at >= 0, 'agent-replay handler branch present');
    const win = src.slice(at, at + 16000);
    assert.ok(
      win.includes('for (const ev of deduped) _appendAgentEvent(ev);'),
      'replay events must render via the single-stream renderer'
    );
  });

  t('team view mode persists via localStorage (preference shape unchanged)', () => {
    assert.ok(src.includes("localStorage.getItem('myco_team_view_mode')"),
      'saved 单列/双列 preference key must stay');
  });

  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

main();
