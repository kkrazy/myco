// ─── MCP MARKET → IN-PROCESS SDK MCP SERVER ────────────────────────────
// The tool half of the MCP market (additive layer over market.js's
// skill packs): a per-session SDK MCP server (pattern:
// server/src/myco-mcp.js) exposing the `sdkTools` declared by
// INSTALLED catalog entries (rec.installedMcp) as real callable tools:
//   mcp__myco_mcp__<entry>_<tool>
// e.g. mcp__myco_mcp__github_create_issue.
//
// Installing a market entry therefore gives the agent BOTH halves:
//   (a) the guidance SKILLS copied into .claude/skills/ (market.js
//       installServer) — interface, params, curl/JSON-RPC examples;
//   (b) these server-side tools for the operations myco can execute
//       itself with the session's stored credentials.
// Entries without `sdkTools` (filesystem/postgres stdio packs,
// intranet-gated CodeHub) contribute skills only — no server here.
//
// Handlers are grouped per entry name in `handlers` below;
// builtin-servers.js is the single source of truth for the surface.
// Credential resolution goes through myco's existing token store
// (server/src/git-tokens.js) — no secrets ever enter the prompt.
'use strict';

const { createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');
const { builtinServers } = require('./builtin-servers');

// How long a single outbound HTTP call inside a tool may take.
const HTTP_TIMEOUT_MS = 20000;
const MAX_TEXT_CHARS = 20000;

// ── small fetch helper (global fetch, bounded) ──────────────────────────
async function _fetchJson(url, { headers, method, body } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: method || 'GET',
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctl.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

function _txt(str, isError) {
  const s = String(str == null ? '' : str);
  return {
    content: [{ type: 'text', text: s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) + '\n…[truncated]' : s }],
    isError: !!isError,
  };
}

// Minimal HTML → text: strips script/style blocks + tags, collapses
// whitespace. Deliberately regex-based (no DOM dependency server-side).
function _htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── credential resolution (myco's existing stores) ──────────────────────
// Token for the session's user + provider, or null. `owner/repo`
// optionally resolves the per-repo PAT override (gitee).
function _gitToken(sessionId, provider, owner, repo) {
  try {
    const gitTokens = require('../git-tokens');
    const sessionsMod = require('../sessions');
    const rec = sessionsMod.loadStore().sessions[sessionId];
    const user = (rec && rec.user) || 'default';
    return gitTokens.getToken(user, provider, owner, repo) || null;
  } catch {
    return null;
  }
}

// ── per-entry tool handlers ─────────────────────────────────────────────
// Each handler: async (args, sessionId) → _txt() result.

const handlers = {

  github: {
    async list_repos(args, sessionId) {
      const tok = _gitToken(sessionId, 'github');
      const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (tok) headers.Authorization = `Bearer ${tok}`;
      else return _txt('No GitHub token on file — sign in via GitHub OAuth or run /setpat from the session. Unauthenticated listing needs a target user; see the mcp-github skill for the curl flow.', true);
      const per = Math.min(Math.max(parseInt(args.perPage, 10) || 30, 1), 100);
      const r = await _fetchJson(`https://api.github.com/user/repos?per_page=${per}&sort=updated`, { headers });
      if (r.status !== 200) return _txt(`GitHub list_repos failed: HTTP ${r.status} ${r.text.slice(0, 300)}`, true);
      const rows = (Array.isArray(r.json) ? r.json : []).map((x) => `${x.full_name} [${x.visibility || (x.private ? 'private' : 'public')}] ${x.html_url}`);
      return _txt(rows.length ? rows.join('\n') : 'no repositories visible for this token');
    },
    async get_file(args, sessionId) {
      const tok = _gitToken(sessionId, 'github');
      const headers = { Accept: 'application/vnd.github.raw' };
      if (tok) headers.Authorization = `Bearer ${tok}`;
      const ref = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
      const r = await _fetchJson(`https://api.github.com/repos/${args.owner}/${args.repo}/contents/${args.path}${ref}`, { headers });
      if (r.status !== 200) return _txt(`GitHub get_file failed: HTTP ${r.status} ${r.text.slice(0, 300)}`, true);
      return _txt(r.text);
    },
    async create_issue(args, sessionId) {
      const tok = _gitToken(sessionId, 'github');
      if (!tok) return _txt('No GitHub token on file — sign in via GitHub OAuth or run /setpat from the session.', true);
      const r = await _fetchJson(`https://api.github.com/repos/${args.owner}/${args.repo}/issues`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' },
        body: { title: args.title, body: args.body || '' },
      });
      if (r.status !== 201) return _txt(`GitHub create_issue failed: HTTP ${r.status} ${r.text.slice(0, 300)}`, true);
      return _txt(`Created issue #${r.json.number}: ${r.json.html_url}`);
    },
    async list_issues(args, sessionId) {
      const tok = _gitToken(sessionId, 'github');
      const headers = { Accept: 'application/vnd.github+json' };
      if (tok) headers.Authorization = `Bearer ${tok}`;
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
      const r = await _fetchJson(`https://api.github.com/repos/${args.owner}/${args.repo}/issues?state=open&per_page=${limit}`, { headers });
      if (r.status !== 200) return _txt(`GitHub list_issues failed: HTTP ${r.status} ${r.text.slice(0, 300)}`, true);
      const rows = (Array.isArray(r.json) ? r.json : []).map((x) => `#${x.number} ${x.title} (${x.html_url})`);
      return _txt(rows.length ? rows.join('\n') : 'no open issues');
    },
  },

  gitee: {
    async list_repos(args) {
      const r = await _fetchJson(`https://gitee.com/api/v5/users/${args.user}/repos?per_page=50`);
      if (r.status !== 200) return _txt(`Gitee list_repos failed: HTTP ${r.status} ${r.text.slice(0, 300)}`, true);
      const rows = (Array.isArray(r.json) ? r.json : []).map((x) => `${x.full_name} ${x.html_url}`);
      return _txt(rows.length ? rows.join('\n') : 'no repositories found');
    },
    async list_issues(args) {
      const r = await _fetchJson(`https://gitee.com/api/v5/repos/${args.owner}/${args.repo}/issues?state=open&per_page=50`);
      if (r.status !== 200) return _txt(`Gitee list_issues failed: HTTP ${r.status} ${r.text.slice(0, 300)}`, true);
      const rows = (Array.isArray(r.json) ? r.json : []).map((x) => `#${x.number} ${x.title} (${x.html_url})`);
      return _txt(rows.length ? rows.join('\n') : 'no open issues');
    },
    async create_issue(args, sessionId) {
      const tok = _gitToken(sessionId, 'gitee', args.owner, args.repo);
      if (!tok) return _txt('No Gitee PAT on file for this repo — run /setpat <token> from a session whose origin is the gitee repo.', true);
      const r = await _fetchJson(`https://gitee.com/api/v5/repos/${args.owner}/${args.repo}/issues`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}` },
        body: { title: args.title, body: args.body || '' },
      });
      if (r.status !== 201) return _txt(`Gitee create_issue failed: HTTP ${r.status} ${r.text.slice(0, 300)}`, true);
      return _txt(`Created issue #${r.json.number}: ${r.json.html_url}`);
    },
  },

  'web-search': {
    async fetch_url(args) {
      const maxChars = Math.min(Math.max(parseInt(args.maxChars, 10) || MAX_TEXT_CHARS, 500), 60000);
      const r = await _fetchJson(args.url, {});
      if (r.status >= 400) return _txt(`fetch failed: HTTP ${r.status} ${r.text.slice(0, 200)}`, true);
      const text = _htmlToText(r.text);
      return _txt(text.length > maxChars ? text.slice(0, maxChars) + '\n…[truncated]' : text);
    },
    async search_page(args) {
      const r = await _fetchJson(args.url, {});
      if (r.status >= 400) return _txt(`fetch failed: HTTP ${r.status}`, true);
      const paras = _htmlToText(r.text).split(/\n\s*\n/);
      const kw = String(args.keyword || '').toLowerCase();
      const hits = paras.filter((p) => p.toLowerCase().includes(kw)).slice(0, 40);
      return _txt(hits.length ? hits.join('\n—\n') : `no paragraphs matched "${args.keyword}"`);
    },
  },
};

// ── zod param schemas ───────────────────────────────────────────────────
function _zodParam(p) {
  const isNum = p.type === 'number';
  let base;
  if (isNum) {
    base = z.coerce.number().int();
    const m = /(\d+)\s*-\s*(\d+)/.exec(p.description || '');
    if (m) base = base.min(parseInt(m[1], 10)).max(parseInt(m[2], 10));
  } else {
    base = z.string();
  }
  const desc = p.description || p.name;
  return p.required ? base.describe(desc) : base.optional().describe(desc);
}

function _zodArgs(toolEntry) {
  const shape = {};
  for (const p of toolEntry.params || []) shape[p.name] = _zodParam(p);
  return z.object(shape);
}

// ── server construction ────────────────────────────────────────────────
// `installed` = array of catalog entry names installed in THIS session
// (rec.installedMcp). Only those entries' sdkTools are exposed; an
// entry without sdkTools or handlers contributes nothing. Returns null
// when no tools apply (session sdkOpts stays untouched).
function createMarketMcpServer(sessionId, installed) {
  const inst = new Set(Array.isArray(installed) ? installed : []);
  const byName = new Map(builtinServers.map((s) => [s.name, s]));
  const tools = [];
  for (const name of inst) {
    const entry = byName.get(name);
    if (!entry || !Array.isArray(entry.sdkTools)) continue;
    const entryHandlers = handlers[name];
    if (!entryHandlers) continue;
    for (const t of entry.sdkTools) {
      const fn = entryHandlers[t.name];
      if (!fn) continue;
      const paramSummary = (t.params || []).map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ');
      tools.push(tool(
        `${name}_${t.name}`,
        `${t.description} [params: ${paramSummary}]`,
        _zodArgs(t),
        async (args) => {
          try {
            return await fn(args, sessionId);
          } catch (e) {
            return _txt(`tool call failed: ${e.message || e}`, true);
          }
        },
      ));
    }
  }
  if (!tools.length) return null;   // nothing executable → no server
  return createSdkMcpServer({
    name: 'myco_mcp',
    version: '1.0.0',
    tools,
  });
}

module.exports = {
  createMarketMcpServer,
  handlers,
  _htmlToText,          // exported for tests
  MARKET_MCP_TOOL_PREFIX: 'mcp__myco_mcp__',
};
