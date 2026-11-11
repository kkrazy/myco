// team-split-singlestream: 2026-10-23 单列 print regression.
//
// User report: run-n2 单列 (stream) view stopped printing — myco text,
// tool calls, worker activity all vanished after the dual-column
// (split) view landed. Root cause: _routeAgentEvent consumed the
// worker-tagged event in split mode (return true) so it never reached
// the single-stream renderer; after a session switch the agent-replay
// rebuilt ONLY the stream, so the 单列 view was empty for the whole
// dual-column run. The fix: split mode renders into the worker column
// AND falls through (return false) so #chat-messages always prints
// every worker event with its badge — in BOTH modes. The dual-column
// task-only policy itself is unchanged (see team-split-taskonly).
//
// Static + tiny-eval (no server), sub-second standalone.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'web', 'public');
const appJs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');

// Slice a function body from app.js source (same shape as the
// fn-body helper; kept local so this test has no deps).
function fnBody(src, re) {
  const m = src.match(re);
  assert.ok(m, 'function found in app.js for ' + re);
  // Walk forward from the match to the first '{' (opening the body),
  // then balance braces to the closing '}' on column 0.
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

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ ' + name + '\n    ' + (err && err.message)); }
}

function main() {
  console.log('── team-split-singlestream: 单列 stream always prints worker events ──');

  const routeBody = fnBody(appJs, /function _routeAgentEvent\s*\(/);

  t('_routeAgentEvent never consumes the event (falls through to the stream)', () => {
    // The regression: split mode ended with `return true`, swallowing
    // the event so _appendAgentEvent never rendered it into
    // #chat-messages. The fix: the final return must be false (fall
    // through) on every path past the guards, so a worker event always
    // also prints into the single stream.
    const trimmed = routeBody.replace(/\s+$/, '');
    assert.ok(/return false;\s*\}\s*$/.test(trimmed),
      'the function must end with `return false` — the split-mode column render falls through to the single-stream renderer');
    assert.ok(!/return true;/.test(routeBody),
      '_routeAgentEvent must never return true (consume) — the 单列 stream would lose the event');
  });

  t('split mode still renders into the worker column before falling through', () => {
    assert.ok(/_appendTeamColumnEvent\(evLaneId, ev\.worker, ev, \{\}\)/.test(routeBody),
      'the column append call must survive the fix (dual-column rendering unchanged)');
    assert.ok(/team-col-' \s*\+\s*_teamLaneKey\(evLaneId\)/.test(routeBody),
      'column body lookup stays lane-scoped');
  });

  t('split mode caches into the lane colEvents (replay/column rebuild input)', () => {
    assert.ok(/laneCache\.push\(ev\)/.test(routeBody),
      'the per-lane per-worker cache push must survive (a later switch back to split rebuilds from it)');
  });

  t('stream mode fall-through has no swallow either', () => {
    assert.ok(/if \(state\.teamView\.mode !== 'split'\) return false;/.test(routeBody),
      'stream mode must return false so the plain stream renderer prints the event with the worker badge');
  });

  t('missing column DOM also falls through (event still prints in the stream)', () => {
    // Pre-fix the stale-DOM path returned true ("stay cached") — the
    // event silently vanished from BOTH surfaces. Post-fix it returns
    // false so the stream still prints it.
    const m = routeBody.match(/if \(!body\) \{\s*\/\/ lane not in the registry view yet[\s\S]*?return false;\s*\}/);
    assert.ok(m, 'the stale-DOM branch must return false, not consume the event');
  });

  t('_appendAgentEvent routes via _routeAgentEvent and keeps the fall-through render', () => {
    const body = fnBody(appJs, /function _appendAgentEvent\s*\(/);
    assert.ok(/if \(_routeAgentEvent\(ev\)\) return;/.test(body),
      'the routing hook call site is intact');
  });

  t('agent-replay wipe comment no longer claims the stream never sees worker rows', () => {
    assert.ok(!/pane prepend below never sees them/.test(appJs),
      'the stale "worker rows belong to the columns only" comment is gone (they now print in both surfaces)');
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
