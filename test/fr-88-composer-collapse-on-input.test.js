// fr-88: Collapse chat composer buttons to icon-only when user
// starts typing.
//
// User-reported (verbatim, plan-item dispatch):
//   Problem: Composer action buttons occupy horizontal space
//            needed for the text input once the user begins typing.
//   Expected: As soon as input is non-empty, buttons shrink to
//             icon-only, freeing room for text content.
//   Actual: Buttons retain their full label+icon width regardless
//           of input state, crowding the typed message.
//
// Surface: the four `.composer-btn` action buttons in
// web/public/index.html lines 178–210 — Stop (#claude-stop), Mic
// (#chat-mic), Draw (#chat-diagram), Send (#chat-send). Each
// renders as <svg.composer-icon> + <span.composer-btn-label> +
// optional <kbd.composer-btn-kbd> (Esc hint on Stop only).
//
// Scope (anti-bloat §3 — exactly the user's "buttons", nothing
// more):
//   - The `.composer-btn` family collapses to icon-only via a
//     `.composer.composer-has-content` body-class toggle on
//     `#chat-form`. CSS hides .composer-btn-label + .composer-
//     btn-kbd when the class is set; the SVG icon stays.
//   - title + aria-label attrs on each button are kept so screen
//     readers + hover tooltips still announce Stop/Speak/Draw/
//     Send even when the visible label is hidden.
//   - The `<select id="composer-critic-select">` is NOT
//     a `.composer-btn` and is intentionally untouched — different
//     element type, and bug-43 already caps it on mobile.
//
// Trigger: textarea `input` event in `bindChatUi()` (app.js
// ~line 7862). Check `input.value.trim().length > 0` — whitespace-
// only input doesn't trigger the collapse (typing a space shouldn't
// shrink the buttons).
//
// Test shape: static-grep guards on web/public/index.html (button
// markup invariants), web/public/styles.css (the CSS rule), and
// web/public/app.js (the textarea input listener + class toggle).

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

console.log('── fr-88: composer buttons collapse to icon-only on input ──');

// ── markup invariant: every .composer-btn carries the label span
//    that the collapse rule hides ──

