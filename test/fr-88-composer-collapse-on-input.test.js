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

// ── fr-88 r2: Critic select collapses too ──
//
// User: "Critic button should collapse to icon only too."
//
// The <select id="composer-critic-select"> isn't a `.composer-btn`
// but it sits in the same actions row and takes ~120px when its
// option label ("⚖️ Critic: Gemini") is visible. Under the same
// .composer-has-content class, clamp its max-width so only the
// ⚖️ glyph + the native dropdown arrow remain visible at rest.
// The option list still opens at full width on click — browsers
// render the open dropdown chrome at its intrinsic width
// regardless of the closed-state clamp. bug-43 already had a
// mobile cap of 90px; fr-88 r2 narrows further to icon-only when
// the user is actively typing.

t('fr-88 r2: .composer-critic-select clamps to icon-only width when .composer-has-content is set', () => {
  const css = _read('web/public/styles.css');
  // Find a rule whose selector includes both .composer-has-content
  // and .composer-critic-select. It must set a small max-width
  // (≤ 40px) so only the ⚖️ glyph + dropdown arrow are visible.
  const ruleRe = /([^{}]*\.composer-has-content[^{}]*\.composer-critic-select[^{}]*|\.composer-has-content[\s\S]*?\.composer-critic-select[\s\S]*?)\{([^}]*)\}/;
  const m = css.match(ruleRe);
  assert.ok(m, 'styles.css must contain a rule whose selector references BOTH .composer-has-content AND .composer-critic-select so the critic dropdown collapses too (fr-88 r2 — "Critic button should collapse to icon only too").');
  const body = m[2];
  const mw = body.match(/max-width:\s*(\d+)px/);
  assert.ok(mw, '.composer-critic-select under .composer-has-content must declare a max-width in px to clamp the closed-state visual to the ⚖️ glyph + dropdown arrow only.');
  const w = parseInt(mw[1], 10);
  assert.ok(w <= 40, `.composer-critic-select max-width under .composer-has-content must be ≤ 40px (icon-only floor) — got ${w}px. bug-43's 90px mobile cap is too wide for "icon only".`);
});

// ── fr-88 r3: button + column actually shrink to fit ──
//
// User: "The buttons in the composer is not shrinked to fit the
// icon only. The width should be just enough for the icon."
//
// Hiding the label/kbd via display:none was necessary but not
// sufficient — the buttons were still ~40px wide because:
//   (a) .composer-btn carries `padding: 0 12px` (24px horizontal
//       padding around the 16px icon = 40px wide button)
//   (b) .composer-actions carries `min-width: 90px` so even if
//       individual buttons shrank, the parent column held the
//       width and let the buttons fill it via align-items: stretch
//
// r3 drops both under .composer-has-content:
//   · .composer-actions { min-width: 0 } — column shrinks to fit
//   · .composer-btn { padding: 0 10px } — 16 + 20 = 36px wide
//     button, matches r2's Critic-select max-width: 36px so the
//     icon-only column reads as one unified strip.

t('fr-88 r3: .composer-has-content .composer-actions drops min-width so the column shrinks to fit', () => {
  const css = _read('web/public/styles.css');
  const ruleRe = /([^{}]*\.composer-has-content[^{}]*\.composer-actions[^{}]*|\.composer-has-content[\s\S]*?\.composer-actions[\s\S]*?)\{([^}]*)\}/;
  const m = css.match(ruleRe);
  assert.ok(m, 'styles.css must contain a rule whose selector references BOTH .composer-has-content AND .composer-actions so the action column can shrink to fit (fr-88 r3 — the default min-width: 90px held the column wide regardless of inner content).');
  const body = m[2];
  const mw = body.match(/min-width:\s*(\d+|auto|0)/);
  assert.ok(mw, '.composer-actions under .composer-has-content must declare min-width — without dropping the base 90px floor, the column stays wide.');
  const v = mw[1];
  assert.ok(v === '0' || v === 'auto' || (parseInt(v, 10) <= 40),
    `.composer-actions under .composer-has-content must drop min-width to 0 / auto / ≤ 40px so the column collapses to fit the icon-only buttons — got "${v}". The base rule's 90px held the column wide and let align-items:stretch keep buttons at full column width even after the label hid.`);
});

