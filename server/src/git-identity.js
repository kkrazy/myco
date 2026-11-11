// fr-26: git author identity from session owner.
//
// Wraps the noreply-email convention GitHub uses for attribution:
//   <githubId>+<login>@users.noreply.github.com
// GitHub treats that as authoritative for matching commits to a
// profile (the avatar + contribution graph land on the user's page),
// AND it never leaks the user's real email — which is important
// because myco doesn't currently capture user.email at OAuth time
// (the `user:email` scope isn't requested) and we don't want to
// guess.
//
// `name` falls back to `login` because the OAuth handler doesn't
// currently capture the user's display name either (see auth.js
// mintSession — `name` is stored but populated null in practice).
// An Option B follow-up could one-time-fetch the real name via
// GitHub's /user API; until then the login is the best signal we
// have, and it stays consistent with the @login chip the UI shows.
//
// Returns null when either field is missing — both are required to
// build a valid noreply email. The caller decides whether to fall
// back to a generic identity, leave env unset (git uses .gitconfig
// or "Unknown <unknown@example.com>"), or refuse to spawn.

function buildIdentity(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const login = profile.login;
  const githubId = profile.githubId;
  if (!login || !githubId) return null;
  const name = profile.name || login;
  const email = `${githubId}+${login}@users.noreply.github.com`;
  return { name, email };
}

module.exports = { buildIdentity };
