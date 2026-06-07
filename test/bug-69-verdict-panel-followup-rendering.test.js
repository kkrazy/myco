// bug-69: verdict panel renders follow-up questions unreadably alongside
// original message.
//
// User-reported (verbatim, plan-item from @labxnow):
//   Problem:  User follow-up questions in the verdict panel are hard to
//             read and poorly grouped with the original message.
//   Expected: Follow-up questions display in a readable, structured
//             format paired clearly with the original message they
//             relate to.
//   Actual:   Follow-ups render in a format that's hard to scan and
//             not visually tied to the original message.
//
// Root cause (pre-bug-69):
//   The 💬 Ask Critic button (bug-53) lets the user type a follow-up
//   question into the verdict pane's textarea. The button POSTs to
//   /critique/retry { userPrompt }. Server's retryLastCritique fires
//   triggerGeminiCritique with opts.userPrompt — which builds a
//   userFollowupBlock in the critic's PROMPT (critique.js:353-354).
//   Critic produces a new verdict that may or may not echo the
//   question. New broadcast → state.critiqueReview = NEW msg →
//   _renderVerdictPanel shows it. The user's QUESTION is gone from
//   the rendered UI. Only Gemini's response remains. User has no
//   record of what they asked.
//
// Fix (bug-69):
//   · critique.js: include `userPrompt` field in broadcastPayload
//     (sourced from existing userFollowup variable, already trimmed +
//     capped at 2048 chars).
//   · app.js _renderVerdictPanel: render a .verdict-user-question
//     block ABOVE .verdict-critique when review.userPrompt is a
//     non-empty string. Uses escHtml for safety.
//   · styles.css: new .verdict-user-question + .verdict-user-question-
//     label + .verdict-user-question-body rules. Tinted accent border
//     (matches .agent-card-assistant_text) + chip-styled label
//     (matches .agent-card-claude chip).
//   · fr-98 persistence covers it automatically — the whole
//     broadcastPayload is persisted at item.meta.lastCriticReview, so
//     the question replays on cross-device + post-restart attach.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-69: verdict panel follow-up question rendering ──');

// ── 1. Server: critique.js broadcastPayload includes userPrompt ──

t('server/src/critique.js: broadcastPayload includes a userPrompt field', () => {
  const src = _read('server/src/critique.js');
  // Locate the broadcastPayload object literal definition.
  const at = src.search(/const\s+broadcastPayload\s*=\s*\{/);
  assert.ok(at > -1, 'critique.js must declare broadcastPayload.');
  // Window covers the full object literal — userPrompt sits between
  // criticId and specialties per the bug-69 patch.
  const body = src.slice(at, at + 1500);
  assert.ok(/userPrompt\s*:/.test(body),
    'broadcastPayload must include a `userPrompt` field — pre-bug-69 the user\'s follow-up question was only used in the critic PROMPT (userFollowupBlock at line ~353) but never surfaced in the broadcast. Without it the client has nothing to render.');
});

t('server/src/critique.js: userPrompt field is sourced from the userFollowup variable (existing 2048-char cap)', () => {
  const src = _read('server/src/critique.js');
  const at = src.search(/const\s+broadcastPayload\s*=\s*\{/);
  const body = src.slice(at, at + 1500);
  // The userPrompt field value must reference userFollowup (the
  // trimmed + capped variable). Either `userFollowup` directly or
  // `userFollowup || ''` (preferred — explicit empty-string fallback).
  assert.ok(/userPrompt\s*:\s*userFollowup/.test(body),
    'broadcastPayload.userPrompt must reference the userFollowup variable (already trimmed + capped at 2048 chars by the bug-52 logic). Sourcing from a fresh / unchecked source could bypass the cap.');
});

t('server/src/critique.js: bug-69 marker comment names the user-reported symptom', () => {
  const src = _read('server/src/critique.js');
  // Provenance marker so a future restyle knows the broadcastPayload
  // userPrompt is intentional (and which feature it serves).
  assert.ok(/bug-69:[\s\S]{0,500}userPrompt/.test(src),
    'critique.js must carry a `bug-69:` marker comment near the userPrompt addition so a future maintainer can trace the field back to the user report.');
});

// ── 2. Client: app.js _renderVerdictPanel renders the .verdict-user-question block ──

t('web/public/app.js: _renderVerdictPanel renders .verdict-user-question when review.userPrompt is non-empty', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  assert.ok(at > -1, '_renderVerdictPanel function must exist.');
  const body = sliceFn(src, at);
  // The render code must reference review.userPrompt + the
  // .verdict-user-question class.
  assert.ok(/review\.userPrompt/.test(body),
    '_renderVerdictPanel must read review.userPrompt — that\'s the bug-69 broadcast field carrying the user\'s question.');
  assert.ok(/verdict-user-question/.test(body),
    '_renderVerdictPanel must render an element with the .verdict-user-question class so the bug-69 styles apply.');
});

t('web/public/app.js: .verdict-user-question render uses escHtml (XSS safety — the question is raw user input)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = sliceFn(src, at);
  // Find the userQuestionHtml definition or the verdict-user-question
  // block, and confirm escHtml is in the same region.
  const qBlock = body.match(/verdict-user-question[\s\S]{0,500}/);
  assert.ok(qBlock, '.verdict-user-question render block must exist.');
  assert.ok(/escHtml/.test(qBlock[0]),
    'the .verdict-user-question block must use escHtml on the question text — raw user input must be HTML-escaped to prevent injection.');
});

