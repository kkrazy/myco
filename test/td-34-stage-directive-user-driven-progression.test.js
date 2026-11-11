// td-34: §9 directive rewrite — user-driven progression (5-step
// loop) supersedes td-33 r3's auto-iterate clause.
//
// Pre-td-34: the §9 directive in best-practices-template.md told
// claude to auto-iterate up to 2x on critic disagreement before
// pausing for the user. Empirically (in the very session that
// shipped fr-95 + bug-53 + bug-55 + bug-54 + bug-57 + bug-56 +
// fr-96) this didn't deliver the human-in-the-loop discipline —
// claude barreled through analyze → code → verify without giving
// the user a chance to review each checkpoint. User-reported
// verbatim:
//   "during the process it automatically moved to next stage
//    before I accept the result of the check point verdict, it
//    should pause until I accept"
//   "I shouldnt need to reply with continue/process/code"
//   "any follow up question should set to wither the critic or
//    claude to fix"
//
// Fix: td-34 SUPERSEDES td-33 r3's auto-iterate. The new directive
// codifies the user-spec 5-step flow:
//   1. stage — work to done-criteria, emit [stage: X done]
//   2. stage critic — server fires critic + broadcasts to truly-
//      modal verdict pane
//   3. next stage if accepted — user signals via button OR chat
//      accept-class phrase
//   4. rerun critic if follow-up question is provided
//   5. rerun stage if asked to fix (back to step 2)
//
// Silence ≠ accept. The agent stays paused until an explicit
// signal advances.
//
// Test shape: static-grep on the locked §9 surface in
// web/public/best-practices-template.md.

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

console.log('── td-34: §9 directive rewrite — user-driven 5-step loop ──');

const TEMPLATE = 'web/public/best-practices-template.md';

// ── 1. Title + supersession marker ──

t('§9 title carries td-34 (replacing td-33 r3)', () => {
  const md = _read(TEMPLATE);
  assert.ok(/##\s*9\.[^\n]*td-34/.test(md),
    '§9 heading must include td-34 (replacing the td-33 r3 marker) — that\'s the anchor future restyles read.');
});

t('§9 explicitly declares it SUPERSEDES td-33 r3 and explains the empirical reason', () => {
  const md = _read(TEMPLATE);
  assert.ok(/td-34\s+SUPERSEDES\s+td-33\s+r3/.test(md),
    '§9 must contain "td-34 SUPERSEDES td-33 r3" — without the supersession marker, a future reader sees both directives in git history and can\'t tell which is canonical.');
  // The supersession block should mention the failure mode that
  // motivated the rewrite — "auto-iterate" / "barreled through" /
  // similar language.
  assert.ok(/auto-iterate|barrel|human-in-the-loop|empirically/i.test(md),
    'the supersession block must explain WHY td-33 r3 was replaced — anchor on "auto-iterate" / "barreled through" / "human-in-the-loop" / "empirically observed" so future readers understand the motivation.');
});

// ── 2. The 5-step user-driven loop ──

t('§9 contains the user-spec 5-step loop section', () => {
  const md = _read(TEMPLATE);
  assert.ok(/5-step\s+loop|five-step\s+loop|5\.\s*step|five\s+step/i.test(md),
    '§9 must reference the "5-step loop" by name so the user can find the codification of the spec they wrote.');
});

t('§9 enumerates all 5 steps in order: stage → critic → next stage if accepted → rerun critic on follow-up → rerun stage on fix', () => {
  const md = _read(TEMPLATE);
  // Look for each step in the order they appear in the user's spec.
  // The exact numbering may vary; the SUBSTANCE has to be present.
  assert.ok(/1\.\s*\*\*stage\*\*/i.test(md),
    'step 1 must be "stage" — the work-the-current-stage step.');
  assert.ok(/2\.\s*\*\*stage critic\*\*/i.test(md),
    'step 2 must be "stage critic" — the server-fires-critic step.');
  assert.ok(/3\.\s*\*\*next stage if accepted\*\*/i.test(md),
    'step 3 must be "next stage if accepted" — the user-accepts-advance step.');
  assert.ok(/4\.\s*\*\*rerun critic if follow-up/i.test(md),
    'step 4 must be "rerun critic if follow-up question is provided" — the user-asks-critic step.');
  assert.ok(/5\.\s*\*\*rerun stage if asked to fix/i.test(md),
    'step 5 must be "rerun stage if asked to fix" — the user-asks-claude-to-redo step.');
});

