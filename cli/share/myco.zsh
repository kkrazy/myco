# myco — zsh integration (fr-115)
#
# Zsh port of the fr-114 bash prompt hook. Same behavior: hijack Enter,
# classify the input line via a pure-zsh port of the fr-113 Lacy 5-rule
# classifier, tint the accepted line green (shell) or magenta (chat),
# then hand off to zsh's native accept-line for history + eval.
#
# The rule sets below MIRROR cli/src/classifier.js AND cli/share/myco.bash.
# Three files, one source of truth (JS). test/fr-115-zsh-prompt-hook.test.js
# turns red the moment a JS entry stops appearing here — same drift guard
# fr-114 established for the bash mirror.
#
# Zsh divergences from the bash version worth calling out:
#   - Arrays are 1-indexed. `${tokens[1]}` is the first token, and the
#     rest-of-line loop starts at index 2.
#   - `bind -x` does not exist. Zsh registers editor widgets via
#     `zle -N <widget>`, then `bindkey '^M' <widget>` overrides Enter
#     inside the ZLE (Zsh Line Editor).
#   - `${(L)word}` is zsh-native lowercase — no `tr` subshell needed.
#   - `${(z)line}` word-splits like a shell command (respects escapes
#     but not real quoting parsers). For our purposes we use IFS
#     splitting via `${=line}` — matches the JS tokenizer's
#     whitespace-only split.
#
# Sourcing contract this file honors (fr-109 lineage):
#   1. Idempotent: sourcing twice must not double-hook Enter.
#   2. Silent on load: no stdout/stderr output when everything is fine.
#   3. Reversible: `unset MYCO_INTEGRATE_LOADED` lets a user re-source.
#   4. Never fails a user's shell: any local error becomes a no-op
#      with the widget disabled — the user's Enter still works.

# ────────────────────────────────────────────────────────────────
# Idempotency guard (fr-109 contract).

if [ -n "$MYCO_INTEGRATE_LOADED" ]; then
  return 2>/dev/null || true
fi
MYCO_INTEGRATE_LOADED=1
export MYCO_INTEGRATE_VERSION="fr-115"

# ────────────────────────────────────────────────────────────────
# Rule 2 — bash reserved words. MIRRORS cli/src/classifier.js:BASH_RESERVED_WORDS
# AND cli/share/myco.bash. Same 13 words, same rationale: they pass
# `command -v` (zsh reports them as reserved words / keywords) but
# never work standalone.

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
#   NL_ARTICLES  = { the, a, an }                                     — 3
#   NL_PRONOUNS  = { this, that, these, those, it, they, we, i,
#                    you, my, your, its, their, our }                  — 14
#   NL_QUESTION  = { what, why, how, when, where, who, which }         — 7
#   NL_MODAL     = { should, could, would, can, may, might, must,
#                    will, shall }                                     — 9

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
# The 5-rule classifier. Echoes 'shell' or 'chat'. Order matches the JS
# and bash implementations exactly:
#   Rule 2 (reserved) FIRST — zsh reports keywords as `command -v` hits.
#   Rule 1 (command -v)
#   Rule 3 (single-word passed 1+2)
#   Rule 4a (trailing `?` — beats 4b)
#   Rule 4b (NL word in rest tokens)
#   Rule 4c (multi-word shell)

_myco_classify() {
  # $1 = the raw input line (may include leading/trailing whitespace)
  local line="$1"

  # Trim leading + trailing whitespace via zsh parameter expansion.
  local trimmed="${${line##[[:space:]]#}%%[[:space:]]#}"
  if [ -z "$trimmed" ]; then
    printf shell
    return
  fi

  # Split on whitespace (IFS). ${=trimmed} forces field splitting even
  # in zsh (which by default does NOT word-split parameter expansions
  # the way bash does — this is the shell's biggest sharp edge).
  local -a tokens
  tokens=(${=trimmed})

  local first="${tokens[1]}"          # zsh arrays are 1-indexed
  local first_lower="${(L)first}"     # zsh-native lowercase

  # Rule 2: bash reserved word → chat. Runs FIRST.
  if _myco_is_reserved "$first_lower"; then
    printf chat
    return
  fi

  # Rule 1: `command -v <first>` misses → chat. Case-sensitive on
  # Linux/macOS (matches the JS implementation).
  if ! command -v "$first" >/dev/null 2>&1; then
    printf chat
    return
  fi

  # Rule 3: single-word input that passed 1+2 → shell.
  if [ "${#tokens}" -eq 1 ]; then
    printf shell
    return
  fi

  # Rule 4a: trailing `?` (optional trailing whitespace) → chat.
  if [[ "$line" =~ '\?[[:space:]]*$' ]]; then
    printf chat
    return
  fi

  # Rule 4b: multi-word with an NL word in the REST tokens → chat.
  # 1-indexed: rest starts at index 2.
  local i word word_lower
  for ((i = 2; i <= ${#tokens}; i++)); do
    word="${tokens[$i]}"
    word_lower="${(L)word}"
    if _myco_is_nl_word "$word_lower"; then
      printf chat
      return
    fi
  done

  # Rule 4c: multi-word real command, no NL, no `?` → shell.
  printf shell
}

# ────────────────────────────────────────────────────────────────
# Enter hijack via a zle widget. Zsh's editor is different from bash's
# readline: instead of `bind -x`, we register a function as a widget
# with `zle -N`, then bind it to Enter (`^M`) across both editing modes
# (emacs + vi-insert).

_myco_accept_line() {
  local line="$BUFFER"

  # Empty Enter → let zsh do its default (fresh prompt, no output).
  if [ -z "$line" ]; then
    zle .accept-line
    return
  fi

  local verdict
  verdict="$(_myco_classify "$line")"

  # Color the echoed line so the user sees WHICH way this went.
  #   \e[32m green   → shell
  #   \e[35m magenta → chat
  # Emit BEFORE .accept-line so the tinted echo appears above the
  # command's own output. `print` here (not `printf`) is the zsh
  # idiom — cleaner escape handling.
  case "$verdict" in
    shell)
      print -r -- $'\r\e[K\e[32m'"$line"$'\e[0m'
      ;;
    chat)
      print -r -- $'\r\e[K\e[35m'"$line"$'\e[0m'
      print -r -- $'\e[2m→ this looks like a chat message (fr-117 will route to `myco chat`)\e[0m'
      ;;
  esac

  # Clear BUFFER so .accept-line does NOT re-print the (now-tinted)
  # line — otherwise we get a double echo. History push happens
  # automatically via addhistory hooks.
  print -s -- "$line"    # push to history explicitly (we cleared BUFFER)
  BUFFER=""
  CURSOR=0
  zle .accept-line
  # After accept-line returns, execute the original line via zsh's
  # command-line eval so it actually runs.
  eval "$line"
}

# Only register the widget if we're in an interactive zsh with ZLE.
# Non-interactive shells (script runs, cron, CI) get the classifier
# functions but no key bind — sourcing this file in a script must not
# break the script.
if [[ -o interactive ]] && [ -n "$ZSH_VERSION" ]; then
  # `zle -N` registers _myco_accept_line as an editor widget.
  # `bindkey` overrides Enter (`^M`) in both editing modes so the
  # user gets the hijack whether they use vi or emacs bindings.
  zle -N _myco_accept_line 2>/dev/null || true
  bindkey -M emacs '^M' _myco_accept_line 2>/dev/null || true
  bindkey -M viins '^M' _myco_accept_line 2>/dev/null || true
fi
