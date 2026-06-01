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

// ── bug-45 round 2: pipeline labels shortened ──
//
// The 4-step "Analysis → Writing Code → Verification → Critique"
// labels were verbose enough that even after the flex-wrap, the
// chips wrapped to 2 rows on mid-width phones. User asked to
// "rewrite for shorter word" — replaced with one-word forms (≤7
// chars each) so the 4 chips fit on a single row at typical phone
// widths (375px+) while still being readable.

t('app.js HUD pipeline uses short labels: Analyze / Code / Verify / Critic', () => {
  const app = _read('web/public/app.js');
  // The display array MUST contain the new short labels. Old
  // verbose forms ("Analysis", "Writing Code", "Verification",
  // "Critique") in the steps array must be gone.
  const stepsMatch = app.match(/const\s+steps\s*=\s*\[([^\]]+)\]/);
  assert.ok(stepsMatch, '_updateTaskHUD must declare `const steps = [...]` with the 4 pipeline labels.');
  const stepsBody = stepsMatch[1];
  assert.ok(/'Analyze'/.test(stepsBody),  "steps[] must contain 'Analyze' (bug-45 round 2 short form)");
  assert.ok(/'Code'/.test(stepsBody),     "steps[] must contain 'Code'");
  assert.ok(/'Verify'/.test(stepsBody),   "steps[] must contain 'Verify'");
  assert.ok(/'Critic'/.test(stepsBody),   "steps[] must contain 'Critic'");
  assert.ok(!/'Analysis'/.test(stepsBody),     "steps[] must NOT carry the verbose 'Analysis' (replaced with 'Analyze' in bug-45 round 2)");
  assert.ok(!/'Writing Code'/.test(stepsBody), "steps[] must NOT carry the verbose 'Writing Code' (replaced with 'Code')");
  assert.ok(!/'Verification'/.test(stepsBody), "steps[] must NOT carry the verbose 'Verification' (replaced with 'Verify')");
  assert.ok(!/'Critique'/.test(stepsBody),     "steps[] must NOT carry the verbose 'Critique' (replaced with 'Critic')");
});

t('_getHUDActiveStep returns short labels matching the steps[] array', () => {
  // Active-step highlight uses string === comparison
  // (s === activeStep), so if the resolver returns 'Verification'
  // but steps[] holds 'Verify', no chip gets the .active class and
  // the highlight silently breaks. Lock the four return strings.
  const app = _read('web/public/app.js');
  const fnMatch = app.match(/function\s+_getHUDActiveStep\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, '_getHUDActiveStep function must exist in app.js');
  const body = fnMatch[0];
  assert.ok(/return\s+'Critic'/.test(body),  "_getHUDActiveStep must return 'Critic' (not 'Critique')");
  assert.ok(/return\s+'Verify'/.test(body),  "_getHUDActiveStep must return 'Verify' (not 'Verification')");
  assert.ok(/return\s+'Code'/.test(body),    "_getHUDActiveStep must return 'Code' (not 'Writing Code')");
  assert.ok(/return\s+'Analyze'/.test(body), "_getHUDActiveStep must return 'Analyze' (not 'Analysis')");
  assert.ok(!/return\s+'Critique'/.test(body),     "_getHUDActiveStep must NOT return the stale 'Critique'");
  assert.ok(!/return\s+'Verification'/.test(body), "_getHUDActiveStep must NOT return the stale 'Verification'");
  assert.ok(!/return\s+'Writing Code'/.test(body), "_getHUDActiveStep must NOT return the stale 'Writing Code'");
  assert.ok(!/return\s+'Analysis'/.test(body),     "_getHUDActiveStep must NOT return the stale 'Analysis'");
});

// ── bug-45 round 3: HUD buttons adopt the queue's look + feel ──
//
// User: "Make all hud button to have the same look and feel as the
// queue." The queue strip carries two visual languages:
//
//   · Pill-chip family (.runqueue-chip): border-radius 12px,
//     subtle bg-input bg, soft 1px border, monospace, neutral by
//     default with status tints (running=green, failed=red).
//   · Action-button family (.runqueue-clear / -cancel / -resume):
//     transparent bg, muted text + soft 1px border, square 4px
//     radius, intent color (red/green) only on hover.
//
// The HUD's chrome maps to those families one-to-one:
//   · .hud-stop-btn       → action-button family (the only
//                             actual <button> in the HUD)
//   · .hud-task-id        → pill-chip (identity badge)
//   · .timeline-step      → pill-chip (pipeline steps)
//   · .timeline-step.active → status-tinted pill (purple),
//                              same idiom as .runqueue-chip-running
//
// The mobile @media block from r1 stays — phones still get the
// 36px tap-target floor on Stop. Desktop loses the always-red
// look and matches the queue's "muted resting, red on hover"
// convention.