t('web/public/app.js: .verdict-user-question only renders when userPrompt is a non-empty string (no empty block)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = sliceFn(src, at);
  // The userQuestionHtml conditional must guard against empty / null
  // / undefined userPrompt. Look for a `.trim()` or truthy check.
  assert.ok(/review\.userPrompt\s*&&[\s\S]{0,80}\.trim\(\)/.test(body) || /userPrompt[\s\S]{0,50}\?\s*`/.test(body),
    '_renderVerdictPanel must guard the .verdict-user-question render on a non-empty userPrompt — otherwise empty/missing questions would produce an empty styled block that confuses the layout.');
});

t('web/public/app.js: .verdict-user-question renders BEFORE .verdict-critique (visual order: question → answer)', () => {
  const src = _read('web/public/app.js');
  const at = src.search(/function\s+_renderVerdictPanel\s*\(\)/);
  const body = sliceFn(src, at);
  // Locate the panel.innerHTML template literal that contains the
  // VERDICT CARD (the one with .verdict-critique). _renderVerdictPanel
  // may have OTHER panel.innerHTML assignments earlier in the function
  // for orthogonal affordances (e.g. bug-72's `↻ Reopen verdict` pill,
  // which renders when state.lastDismissedVerdict is set + no active
  // review). We want THIS test to lock the question-before-critique
  // ordering inside the verdict card template specifically — not the
  // first template it happens to find.
  //
  // Find all `panel.innerHTML = \`...\`` literals and pick the one
  // containing verdict-critique. The non-greedy quantifier `?` and the
  // closing backtick + lookahead avoid swallowing across multiple
  // assignments.
  const tmplMatches = [...body.matchAll(/panel\.innerHTML\s*=\s*`[\s\S]*?`/g)];
  const tmpl = tmplMatches.find((m) => /verdict-critique/.test(m[0]));
  assert.ok(tmpl, '_renderVerdictPanel must contain a panel.innerHTML = `...` template literal that includes the .verdict-critique class.');
  const tmplBody = tmpl[0];
  const uqAt = tmplBody.search(/userQuestionHtml|verdict-user-question/);
  const vcAt = tmplBody.search(/verdict-critique/);
  assert.ok(uqAt > -1, '.verdict-user-question must appear in the verdict-card panel.innerHTML template.');
  assert.ok(vcAt > -1, '.verdict-critique must appear in the verdict-card panel.innerHTML template.');
  assert.ok(uqAt < vcAt,
    `.verdict-user-question (or its variable userQuestionHtml) must come BEFORE .verdict-critique in the template — visual order matches user's mental model "I asked → the critic replied". Found question at ${uqAt}, critique at ${vcAt}.`);
});

// ── 3. CSS: .verdict-user-question rule exists with the expected visual treatment ──

t('web/public/styles.css: .verdict-user-question rule exists', () => {
  const src = _read('web/public/styles.css');
  assert.ok(/\.verdict-user-question\s*\{/.test(src),
    '.verdict-user-question CSS rule must exist so the rendered block has visual treatment.');
});

t('web/public/styles.css: .verdict-user-question has tinted background + left-accent border (visually distinct block)', () => {
  const src = _read('web/public/styles.css');
  // Locate the rule + check for the visual-treatment properties.
  const ruleMatch = src.match(/\.verdict-user-question\s*\{[\s\S]{0,600}?\}/);
  assert.ok(ruleMatch, '.verdict-user-question rule body must exist.');
  const rule = ruleMatch[0];
  assert.ok(/background\s*:/.test(rule),
    '.verdict-user-question must declare a background (subtle tint matching the accent treatment on .agent-card-assistant_text).');
  assert.ok(/border-left\s*:/.test(rule),
    '.verdict-user-question must declare a left border (3px accent — matches the assistant_text card pattern so the user immediately recognizes "this is a paired block").');
  assert.ok(/padding\s*:/.test(rule),
    '.verdict-user-question must declare padding so the inner text has breathing room.');
});

t('web/public/styles.css: .verdict-user-question-label (the "💬 You asked:" chip) is styled distinctly', () => {
  const src = _read('web/public/styles.css');
  assert.ok(/\.verdict-user-question-label\s*\{/.test(src),
    '.verdict-user-question-label rule must exist so the "💬 You asked:" header looks like a chip / label, not body text.');
});

// ── 4. Provenance markers ──

t('a bug-69 comment marker appears in all 3 touched files (provenance — future restyles can trace back)', () => {
  const sources = ['server/src/critique.js', 'web/public/app.js', 'web/public/styles.css'];
  for (const rel of sources) {
    const src = _read(rel);
    assert.ok(/bug-69/.test(src),
      `${rel} must carry a \`bug-69\` marker comment so a future maintainer can trace the change back to the user report.`);
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
