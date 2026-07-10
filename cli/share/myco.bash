# myco — bash integration stub (fr-109 skeleton)
#
# This is a NO-OP loader. It proves the sourcing mechanism works
# end-to-end (myco integrate --bash prints the source line for this
# file, and running that source line loads it cleanly with zero
# side-effects). Real functionality — the Lacy Shell 5-rule classifier,
# real-time green/magenta prompt indicator, and shell-vs-chat routing —
# lands in fr-110.
#
# Sourcing contract this stub establishes and future phases must honor:
#   1. Idempotent: sourcing twice must not double-hook prompt commands.
#   2. Silent on load: no stdout / stderr output when everything is fine.
#   3. Reversible: `unset MYCO_INTEGRATE_LOADED` lets a user re-source
#      cleanly (useful during dev of fr-110's classifier).
#   4. Never fails a user's shell: if myco is unhealthy, we should log
#      to stderr once and become a no-op; never break `.bashrc`.
#
# fr-109: idempotency guard (points 1 + 3 above).
if [ -n "$MYCO_INTEGRATE_LOADED" ]; then
  return 2>/dev/null || true
fi
MYCO_INTEGRATE_LOADED=1
export MYCO_INTEGRATE_VERSION="fr-109-stub"

# fr-110 will replace the block below with:
#   - A PROMPT_COMMAND hook that reads $READLINE_LINE
#   - A local 5-rule classifier (checks command -v, reserved words,
#     natural-language patterns, multi-word bare-words heuristic)
#   - Color feedback (green if shell, magenta if chat) via
#     $PS1 / $PROMPT_COMMAND rewrite
#   - Chat routing to `myco chat` (which fr-112 adds)
#
# For fr-109 there is nothing to do. Sourcing this file is a no-op that
# just marks the environment.
