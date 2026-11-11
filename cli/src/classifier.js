// fr-113: pure Lacy Shell 5-rule classifier — decides whether user
// input is a shell command or a chat message. Deterministic, no ML,
// no network calls. Runs in <1ms on any line the user could plausibly
// type. fr-114 will wire this into share/myco.bash's PROMPT_COMMAND
// for real-time green/magenta feedback before Enter.
//
// Blueprint: Lacy Shell v1.8.9 (github.com/lacymorrow/lacy). Same
// 5-rule model, adapted for Node.js + our need to plumb classification
// metadata (which rule fired) up to the color-indicator UX.
//
// The five rules (rule 5 — post-exec silent re-route — lives in the
// shell integration layer, not here):
//
//   1. `command -v <first-token>` returns non-zero → chat
//      (unknown command — probably natural language)
//   2. First token is a bash reserved word (do/then/in/else/fi/esac/
//      while/for/if/case/until/select/function/time) → chat
//      (they pass command -v but never work standalone)
//   3. Single-word input that passed 1+2 → shell
//      (obvious command: ls, pwd, git, top, vim)
//   4a. Line ends with `?` → chat
//       (top 5 memory hogs? → chat, even though `top` is a command)
//   4b. Multi-word input with NL words in the rest → chat
//       (test the login flow — `test` is a command, `the` is NL)
//   4c. Multi-word real command, no NL, no `?` → shell
//       (git commit -am "fix", npm test -- foo.js)
//
// Pure function. No I/O, no shell exec, no child_process. Everything
// the classifier needs comes through opts. Callers (fr-114 prompt hook,
// tests, dry runs) all use the same entry point.

'use strict';

// Bash reserved keywords that pass `command -v` (bash reports them as
// keywords) but never work standalone as commands. Typing `do` at a
// prompt gives you a syntax error — it only means anything inside a
// `for ... do ... done` block. Small hardcoded set.
const BASH_RESERVED_WORDS = new Set([
  'do', 'then', 'in', 'else', 'fi', 'esac',
  'while', 'for', 'if', 'case', 'until',
  'select', 'function', 'time',
]);

// Natural-language pattern detectors (rule 4). Each set is a distinct
// category of "this word smells like English, not a shell arg." When
// any of these appears in the rest-of-line (tokens after the first),
// rule 4b fires and we route to chat.
const NL_ARTICLES = new Set(['the', 'a', 'an']);

// Subject pronouns + possessives. Not exhaustive — we skip `he/she/him/
// her/his/hers` because they're rare in dev-chat vs. `this/that/it`.
const NL_PRONOUNS = new Set([
  'this', 'that', 'these', 'those',
  'it', 'they', 'we', 'i', 'you',
  'my', 'your', 'its', 'their', 'our',
]);

// Question words that strongly signal chat intent.
const NL_QUESTION = new Set([
  'what', 'why', 'how', 'when', 'where', 'who', 'which',
]);

// Modal verbs — signals like "should we refactor" or "could this be
// faster" — heavily bias toward chat.
const NL_MODAL = new Set([
  'should', 'could', 'would',
  'can', 'may', 'might', 'must',
  'will', 'shall',
]);

// Verdict enum — return shape callers pattern-match on. Kept as strings
// (not JS enums) so serializing across process boundaries (e.g. sending
// to fr-114's bash color-tint script) is trivial.
const VERDICT = Object.freeze({
  SHELL: 'shell',
  CHAT:  'chat',
});

// Rule identifiers — surfaced in the return object so the UX layer
// (fr-114 color indicator + tooltip) can show WHICH rule fired. Good
// for debugging + user education ("→ chat because the pronoun 'this'
// suggests natural language").
const RULE = Object.freeze({
  EMPTY:            'empty-input',
  RESERVED:         'rule-2-reserved-word',
  UNKNOWN_CMD:      'rule-1-unknown-command',
  SINGLE_KNOWN:    'rule-3-single-known-command',
  QUESTION_MARK:    'rule-4a-question-mark',
  NL_IN_REST:       'rule-4b-nl-in-rest',
  MULTI_SHELL:      'rule-4c-multi-shell-shape',
  PROJECT_WORD:     'rule-3-project-shell-word',
});

// True if the word — lowercased — falls into any of the NL categories.
// Exported so tests can exercise the individual pattern detectors +
// so future work (fr-115 skills-aware classification) can add project-
// specific NL patterns via composition.
function isNaturalLanguageWord(word) {
  const lower = String(word || '').toLowerCase();
  return (
    NL_ARTICLES.has(lower) ||
    NL_PRONOUNS.has(lower) ||
    NL_QUESTION.has(lower) ||
    NL_MODAL.has(lower)
  );
}

