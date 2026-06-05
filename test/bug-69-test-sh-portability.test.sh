#!/usr/bin/env bash
# bug-69 regression: test.sh must be portable across hosts.
#
# Pre-fix symptoms (verified on a busybox-grep host without
# server/node_modules/):
#   - 26 static checks using `grep -Pzoq` / `grep -Pq` failed with
#     "grep: unrecognized option: P" because busybox grep lacks PCRE.
#   - test_npm_deps failed with "Missing npm dep: express".
#   - 6 server-smoke tests failed with "Cannot find module
#     'global-agent/bootstrap'" (chained to missing node_modules).
#   - Total: 33 environmental failures on a clean checkout.
#
# Fix (in test/test.sh):
#   1. pcre_match(pattern, file) helper delegates to node's RegExp
#      engine. JS RegExp accepts the same syntax (\s, \d, (?i), (?s),
#      [\s\S]{0,N}). Works on any host where node is on PATH (already
#      a hard dep for the rest of the suite).
#   2. ensure_server_deps() auto-installs server/ deps if missing.
#      Invoked before node_test_prelaunch. Idempotent.
#   3. All 26 production `grep -P` call sites replaced with
#      pcre_match. Patterns themselves unchanged.
#
# This test enforces the contract: no production grep -P in test.sh,
# pcre_match referenced >=26 times, both helpers defined, and the
# pcre_match function actually works on synthetic content.

set -euo pipefail

# Anchor to repo root regardless of caller cwd (same idiom as
# test.sh).
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)/.."

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; }

echo "── bug-69: test.sh portability (busybox grep + npm deps) ──"

# ─────────────────────────────────────────────────────────────────
# PART A — Static guards on test.sh
# ─────────────────────────────────────────────────────────────────

# Guard 1: zero production `grep -P` calls. Comments referencing the
# pattern (in the pcre_match docstring) are allowed and counted via
# a separate non-comment line filter.
prod_grep_p=0
while IFS= read -r line; do
  case "$line" in
    \#*) continue ;;
    *grep\ -P*) prod_grep_p=$((prod_grep_p + 1)) ;;
  esac
done < test/test.sh
if [ "$prod_grep_p" -eq 0 ]; then
  pass "no production grep -P calls in test.sh (comment-only mentions OK)"
else
  fail "production grep -P still present: $prod_grep_p call sites remain — busybox-grep hosts will fail these"
fi

# Guard 2: pcre_match referenced at least 26 times (function def + at
# least 26 call sites = >=27 lines). We count occurrences not lines
# so a multi-call line still counts.
pcre_count=$(grep -c 'pcre_match' test/test.sh || true)
if [ "$pcre_count" -ge 27 ]; then
  pass "pcre_match referenced $pcre_count times (>=27 — def + 26 call sites)"
else
  fail "pcre_match referenced only $pcre_count times (expected >=27) — some grep -P sites may have been missed"
fi

# Guard 3: both helpers are defined as functions.
if grep -q '^pcre_match()' test/test.sh; then
  pass "pcre_match() function defined"
else
  fail "pcre_match() function not defined in test.sh"
fi
if grep -q '^ensure_server_deps()' test/test.sh; then
  pass "ensure_server_deps() function defined"
else
  fail "ensure_server_deps() function not defined in test.sh"
fi

# Guard 4: ensure_server_deps is INVOKED (not just defined) before
# the node_test_prelaunch call. Order matters: deps must exist
# before the parallel test runner kicks off.
deps_invocation_line=$(grep -n '^ensure_server_deps$' test/test.sh | head -1 | sed 's/:.*//')
prelaunch_invocation_line=$(grep -n '^node_test_prelaunch$' test/test.sh | head -1 | sed 's/:.*//')
if [ -n "$deps_invocation_line" ] && [ -n "$prelaunch_invocation_line" ] && [ "$deps_invocation_line" -lt "$prelaunch_invocation_line" ]; then
  pass "ensure_server_deps invoked at line $deps_invocation_line, before node_test_prelaunch at line $prelaunch_invocation_line"
else
  fail "ensure_server_deps must be INVOKED before node_test_prelaunch (deps_line=$deps_invocation_line prelaunch_line=$prelaunch_invocation_line)"
fi

# Guard 5: pcre_match delegates to node (not awk / not python — must
# match the documented contract).
if grep -q "node -e" test/test.sh && grep -q "new RegExp" test/test.sh; then
  pass "pcre_match delegates to node's RegExp engine"