t('every .composer-btn in index.html carries a .composer-btn-label child', () => {
  const html = _read('web/public/index.html');
  // Find every <button … class="… composer-btn …" …>…</button>.
  const re = /<button\b([^>]*class="[^"]*\bcomposer-btn\b[^"]*"[^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  let count = 0;
  while ((m = re.exec(html))) {
    count++;
    const innerHtml = m[2];
    assert.ok(/<span\b[^>]*class="composer-btn-label"/.test(innerHtml),
      `every .composer-btn must wrap its visible label in <span class="composer-btn-label"> so the fr-88 collapse rule has a stable hook. Found button without label span: ${m[1].slice(0, 120)}`);
  }
  assert.ok(count >= 3, `expected ≥ 3 .composer-btn elements in index.html (Stop, Draw, Send minimum) — found ${count}`);
});

t('every .composer-btn keeps a title + aria-label so a11y survives the collapse', () => {
  const html = _read('web/public/index.html');
  const re = /<button\b([^>]*class="[^"]*\bcomposer-btn\b[^"]*"[^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const openTag = m[1];
    assert.ok(/\btitle\s*=/.test(openTag),
      'every .composer-btn must carry a title="…" so hover/long-press still names the action when only the icon is visible (fr-88).');
    assert.ok(/\baria-label\s*=/.test(openTag),
      'every .composer-btn must carry aria-label="…" so screen readers still announce the action when the visible label is hidden (fr-88).');
  }
});

// ── CSS: .composer.composer-has-content hides labels (+ kbd) ──

t('styles.css declares a .composer.composer-has-content rule that hides .composer-btn-label', () => {
  const css = _read('web/public/styles.css');
  // The selector must include both `.composer.composer-has-content`
  // AND `.composer-btn-label`. Accept ANY order (descendant or
  // explicit), as long as the rule sets `display: none` (or
  // `visibility: hidden` is NOT enough — we want the slot to
  // collapse so the textarea actually gets the freed space).
  const re = /\.composer(?:[^{,]*\.composer-has-content[^{,]*)?\.composer-has-content[^{]*\.composer-btn-label\s*[,{]|\.composer\.composer-has-content[^{,]*\.composer-btn-label\s*[,{]/;
  // Simpler: just look for any selector containing both .composer-has-content
  // and .composer-btn-label.
  const ruleRe = /([^{}]*\.composer-has-content[^{}]*\.composer-btn-label[^{}]*|\.composer-has-content[\s\S]*?\.composer-btn-label[\s\S]*?)\{([^}]*)\}/;
  const m = css.match(ruleRe);
  assert.ok(m, 'styles.css must contain a rule whose selector references BOTH .composer-has-content AND .composer-btn-label so labels collapse when the textarea has content (fr-88).');
  const body = m[2];
  assert.ok(/display:\s*none/.test(body),
    'the .composer-has-content rule must set display: none on .composer-btn-label so the slot fully collapses and gives the freed space to the textarea (visibility: hidden would leave a gap).');
});

t('styles.css collapses .composer-btn-kbd too (the Esc hint takes space)', () => {
  const css = _read('web/public/styles.css');
  // The Esc kbd on Stop is part of the labeled affordance — when
  // labels collapse, the kbd should collapse too so the button is
  // truly icon-only. Accept a separate rule OR a comma-grouped
  // selector with the label rule above.
  const re = /\.composer-has-content[\s\S]*?\.composer-btn-kbd[\s\S]*?\{[^}]*display:\s*none/;
  assert.ok(re.test(css),
    'styles.css must collapse .composer-btn-kbd to display: none under .composer-has-content too — otherwise the Esc kbd hint on Stop stays visible and the button isn\'t truly icon-only (fr-88).');
});

// ── JS: bindChatUi toggles .composer-has-content on input ──

t('app.js wires a textarea input handler that toggles .composer-has-content on #chat-form', () => {
  const app = _read('web/public/app.js');
  // The simplest guard: somewhere in app.js, code reads the
  // textarea value, trims it, and toggles a class containing
  // "composer-has-content" on chat-form. We allow several
  // shapes:
  //   form.classList.toggle('composer-has-content', input.value.trim().length > 0)
  //   form.classList.toggle('composer-has-content', !!input.value.trim())
  //   if (input.value.trim()) form.classList.add('composer-has-content') else …remove…
  assert.ok(/composer-has-content/.test(app),
    'app.js must reference the .composer-has-content class so the textarea input handler can toggle it (fr-88).');
  // And the toggle must consult the textarea value (not some other
  // signal). Look for an `input.value` (or `chatInput.value` etc.)
  // adjacent to the composer-has-content reference.
  const hasContentRefs = [...app.matchAll(/composer-has-content/g)];
  let foundValueProximity = false;
  for (const m of hasContentRefs) {
    const win = app.slice(Math.max(0, m.index - 500), m.index + 500);
    if (/\.value/.test(win) && /trim\(\)/.test(win)) {
      foundValueProximity = true;
      break;
    }
  }
  assert.ok(foundValueProximity,
    'the .composer-has-content toggle must consult the textarea\'s `.value.trim()` so whitespace-only input doesn\'t trigger the collapse (fr-88).');
});

t('the composer-has-content toggle hooks the textarea `input` event (not just on submit/blur)', () => {
  const app = _read('web/public/app.js');
  // Find the textarea input listener in bindChatUi. The fr-88 toggle
  // must fire on every keystroke — easiest hook is the same `input`
  // event the existing autoResize() consumes.
  // We look for `addEventListener('input'` followed (within ~2000
  // chars) by a composer-has-content reference OR for an
  // `addEventListener('input',` inside the same function that
  // contains the toggle.
  const inputListenerRe = /addEventListener\s*\(\s*['"]input['"][\s\S]{0,2500}composer-has-content/;
  const reverseRe = /composer-has-content[\s\S]{0,2500}addEventListener\s*\(\s*['"]input['"]/;
  assert.ok(inputListenerRe.test(app) || reverseRe.test(app),
    'the .composer-has-content toggle must be wired to the textarea `input` event so it fires on every keystroke (not just on form submit or blur). Found neither input-listener-then-toggle nor toggle-then-input-listener within a 2500-char window (fr-88).');
});

// ── marker comment ──

t('a comment naming fr-88 sits NEAR the composer-has-content code so a future restyle finds the rationale (disambiguates from the pre-existing fr-88-r blocking-modal feature in app.js)', () => {
  // The id `fr-88` was reused by the plan tab — there's a
  // pre-existing fr-88(r) feature in app.js + styles.css about a
  // blocking connection-overlay modal, totally unrelated to this
  // composer-collapse work. So a bare `grep fr-88 web/public/`
  // would pass on the old comments even if no marker is added for
  // THIS feature. Lock the marker NEAR the composer-has-content
  // reference so the new rationale is genuinely committed.
  const css = _read('web/public/styles.css');
  const app = _read('web/public/app.js');
  // Search for composer-has-content occurrences; require fr-88 in
  // a ±1500-char window around at least one of them, in either
  // file.
  const sources = [['styles.css', css], ['app.js', app]];
  let foundNearby = false;
  for (const [name, src] of sources) {
    const positions = [...src.matchAll(/composer-has-content/g)];
    for (const m of positions) {
      const win = src.slice(Math.max(0, m.index - 1500), m.index + 1500);
      if (/fr-88/.test(win)) {
        foundNearby = true;
        break;
      }
    }
    if (foundNearby) break;
  }
  assert.ok(foundNearby,
    'a comment naming fr-88 must appear within ±1500 chars of a `composer-has-content` reference (in styles.css or app.js). Without that proximity, the unrelated pre-existing fr-88(r) blocking-modal references trick a flat `grep fr-88` into passing — and a future restyle removes the composer-collapse code thinking the markers are about the modal.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
