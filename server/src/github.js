// Back-compat shim for the pre-Gitee github.js API.
//
// Until td-4, this module owned the token jar (gh-tokens.json) + the
// GitHub-only protocol calls (detectRepo, createIssue). Adding Gitee
// support meant splitting that into two concerns:
//
//   git-tokens.js — provider-keyed token storage on disk.
//   git-hosts.js  — provider dispatch for detect / createIssue / fetchUser.
//
// To avoid touching every caller, we keep this module's old surface
// alive as a github-flavored wrapper over the new dispatcher. Callers
// that explicitly want GitHub (the OAuth callback storing a token, the
// PAT login route validating + storing) keep working unchanged.
//
// New callers should require('./git-hosts') instead.

const gitHosts = require('./git-hosts');
const gitTokens = require('./git-tokens');

function getToken(user) {
  // User-level only — pre-td-4 callers had no repo context. The
  // per-repo lookup is intentionally NOT exposed through this shim;
  // new code should require('./git-hosts').getToken(user, provider,
  // owner, repo) directly.
  return gitTokens.getToken(user, 'github');
}

function setToken(user, token) {
  // OAuth callback + PAT login both land here with a user-level
  // access_token (one credential good for all the user's github
  // repos). Store at the bare 'github' key so per-repo PATs set via
  // /setpat can override on a case-by-case basis.
  return gitTokens.setUserToken(user, 'github', token);
}

// detectRepo used to only ever return GitHub matches. Preserve that
// behavior so callers that haven't been refactored don't suddenly start
// trying to POST GitHub URLs to gitee.com — they need to opt-in.
async function detectRepo(absCwd) {
  const host = await gitHosts.detectHost(absCwd);
  if (!host || host.provider !== 'github') return null;
  return { owner: host.owner, repo: host.repo };
}

function createIssue(opts) {
  return gitHosts.createIssue({ ...opts, provider: 'github' });
}

module.exports = { getToken, setToken, detectRepo, createIssue };
