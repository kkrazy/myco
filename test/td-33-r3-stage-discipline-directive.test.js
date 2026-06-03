// td-33 r3: persistent 3-stage discipline directive in CLAUDE.md
// template + auto-iterate-up-to-2x on critic disagreement.
//
// User-requested in chat (verbatim):
//   "The critic should be kicked off at each stage: analyze, code,
//    test. Find a way to break the entire implementation into those
//    3 stages"
//   "Make the methodology persistent — update CLAUDE.md / critic.md
//    so future claude sessions also follow it"
//   "Auto-iterate — I address the critic's points + re-fire the
//    stage critique up to 2 times before pausing"
//
// Honest scope acknowledgment (flagged by Gemini at the analyze
// stage of this very work): the auto-iterate is DIRECTIVE-BASED.
// The server fires the critic + logs the sentinel, but claude is
// responsible for reading the verdict + applying the fix +
// re-emitting. Future server-side enforcement (e.g. auto-queuing
// a "address the critic feedback" prompt) is out of scope here —
// for now, discipline lives in the template, and the server-side
// log markers from td-33 give us auditability post-hoc.
//
// Test shape: static-grep that the §9 carries the new mandatory
// directive language + the auto-iterate clause + the stage gates +
// the td-33 r3 marker.

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

console.log('── td-33 r3: 3-stage discipline directive + auto-iterate ──');

t('best-practices-template.md: §9 uses MANDATORY directive language ("MUST structure"), not descriptive ("tends to")', () => {
  const md = _read('web/public/best-practices-template.md');
  // The §9 must contain the new MUST directive — not the prior
  // descriptive "tends to move through" framing.
  assert.ok(/claude\s+\*\*MUST\*\*|claude\s+MUST/i.test(md),
    '§9 must use mandatory "MUST" directive language so future claude sessions read it as a rule, not a description (td-33 r3).');
  // Negative: the old "tends to" descriptive language should be gone
  // (it was too soft — claude could ignore it without violating intent).
  assert.ok(!/claude\s+tends\s+to\s+move\s+through/i.test(md),
    'the pre-r3 "claude tends to move through" descriptive language should be replaced — too soft to enforce the methodology.');
});

t('best-practices-template.md: §9 lists explicit done-criteria for each stage (analyze / code / verify)', () => {
  const md = _read('web/public/best-practices-template.md');
  // Each stage gets a "DONE when ALL of:" block with a numbered list.
  assert.ok(/analyze[\s\S]{0,200}DONE when/i.test(md),
    '§9 must spell out what "analyze done" actually requires (td-33 r3 — without explicit criteria, claude can declare "done" prematurely).');
  assert.ok(/code[\s\S]{0,200}DONE when/i.test(md),
    '§9 must spell out what "code done" requires.');
  assert.ok(/verify[\s\S]{0,200}DONE when/i.test(md),
    '§9 must spell out what "verify done" requires.');
  // Specific criteria worth locking — the analyze gate's "NO source
  // edits yet" anti-pattern + the verify gate's test.sh-wiring.
  assert.ok(/ZERO source-file edits|NO source-file edits|no Edit\/Write/i.test(md),
    'analyze done-criteria must explicitly forbid source edits during analyze — the most common discipline failure is "I started coding before I finished planning."');
  assert.ok(/test\.sh|wired into.*test/i.test(md),
    'verify done-criteria must reference test.sh wiring so the regression test actually runs on future changes.');
});

t('best-practices-template.md: §9 carries the auto-iterate clause with an explicit 2-retry cap OR the td-34 supersession marker', () => {
  const md = _read('web/public/best-practices-template.md');
  // td-34 follow-up: td-33 r3's auto-iterate clause was replaced by
  // the explicit pause-and-await-accept 5-step loop (the user
  // empirically saw claude barrel through stages without giving
  // them a chance to review). The contract this test locks is now:
  // EITHER the auto-iterate clause is present (legacy td-33 r3 era)
  // OR a td-34 SUPERSEDES td-33 r3 marker is present (post-rewrite).
  // Pinning the auto-iterate clause as the only valid state would
  // re-lock the failure mode td-34 fixes.
  const hasAutoIterate = /auto-iterate|automatically iterate|AT MOST TWICE|at most twice|up to TWO/i.test(md);
  const hasSupersession = /td-34\s+SUPERSEDES\s+td-33\s+r3/i.test(md);
  assert.ok(hasAutoIterate || hasSupersession,
    '§9 must EITHER describe the auto-iterate behavior (legacy td-33 r3) OR carry a "td-34 SUPERSEDES td-33 r3" marker (post-rewrite). Neither was found — the methodology has drifted unmarked.');
});

t('best-practices-template.md: §9 carries a "behavioral honesty" section (directive-based vs server-enforced)', () => {
  const md = _read('web/public/best-practices-template.md');
  // Honest scope. Without this honesty, a future maintainer might
  // think there's server-side enforcement logic and break it.
  // td-34 follow-up: the honesty rule still applies but now to the
  // PAUSE between stages (not the auto-iterate). Either phrasing
  // satisfies — both are about distinguishing directive-based
  // claude-side discipline from server-enforced behavior.
  assert.ok(/directive-based|not server-enforced|relies on the directive|behavioral honesty|server-backed/i.test(md),
    '§9 must be honest about which bits are claude-side (directive-based) vs server-enforced — surfaces the limitation so future work can decide whether to add stronger server-side enforcement.');
});

t('best-practices-template.md: §9 still references all three sentinel patterns', () => {
  const md = _read('web/public/best-practices-template.md');
  // The td-33 r2 test already locks these; preserving them in r3 too.
  assert.ok(/\[stage:\s*analyze\s+done\]/i.test(md),
    '§9 must still show the [stage: analyze done] shape.');
  assert.ok(/\[stage:\s*code\s+done\]/i.test(md),
    '§9 must still show the [stage: code done] shape.');
  assert.ok(/\[stage:\s*verify\s+done\]/i.test(md),
    '§9 must still show the [stage: verify done] shape.');
});

t('best-practices-template.md: §9 limits scope to plan-item dispatches (not bare chat turns)', () => {
  const md = _read('web/public/best-practices-template.md');
  // Without scope-limiting language, claude might try to emit
  // sentinels on every reply — including conversational ones —
  // which would spam the critic + run up Gemini quota.
  assert.ok(/\[run:plan#|plan-item dispatch|bare chat turns|bare conversational/i.test(md),
    '§9 must scope the 3-stage methodology to [run:plan#X] dispatches — bare conversational turns shouldn\'t trigger stage critiques (cost + noise).');
});

t('best-practices-template.md: §9 lists common pitfalls so claude can self-correct', () => {
  const md = _read('web/public/best-practices-template.md');
  assert.ok(/[Cc]ommon pitfalls|[Pp]itfalls|common mistakes/i.test(md),
    '§9 must list common pitfalls (e.g. premature [stage: code done], skipping analyze on "simple" tasks) so claude can self-correct without the user having to flag them.');
  // The premature-emission pitfall is critical — it would trigger
  // critiques on half-done work.
  assert.ok(/premature[\s\S]{0,100}emission|still editing|half-done/i.test(md),
    'pitfalls must call out premature stage-sentinel emission specifically — it\'s the failure mode that wastes Gemini quota on incomplete work.');
});

t('a comment naming "td-33 r3" appears in the template (anchors future restyles)', () => {
  const md = _read('web/public/best-practices-template.md');
  assert.ok(/td-33 r3/.test(md),
    'a td-33 r3 marker must appear in §9 so future restyles understand the r3 directive-language layer is intentional, not boilerplate.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
