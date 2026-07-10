# myco — zsh integration stub (fr-109 skeleton)
#
# Same contract as share/myco.bash — no-op loader that proves the
# sourcing mechanism works. fr-110 fills in the Lacy Shell 5-rule
# classifier + prompt hook (using zsh's `precmd_functions` and
# `zle-line-init` widgets instead of bash's `PROMPT_COMMAND`).

# Idempotency guard.
if [ -n "$MYCO_INTEGRATE_LOADED" ]; then
  return 2>/dev/null || true
fi
MYCO_INTEGRATE_LOADED=1
export MYCO_INTEGRATE_VERSION="fr-109-stub"

# fr-110 will replace the block below with:
#   - A ZLE widget bound to accept-line that classifies input pre-run
#   - Color feedback via prompt precmd hooks
#   - Chat routing to `myco chat` (which fr-112 adds)
#
# For fr-109 there is nothing to do. Sourcing this file is a no-op that
# just marks the environment.
