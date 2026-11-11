// fr-113: pure Lacy Shell 5-rule classifier at cli/src/classifier.js.
// Deterministic decision — is the line the user just typed a shell
// command, or a chat message? Runs in <1ms with no I/O.
//
// This test file locks the rule ordering + return shape + all five
// rules' individual behaviour so downstream work (fr-114 bash prompt
// hook, fr-115 tool endpoints, fr-116 chat client, fr-117 VSCode
// extension) can rely on classifyInput as a stable primitive.
//
// The five rules (rule 5 — post-exec silent re-route — lives in the
// shell integration layer, NOT the classifier):
//   1. `command -v <first>` returns non-zero → chat
//   2. First token is a bash reserved word → chat
//   3. Single-word input that passed 1+2 → shell
//   4a. Line ends with `?` → chat
//   4b. Multi-word with NL word in the rest → chat
//   4c. Multi-word real command, no NL, no `?` → shell
//
// Rule ordering matters: rule 2 (reserved) runs BEFORE rule 1
// (command -v) because bash reports keywords as `command -v` hits,
// and we'd erroneously send `do` to shell if we ran rule 1 first.
// This test file locks that ordering explicitly.

const assert = require('assert');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const classifierPath = path.join(__dirname, '..', 'cli', 'src', 'classifier.js');
const {
  classifyInput,
  isNaturalLanguageWord,
  tokenize,
  BASH_RESERVED_WORDS,
  NL_ARTICLES,
  NL_PRONOUNS,
  NL_QUESTION,
  NL_MODAL,
  VERDICT,
  RULE,
} = require(classifierPath);

console.log('── fr-113: pure Lacy Shell 5-rule classifier (cli/src/classifier.js) ──');

// A realistic pathCache — the set of "known executables on $PATH."
// fr-114 will build this at shell start from a real $PATH walk; here
// we just enumerate the commands the tests care about.
const PATH_CACHE = new Set([
  'ls', 'pwd', 'cd', 'top', 'vim', 'vi', 'nano',
  'git', 'npm', 'node', 'python', 'python3', 'docker',
  'grep', 'find', 'awk', 'sed', 'cat', 'echo', 'test',
  'curl', 'wget', 'ssh', 'scp', 'kubectl', 'make',
  'myco', 'ps', 'kill', 'df', 'du', 'free', 'uname',
]);

// ──────────────────────────────────────────────────────────────────
// Group A: exports + basic module shape.

t('exports classifyInput as a function', () => {
  assert.strictEqual(typeof classifyInput, 'function',
    'classifyInput must be exported as a function — it is the single entry point callers rely on');
});

t('exports the four NL sets + reserved words', () => {
  for (const [name, set] of Object.entries({ BASH_RESERVED_WORDS, NL_ARTICLES, NL_PRONOUNS, NL_QUESTION, NL_MODAL })) {
    assert.ok(set instanceof Set,
      `${name} must be exported as a Set — tests + fr-115 skills injection compose against these`);
    assert.ok(set.size > 0, `${name} must be non-empty`);
  }
});

t('exports VERDICT + RULE enums with the shell/chat verdicts', () => {
  assert.strictEqual(VERDICT.SHELL, 'shell', 'VERDICT.SHELL must be the string "shell" — serialized across bash-hook boundary');
  assert.strictEqual(VERDICT.CHAT, 'chat', 'VERDICT.CHAT must be the string "chat"');
  assert.ok(RULE.EMPTY && RULE.RESERVED && RULE.UNKNOWN_CMD && RULE.SINGLE_KNOWN
    && RULE.QUESTION_MARK && RULE.NL_IN_REST && RULE.MULTI_SHELL,
    'RULE must expose the identifiers for every rule branch so the UX layer can surface WHICH rule fired');
});

t('exports helper functions isNaturalLanguageWord + tokenize', () => {
  assert.strictEqual(typeof isNaturalLanguageWord, 'function',
    'isNaturalLanguageWord must be exported — fr-115 skills-aware classification composes on it');
  assert.strictEqual(typeof tokenize, 'function',
    'tokenize must be exported for the same reason');
});

// ──────────────────────────────────────────────────────────────────
// Group B: return-shape contract.

