# myco — bash integration (fr-114)
#
# What this file does: hijacks the Enter key so that every command line
# the user types gets classified by a pure-bash port of the Lacy Shell
# 5-rule classifier (fr-113) BEFORE it runs. Shell verdicts get a green
# tint and execute normally. Chat verdicts get a magenta tint + a hint
# ("→ this looks like a chat message") and still execute — until fr-116
# adds the real `myco chat` client, we prefer educating the user over
# blocking their shell.
#
# The rule sets below MIRROR cli/src/classifier.js. If you change one,
# change the other. There is a static drift-guard in test/test.sh
# (`test_bash_classifier_mirrors_js`) that turns the build red the
# moment a JS entry stops appearing in this file.
#
# Sourcing contract this file honors (established in the fr-109 stub):
#   1. Idempotent: sourcing twice must not double-hook the Enter bind.
#   2. Silent on load: no stdout/stderr output when everything is fine.
#   3. Reversible: `unset MYCO_INTEGRATE_LOADED` lets a user re-source.
#   4. Never fails a user's shell: any local error becomes a no-op with
#      the classifier disabled — the user's Enter still works.

# ────────────────────────────────────────────────────────────────
# Idempotency guard (fr-109 contract).

if [ -n "$MYCO_INTEGRATE_LOADED" ]; then
  return 2>/dev/null || true
fi
MYCO_INTEGRATE_LOADED=1
# fr-115: version marker reflects the current release, not the file.
# Both share/myco.bash and share/myco.zsh set this to the same value —
# the version tracks "what myco features are wired up on this shell,"
# which advances as a whole regardless of which shell you use.
export MYCO_INTEGRATE_VERSION="fr-115"

# ────────────────────────────────────────────────────────────────
# Rule 2 — bash reserved words. MIRRORS cli/src/classifier.js:BASH_RESERVED_WORDS.
# These pass `command -v` (bash reports them as keywords) but never work
# standalone. Typing `do` at a prompt is a syntax error unless it's
# inside a `for … do … done` block.

_myco_is_reserved() {
  # $1 = word (already lowercased by caller)
  case "$1" in
    do|then|in|else|fi|esac|while|for|if|case|until|select|function|time)
      return 0 ;;
    *)
      return 1 ;;
  esac
}

# ────────────────────────────────────────────────────────────────
# Rule 4b — natural-language word categories. MIRRORS cli/src/classifier.js:
#   NL_ARTICLES  = { the, a, an }
#   NL_PRONOUNS  = { this, that, these, those, it, they, we, i, you, my, your, its, their, our }
#   NL_QUESTION  = { what, why, how, when, where, who, which }
#   NL_MODAL     = { should, could, would, can, may, might, must, will, shall }

_myco_is_nl_word() {
  # $1 = word (already lowercased by caller)
  case "$1" in
    # NL_ARTICLES
    the|a|an) return 0 ;;
    # NL_PRONOUNS
    this|that|these|those|it|they|we|i|you|my|your|its|their|our) return 0 ;;
    # NL_QUESTION
    what|why|how|when|where|who|which) return 0 ;;
    # NL_MODAL
    should|could|would|can|may|might|must|will|shall) return 0 ;;
    *) return 1 ;;
  esac
}

# ────────────────────────────────────────────────────────────────
# The 5-rule classifier itself. Echoes 'shell' or 'chat'.
#
# Order matters — must match the JS implementation exactly:
#   Rule 2 (reserved) runs FIRST because bash reports reserved words as
#   `command -v` hits. Rule 4a (trailing `?`) beats rule 4b (NL in rest).

_myco_classify() {
  # $1 = the raw input line (may contain leading/trailing whitespace)
  local line="$1"

  # Empty input → shell (safe no-op, matches JS default).
  local trimmed
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [ -z "$trimmed" ]; then
    printf shell
    return
  fi

  # Split into tokens (whitespace-delimited, quoting IGNORED — deliberate,
  # matches JS `tokenize`).
  local -a tokens
  # shellcheck disable=SC2086
  read -r -a tokens <<< "$trimmed"

  local first="${tokens[0]}"
  local first_lower
  first_lower="$(printf '%s' "$first" | tr '[:upper:]' '[:lower:]')"

  # Rule 2: bash reserved word → chat. Runs FIRST.
  if _myco_is_reserved "$first_lower"; then
    printf chat
    return
  fi

  # Rule 1: `command -v <first>` misses → chat. Case-sensitive on
  # Linux/macOS (`Git` ≠ `git`).
  if ! command -v "$first" >/dev/null 2>&1; then
    printf chat
    return
  fi

  # Rule 3: single-word input that passed 1+2 → shell.
  if [ "${#tokens[@]}" -eq 1 ]; then
    printf shell
    return
  fi

  # Rule 4a: trailing `?` (optional whitespace after) → chat. Strong
  # signal even when the first token is a real command.
  if [[ "$line" =~ \?[[:space:]]*$ ]]; then
    printf chat
    return
  fi

  # Rule 4b: multi-word with an NL word in the REST tokens → chat.
  local i word word_lower
  for ((i = 1; i < ${#tokens[@]}; i++)); do
    word="${tokens[$i]}"
    word_lower="$(printf '%s' "$word" | tr '[:upper:]' '[:lower:]')"
    if _myco_is_nl_word "$word_lower"; then
      printf chat
      return
    fi
  done

  # Rule 4c: multi-word real command, no NL, no `?` → shell.
  printf shell
}

# ────────────────────────────────────────────────────────────────
# Enter hijack. Wraps the accepted line with a color-tinted echo (green
# for shell, magenta for chat) before handing execution back to bash.
#
# Why this instead of PROMPT_COMMAND / PS1 rewrites: we want the color
# to appear on the accepted line the user just typed (moments before
# it runs), not on the next prompt. `bind -x` on `\C-m` gives us the
# raw `$READLINE_LINE` at the moment of acceptance, before bash strips
# it into history.

_myco_accept_line() {
  local line="$READLINE_LINE"

  # Empty Enter → let bash do its default (fresh prompt, no output).
  if [ -z "$line" ]; then
    return
  fi

  local verdict
  verdict="$(_myco_classify "$line")"

  # Color the echoed line so the user sees WHICH way this went.
  #   \e[32m green  → shell
  #   \e[35m magenta → chat
  # `\r` returns to column 0 so we overwrite bash's own line-echo, then
  # \e[K clears from cursor to EOL to remove any prior magenta hint.
  case "$verdict" in
    shell)
      printf '\r\e[K\e[32m%s\e[0m\n' "$line"
      ;;
    chat)
      printf '\r\e[K\e[35m%s\e[0m\n' "$line"
      printf '\e[2m→ this looks like a chat message (fr-117 will route to `myco chat`)\e[0m\n'
      ;;
  esac

  # Push the line into history + execute. Same pattern Lacy Shell uses.
  history -s -- "$line"
  # shellcheck disable=SC2090
  eval "$line"
  # Clear READLINE_LINE so bash draws a fresh prompt on return.
  READLINE_LINE=""
  READLINE_POINT=0
}

# Only bind if we're in an interactive shell with readline. Non-interactive
# subshells (script runs, cron, CI) get the classifier functions but no
# key bind — sourcing this file in a script must not break the script.
if [[ $- == *i* ]] && [ -t 0 ]; then
  # \C-m is carriage return (Enter). This overrides bash's default
  # accept-line binding for this shell only. Non-idempotent bindings
  # are prevented by the MYCO_INTEGRATE_LOADED guard at the top.
  bind -x '"\C-m": _myco_accept_line' 2>/dev/null || true
fi
