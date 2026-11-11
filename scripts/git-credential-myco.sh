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
# against github.com / gitee.com / codehub-dg-g.huawei.com then
# transparently picks up the stored token.
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
#   bug-92 (reaped-session fallback): the cwd-derived user is a
#   BEST-EFFORT signal, not a hard gate. The session reaper can delete
#   a workspace while its git operation is still in flight, in which
#   case $(pwd) no longer matches /wks/<user>/ and the old code emit()
#   nothing → git fails with "could not read Username" in ~0.2s even
#   though a valid codehub token IS on file. So when cwd fails to
#   resolve a user, we FALL BACK to scanning every entry in the token
#   store for a credential that matches this (provider, path). If all
#   candidates collapse to a single distinct token we emit it; if there
#   are multiple distinct tokens that is genuinely ambiguous (which
#   identity?), so we emit nothing rather than guess.
#
# Outside a session cwd (e.g. user shelled into the container manually
# and `cd /tmp; git push`), the helper emits nothing → safe fallthrough
# (unless a store-wide unique match exists, which restoring the
# credential was the whole point of).

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
//    Optional — the session reaper can remove the workspace mid-flight,
//    in which case cwd does NOT match and we fall back to a store-wide
//    scan below (bug-92) instead of giving up.
const cwdMatch = String(myCwd || "").match(/\/wks\/([^/]+)\//);
const mycoUser = cwdMatch ? cwdMatch[1] : null;

// 2. Parse git stdin (key=value lines).
let raw;
try { raw = fs.readFileSync(stdinPath, "utf8"); } catch { emit(); process.exit(0); }
const ctx = {};
for (const line of raw.split("\n")) {
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  ctx[line.slice(0, eq)] = line.slice(eq + 1);
}

// 3. Map host → provider. github.com → github; gitee.com → gitee;
//    codehub-dg-g.huawei.com → codehub (Huawei intranet GitLab-family).
//    Anything else → emit nothing (provider not supported by myco).
const host = String(ctx.host || "").toLowerCase();
let provider = null;
if (host === "github.com" || host.endsWith(".github.com")) provider = "github";
else if (host === "gitee.com" || host.endsWith(".gitee.com")) provider = "gitee";
else if (host === "codehub-dg-g.huawei.com" || host.endsWith(".codehub-dg-g.huawei.com")) provider = "codehub";
if (!provider) { emit(); process.exit(0); }

// 4. Load the token store. Tolerate missing file (no /setpat yet).
let store;
try { store = JSON.parse(fs.readFileSync(tokensFile, "utf8")); }
catch { emit(); process.exit(0); }
if (!store || typeof store !== "object") { emit(); process.exit(0); }

// 5. Parse path → owner/repo for the per-repo lookup. Git sends
//    path=owner/repo.git OR path=owner/repo. Strip .git suffix.
//    If path missing / malformed → fall back to user-level only.
const cleanPath = String(ctx.path || "").replace(/\.git$/, "").replace(/^\/+/, "");
const parts = cleanPath.split("/").filter(Boolean);
const hasPath = parts.length >= 2;

// Resolve one (token, username) pair for a single store entry, for the
// current (provider, path) context. Mirrors git-tokens.js precedence:
// per-repo PAT first, then the user-level provider key. The emitted
// username depends on provider — github always uses the sentinel
// "x-access-token"; gitee and codehub validate the login against the
// PAT owning account, so we resolve a stored login and fall back to the
// user key last. Returns null when this entry holds no usable token.
function resolveForUser(userKey, entry) {
  if (!entry || typeof entry !== "object") return null;
  let token = null;
  if (hasPath) {
    const repoKey = provider + "/" + parts[0] + "/" + parts[1];
    if (entry[repoKey]) token = entry[repoKey];
  }
  if (!token && entry[provider]) token = entry[provider];
  if (!token) return null;

  let username;
  if (provider === "github") {
    username = "x-access-token";
  } else if (provider === "gitee") {
    let login = null;
    if (hasPath) {
      const k = "gitee/" + parts[0] + "/" + parts[1] + ".login";
      if (typeof entry[k] === "string" && entry[k]) login = entry[k];
    }
    if (!login && typeof entry.giteeLogin === "string" && entry.giteeLogin) login = entry.giteeLogin;
    if (!login) login = userKey; // final fallback: the owning myco account
    username = login;
  } else if (provider === "codehub") {
    // codehub (Huawei GitLab-family) validates the credential username
    // against the PAT owning account (like gitee). Resolve a stored
    // login override (per-repo, then user-level), else fall back to the
    // owning account key. In single-user mode codehubLogin carries the
    // real account (e.g. s00791175) and the myco-user is just "default".
    let login = null;
    if (hasPath) {
      const k = "codehub/" + parts[0] + "/" + parts[1] + ".login";
      if (typeof entry[k] === "string" && entry[k]) login = entry[k];
    }
    if (!login && typeof entry.codehubLogin === "string" && entry.codehubLogin) login = entry.codehubLogin;
    if (!login) login = userKey;
    username = login;
  } else {
    // Unknown provider (guard only — step 3 already returned for these).
    return null;
  }
  return { token: token, username: username };
}

// 6. Pick the credential source.
//    Normal path: cwd resolved a myco-user → use exactly that entry.
//    Fallback (bug-92): cwd gone/reaped → scan every user; emit only
//    if every matching credential collapses to ONE distinct token.
let picked = null;
if (mycoUser) {
  picked = resolveForUser(mycoUser, store[mycoUser]);
} else {
  const seen = new Set();
  const candidates = [];
  for (const userKey of Object.keys(store)) {
    const r = resolveForUser(userKey, store[userKey]);
    if (r && !seen.has(r.token)) { seen.add(r.token); candidates.push(r); }
  }
  if (candidates.length === 1) picked = candidates[0];
}

if (!picked) { emit(); process.exit(0); }

process.stdout.write("username=" + picked.username + "\n");
process.stdout.write("password=" + picked.token + "\n");
' 2>/dev/null || true

# Always exit 0. Git treats non-zero as "this helper crashed, skip its
# output entirely" — we want it to use whatever we DID print even if
# node hiccupped on something tangential.
exit 0
