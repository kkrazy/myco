// bug-77 (plan-item bug-73): admin config modal has 2 Save buttons
// with ambiguous scope. The PAT-form button is labeled bare "Save"
// — visually identical to a global Save but actually scoped to ONE
// per-repo PAT add. Adjacent to the admin "Save env config" button
// it looks like a global commit, confusing users about which one
// persists their changes.
//
// User report (verbatim, 2026-06-08):
//   "End users are confused by the presence of multiple 'Save'
//    buttons on the config page, making it unclear which one
//    persists their changes."
//
// Test file uses bug-77 because bug-73 is the plan-item id but
// test/bug-73-stage-accept-wakes-claude.test.js from earlier
// abandoned work already occupies that slot. bug-76 just shipped.
// bug-77 is the next-free numeric slot for the test file.
//
// Fix: rename `#config-pat-save` button label from bare "Save" to
// "Add PAT" — matches the section header at index.html:521 which
// already reads "<h4>Add a per-repo PAT</h4>". The button's id +
// click handler stay unchanged so no JS changes needed. The
// "Save env config" button at #config-admin-env-save already has
// an unambiguous label and stays as-is.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-77 (plan-item bug-73): config Save button labels must be unambiguous ──');

const INDEX_HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');

t('#config-pat-save button is labeled "Add PAT" (not bare "Save")', () => {
  // Pre-fix: <button id="config-pat-save">Save</button>
  // Post-fix: <button id="config-pat-save">Add PAT</button>
  const re = /<button[^>]*id="config-pat-save"[^>]*>([^<]+)<\/button>/;
  const m = INDEX_HTML.match(re);
  assert.ok(m, '#config-pat-save button must be present in index.html');
  const label = m[1].trim();
  assert.strictEqual(label, 'Add PAT',
    `bug-77: #config-pat-save label must be "Add PAT" (matches the section header "Add a per-repo PAT") — got "${label}". The bare "Save" label was the source of user confusion: it looked like a global save action but actually scoped to just the one PAT-add form above it.`);
});

t('#config-pat-save id is unchanged (handler stays wired)', () => {
  // The handler binding at app.js:1055 (_saveConfigPerRepoPat) keys
  // on the id, NOT the text. Renaming text must not change id.
  const re = /<button[^>]*id="config-pat-save"/;
  assert.ok(re.test(INDEX_HTML),
    'bug-77: the id `config-pat-save` must be preserved so the existing app.js click handler stays wired without a JS change');
});

t('#config-admin-env-save button label is unchanged ("Save env config")', () => {
  // The admin env-save button is already unambiguous and is NOT
  // touched by this fix. Confirm it stays as-is.
  const re = /<button[^>]*id="config-admin-env-save"[^>]*>([^<]+)<\/button>/;
  const m = INDEX_HTML.match(re);
  assert.ok(m, '#config-admin-env-save button must be present');
  const label = m[1].trim();
  assert.strictEqual(label, 'Save env config',
    `bug-77: #config-admin-env-save label must remain "Save env config" — already unambiguous, not in scope of this fix. Got "${label}".`);
});

t('section header above the PAT form still reads "Add a per-repo PAT" (button label matches)', () => {
  // The button label "Add PAT" was chosen because the section header
  // (index.html:521 area) already reads "<h4>Add a per-repo PAT</h4>".
  // If a future refactor renames the header, the button label should
  // be reconsidered to stay consistent.
  assert.ok(/<h4>\s*Add a per-repo PAT\s*<\/h4>/.test(INDEX_HTML),
    'bug-77: the <h4>Add a per-repo PAT</h4> section header must still be present — the "Add PAT" button label was chosen specifically to match this header');
});

t('the bare "Save" text is no longer adjacent to id="config-pat-save"', () => {
  // Defensive regression catch — if a future edit reverts to bare
  // "Save" while keeping the id, this assertion fails.
  const re = /<button[^>]*id="config-pat-save"[^>]*>\s*Save\s*<\/button>/;
  assert.ok(!re.test(INDEX_HTML),
    'bug-77: the bare "Save" label on #config-pat-save must NOT come back — that\'s the user-reported confusion. Use "Add PAT" or a comparably scoped label.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