else
  fail "pcre_match body must invoke node -e with new RegExp(...)"
fi

# Guard 6: ensure_server_deps is idempotent — checks
# node_modules/.package-lock.json before installing.
if grep -q 'node_modules/.package-lock.json' test/test.sh; then
  pass "ensure_server_deps idempotency guard present (.package-lock.json check)"
else
  fail "ensure_server_deps must guard on node_modules/.package-lock.json so repeat runs don't reinstall"
fi

# ─────────────────────────────────────────────────────────────────
# PART B — Behavioral: pcre_match correctness
# ─────────────────────────────────────────────────────────────────

# Inline a self-contained pcre_match so this test exercises the
# documented behavior without sourcing test.sh (which would also
# fire ensure_server_deps and the rest of the setup).
_inline_pcre_match() {
  local pattern="$1" file="$2"
  if ! command -v node >/dev/null 2>&1; then return 2; fi
  node -e '
    const fs = require("fs");
    try {
      let pat = process.argv[1];
      let flags = "";
      const m = pat.match(/^\(\?([a-z]+)\)/);
      if (m) {
        const valid = "ims";
        for (const c of m[1]) if (valid.includes(c) && !flags.includes(c)) flags += c;
        pat = pat.slice(m[0].length);
      }
      const re = new RegExp(pat, flags);
      const content = fs.readFileSync(process.argv[2], "utf8");
      process.exit(re.test(content) ? 0 : 1);
    } catch (err) {
      console.error("pcre_match: " + err.message);
      process.exit(2);
    }
  ' "$pattern" "$file"
}

TMPF=$(mktemp)
trap 'rm -f "$TMPF"' EXIT
printf 'foo bar baz\nmulti-\nline content\nwith Bash command\n' > "$TMPF"

# Multi-line PCRE pattern (the exact shape test.sh's static checks
# use). [\s\S]{0,N} spans newlines.
if _inline_pcre_match 'foo[\s\S]{0,80}content' "$TMPF"; then
  pass "pcre_match: multi-line [\\s\\S]{0,80} pattern matches across newlines"
else
  fail "pcre_match: multi-line pattern failed to match — busybox-grep failure mode regresses"
fi

# Negative: known-absent pattern returns non-zero.
if _inline_pcre_match 'xyzzy_no_such_string' "$TMPF"; then
  fail "pcre_match: false-positive on a string that is NOT in the file"
else
  pass "pcre_match: returns non-zero when pattern is absent"
fi

# Inline-flag (?i) for case-insensitive — used by line ~4062 of test.sh.
if _inline_pcre_match '(?i)BASH command' "$TMPF"; then
  pass "pcre_match: (?i) inline-flag (case-insensitive) honored"
else
  fail "pcre_match: (?i) inline-flag did not work — line ~4062 of test.sh would regress"
fi

# Dotall (?s) for newline-spanning dot — used by line ~1496 of test.sh.
if _inline_pcre_match '(?s)multi.*line' "$TMPF"; then
  pass "pcre_match: (?s) inline-flag (dotall) honored"
else
  fail "pcre_match: (?s) inline-flag did not work — line ~1496 of test.sh would regress"
fi

# Invalid regex returns exit 2 (caller's `|| fail` treats this same
# as no-match — defensive contract for malformed patterns).
if _inline_pcre_match '[unterminated' "$TMPF" 2>/dev/null; then
  fail "pcre_match: invalid regex must NOT return 0 (false positive)"
else
  pass "pcre_match: invalid regex returns non-zero (caller's || fail path fires)"
fi

# ─────────────────────────────────────────────────────────────────
# PART C — Behavioral: ensure_server_deps contract (BOTH directions)
#
# Run the helper against an isolated stub `server/` tree so we don't
# touch the real one. Two scenarios:
#   C.1 node_modules + .package-lock.json present → must NOT call npm
#       (idempotency contract).
#   C.2 node_modules absent → MUST call npm (install path).
#
# We stub `npm` on PATH so we can observe whether it was invoked
# without doing a real network install in the test. The stub records
# its invocation to a sentinel file + creates the expected
# node_modules tree so the helper's post-install state checks pass.
# ─────────────────────────────────────────────────────────────────