// Split a line on whitespace into non-empty tokens. Deliberately does
// NOT respect shell quoting or escape sequences — rule 4 detection
// operates on word-level patterns, and rule 1 only needs the first
// token before any shell metacharacter. Getting quoting "right" would
// require a real shell parser; the classifier is a heuristic, not a
// grammar-perfect parser.
function tokenize(line) {
  return String(line || '').trim().split(/\s+/).filter(Boolean);
}

/**
 * Classify a line as shell or chat.
 *
 * @param {string} line — user's input line
 * @param {object} [opts]
 * @param {Set<string>} [opts.pathCache] — set of executables on $PATH.
 *   When provided, rule 1 (command -v) fires; when absent, rule 1 is
 *   permissively skipped (assume first token IS a command). fr-114
 *   will always provide a real path cache built once at shell start.
 * @param {Set<string>} [opts.reservedWords] — override the bash
 *   reserved word list. Defaults to BASH_RESERVED_WORDS.
 * @param {Set<string>} [opts.projectShellWords] — additional
 *   "definitely shell" vocabulary (e.g. django-project skill adds
 *   'makemigrations', 'runserver'). Empty by default. Skills-based
 *   population arrives in fr-115+.
 * @returns {{verdict: string, rule: string, tokens: string[]}}
 */
function classifyInput(line, opts) {
  opts = opts || {};
  const pathCache        = opts.pathCache || null;
  const reservedWords    = opts.reservedWords || BASH_RESERVED_WORDS;
  const projectShellWords = opts.projectShellWords || null;

  const tokens = tokenize(line);

  // Empty input has nothing to route. Return 'shell' as a safe default
  // (a bare Enter in a shell is a no-op; not a chat message).
  if (tokens.length === 0) {
    return { verdict: VERDICT.SHELL, rule: RULE.EMPTY, tokens: [] };
  }

  const firstToken = tokens[0];
  const firstLower = firstToken.toLowerCase();

  // Rule 2: bash reserved words → chat. Runs FIRST because it's O(1)
  // Set.has and gives a definitive answer. Reserved words pass
  // `command -v` (bash reports them as keywords) so if we ran rule 1
  // first we'd erroneously route `do` to shell.
  if (reservedWords.has(firstLower)) {
    return { verdict: VERDICT.CHAT, rule: RULE.RESERVED, tokens };
  }

  // Project-specific shell vocab (fr-115+): activated skills can inject
  // words that should ALWAYS be treated as shell commands even if
  // command -v isn't available or the classifier would otherwise route
  // to chat. Case-sensitive to match Linux/macOS binary lookup.
  if (projectShellWords && projectShellWords.has(firstToken)) {
    // Single word → shell straight. Multi-word → still allow rule 4
    // to catch NL patterns in the rest.
    if (tokens.length === 1) {
      return { verdict: VERDICT.SHELL, rule: RULE.PROJECT_WORD, tokens };
    }
    // Fall through to rule 4 for NL-in-rest check.
  }

  // Rule 1: command -v via pathCache. Only fires when pathCache is
  // provided; without one, permissively assume the first token IS a
  // command and let subsequent rules decide. fr-114 will always
  // provide a real pathCache built from $PATH walk on shell init.
  // Case-sensitive match — Linux/macOS filesystems are case-sensitive
  // for binaries (`Git` and `git` are different files).
  if (pathCache) {
    const isKnown = pathCache.has(firstToken)
      || (projectShellWords && projectShellWords.has(firstToken));
    if (!isKnown) {
      return { verdict: VERDICT.CHAT, rule: RULE.UNKNOWN_CMD, tokens };
    }
  }

  // Rule 3: single-word input that passed rules 1+2 → shell. This is
  // the "obvious command" fast path — `ls`, `pwd`, `git`, `top`, `vim`.
  if (tokens.length === 1) {
    return { verdict: VERDICT.SHELL, rule: RULE.SINGLE_KNOWN, tokens };
  }

  // Rule 4a: line ends with `?` → chat. Strong signal a user is asking
  // a question rather than running a command. Runs before rule 4b so
  // `top 5 memory hogs?` routes to chat even without NL words in
  // rest (top / 5 / memory / hogs aren't in any NL set).
  if (/\?\s*$/.test(line)) {
    return { verdict: VERDICT.CHAT, rule: RULE.QUESTION_MARK, tokens };
  }

  // Rule 4b: multi-word with an NL word in the rest → chat. This is
  // the primary NL detector — catches `test the login flow`, `history
  // of this file`, `git commit strategy discussion`.
  const restTokens = tokens.slice(1);
  for (const t of restTokens) {
    if (isNaturalLanguageWord(t)) {
      return { verdict: VERDICT.CHAT, rule: RULE.NL_IN_REST, tokens };
    }
  }

  // Rule 4c: multi-word, first is a known command, no NL words, no
  // `?` — shell. `git commit -am "fix"`, `npm test -- auth.test.js`,
  // `docker exec myco bash`.
  return { verdict: VERDICT.SHELL, rule: RULE.MULTI_SHELL, tokens };
}

module.exports = {
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
};