t('fr-88 r3: .composer-has-content .composer-btn tightens horizontal padding so the button hugs its icon', () => {
  const css = _read('web/public/styles.css');
  // Find a rule whose selector matches `.composer-has-content`
  // AND `.composer-btn` (NOT `.composer-btn-label` or
  // `.composer-btn-kbd`). The simplest disambiguation: look for
  // a selector ending in `.composer-btn` (followed by `{` or `,`
  // or whitespace before `{`).
  const ruleRe = /\.composer-has-content\s+\.composer-btn\s*\{([^}]*)\}/;
  const m = css.match(ruleRe);
  assert.ok(m, 'styles.css must contain a rule for `.composer-has-content .composer-btn` (no -label/-kbd suffix) so button padding tightens (fr-88 r3).');
  const body = m[1];
  // r3 was `padding: 0 10px` (two values); r4 tightens to
  // `padding: 4px` (single shorthand, all sides). Accept either
  // form — parse every numeric value in the padding shorthand
  // and treat the SMALLEST horizontal-relevant value as the
  // "horizontal padding" floor.
  const p = body.match(/padding:\s*([^;]+);/);
  assert.ok(p, '.composer-btn under .composer-has-content must declare padding (fr-88 r3+).');
  const values = p[1].trim().split(/\s+/).map(v => parseInt(v, 10)).filter(n => !isNaN(n));
  assert.ok(values.length > 0, '.composer-btn padding must resolve to numeric values');
  // Horizontal padding in CSS shorthand:
  //   1 value:  v applies to all sides → horizontal = v
  //   2 values: v h → horizontal = values[1]
  //   3 values: top h bottom → horizontal = values[1]
  //   4 values: t r b l → horizontal = max(values[1], values[3])
  let horizontal;
  if (values.length === 1) horizontal = values[0];
  else if (values.length === 2 || values.length === 3) horizontal = values[1];
  else horizontal = Math.max(values[1], values[3]);
  assert.ok(horizontal < 12,
    `.composer-btn under .composer-has-content must use horizontal padding < 12px (base) — got ${horizontal}px from "${p[1].trim()}". The base 12px×2 around a 16px icon gives 40px-wide buttons that don't read as "icon-only".`);
});

// ── fr-88 r4: hug the icon — tight padding + shrunk height ──
//
// User: "The shrinked button is still a lot wider than the icon."
//
// r3's `padding: 0 10px` left 20px of horizontal padding around
// the 16px icon (36px-wide button) — still visibly wider than the
// icon. And the base `height: 34px` from .composer-btn kept each
// button tall regardless of how tight the padding got. r4 drops
// the button to 24×24 (16px icon + 4px padding on every side)
// AND tightens the Critic clamp from 36px to 28px to match.

t('fr-88 r4 → r12: .composer-has-content .composer-btn declares explicit height (was 24px r4, now 34px r12 to match expanded)', () => {
  const css = _read('web/public/styles.css');
  const ruleRe = /\.composer-has-content\s+\.composer-btn\s*\{([^}]*)\}/;
  const m = css.match(ruleRe);
  assert.ok(m, 'styles.css must contain a rule for `.composer-has-content .composer-btn`.');
  const body = m[1];
  const h = body.match(/height:\s*(\d+)px/);
  assert.ok(h, '.composer-btn under .composer-has-content must declare height. r4 dropped it to 24px; r12 raised it back to 34px so the height stays constant across modes (user: "the height for expanded and shrinked mode should remain the same").');
  const heightPx = parseInt(h[1], 10);
  assert.ok(heightPx === 34,
    `.composer-btn collapsed height must be 34px (matching expanded) per fr-88 r12 — got ${heightPx}px.`);
});

t('fr-88 r4: .composer-has-content .composer-btn padding ≤ 6px on every side', () => {
  const css = _read('web/public/styles.css');
  const ruleRe = /\.composer-has-content\s+\.composer-btn\s*\{([^}]*)\}/;
  const m = css.match(ruleRe);
  assert.ok(m);
  const body = m[1];
  // Padding can be expressed as `padding: 4px;` (all sides) or
  // `padding: 4px 4px;` etc. We accept any shorthand whose every
  // resolved value is ≤ 6.
  const p = body.match(/padding:\s*([^;]+);/);
  assert.ok(p, '.composer-btn under .composer-has-content must declare padding (r4).');
  const values = p[1].trim().split(/\s+/).map(v => parseInt(v, 10)).filter(n => !isNaN(n));
  assert.ok(values.length > 0, '.composer-btn padding must resolve to numeric values');
  for (const v of values) {
    assert.ok(v <= 6, `.composer-btn padding values must all be ≤ 6px so the button hugs the icon — found ${v}px in "${p[1]}" (fr-88 r4).`);
  }
});

