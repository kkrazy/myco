// bug-43: HUD and "critic: gemini" button overflow on mobile,
// crowding text input.
//
// User-reported (verbatim, plan-item dispatch):
//   Problem: On mobile, the HUD is too wide and the "critic: gemini"
//            button takes up space that should belong to the text
//            input area.
//   Expected: HUD fits within the mobile viewport; "critic: gemini"
//             button is sized so the text input retains usable width.
//   Actual:   HUD overflows horizontally and the oversized "critic:
//             gemini" button chews into the text input area.
//
// Root cause (verified by reading prod CSS):
//   - The "critic: gemini button" the user sees is actually the
//     <select id="composer-critic-select"> at index.html line ~190.
//     Its options carry verbose labels ("⚖️ Critic: Gemini",
//     "⚖️ Critic: Codex", "⚖️ Critic: Hosted") so the rendered
//     select sizes to ~120px to fit. styles.css's .composer-critic-
//     select rule has NO max-width and NO mobile media-query override,
//     so on a 360-380px viewport the select crowds the chat input.
//   - The HUD (#chat-hud-task) has .hud-task-text with an
//     unconditional `max-width: 400px`. On viewports narrower than
//     ~440px (after accounting for HUD padding + sibling content),
//     the text — which is set white-space:nowrap + text-overflow:
//     ellipsis — pushes the HUD container past viewport width,
//     producing horizontal overflow. .chat-hud-task's padding
//     (12px 16px = 32px horizontal) also wastes mobile real estate.
//
// Fix (pure CSS, no JS contract change):
//   - Add @media (max-width: 600px) override for .composer-critic-
//     select that caps its width (max-width:90px) so the select
//     stays tappable but doesn't crowd input.
//   - Add a mobile override for .hud-task-text that replaces the
//     unconditional max-width:400px with a viewport-aware value.
//   - Tighten .chat-hud-task padding on mobile so the HUD has more
//     room for the actual content.
//
// Test shape: static-grep guards on web/public/styles.css. Pure CSS
// changes don't lend themselves to runtime DOM-shape tests without
// a real browser; the static guards lock the existence + shape of
// the mobile rules so a future refactor that drops them red-flips.

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

console.log('── bug-43: mobile HUD + critic-select overflow ──');

// ── critic select ──

t('styles.css: .composer-critic-select has a mobile (≤600px) override capping its width', () => {
  const css = _read('web/public/styles.css');
  // Find every @media (max-width: …px) rule, walk the body, look for
  // .composer-critic-select with a max-width/width property.
  // We accept any breakpoint ≤900px since 600 and 900 are both used
  // in this project.
  const mobileBlocks = [...css.matchAll(/@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g)];
  let found = false;
  for (const m of mobileBlocks) {
    const start = m.index;
    const bp = parseInt(m[1], 10);
    if (bp > 900) continue;
    // Walk forward to matching close brace (naive depth counter — fine for our CSS).
    let depth = 0;
    let end = start;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    const block = css.slice(start, end + 1);
    if (/\.composer-critic-select\b[^}]*(max-width|width)\s*:/m.test(block)) {
      found = true;
      break;
    }
  }
  assert.ok(found,
    'styles.css must contain an @media (max-width: ≤900px) block that overrides .composer-critic-select with a width or max-width cap so it stops crowding the chat input on mobile.');
});

t('styles.css: .composer-critic-select mobile rule cites bug-43 so the why is discoverable', () => {
  const css = _read('web/public/styles.css');
  // The comment doesn't have to be IN the @media block, but it must
  // appear near the .composer-critic-select rule + name bug-43.
  const ruleAt = css.indexOf('.composer-critic-select');
  assert.ok(ruleAt > 0);
  // Look in a generous window around the rule for the marker. The
  // first `.composer-critic-select` reference is inside the bug-43
  // fix comment block (the comment mentions the selector by name);
  // 800-byte upstream window captures both the rule and its
  // preceding documentation comment.
  const window = css.slice(Math.max(0, ruleAt - 800), ruleAt + 1500);
  assert.ok(/bug-43/.test(window),
    'a comment naming bug-43 must explain why the mobile cap on .composer-critic-select exists so a future "clean up" pass doesn\'t silently re-introduce the overflow');
});

// ── HUD ──

t('styles.css: .hud-task-text mobile override replaces the unconditional max-width:400px', () => {
  const css = _read('web/public/styles.css');
  // Either the base .hud-task-text rule is now responsive
  // (e.g. max-width: min(400px, …)) OR a mobile @media block
  // re-declares its max-width.
  const baseAt = css.indexOf('.hud-task-text');
  assert.ok(baseAt > 0, 'styles.css must define .hud-task-text');
  // Take the base rule body (up to the first '}').
  const baseEnd = css.indexOf('}', baseAt);
  const baseBody = css.slice(baseAt, baseEnd);
  const isResponsive = /max-width\s*:\s*min\s*\(/.test(baseBody)
    || /max-width\s*:\s*[^;]*calc\s*\(/.test(baseBody)
    || /max-width\s*:\s*[^;]*vw\b/.test(baseBody);

  // Or — fall back to checking for a mobile @media override.
  let mobileOverride = false;
  const mediaBlocks = [...css.matchAll(/@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g)];
  for (const m of mediaBlocks) {
    const bp = parseInt(m[1], 10);
    if (bp > 900) continue;
    const start = m.index;
    let depth = 0, end = start;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = css.slice(start, end + 1);
    if (/\.hud-task-text\b[^}]*max-width\s*:/m.test(block)) { mobileOverride = true; break; }
  }
  assert.ok(isResponsive || mobileOverride,
    '.hud-task-text must either use a responsive max-width (calc/vw/min) OR have a mobile @media override — the unconditional max-width:400px overflows narrow viewports.');
});

t('styles.css: .chat-hud-task has reduced padding on mobile (avoids wasting horizontal space)', () => {
  const css = _read('web/public/styles.css');
  const mediaBlocks = [...css.matchAll(/@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g)];
  let found = false;
  for (const m of mediaBlocks) {
    const bp = parseInt(m[1], 10);
    if (bp > 900) continue;
    const start = m.index;
    let depth = 0, end = start;
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const block = css.slice(start, end + 1);
    if (/\.chat-hud-task\b[^}]*padding\s*:/m.test(block)) { found = true; break; }
  }
  assert.ok(found,
    'a mobile @media block must override .chat-hud-task padding so the HUD has more horizontal room for content on small viewports.');
});

t('styles.css: a comment naming bug-43 explains the HUD mobile fix too', () => {
  const css = _read('web/public/styles.css');
  // Same trick — find the .chat-hud-task rule and look for the bug-43
  // marker in a window around it.
  const ruleAt = css.indexOf('.chat-hud-task');
  assert.ok(ruleAt > 0);
  const window = css.slice(Math.max(0, ruleAt - 400), ruleAt + 2500);
  assert.ok(/bug-43/.test(window),
    'a comment naming bug-43 must explain the mobile HUD/padding fix so a future restyle doesn\'t silently re-introduce the overflow.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
