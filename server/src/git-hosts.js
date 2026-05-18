// Provider-aware Git-host integration dispatcher.
//
// Replaces the protocol-specific half of the old github.js. Owns:
//   detectHost(absCwd)  — read `git remote get-url origin`, classify
//                         the URL as github.com or gitee.com, and pull
//                         out owner/repo. Returns null if no remote or
//                         an unrecognized host.
//   createIssue({...})  — dispatches to a provider-specific client and
//                         returns {number, url} on success or
//                         {error, status} on failure. Never throws.
//   fetchUser({...})    — validates a token by hitting the provider's
//                         "current user" endpoint. Used by /setpat to
//                         confirm a pasted PAT before storing it.
//
// Token storage lives in git-tokens.js (one file, provider-keyed).
// We re-export the relevant helpers here so callers only need to
// require('./git-hosts').

const { execFile } = require('child_process');
const https = require('https');
const gitTokens = require('./git-tokens');

const KNOWN_PROVIDERS = gitTokens.KNOWN_PROVIDERS;

// ── repo detection ──────────────────────────────────────────────────────────
//
// Returns one of:
//   { provider: 'github' | 'gitee', owner, repo }
//   null  — no git remote, no recognized host, or git CLI failure.
//
// SSH form:  git@github.com:OWNER/REPO(.git)?   or  git@gitee.com:OWNER/REPO(.git)?
// HTTPS form: https://github.com/OWNER/REPO(.git)?  or https://gitee.com/OWNER/REPO(.git)?
// User-embedded HTTPS (PAT-in-URL): https://x:y@github.com/OWNER/REPO — still matches.
const HOST_REGEX = /(github\.com|gitee\.com)[:/]([^/]+)\/([^/]+?)(?:\.git)?\s*$/i;

function detectHost(absCwd) {
  return new Promise((resolve) => {
    if (!absCwd) return resolve(null);
    execFile('git', ['-C', absCwd, 'remote', 'get-url', 'origin'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const url = String(stdout || '').trim();
      const m = url.match(HOST_REGEX);
      if (!m) return resolve(null);
      const provider = m[1].toLowerCase() === 'gitee.com' ? 'gitee' : 'github';
      resolve({ provider, owner: m[2], repo: m[3] });
    });
  });
}

