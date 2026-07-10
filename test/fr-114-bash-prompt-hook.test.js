// fr-114: bash prompt hook wires the fr-113 classifier into
// share/myco.bash so the accepted input line gets a green (shell) or
// magenta (chat) tint before it runs.
//
// This test locks the wiring — every JS rule set entry MUST appear
// literally in the bash mirror, the Enter hijack MUST be present, and
// the fr-109 sourcing contract (idempotency, silent load, reversible)
// MUST still hold.
//
// Why static-only tests: exercising bash-readline behavior end-to-end
// requires spawning a bash subprocess against a real TTY (`bind -x`
// depends on interactive readline + terminal input). That's flaky in
// containerized CI. Static grep guards catch every regression this
// slice cares about — if the wiring compiles at all, the runtime
// behavior follows.
//
// The five rule sets mirrored from cli/src/classifier.js:
//   BASH_RESERVED_WORDS (13 entries)
//   NL_ARTICLES         (3)
//   NL_PRONOUNS         (14)
//   NL_QUESTION         (7)
//   NL_MODAL            (9)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _readText(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── fr-114: bash prompt hook wires fr-113 classifier into share/myco.bash ──');

const bashSrc = _readText('cli/share/myco.bash');
const zshSrc  = _readText('cli/share/myco.zsh');
const argvSrc = _readText('cli/src/argv.js');

const classifier = require(path.join(__dirname, '..', 'cli', 'src', 'classifier.js'));
const {
  BASH_RESERVED_WORDS,
  NL_ARTICLES,
  NL_PRONOUNS,
  NL_QUESTION,
  NL_MODAL,
} = classifier;

// ──────────────────────────────────────────────────────────────────
// Group A: fr-109 sourcing contract preserved.

t('fr-109 contract: MYCO_INTEGRATE_LOADED idempotency guard still present', () => {
  assert.ok(/if\s+\[\s+-n\s+"\$MYCO_INTEGRATE_LOADED"\s+\]/.test(bashSrc),
    'sourcing twice must not double-hook the Enter bind — the idempotency guard is the ONLY thing between us and duplicate binds');
});

t('fr-109 contract: MYCO_INTEGRATE_LOADED=1 set on first load', () => {
  assert.ok(/^MYCO_INTEGRATE_LOADED=1$/m.test(bashSrc),
    'MYCO_INTEGRATE_LOADED must be set to 1 after the guard check — this is what makes re-source safe');
});

t('fr-114 marker: MYCO_INTEGRATE_VERSION bumped to "fr-114"', () => {
  assert.ok(/export\s+MYCO_INTEGRATE_VERSION="fr-114"/.test(bashSrc),
    'MYCO_INTEGRATE_VERSION must announce fr-114 — the fr-109 stub had "fr-109-stub"; the bump is the version fingerprint');
});

// ──────────────────────────────────────────────────────────────────
// Group B: classifier function skeleton — the 3 helpers + the driver.

t('bash defines _myco_is_reserved function', () => {
  assert.ok(/_myco_is_reserved\s*\(\s*\)/.test(bashSrc),
    '_myco_is_reserved must exist — it mirrors JS BASH_RESERVED_WORDS check');
});

t('bash defines _myco_is_nl_word function', () => {
  assert.ok(/_myco_is_nl_word\s*\(\s*\)/.test(bashSrc),
    '_myco_is_nl_word must exist — it mirrors JS isNaturalLanguageWord()');
});

t('bash defines _myco_classify function (the driver)', () => {
  assert.ok(/_myco_classify\s*\(\s*\)/.test(bashSrc),
    '_myco_classify must exist — it runs the 5 rules in order');
});

t('bash defines _myco_accept_line function (Enter hijack)', () => {
  assert.ok(/_myco_accept_line\s*\(\s*\)/.test(bashSrc),
    '_myco_accept_line must exist — it is the target of the \\C-m bind');
});

// ──────────────────────────────────────────────────────────────────
// Group C: drift guard — every JS rule set entry appears literally in
// the bash file. This is the primary regression brake against JS/bash
// drift. Parametrized across all five sets.