t('fr-88 r4: .composer-has-content .composer-critic-select max-width tightens to ≤ 32px (matches the smaller button width)', () => {
  const css = _read('web/public/styles.css');
  // Find ALL rules whose selector matches `.composer-has-content
  // .composer-critic-select` — the LAST one wins by source order.
  // Assert the winning max-width is ≤ 32px (r4 floor; r2 had 36).
  const re = /\.composer-has-content\s+\.composer-critic-select\s*\{([^}]*)\}/g;
  let lastMatch = null;
  let m;
  while ((m = re.exec(css))) {
    lastMatch = m;
  }
  assert.ok(lastMatch, 'styles.css must contain at least one `.composer-has-content .composer-critic-select` rule');
  const body = lastMatch[1];
  const mw = body.match(/max-width:\s*(\d+)px/);
  assert.ok(mw, '.composer-critic-select under .composer-has-content must declare a max-width');
  const w = parseInt(mw[1], 10);
  assert.ok(w <= 32, `.composer-critic-select effective max-width must be ≤ 32px to match the r4 button width — got ${w}px. (r2 had 36; r4 tightens.)`);
});

// ── fr-88 r6: uniform width + height ──
//
// User: "Revert the last change. Then make sure all buttons have
// the same width and height."
//
// r5 had unified the chrome (drop Send accent green + Stop red,
// remove Mic). User reverted that and asked for explicit
// dimensional uniformity instead. r6 locks .composer-btn to a
// fixed 90×34 at rest and 24×24 collapsed, regardless of variant
// (Mic / Send / Stop / Draw). Even with the variant chromes back
// (Send green bg, Stop red, Mic dashed border + strikethrough),
// the buttons all render at the same outer pixel dimensions
// because the base class wins on the dimension props.

t('fr-88 r6: .composer-btn base rule locks an explicit width AND height (uniform across variants)', () => {
  const css = _read('web/public/styles.css');
  // Find the base `.composer-btn {` rule (NOT a variant
  // `.composer-btn-foo` rule). Look for `.composer-btn` followed
  // by whitespace + `{` with no `-` or `:` in between.
  const re = /\n\.composer-btn\s*\{([^}]*)\}/;
  const m = css.match(re);
  assert.ok(m, '.composer-btn base rule must exist');
  const body = m[1];
  const w = body.match(/width:\s*(\d+)px/);
  const h = body.match(/height:\s*(\d+)px/);
  assert.ok(w, '.composer-btn base must declare an explicit width: …px so all variants (Stop / Mic / Draw / Send) render at the same outer pixel width regardless of label content (fr-88 r6).');
  assert.ok(h, '.composer-btn base must declare an explicit height: …px so all variants render at the same outer pixel height regardless of variant chrome (fr-88 r6).');
  // Both must be positive
  assert.ok(parseInt(w[1], 10) >= 24, `.composer-btn width must be a sensible button width (≥24px) — got ${w[1]}px.`);
  assert.ok(parseInt(h[1], 10) >= 24, `.composer-btn height must be a sensible button height (≥24px) — got ${h[1]}px.`);
});

t('fr-88 r6: .composer-btn carries flex-shrink: 0 so the column can\'t squish individual variants differently', () => {
  const css = _read('web/public/styles.css');
  const re = /\n\.composer-btn\s*\{([^}]*)\}/;
  const m = css.match(re);
  assert.ok(m);
  const body = m[1];
  assert.ok(/flex-shrink:\s*0/.test(body),
    '.composer-btn must declare flex-shrink: 0 so the .composer-actions flex column can\'t squish individual variants (e.g. Mic with its dashed border) at a different rate than the others. The width: 90px lock is only honoured when shrink is disabled (fr-88 r6).');
});

t('fr-88 r6: collapsed override also locks .composer-btn width (must override base 90px)', () => {
  const css = _read('web/public/styles.css');
  const re = /\.composer-has-content\s+\.composer-btn\s*\{([^}]*)\}/;
  const m = css.match(re);
  assert.ok(m, '.composer-has-content .composer-btn rule must exist (fr-88 r4+)');
  const body = m[1];
  const w = body.match(/width:\s*(\d+)px/);
  assert.ok(w, '.composer-has-content .composer-btn must EXPLICITLY override width — without it, the base 90px lock from r6 keeps the collapsed buttons 90px wide even at 24px tall (broken aspect ratio).');
  const wpx = parseInt(w[1], 10);
  assert.ok(wpx <= 28, `.composer-has-content .composer-btn width must be ≤ 28px so the collapsed button hugs the 16px icon — got ${wpx}px (fr-88 r6).`);
});

