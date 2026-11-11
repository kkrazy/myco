// fr-115: zsh port of the fr-114 bash prompt hook.
//
// Wires the fr-113 5-rule classifier into share/myco.zsh via a zle
// widget bound to Enter (`^M`) in both emacs and vi-insert modes. Same
// green/magenta color feedback fr-114 gives bash users; same 46-word
// drift guard against JS.
//
// This test locks the zsh wiring — every JS rule set entry MUST appear
// literally in share/myco.zsh (same drift guard fr-114 established for
// share/myco.bash), the zle widget registration MUST be present, and
// the fr-109 sourcing contract (idempotency, silent load, reversible)
// MUST still hold.
//
// Why static-only tests: (a) the sandbox has no zsh interpreter, and
// (b) zle widgets need an interactive shell with a real TTY. Static
// grep guards catch every regression this slice cares about — if the
// wiring is right, the runtime behavior follows. fr-114 uses the same
// approach for bash and it's held clean across two commits.
//
// Mirror sets from cli/src/classifier.js (verify against JS at test
// load-time so a JS-only edit that renames a set surfaces immediately):
//   BASH_RESERVED_WORDS (13)
//   NL_ARTICLES         (3)
//   NL_PRONOUNS         (14)
//   NL_QUESTION         (7)
//   NL_MODAL            (9)
//                        = 46 words total

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

console.log('── fr-115: zsh port of the bash prompt hook (share/myco.zsh) ──');

const zshSrc  = _readText('cli/share/myco.zsh');
const bashSrc = _readText('cli/share/myco.bash');
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

t('fr-109 contract: MYCO_INTEGRATE_LOADED idempotency guard still present in zsh', () => {
  assert.ok(/if\s+\[\s+-n\s+"\$MYCO_INTEGRATE_LOADED"\s+\]/.test(zshSrc),
    'sourcing the zsh file twice must not double-hook the Enter bind — the idempotency guard is the ONLY thing between us and duplicate widget bindings');
});

t('fr-109 contract: MYCO_INTEGRATE_LOADED=1 set on first load (zsh)', () => {
  assert.ok(/^MYCO_INTEGRATE_LOADED=1$/m.test(zshSrc),
    'MYCO_INTEGRATE_LOADED must be set to 1 after the guard check — this is what makes re-source safe on zsh too');
});

t('fr-115 marker: zsh MYCO_INTEGRATE_VERSION set to fr-1XX release label', () => {
  assert.ok(/export\s+MYCO_INTEGRATE_VERSION="fr-1\d\d"/.test(zshSrc),
    'zsh must set MYCO_INTEGRATE_VERSION to a fr-1XX release label — matches bash so `echo $MYCO_INTEGRATE_VERSION` reports the same value regardless of which shell you sourced');
});

t('release convergence: zsh + bash share the same MYCO_INTEGRATE_VERSION value', () => {
  const zshVer  = zshSrc.match(/MYCO_INTEGRATE_VERSION="(fr-1\d\d)"/);
  const bashVer = bashSrc.match(/MYCO_INTEGRATE_VERSION="(fr-1\d\d)"/);
  assert.ok(zshVer && bashVer, 'both files must set MYCO_INTEGRATE_VERSION');
  assert.strictEqual(zshVer[1], bashVer[1],
    `MYCO_INTEGRATE_VERSION must match across shells (got zsh=${zshVer[1]}, bash=${bashVer[1]}). Version tracks the RELEASE — bump both together.`);
});

// ──────────────────────────────────────────────────────────────────
// Group B: classifier function skeleton — same 3 helpers + accept-line
// widget, zsh-flavored bodies.

t('zsh defines _myco_is_reserved function', () => {
  assert.ok(/_myco_is_reserved\s*\(\s*\)/.test(zshSrc),
    '_myco_is_reserved must exist — mirrors bash + JS BASH_RESERVED_WORDS check');
});

t('zsh defines _myco_is_nl_word function', () => {
  assert.ok(/_myco_is_nl_word\s*\(\s*\)/.test(zshSrc),
    '_myco_is_nl_word must exist — mirrors bash + JS isNaturalLanguageWord');
});

t('zsh defines _myco_classify function (5-rule driver)', () => {
  assert.ok(/_myco_classify\s*\(\s*\)/.test(zshSrc),
    '_myco_classify must exist — the 5-rule driver');
});

t('zsh defines _myco_accept_line function (zle widget target)', () => {
  assert.ok(/_myco_accept_line\s*\(\s*\)/.test(zshSrc),
    '_myco_accept_line must exist — it is the target of the zle -N widget registration');
});

// ──────────────────────────────────────────────────────────────────
// Group C: drift guard — every JS rule set entry appears literally in
// the zsh mirror. Same helper fr-114 uses for bash.

