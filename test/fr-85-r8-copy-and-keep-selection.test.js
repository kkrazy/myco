// fr-85 r8: copy button + keep selection visually on the clarify
// popover.
//
// User-reported (verbatim, plan-item comment from @labxnow on
// 2026-06-02T23:15:19):
//   "add copy button to the popover to copy the selected text.
//    Keep the selected text visually selected for better ux."
//
// Two-part fix:
//   (A) Copy button — new <button id="chat-clarify-copy">📋 between
//       the input and Send. Click → navigator.clipboard.writeText
//       on the selected SPAN TEXT (not the popover question or
//       preview). Brief "✓" confirmation, then restore 📋.
//   (B) Keep selection visually — the open-time code now wraps the
//       Range in a <span class="chat-clarify-anchor chat-clarify-
//       anchor-pending"> AT OPEN (was only at send before). The
//       pending class gets a stronger highlight so it mimics the
//       browser's native selection. On send → -pending class drops,
//       anchor stays as the post-send marker (r4-r7 behavior).
//       On cancel → _closeClarifyPopover unwraps the span entirely
//       so no visual residue remains.
//
// Test shape: static-grep on the locked surface.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-85 r8: copy button + keep selection on clarify popover ──');

// ── A. Copy button ──

t('web/public/app.js: clarify popover renders a #chat-clarify-copy button between input and #chat-clarify-send', () => {
  const app = _read('web/public/app.js');
  assert.ok(/id=['"]chat-clarify-copy['"]/.test(app),
    '#chat-clarify-copy button must exist in the popover HTML (fr-85 r8).');
  // Locate the popover innerHTML template + verify the order:
  // input → copy → send → close (Copy is a side-action, Send stays
  // the primary action).
  const at = app.search(/pop\.innerHTML\s*=\s*`/);
  assert.ok(at > -1, 'popover innerHTML template must exist.');
  const tmpl = app.slice(at, at + 2500);
  const inputIdx = tmpl.indexOf('id="chat-clarify-input"');
  const copyIdx = tmpl.indexOf('id="chat-clarify-copy"');
  const sendIdx = tmpl.indexOf('id="chat-clarify-send"');
  assert.ok(inputIdx > -1 && copyIdx > -1 && sendIdx > -1, 'all three button ids must appear in the template.');
  assert.ok(inputIdx < copyIdx && copyIdx < sendIdx,
    'order must be input → copy → send (Copy sits between input and Send so Send stays the rightmost primary action).');
});

t('web/public/app.js: _copyClarifySelection helper is defined + uses navigator.clipboard.writeText', () => {
  const app = _read('web/public/app.js');
  assert.ok(/function\s+_copyClarifySelection\s*\(/.test(app),
    '_copyClarifySelection helper must be defined (fr-85 r8 — copy-to-clipboard action).');
  const at = app.search(/function\s+_copyClarifySelection\s*\(/);
  const body = app.slice(at, at + 2500);
  assert.ok(/navigator\.clipboard\.writeText/.test(body),
    '_copyClarifySelection must use navigator.clipboard.writeText for the modern clipboard path (fr-85 r8).');
  // Fallback for non-secure contexts: execCommand path.
  assert.ok(/execCommand\s*\(['"]copy['"]\)/.test(body) || /execCommand\s*&&\s*document\.execCommand/.test(body),
    '_copyClarifySelection must include the execCommand fallback so the copy still works in non-secure contexts (fr-85 r8).');
  // Visual confirmation: brief "✓" swap on the button label.
  assert.ok(/['"]✓['"]/.test(body),
    '_copyClarifySelection must swap the button label to "✓" briefly so the user gets a visual confirmation (fr-85 r8).');
});

t('web/public/app.js: Copy button click handler is wired in the popover lazy-build path', () => {
  const app = _read('web/public/app.js');
  // The click handler wiring happens once when the popover is first
  // built (lazy mount). Look for the addEventListener wiring on
  // #chat-clarify-copy.
  assert.ok(/querySelector\(['"]#chat-clarify-copy['"]\)\.addEventListener\(/.test(app) ||
            /#chat-clarify-copy[\s\S]{0,200}addEventListener[\s\S]{0,200}_copyClarifySelection/.test(app),
    'the Copy button click must be wired to _copyClarifySelection in the popover lazy-build branch (fr-85 r8).');
});

// ── B. Keep selection visually (wrap at open-time) ──

t('web/public/app.js: the popover OPEN path wraps the selected Range in <span class="chat-clarify-anchor chat-clarify-anchor-pending"> (not only at send)', () => {
  const app = _read('web/public/app.js');
  // The open-time wrap must use the pending class so the cancel
  // path can identify "user never sent" and unwrap.
  const openAt = app.search(/function\s+_openClarifyPopover\s*\(/);
  assert.ok(openAt > -1, '_openClarifyPopover must exist.');
  const openBody = app.slice(openAt, openAt + 8000);
  assert.ok(/surroundContents\(/.test(openBody),
    '_openClarifyPopover must call surroundContents to wrap the range at open (fr-85 r8 — keeps selection visually).');
  assert.ok(/chat-clarify-anchor-pending/.test(openBody),
    'the open-time wrap must use the "chat-clarify-anchor-pending" class so cancel can identify + unwrap it (fr-85 r8).');
});

t('web/public/app.js: _sendClarify drops the -pending class (graduates the wrap from pre-send to post-send) instead of creating a new wrap', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_sendClarify\s*\(/);
  const body = app.slice(at, at + 3500);
  assert.ok(/classList\.remove\s*\(\s*['"]chat-clarify-anchor-pending['"]\)/.test(body),
    '_sendClarify must drop the chat-clarify-anchor-pending class so the wrap graduates to the post-send anchor look (fr-85 r8 — instead of creating a second wrap).');
});

t('web/public/app.js: _closeClarifyPopover unwraps the pending-anchor span if the user closed without sending', () => {
  const app = _read('web/public/app.js');
  const at = app.search(/function\s+_closeClarifyPopover\s*\(/);
  const body = app.slice(at, at + 2500);
  assert.ok(/chat-clarify-anchor-pending/.test(body),
    '_closeClarifyPopover must check for the chat-clarify-anchor-pending class to detect "user never sent" (fr-85 r8).');
  assert.ok(/_unwrapClarifyAnchor\s*\(/.test(body),
    '_closeClarifyPopover must call _unwrapClarifyAnchor on the pending wrap so cancel leaves no visual residue (fr-85 r8).');
});

t('web/public/app.js: _unwrapClarifyAnchor helper is defined + restores the wrapped span back to plain text', () => {
  const app = _read('web/public/app.js');
  assert.ok(/function\s+_unwrapClarifyAnchor\s*\(/.test(app),
    '_unwrapClarifyAnchor helper must be defined (fr-85 r8 — reverts the open-time wrap on cancel).');
  const at = app.search(/function\s+_unwrapClarifyAnchor\s*\(/);
  const body = app.slice(at, at + 1500);
  // Either: lift child nodes out + remove the wrap, or use
  // replaceWith / outerHTML — anything that drops the span.
  assert.ok(/insertBefore[\s\S]{0,200}removeChild|replaceChild|replaceWith/.test(body),
    '_unwrapClarifyAnchor must lift the wrap\'s children to the parent + remove the wrap (or equivalent) so the original text-only DOM is restored.');
});

// ── CSS for the new -pending state + the Copy button ──

t('web/public/styles.css: .chat-clarify-anchor-pending has a stronger background than the post-send anchor (mimics native selection)', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/\.chat-clarify-anchor-pending\s*\{|\.chat-clarify-anchor\.chat-clarify-anchor-pending\s*\{/.test(css),
    '.chat-clarify-anchor-pending CSS rule must exist (fr-85 r8 — pre-send variant of the anchor).');
  // The post-send background is rgba(80, 120, 200, .08); the
  // pre-send must be stronger so it mimics native selection.
  const block = (css.match(/\.chat-clarify-anchor\.chat-clarify-anchor-pending\s*\{[^}]*\}/) || [''])[0];
  assert.ok(block, 'must locate the .chat-clarify-anchor-pending block.');
  // Parse the background alpha — must be > .08.
  const bgMatch = block.match(/background\s*:\s*rgba?\([^)]+\)/);
  assert.ok(bgMatch, '.chat-clarify-anchor-pending must declare a background.');
  const alphaMatch = bgMatch[0].match(/,\s*\.?(\d+(?:\.\d+)?)\s*\)$|,\s*0?\.(\d+)\s*\)$/);
  assert.ok(alphaMatch, 'background alpha must be parseable.');
  const alpha = parseFloat(alphaMatch[1] || ('0.' + alphaMatch[2]));
  assert.ok(alpha > 0.08,
    `.chat-clarify-anchor-pending background alpha must be > 0.08 (the post-send anchor's value) so the pre-send state visually stands out — got ${alpha}.`);
});

t('web/public/styles.css: #chat-clarify-copy button is styled', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/#chat-clarify-copy\s*\{|#chat-clarify-popover\s+#chat-clarify-copy\s*\{/.test(css),
    '#chat-clarify-copy must have a CSS rule so it gets the muted styling that distinguishes it from Send (fr-85 r8).');
});

// ── marker ──

t('a comment naming "fr-85 r8" appears in app.js + styles.css', () => {
  const app = _read('web/public/app.js');
  const css = _read('web/public/styles.css');
  assert.ok(/fr-85 r8/.test(app),
    'a comment naming fr-85 r8 must appear in app.js so a future restyle understands the open-time wrap + Copy button plumbing.');
  assert.ok(/fr-85 r8/.test(css),
    'a comment naming fr-85 r8 must appear in styles.css so a future restyle understands the -pending highlight + Copy button styling.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