// ── fr-88 r7: ACTUAL uniformity (verified with JSDOM cascade) ──
//
// User after r6: "The buttons are of different size after shrink."
// Measured the actual cascade with JSDOM and saw:
//   #claude-stop    width=24 height=24 border-top=1px solid    → content area 14px (overflow)
//   #chat-mic       width=24 height=24 border-top=1px dashed   → content area 14px (overflow)
//   #chat-diagram   width=24 height=24 border-top=0            → content area 16px (fits)
//   #chat-send      width=24 height=24 border-top=0            → content area 16px (fits)
//   #composer-critic-select  width=auto height=auto (NO collapse rule applied — different element type)
//
// Outer dimensions were equal (24×24) but variant borders ate
// 2px of content area on Mic + Stop, while Draw + Send kept the
// full 16px. The 16px SVG icon overflowed by 1px on Mic + Stop,
// making them visibly larger. Critic select wasn't sized at all,
// staying at native auto/auto. r7 fixes both:
//
//   .composer-has-content .composer-btn-mic,
//   .composer-has-content .composer-btn-stop { border: 0 }
//
//   .composer-has-content .composer-critic-select {
//     width: 24px; height: 24px; max-width: 24px;
//     padding: 4px; border: 0; appearance: none;
//   }

t('fr-88 r7: bordered variants (Mic + Stop) get border: 0 in collapsed state', () => {
  const css = _read('web/public/styles.css');
  // Find a rule whose selector references .composer-has-content
  // AND either .composer-btn-mic or .composer-btn-stop and sets
  // border: 0 (or border-width: 0). The simplest: look for the
  // r7 paired selector that hits both.
  const re = /\.composer-has-content\s+\.composer-btn-mic[^{]*\.composer-has-content\s+\.composer-btn-stop\s*\{([^}]*)\}|\.composer-has-content\s+\.composer-btn-stop[^{]*\.composer-has-content\s+\.composer-btn-mic\s*\{([^}]*)\}/;
  const m = css.match(re);
  assert.ok(m, 'styles.css must contain a comma-joined rule covering BOTH `.composer-has-content .composer-btn-mic` AND `.composer-has-content .composer-btn-stop` so their variant borders (dashed/solid 1px) get zeroed in collapsed state. Without this, the 16px icon overflows the 14px content area on those two variants while Draw + Send (no border) sit flush — visibly different sizes (fr-88 r7).');
  const body = m[1] || m[2];
  assert.ok(/border(-width)?:\s*0/.test(body),
    'the bordered-variants collapse rule must set border: 0 (or border-width: 0) so all four .composer-btn variants share the same 16px content area at 24×24 outer (fr-88 r7).');
});

t('fr-88 r7: .composer-critic-select locks to 24×24 in collapsed state (matches the buttons)', () => {
  const css = _read('web/public/styles.css');
  // Find the LAST .composer-has-content .composer-critic-select
  // rule (cascade winner). It must declare width: 24px AND
  // height: 24px so the select sits at the same dimensions as
  // the four .composer-btn elements when collapsed.
  const re = /\.composer-has-content\s+\.composer-critic-select\s*\{([^}]*)\}/g;
  let last = null;
  let m;
  while ((m = re.exec(css))) last = m;
  assert.ok(last, '.composer-has-content .composer-critic-select rule must exist');
  const body = last[1];
  assert.ok(/width:\s*24px/.test(body),
    '.composer-critic-select collapsed rule must declare width: 24px so the select matches the buttons exactly (fr-88 r7). r2/r4 only set max-width which left height + actual width browser-dependent — visibly different from the 24×24 buttons.');
  assert.ok(/height:\s*34px/.test(body),
    '.composer-critic-select collapsed rule must declare height: 34px (fr-88 r12 — height constant across modes; r7 originally set 24, r12 raised to match expanded).');
  assert.ok(/appearance:\s*none/.test(body),
    '.composer-critic-select collapsed rule must declare appearance: none so the native dropdown chevron doesn\'t eat into the 16×16 icon slot (fr-88 r7).');
});

// ── fr-88 r8: mobile @media rules with higher specificity ──
//
// User after r7: "the buttons in composer-actions are of different
// width after shrink, some are of 80x24, 24x24, 56x24, the entire
// composer-actions div width should be shrinked too"
//
// Root cause: r7 verified uniformity with JSDOM but JSDOM doesn't
// honor @media (max-width:Npx) gating by default. On the user's
// real mobile viewport, two @media (max-width:900px) rules from
// the top of styles.css won the cascade:
//   .composer-btn { min-width: 80px; height: 44px; padding: 0 16px }
//   #chat-send    { min-width: 56px; min-height: 40px; font-size: 15px }
// The first beats r7's `.composer.composer-has-content
// .composer-btn` for min-width (r7 declared only `width`, not
// `min-width`). The second beats every class-chain rule because
// `#chat-send` ID specificity 0,1,0,0 > 0,0,3,0. Effective
// computed widths on mobile: Stop/Mic/Draw = 80, Send = 56,
// Critic = browser default. User saw the cascade I missed.
//
// r8 fixes both:
//   (a) Class-chain collapse rule now sets explicit min/max
//       width AND min/max height equal to the lock dimensions
//       so the mobile .composer-btn min-width:80 can't bleed
//       through.
//   (b) Adds an ID-based override
//       #chat-form.composer.composer-has-content #<id>
//       (specificity 0,1,2,1) that outranks every per-id mobile
//       rule (#chat-send 0,1,0,0 and any future siblings).