// ── tiny HTTPS helper ───────────────────────────────────────────────────────
//
// Replaces three near-identical https.request blocks in github.js +
// gitee.js. Resolves to { status, body } where body is the parsed JSON
// (or {} if parsing fails). Never throws — network errors come back as
// { status: 0, body: { error: '<msg>' } } so callers can branch on
// status uniformly.
function _httpsJson({ hostname, path, method, headers, body }) {
  return new Promise((resolve) => {
    const payload = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const hdrs = { ...headers };
    if (payload) hdrs['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ hostname, path, method, headers: hdrs, timeout: 15000 }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d.toString(); });
      res.on('end', () => {
        let parsed = {};
        try { parsed = chunks ? JSON.parse(chunks) : {}; } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: { error: err.message } }));
    req.on('timeout', () => { try { req.destroy(); } catch {}; resolve({ status: 0, body: { error: 'timeout' } }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── createIssue ─────────────────────────────────────────────────────────────
//
// Provider strategies for the two supported hosts. Both return either
// { number, url } on success or { error, status } on failure.
//
// Test seam: pass `httpsJson: <fn>` in the call options to inject a fake
// fetcher. Lets us unit-test the dispatch + URL/body construction
// without going over the network.

async function _createIssueGithub({ token, owner, repo, title, body, labels }, httpsJson) {
  // GitHub REST: JSON body + token in Authorization header. labels: array.
  const fetcher = httpsJson || _httpsJson;
  const result = await fetcher({
    hostname: 'api.github.com',
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'myco/1.0',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: {
      title: String(title || '').slice(0, 250),
      body: String(body || ''),
      labels: Array.isArray(labels) ? labels : undefined,
    },
  });
  if (result.status >= 200 && result.status < 300 && result.body.number) {
    return { number: result.body.number, url: result.body.html_url };
  }
  return {
    error: result.body.message || result.body.error || `GitHub API ${result.status}`,
    status: result.status,
  };
}

async function _createIssueGitee({ token, owner, repo, title, body, labels }, httpsJson) {
  // Gitee v5 quirks (https://gitee.com/api/v5/swagger):
  //   - Endpoint is /api/v5/repos/{owner}/issues (NOT /repos/{owner}/{repo}/issues
  //     like GitHub) — the repo name goes in the form body as `repo`.
  //   - Token is `access_token` in form body OR query, not Authorization header.
  //   - Body is application/x-www-form-urlencoded, not JSON.
  //   - Labels is a comma-separated string, not an array.
  const fetcher = httpsJson || _httpsJson;
  const form = new URLSearchParams();
  form.set('access_token', token);
  form.set('repo', repo);
  form.set('title', String(title || '').slice(0, 250));
  form.set('body', String(body || ''));
  if (Array.isArray(labels) && labels.length > 0) form.set('labels', labels.join(','));
  const result = await fetcher({
    hostname: 'gitee.com',
    path: `/api/v5/repos/${encodeURIComponent(owner)}/issues`,
    method: 'POST',
    headers: {
      'User-Agent': 'myco/1.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: form.toString(),
  });
  if (result.status >= 200 && result.status < 300 && result.body.number) {
    return { number: result.body.number, url: result.body.html_url };
  }
  return {
    error: result.body.message || result.body.error || `Gitee API ${result.status}`,
    status: result.status,
  };
}

async function createIssue(opts) {
  const provider = String(opts && opts.provider || '').toLowerCase();
  if (provider === 'github') return _createIssueGithub(opts, opts.httpsJson);
  if (provider === 'gitee') return _createIssueGitee(opts, opts.httpsJson);
  return { error: `unknown provider: ${opts && opts.provider}`, status: 0 };
}

// ── fetchUser (token validation) ────────────────────────────────────────────
//
// Used by /setpat to verify a pasted token is real before storing it.
// Returns { login, id, name, avatar_url } on success. Throws on any
// failure (so callers can surface a user-facing reason).
//
// Test seam: same httpsJson injection as createIssue.

async function _fetchUserGithub(token, httpsJson) {
  const fetcher = httpsJson || _httpsJson;
  const result = await fetcher({
    hostname: 'api.github.com',
    path: '/user',
    method: 'GET',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'myco/1.0',
    },
  });
  if (result.status < 200 || result.status >= 300 || !result.body.login) {
    throw new Error(result.body.message || result.body.error || `github /user HTTP ${result.status}`);
  }
  return result.body;
}

async function _fetchUserGitee(token, httpsJson) {
  const fetcher = httpsJson || _httpsJson;
  // Gitee accepts access_token as a query param.
  const result = await fetcher({
    hostname: 'gitee.com',
    path: `/api/v5/user?access_token=${encodeURIComponent(token)}`,
    method: 'GET',
    headers: {
      'User-Agent': 'myco/1.0',
      'Accept': 'application/json',
    },
  });
  if (result.status < 200 || result.status >= 300 || !result.body.login) {
    throw new Error(result.body.message || result.body.error || `gitee /user HTTP ${result.status}`);
  }
  return result.body;
}

async function fetchUser(opts) {
  const provider = String(opts && opts.provider || '').toLowerCase();
  const token = opts && opts.token;
  if (!token) throw new Error('token required');
  if (provider === 'github') return _fetchUserGithub(token, opts.httpsJson);
  if (provider === 'gitee') return _fetchUserGitee(token, opts.httpsJson);
  throw new Error(`unknown provider: ${opts && opts.provider}`);
}

module.exports = {
  detectHost,
  createIssue,
  fetchUser,
  KNOWN_PROVIDERS,
  // Token-store passthrough so callers can do everything through one require.
  getToken: gitTokens.getToken,
  setRepoToken: gitTokens.setRepoToken,
  setUserToken: gitTokens.setUserToken,
  listRepos: gitTokens.listRepos,
};
