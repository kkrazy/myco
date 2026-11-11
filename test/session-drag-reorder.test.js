// User ask: "session 应该支持鼠标拖动改变顺序" — the session sidebar
// must support mouse drag-to-reorder.
//
// Design (client-side, no server schema change):
//   · renderSessionList wires HTML5 drag-and-drop on every
//     .session-item via _wireSessionDrag (draggable=true, dragstart/
//     dragover/drop/dragend).
//   · The new order persists in localStorage under
//     'myco_session_order' (JSON array of session ids).
//   · refreshSessions re-applies the saved order
//     (_sortSessionsBySavedOrder) so the 3s sidebar poll never snaps
//     a dragged order back to server order.
//   · CSS paints the insertion marker (.drag-above/.drag-below) and
//     dims the dragged card (.dragging).
//
// This is a static guard suite (grep/shape assertions on app.js +
// styles.css), same pattern as the other delm UI suites.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'public', 'styles.css'), 'utf8');

console.log('── session sidebar drag-reorder ──');

t('app.js defines the persisted-order key + loader/saver', () => {
  assert.ok(/const SESSION_ORDER_KEY = 'myco_session_order'/.test(APP),
    'SESSION_ORDER_KEY must be myco_session_order (localStorage contract)');
  assert.ok(/function _loadSessionOrder\(\)/.test(APP), '_loadSessionOrder must exist');
  assert.ok(/function _saveSessionOrder\(/.test(APP), '_saveSessionOrder must exist');
});

t('app.js sorts state.sessions by the saved order in refreshSessions', () => {
  const at = APP.indexOf('async function refreshSessions');
  assert.ok(at > -1, 'refreshSessions must exist');
  const end = APP.indexOf('\n}', at);
  const body = APP.slice(at, end);
  assert.ok(/_sortSessionsBySavedOrder\(\)/.test(body),
    'refreshSessions must call _sortSessionsBySavedOrder — else the 3s poll snaps the dragged order back');
});

t('app.js: _applySessionOrder is stable (known ids in saved order, unknown keep input order at the tail)', () => {
  const at = APP.indexOf('function _applySessionOrder');
  assert.ok(at > -1, '_applySessionOrder must exist');
  const end = APP.indexOf('\n}', at);
  const body = APP.slice(at, end);
  assert.ok(/pos\.has\(s\.id\)/.test(body) && /\.sort\(/.test(body) && /\[\.\.\.known, \.\.\.rest\]/.test(body),
    '_applySessionOrder must partition by saved-order membership, sort knowns by position, and append the rest');
});

t('app.js: renderSessionList wires drag-and-drop on every card', () => {
  const at = APP.indexOf('function renderSessionList');
  assert.ok(at > -1, 'renderSessionList must exist');
  const end = APP.indexOf('\n}', at);
  const body = APP.slice(at, end);
  assert.ok(/_wireSessionDrag\(li, s\)/.test(body),
    'renderSessionList must call _wireSessionDrag(li, s) — the drag-reorder wiring');
});

t('app.js: _wireSessionDrag implements dragstart/over/drop + persists on drop', () => {
  const at = APP.indexOf('function _wireSessionDrag');
  assert.ok(at > -1, '_wireSessionDrag must exist');
  const end = APP.indexOf('\n}', at);
  const body = APP.slice(at, end);
  assert.ok(/li\.draggable = true/.test(body), 'the card must be draggable');
  for (const evType of ['dragstart', 'dragover', 'drop', 'dragend']) {
    assert.ok(body.includes(`'${evType}'`), `_wireSessionDrag must handle ${evType}`);
  }
  assert.ok(/_saveSessionOrder\(/.test(body), 'drop must persist the new order');
  assert.ok(/renderSessionList\(\)/.test(body), 'drop must re-render the list');
});

t('styles.css paints the insertion marker + dragged-card dimming', () => {
  assert.ok(/\.session-item\.drag-above::before/.test(CSS) && /\.session-item\.drag-below::after/.test(CSS),
    'the .drag-above/.drag-below insertion markers must exist in CSS');
  assert.ok(/\.session-item\.dragging\s*\{[^}]*opacity/.test(CSS),
    'the .dragging class must dim the dragged card');
});

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${passed} checks passed`);