t('fr-88 r8: class-chain collapse rule sets min/max width AND min/max height (defends against mobile .composer-btn min-width)', () => {
  const css = _read('web/public/styles.css');
  const re = /\.composer\.composer-has-content\s+\.composer-btn\s*\{([^}]*)\}/;
  const m = css.match(re);
  assert.ok(m, 'class-chain collapse rule must exist');
  const body = m[1];
  // r8 width contract = 24px (collapse to icon-only width). r12
  // height contract = 34px (constant across modes). Mobile @media
  // rules can't override either when both min/max are set.
  for (const prop of ['width', 'min-width', 'max-width']) {
    assert.ok(new RegExp(`${prop}:\\s*24px`).test(body),
      `.composer.composer-has-content .composer-btn must declare ${prop}: 24px so mobile @media (max-width: 900px) .composer-btn { min-width: 80px } can't bleed through (fr-88 r8). Body: ${body.slice(0, 200)}`);
  }
  for (const prop of ['height', 'min-height', 'max-height']) {
    assert.ok(new RegExp(`${prop}:\\s*34px`).test(body),
      `.composer.composer-has-content .composer-btn must declare ${prop}: 34px so the collapsed height stays uniform with the expanded state (fr-88 r12). Body: ${body.slice(0, 200)}`);
  }
});

t('fr-88 r8: ID-based collapse overrides exist for all 5 elements (beats #chat-send mobile rule). r9 may split Critic into its own rule.', () => {
  let css = _read('web/public/styles.css');
  // Strip CSS comments before scanning — comments anywhere in the
  // file mention the id literals (e.g. "fr-88 r2 clamps
  // #composer-critic-select to ~36px") and the naive regex would
  // pick them up as if they were selectors.
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ids = ['claude-stop', 'chat-mic', 'chat-diagram', 'chat-send', 'composer-critic-select'];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  const seen = new Map();
  let m;
  while ((m = ruleRe.exec(css))) {
    const selector = m[1];
    if (!/composer-has-content/.test(selector)) continue;
    for (const id of ids) {
      if (new RegExp(`#${id}\\b`).test(selector) && !seen.has(id)) {
        seen.set(id, m[2]);
      }
    }
  }
  for (const id of ids) {
    assert.ok(seen.has(id),
      `ID #${id} must be referenced in at least one #chat-form.composer.composer-has-content #<id> selector so its per-id mobile rules can't bleed through (fr-88 r8/r9).`);
  }
  for (const id of ids) {
    const body = seen.get(id);
    for (const prop of ['width', 'min-width', 'max-width']) {
      assert.ok(new RegExp(`${prop}:\\s*24px`).test(body),
        `ID-based collapse rule covering #${id} must declare ${prop}: 24px so #chat-send-style per-id mobile rules can't pump it back up. Found body: ${body.slice(0, 200)}`);
    }
  }
});

// ── fr-88 r9: Critic emoji visible at rest in collapsed state ──
//
// User after r8: "the critic icon is not visible by default, it
// become visible after I click on it"
//
// Symptom: the ⚖️ emoji wasn't rendering until the user clicked
// the select. Root cause: r7+r8 had `padding: 4px` on the Critic
// select in collapsed state. With width: 24px + box-sizing:
// border-box, the 4px padding eats 8px of horizontal space,
// leaving a 16px content area. The ⚖️ emoji's rendered width at
// the inherited font-size is ~18-20px — so the right edge of the
// emoji overflows the content area, and some browsers skip the
// initial paint entirely (especially with appearance: none) until
// a user interaction triggers a re-render. r9 drops the Critic
// select padding to 0 (separating it from the buttons that need
// padding for icon centering) and pins font-size: 16px so the
// emoji's width is predictable across viewport font-size scales.

t('fr-88 r9: Critic select collapsed rule has padding: 0 (not 4px) so the ⚖️ emoji fits without clipping', () => {
  const css = _read('web/public/styles.css');
  // The class-chain rule must declare padding: 0 (and NOT a
  // 4-pixel padding shorthand). Look at the LAST class-chain
  // critic-select rule.
  const re = /\.composer-has-content\s+\.composer-critic-select\s*\{([^}]*)\}/g;
  let last;
  let m;
  while ((m = re.exec(css))) last = m;
  assert.ok(last, '.composer-has-content .composer-critic-select rule must exist');
  const body = last[1];
  assert.ok(/padding:\s*0\b/.test(body),
    '.composer-critic-select collapsed rule must declare padding: 0 (NOT 4px) so the 24px box gives the ⚖️ emoji the full 24px content area instead of a 16px slot the emoji overflows (fr-88 r9). Found body: ' + body.slice(0, 200));
  assert.ok(!/padding:\s*4(px)?\b/.test(body),
    '.composer-critic-select collapsed rule must NOT declare padding: 4px (was r7\'s value; r9 drops it).');
});