t('return shape: { verdict, rule, tokens } for every branch', () => {
  const cases = ['', 'ls', 'do', 'unknownxyz', 'top 5 memory hogs?', 'test the login', 'git commit -am fix'];
  for (const line of cases) {
    const r = classifyInput(line, { pathCache: PATH_CACHE });
    assert.ok(r && typeof r.verdict === 'string' && typeof r.rule === 'string' && Array.isArray(r.tokens),
      `classifyInput(${JSON.stringify(line)}) must return { verdict:string, rule:string, tokens:string[] } — got ${JSON.stringify(r)}`);
  }
});

// ──────────────────────────────────────────────────────────────────
// Group C: empty / whitespace input.

t('empty input → { verdict:shell, rule:EMPTY, tokens:[] }', () => {
  const r = classifyInput('', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.SHELL, 'empty input must default to shell (bare Enter is a shell no-op, not a chat message)');
  assert.strictEqual(r.rule, RULE.EMPTY);
  assert.deepStrictEqual(r.tokens, []);
});

t('whitespace-only input → shell + EMPTY (nothing to route)', () => {
  const r = classifyInput('    \t  ', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.SHELL);
  assert.strictEqual(r.rule, RULE.EMPTY);
});

t('null / undefined input tolerated (no throw)', () => {
  const r1 = classifyInput(null);
  const r2 = classifyInput(undefined);
  assert.strictEqual(r1.rule, RULE.EMPTY, 'null must degrade to empty-input, not throw');
  assert.strictEqual(r2.rule, RULE.EMPTY, 'undefined must degrade to empty-input, not throw');
});

// ──────────────────────────────────────────────────────────────────
// Group D: rule 2 — bash reserved words → chat (runs FIRST).

t('rule 2: `do` alone → chat (reserved word, would erroneously pass rule 1)', () => {
  const r = classifyInput('do', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT,
    '`do` is a bash reserved keyword — `command -v do` succeeds but typing `do` alone is a syntax error, so it must route to chat');
  assert.strictEqual(r.rule, RULE.RESERVED);
});

t('rule 2: `then`, `else`, `fi`, `esac`, `for`, `while`, `if`, `case` all → chat', () => {
  for (const w of ['then', 'else', 'fi', 'esac', 'for', 'while', 'if', 'case', 'until', 'select', 'function', 'time', 'in']) {
    const r = classifyInput(w, { pathCache: PATH_CACHE });
    assert.strictEqual(r.verdict, VERDICT.CHAT, `\`${w}\` (bash reserved) must route to chat`);
    assert.strictEqual(r.rule, RULE.RESERVED, `\`${w}\` must fire the RESERVED rule`);
  }
});

t('rule 2: case-insensitive match — `DO`, `For` also chat', () => {
  const r1 = classifyInput('DO', { pathCache: PATH_CACHE });
  const r2 = classifyInput('For', { pathCache: PATH_CACHE });
  assert.strictEqual(r1.rule, RULE.RESERVED, 'reserved-word check must be case-insensitive');
  assert.strictEqual(r2.rule, RULE.RESERVED, 'reserved-word check must be case-insensitive');
});

t('rule 2 fires BEFORE rule 1 — even without pathCache, `do` → chat', () => {
  // Critical ordering guarantee. Even in an environment where rule 1 is
  // skipped (no pathCache), reserved words must still route to chat.
  const r = classifyInput('do');
  assert.strictEqual(r.rule, RULE.RESERVED,
    'reserved-word rule must fire before rule 1 (pathCache lookup) — otherwise ordering breaks when both apply');
});

// ──────────────────────────────────────────────────────────────────
// Group E: rule 1 — unknown command (command -v miss) → chat.

t('rule 1: unknown first token → chat when pathCache is provided', () => {
  const r = classifyInput('supercalifragilistic', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT,
    '`command -v supercalifragilistic` misses → route to chat');
  assert.strictEqual(r.rule, RULE.UNKNOWN_CMD);
});

t('rule 1: multi-word unknown first token → still chat', () => {
  const r = classifyInput('flurgle the widget', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT);
  assert.strictEqual(r.rule, RULE.UNKNOWN_CMD,
    'unknown-command check runs on the first token regardless of what follows — `flurgle` is not on PATH');
});

t('rule 1: SKIPPED when pathCache is absent (permissive fallback)', () => {
  // Without a pathCache the classifier can't run command -v — it should
  // permissively assume the first token IS a command and defer to
  // rules 3/4. This is the "no bash integration yet" fallback path.
  const r = classifyInput('unknownxyz', {});
  assert.strictEqual(r.verdict, VERDICT.SHELL,
    'without pathCache, single-word input must fall through to rule 3 (assume command) — not fire rule 1');
  assert.strictEqual(r.rule, RULE.SINGLE_KNOWN);
});

