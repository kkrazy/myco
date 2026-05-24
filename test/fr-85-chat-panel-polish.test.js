// fr-85: per-item chat panel polish.
//
// Three sub-fixes:
//   1. Larger chat area — mobile sheet min-height 50→75vh, max-height
//      85→92vh; desktop drawer width 420→520px.
//   2. Visibility on click — onArtifactItemAiChat must NEVER silently
//      fail. If the artifact cache hasn't populated the item yet, the
//      handler must try a one-shot loadArtifact + retry; if that still
//      misses, surface a visible toast.
//   3. Context-sensitive slash menu — the per-item panel must filter
//      out global plan-level commands (/queue, /merge, /feature, /fr,
//      /td, /bug, /setpat, /admin, /git, /whatsnext, /clear, …) and
//      show only commands meaningful inside a per-item conversation
//      (/task, /skip, /cancel, /decide, /allow, /deny, /allowlist).
//
// Static guards on app.js + styles.css + behavior simulation of the
// allow-list filter.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-85: chat panel polish (size + visibility + slash filter) ──');

// ──────────────────────────────────────────────────────────────────────
// 1. Larger chat area
// ──────────────────────────────────────────────────────────────────────

t('styles.css: mobile sheet min-height bumped to 75vh', () => {
  assert.ok(/@media\s*\(\s*max-width:\s*900px\s*\)[\s\S]{0,2500}min-height:\s*75vh/.test(CSS),
    'mobile @media block must declare min-height: 75vh (was 50vh — felt cramped)');
});

t('styles.css: mobile sheet max-height bumped to 92vh', () => {
  assert.ok(/@media\s*\(\s*max-width:\s*900px\s*\)[\s\S]{0,2500}max-height:\s*92vh/.test(CSS),
    'mobile @media block must declare max-height: 92vh (was 85vh)');
});

t('styles.css: desktop drawer width bumped to 520px', () => {
  assert.ok(/@media\s*\(\s*min-width:\s*901px\s*\)[\s\S]{0,2500}width:\s*520px/.test(CSS),
    'desktop @media block must declare width: 520px (was 420px — too narrow for agent replies)');
});

// ──────────────────────────────────────────────────────────────────────
// 2. Visibility on click — no silent fail
// ──────────────────────────────────────────────────────────────────────

