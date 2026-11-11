// Cross out "Sign in with GitHub" with a "Soon" indicator until OAuth
// is wired up — the PAT form below is the working path. User-requested.
//
// Pins the three pieces that make the disabled state real:
//   1. label wrapped in <s>...</s> for the strikethrough
//   2. a .soon-badge sibling that reads "Soon"
//   3. anchor neutralized — href="#" + aria-disabled + onclick no-op
//      so click + keyboard activation are both no-ops
//   4. CSS rule .disabled-soon mutes the visual

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const HTML = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'index.html'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── login: "Sign in with GitHub" crossed out + Soon badge ──');

function _githubAnchor() {
  // Match the entire <a id="login-github" ...> ... </a> block.
  const m = HTML.match(/<a\s+id=["']login-github["'][\s\S]*?<\/a>/);
  assert.ok(m, 'login-github anchor must exist');
  return m[0];
}

t('label is wrapped in <s> for strikethrough', () => {
  const a = _githubAnchor();
  assert.ok(/<s>\s*Sign in with GitHub\s*<\/s>/.test(a),
    '"Sign in with GitHub" text must be wrapped in <s> tags');
});

t('a "Soon" badge sibling is present', () => {
  const a = _githubAnchor();
  assert.ok(/class=["']soon-badge["']/.test(a),
    'must include a .soon-badge element');
  assert.ok(/>\s*Soon\s*</.test(a),
    'badge text must read "Soon"');
});

t('anchor is functionally disabled (href neutralized + aria-disabled + onclick no-op)', () => {
  const a = _githubAnchor();
  assert.ok(/href=["']#["']/.test(a),
    'href must NOT point at /auth/github/start anymore — neutralize to "#"');
  assert.ok(/aria-disabled=["']true["']/.test(a),
    'aria-disabled="true" so assistive tech announces the disabled state');
  assert.ok(/onclick=["']return false;?["']/.test(a),
    'onclick must short-circuit so the link does nothing on click');
  // Also: should NOT still reference the OAuth start route — that's
  // the entire point of the "soon" treatment.
  assert.ok(!/auth\/github\/start/.test(a),
    'auth/github/start must not be referenced in this anchor while OAuth is disabled');
});

t('anchor carries the .disabled-soon class hook', () => {
  const a = _githubAnchor();
  assert.ok(/class=["'][^"']*\bdisabled-soon\b[^"']*["']/.test(a),
    'anchor must include the .disabled-soon class so the CSS mute rules apply');
});

t('CSS .disabled-soon mute rules exist', () => {
  assert.ok(/#login-github\.disabled-soon\s*\{[\s\S]*?cursor:\s*not-allowed/.test(CSS),
    '.disabled-soon rule must set cursor: not-allowed');
  assert.ok(/#login-github\.disabled-soon:hover/.test(CSS),
    'hover rule must be overridden so the button doesn\'t feel clickable');
});

t('CSS .soon-badge styling exists (amber, uppercase, small)', () => {
  assert.ok(/\.soon-badge\s*\{[\s\S]*?text-transform:\s*uppercase/.test(CSS),
    '.soon-badge must be uppercase so it reads as a status chip, not body text');
  assert.ok(/\.soon-badge[\s\S]*?color:\s*#f6b48a/.test(CSS) ||
            /\.soon-badge[\s\S]*?border[^;]*246,\s*180,\s*138/.test(CSS),
    '.soon-badge should use the amber tone (matches the file-conflict modal\'s warning palette)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