function assertMirrored(setName, jsSet) {
  const missing = [];
  for (const word of jsSet) {
    const pat = new RegExp('\\b' + word.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&') + '\\b');
    if (!pat.test(zshSrc)) missing.push(word);
  }
  assert.strictEqual(missing.length, 0,
    `share/myco.zsh must mirror every JS ${setName} entry — missing: ${missing.join(', ')}. If you added a word to the JS set, add it to the case statement in share/myco.zsh (and share/myco.bash — fr-114's drift guard catches that).`);
}

t('drift guard: every BASH_RESERVED_WORDS entry (13) appears in the zsh file', () => {
  assertMirrored('BASH_RESERVED_WORDS', BASH_RESERVED_WORDS);
});

t('drift guard: every NL_ARTICLES entry (3) appears in the zsh file', () => {
  assertMirrored('NL_ARTICLES', NL_ARTICLES);
});

t('drift guard: every NL_PRONOUNS entry (14) appears in the zsh file', () => {
  assertMirrored('NL_PRONOUNS', NL_PRONOUNS);
});

t('drift guard: every NL_QUESTION entry (7) appears in the zsh file', () => {
  assertMirrored('NL_QUESTION', NL_QUESTION);
});

t('drift guard: every NL_MODAL entry (9) appears in the zsh file', () => {
  assertMirrored('NL_MODAL', NL_MODAL);
});

// ──────────────────────────────────────────────────────────────────
// Group D: zle widget registration + Enter bind for both editing modes.

t('zle widget registered: `zle -N _myco_accept_line`', () => {
  assert.ok(/zle\s+-N\s+_myco_accept_line/.test(zshSrc),
    'the zle widget must be registered via `zle -N _myco_accept_line` — this is the zsh equivalent of bash bind -x');
});

t('Enter bound in emacs mode: `bindkey -M emacs \'^M\' _myco_accept_line`', () => {
  assert.ok(/bindkey\s+-M\s+emacs\s+'\^M'\s+_myco_accept_line/.test(zshSrc),
    'Enter (\\^M) must be bound to the widget in emacs mode — most zsh users default to emacs bindings');
});

t('Enter bound in vi-insert mode: `bindkey -M viins \'^M\' _myco_accept_line`', () => {
  assert.ok(/bindkey\s+-M\s+viins\s+'\^M'\s+_myco_accept_line/.test(zshSrc),
    'Enter must also be bound in vi-insert mode — vi-mode zsh users would otherwise get no color feedback');
});

t('widget registration is inside an interactive-only guard', () => {
  // Same rationale as fr-114: scripts sourcing this file must not break.
  // The zsh idiom is `[[ -o interactive ]]` (cleaner than checking $-).
  assert.ok(/\[\[\s*-o\s+interactive\s*\]\]/.test(zshSrc),
    'the zle registration must be gated by `[[ -o interactive ]]` — non-interactive scripts sourcing myco integrate --zsh must not break');
});

// ──────────────────────────────────────────────────────────────────
// Group E: color feedback + chat hint.

t('ANSI green (32m) code is emitted on shell verdicts', () => {
  const body = fnBody(zshSrc, /_myco_accept_line\s*\(/);
  assert.ok(body, '_myco_accept_line body must be locatable');
  assert.ok(/\\e\[32m/.test(body) || /\\033\[32m/.test(body),
    '_myco_accept_line must emit ANSI green (\\e[32m or \\033[32m) on shell verdicts — the visual "shell" signal');
});

t('ANSI magenta (35m) code is emitted on chat verdicts', () => {
  const body = fnBody(zshSrc, /_myco_accept_line\s*\(/);
  assert.ok(/\\e\[35m/.test(body) || /\\033\[35m/.test(body),
    '_myco_accept_line must emit ANSI magenta (\\e[35m or \\033[35m) on chat verdicts — the visual "chat" signal');
});

t('ANSI reset (0m) code is emitted so color does not bleed', () => {
  const body = fnBody(zshSrc, /_myco_accept_line\s*\(/);
  assert.ok(/\\e\[0m/.test(body) || /\\033\[0m/.test(body),
    'accept-line must reset color after the tint — otherwise every subsequent line stays colored');
});

t('chat verdict prints an educational hint mentioning `myco chat`', () => {
  const body = fnBody(zshSrc, /_myco_accept_line\s*\(/);
  assert.ok(/myco chat/.test(body),
    'chat verdicts must show an educational hint mentioning `myco chat` — matches bash; teaches the user before fr-117 wires real routing');
});

// ──────────────────────────────────────────────────────────────────
// Group F: rule ordering (must match fr-113 + fr-114).

t('rule ordering: _myco_is_reserved is called BEFORE `command -v` inside _myco_classify', () => {
  const body = fnBody(zshSrc, /_myco_classify\s*\(/);
  assert.ok(body, '_myco_classify body must be locatable');
  const reservedAt = body.search(/_myco_is_reserved/);
  const commandAt  = body.search(/command\s+-v/);
  assert.ok(reservedAt >= 0 && commandAt >= 0,
    'both _myco_is_reserved and `command -v` must appear inside _myco_classify');
  assert.ok(reservedAt < commandAt,
    'rule 2 (reserved) must run BEFORE rule 1 (command -v) — otherwise zsh keywords like `do` would fake a rule-1 hit and route to shell');
});

t('rule ordering: trailing `?` check runs BEFORE the NL-in-rest loop', () => {
  const body = fnBody(zshSrc, /_myco_classify\s*\(/);
  const questionAt = body.search(/\\\?\[\[:space:\]\]/);
  const nlLoopAt   = body.search(/_myco_is_nl_word/);
  assert.ok(questionAt >= 0 && nlLoopAt >= 0,
    'both the trailing-? regex and the NL-loop must appear inside _myco_classify');
  assert.ok(questionAt < nlLoopAt,
    'rule 4a (trailing ?) must run before rule 4b (NL in rest) — matches fr-114 bash and fr-113 JS ordering');
});

// ──────────────────────────────────────────────────────────────────
// Group G: zsh-specific idioms (1-indexed arrays, lowercase, .accept-line).

t('zsh idiom: uses `zle .accept-line` for the native accept hand-off', () => {
  const body = fnBody(zshSrc, /_myco_accept_line\s*\(/);
  assert.ok(/zle\s+\.accept-line/.test(body),
    '_myco_accept_line must delegate to `zle .accept-line` — this is zsh\'s native "run the line as command + push history" widget. Missing it would leave BUFFER unaccepted and the shell hangs on Enter.');
});

t('zsh idiom: reads $BUFFER (not $READLINE_LINE) — zsh\'s widget-local line var', () => {
  const body = fnBody(zshSrc, /_myco_accept_line\s*\(/);
  assert.ok(/\$BUFFER/.test(body),
    '_myco_accept_line must read $BUFFER — zsh\'s widget-local line variable. Using $READLINE_LINE would work in bash but not here.');
});

t('zsh idiom: rest-token loop starts at index 2 (1-indexed arrays)', () => {
  const body = fnBody(zshSrc, /_myco_classify\s*\(/);
  // Look for either `((i = 2` (C-style) or `{2..` (brace expansion range).
  assert.ok(/\(\(\s*i\s*=\s*2/.test(body) || /\{2\.\.\$\{#tokens\}\}/.test(body),
    'rest-token loop must start at index 2 in zsh — arrays are 1-indexed here, unlike bash where the loop starts at 1');
});

// ──────────────────────────────────────────────────────────────────
// Group H: comment header + drift-guard warning documented.

t('comment header: mentions fr-115 and the classifier wiring rationale', () => {
  assert.ok(/fr-115/.test(zshSrc),
    'the top comment header must document that this is fr-115 — future contributors reading share/myco.zsh need to know which slice added the port');
});

t('comment header: MIRROR warning names both classifier.js AND share/myco.bash', () => {
  // Zsh mirror has TWO sources to sync with: the JS canonical set and
  // the bash mirror. Make sure the warning names both so contributors
  // don't fix one and forget the other.
  assert.ok(/MIRROR/i.test(zshSrc) && /classifier\.js/.test(zshSrc),
    'the comment header must warn that the rule sets MIRROR cli/src/classifier.js — the drift guard depends on future contributors reading this');
  assert.ok(/myco\.bash/.test(zshSrc),
    'the comment header must also name share/myco.bash — the zsh port has TWO mirrors to keep in sync (JS + bash sibling)');
});

t('comment header: no stale "fr-109 stub" placeholder left over', () => {
  assert.ok(!/fr-109 stub/.test(zshSrc),
    'the "zsh integration stub (fr-109 skeleton)" placeholder must be gone — leaving it there implies the zsh port hasn\'t landed');
});

// ──────────────────────────────────────────────────────────────────
// Group I: argv.js helpText — fr-115 = "this release."

t('argv.js helpText: fr-115 labeled "this release"', () => {
  assert.ok(/fr-115.*this release/i.test(argvSrc) || /fr-115.*Zsh.*this release/i.test(argvSrc),
    'argv.js helpText must mark fr-115 as "this release" — the user-visible roadmap shifts with each phase');
});

t('argv.js helpText: fr-115 line mentions zsh (the port\'s user-facing feature)', () => {
  assert.ok(/fr-115.*[Zz]sh/.test(argvSrc),
    'argv.js helpText must describe fr-115 in terms of the zsh port — otherwise users see "this release" with no clue what shipped');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