t('bug-45 r3: .hud-stop-btn desktop matches queue action-button family (transparent bg, muted color, soft border)', () => {
  const css = _read('web/public/styles.css');
  // Find the top-level (non-@media) .hud-stop-btn rule. It must
  // declare transparent background AND muted text color, NOT the
  // pre-r3 "always red" theme.
  const m = css.match(/\n\.hud-stop-btn\s*\{([^}]*)\}/);
  assert.ok(m, '.hud-stop-btn base rule must exist in styles.css');
  const body = m[1];
  assert.ok(/background:\s*transparent/.test(body),
    '.hud-stop-btn desktop bg must be transparent (queue action-button family) — pre-r3 was rgba(248,81,73,0.15) red.');
  assert.ok(/color:\s*var\(--muted/.test(body),
    '.hud-stop-btn desktop color must use --muted token — same as .runqueue-clear/.runqueue-cancel/.runqueue-resume.');
  assert.ok(!/color:\s*#ff7b72/.test(body),
    '.hud-stop-btn must NOT set a hardcoded red color — that was the pre-r3 always-red look; intent color now only on hover.');
});

t('bug-45 r3: .hud-stop-btn:hover turns red (intent on hover, queue convention)', () => {
  const css = _read('web/public/styles.css');
  const m = css.match(/\.hud-stop-btn:hover\s*\{([^}]*)\}/);
  assert.ok(m, '.hud-stop-btn:hover rule must exist');
  const body = m[1];
  // Either #d32f2f (queue red) or any red-ish hex/rgba is fine —
  // the point is hover signals destructive intent.
  assert.ok(/color:\s*#?d32f2f|color:\s*#?ff/.test(body),
    '.hud-stop-btn:hover must shift color to a red — same convention as .runqueue-clear:hover.');
});

