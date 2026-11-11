// delm-10 RLM mode — web UI contract (feature: /rlm one-shot lane badge
// + rlm-mode-changed state-update). Locks the three additive frontend
// surfaces WITHOUT a browser:
//   1. _rlmLaneBadge renders the 🧠 RLM chip for `rlmLane`-tagged events
//      (the tag rlm-session.js startRlmLane stamps on bridged events).
//   2. _workerBadge composes the RLM chip after the worker chip.
//   3. _applyStateUpdate handles kind:'rlm-mode-changed' (from /rlm on|off)
//      and records state.rlmMode.
//   4. styles.css ships the .agent-worker-rlm chip color.
//
// The frontend is a plain script (no module exports), so like the other
// web-contract tests in this repo we evaluate the relevant function
// bodies from source. See test/team-split-view.test.js for the same
// source-slicing approach.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = () => fs.readFileSync(path.join(ROOT, 'web/public/app.js'), 'utf8');
const CSS_SRC = () => fs.readFileSync(path.join(ROOT, 'web/public/styles.css'), 'utf8');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Minimal escHtml mirror (the app's escHtml escapes &, <, >, ", ').
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Extract one named function's body from app.js source. Slices from the
// `function <name>(` anchor to the next column-0 `}` — same convention as
// test/_lib/fn-body.js sliceFn, inlined here so this test has no deps.
function fnBody(src, nameRe) {
  const at = src.search(nameRe);
  assert.ok(at >= 0, 'function must exist in app.js source: ' + nameRe);
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, 'function body terminator found');
  return src.slice(at, end + 2);
}