function assertMirrored(setName, jsSet) {
  const missing = [];
  for (const word of jsSet) {
    // Word boundary so `if` matches at token boundaries, not inside `nifty`.
    const pat = new RegExp('\\b' + word.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&') + '\\b');
    if (!pat.test(bashSrc)) missing.push(word);
  }
  assert.strictEqual(missing.length, 0,
    `bash file must mirror every JS ${setName} entry — missing: ${missing.join(', ')}. If you added a word to the JS set, add it to the case statement in share/myco.bash.`);
}

t('drift guard: every BASH_RESERVED_WORDS entry (13) appears in the bash file', () => {
  assertMirrored('BASH_RESERVED_WORDS', BASH_RESERVED_WORDS);
});

t('drift guard: every NL_ARTICLES entry (3) appears in the bash file', () => {
  assertMirrored('NL_ARTICLES', NL_ARTICLES);
});

t('drift guard: every NL_PRONOUNS entry (14) appears in the bash file', () => {
  assertMirrored('NL_PRONOUNS', NL_PRONOUNS);
});

t('drift guard: every NL_QUESTION entry (7) appears in the bash file', () => {
  assertMirrored('NL_QUESTION', NL_QUESTION);
});

t('drift guard: every NL_MODAL entry (9) appears in the bash file', () => {
  assertMirrored('NL_MODAL', NL_MODAL);
});

// ──────────────────────────────────────────────────────────────────
// Group D: the Enter hijack + color feedback.

t('bind -x on \\C-m (Enter) is registered inside an interactive-only guard', () => {
  // The bind MUST be gated by `[[ $- == *i* ]]` so non-interactive
  // subshells (script runs, cron, CI) get the classifier functions
  // but no key bind — sourcing this file in a script must not break it.
  assert.ok(/\[\[\s*\$-\s*==\s*\*i\*\s*\]\]/.test(bashSrc),
    'the bind -x must be gated by an interactive-shell check — otherwise scripts sourcing myco integrate --bash would break');
  assert.ok(/bind\s+-x\s+'"\\C-m":\s+_myco_accept_line'/.test(bashSrc),
    'the bind -x on \\C-m calling _myco_accept_line is the primary UX wiring — must be present');
});

t('ANSI green (32m) code is emitted on shell verdicts', () => {
  const body = fnBody(bashSrc, /_myco_accept_line\s*\(/);
  assert.ok(body, '_myco_accept_line body must be locatable');
  assert.ok(/\\e\[32m/.test(body) || /\\033\[32m/.test(body),
    '_myco_accept_line must emit ANSI green (\\e[32m or \\033[32m) on shell verdicts — this is the visual "shell" signal');
});

t('ANSI magenta (35m) code is emitted on chat verdicts', () => {
  const body = fnBody(bashSrc, /_myco_accept_line\s*\(/);
  assert.ok(/\\e\[35m/.test(body) || /\\033\[35m/.test(body),
    '_myco_accept_line must emit ANSI magenta (\\e[35m or \\033[35m) on chat verdicts — this is the visual "chat" signal');
});

t('ANSI reset (0m) code is emitted so color does not bleed into subsequent output', () => {
  const body = fnBody(bashSrc, /_myco_accept_line\s*\(/);
  assert.ok(/\\e\[0m/.test(body) || /\\033\[0m/.test(body),
    'accept-line must reset color (\\e[0m) after the tint — otherwise every subsequent output line stays colored');
});

t('chat verdict prints an educational hint mentioning myco chat', () => {
  const body = fnBody(bashSrc, /_myco_accept_line\s*\(/);
  assert.ok(/myco chat/.test(body),
    'chat verdicts must show a hint mentioning `myco chat` — until fr-116 wires the real client, the hint is how users learn the routing');
});

t('_myco_accept_line uses eval (not source) to run the line — bash idiom for interactive command exec', () => {
  const body = fnBody(bashSrc, /_myco_accept_line\s*\(/);
  assert.ok(/eval\s+"\$line"/.test(body),
    '_myco_accept_line must eval the line — that is the bash idiom for running an interactive command from a bind -x hook (source would fork behavior)');
});

t('_myco_accept_line pushes into history via `history -s`', () => {
  const body = fnBody(bashSrc, /_myco_accept_line\s*\(/);
  assert.ok(/history\s+-s\s+--\s+"\$line"/.test(body),
    'accept-line must push to history — otherwise up-arrow recall breaks under the hijack');
});

t('_myco_accept_line clears READLINE_LINE after execution so the next prompt is fresh', () => {
  const body = fnBody(bashSrc, /_myco_accept_line\s*\(/);
  assert.ok(/READLINE_LINE=""/.test(body),
    'clear READLINE_LINE after eval — otherwise bash draws the just-run command as the next prompt content');
});

// ──────────────────────────────────────────────────────────────────
// Group E: classifier rule ordering documented (RULE 2 first).
// The bash port must run rule 2 (reserved) BEFORE rule 1 (command -v)
// or `do` would incorrectly route to shell (bash reports it as a
// command-v hit — it's a keyword). Static-check that reserved runs
// before command -v in the classify function.

t('rule ordering: _myco_is_reserved is called BEFORE `command -v` inside _myco_classify', () => {
  const body = fnBody(bashSrc, /_myco_classify\s*\(/);
  assert.ok(body, '_myco_classify body must be locatable');
  const reservedAt = body.search(/_myco_is_reserved/);
  const commandAt  = body.search(/command\s+-v/);
  assert.ok(reservedAt >= 0 && commandAt >= 0,
    'both _myco_is_reserved and `command -v` must appear inside _myco_classify');
  assert.ok(reservedAt < commandAt,
    'rule 2 (reserved) must run BEFORE rule 1 (command -v) — otherwise bash keywords like `do` would fake a rule-1 hit and route to shell');
});

t('rule ordering: trailing `?` check runs BEFORE the NL-in-rest loop', () => {
  const body = fnBody(bashSrc, /_myco_classify\s*\(/);
  const questionAt = body.search(/\\\?\[\[:space:\]\]\*\$/);
  const nlLoopAt   = body.search(/_myco_is_nl_word/);
  assert.ok(questionAt >= 0 && nlLoopAt >= 0,
    'both the trailing-? regex and the NL-loop must appear inside _myco_classify');
  assert.ok(questionAt < nlLoopAt,
    'rule 4a (trailing ?) must run before rule 4b (NL in rest) — otherwise `top 5 memory hogs?` would emit NL_IN_REST instead of QUESTION_MARK-flavored classification');
});

// ──────────────────────────────────────────────────────────────────
// Group F: zsh stub UNCHANGED (fr-114 scope guard — zsh port deferred).

t('scope guard: zsh stub still says "fr-109 stub" — fr-114 does NOT touch zsh', () => {
  assert.ok(/fr-109/.test(zshSrc),
    'share/myco.zsh must still be the fr-109 stub — fr-114 scope was bash-only. The zsh port lands in a later slice.');
});

t('scope guard: zsh stub is short (< 40 lines) — no accidental porting', () => {
  const lineCount = zshSrc.split('\n').length;
  assert.ok(lineCount < 40,
    `share/myco.zsh must remain a short stub (got ${lineCount} lines) — if this grew, fr-114 accidentally touched the zsh side. Roll back or split the slice.`);
});

// ──────────────────────────────────────────────────────────────────
// Group G: comment header + drift-guard warning documented.

t('comment header: mentions fr-114 and the classifier wiring rationale', () => {
  assert.ok(/fr-114/.test(bashSrc),
    'the top comment header must document that this is fr-114 — future contributors reading share/myco.bash need to know which slice added the hijack');
});

t('comment header: mirror-warning tells contributors to keep bash + JS in sync', () => {
  assert.ok(/MIRROR/i.test(bashSrc) && /classifier\.js/.test(bashSrc),
    'the comment header must warn that the rule sets MIRROR cli/src/classifier.js so future contributors know to update both when adding a word');
});

t('comment header: no stale "fr-110 will replace" placeholder left over', () => {
  assert.ok(!/fr-110 will replace/i.test(bashSrc),
    'the fr-109-stub placeholder "fr-110 will replace…" must be gone — leaving it there implies fr-114 hasn\'t landed yet, which lies to future readers');
});

// ──────────────────────────────────────────────────────────────────
// Group H: argv.js helpText refreshed to reflect fr-114 as this release.

t('argv.js helpText: fr-114 labeled "this release"', () => {
  assert.ok(/fr-114.*Bash prompt hook.*this release/.test(argvSrc),
    'argv.js helpText must mark fr-114 as "this release" — the user-visible roadmap shifts with each phase');
});

t('argv.js helpText: fr-115 + fr-116 are still labeled as upcoming (planned)', () => {
  assert.ok(/fr-115/.test(argvSrc) && /fr-116/.test(argvSrc),
    'argv.js helpText must retain fr-115 + fr-116 labels — dropping them would strand the roadmap');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
