// Thin HTTP client for the standalone KB service.
//
// myco does NOT index or search anything itself — the knowledge base is a
// separate process (kb-service/) reached over HTTP. This module is the only
// place that knows the wire protocol, so swapping the backend (a different
// service, a remote host, a different store) touches one file.
//
// Configuration ($MYCO_STATE_DIR/.env or the process env):
//   MYCO_KB_URL    base URL, e.g. http://127.0.0.1:7317  (unset = disabled)
//   MYCO_KB_TOKEN  bearer token, if the service requires one
//   MYCO_KB_TIMEOUT_MS  per-request timeout (default 5000)
//
// Every call fails OPEN: when the service is down or unconfigured, the
// caller gets { ok: false, error } and the agent simply proceeds without
// domain knowledge. A knowledge base outage must never block a turn.

'use strict';

const DEFAULT_TIMEOUT_MS = 5000;

function config() {
  const url = String(process.env.MYCO_KB_URL || '').replace(/\/+$/, '');
  return {
    url,
    token: process.env.MYCO_KB_TOKEN || '',
    timeoutMs: parseInt(process.env.MYCO_KB_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
    enabled: !!url,
  };
}

function isEnabled() {
  return config().enabled;
}

// One HTTP call. Never throws; returns { ok, status, data, error }.
async function request(method, pathname, body, opts = {}) {
  const cfg = config();
  if (!cfg.enabled) {
    return { ok: false, status: 0, error: 'knowledge base service is not configured (MYCO_KB_URL unset)' };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.url}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: (data && data.error) || `HTTP ${res.status}`,
        data,
      };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    const error = e.name === 'AbortError'
      ? `knowledge base request timed out after ${opts.timeoutMs || cfg.timeoutMs}ms`
      : e.message;
    return { ok: false, status: 0, error };
  } finally {
    clearTimeout(timer);
  }
}

// ── API surface (mirrors kb-service/src/server.js) ──────────────────────

async function health() {
  return request('GET', '/health');
}

async function listKbs() {
  return request('GET', '/kbs');
}

async function stats(kb) {
  return request('GET', `/kbs/${enc(kb)}/stats`);
}

// search(kb, query, opts) → { ok, data: { count, results, vector } }
async function search(kb, query, opts = {}) {
  return request('POST', `/kbs/${enc(kb)}/search`, {
    query,
    k: opts.k,
    kinds: opts.kinds,
    source: opts.source,
    discipline: opts.discipline,
    family: opts.family,
    paper: opts.paper,
    note: opts.note,
    includeVersions: opts.includeVersions,
    includeRefs: opts.includeRefs,
    includeDeprecated: opts.includeDeprecated,
    snippetChars: opts.snippetChars,
  }, { timeoutMs: opts.timeoutMs });
}

async function getChunk(kb, chunkId, opts = {}) {
  const qs = opts.neighbours === false ? '?neighbours=0' : '';
  return request('GET', `/kbs/${enc(kb)}/chunks/${encodeURIComponent(chunkId)}${qs}`);
}

async function related(kb, { paper, family, limit } = {}) {
  const qs = new URLSearchParams();
  if (paper) qs.set('paper', paper);
  if (family) qs.set('family', family);
  if (limit) qs.set('limit', String(limit));
  return request('GET', `/kbs/${enc(kb)}/related?${qs.toString()}`);
}

async function listNotes(kb, opts = {}) {
  const qs = new URLSearchParams();
  if (opts.kind) qs.set('kind', opts.kind);
  if (opts.status) qs.set('status', opts.status);
  if (opts.limit) qs.set('limit', String(opts.limit));
  return request('GET', `/kbs/${enc(kb)}/notes?${qs.toString()}`);
}

async function getNote(kb, slug) {
  return request('GET', `/kbs/${enc(kb)}/notes/${encodeURIComponent(slug)}`);
}

// remember(kb, note) → { ok, data: { slug, created, merged, kind, status } }
async function remember(kb, note) {
  return request('POST', `/kbs/${enc(kb)}/notes`, note, { timeoutMs: 15000 });
}

async function patchNote(kb, slug, patch) {
  return request('PATCH', `/kbs/${enc(kb)}/notes/${encodeURIComponent(slug)}`, patch, { timeoutMs: 15000 });
}

async function deleteNote(kb, slug) {
  return request('DELETE', `/kbs/${enc(kb)}/notes/${encodeURIComponent(slug)}`);
}

async function reindexNotes(kb) {
  return request('POST', `/kbs/${enc(kb)}/notes/reindex`, {}, { timeoutMs: 30000 });
}

function enc(s) {
  return encodeURIComponent(String(s || ''));
}

module.exports = {
  config,
  isEnabled,
  request,
  health,
  listKbs,
  stats,
  search,
  getChunk,
  related,
  listNotes,
  getNote,
  remember,
  patchNote,
  deleteNote,
  reindexNotes,
};
