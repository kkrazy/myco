// bug-41: AskUserQuestion / permission modal must NOT dismiss when the
// user clicks outside the box (on the backdrop).
//
// User-reported (kkrazy 2026-05-25): "click outside of the askuserquestion
// won't have opportunity to bring it back again, the askuserquestion
// shouldn't disappear when click outside"
//
// bug-31 already removed the `data-perm-defer="1"` attribute from the
// backdrop in index.html — so the click handler at app.js
// _bindPermModal doesn't fire defer on backdrop click. BUT the visual
// cues were stale:
//   - .perm-modal-backdrop had `cursor: pointer` (suggesting clickability)
//   - The hint text in the box said "click outside to defer"
//   - The JS code comment on the click handler said "(X, backdrop click)"
// Any of those could lead a user to expect / believe outside-click was
// a defer affordance — and any subtle path (a stale handler, a hand-
// added attribute on a future redesign) could re-introduce it.
//
// bug-41 fix (defense in depth):
//   1. backdrop CSS: cursor: default + pointer-events: none
//      → backdrop CANNOT receive clicks at all; pointer affordance gone
//   2. index.html hint: drop "click outside to defer" phrase
//   3. app.js JS comment: documents bug-41 behavior + Esc/X as the
//      only defer paths
//   4. backdrop element still has NO data-perm-defer attribute
//
// Result: clicking outside the modal-box does nothing. The agent
// stays blocked on AskUserQuestion. The user picks an option, clicks
// X, or hits Esc to defer. No surprise loss of the modal.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');
const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── bug-41: perm-modal backdrop click does NOT dismiss ──');

// ──────────────────────────────────────────────────────────────────────
// CSS: backdrop is non-interactive
// ──────────────────────────────────────────────────────────────────────

t('styles.css: .perm-modal-backdrop has pointer-events: none', () => {
  // Find the .perm-modal-backdrop rule block.
  const idx = CSS.indexOf('.perm-modal-backdrop');
  assert.ok(idx > -1, '.perm-modal-backdrop rule must exist');
  const ruleEnd = CSS.indexOf('}', idx);
  const block = CSS.slice(idx, ruleEnd);
  assert.ok(/pointer-events:\s*none/.test(block),
    'backdrop must have pointer-events: none so clicks cannot reach it (defense in depth)');
});

t('styles.css: .perm-modal-backdrop does NOT have cursor: pointer', () => {
  const idx = CSS.indexOf('.perm-modal-backdrop');
  const ruleEnd = CSS.indexOf('}', idx);
  const block = CSS.slice(idx, ruleEnd);
  // Strip CSS comments before checking — historical references like
  // "Pre-fix the cursor:pointer..." inside /* ... */ blocks must NOT
  // trip this regex, only the actual active declaration would.
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/cursor:\s*pointer/.test(noComments),
    'backdrop must NOT have an active cursor: pointer declaration (was misleading)');
});

t('styles.css: bug-41 marker present', () => {
  assert.ok(/bug-41/.test(CSS),
    'CSS must carry bug-41 marker for traceability');
});

// ──────────────────────────────────────────────────────────────────────
// HTML: backdrop has no data-perm-defer + hint text updated
// ──────────────────────────────────────────────────────────────────────

t('index.html: .perm-modal-backdrop element has NO data-perm-defer attribute', () => {
  // The bug-31 fix removed this; bug-41 confirms it's still gone +
  // would catch any regression that added it back.
  const idx = HTML.indexOf('perm-modal-backdrop');
  assert.ok(idx > -1, '.perm-modal-backdrop element must exist');
  // Look at the whole opening tag.
  const lineStart = HTML.lastIndexOf('<', idx);
  const lineEnd = HTML.indexOf('>', idx);
  const tag = HTML.slice(lineStart, lineEnd + 1);
  assert.ok(!/data-perm-defer/.test(tag),
    'backdrop element must NOT carry data-perm-defer (would re-enable outside-click dismiss): ' + tag);
});

t('index.html: hint text no longer says "click outside to defer"', () => {
  const idx = HTML.indexOf('perm-modal-hint');
  assert.ok(idx > -1, '.perm-modal-hint element must exist');
  // The hint block extends to the next closing </div>.
  const blockEnd = HTML.indexOf('</div>', idx);
  const block = HTML.slice(idx, blockEnd);
  // Strip HTML comments (<!-- ... -->) before checking — the bug-41
  // comment documents that the phrase was removed, but the phrase
  // appears INSIDE that comment block which would trip a naive grep.
  const noComments = block.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/click outside to defer/i.test(noComments),
    'visible hint must NOT mention "click outside to defer" — the affordance is gone');
  // The Esc + X mention should still be present in the visible text.
  assert.ok(/Esc/.test(noComments) && /×|X/.test(noComments),
    'visible hint should still list the actual defer affordances (Esc + X button)');
});

// ──────────────────────────────────────────────────────────────────────
// app.js: only Esc + data-perm-defer ancestor dismiss
// ──────────────────────────────────────────────────────────────────────

t('app.js: permModalDismissed=true is only set in TWO spots (Esc + data-perm-defer)', () => {
  // Defense: future "outside-click dismiss" patch would add a third
  // site. Count must stay at 2.
  const matches = (APP.match(/state\.permModalDismissed\s*=\s*true/g) || []);
  assert.strictEqual(matches.length, 2,
    'state.permModalDismissed = true must appear exactly twice — the X-button handler + the Esc key handler. Found ' + matches.length);
});

t('app.js: bug-41 comment explicitly notes backdrop click is NOT a defer affordance', () => {
  // Anchor on the click-handler comment block right before _bindPermModal.
  const idx = APP.indexOf('Modal click handler');
  assert.ok(idx > -1, 'modal click handler comment block must exist');
  // Window covers the comment block + the function.
  const win = APP.slice(idx, idx + 1500);
  assert.ok(/bug-41/.test(win),
    'click-handler comment must reference bug-41');
  assert.ok(/backdrop[\s\S]{0,60}NOT/i.test(win),
    'comment must explicitly state backdrop click is NOT a defer affordance');
});

// ──────────────────────────────────────────────────────────────────────
// Cache buster bumped so the deployed CSS+HTML refresh
// ──────────────────────────────────────────────────────────────────────

t('index.html: styles.css cache buster bumped >= 255 (so browsers pick up new CSS)', () => {
  const m = HTML.match(/styles\.css\?v=(\d+)/);
  assert.ok(m, 'styles.css cache buster must exist');
  const v = parseInt(m[1], 10);
  assert.ok(v >= 255, 'cache buster must be bumped to >= 255 (was 254 pre-fix); got v=' + v);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