t('fr-88 r9: Critic select has explicit font-size: 16px + line-height: 1 (emoji width predictable across viewport scales)', () => {
  const css = _read('web/public/styles.css');
  const re = /\.composer-has-content\s+\.composer-critic-select\s*\{([^}]*)\}/g;
  let last;
  let m;
  while ((m = re.exec(css))) last = m;
  assert.ok(last);
  const body = last[1];
  assert.ok(/font-size:\s*16px/.test(body),
    '.composer-critic-select collapsed rule must pin font-size: 16px so the emoji renders at a known width — mobile @media bumps body font-size, which without this pin would scale the emoji past the 24px box (fr-88 r9).');
  assert.ok(/line-height:\s*1\b/.test(body),
    '.composer-critic-select collapsed rule must pin line-height: 1 so vertical centering is deterministic at 24px height (fr-88 r9).');
});

t('fr-88 r9: ID-based Critic override has its own padding: 0 (not lumped with buttons\' padding: 4px)', () => {
  const css = _read('web/public/styles.css');
  // The r8 ID rule combined all 5 elements with padding: 4px.
  // r9 splits the Critic select into its own rule with padding: 0.
  // Find a rule whose selector is JUST the critic-select id-chain
  // and check it sets padding: 0.
  const re = /#chat-form\.composer\.composer-has-content\s+#composer-critic-select\s*\{([^}]*)\}/;
  const m = css.match(re);
  assert.ok(m,
    'styles.css must contain a standalone ID-based rule `#chat-form.composer.composer-has-content #composer-critic-select` so the Critic select gets padding: 0 without forcing it on the buttons (fr-88 r9).');
  const body = m[1];
  assert.ok(/padding:\s*0\b/.test(body),
    'standalone Critic ID-rule must declare padding: 0 (fr-88 r9). Found body: ' + body.slice(0, 200));
});

// ── fr-88 r10: short Critic option labels + placeholder ──
//
// User: "the critic label is too long, just show critic when
// nothing is selected, or model name when a model is selected,
// in shrink mode, it should show icon only"
//
// Pre-r10 options: "⚖️ Critic: Gemini" / "⚖️ Critic: Codex" /
// "⚖️ Critic: Hosted" — at the desktop 11px font those render
// ~110-120px wide closed. Mobile bug-43 already capped to 90px
// with overflow ellipsis so users saw "⚖️ Critic:" with the
// model name clipped.
//
// r10 splits this into:
//   · A `<option value="" disabled selected>⚖️ Critic</option>`
//     placeholder for fresh sessions — disabled so it can't be
//     re-selected after the user picks a model. Shows "⚖️ Critic"
//     until a model is picked.
//   · Model options keep "⚖️ Gemini" / "⚖️ Codex" / "⚖️ Hosted"
//     (no "Critic:" prefix) so once a model is picked the select
//     reads as just the model name.
//
// In shrink mode (.composer-has-content), the existing r9
// width:24 + padding:0 + overflow:hidden already clips everything
// past the leading ⚖️ glyph — so the user's "icon only in shrink
// mode" requirement is already met by the prior rounds. No new
// CSS needed; only the option labels change.