t('rule 1: case-SENSITIVE (`Git` misses even though `git` is on PATH)', () => {
  // Linux/macOS filesystems are case-sensitive for binaries. `Git` and
  // `git` are different files. The classifier must not do a case-fold
  // for rule 1 or it will report `Git` as a known command when it isn't.
  const r = classifyInput('Git', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT,
    'rule 1 must be case-sensitive — `Git` is not `git` on Linux/macOS');
  assert.strictEqual(r.rule, RULE.UNKNOWN_CMD);
});

// ──────────────────────────────────────────────────────────────────
// Group F: rule 3 — single-word known command → shell.

t('rule 3: `ls`, `pwd`, `git`, `top`, `vim` all → shell (single known command)', () => {
  for (const w of ['ls', 'pwd', 'git', 'top', 'vim']) {
    const r = classifyInput(w, { pathCache: PATH_CACHE });
    assert.strictEqual(r.verdict, VERDICT.SHELL, `single-word \`${w}\` must route to shell`);
    assert.strictEqual(r.rule, RULE.SINGLE_KNOWN, `\`${w}\` must fire the SINGLE_KNOWN rule`);
  }
});

t('rule 3: tokens preserved as a length-1 array', () => {
  const r = classifyInput('ls', { pathCache: PATH_CACHE });
  assert.deepStrictEqual(r.tokens, ['ls'], 'tokens field must round-trip the input');
});

// ──────────────────────────────────────────────────────────────────
// Group G: rule 4a — line ends with `?` → chat.

t('rule 4a: `top 5 memory hogs?` → chat despite `top` being a known command', () => {
  const r = classifyInput('top 5 memory hogs?', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT,
    'trailing `?` is a strong chat signal — even when the first token is a real command like `top`');
  assert.strictEqual(r.rule, RULE.QUESTION_MARK);
});

t('rule 4a: trailing whitespace after `?` still fires', () => {
  const r = classifyInput('git log?   ', { pathCache: PATH_CACHE });
  assert.strictEqual(r.rule, RULE.QUESTION_MARK,
    '`?` followed only by whitespace must still fire — users copy-paste with trailing spaces all the time');
});

t('rule 4a: `?` in the middle does NOT fire — only trailing counts', () => {
  const r = classifyInput('grep -E "foo?" file.txt', { pathCache: PATH_CACHE });
  assert.notStrictEqual(r.rule, RULE.QUESTION_MARK,
    '`?` inside a regex/glob argument is not a chat signal — only trailing `?` (with optional whitespace) counts');
  assert.strictEqual(r.verdict, VERDICT.SHELL);
});

// ──────────────────────────────────────────────────────────────────
// Group H: rule 4b — multi-word with NL word in rest → chat.

t('rule 4b: `test the login flow` → chat (article `the` in rest)', () => {
  const r = classifyInput('test the login flow', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT,
    '`test` is a real command, but `the` in the rest tokens is an English article — routes to chat');
  assert.strictEqual(r.rule, RULE.NL_IN_REST);
});

t('rule 4b: `git commit strategy discussion` — no NL word, so falls through to 4c', () => {
  // `strategy` and `discussion` are English but not in any of our NL
  // sets (articles, pronouns, question, modal). The classifier is
  // deliberately not English-comprehensive; it looks for STRONG NL
  // signals. So this line stays shell.
  const r = classifyInput('git commit strategy discussion', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.SHELL,
    'the NL detector is scoped to strong signals (articles/pronouns/question/modal) — plain nouns like `strategy` do not trigger it');
});

t('rule 4b: pronoun `this` in rest → chat', () => {
  const r = classifyInput('grep this file for foo', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT);
  assert.strictEqual(r.rule, RULE.NL_IN_REST,
    '`this` in the rest tokens signals NL intent — route to chat');
});

t('rule 4b: question word `what` in rest → chat', () => {
  const r = classifyInput('git show what files changed', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT);
  assert.strictEqual(r.rule, RULE.NL_IN_REST);
});

t('rule 4b: modal `should` in rest → chat', () => {
  const r = classifyInput('git should we refactor', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT);
  assert.strictEqual(r.rule, RULE.NL_IN_REST);
});