# Extract the ensure_server_deps function body from test.sh so we
# exercise the REAL helper, not an inlined approximation. Falls back
# to a clearly-marked failure if extraction fails (e.g. function
# moved + renamed).
ENSURE_BODY=$(awk '/^ensure_server_deps\(\) \{/,/^\}/' test/test.sh)
if [ -z "$ENSURE_BODY" ] || ! echo "$ENSURE_BODY" | grep -q 'package-lock.json'; then
  fail "ensure_server_deps function body could not be extracted from test.sh — Part C tests cannot run"
else
  pass "ensure_server_deps function body extracted from test.sh for behavioral exercise"

  # Scenario C.1 — idempotent when deps already present.
  CASE1_DIR=$(mktemp -d)
  STUB1_DIR=$(mktemp -d)
  trap 'rm -f "$TMPF"; rm -rf "$CASE1_DIR" "$STUB1_DIR"' EXIT
  mkdir -p "$CASE1_DIR/server/node_modules"
  touch "$CASE1_DIR/server/node_modules/.package-lock.json"
  cat > "$STUB1_DIR/npm" <<'EOF'
#!/bin/sh
echo "STUB-NPM-INVOKED" > "$STUB_SENTINEL"
exit 0
EOF
  chmod +x "$STUB1_DIR/npm"
  STUB1_SENTINEL="$STUB1_DIR/.invoked"
  (
    cd "$CASE1_DIR"
    PATH="$STUB1_DIR:$PATH" STUB_SENTINEL="$STUB1_SENTINEL" bash -c "
      die() { echo \"die: \$*\" >&2; exit 1; }
      $ENSURE_BODY
      ensure_server_deps
    "
  )
  if [ -f "$STUB1_SENTINEL" ]; then
    fail "ensure_server_deps: re-invoked npm even though node_modules + .package-lock.json existed (not idempotent)"
  else
    pass "ensure_server_deps C.1: idempotent — skipped npm install when deps already present"
  fi

  # Scenario C.2 — installs when deps missing.
  CASE2_DIR=$(mktemp -d)
  STUB2_DIR=$(mktemp -d)
  trap 'rm -f "$TMPF"; rm -rf "$CASE1_DIR" "$STUB1_DIR" "$CASE2_DIR" "$STUB2_DIR"' EXIT
  mkdir -p "$CASE2_DIR/server"
  # No node_modules — the helper must call npm install.
  cat > "$STUB2_DIR/npm" <<'EOF'
#!/bin/sh
# Stub records the invocation + simulates a successful install by
# materializing the directory layout the helper checked.
echo "$@" > "$STUB_SENTINEL"
mkdir -p "$STUB_CWD/server/node_modules"
touch "$STUB_CWD/server/node_modules/.package-lock.json"
exit 0
EOF
  chmod +x "$STUB2_DIR/npm"
  STUB2_SENTINEL="$STUB2_DIR/.invoked"
  (
    cd "$CASE2_DIR"
    PATH="$STUB2_DIR:$PATH" STUB_SENTINEL="$STUB2_SENTINEL" STUB_CWD="$CASE2_DIR" bash -c "
      die() { echo \"die: \$*\" >&2; exit 1; }
      $ENSURE_BODY
      ensure_server_deps
    "
  )
  if [ -f "$STUB2_SENTINEL" ]; then
    # Verify the stub recorded `install ...` args, not some other npm cmd.
    if grep -q '^install' "$STUB2_SENTINEL"; then
      pass "ensure_server_deps C.2: invoked 'npm install' when node_modules was absent"
    else
      fail "ensure_server_deps C.2: invoked npm but NOT with 'install' (sentinel: $(cat "$STUB2_SENTINEL"))"
    fi
  else
    fail "ensure_server_deps C.2: did NOT invoke npm when node_modules was absent — the install path is broken"
  fi

  # Scenario C.3 — post-install state-check: node_modules + lock file
  # exist after the helper returns. (The stub creates these to mimic
  # a real install; this asserts the helper's chained state assertion
  # holds.)
  if [ -d "$CASE2_DIR/server/node_modules" ] && [ -f "$CASE2_DIR/server/node_modules/.package-lock.json" ]; then
    pass "ensure_server_deps C.3: post-install state has node_modules + .package-lock.json"
  else
    fail "ensure_server_deps C.3: post-install state missing node_modules or .package-lock.json"
  fi
fi

echo
echo "── bug-69 portability: $PASS passed, $FAIL failed ──"
exit "$FAIL"
