// run-n2 单列 regression (2026-10-23): after switching sessions and coming
// back, the /run-n2 lane's team info (task header, queue rows, 认领 claims,
// tool-call status) vanished and the 单列 history pane could land blank.
//
// Root cause: `_teamRowHtml` referenced `taskLabel` (and a badge span) that
// were never declared — the row-header template lost its `const taskLabel =
// …` + `<span class="team-row-badge">` lines in a merge. The function threw
// ReferenceError: taskLabel is not defined, so `_rebuildTeamRows` aborted
// mid-`innerHTML = lanes.map(_teamRowHtml).join('')`, `#team-rows` stayed
// empty, and the exception unwound through `_handleTeamInfoFrame`, killing
// the rest of the attach-frame pipeline (board pane render, column statuses,
// and — via the same throw path on rebuild — the 单列 stream restore).
//
// This test is written to be robust against reasonable refactors: it checks
// (a) the source shape (taskLabel declared + badge span rendered), and
// (b) BEHAVIOUR — the function actually executes without a ReferenceError
// and produces the row markup (executed in a `new Function` sandbox with
// stubbed escHtml/_teamLaneKey/_teamWorkerChipClass/TEAM_COL_MIN_W etc.).
//
// Convention: function-slice assertions (test/_lib/fn-body.js), cf.
// test/team-split-view.test.js + the static guards in test/test.sh.

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

// Slice one function body from `function NAME(` to the next column-0 `}`.
function fnBodySrc(name) {
  const at = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  assert.ok(at >= 0, 'function ' + name + ' must exist in app.js');
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, 'function ' + name + ' must have a body');
  return src.slice(at, end + 2);
}

// Behavioural check: execute _teamRowHtml with its free identifiers stubbed.
// A ReferenceError here is exactly the browser failure (blank lane row).
function execRowHtml(rec) {
  const body = fnBodySrc('_teamRowHtml');
  // Sandbox: stub every free identifier the template legitimately uses.
  const sandbox = {
    TEAM_COL_MIN_W: 220,
    TEAM_MID_MIN_W: 260,
    escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    _teamLaneKey: (id) => id || '__default__',
    _teamWorkerChipClass: (w) => 'agent-worker agent-worker-x',
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    'return (' + body.replace(/^function\s+_teamRowHtml\s*\(([^)]*)\)\s*\{/, 'function ($1) {') + ')'
  )(...Object.values(sandbox));
  return fn(rec);
}

function main() {
  console.log('── _teamRowHtml renders without ReferenceError (team-row-html-undefined) ──');

  t('source shape: taskLabel is DECLARED inside _teamRowHtml (merge lost the declaration once)', () => {
    const body = fnBodySrc('_teamRowHtml');
    assert.ok(
      /(?:const|let|var)\s+taskLabel\s*=/.test(body),
      '_teamRowHtml must declare taskLabel (`const taskLabel = …`) — referencing it undeclared throws ReferenceError and kills the lane row (单列历史/看板全丢)'
    );
  });

  t('source shape: the running/ended badge span is rendered in the row header', () => {
    const body = fnBodySrc('_teamRowHtml');
    assert.ok(
      /team-row-badge/.test(body),
      'row header must render the running/ended badge span (.team-row-badge) — _rebuildTeamRows queries it to sync the ended state'
    );
  });

  t('behaviour: _teamRowHtml executes and returns the row markup (no ReferenceError)', () => {
    const html = execRowHtml({
      laneId: 'lane-1', task: 'fix the widget', ended: false,
      roster: ['worker-A', 'worker-B'],
    });
    assert.ok(typeof html === 'string', 'must return the row HTML string');
    assert.ok(html.includes('team-row-lane-1'), 'row id must embed the lane key');
    assert.ok(html.includes('fix the widget'), 'task header must show the lane task');
    assert.ok(html.includes('team-mid-queue-lane-1') && html.includes('team-mid-events-lane-1'),
      'queue (任务数/认领) + board-event feed containers must exist in the row');
    assert.ok(html.includes('team-status-lane-1-worker-A') && html.includes('team-status-lane-1-worker-B'),
      'per-worker status spans (工具调用数/认领) must exist');
  });

  t('behaviour: ended lane renders the frozen/ended class (attach handshake rebuild)', () => {
    const html = execRowHtml({
      laneId: 'lane-2', task: 'done run', ended: true,
      roster: ['worker-A', 'worker-B'],
    });
    assert.ok(/team-split-ended/.test(html), 'an ended lane row must carry team-split-ended');
    assert.ok(/team-row-badge-ended|ended/.test(html), 'ended state must be visible in the header badge');
  });

  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

main();