t('fr-88 r10: Critic placeholder option <option value="" disabled selected>⚖️ Critic</option> exists', () => {
  const html = _read('web/public/index.html');
  // Find the <select id="composer-critic-select"> block + extract
  // its option children.
  const selectMatch = html.match(/<select[^>]*id="composer-critic-select"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(selectMatch, '<select id="composer-critic-select"> must exist in index.html');
  const inner = selectMatch[1];
  // The placeholder must be the FIRST <option> child and must
  // carry value="", disabled, AND selected attributes.
  const firstOption = inner.match(/<option\b[^>]*>([^<]*)<\/option>/);
  assert.ok(firstOption, 'composer-critic-select must contain at least one <option>');
  const openTag = firstOption[0].match(/<option\b[^>]*>/)[0];
  const body = firstOption[1];
  assert.ok(/value=""/.test(openTag),
    'first <option> in composer-critic-select must declare value="" (placeholder; selecting it doesn\'t POST a real modelId) — fr-88 r10.');
  assert.ok(/\bdisabled\b/.test(openTag),
    'first <option> in composer-critic-select must be `disabled` so the user can\'t re-select the placeholder after picking a model (fr-88 r10).');
  assert.ok(/\bselected\b/.test(openTag),
    'first <option> in composer-critic-select must be `selected` so fresh sessions render "⚖️ Critic" by default (fr-88 r10).');
  assert.ok(/⚖️\s*Critic/.test(body),
    'placeholder option text must contain "⚖️ Critic" (fr-88 r10). Found body: ' + JSON.stringify(body));
  assert.ok(!/Critic:/.test(body),
    'placeholder option must NOT contain the verbose "Critic:" prefix — that\'s the pre-r10 string fr-88 r10 retires.');
});

t('fr-88 r10: model options use short labels (no "Critic:" prefix)', () => {
  const html = _read('web/public/index.html');
  const selectMatch = html.match(/<select[^>]*id="composer-critic-select"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(selectMatch);
  const inner = selectMatch[1];
  // All non-placeholder options (value!="") must have short labels.
  const options = [...inner.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)];
  for (const m of options) {
    const attrs = m[1];
    const text = m[2];
    if (/value=""/.test(attrs)) continue;  // skip placeholder
    assert.ok(!/Critic:/.test(text),
      `model option text must NOT contain the "Critic:" prefix (fr-88 r10). Found: ${JSON.stringify(text)} on option with attrs ${attrs}`);
    assert.ok(/⚖️/.test(text),
      `model option text must keep the ⚖️ glyph so the closed-select preview shows the icon (fr-88 r10). Found: ${JSON.stringify(text)}`);
  }
  // Make sure we have at least 2 model options remaining.
  const modelOptions = options.filter(m => !/value=""/.test(m[1]));
  assert.ok(modelOptions.length >= 2,
    `composer-critic-select must keep ≥ 2 model options after r10 (currently expecting Gemini/Codex/Hosted) — found ${modelOptions.length}.`);
});

// ── fr-88 r11: uniform dimensions in BOTH states ──
//
// User: "the size of the buttons in composer-actions should be
// the same both in width and height, both in expanded or
// shrinked mode"
//
// Pre-r11 in expanded (resting) state:
//   · #chat-send carried `min-height: 40px` from the mobile
//     @media (max-width: 900px) rule. ID specificity 0,1,0,0 beat
//     my class-chain `.composer-btn { height: 34px }` (0,0,1,0)
//     so Send rendered 90×40 on mobile while the other three
//     buttons rendered 90×34.
//   · #composer-critic-select had no dimension rules in expanded
//     state (different element type than .composer-btn) so the
//     select used the browser's native content-driven size —
//     typically 30-40px tall depending on browser + option text.
//
// r11 adds an expanded-state ID-based lock paralleling the
// collapsed r8 rule, just without the .composer-has-content gate:
//
//   #chat-form.composer #<id> { width:90; …; height:34; … }
//
// Specificity 0,1,2,1 — beats the per-id mobile rules. The r8
// collapsed sibling at 0,1,3,1 (extra .composer-has-content class)
// wins when typed input is present, so collapse to 24×24 still
// fires correctly.

t('fr-88 r11: expanded-state ID-based lock exists for all 5 elements', () => {
  let css = _read('web/public/styles.css');
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const ids = ['claude-stop', 'chat-mic', 'chat-diagram', 'chat-send', 'composer-critic-select'];
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  const seen = new Map();
  let m;
  while ((m = ruleRe.exec(css))) {
    const selector = m[1];
    // EXPANDED rule must be ID-based AND NOT gated by
    // .composer-has-content. Reject any selector containing the
    // collapse class so we only pick the resting-state lock.
    if (/composer-has-content/.test(selector)) continue;
    if (!/#chat-form/.test(selector)) continue;
    for (const id of ids) {
      if (new RegExp(`#${id}\\b`).test(selector) && !seen.has(id)) {
        seen.set(id, m[2]);
      }
    }
  }
  for (const id of ids) {
    assert.ok(seen.has(id),
      `ID #${id} must be referenced in an expanded-state #chat-form.composer #<id> rule (NOT gated by .composer-has-content) so its per-id mobile rule can't override resting dimensions (fr-88 r11).`);
  }
  // Each rule body must lock width=90px AND height=34px (with
  // matching min/max defenses).
  for (const id of ids) {
    const body = seen.get(id);
    for (const prop of ['width', 'min-width', 'max-width']) {
      assert.ok(new RegExp(`${prop}:\\s*90px`).test(body),
        `expanded-state ID rule covering #${id} must declare ${prop}: 90px so the resting dimensions are uniform (fr-88 r11). Body: ${body.slice(0, 200)}`);
    }
    for (const prop of ['height', 'min-height', 'max-height']) {
      assert.ok(new RegExp(`${prop}:\\s*34px`).test(body),
        `expanded-state ID rule covering #${id} must declare ${prop}: 34px so the resting heights are uniform (fr-88 r11). Body: ${body.slice(0, 200)}`);
    }
  }
});

// ── fr-88 r12: constant 34px height + Draw boundary ──
//
// User: "the draw button should have a 'boundary' and the height
// for expanded and shrinked mode should remain the same"
//
// r12 keeps width-only collapse (90 → 24px) but holds the height
// constant at 34px in BOTH states. The .composer-actions column
// keeps the same vertical footprint whether the user is typing
// or not; only horizontal width reclamation happens. Visually:
//   expanded:  90×34 rectangles
//   collapsed: 24×34 narrow rectangles (icon centered)
//
// Draw button gets an explicit `1px solid` border so it reads as
// a tangible button at rest (Mic dashed, Stop red, Send filled —
// only Draw was border-less).

t('fr-88 r12: .composer-btn-diagram declares an explicit border', () => {
  const css = _read('web/public/styles.css');
  const m = css.match(/\n\.composer-btn-diagram\s*\{([^}]*)\}/);
  assert.ok(m, '.composer-btn-diagram rule must exist (with rule body, not just a stub comment).');
  const body = m[1];
  assert.ok(/border:\s*1px\s+solid/.test(body),
    '.composer-btn-diagram must declare an explicit `border: 1px solid …` so the Draw button has a visible boundary at rest (fr-88 r12). Found body: ' + body.slice(0, 200));
});

t('fr-88 r12: collapsed-state class-chain rule keeps height: 34px (not 24px)', () => {
  const css = _read('web/public/styles.css');
  const re = /\.composer\.composer-has-content\s+\.composer-btn\s*\{([^}]*)\}/;
  const m = css.match(re);
  assert.ok(m);
  const body = m[1];
  for (const prop of ['height', 'min-height', 'max-height']) {
    assert.ok(new RegExp(`${prop}:\\s*34px`).test(body),
      `.composer-has-content .composer-btn must declare ${prop}: 34px so the collapsed buttons stay the same height as the resting state (fr-88 r12 — user: "the height for expanded and shrinked mode should remain the same"). Body: ${body.slice(0, 200)}`);
    assert.ok(!new RegExp(`${prop}:\\s*24px`).test(body),
      `.composer-has-content .composer-btn must NOT declare ${prop}: 24px anymore — r12 changes the collapsed height to 34px.`);
  }
});

