// bug-45: Mobile HUD layout is not user-friendly.
//
// User-reported (verbatim, plan-item dispatch):
//   Problem: HUD display is awkward to use on mobile viewports.
//   Expected: HUD elements sized, spaced, and positioned for
//             comfortable touch use on small screens.
//   Actual: Current HUD layout is not adjusted for mobile and
//           degrades usability.
//   Comment: "Its too wide and too small for mobile."
//
// Disambiguation (user confirmed via in-chat clarification): the
// HUD in scope is `#chat-hud-task` — the pinned task-status box at
// the TOP of the chat pane (web/public/index.html:147,
// styles.css:8176-8312, app.js _updateTaskHUD around line 7184).
// It sits ABOVE `#runqueue-strip` (the queue chip list) in DOM
// order, which is why the user pointed at it as "the running task
// status above the queue list."
//
// HUD structure:
//   .chat-hud-task (sticky top, blurred bg)
//     .hud-task-row (flex justify-between)
//       .hud-task-title-wrap   [hud-task-id badge] [hud-task-text title]
//       .hud-task-status       [⏱️ elapsed] [Stop button]
//     .hud-progress-timeline   Analysis → Writing → Verification → Critique
//
// Two distinct mobile-UX defects covered by the report:
//
// 1. "Too small" — type scale + tap targets sized for desktop.
//    Pre-fix mobile uses .hud-task-text=13px, .hud-task-id=11px,
//    .hud-task-status=11px, .timeline-step=11px, .hud-stop-btn=11px
//    with 3px×8px padding (≈22px tall). 11px is below the iOS
//    Human Interface Guidelines minimum readable size, and the
//    Stop button is well under Apple's 44px / Material's 48px
//    tap-target recommendation.
//
// 2. "Too wide" — the 4-step timeline relies on `overflow-x: auto`
//    to handle phone-width overflow. That works on desktop touch
//    pads but is hostile on a phone: the user can't see all 4 steps
//    at once + has to horizontally swipe a 24px-tall strip. The
//    fix lets the timeline WRAP onto a second line instead, so all
//    4 steps stay visible without touch-scrolling.
//
// Fix scope (anti-bloat §3 — exactly what was reported, no more):
//   - Add mobile-specific font-size bumps inside the existing
//     @media (max-width: 600px) block (no new breakpoints).
//   - Add min-height + padding bump to .hud-stop-btn for tap target.
//   - Switch .hud-progress-timeline from overflow-x: auto to
//     flex-wrap: wrap on mobile (4 steps on a phone wrap to 2 rows
//     — still compact, all visible).
//   - Keep the bug-43 fixes (.hud-task-text max-width calc(),
//     padding tightening, critic-select 90px cap) — they were
//     correct, just incomplete.
//
// Test shape: static-grep guards on styles.css. Pure CSS change
// so no runtime behaviour test needed.

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

console.log('── bug-45: mobile HUD layout (font scale + tap target + timeline wrap) ──');

// Helper: extract + concatenate the BODIES of EVERY
// @media (max-width: 600px) {...} block in styles.css. styles.css has
// several such blocks scattered across sections (Plan tab mobile,
// chat composer mobile, HUD mobile…), and the bug-45 rules live in
// the chat-hud section. Concatenating the bodies lets the per-
// selector assertions find their rule no matter which @media block
// it landed in, while still rejecting "the rule lives at desktop
// scope only". Brace-counts so nested blocks inside an @media work.
function extractMobileMediaBody(css) {
  const re = /@media\s*\(\s*max-width:\s*600px\s*\)\s*\{/g;
  const parts = [];
  let m;
  while ((m = re.exec(css))) {
    const startAt = m.index + m[0].length;
    let depth = 1;
    for (let i = startAt; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          parts.push(css.slice(startAt, i));
          break;
        }
      }
    }
  }
  return parts.length ? parts.join('\n/* ---- @media boundary ---- */\n') : null;
}

t('styles.css declares a @media (max-width: 600px) block (the mobile HUD breakpoint bug-43 + bug-45 share)', () => {
  const css = _read('web/public/styles.css');
  const body = extractMobileMediaBody(css);
  assert.ok(body, 'styles.css must contain @media (max-width: 600px) { … } — bug-43 introduced it, bug-45 extends it.');
});

// ── type scale: text bumped to readable sizes on mobile ──

t('.hud-task-text font-size bumped to ≥ 14px on mobile (was 13px desktop)', () => {
  const css = _read('web/public/styles.css');
  const body = extractMobileMediaBody(css);
  const m = body.match(/\.hud-task-text\s*\{[^}]*font-size:\s*(\d+)px/);
  assert.ok(m, '.hud-task-text inside @media must declare font-size in px (bug-45 readability bump)');
  const size = parseInt(m[1], 10);
  assert.ok(size >= 14, `.hud-task-text mobile font-size must be ≥ 14px — got ${size}px. 13px desktop was unreadably small on phones (bug-45).`);
});

