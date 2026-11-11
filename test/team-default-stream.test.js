// team-default-stream: 2026-10-23 run-n2 default-单列 regression.
//
// User report: 「run-n2默认展示为单列」— the /run-n2 lane (and every team
// view) must OPEN in the 单列 (stream) layout by default. Pre-fix the
// no-preference fallback in _resetUiForNewSession was 'split', so a fresh
// browser / cleared localStorage dropped the user straight into the 多列
// columns and the 单列 history-print regression (see
// team-stream-reattach.test.js) surfaced on every such first attach.
//
// The fix: the localStorage read now honours an EXPLICIT saved choice
// ('stream' | 'split') but falls back to 'stream' when the key is absent
// (or localStorage throws). The initial state literal at boot mirrors the
// same default so the very first session (before any
// _resetUiForNewSession) is also 单列-first.
//
// This test locks the source shapes (function-slice assertions — the
// repo's static-guard convention, cf. team-stream-reattach.test.js).

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

function fnBody(name) {
  const at = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  assert.ok(at >= 0, 'function ' + name + ' must exist in app.js');
  const end = src.indexOf('\n}', at);
  assert.ok(end > at, 'function ' + name + ' must have a body');
  return src.slice(at, end + 2);
}

function main() {
  console.log('── run-n2 defaults to 单列 (team-default-stream) ──');

  t('_resetUiForNewSession honours a saved preference but defaults to stream', () => {
    const body = fnBody('_resetUiForNewSession');
    // The saved key is honoured verbatim when it holds a valid mode…
    assert.ok(
      /saved === 'stream' \|\| saved === 'split'/.test(body),
      'explicit saved preference (单列 or 多列) must win over the default'
    );
    // …and the absent-key fallback is 单列/stream, NOT 多列/split.
    const m = body.match(/return '(stream|split)'; \/\/ default 单列/);
    assert.ok(m, 'fallback line with the default-单列 marker must exist');
    assert.strictEqual(m[1], 'stream',
      'absent-preference fallback must be stream (单列), got ' + m[1]);
  });

  t('_resetUiForNewSession localStorage-failure catch also defaults to stream', () => {
    const body = fnBody('_resetUiForNewSession');
    // `catch { return 'stream'; }` — a sandboxed/private-mode browser that
    // throws on localStorage.getItem must still land on 单列.
    assert.ok(
      /catch\s*\{\s*return 'stream';\s*\}/.test(body),
      'catch fallback must return stream (单列)'
    );
    // And the old split-default shape must be gone.
    assert.ok(
      !/getItem\('myco_team_view_mode'\)\s*===\s*'stream'\s*\?\s*'stream'\s*:\s*'split'/.test(body),
      'old ternary (missing key → split) must be removed'
    );
  });

  t('initial state.teamView.mode literal is stream (boot default before any session switch)', () => {
    // The state literal at the top of the file — first paint before
    // _resetUiForNewSession has ever run must also be 单列.
    const at = src.indexOf('teamView: { active: false, mode:');
    assert.ok(at >= 0, 'state.teamView literal must exist');
    const win = src.slice(at, at + 80);
    assert.ok(win.includes("mode: 'stream'"),
      'boot literal must be stream, got: ' + win.trim().split('\n')[0]);
  });

  t('_setTeamViewMode still persists the explicit user choice (preference shape unchanged)', () => {
    const body = fnBody('_setTeamViewMode');
    assert.ok(
      /localStorage\.setItem\('myco_team_view_mode'/.test(body),
      'explicit dropdown pick must keep persisting'
    );
  });

  t('_applyTeamViewMode keeps the dropdown in sync with the default (stream select option)', () => {
    const body = fnBody('_applyTeamViewMode');
    assert.ok(
      /sel\.value = split \? 'split' : 'stream'/.test(body),
      'dropdown mirrors the mode — default stream selects the 单列 option'
    );
  });

  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

main();
