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
        // fr-80 r3: capture response headers so callers can read the
        // X-OAuth-Scopes header GitHub returns on every API call (the
        // single most useful signal when debugging "Resource not
        // accessible by personal access token" 403s — it tells you
        // exactly what scopes the token actually carries vs. what the
        // endpoint requires).
        resolve({ status: res.statusCode, body: parsed, headers: res.headers || {} });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: { error: err.message }, headers: {} }));
    req.on('timeout', () => { try { req.destroy(); } catch {}; resolve({ status: 0, body: { error: 'timeout' }, headers: {} }); });
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
  // fr-80 r3: surface the token's actual OAuth scopes + the endpoint's
  // required scopes so the user can see EXACTLY what's missing. Both
  // headers are returned by GitHub on every authenticated request,
  // including 403s.
  const scopes = (result.headers && result.headers['x-oauth-scopes']) || '';
  const acceptedScopes = (result.headers && result.headers['x-accepted-oauth-scopes']) || '';
  return {
    error: result.body.message || result.body.error || `GitHub API ${result.status}`,
    status: result.status,
    scopes: String(scopes).trim(),
    acceptedScopes: String(acceptedScopes).trim(),
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

// ── fetchIssues (fr-81: Plan view ingest) ───────────────────────────────────
//
// Reads the open + (optionally) closed issues for {provider, owner, repo} and
// returns a normalized array so the Plan view can render GitHub + Gitee
// issues side-by-side without knowing which host they came from.
//
// Normalized shape (one row):
//   { provider, number, title, body, htmlUrl, state, author,
//     createdAt, updatedAt, labels: [string], isPullRequest }
//
// Pagination: requests `per_page` items per page. Loops up to `maxPages`
// (default 5 = 500 issues for github/per_page=100). Stops early when a
// page returns fewer than `per_page` rows.
//
// State: 'open' (default), 'closed', or 'all'. Maps to each provider's
// query semantics.
//
// Test seam: pass `httpsJson` to inject a fake fetcher (same pattern as
// createIssue + fetchUser).

const _DEFAULT_ISSUES_PER_PAGE = 100;
const _DEFAULT_ISSUES_MAX_PAGES = 5;

async function _fetchIssuesGithub({ token, owner, repo, state, perPage, maxPages }, httpsJson) {
  const fetcher = httpsJson || _httpsJson;
  const per = Math.max(1, Math.min(100, perPage || _DEFAULT_ISSUES_PER_PAGE));
  const cap = Math.max(1, Math.min(20, maxPages || _DEFAULT_ISSUES_MAX_PAGES));
  const items = [];
  let lastStatus = 0;
  for (let page = 1; page <= cap; page++) {
    const result = await fetcher({
      hostname: 'api.github.com',
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${encodeURIComponent(state || 'open')}&per_page=${per}&page=${page}`,
      method: 'GET',
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'myco/1.0',
        'Accept': 'application/vnd.github+json',
      },
    });
    lastStatus = result.status;
    if (result.status < 200 || result.status >= 300) {
      return { items, status: result.status, error: result.body && (result.body.message || result.body.error) };
    }
    const rows = Array.isArray(result.body) ? result.body : [];
    for (const r of rows) {
      items.push({
        provider: 'github',
        number: r.number,
        // 250-char truncation matches what createIssue uses for the
        // outbound path (line ~107) and GitHub's UI cap (~256 in
        // practice). Defensive against a pathological 50k-char title
        // dragging down the Plan view's render. Real titles never
        // exceed ~200.
        title: String(r.title || '').slice(0, 250),
        body: String(r.body || ''),
        htmlUrl: r.html_url,
        state: r.state,
        author: (r.user && r.user.login) || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        labels: Array.isArray(r.labels) ? r.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean) : [],
        // GitHub's /issues endpoint returns PRs too — flag them so the
        // Plan view can hide / badge them differently.
        isPullRequest: !!r.pull_request,
      });
    }
    if (rows.length < per) break;
  }
  return { items, status: lastStatus };
}

async function _fetchIssuesGitee({ token, owner, repo, state, perPage, maxPages }, httpsJson) {
  const fetcher = httpsJson || _httpsJson;
  const per = Math.max(1, Math.min(100, perPage || _DEFAULT_ISSUES_PER_PAGE));
  const cap = Math.max(1, Math.min(20, maxPages || _DEFAULT_ISSUES_MAX_PAGES));
  const items = [];
  let lastStatus = 0;
  // Gitee state values: 'open' | 'progressing' | 'closed' | 'rejected' | 'all'.
  // Map 'open' to 'open,progressing' so we don't miss work-in-progress
  // issues; map 'closed' to 'closed,rejected' for the same reason.
  const giteeState = state === 'closed' ? 'closed,rejected'
                    : state === 'all' ? 'all'
                    : 'open,progressing';
  // Gitee's API convention puts `access_token` in the URL query rather
  // than an Authorization header — same pattern as the existing
  // _fetchUserGitee. The token is therefore visible in proxy logs /
  // browser history if anyone catches an outbound request, which is a
  // known concession to Gitee's API design (no header-auth alternative
  // for v5 GET endpoints). We mitigate by (a) only making these calls
  // server-side over HTTPS, (b) the token never crosses the WS to the
  // browser, and (c) token storage is mode-0600 in /data/git-tokens.json.
  // No new exposure vs. the pre-fr-81 surface.
  for (let page = 1; page <= cap; page++) {
    const result = await fetcher({
      hostname: 'gitee.com',
      path: `/api/v5/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?access_token=${encodeURIComponent(token)}&state=${encodeURIComponent(giteeState)}&per_page=${per}&page=${page}`,
      method: 'GET',
      headers: {
        'User-Agent': 'myco/1.0',
        'Accept': 'application/json',
      },
    });
    lastStatus = result.status;
    if (result.status < 200 || result.status >= 300) {
      return { items, status: result.status, error: result.body && (result.body.message || result.body.error) };
    }
    const rows = Array.isArray(result.body) ? result.body : [];
    for (const r of rows) {
      items.push({
        provider: 'gitee',
        number: r.number,
        title: String(r.title || '').slice(0, 250),
        body: String(r.body || ''),
        htmlUrl: r.html_url,
        state: r.state,
        author: (r.user && r.user.login) || '',
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        labels: Array.isArray(r.labels) ? r.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean) : [],
        // Gitee has no PR-in-issues conflation (issues + PRs are
        // separate APIs), so this is always false here.
        isPullRequest: false,
      });
    }
    if (rows.length < per) break;
  }
  return { items, status: lastStatus };
}

async function fetchIssues(opts) {
  const provider = String(opts && opts.provider || '').toLowerCase();
  if (provider === 'github') return _fetchIssuesGithub(opts, opts.httpsJson);
  if (provider === 'gitee') return _fetchIssuesGitee(opts, opts.httpsJson);
  return { items: [], status: 0, error: `unknown provider: ${opts && opts.provider}` };
}

// ── closeIssue (fr-81 Phase B.4: write-back on local close) ─────────────────
//
// Closes an issue upstream. Used by the Plan-view close action when
// the item carries meta.remoteUrl (set by Phase B.1's auto-promote).
//
// Returns { ok: true, number, url } on success, or { error, status }
// on failure. Never throws — network errors come back through the
// status-0 path same as fetchIssues.
//
// GitHub: PATCH /repos/{owner}/{repo}/issues/{number} with JSON body
// `{state: "closed"}`. Token in Authorization header.
// Gitee:  PATCH /api/v5/repos/{owner}/issues/{number} (note: owner
// in path, NOT owner/repo — Gitee's own quirk for the issue-update
// endpoint, same shape as _createIssueGitee). Body form-encoded
// with access_token + state=closed + repo=<repo>.

async function _closeIssueGithub({ token, owner, repo, number }, httpsJson) {
  const fetcher = httpsJson || _httpsJson;
  const r = await fetcher({
    hostname: 'api.github.com',
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}`,
    method: 'PATCH',
    headers: {
      'Authorization': `token ${token}`,
      'User-Agent': 'myco/1.0',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: { state: 'closed' },
  });
  if (r.status >= 200 && r.status < 300 && r.body && r.body.number) {
    return { ok: true, number: r.body.number, url: r.body.html_url };
  }
  return {
    error: (r.body && (r.body.message || r.body.error)) || `GitHub close API ${r.status}`,
    status: r.status,
  };
}

async function _closeIssueGitee({ token, owner, repo, number }, httpsJson) {
  const fetcher = httpsJson || _httpsJson;
  const form = new URLSearchParams();
  form.set('access_token', token);
  form.set('repo', repo);
  form.set('state', 'closed');
  const r = await fetcher({
    hostname: 'gitee.com',
    path: `/api/v5/repos/${encodeURIComponent(owner)}/issues/${encodeURIComponent(number)}`,
    method: 'PATCH',
    headers: {
      'User-Agent': 'myco/1.0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: form.toString(),
  });
  if (r.status >= 200 && r.status < 300 && r.body && r.body.number) {
    return { ok: true, number: r.body.number, url: r.body.html_url };
  }
  return {
    error: (r.body && (r.body.message || r.body.error)) || `Gitee close API ${r.status}`,
    status: r.status,
  };
}

async function closeIssue(opts) {
  const provider = String(opts && opts.provider || '').toLowerCase();
  if (!opts || !opts.token || !opts.owner || !opts.repo || !opts.number) {
    return { error: 'closeIssue requires {provider, token, owner, repo, number}', status: 0 };
  }
  if (provider === 'github') return _closeIssueGithub(opts, opts.httpsJson);
  if (provider === 'gitee') return _closeIssueGitee(opts, opts.httpsJson);
  return { error: `unknown provider: ${opts.provider}`, status: 0 };
}

module.exports = {
  detectHost,
  createIssue,
  closeIssue,
  fetchUser,
  fetchIssues,
  KNOWN_PROVIDERS,
  // Token-store passthrough so callers can do everything through one require.
  getToken: gitTokens.getToken,
  listAliases: gitTokens.listAliases,
  setRepoToken: gitTokens.setRepoToken,
  setUserToken: gitTokens.setUserToken,
  listRepos: gitTokens.listRepos,
};