t('bug-45 r3: .hud-task-id chip adopts pill chrome (border-radius 12px, soft bg/border)', () => {
  const css = _read('web/public/styles.css');
  const m = css.match(/\.hud-task-id\s*\{([^}]*)\}/);
  assert.ok(m, '.hud-task-id rule must exist');
  const body = m[1];
  assert.ok(/border-radius:\s*12px/.test(body),
    '.hud-task-id must use border-radius: 12px (pill) — matches .runqueue-chip. Pre-r3 was 4px (square).');
  assert.ok(/background:\s*var\(--bg-input/.test(body),
    '.hud-task-id background must use --bg-input token — same as .runqueue-chip.');
  assert.ok(/border:\s*1px\s+solid\s+var\(--border-soft/.test(body),
    '.hud-task-id border must use --border-soft token — same as .runqueue-chip.');
});

t('bug-45 r3: .timeline-step chip adopts pill chrome (border-radius 12px, explicit border)', () => {
  const css = _read('web/public/styles.css');
  // Match the base .timeline-step rule (not the .active variant).
  // Use a regex that demands exactly `.timeline-step {` (not
  // `.timeline-step.active {`).
  const re = /\n\.timeline-step\s*\{([^}]*)\}/;
  const m = css.match(re);
  assert.ok(m, '.timeline-step base rule must exist');
  const body = m[1];
  assert.ok(/border-radius:\s*12px/.test(body),
    '.timeline-step must use border-radius: 12px (pill) — matches .runqueue-chip. Pre-r3 was 4px.');
  assert.ok(/border:\s*1px\s+solid\s+var\(--border-soft/.test(body),
    '.timeline-step must declare a soft 1px border — pre-r3 was border-less. Matches .runqueue-chip.');
  assert.ok(/background:\s*var\(--bg-input/.test(body),
    '.timeline-step background must use --bg-input token — same as .runqueue-chip neutral resting state.');
});

t('bug-45 r3: .timeline-step.active overrides border to purple (status-tint idiom)', () => {
  const css = _read('web/public/styles.css');
  const m = css.match(/\.timeline-step\.active\s*\{([^}]*)\}/);
  assert.ok(m, '.timeline-step.active rule must exist');
  const body = m[1];
  assert.ok(/border-color:\s*rgba\(192,\s*132,\s*252/.test(body),
    '.timeline-step.active must override border-color to purple rgba(192,132,252,…) so the active chip pops — same idiom as .runqueue-chip-running tinting border green.');
});

// ── bug-45 round 4: strip Stop label + clock emoji from HUD status ──
//
// User: "Remove the stop text on the stop button of hud, also the
// clock icon, just show the time."
//
// Two render strings in web/public/app.js carry the affordances:
//   · The button's child text "Stop" (after the SVG rect icon) —
//     gone. The button keeps title="Stop execution (Esc)" +
//     aria-label="Stop" so the affordance stays discoverable on
//     hover/long-press and announced by screen readers; only the
//     visible label is removed.
//   · The elapsed-time span "[⏱️ ${getElapsedStr()}]" — gone,
//     replaced with bare `${getElapsedStr()}`. Both the initial
//     render (around line 7245) AND the setInterval ticker
//     (around line 7270) must produce the bare form; if the
//     ticker still wraps the brackets/emoji back in, every second
//     re-introduces them.

t('bug-45 r4: HUD Stop button has no visible "Stop" text child', () => {
  const app = _read('web/public/app.js');
  // Find the .hud-stop-btn button literal in the _updateTaskHUD
  // template string. Walk forward to the matching </button>. The
  // slice between MUST NOT contain a bare "Stop" word as visible
  // text. (We allow attributes like title="Stop execution (Esc)"
  // and aria-label="Stop" — they sit inside the OPENING <button>
  // tag, before the slice we examine.)
  const openMatch = app.match(/<button[^>]*class="hud-stop-btn"[^>]*>/);
  assert.ok(openMatch, '.hud-stop-btn button opening tag must exist in app.js');
  const openEnd = openMatch.index + openMatch[0].length;
  const closeAt = app.indexOf('</button>', openEnd);
  assert.ok(closeAt > openEnd, '.hud-stop-btn button must have a closing </button>');
  const innerHtml = app.slice(openEnd, closeAt);
  assert.ok(!/\bStop\b/.test(innerHtml),
    '.hud-stop-btn must NOT carry a visible "Stop" text child (icon-only per bug-45 r4). Found in inner HTML: ' + JSON.stringify(innerHtml.slice(0, 200)));
});

t('bug-45 r4: HUD Stop button keeps title + aria-label for a11y', () => {
  const app = _read('web/public/app.js');
  const openMatch = app.match(/<button[^>]*class="hud-stop-btn"[^>]*>/);
  assert.ok(openMatch, '.hud-stop-btn opening tag must exist');
  const openTag = openMatch[0];
  assert.ok(/title="Stop execution[^"]*"/.test(openTag),
    '.hud-stop-btn must keep title="Stop execution (Esc)" so the affordance is discoverable on hover (icon-only buttons without titles are user-hostile).');
  assert.ok(/aria-label="Stop"/.test(openTag),
    '.hud-stop-btn must keep aria-label="Stop" so screen readers still announce the button (icon-only without aria-label reads as nothing).');
});

t('bug-45 r4: #hud-duration-text initial render is bare time (no clock emoji, no brackets)', () => {
  const app = _read('web/public/app.js');
  // The initial render uses a template literal — must show
  // `${getElapsedStr()}` without the [⏱️ … ] wrapper.
  const m = app.match(/<span id="hud-duration-text">([^<]*)<\/span>/);
  assert.ok(m, 'app.js must declare a #hud-duration-text span');
  const content = m[1];
  assert.ok(!/⏱/.test(content),
    '#hud-duration-text initial content must NOT contain the ⏱️ clock emoji (bug-45 r4). Found: ' + JSON.stringify(content));
  assert.ok(!/\[/.test(content) && !/\]/.test(content),
    '#hud-duration-text initial content must NOT wrap the time in [brackets] (bug-45 r4). Found: ' + JSON.stringify(content));
  assert.ok(/getElapsedStr\(\)/.test(content),
    '#hud-duration-text must still interpolate getElapsedStr() so the timer renders.');
});

t('bug-45 r4: setInterval ticker also writes the bare time (no emoji/brackets)', () => {
  const app = _read('web/public/app.js');
  // The ticker MUST match the initial render's shape or the
  // brackets/emoji re-appear after 1s. Look at the
  // durText.textContent assignment inside the ticker.
  const tickMatch = app.match(/_hudTimerInterval\s*=\s*setInterval[\s\S]*?durText\.textContent\s*=\s*([^;]+);/);
  assert.ok(tickMatch, 'the HUD timer setInterval must assign durText.textContent');
  const rhs = tickMatch[1];
  assert.ok(!/⏱/.test(rhs),
    'HUD timer ticker must NOT re-insert the ⏱️ clock emoji every second (bug-45 r4). Found assignment RHS: ' + rhs.trim());
  assert.ok(!/\[/.test(rhs) && !/\]/.test(rhs),
    'HUD timer ticker must NOT wrap the time in [brackets] (bug-45 r4). Found: ' + rhs.trim());
  assert.ok(/getElapsedStr\(\)/.test(rhs),
    'HUD timer ticker must still call getElapsedStr() so the time updates.');
});

// ── marker comment ──

t('a comment naming bug-45 explains the mobile HUD readability/tap-target/wrap fix', () => {
  const css = _read('web/public/styles.css');
  assert.ok(/bug-45/.test(css),
    'a comment in styles.css must name bug-45 near the mobile HUD rules so a future restyle understands why the @media block carries explicit font-sizes + a tap-target floor + flex-wrap for the timeline (and does not silently revert to "everything inherits desktop values + overflow-x: auto").');
});

t('a comment naming bug-45 in app.js explains the short-label sync invariant', () => {
  const app = _read('web/public/app.js');
  assert.ok(/bug-45/.test(app),
    'a comment in app.js must name bug-45 near the pipeline labels so a future refactor knows the steps[] array and _getHUDActiveStep return strings must stay in sync (string === comparison drives the .active highlight — a label drift silently breaks the active chip).');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