t('fr-88 r12: collapsed-state ID-based override (for the 4 buttons) keeps height: 34px', () => {
  let css = _read('web/public/styles.css');
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Find a rule whose selector includes #chat-form.composer.
  // composer-has-content AND at least one of #claude-stop or
  // #chat-send (signaling it's the button-id rule, not the
  // Critic rule). Body must declare height: 34px.
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let found = null;
  let m;
  while ((m = ruleRe.exec(css))) {
    const sel = m[1];
    if (!/composer-has-content/.test(sel)) continue;
    if (!/#chat-form/.test(sel)) continue;
    if (!/#claude-stop|#chat-send/.test(sel)) continue;
    if (/#composer-critic-select/.test(sel)) continue;  // skip Critic rule
    found = m[2];
    break;
  }
  assert.ok(found, 'collapsed-state ID-based override for the 4 buttons must exist');
  for (const prop of ['height', 'min-height', 'max-height']) {
    assert.ok(new RegExp(`${prop}:\\s*34px`).test(found),
      `collapsed-state ID-based button override must declare ${prop}: 34px so the collapsed height matches the expanded state (fr-88 r12). Body: ${found.slice(0, 200)}`);
  }
});

t('fr-88 r12: collapsed-state Critic select rules keep height: 34px', () => {
  let css = _read('web/public/styles.css');
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Find BOTH the class-chain and ID-based collapsed rules for
  // the Critic select. Each must declare height: 34px.
  const re = /\.composer-has-content\s+\.composer-critic-select\s*\{([^}]*)\}|#chat-form\.composer\.composer-has-content\s+#composer-critic-select\s*\{([^}]*)\}/g;
  const bodies = [];
  let m;
  while ((m = re.exec(css))) bodies.push(m[1] || m[2]);
  assert.ok(bodies.length >= 1, 'at least one collapsed-state critic rule must exist');
  for (const body of bodies) {
    for (const prop of ['height', 'min-height', 'max-height']) {
      assert.ok(new RegExp(`${prop}:\\s*34px`).test(body),
        `collapsed-state critic-select rule must declare ${prop}: 34px (fr-88 r12). Body: ${body.slice(0, 200)}`);
    }
  }
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