t('rule 4b: first-token NL word does NOT trigger 4b — first token is checked by rule 1/2', () => {
  // If `the` were on PATH the classifier would still route to shell
  // for a single-word `the`; rule 4b only scans REST tokens. This test
  // guards against a regression where someone widens 4b to include the
  // first token and inadvertently double-fires with rule 2.
  const cache = new Set(['the']); // pretend `the` is a binary somewhere
  const r = classifyInput('the', { pathCache: cache });
  assert.strictEqual(r.verdict, VERDICT.SHELL,
    'rule 4b scans REST tokens only — first token routes via rules 1/2/3');
});

t('rule 4b: case-insensitive NL match — `The`, `THIS`, `Should` all trigger', () => {
  for (const [line, why] of [
    ['git log The file', 'article capitalized'],
    ['git log THIS file', 'pronoun uppercase'],
    ['git log Should apply', 'modal capitalized'],
  ]) {
    const r = classifyInput(line, { pathCache: PATH_CACHE });
    assert.strictEqual(r.verdict, VERDICT.CHAT, `NL detector must be case-insensitive (${why})`);
    assert.strictEqual(r.rule, RULE.NL_IN_REST);
  }
});

// ──────────────────────────────────────────────────────────────────
// Group I: rule 4c — multi-word real command → shell.

t('rule 4c: `git commit -am "fix"` → shell', () => {
  const r = classifyInput('git commit -am "fix"', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.SHELL,
    'multi-word real command with no NL words and no `?` → shell');
  assert.strictEqual(r.rule, RULE.MULTI_SHELL);
});

t('rule 4c: `npm test -- foo.js` → shell', () => {
  const r = classifyInput('npm test -- foo.js', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.SHELL);
  assert.strictEqual(r.rule, RULE.MULTI_SHELL);
});

t('rule 4c: `docker exec myco bash` → shell', () => {
  const r = classifyInput('docker exec myco bash', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.SHELL);
  assert.strictEqual(r.rule, RULE.MULTI_SHELL);
});

t('rule 4c: tokens preserved in order', () => {
  const r = classifyInput('git commit -am fix', { pathCache: PATH_CACHE });
  assert.deepStrictEqual(r.tokens, ['git', 'commit', '-am', 'fix'],
    'tokens field must preserve the split-on-whitespace tokens in order');
});

// ──────────────────────────────────────────────────────────────────
// Group J: projectShellWords override (fr-115 hook point).

t('projectShellWords: single-word project command → shell + PROJECT_WORD rule', () => {
  // fr-115 will let activated skills inject project-specific vocab like
  // `makemigrations` (django), `runserver` (django), `db:reset` (rails).
  // The classifier reserves the PROJECT_WORD rule id for this path.
  const r = classifyInput('makemigrations', {
    pathCache: PATH_CACHE, // does NOT include makemigrations
    projectShellWords: new Set(['makemigrations', 'runserver']),
  });
  assert.strictEqual(r.verdict, VERDICT.SHELL,
    'project shell words must route to shell even when pathCache would otherwise miss');
  assert.strictEqual(r.rule, RULE.PROJECT_WORD);
});

t('projectShellWords: multi-word still runs rule 4 — NL word in rest still routes to chat', () => {
  const r = classifyInput('makemigrations the users table', {
    pathCache: PATH_CACHE,
    projectShellWords: new Set(['makemigrations']),
  });
  assert.strictEqual(r.verdict, VERDICT.CHAT,
    'project shell word as first token still allows rule 4b to catch NL in rest — otherwise `makemigrations the users` slips through');
  assert.strictEqual(r.rule, RULE.NL_IN_REST);
});

t('projectShellWords: multi-word project command with no NL → shell', () => {
  const r = classifyInput('runserver --port=8000', {
    pathCache: PATH_CACHE,
    projectShellWords: new Set(['runserver']),
  });
  assert.strictEqual(r.verdict, VERDICT.SHELL);
  assert.strictEqual(r.rule, RULE.MULTI_SHELL,
    'project word + shell-shaped rest falls through to the standard MULTI_SHELL rule');
});

// ──────────────────────────────────────────────────────────────────
// Group K: helper functions — isNaturalLanguageWord + tokenize.