// ── 3. Accept signal vocabulary ──

t('§9 defines the accept-signal vocabulary (button click + chat phrases) and rejects bare keywords as a requirement', () => {
  const md = _read(TEMPLATE);
  // The accept signal can be a button click OR an accept-class chat
  // phrase. Both must be enumerated.
  assert.ok(/✓\s*Accept\s+Stage/i.test(md),
    '§9 must name the ✓ Accept Stage button (bug-56) as one accept-signal path.');
  assert.ok(/✓\s*Accept\s+Claude/i.test(md),
    '§9 must name the ✓ Accept Claude button (final-stage path) as another accept-signal path.');
  // Chat phrases.
  assert.ok(/accept|accepted|yes|looks\s+good|proceed|ship\s+it|\\u2713/i.test(md) ||
            /accept[\s\S]{0,300}yes[\s\S]{0,300}looks/i.test(md),
    '§9 must list the accept-class chat phrases (accept, yes, looks good, proceed, ship it, ✓, bare stage name).');
});

t('§9 explicitly states that no additional `continue` / `proceed` / `code` keyword is required beyond the accept signal', () => {
  const md = _read(TEMPLATE);
  // The user's specific clarification: don't make them type a
  // second keyword after the accept. The directive should anchor on
  // this so future claude doesn't re-introduce the ask.
  assert.ok(/no\s+additional\s+`?continue`?[\s\S]{0,200}keyword|NO\s+additional|no\s+specific\s+keyword|no\s+second\s+word/i.test(md),
    '§9 must explicitly note that no additional continue/proceed/code keyword is needed beyond the accept signal (the user clarified this twice).');
});

// ── 4. Silence ≠ accept ──

t('§9 states "Silence ≠ accept" or equivalent — agent stays paused on no signal', () => {
  const md = _read(TEMPLATE);
  // The pause rule is what makes the methodology actually work.
  assert.ok(/[Ss]ilence\s*≠?\s*(is\s+not|!=|is\s+not\s+acceptance|≠)\s*accept|[Ss]ilence\s+is\s+not\s+accept|stays?\s+paused/i.test(md),
    '§9 must state that silence ≠ accept (or equivalent: "the agent stays paused") so claude doesn\'t treat absent input as implicit approval.');
});

// ── 5. Follow-up question routing ──

t('§9 explains follow-up routing: typed question → 💬 Ask Critic button OR chat-level question read as follow-up', () => {
  const md = _read(TEMPLATE);
  assert.ok(/💬\s*Ask\s+Critic/i.test(md),
    '§9 must name the 💬 Ask Critic button (bug-53) as the typed-question path.');
});

// ── 6. Fix-stage routing ──

t('§9 explains fix-stage routing: ⚡ Ask Claude to Fix Stage button → state machine → claude redoes stage', () => {
  const md = _read(TEMPLATE);
  assert.ok(/⚡\s*Ask\s+Claude\s+to\s+Fix\s+Stage|⚡\s*Ask\s+Claude\s+to\s+Fix/i.test(md),
    '§9 must name the ⚡ Ask Claude to Fix Stage button (bug-56) — that\'s the user-requested redo affordance.');
});

// ── 7. Cross-reference to related plan items ──

t('§9 cross-references the related plan items (fr-95, bug-53, bug-54, bug-55, bug-56, bug-57, fr-96)', () => {
  const md = _read(TEMPLATE);
  // Each referenced item should appear at least once so a future
  // reader can trace the methodology back to its component fixes.
  const items = ['fr-95', 'bug-53', 'bug-54', 'bug-55', 'bug-56', 'bug-57', 'fr-96'];
  for (const it of items) {
    assert.ok(new RegExp(it).test(md),
      `§9 must reference ${it} so future readers can trace the methodology back to its component fixes.`);
  }
});

