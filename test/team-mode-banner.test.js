// team-mode-banner — 2026-10-28 UX fix for the user report
// "单、多列切换的内容不太好理解，不知道在哪里看进展".
//
// The 布局 dropdown (#team-mode-select) only named the mode; nothing in
// the chatpane explained WHAT each mode shows or WHERE run progress
// (看板) lives, and the live progress numbers were buried inside the
// mode-specific surfaces (split 看板 column / 单列 board card) so a user
// who didn't know where to look saw nothing at all.
//
// The fix adds #team-mode-banner (index.html, under #chat-empty):
//   1. a one-line explainer for the CURRENT mode (单列 = merged timeline
//      with worker 徽章 + inline 看板 card; 多列 = one column per worker +
//      the 看板 column),
//   2. the live 看板进展 done/total counter computed from the lane
//      registry (same source the split rows / stream cards render from),
//   3. a "右上「布局」下拉切换" hint so the switch control is discoverable.
//
// Render path: _renderTeamModeBanner() is called from _applyTeamViewMode
// (every mode change), the kind:'board' handler (progress refresh) and
// _handleTeamInfoFrame (attach seed); _teardownTeamSplit hides + clears
// it on session switch so it can't leak into a non-team session.
//
// Static source-shape assertions per the repo's UI regression convention.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'web', 'public', 'app.js');
const CSS = path.join(__dirname, '..', 'web', 'public', 'styles.css');
const HTML = path.join(__dirname, '..', 'web', 'public', 'index.html');
const appJs = fs.readFileSync(APP, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ ' + name + '\n    ' + (err && err.message)); }
}

function main() {
  console.log('── team-mode-banner: 布局切换有解释横幅 + 看板进展可见 ──');

  t('index.html declares the banner node (hidden by default)', () => {
    assert.ok(/id="team-mode-banner"/.test(html),
      '#team-mode-banner must exist in index.html (declared hidden; content is JS-rendered)');
    assert.ok(/class="team-mode-banner"/.test(html),
      'banner carries the .team-mode-banner class for styling');
  });

  t('_renderTeamModeBanner exists and is team-view-scoped', () => {
    const m = appJs.match(/function _renderTeamModeBanner\s*\(/);
    assert.ok(m, 'renderer function must exist');
    const body = m ? appJs.slice(m.index) : '';
    assert.ok(/el\.hidden = !active/.test(body),
      'banner must hide outside team sessions (a plain session has no 布局 mode)');
    assert.ok(/state\.teamView\.active/.test(body),
      'visibility keyed on team-view active');
  });

  t('banner explains BOTH modes (单列 merged stream / 多列 per-worker columns)', () => {
    const m = appJs.match(/function _renderTeamModeBanner\s*\(/);
    const body = appJs.slice(m.index, appJs.indexOf('\n}', m.index));
    assert.ok(/单列/.test(body) && /多列/.test(body),
      'explainer text must cover both modes');
    assert.ok(/合并/.test(body) && /独立一列/.test(body),
      '单列 = merged timeline; 多列 = per-worker columns — the WHAT of each mode');
    assert.ok(/worker 徽章|彩色徽章/.test(body),
      '单列 explanation must say the worker badge distinguishes who is speaking');
  });

  t('banner shows the live 看板进展 done/total counter', () => {
    const m = appJs.match(/function _renderTeamModeBanner\s*\(/);
    const body = appJs.slice(m.index, appJs.indexOf('\n}', m.index));
    assert.ok(/_teamLanesList\(\)/.test(body),
      'progress computed from the lane registry (authoritative board source)');
    assert.ok(/state === 'done'/.test(body) && /totalN/.test(body) && /doneN/.test(body),
      'done/total counts derived from the per-lane board queues');
    assert.ok(/看板进展/.test(body),
      'the counter is labelled so the user knows what the numbers mean');
    assert.ok(/endedLanes/.test(body),
      'retired lanes are excluded — a finished run must not pollute the counter');
  });

  t('banner names the switch affordance (右上「布局」下拉)', () => {
    const m = appJs.match(/function _renderTeamModeBanner\s*\(/);
    const body = appJs.slice(m.index, appJs.indexOf('\n}', m.index));
    assert.ok(/布局/.test(body) && /下拉/.test(body),
      'hint must point at the 布局 dropdown so switching is discoverable');
  });

  t('_applyTeamViewMode refreshes the banner on every mode change', () => {
    const m = appJs.match(/function _applyTeamViewMode\s*\(/);
    const body = appJs.slice(m.index, appJs.indexOf('\n}', m.index));
    assert.ok(/_renderTeamModeBanner\(\)/.test(body),
      'mode toggle must repaint the explainer (dropdown label alone is not enough)');
  });

  t('board frames refresh the banner counter (progress stays live)', () => {
    const m = appJs.match(/if \(msg\.kind === 'board'\) \{/);
    assert.ok(m, 'board handler exists');
    const body = appJs.slice(m.index, appJs.indexOf('\n  }\n', m.index));
    assert.ok(/_renderTeamModeBanner\(\)/.test(body),
      'a claim/done must bump the banner counter at the top of the pane');
  });

  t('team-info attach seeds the banner (fresh device sees the explainer)', () => {
    const m = appJs.match(/function _handleTeamInfoFrame\s*\(/);
    const body = appJs.slice(m.index, appJs.indexOf('\n}', m.index));
    assert.ok(/_renderTeamModeBanner\(\)/.test(body),
      'attach carries lane roster + board snapshot — banner must render then too');
  });

  t('_teardownTeamSplit hides + clears the banner on session switch', () => {
    const m = appJs.match(/function _teardownTeamSplit\s*\(/);
    const body = appJs.slice(m.index, appJs.indexOf('\n}', m.index));
    assert.ok(/team-mode-banner/.test(body),
      'teardown must address #team-mode-banner (no stale 协同布局 banner in a non-team session)');
    assert.ok(/banner\.hidden = true/.test(body),
      'teardown must hide it (hidden=false would leak the banner across sessions)');
  });

  t('the 布局 dropdown title cross-references the banner', () => {
    assert.ok(/切换后横幅说明当前模式与进展/.test(appJs),
      'the dropdown tooltip should tell the user the banner explains the modes');
  });

  t('styles: .team-mode-banner family exists and [hidden] hides it', () => {
    assert.ok(/\.team-mode-banner\s*\{/.test(css), 'banner base rule must exist');
    assert.ok(/\.team-mode-banner\[hidden\]\s*\{/.test(css),
      '[hidden] must actually hide the banner');
    for (const cls of ['.tmb-label', '.tmb-text', '.tmb-hint']) {
      assert.ok(css.includes(cls + ' {') || css.includes(cls + '{'),
        `CSS rule for ${cls} must exist`);
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