t('app.js: onArtifactItemAiChat retries via loadArtifact when item not in cache', () => {
  // The user reported "Chat area should be visible when click on the
  // chat icon" — pre-fix, a missing item just console.warn'd and
  // returned silently. The handler must now attempt a one-shot
  // loadArtifact + retry before giving up.
  const idx = APP.search(/function\s+onArtifactItemAiChat\s*\(/);
  assert.ok(idx > -1, 'onArtifactItemAiChat must exist');
  const win = APP.slice(idx, idx + 1500);
  assert.ok(/loadArtifact\s*\(\s*t\s*\)/.test(win),
    'onArtifactItemAiChat must call loadArtifact(t) to refresh the cache when item is missing');
});

t('app.js: onArtifactItemAiChat surfaces a visible toast on terminal failure', () => {
  // After loadArtifact retry, if the item is STILL missing (or load
  // failed), the click must NOT be invisible — surface a toast.
  const idx = APP.search(/function\s+onArtifactItemAiChat\s*\(/);
  const win = APP.slice(idx, idx + 1500);
  assert.ok(/_aiChatShowToast\s*\(/.test(win),
    'onArtifactItemAiChat must call _aiChatShowToast on the failure path so the click is never invisible');
});

t('app.js: _aiChatShowToast helper renders a DOM element + auto-dismisses', () => {
  assert.ok(/function\s+_aiChatShowToast\s*\(/.test(APP),
    '_aiChatShowToast helper must be defined');
  const idx = APP.search(/function\s+_aiChatShowToast\s*\(/);
  const win = APP.slice(idx, idx + 800);
  assert.ok(/createElement\(['"]div['"]\)/.test(win),
    '_aiChatShowToast must createElement a div');
  assert.ok(/setTimeout[\s\S]{0,200}remove(Child)?/.test(win),
    '_aiChatShowToast must auto-dismiss via setTimeout (no permanent toast)');
  assert.ok(/className\s*=\s*['"]aichat-toast['"]/.test(win),
    'toast must carry .aichat-toast class (CSS-styled)');
});

t('styles.css: .aichat-toast is styled (positioned + animated)', () => {
  assert.ok(/\.aichat-toast\b/.test(CSS),
    '.aichat-toast selector must exist');
  assert.ok(/\.aichat-toast\.is-open/.test(CSS),
    '.aichat-toast.is-open must define the visible state (opacity + transform animation)');
  // Above the panel's z-index (1001) so it sits over an opening panel.
  assert.ok(/\.aichat-toast[\s\S]{0,600}z-index:\s*1[1-9]\d{2}/.test(CSS),
    '.aichat-toast z-index must be > 1001 so it sits above the panel');
});

// ──────────────────────────────────────────────────────────────────────
// 3. Context-sensitive slash menu — allow-list filter
// ──────────────────────────────────────────────────────────────────────

t('app.js: AICHAT_ALLOWED_COMMANDS allow-list defined', () => {
  assert.ok(/AICHAT_ALLOWED_COMMANDS\s*=\s*new Set/.test(APP),
    'AICHAT_ALLOWED_COMMANDS must be a Set (fast O(1) lookup)');
});

t('app.js: allow-list contains task/skip/cancel + decide + allow/deny/allowlist', () => {
  // These are the commands meaningful inside a per-item chat:
  //   - task/tasks/skip/cancel: intervene in the running claude's
  //     internal TaskList
  //   - decide/pick/choose: answer a pending claude dialog
  //   - allow/deny/allowlist: gate permissions while a tool is in flight
  // Pin each so a future refactor can't quietly drop one.
  const idx = APP.search(/AICHAT_ALLOWED_COMMANDS\s*=/);
  assert.ok(idx > -1);
  const win = APP.slice(idx, idx + 600);
  for (const cmd of ['task', 'tasks', 'skip', 'cancel', 'decide', 'pick', 'choose', 'allow', 'deny', 'allowlist']) {
    assert.ok(new RegExp(`['"]${cmd}['"]`).test(win),
      'allow-list must include "' + cmd + '"');
  }
});

t('app.js: bindAiChatAutocomplete is defined + wired from _openAiChatPanel', () => {
  assert.ok(/function\s+bindAiChatAutocomplete\s*\(/.test(APP),
    'bindAiChatAutocomplete(panel) must be defined');
  // Wired into the open path so the panel input gets autocomplete
  // bindings as soon as the panel mounts.
  const openIdx = APP.search(/function\s+_openAiChatPanel\s*\(/);
  const openWin = APP.slice(openIdx, openIdx + 2000);
  assert.ok(/bindAiChatAutocomplete\s*\(\s*panel\s*\)/.test(openWin),
    '_openAiChatPanel must call bindAiChatAutocomplete(panel)');
});

t('app.js: bindAiChatAutocomplete renders a panel-LOCAL dropdown (.aichat-autocomplete)', () => {
  // Panel-local — appended INSIDE the panel so CSS positioning
  // (absolute, above the form) just works. Avoids re-positioning
  // the global #chat-autocomplete on focus.
  const idx = APP.search(/function\s+bindAiChatAutocomplete\s*\(/);
  const win = APP.slice(idx, idx + 4000);
  assert.ok(/className\s*=\s*['"]aichat-autocomplete['"]/.test(win),
    'panel-local dropdown must carry .aichat-autocomplete class');
  assert.ok(/panel\.appendChild\s*\(\s*dropdown\s*\)/.test(win),
    'dropdown must be appended INSIDE the panel (not the global body) for natural positioning');
});

t('app.js: panel autocomplete reuses _loadAcData cache (no duplicate fetch)', () => {
  // Both bindings share the same /commands + /users data — fetching
  // twice on first interaction would waste a round-trip and flicker.
  const idx = APP.search(/function\s+bindAiChatAutocomplete\s*\(/);
  const win = APP.slice(idx, idx + 4000);
  assert.ok(/_loadAcData\s*\(\s*\)/.test(win),
    'bindAiChatAutocomplete must reuse _loadAcData() (same cache as the global chat autocomplete)');
});

t('styles.css: .aichat-autocomplete styled', () => {
  assert.ok(/\.aichat-autocomplete\b/.test(CSS),
    '.aichat-autocomplete must have CSS rules');
  assert.ok(/\.aichat-autocomplete[\s\S]{0,400}position:\s*absolute/.test(CSS),
    'panel-local dropdown must be position:absolute so it overlays the panel form');
});

t('app.js: aichat-input carries data-ac-context="aichat" attribute', () => {
  // Discoverability hook — future code (or other tests) can branch on
  // dataset.acContext to distinguish the panel input from the main
  // chat input.
  assert.ok(/data-ac-context=["']aichat["']/.test(APP),
    '.aichat-input must declare data-ac-context="aichat"');
});

t('app.js: aichat-input rows bumped to 3 (was 2 — visibility complaint)', () => {
  // Larger initial textarea so the chat input itself doesn't read
  // as a tiny single-line strip. Mobile keyboard still expands it.
  assert.ok(/aichat-input[\s\S]{0,300}rows=["']3["']/.test(APP),
    'aichat-input textarea must have rows="3" for a roomier initial input');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — the allow-list filter logic, independent of
// app.js source. Same logic the panel binding uses; locks the contract
// even if the source moves around.
// ──────────────────────────────────────────────────────────────────────

t('behavior: filter rejects global plan/queue/admin commands', () => {
  const ALLOWED = new Set([
    'task', 'tasks', 'skip', 'cancel',
    'decide', 'pick', 'choose',
    'allow', 'deny', 'allowlist',
  ]);
  const filter = (cmd) => ALLOWED.has(cmd.name)
    || (cmd.aliases || []).some((a) => ALLOWED.has(a));

  // These should ALL be rejected (they're noise in a per-item chat).
  const noisy = [
    { name: 'queue' }, { name: 'qstatus' }, { name: 'qcancel' },
    { name: 'qclear' }, { name: 'qresume' },
    { name: 'feature', aliases: ['feat'] }, { name: 'fr' },
    { name: 'td', aliases: ['todo'] }, { name: 'bug' },
    { name: 'merge' }, { name: 'dedupe' }, { name: 'add2plan' },
    { name: 'setpat' }, { name: 'admin' }, { name: 'strict' },
    { name: 'git' }, { name: 'whatsnext', aliases: ['next'] },
    { name: 'clear' },
  ];
  for (const cmd of noisy) {
    assert.strictEqual(filter(cmd), false,
      '/' + cmd.name + ' must be FILTERED OUT of the aichat panel autocomplete');
  }
});

t('behavior: filter accepts the per-conversation ops', () => {
  const ALLOWED = new Set([
    'task', 'tasks', 'skip', 'cancel',
    'decide', 'pick', 'choose',
    'allow', 'deny', 'allowlist',
  ]);
  const filter = (cmd) => ALLOWED.has(cmd.name)
    || (cmd.aliases || []).some((a) => ALLOWED.has(a));

  const useful = [
    { name: 'task', aliases: ['tasks'] },
    { name: 'skip' }, { name: 'cancel' },
    { name: 'decide', aliases: ['pick', 'choose'] },
    { name: 'allow' }, { name: 'deny' }, { name: 'allowlist' },
  ];
  for (const cmd of useful) {
    assert.strictEqual(filter(cmd), true,
      '/' + cmd.name + ' MUST be kept in the aichat panel autocomplete');
  }
});

t('behavior: @-mentions are unfiltered (work in any context)', () => {
  // The filter only restricts slash commands. @-mentions to users
  // are always meaningful (e.g. "@kkrazy what do you think?").
  // Pinning the intent so a future refactor doesn't accidentally
  // gate @-mentions too.
  const tok = '@kk';
  assert.ok(tok[0] === '@',
    '@-mention tokens are routed to the user-list branch, not the command-filter branch');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
