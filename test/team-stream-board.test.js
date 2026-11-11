// team-stream-board: 2026-10-23 单列 board-visibility regression.
//
// User report: "run-n2 单流队列中的工具调用数，任务数, 谁认领的这些
// 好像也不展示了" — in the run-n2 单列 (stream) view, the lane's 看板
// info (queue items / claim owners / busy-tool activity) stopped
// showing. Root cause: the ONLY surfaces that render board state are
// the split-view DOM (#team-split: team-mid-queue rows, per-column
// status lines) and the worker-tagged tool-progress handler — both of
// which are display:none in 单列 mode. The fix:
//   1. tool-progress (worker-tagged, teamView active) now ALSO merges
//      all workers' open tools into state.openToolCalls in stream mode
//      so the busy-tool strip / HUD keep working.
//   2. New _renderTeamStreamBoardCard renders the lane's queue
//      (subject + owner + state) + per-worker busy/认领 footer as a
//      persistent live-synced card in #chat-messages; board frames +
//      team-info re-render it, team-lane-end retires it.
//   3. New _appendTeamStreamBoardNotice prints one-line coordination
//      notices (发布/认领/完成/note/apply/状态) into the timeline.
// Static (no server), sub-second standalone.
//
// Run: node test/team-stream-board.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'web', 'public');
const appJs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');

// Slice a function body from app.js source (same shape as the
// fn-body helper; kept local so this test has no deps).
function fnBody(src, re) {
  const m = src.match(re);
  assert.ok(m, 'function found in app.js for ' + re);
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== '{') {
    if (src[i] === ';') break; // matched a call site, not a definition
    i++;
  }
  assert.ok(src[i] === '{', 'opening brace found for ' + re);
  const start = i;
  let depth = 1; i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, Math.max(i, start + 1));
}

// Slice an `if (...) { ... }` block body from app.js source: the match
// may or may not include the opening brace (regex-dependent), so scan
// forward to the first '{' unconditionally and balance braces.
function ifBlock(src, re) {
  const m = src.match(re);
  assert.ok(m, 'block found in app.js for ' + re);
  // m[0] may already include the opening '{' — scan from the match
  // start so the FIRST '{' we hit is the block opener either way.
  let i = m.index;
  while (i < src.length && src[i] !== '{') {
    if (src[i] === ';') throw new Error('matched a call site, not a block: ' + re);
    i++;
  }
  assert.ok(src[i] === '{', 'opening brace found for ' + re);
  const start = i;
  let depth = 1; i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, Math.max(i, start + 1));
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ ' + name + '\n    ' + (err && err.message)); }
}

