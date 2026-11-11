// team-mode-ux: 2026-10-28 用户反馈「单、多列切换的内容不太好理解，
// 不知道在哪里看进展」regression lock.
//
// The fix has three surfaces, all in web/public:
//   1. #team-mode-select options self-explain (what each layout SHOWS),
//      not just name the mode.
//   2. A transient toast (_showTeamModeToast) confirms a layout switch and
//      tells the user WHERE progress lives in the new layout.
//   3. Persistent toolbar readouts (_updateTeamToolbarReadouts): a 布局
//      chip + an aggregate 「进度: n/m 子任务完成 · k 个任务运行中」line,
//      refreshed on every mode apply AND every board snapshot, so progress
//      has a fixed home in BOTH layouts.
//
// This test locks the source shapes (function-slice + string assertions —
// the repo's static-guard convention, cf. team-default-stream.test.js).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const CSS = path.join(__dirname, '..', 'web', 'public', 'styles.css');
const HTML = path.join(__dirname, '..', 'web', 'public', 'index.html');
const src = fs.readFileSync(APP, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

function fnBody(name) {
  const at = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  assert.ok(at >= 0, 'function ' + name + ' must exist in app.js');
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, 'function ' + name + ' must have a body');
  return src.slice(at, end + 2);
}

function main() {
  console.log('── 单/多列切换展示体验 (team-mode-ux) ──');

  t('dropdown options are SHORT (布局 select must not widen the topctl row)', () => {
    const body = fnBody('_ensureTeamModeSelect');
    // 2026-10-28 用户反馈: "单列双列下拉框名字也太长了" — the explanatory
    // option text (每个 worker 一列，带共享看板…) made the select itself
    // too wide. The WHAT/WHERE explanation now lives in the tooltip, the
    // banner, and the toast — the options stay bare-short 多列/单列.
    assert.ok(/option value="split">[^<]*多列<\/option>/.test(body),
      'split option must be the short ◫ 多列 label (no trailing explainer)');
    assert.ok(/option value="stream">[^<]*单列<\/option>/.test(body),
      'stream option must be the short ▤ 单列 label (no trailing explainer)');
    assert.ok(!/多列 —/.test(body) && !/单列 —/.test(body),
      'option labels must NOT carry the long dash-explainer suffix');
    // Tooltip describing the semantics survives for hover affordance.
    assert.ok(/sel\.title\s*=\s*'视图布局/.test(body),
      'select must carry a 视图布局 tooltip');
  });

  t('switching fires a confirmation toast naming where progress lives', () => {
    const body = fnBody('_showTeamModeToast');
    assert.ok(/team-mode-toast/.test(body), 'toast element id must be team-mode-toast');
    assert.ok(/已切换到多列视图/.test(body) && /已切换到单列视图/.test(body),
      'toast must confirm WHICH layout it switched to (both branches)');
    assert.ok(/看板/.test(body) && /时间流/.test(body),
      'toast must tell the user where progress lives in each layout');
    assert.ok(/setTimeout/.test(body), 'toast must auto-dismiss (transient, not sticky)');
  });

  t('_setTeamViewMode passes showToast so the toast only fires on USER toggles', () => {
    const body = fnBody('_setTeamViewMode');
    assert.ok(/_applyTeamViewMode\(true\)/.test(body),
      'user dropdown pick must trigger the toast (apply(true))');
  });

  t('_applyTeamViewMode refreshes the toolbar readouts on every apply', () => {
    const body = fnBody('_applyTeamViewMode');
    assert.ok(/_updateTeamToolbarReadouts\(\)/.test(body),
      'readouts must refresh on every mode apply (session switch + toggle)');
    assert.ok(/showToast\)\s+_showTeamModeToast/.test(body),
      'apply(showToast) must gate the toast');
  });

  t('toolbar hosts persistent 布局 + 进度 readouts (DOM)', () => {
    const body = fnBody('_ensureTeamSplitDom');
    assert.ok(/team-toolbar-mode/.test(body),
      '#team-toolbar-mode chip must be created in the team toolbar');
    assert.ok(/team-toolbar-progress/.test(body),
      '#team-toolbar-progress chip must be created in the team toolbar');
  });

  t('_updateTeamToolbarReadouts aggregates board progress across lanes', () => {
    const body = fnBody('_updateTeamToolbarReadouts');
    assert.ok(/team-toolbar-mode/.test(body) && /team-toolbar-progress/.test(body),
      'readout function must target both toolbar chips');
    assert.ok(/state\.teamView\.mode === 'split'/.test(body),
      '布局 chip must mirror the active mode');
    assert.ok(/board\.queue/.test(body) && /state === 'done'/.test(body),
      '进度 chip must count done vs total queue items');
    assert.ok(/子任务完成/.test(body) && /运行中/.test(body),
      '进度 text must state done/total 子任务 + running lanes');
  });

  t('board snapshots refresh the 进度 readout (live progress)', () => {
    // The kind:'board' handler in _applyStateUpdate must refresh the
    // readouts — otherwise 进度 only updates on layout toggles.
    const at = src.search(/function _applyStateUpdate\s*\(/);
    assert.ok(at >= 0, '_applyStateUpdate must exist');
    const win = src.slice(at, at + 22000);
    const boardAt = win.indexOf("msg.kind === 'board'");
    assert.ok(boardAt >= 0, "kind:'board' branch must exist in _applyStateUpdate");
    const boardBlock = win.slice(boardAt, boardAt + 3000);
    assert.ok(/_updateTeamToolbarReadouts\(\)/.test(boardBlock),
      "kind:'board' handler must refresh the toolbar readouts (live progress)");
  });

  t('lane retirement also refreshes the readouts (no stale 进度)', () => {
    const body = fnBody('_retireTeamLane');
    assert.ok(/_updateTeamToolbarReadouts\(\)/.test(body),
      '_retireTeamLane must drop the retired lane from the 进度 aggregate');
  });

  t('styles.css: readout chips + toast styled, toast never blocks input', () => {
    assert.ok(/\.team-toolbar-mode\s*\{/.test(css), '布局 chip styled');
    assert.ok(/\.team-toolbar-progress\s*\{/.test(css), '进度 chip styled');
    assert.ok(/\.team-toolbar-progress:empty/.test(css),
      'empty 进度 chip must collapse (no blank band when nothing is running)');
    assert.ok(/\.team-mode-toast\s*\{/.test(css), 'toast styled');
    const at = css.indexOf('.team-mode-toast {');
    const block = css.slice(at, css.indexOf('}', at));
    assert.ok(/pointer-events:\s*none/.test(block),
      'toast must be pointer-events:none so it never blocks the composer');
  });

  t('index.html cache busters bumped for app.js + styles.css', () => {
    // Stale-cache guard: the changed assets must not be served from an
    // old ?v= URL, otherwise the user never sees the fix.
    const mCss = html.match(/styles\.css\?v=(\d+)/);
    const mJs = html.match(/app\.js\?v=(\d+)/);
    assert.ok(mCss, 'styles.css must carry a ?v= cache buster');
    assert.ok(mJs, 'app.js must carry a ?v= cache buster');
    assert.ok(Number(mCss[1]) >= 286, 'styles.css buster bumped to ≥286, got ' + mCss[1]);
    assert.ok(Number(mJs[1]) >= 264, 'app.js buster bumped to ≥264, got ' + mJs[1]);
  });

  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

main();