async function main() {
  console.log('── delm-10: RLM mode web UI ──');

  await t('app.js defines _rlmLaneBadge rendering the 🧠 RLM chip', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _rlmLaneBadge\s*\(/);
    assert.ok(body.includes('rlmLane'), 'badge must read ev.rlmLane (the lane tag from startRlmLane)');
    assert.ok(body.includes('agent-worker-rlm'), 'badge must use the agent-worker-rlm class');
    assert.ok(body.includes('🧠'), 'badge carries the 🧠 glyph so RLM cards are visually distinct');
    assert.ok(body.includes('return \'\''), 'events without rlmLane render no badge (unchanged cards)');
  });

  await t('_workerBadge composes the RLM chip (worker + rlm lanes share the head slot)', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _workerBadge\s*\(/);
    assert.ok(body.includes('_rlmLaneBadge(ev)'), 'worker badge path must chain the RLM badge');
  });

  await t('_applyStateUpdate handles rlm-mode-changed (state.rlmMode tracked)', () => {
    const src = APP_SRC();
    const at = src.indexOf("msg.kind === 'rlm-mode-changed'");
    assert.ok(at >= 0, "app.js must handle state-update kind:'rlm-mode-changed' (broadcast by /rlm on|off)");
    // The handler must be INSIDE _applyStateUpdate (not some unrelated site).
    const fnAt = src.indexOf('function _applyStateUpdate(');
    const nextFnAt = src.indexOf('\nfunction ', fnAt + 10);
    assert.ok(fnAt >= 0 && at > fnAt && at < nextFnAt,
      'rlm-mode-changed handler must live inside _applyStateUpdate');
    const slice = src.slice(at, at + 300);
    assert.ok(slice.includes('state.rlmMode'), 'handler records state.rlmMode from msg.rlm');
  });

  await t('styles.css ships the .agent-worker-rlm chip style', () => {
    const css = CSS_SRC();
    assert.ok(/\.agent-worker-rlm\s*\{/.test(css),
      'styles.css must style .agent-worker-rlm (chip would render unstyled otherwise)');
  });

  await t('RLM chip renders correct HTML for a rlmLane-tagged event', () => {
    // Execute the badge functions in a shared scope so _workerBadge can
    // call _laneTaskBadge + _rlmLaneBadge, verifying the composed output
    // shape. (2026-10-22 multi-lane: _workerBadge also composes the
    // laneTask 「task」 chip — included in the eval scope.)
    const src = APP_SRC();
    const badgeSrc = fnBody(src, /function _rlmLaneBadge\s*\(/);
    const laneSrc = fnBody(src, /function _laneTaskBadge\s*\(/);
    const workerSrc = fnBody(src, /function _workerBadge\s*\(/);
    const scope = new Function('escHtml',
      badgeSrc + '\n' + laneSrc + '\n' + workerSrc + '\nreturn { _rlmLaneBadge, _laneTaskBadge, _workerBadge };');
    const { _rlmLaneBadge, _laneTaskBadge, _workerBadge } = scope(escHtml);
    const out = _rlmLaneBadge({ rlmLane: 'rlm' });
    assert.ok(out.includes('agent-worker-rlm'), 'chip has the class');
    assert.ok(out.includes('🧠 RLM'), 'chip shows 🧠 RLM');
    assert.strictEqual(_rlmLaneBadge({}), '', 'no rlmLane → no chip (existing cards unchanged)');
    assert.strictEqual(_workerBadge({}), '', 'no worker → no chips at all');
    const both = _workerBadge({ worker: 'worker-A', rlmLane: 'rlm' });
    assert.ok(both.includes('agent-worker-a') && both.includes('agent-worker-rlm'),
      'a hypothetical worker+rlm event renders both chips');
    // multi-lane 单列 stream label: a laneTask-tagged worker event gets
    // the 「task」 chip; untagged events render no extra chip.
    assert.strictEqual(_laneTaskBadge({}), '', 'no laneTask → no chip (single-lane cards unchanged)');
    const laneChip = _laneTaskBadge({ laneTask: 'fix the build' });
    assert.ok(laneChip.includes('lane-task-badge') && laneChip.includes('fix the build'),
      'laneTask event renders the task chip');
  });

  // ── RLM hard implementation §5.2 — the mode-level UI surfaces ──────

  await t('app.js defines _updateRlmBadge (top-bar pill driven by state.rlmMode)', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _updateRlmBadge\s*\(/);
    assert.ok(body.includes("getElementById('rlm-mode-badge')"),
      '_updateRlmBadge must toggle #rlm-mode-badge (index.html pill)');
    assert.ok(/el\.hidden\s*=\s*!state\.rlmMode/.test(body),
      'badge visibility is driven by state.rlmMode');
    assert.ok(/rlm-mode-on/.test(body), 'badge carries the rlm-mode-on class when active');
    assert.ok(/RLM 模式/.test(body),
      'composer placeholder gains the · (RLM 模式) suffix while the mode is on');
  });

  await t('rlm-mode-changed handler calls _updateRlmBadge (live badge updates)', () => {
    const src = APP_SRC();
    const at = src.indexOf("msg.kind === 'rlm-mode-changed'");
    assert.ok(at >= 0, 'handler exists');
    const slice = src.slice(at, at + 700);
    assert.ok(slice.includes('_updateRlmBadge()'),
      'the state-update handler must re-render the badge (live /rlm on|off toggle)');
  });

  await t('index.html ships the #rlm-mode-badge pill element', () => {
    const html = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
    assert.ok(/id="rlm-mode-badge"/.test(html),
      'index.html must contain the rlm-mode-badge div (refresh-safe static markup)');
    // The pill starts hidden (mode is off by default). Match the actual
    // opening tag rather than a window around the first textual mention —
    // comments referencing #rlm-mode-badge (e.g. the topctl-row adopt
    // note, 2026-10-23 RLM-pill-on-the-row change) would otherwise fall
    // inside the old ±60/+120 slice and break the heuristic.
    const tag = html.match(/<div[^>]*id="rlm-mode-badge"[^>]*>/);
    assert.ok(tag && /\bhidden\b/.test(tag[0]),
      'the pill starts hidden (mode is off by default)');
  });

  await t('styles.css ships .rlm-badge (sidebar) + .rlm-mode-badge (top-bar) styles', () => {
    const css = CSS_SRC();
    assert.ok(/\.rlm-badge\s*\{/.test(css),
      'styles.css must style .rlm-badge (session-card chip fed by /sessions s.rlm)');
    assert.ok(/\.rlm-mode-badge\s*\{/.test(css),
      'styles.css must style .rlm-mode-badge (the in-chat top-bar pill)');
    assert.ok(/\.rlm-mode-badge\[hidden\]\s*\{/.test(css),
      'the [hidden] attribute must actually hide the pill (display:none override)');
  });

  await t('sidebar session card badges RLM sessions from s.rlm', () => {
    const src = APP_SRC();
    const at = src.indexOf('s.rlm');
    assert.ok(at >= 0, 'app.js must read s.rlm from the /sessions payload');
    const slice = src.slice(at - 80, at + 200);
    assert.ok(slice.includes('rlm-badge'),
      'the s.rlm flag must render a .rlm-badge chip on the session card');
  });

  await t('_resetUiForNewSession clears the RLM badge (no stale mode across sessions)', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _resetUiForNewSession\s*\(/);
    assert.ok(/state\.rlmMode\s*=\s*false/.test(body),
      'switching sessions must reset state.rlmMode (mode is per-session)');
    assert.ok(body.includes('_updateRlmBadge()'),
      'the reset must re-render the badge so the pill hides immediately');
  });

  // ── RLM switch + team view switch share ONE top-right row ──────────
  // User-reported: with the team view pill hidden, the RLM switch sat
  // alone under a blank band. Fix: both live in #chatpane-topctl-row.

  await t('index.html ships #chatpane-topctl-row before the RLM select', () => {
    const html = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
    const rowAt = html.indexOf('id="chatpane-topctl-row"');
    const selAt = html.indexOf('id="rlm-scope-select"');
    assert.ok(rowAt >= 0, 'index.html must contain the top-right control row container');
    assert.ok(selAt > rowAt, 'the RLM select must be declared after the row so _adoptRlmSwitchIntoTopRow can move it in');
  });

  await t('app.js adopts the RLM select into the row at boot', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _adoptRlmSwitchIntoTopRow\s*\(/);
    assert.ok(body.includes('_topctlRow()') && body.includes('row.appendChild(el)'),
      '_adoptRlmSwitchIntoTopRow must move #rlm-scope-select into #chatpane-topctl-row');
    assert.ok(/_adoptRlmSwitchIntoTopRow\(\)/.test(src),
      'init() must call the adoption so the switch lands in the row at boot');
  });

  await t('the row collapses when both controls are hidden (_refreshTopctlRow)', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _refreshTopctlRow\s*\(/);
    assert.ok(/some\(\(c\) => !c\.hidden\)/.test(body),
      '_refreshTopctlRow must show the row only when a child is visible (kills the blank band)');
    assert.ok(/row\.hidden\s*=\s*!anyVisible/.test(body),
      'the row hidden flag must track child visibility');
  });

  // The stream-mode floating pill (#team-float-toggle) was superseded by
  // the 布局: 单列/多列 dropdown (#team-mode-select) — peer's rework for
  // the same user request. The invariant that matters: the team view
  // switch, whatever its shape, must live INSIDE #chatpane-topctl-row.
  await t('team view switch (dropdown) appends into the row (no more absolute floating)', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _ensureTeamModeSelect\s*\(/);
    assert.ok(body.includes('_topctlRow()') && /insertBefore\(sel,\s*rlmSel\)/.test(body),
      'the 单列/多列 switch must be created inside #chatpane-topctl-row (same line as RLM switch, inserted AFTER the 🧠 pill / before the RLM select — the old insertBefore(row.firstChild) landed it LEFT of the margin-left:auto pill, shoving 布局 to the far-left edge: 2026-10-26 squeeze report)');
    assert.ok(body.includes('_refreshTopctlRow()'),
      'toggling the switch must refresh the row visibility');
    assert.ok(/sel\.hidden\s*=\s*!state\.teamView\.active/.test(body),
      'the switch is visible whenever the team view is active (both modes)');
  });

  await t('styles.css: row is an end-aligned flex strip; team switch is inline', () => {
    const css = CSS_SRC();
    assert.ok(/\.chatpane-topctl-row\s*\{[\s\S]*?justify-content:\s*flex-end/.test(css),
      'the row must right-align its controls (top-right strip)');
    assert.ok(/\.chatpane-topctl-row\[hidden\]\s*\{/.test(css),
      'the collapsed row must actually hide (display:none override)');
    const at = css.indexOf('.team-mode-select {');
    const block = at >= 0 ? css.slice(at, css.indexOf('}', at)) : '';
    assert.ok(!/position:\s*absolute/.test(block),
      'the team switch must NOT be position:absolute (inline in the row)');
  });

  // 4th user report (2026-10-22): "RLM下拉框太靠上了，被上面的图标都挡住了，
  // 上边界距离文件夹和首页等图标所在行的下边界10px，把RLM下拉框放在最右边" —
  // the row must sit BELOW the fixed chrome icon cluster with a 10px top
  // gap, and the RLM select must be the RIGHTMOST control (no
  // chrome-cluster width reservation pushing it left).

  await t('styles.css: row sits 10px below the icon band (not inside it)', () => {
    const css = CSS_SRC();
    const at = css.indexOf('.chatpane-topctl-row {');
    assert.ok(at >= 0, 'the topctl row block must exist in styles.css');
    const block = css.slice(at, css.indexOf('\n}', at));
    assert.ok(!/margin-top:\s*calc\(-/.test(block) && !/-1 \* \(env/.test(block),
      'the negative margin-top that pulled the row INTO the fixed icon band (遮挡) must stay gone');
    assert.ok(!/min-height:\s*var\(--pane-header-h\)/.test(block),
      'no min-height band — the row is a slim strip below the icons, not a same-band overlay');
    assert.ok(/margin:\s*0(\s+0)?\s+10px\s+0\s*;/.test(block) || /margin:\s*0\s*;/.test(block),
      'margin 0 (top) — the row starts at the chatpane padding edge (safe+strip+52px) which is exactly 10px below the icons\' bottom edge (safe+strip+42px). A 10px margin-BOTTOM spacing from the chat content below (2026-10-23 layout polish) is also accepted.');
    assert.ok(!/padding[^;]*5 \* \(var\(--chrome-btn-size\) \+ 8px\)/.test(block),
      'no 5-button width reservation on the right — the dropdowns must reach the far right edge');
    assert.ok(/justify-content:\s*flex-end/.test(block),
      'row right-aligns its children so the last child sits flush right');
    assert.ok(/padding:\s*0 calc\(env\(safe-area-inset-right, 0px\) \+ 10px\) 0 0/.test(block),
      'only a 10px right inset remains — the RLM select is the rightmost control');
  });

  await t('app.js: RLM select stays the rightmost child of the row', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _ensureTeamModeSelect\s*\(/);
    assert.ok(/insertBefore\(sel,\s*rlmSel\)/.test(body) && !/insertBefore\(sel,\s*row\.firstChild\)/.test(body),
      'the team 布局 select must be inserted before the RLM select but AFTER the 🧠 pill (never at row.firstChild — the pill\'s margin-left:auto isolates anything to its left at the far-left edge) so #rlm-scope-select stays rightmost');
    const adopt = fnBody(src, /function _adoptRlmSwitchIntoTopRow\s*\(/);
    assert.ok(adopt.includes('row.appendChild(el)'),
      '_adoptRlmSwitchIntoTopRow keeps appending the RLM select (rightmost at boot)');
  });

  // ── task req c (2026-10-23): RLM usage stats surfacing ──────────────
  await t('app.js handles kind:\'rlm-stats\' and stores state.rlmStats', () => {
    const src = APP_SRC();
    const at = src.indexOf("msg.kind === 'rlm-stats'");
    assert.ok(at >= 0, 'rlm-stats state-update handler exists');
    const slice = src.slice(at, at + 400);
    assert.ok(slice.includes('state.rlmStats = msg.stats'),
      'handler must stash the stats payload in state.rlmStats');
    assert.ok(slice.includes('_updateRlmStatsBadge()'),
      'handler must refresh the badge tooltip');
  });

  await t('_updateRlmStatsBadge renders trigger counts + saved context in the pill tooltip', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _updateRlmStatsBadge\s*\(/);
    assert.ok(body.includes("getElementById('rlm-mode-badge')"),
      'stats readout targets the same 🧠 pill');
    assert.ok(/evalCalls/.test(body) && /spawns/.test(body) && /collects/.test(body),
      'tooltip names the three RLM trigger counts (kernel calls / sub-agents / collects)');
    assert.ok(/savedChars/.test(body),
      'tooltip reports the estimated context saved');
  });

  await t('attach.js replays kind:\'rlm-stats\' on initial attach', () => {
    const attachSrc = fs.readFileSync(path.join(ROOT, 'server/src/attach.js'), 'utf8');
    const at = attachSrc.indexOf("kind: 'rlm-stats'");
    assert.ok(at >= 0, 'attach snapshot ships rlm-stats so refresh/device-switch repopulates the tooltip');
    const slice = attachSrc.slice(Math.max(0, at - 600), at + 200);
    assert.ok(slice.includes('agents/rlm/stats'),
      'the frame is fed by the agents/rlm/stats module');
  });

  await t('stats.js logs with the stable [rlm-stats] prefix (diag-loop filter contract)', () => {
    const statsSrc = fs.readFileSync(path.join(ROOT, 'server/src/agents/rlm/stats.js'), 'utf8');
    assert.ok(statsSrc.includes('[rlm-stats]'),
      'log marker keeps the bracketed-prefix convention (CLAUDE.md Diagnostics §3)');
    assert.ok(/savedChars/.test(statsSrc) && /Math\.max\(0/.test(statsSrc),
      'savedChars estimator is floored at 0');
  });

  // ── 2026-10-29 user report: RLM dropdown/state mismatch + fixed-area
  // stats readout (任务 2/3). The mode flip must sync BOTH the pill AND
  // the dropdown, and the stats must be VISIBLE in a fixed area, not
  // hover-only.
  await t('rlm-mode-changed handler syncs the dropdown too (dropdown/state mismatch fix)', () => {
    const src = APP_SRC();
    const at = src.indexOf("msg.kind === 'rlm-mode-changed'");
    assert.ok(at >= 0, 'handler exists');
    const slice = src.slice(at, at + 900);
    assert.ok(slice.includes('_updateRlmBadge()'),
      'the pill still updates on mode flip (existing contract)');
    assert.ok(slice.includes('_refreshRlmSwitch()'),
      'the #rlm-scope-select dropdown MUST re-sync on every mode flip — this was the 2026-10-29 dropdown/state mismatch (下拉框和状态对不上)');
  });

  await t('_refreshRlmSwitch reads state.rlmMode (value = session when on)', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _refreshRlmSwitch\s*\(/);
    assert.ok(/el\.value\s*=\s*state\.rlmMode\s*\?\s*'session'\s*:\s*'off'/.test(body),
      'the dropdown value must be driven by state.rlmMode (开 ↔ 关)');
  });

  await t('index.html ships the #rlm-stats-chip fixed-area element', () => {
    const html = fs.readFileSync(path.join(ROOT, 'web/public/index.html'), 'utf8');
    const tag = html.match(/<div[^>]*id="rlm-stats-chip"[^>]*>/);
    assert.ok(tag, 'index.html must declare #rlm-stats-chip (fixed-area stats readout)');
    assert.ok(/\bhidden\b/.test(tag[0]),
      'the chip starts hidden (visible only while RLM mode is on)');
  });

  await t('_renderRlmStatsChip renders counts into the fixed area (not tooltip-only)', () => {
    const src = APP_SRC();
    const body = fnBody(src, /function _renderRlmStatsChip\s*\(/);
    assert.ok(body.includes("getElementById('rlm-stats-chip')"),
      'the renderer targets #rlm-stats-chip');
    assert.ok(/chip\.textContent\s*=/.test(body),
      'counts render as visible TEXT in the fixed chip (the 2026-10-29 request: 固定区域让人看到省了多少上下文)');
    assert.ok(/evalCalls/.test(body) && /spawns/.test(body) && /collects/.test(body),
      'chip shows REPL 内核触发 / 子代理 spawn / 回收 collects');
    assert.ok(/evolved/.test(body),
      'chip shows the Continual Harness 进化 count (stats.evolved)');
    assert.ok(/savedChars/.test(body),
      'chip shows the estimated saved context (节省上下文)');
    assert.ok(/!state\.rlmMode/.test(body),
      'chip hides when RLM mode is off (stats without the mode are meaningless)');
  });

  await t('rlm-stats handler + _resetUiForNewSession drive the fixed chip', () => {
    const src = APP_SRC();
    const at = src.indexOf("msg.kind === 'rlm-stats'");
    const slice = src.slice(at, at + 400);
    assert.ok(slice.includes('_updateRlmStatsBadge()'),
      'rlm-stats handler must refresh the stats surfaces');
    const upd = fnBody(src, /function _updateRlmStatsBadge\s*\(/);
    assert.ok(upd.includes('_renderRlmStatsChip()'),
      '_updateRlmStatsBadge must also render the fixed chip (not just the tooltip)');
    const reset = fnBody(src, /function _resetUiForNewSession\s*\(/);
    assert.ok(/state\.rlmStats\s*=\s*null/.test(reset),
      'switching sessions must clear the PER-SESSION stats (no cross-session leak)');
    assert.ok(reset.includes('_renderRlmStatsChip()'),
      'the reset must hide the chip for the new session until fresh stats land');
  });

  await t('styles.css ships the .rlm-stats-chip style (fixed-area chip visible + hidden)', () => {
    const css = CSS_SRC();
    assert.ok(/\.rlm-stats-chip\s*\{/.test(css),
      'the fixed stats chip must be styled');
    assert.ok(/\.rlm-stats-chip\[hidden\]\s*\{/.test(css),
      '[hidden] must actually hide the chip');
  });

  // ── Continual Harness evolution counter (进化次数, 2026-10-29). The UI
  // reads stats.evolved — the server must actually count rlm.addPrompt
  // additions, or the fixed chip's 进化 readout is frozen at 0.
  await t('stats.js counts Continual Harness evolutions (evolved in getStats)', () => {
    const statsPath = path.join(ROOT, 'server/src/agents/rlm/stats.js');
    delete require.cache[require.resolve(statsPath)];
    const stats = require(statsPath);
    const sid = 'ui-test-evolve-' + Date.now();
    assert.strictEqual(stats.getStats(sid).evolved, 0,
      'fresh session must report evolved: 0 (no undefined leaking into the UI)');
    stats.recordEvolution(sid, 42);
    const s = stats.getStats(sid);
    assert.strictEqual(s.evolved, 1,
      'recordEvolution must bump the evolved counter the UI chip renders');
    assert.ok(String(stats.statsLine(sid)).includes('1 次进化'),
      'the /rlm status reply line must surface the evolution count');
    stats.dropSession(sid);
  });

  await t('host.js records an evolution on every rlm.add_prompt', () => {
    const hostSrc = fs.readFileSync(path.join(ROOT, 'server/src/agents/rlm/host.js'), 'utf8');
    const at = hostSrc.indexOf("'rlm.add_prompt'");
    assert.ok(at >= 0, 'rlm.add_prompt handler exists in host.js');
    // slice to the end of the enclosing switch block via the column-0
    // `}` convention (test/_lib/fn-body) — a fixed 600-char window breaks
    // every time the handler gains a comment (CLAUDE.md §10b anti-pattern;
    // the /run-explore harnessKey plumbing tripped it).
    const { sliceFn } = require('./_lib/fn-body');
    const body = sliceFn(hostSrc, at);
    assert.ok(body.includes("require('./stats').recordEvolution"),
      'the add_prompt handler must feed the stats evolved counter (fixed chip 进化 readout)');
  });

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