t('isNaturalLanguageWord: catches all four NL categories', () => {
  assert.strictEqual(isNaturalLanguageWord('the'),    true, 'article');
  assert.strictEqual(isNaturalLanguageWord('this'),   true, 'pronoun');
  assert.strictEqual(isNaturalLanguageWord('what'),   true, 'question word');
  assert.strictEqual(isNaturalLanguageWord('should'), true, 'modal');
});

t('isNaturalLanguageWord: returns false for shell words + code', () => {
  for (const w of ['ls', 'git', '-am', 'fix.js', '--verbose', '"foo"']) {
    assert.strictEqual(isNaturalLanguageWord(w), false,
      `\`${w}\` is not NL — must return false to keep shell commands out of chat`);
  }
});

t('isNaturalLanguageWord: null/undefined tolerated (no throw)', () => {
  assert.strictEqual(isNaturalLanguageWord(null), false);
  assert.strictEqual(isNaturalLanguageWord(undefined), false);
  assert.strictEqual(isNaturalLanguageWord(''), false);
});

t('tokenize: splits on whitespace, filters empty', () => {
  assert.deepStrictEqual(tokenize('git commit -am fix'), ['git', 'commit', '-am', 'fix']);
  assert.deepStrictEqual(tokenize('  git    commit  '), ['git', 'commit'],
    'must collapse runs of whitespace and trim edges');
  assert.deepStrictEqual(tokenize(''), []);
  assert.deepStrictEqual(tokenize('   '), []);
  assert.deepStrictEqual(tokenize(null), []);
});

t('tokenize: does NOT respect shell quoting — deliberate design', () => {
  // Getting quoting "right" would require a real shell parser. The
  // classifier is a heuristic — this test locks the deliberate
  // simplification so a future contributor doesn't try to "fix" it.
  const tokens = tokenize('git commit -m "fix the bug"');
  assert.deepStrictEqual(tokens, ['git', 'commit', '-m', '"fix', 'the', 'bug"'],
    'tokenize splits on whitespace only — quoted strings become multiple tokens on purpose');
});

// ──────────────────────────────────────────────────────────────────
// Group L: rule interaction / ordering edge cases.

t('ordering: reserved-word first token + trailing `?` — rule 2 wins (reserved runs first)', () => {
  // Both rule 2 (reserved) and rule 4a (`?`) apply. Rule 2 must win
  // because it runs first — the return still routes to chat but the
  // rule id must be RESERVED, not QUESTION_MARK, so the UX layer
  // explains WHY correctly. Uses a multi-token input so the `?` is
  // legitimately trailing (not part of the first token itself).
  const r = classifyInput('do things really work?', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT);
  assert.strictEqual(r.rule, RULE.RESERVED,
    'rule 2 runs FIRST — even if `?` and NL words would also match, RESERVED must be the reported rule');
});

t('ordering: rule 1 (unknown) beats rule 4a (`?`)', () => {
  const r = classifyInput('flurglewurgle?', { pathCache: PATH_CACHE });
  assert.strictEqual(r.verdict, VERDICT.CHAT);
  assert.strictEqual(r.rule, RULE.UNKNOWN_CMD,
    'when the first token misses PATH, rule 1 fires before rule 4a — both would route to chat but rule id matters for UX');
});

t('ordering: rule 4a (`?`) beats rule 4b (NL in rest)', () => {
  // `top 5 memory hogs?` — `?` at end, no NL words. Verifies 4a runs
  // before 4b, so QUESTION_MARK is the reported rule (not NL_IN_REST).
  const r = classifyInput('top 5 memory hogs?', { pathCache: PATH_CACHE });
  assert.strictEqual(r.rule, RULE.QUESTION_MARK,
    'rule 4a must run before 4b — trailing `?` is a stronger signal than NL scanning');
});

// ──────────────────────────────────────────────────────────────────
// Group M: opts.reservedWords override (extensibility).

t('reservedWords override: caller can supply their own set', () => {
  // Empty override — `do` should now route via rule 1/3 instead of
  // rule 2. Guards against a regression where the default set is
  // hard-coded past the opt override.
  const r = classifyInput('do', {
    pathCache: new Set(['do']), // pretend `do` is a binary
    reservedWords: new Set(),   // caller overrides the default
  });
  assert.strictEqual(r.verdict, VERDICT.SHELL,
    'caller-supplied empty reservedWords set must let `do` fall through to rule 3');
  assert.strictEqual(r.rule, RULE.SINGLE_KNOWN);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