t('.hud-task-id badge font-size ≥ 12px on mobile (was 11px desktop)', () => {
  const css = _read('web/public/styles.css');
  const body = extractMobileMediaBody(css);
  const m = body.match(/\.hud-task-id\s*\{[^}]*font-size:\s*(\d+)px/);
  assert.ok(m, '.hud-task-id inside @media must declare font-size in px');
  const size = parseInt(m[1], 10);
  assert.ok(size >= 12, `.hud-task-id mobile font-size must be ≥ 12px — got ${size}px.`);
});

t('.hud-task-status / .timeline-step font-size ≥ 12px on mobile (was 11px desktop)', () => {
  const css = _read('web/public/styles.css');
  const body = extractMobileMediaBody(css);
  const statusMatch = body.match(/\.hud-task-status\s*\{[^}]*font-size:\s*(\d+)px/);
  const stepMatch = body.match(/\.timeline-step\s*\{[^}]*font-size:\s*(\d+)px/);
  assert.ok(statusMatch, '.hud-task-status inside @media must declare font-size in px');
  assert.ok(stepMatch, '.timeline-step inside @media must declare font-size in px');
  assert.ok(parseInt(statusMatch[1], 10) >= 12, `.hud-task-status mobile font-size must be ≥ 12px — got ${statusMatch[1]}px.`);
  assert.ok(parseInt(stepMatch[1], 10) >= 12, `.timeline-step mobile font-size must be ≥ 12px — got ${stepMatch[1]}px.`);
});

// ── tap-target: Stop button no longer thumb-tiny ──

t('.hud-stop-btn min-height ≥ 36px on mobile (Apple HIG/Material tap-target floor)', () => {
  const css = _read('web/public/styles.css');
  const body = extractMobileMediaBody(css);
  const m = body.match(/\.hud-stop-btn\s*\{[^}]*min-height:\s*(\d+)px/);
  assert.ok(m, '.hud-stop-btn inside @media must declare min-height — desktop padding 3px 8px gives ~22px which is below the tap-target floor (bug-45).');
  const minH = parseInt(m[1], 10);
  assert.ok(minH >= 36, `.hud-stop-btn mobile min-height must be ≥ 36px — got ${minH}px. Apple HIG = 44px, Material = 48px; 36px is the absolute floor.`);
});

t('.hud-stop-btn padding bumped on mobile (more vertical room for the tap)', () => {
  const css = _read('web/public/styles.css');
  const body = extractMobileMediaBody(css);
  const m = body.match(/\.hud-stop-btn\s*\{[^}]*padding:\s*(\d+)px\s+(\d+)px/);
  assert.ok(m, '.hud-stop-btn inside @media must declare padding (bug-45 tap-target bump)');
  const vert = parseInt(m[1], 10);
  assert.ok(vert >= 6, `.hud-stop-btn mobile vertical padding must be ≥ 6px — got ${vert}px. Desktop 3px is too tight for fingers.`);
});

// ── timeline wrap: 4 steps stay visible without horizontal scroll ──

t('.hud-progress-timeline switches to flex-wrap: wrap on mobile (no horizontal scroll)', () => {
  const css = _read('web/public/styles.css');
  const body = extractMobileMediaBody(css);
  const m = body.match(/\.hud-progress-timeline\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.ok(m, '.hud-progress-timeline inside @media must set flex-wrap: wrap so the 4 steps reflow to 2 lines on phones instead of horizontal-scrolling. Pre-fix used overflow-x: auto which is hostile on touch (the user can\'t see all 4 steps at once).');
});

t('.hud-progress-timeline overflow-x switched off on mobile (auto-scroll removed)', () => {
  const css = _read('web/public/styles.css');
  const body = extractMobileMediaBody(css);
  const m = body.match(/\.hud-progress-timeline\s*\{([^}]*)\}/);
  assert.ok(m, '.hud-progress-timeline must have a mobile rule');
  const decls = m[1];
  if (/overflow-x:/.test(decls)) {
    assert.ok(/overflow-x:\s*visible/.test(decls),
      '.hud-progress-timeline mobile rule sets overflow-x — must be `visible` so flex-wrap can actually wrap (auto would create a horizontal scrollbar inside the wrapped box).');
  }
});

// ── marker comment ──

t('a comment naming bug-45 explains the mobile HUD readability/tap-target/wrap fix', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/bug-45/.test(css),
    'a comment in styles.css must name bug-45 near the mobile HUD rules so a future restyle understands why the @media block carries explicit font-sizes + a tap-target floor + flex-wrap for the timeline (and does not silently revert to "everything inherits desktop values + overflow-x: auto").');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
