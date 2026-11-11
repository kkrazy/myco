// User review ask (前端审查): "界面字体理论上都应该支持选中复制" —
// interface text should be selectable/copyable. The body-level
// `user-select: none` (needed so chrome drag/long-press doesn't
// accidentally select) cascades into readable panes; the readable
// surfaces must explicitly reclaim selectability.
//
// Guards the CSS contract on the surfaces users read + copy from:
//   1. sidebar session cards (title / summary / cwd / meta)
//   2. HUD task title (hud-task-text)
//   3. verdict panel critique + user-question body
//   4. plan/artifact item text
//   5. chat messages (already covered by the !important block; guard
//      keeps it from regressing)

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'public', 'styles.css'), 'utf8');

console.log('── UI text is selectable (前端审查: 支持选中复制) ──');

function blockOf(marker) {
  const at = CSS.indexOf(marker);
  assert.ok(at >= 0, `styles.css must contain ${marker}`);
  const end = CSS.indexOf('}', at);
  return CSS.slice(at, end);
}

t('session sidebar text (title/summary/cwd/meta) is selectable', () => {
  const b = blockOf('.session-name, .session-cwd, .session-title');
  assert.ok(/user-select:\s*text/.test(b),
    'session card text must set user-select:text — the body-level none cascades in and blocks copy');
});

t('HUD task title is selectable', () => {
  const b = blockOf('.hud-task-text {');
  assert.ok(/user-select:\s*text/.test(b),
    '.hud-task-text must set user-select:text (user reads + copies task titles)');
});

t('verdict panel critique is selectable', () => {
  const b = blockOf('.verdict-critique {');
  assert.ok(/user-select:\s*text/.test(b),
    '.verdict-critique must set user-select:text — users copy flagged issues out of the verdict');
});

t('verdict panel user-question body is selectable', () => {
  const b = blockOf('.verdict-user-question-body {');
  assert.ok(/user-select:\s*text/.test(b),
    '.verdict-user-question-body must set user-select:text');
});

t('plan/artifact item text is selectable', () => {
  // Exact-match the standalone rule line — `.artifact-items li.is-done
  // .artifact-item-text` (line-through variant) also contains the
  // marker, so indexOf alone would grab the wrong block.
  const m = CSS.match(/^\.artifact-item-text\s*\{[^}]*\}/m);
  assert.ok(m, 'styles.css must have a standalone .artifact-item-text rule');
  assert.ok(/user-select:\s*text/.test(m[0]),
    '.artifact-item-text must set user-select:text — plan item bodies are core readable content');
});

t('chat messages keep the !important selectability reclaim', () => {
  const at = CSS.indexOf('#chat-messages, #chat-messages *');
  assert.ok(at >= 0, 'the #chat-messages selectability block must exist');
  const b = CSS.slice(at, CSS.indexOf('}', at));
  assert.ok(/user-select:\s*text\s*!important/.test(b),
    '#chat-messages must keep user-select:text !important (body-level none cascades on Chrome)');
});

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${passed} checks passed`);