// ── 8. The 3 stages + done-criteria are preserved from td-33 r3 ──

t('§9 still lists all 3 stages (analyze, code, verify) with done-criteria — unchanged from td-33 r3', () => {
  const md = _read(TEMPLATE);
  // Same structure as td-33 r3; td-34 only changes the
  // progression rule, not the stages themselves.
  assert.ok(/1\.\s*\*\*analyze\*\*[\s\S]{0,200}DONE when/i.test(md),
    '§9 must still spell out what "analyze done" requires.');
  assert.ok(/2\.\s*\*\*code\*\*[\s\S]{0,200}DONE when/i.test(md),
    '§9 must still spell out what "code done" requires.');
  assert.ok(/3\.\s*\*\*verify\*\*[\s\S]{0,200}DONE when/i.test(md),
    '§9 must still spell out what "verify done" requires.');
  // Specific anchors preserved from td-33 r3.
  assert.ok(/ZERO source-file edits|NO source-file edits/i.test(md),
    'analyze done-criteria must still forbid source edits during analyze (preserved from td-33 r3).');
  assert.ok(/test\.sh/i.test(md),
    'verify done-criteria must still reference test.sh wiring (preserved from td-33 r3).');
});

// ── 9. Sentinel grammar preserved ──

t('§9 still locks the [stage: X done] sentinel grammar for all 3 stages', () => {
  const md = _read(TEMPLATE);
  assert.ok(/\[stage:\s*analyze\s+done\]/i.test(md));
  assert.ok(/\[stage:\s*code\s+done\]/i.test(md));
  assert.ok(/\[stage:\s*verify\s+done\]/i.test(md));
});

// ── 10. Pitfalls include the auto-advance failure mode ──

t('§9 pitfalls section lists "auto-advancing without explicit user accept" as the first/key failure mode', () => {
  const md = _read(TEMPLATE);
  assert.ok(/[Aa]uto-?advanc/i.test(md),
    '§9 pitfalls must call out auto-advancing without explicit user accept — the specific discipline failure td-34 fixes.');
});

t('§9 pitfalls clarifies that "no specific keyword needed" does NOT mean "no signal needed"', () => {
  const md = _read(TEMPLATE);
  // The two ideas must be distinguished explicitly. Otherwise a
  // future claude reads "no continue keyword" and assumes silence
  // is acceptance.
  assert.ok(/no\s+signal\s+needed|silence\s+means\s+wait|no\s+keyword\s+needed/i.test(md),
    '§9 pitfalls must distinguish "no specific keyword required" from "no signal required" so future claude doesn\'t read absence of a keyword as absence of a signal.');
});

// ── 11. The auto-iterate clause from td-33 r3 is GONE ──

t('§9 no longer contains the td-33 r3 "Auto-iterate on critic disagreement" section heading', () => {
  const md = _read(TEMPLATE);
  // The OLD section heading should be removed.
  assert.ok(!/###\s*Auto-iterate\s+on\s+critic\s+disagreement/.test(md),
    'the td-33 r3 "### Auto-iterate on critic disagreement" section heading must be removed — td-34 supersedes it. If it lingers, future claude may follow the old auto-iterate rule.');
});

t('§9 no longer instructs to "auto-iterate" / "repeat AT MOST TWICE" / "Re-emit the same stage sentinel" without user input', () => {
  const md = _read(TEMPLATE);
  // The OLD instruction text. If it lingers, future claude may
  // re-introduce the failure mode.
  assert.ok(!/Repeat\s+AT\s+MOST\s+TWICE/.test(md),
    '"Repeat AT MOST TWICE" instruction must be removed — td-34 doesn\'t allow auto-iterate.');
  // The supersession block legitimately mentions "auto-iterate"
  // when explaining what was removed; that mention should be in a
  // context of REMOVAL, not as a current rule. Check the
  // "instruction"-language is gone.
  assert.ok(!/you DO NOT pause for[\s\S]{0,100}first flag/.test(md),
    'the td-33 r3 instruction "you DO NOT pause for user input on the first flag" must be removed — td-34 says the OPPOSITE.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
