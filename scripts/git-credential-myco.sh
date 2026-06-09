#!/bin/sh
# bug-81: git credential helper that bridges myco's token store
# (/data/git-tokens.json — managed by server/src/git-tokens.js) to git's
# credential.fill protocol.
#
# Pre-fix, the myco token store and git's credential resolution were
# entirely disjoint. The user runs `/setpat <token>` (or signs in via
# OAuth) → the token lands in /data/git-tokens.json — but git's
# credential resolution chain (credential.helper → ~/.git-credentials →
# interactive prompt) has no awareness of that file, so `git push`
# either prompts for a password (failing in non-interactive
# environments with "could not read Username") or falls through
# silently and rejects the auth.
#
# Post-fix this helper is registered via `git config --global
# credential.helper /path/to/git-credential-myco.sh` (done at container
# boot in docker/docker-entrypoint.sh). Every HTTPS git operation
# against github.com / gitee.com then transparently picks up the
# stored token.
#
# Git's credential-fill protocol:
#   git invokes us with the action as $1 ("get" | "store" | "erase").
#   For "get", git writes key=value lines on stdin (protocol=https,
#   host=github.com, path=owner/repo.git, …) followed by a blank line,
#   then expects us to write `username=…\npassword=…\n` on stdout (or
#   emit nothing → git falls through to the next helper / prompt).
#
# Per-user disambiguation:
#   /data/git-tokens.json is keyed by myco-user, but git the CLI
#   doesn't know which myco-user it's running for. We derive the user
#   from cwd by matching /wks/<user>/<session-id>/… — the documented
#   session storage layout. Sessions ALWAYS run with cwd inside their
#   workspace, so this is correct for any git invocation that
#   originates from a session.
#
# Outside a session cwd (e.g. user shelled into the container manually
# and `cd /tmp; git push`), the helper emits nothing → safe fallthrough.

set -eu

ACTION="${1:-get}"

# Only the "get" action looks up credentials. "store" + "erase" are
# no-ops — git invokes them after auth succeeds / fails respectively,
# and we don't need to react (the token store is managed by /setpat +
# OAuth, not by individual push attempts).
if [ "$ACTION" != "get" ]; then
  exit 0
fi

# Read git's stdin into a tmpfile so node can parse it.
# stdin = key=value lines until EOF (or blank line).
STDIN_TMP=$(mktemp)
trap 'rm -f "$STDIN_TMP"' EXIT INT TERM
cat > "$STDIN_TMP"

# Derive myco-user from cwd. /wks/<user>/<session-id>/…
# Cwd is the dir git was invoked from (or `git -C <dir>`'s target).
MYCO_CWD="$(pwd)"

# State dir defaults match server/src/git-tokens.js — MYCO_STATE_DIR
# override first, fall back to /data (the documented container layout
# per CLAUDE.md).
STATE_DIR="${MYCO_STATE_DIR:-/data}"
TOKENS_FILE="$STATE_DIR/git-tokens.json"

# Delegate the lookup to node — robust JSON parsing + the same
# per-repo→user-level precedence the server uses. Helper emits
# nothing if any step fails (no tokens file, no matching token, cwd
# outside a session) → git falls through cleanly.
#
# Env vars must precede `node` — shell positional args land at
# process.argv, not process.env. Original v1 of this script had them
# after the closing `'`, which silently produced empty output (the
# node body read undefined for every env var and exited via the
# emit()-and-return path).
MYCO_TOKENS_FILE="$TOKENS_FILE" \
MYCO_CWD="$MYCO_CWD" \
MYCO_STDIN_PATH="$STDIN_TMP" \
node -e '
const fs = require("fs");

const tokensFile = process.env.MYCO_TOKENS_FILE;
const myCwd = process.env.MYCO_CWD;
const stdinPath = process.env.MYCO_STDIN_PATH;

function emit() { /* nothing */ }

// 1. Derive myco-user from cwd: /wks/<user>/...
//    Any other shape → emit nothing.
const cwdMatch = String(myCwd || "").match(/\/wks\/([^/]+)\//);
if (!cwdMatch) { emit(); process.exit(0); }
const mycoUser = cwdMatch[1];

// 2. Parse git stdin (key=value lines).
let raw;
try { raw = fs.readFileSync(stdinPath, "utf8"); } catch { emit(); process.exit(0); }
const ctx = {};
for (const line of raw.split("\n")) {
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  ctx[line.slice(0, eq)] = line.slice(eq + 1);
}

// 3. Map host → provider. github.com → github; gitee.com → gitee.
//    Anything else → emit nothing (provider not supported by myco).
const host = String(ctx.host || "").toLowerCase();
let provider = null;
if (host === "github.com" || host.endsWith(".github.com")) provider = "github";
else if (host === "gitee.com" || host.endsWith(".gitee.com")) provider = "gitee";
if (!provider) { emit(); process.exit(0); }

// 4. Load the token store. Tolerate missing file (no /setpat yet).
let store;
try { store = JSON.parse(fs.readFileSync(tokensFile, "utf8")); }
catch { emit(); process.exit(0); }
const userEntry = store && store[mycoUser];
if (!userEntry || typeof userEntry !== "object") { emit(); process.exit(0); }

// 5. Parse path → owner/repo for the per-repo lookup. Git sends
//    path=owner/repo.git OR path=owner/repo. Strip .git suffix.
//    If path missing / malformed → fall back to user-level only.
let token = null;
const cleanPath = String(ctx.path || "").replace(/\.git$/, "").replace(/^\/+/, "");
const parts = cleanPath.split("/").filter(Boolean);
if (parts.length >= 2) {
  const owner = parts[0];
  const repo = parts[1];
  // Per-repo PAT first (matches git-tokens.js getToken precedence).
  const repoKey = provider + "/" + owner + "/" + repo;
  if (userEntry[repoKey]) token = userEntry[repoKey];
}
// User-level fallback (bare provider key).
if (!token && userEntry[provider]) token = userEntry[provider];

if (!token) { emit(); process.exit(0); }

// 6. Emit the credential lines. x-access-token is the conventional
//    username for both classic and fine-grained GitHub PATs — git
//    ignores it and the token becomes the actual auth.
process.stdout.write("username=x-access-token\n");
process.stdout.write("password=" + token + "\n");
' 2>/dev/null || true

# Always exit 0. Git treats non-zero as "this helper crashed, skip its
# output entirely" — we want it to use whatever we DID print even if
# node hiccupped on something tangential.
exit 0