function main() {
  console.log('── team-stream-board: 单列 shows queue/claims/tool activity ──');

  const tpBody = ifBlock(appJs, /if \(msg\.kind === 'tool-progress'\) \{/);
  const boardBody = ifBlock(appJs, /if \(msg\.kind === 'board'\) \{/);

  // ── 1. tool-progress: stream mode feeds the single-stream slot ──

  t('tool-progress: worker-tagged branch updates split panes AND the stream', () => {
    const m = tpBody.match(/if \(msg\.worker && state\.teamView\.active\) \{[\s\S]*?\n    \}/);
    assert.ok(m, 'worker-tagged tool-progress branch exists');
    const branch = m[0];
    assert.ok(/rec\.openTools\[msg\.worker\]/.test(branch),
      'per-worker openTools cache still updated (split view unchanged)');
    assert.ok(/state\.teamView\.mode !== 'split'/.test(branch),
      'the branch must special-case 单列 (stream) mode — pre-fix it only touched hidden columns');
    assert.ok(/state\.openToolCalls = merged/.test(branch),
      'stream mode must merge workers\' open tools into state.openToolCalls (busy-tool strip input)');
    assert.ok(/_renderClaudeTyping\(\)/.test(branch) && /_updateTaskHUD\(\)/.test(branch),
      'stream mode must re-render the typing strip + HUD after the merge');
  });

  t('tool-progress stream merge covers every lane + worker (flattened)', () => {
    const m = tpBody.match(/const merged = \[\];[\s\S]*?state\.openToolCalls = merged;/);
    assert.ok(m, 'merge accumulator found');
    assert.ok(/_teamLanesList\(\)/.test(m[0]),
      'merge iterates all lanes — multi-lane runs must not lose workers');
    assert.ok(/Object\.values\(lane\.openTools \|\| \{\}\)/.test(m[0]),
      'merge iterates every worker\'s openTools');
  });

  // ── 2. the 单列 board card renderer ──

  const cardBody = fnBody(appJs, /function _renderTeamStreamBoardCard\s*\(/);

  t('_renderTeamStreamBoardCard exists and is stream-mode-only', () => {
    assert.ok(cardBody.length > 100, 'renderer is substantive');
    assert.ok(/state\.teamView\.mode === 'split'/.test(cardBody) && /return;/.test(cardBody.slice(0, 400)),
      'renderer must no-op in split mode (split panes own the board there)');
    assert.ok(/_ensureAgentLogPane\(\)/.test(cardBody),
      'renderer targets the single timeline pane (#chat-messages)');
  });

  t('单列 card shows queue rows with owner (谁认领的)', () => {
    assert.ok(/team-q-row/.test(cardBody), 'queue rows reuse the split-view row classes');
    assert.ok(/item\.owner/.test(cardBody) && /team-q-owner/.test(cardBody),
      'each queue row must show its 认领 owner — the user-visible claim link');
    assert.ok(/team-q-claimed/.test(cardBody) && /team-q-done/.test(cardBody),
      'state styling (claimed/done/open) is preserved on the stream card');
  });

  t('单列 card footer shows per-worker busy tool + 认领 item (工具调用/任务)', () => {
    assert.ok(/rec\.openTools/.test(cardBody), 'footer reads the per-worker openTools map');
    assert.ok(/⚙/.test(cardBody), 'busy tool name + elapsed seconds rendered');
    assert.ok(/认领:/.test(cardBody), 'claimed item surfaced per worker');
    assert.ok(/● idle/.test(cardBody), 'idle workers are explicitly shown idle');
  });

  t('单列 card is keyed per lane and replaced in place (no timeline spam)', () => {
    assert.ok(/team-stream-board-' \+ _teamLaneKey\(laneId\)/.test(cardBody),
      'card id is lane-scoped (multi-lane runs keep one card each)');
    assert.ok(/card\.innerHTML = html/.test(cardBody),
      'an existing card is updated in place rather than appended');
  });

  t('empty board removes the card instead of showing a stale one', () => {
    assert.ok(/if \(card\) card\.remove\(\)/.test(cardBody),
      'a lane whose board is gone must not keep a stale card on screen');
  });

  // ── 3. wiring: board frames / team-info / lane-end drive the card ──

  t('board frame handler re-renders the 单列 card + appends a notice', () => {
    assert.ok(/_renderTeamStreamBoardCard\(laneId\);/.test(boardBody),
      'kind:board handler must refresh the 单列 card (snapshot is authoritative)');
    assert.ok(/_appendTeamStreamBoardNotice\(laneId, msg\.event\)/.test(boardBody),
      'board changes must print a one-line notice into the timeline');
  });

  t('team-info handler seeds the 单列 card on attach/reattach', () => {
    const infoBody = fnBody(appJs, /function _handleTeamInfoFrame\s*\(/);
    assert.ok(/_renderTeamStreamBoardCard\(rec\.laneId\)/.test(infoBody),
      'attach-time team-info (which carries the board snapshot) must seed the stream card');
  });

  t('tool-progress stream path re-renders the card (busy footer stays live)', () => {
    assert.ok(/_renderTeamStreamBoardCard\(laneId\);/.test(tpBody),
      'the worker-tagged tool-progress branch must refresh the 单列 card footer');
  });

  t('team-lane-end retires the 单列 card', () => {
    const endBody = fnBody(appJs, /function _handleTeamLaneEnd\s*\(/);
    assert.ok(/team-stream-board-' \+ _teamLaneKey\(laneId\)/.test(endBody) && /\.remove\(\)/.test(endBody),
      'a finished lane must remove its stream card — no stale "live" board after the run ends');
  });

  // ── 4. board-change notices ──

  const noticeBody = fnBody(appJs, /function _appendTeamStreamBoardNotice\s*\(/);

  t('notices carry the coordination vocabulary + actor', () => {
    for (const label of ['发布', '认领', '完成', '状态']) {
      assert.ok(noticeBody.includes(`'${label}'`) || noticeBody.includes(`${label}`),
        `notice labels must include ${label}`);
    }
    assert.ok(/ev\.actor/.test(noticeBody), 'notice shows which worker acted');
    assert.ok(/state\.teamView\.mode === 'split'/.test(noticeBody),
      'notices are 单列-only (split keeps its own mid-column feed)');
  });

  // ── 5. styles ──

  t('styles: .team-stream-board family exists (card renders styled, not unstyled)', () => {
    for (const cls of ['.team-stream-board', '.team-stream-board-head',
                       '.team-stream-board-count', '.team-stream-board-workers',
                       '.team-stream-board-wstat']) {
      assert.ok(css.includes(cls + ' {') || css.includes(cls + '{'),
        `CSS rule for ${cls} must exist`);
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
