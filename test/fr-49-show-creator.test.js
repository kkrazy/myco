// User request: "show creator of a plan item". Render a small chip
// next to the id chip in the top row showing "by @<addedBy>" — same
// data already lives on each plan item, just not surfaced to readers.
// Hover-title shows the addedAt timestamp for full provenance.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── show creator chip on plan items ──');

t('app.js renders an artifact-item-by chip in renderItem', () => {
  assert.match(PROD_APP, /artifact-item-by/,
    'renderItem must include a span/chip with class artifact-item-by surfacing the creator');
});

t('app.js the by-chip uses it.addedBy from the plan-item object', () => {
  // The chip text must reference the addedBy field on the item.
  assert.match(PROD_APP, /it\.addedBy/,
    'by-chip must read from it.addedBy (the field set by /td /fr /bug filing)');
});

t('app.js the by-chip carries the addedAt timestamp in its title attribute', () => {
  // Hover-tooltip shows when the item was filed.
  assert.match(PROD_APP, /artifact-item-by[\s\S]{0,400}?addedAt/,
    'by-chip must surface addedAt via its title attribute (for full provenance on hover)');
});

t('app.js by-chip falls back gracefully when addedBy is missing (legacy items)', () => {
  // Pre-existing items from before this feature may have no addedBy.
  // The chip should either be empty or show a placeholder — not render
  // "by @undefined". A conditional render is the safest pattern.
  assert.match(PROD_APP, /it\.addedBy[\s\S]{0,400}?\?\s*`/,
    'by-chip rendering must guard on it.addedBy being truthy (avoid "@undefined")');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
