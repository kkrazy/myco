// bug-39: plan-item action-row buttons/chips were inconsistent heights.
//
// User-reported (kkrazy 2026-05-25): "the buttons on the plan item card
// is of different size, make sure they are off the same height for
// 'merged from', 'upvote', 'comment', 'do/fix/implement', 'close', 'edit'"
//
// Pre-fix: each action-row element had its own height behavior:
//   - .artifact-item-merged    font 0.72rem, padding 1px 6px, radius 3px
//   - .artifact-item-deps      font 0.7rem,  padding 1px 6px, radius 3px
//   - .artifact-item-run-status font 0.7rem, padding 1px 6px, radius 3px
//   - .artifact-item-wt        font 0.75rem, padding 1px 7px, radius 10px
//   - .artifact-item-overlap   font 0.75rem, padding 1px 7px, radius 10px
//   - .artifact-vote-chip      font 0.78rem, padding 1px 8px, radius 12px
//   - .artifact-comment-chip   font 0.85rem, padding 1px 8px, radius 12px
//   - .artifact-item-edit      font 11px,    padding 2px 10px, radius 4px
//   - .artifact-item-delete    fixed 22x22px (font 1rem)
// → visually staggered row.
//
// Fix: a single rule sets min-height:22px + box-sizing:border-box +
// display:inline-flex + align-items:center + line-height:1 across
// every action-row element. The min-height matches the existing
// fixed-size delete button (22px) so nothing shrinks; everything
// that was shorter now stretches to 22px and content centers
// vertically. line-height:1 prevents emoji glyphs from inflating
// the box past the declared min-height.

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

console.log('── bug-39: action-row uniform height ──');

t('styles.css: bug-39 unified-height rule exists', () => {
  assert.ok(/bug-39/.test(CSS),
    'CSS must carry a bug-39 marker for traceability');
});

t('styles.css: rule lists every action-row chip / button class', () => {
  // Find the bug-39 block + its selector list.
  const idx = CSS.indexOf('bug-39:');
  assert.ok(idx > -1, 'bug-39 comment must exist');
  // The rule block starts after the comment + ends at the closing brace.
  const ruleStart = CSS.indexOf('.artifact-item-actions .artifact-item-', idx);
  assert.ok(ruleStart > -1, 'rule selectors must follow the bug-39 comment');
  const ruleEnd = CSS.indexOf('}', ruleStart);
  const block = CSS.slice(ruleStart, ruleEnd);
  // Every class the user mentioned (or that the action row renders)
  // must be in the selector list. "do/fix/implement" maps to the
  // legacy .artifact-item-run class (label varied by layer); "close"
  // maps to .artifact-item-close. Both included even though they're
  // not currently rendered on the card (fr-85 r2 dropped them) — so
  // any future re-add picks up the unified height automatically.
  for (const cls of [
    'artifact-item-merged',
    'artifact-item-deps',
    'artifact-item-run-status',
    'artifact-item-wt',
    'artifact-item-overlap',
    'artifact-item-edited',
    'artifact-vote-chip',
    'artifact-comment-chip',
    'artifact-item-run',        // legacy "do/fix/implement"
    'artifact-item-close',      // legacy
    'artifact-item-chat',
    'artifact-item-edit',
    'artifact-item-delete',
  ]) {
    assert.ok(new RegExp('\\.' + cls + '\\b').test(block),
      'unified-height selector list must include .' + cls);
  }
});

t('styles.css: rule sets min-height: 22px (matches existing delete-button size)', () => {
  const idx = CSS.indexOf('bug-39:');
  const ruleStart = CSS.indexOf('.artifact-item-actions .artifact-item-', idx);
  const ruleEnd = CSS.indexOf('}', ruleStart);
  const block = CSS.slice(ruleStart, ruleEnd);
  assert.ok(/min-height:\s*22px/.test(block),
    'rule must set min-height: 22px so every action element matches the delete button\'s fixed 22x22 size');
});

t('styles.css: rule sets box-sizing + display + align-items + line-height', () => {
  const idx = CSS.indexOf('bug-39:');
  const ruleStart = CSS.indexOf('.artifact-item-actions .artifact-item-', idx);
  const ruleEnd = CSS.indexOf('}', ruleStart);
  const block = CSS.slice(ruleStart, ruleEnd);
  assert.ok(/box-sizing:\s*border-box/.test(block),
    'box-sizing: border-box so padding doesn\'t inflate beyond min-height');
  assert.ok(/display:\s*inline-flex/.test(block),
    'display: inline-flex so the element behaves as an inline block + can vertically-center');
  assert.ok(/align-items:\s*center/.test(block),
    'align-items: center so content vertical-centers in the stretched 22px box');
  assert.ok(/line-height:\s*1/.test(block),
    'line-height: 1 so tall glyphs (emoji 🔀/✎/⚠️) don\'t push the box past min-height');
});

t('styles.css: rule scoped under .artifact-item-actions (not global)', () => {
  // Each selector must be prefixed with `.artifact-item-actions ` so
  // we don't accidentally restyle these same classes wherever else
  // they might appear (e.g. inside the chat panel).
  const idx = CSS.indexOf('bug-39:');
  const ruleStart = CSS.indexOf('.artifact-item-actions .artifact-item-', idx);
  const ruleEnd = CSS.indexOf('}', ruleStart);
  const block = CSS.slice(ruleStart, ruleEnd);
  // Every selector line in the list should carry the .artifact-item-actions prefix.
  const lines = block.split(',').map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    assert.ok(line.startsWith('.artifact-item-actions '),
      'selector must be scoped: ' + JSON.stringify(line));
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
