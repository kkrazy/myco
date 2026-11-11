// KB service HTTP API.
//
// Zero dependencies — Node's built-in http module. myco is the only
// intended client; the API is deliberately small and stable:
//
//   GET  /health                        liveness + version + KB count
//   GET  /kbs                           list knowledge bases
//   GET  /kbs/:kb/stats                 counts, taxonomy, note breakdown
//   POST /kbs/:kb/search                { query, k, kinds, source, ... }
//   GET  /kbs/:kb/chunks/:id            full chunk + neighbours
//   GET  /kbs/:kb/related               ?paper=<slug>&family=<id>
//   GET  /kbs/:kb/notes                 ?kind=&status=&limit=
//   POST /kbs/:kb/notes                 { title, content, kind, tags, ... }
//   GET  /kbs/:kb/notes/:slug           one note (front matter + body)
//   PATCH /kbs/:kb/notes/:slug          { status } | { content } | { title }
//   DELETE /kbs/:kb/notes/:slug
//   POST /kbs/:kb/notes/reindex         rebuild local index from Markdown
//   POST /kbs/:kb/build                 { corpus, incremental } (admin)
//
// Auth: when KB_TOKEN is set, every request needs
// `Authorization: Bearer <token>`. /health is always open (no data).

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const { Registry, err } = require('./registry');
const retriever = require('./retriever');
const notes = require('./notes');
const embed = require('./embed');

const MAX_BODY_BYTES = 1024 * 1024;

function createServer(cfg = config.load()) {
  const registry = new Registry(cfg.root);
  const embedder = embed.makeProvider(cfg);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const route = matchRoute(req.method, url.pathname);

      if (!route) return send(res, 404, { error: 'not found', path: url.pathname });
      if (route.name !== 'health' && cfg.token && !authorized(req, cfg.token)) {
        return send(res, 401, { error: 'unauthorized' });
      }

      const body = ['POST', 'PATCH', 'PUT'].includes(req.method)
        ? await readJson(req) : {};
      const out = await route.handler({
        req, url, body, registry, cfg, embedder,
        params: route.params,
      });
      // Handlers return either a plain payload (200) or an explicit
      // { __status, __body } envelope. A bare `status`/`body` key cannot be
      // used: note objects legitimately carry `status: 'verified'`.
      if (out !== undefined) {
        if (out && out.__status) send(res, out.__status, out.__body);
        else send(res, 200, out);
      }
    } catch (e) {
      const status = statusFor(e);
      if (status >= 500) console.error(`[kb] ${req.method} ${req.url}: ${e.stack || e.message}`);
      send(res, status, { error: e.message, code: e.code || null });
    } finally {
      const ms = Date.now() - started;
      if (ms > 500) console.log(`[kb] slow ${req.method} ${req.url} ${ms}ms`);
    }
  });

  server.on('close', () => registry.closeAll());
  return { server, registry, config: cfg };
}

// ── routing ─────────────────────────────────────────────────────────────

function matchRoute(method, pathname) {
  // Slugs may contain non-ASCII (CJK titles), so every path segment must
  // be percent-decoded before use.
  const parts = pathname.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });

  if (method === 'GET' && pathname === '/health') {
    return { name: 'health', handler: ({ registry, cfg }) => ({
      ok: true,
      version: cfg.version,
      node: cfg.nodeVersion,
      host: cfg.hostname,
      root: cfg.root,
      kbs: registry.list().map((k) => k.name),
      vector: !!cfg.embed.url,
    }) };
  }

  if (method === 'GET' && pathname === '/kbs') {
    return { name: 'kbs', handler: ({ registry, cfg }) => ({
      root: cfg.root,
      kbs: registry.list(),
    }) };
  }

  if (parts[0] !== 'kbs' || !parts[1]) return null;
  const kb = parts[1];
  const rest = parts.slice(2);

  if (rest.length === 0 && method === 'GET') {
    return { name: 'kb', handler: ({ registry }) => {
      const all = registry.list();
      const found = all.find((k) => k.name === kb);
      if (!found) throw err('ERR_NOT_FOUND', `knowledge base not found: ${kb}`);
      return found;
    } };
  }

  if (rest[0] === 'stats' && method === 'GET') {
    return { name: 'stats', handler: ({ registry }) => retriever.stats(registry.conn(kb)) };
  }

  if (rest[0] === 'search' && method === 'POST') {
    return { name: 'search', handler: async ({ registry, body, cfg, embedder }) => {
      const db = registry.conn(kb);
      const out = await retriever.search(db, body.query, {
        k: body.k,
        kinds: body.kinds,
        source: body.source,
        discipline: body.discipline,
        family: body.family,
        paperSlug: body.paper,
        noteSlug: body.note,
        includeVersions: !!body.includeVersions,
        includeRefs: !!body.includeRefs,
        includeDeprecated: !!body.includeDeprecated,
        snippetChars: body.snippetChars || cfg.maxSnippetChars,
        sourceWeight: body.sourceWeight,
        embedder,
      });
      // Hit counters are best-effort and never block the response.
      const localSlugs = [...new Set(out.results.filter((r) => r.noteSlug).map((r) => r.noteSlug))];
      if (localSlugs.length) {
        try {
          const w = registry.writeConn(kb);
          notes.bumpHits(w, localSlugs);
          w.close();
        } catch { /* counters are optional */ }
      }
      return out;
    } };
  }

  if (rest[0] === 'chunks' && rest[1] && method === 'GET') {
    return { name: 'chunk', handler: ({ registry, url }) => {
      const db = registry.conn(kb);
      const base = retriever.getChunk(db, rest[1]);
      if (!base) throw err('ERR_NOT_FOUND', `chunk not found: ${rest[1]}`);
      const around = url.searchParams.get('neighbours') === '0' ? [] : retriever.neighbours(db, rest[1], 1, 1);
      return {
        chunk: retriever.shape({ ...base, id: base.id }, { snippetChars: 100000 }),
        neighbours: around.map((r) => retriever.shape({ ...r, id: r.id }, { snippetChars: 2000 })),
      };
    } };
  }

  if (rest[0] === 'related' && method === 'GET') {
    return { name: 'related', handler: ({ registry, url }) => ({
      related: retriever.related(registry.conn(kb), {
        paperSlug: url.searchParams.get('paper') || undefined,
        familyId: url.searchParams.get('family') || undefined,
        limit: parseInt(url.searchParams.get('limit'), 10) || 8,
      }),
    }) };
  }

  if (rest[0] === 'notes') {
    if (rest.length === 1 && method === 'GET') {
      return { name: 'notes-list', handler: ({ registry, url }) => ({
        notes: notes.listNotes(registry.conn(kb), {
          kind: url.searchParams.get('kind') || undefined,
          status: url.searchParams.get('status') || undefined,
          limit: parseInt(url.searchParams.get('limit'), 10) || 100,
        }),
      }) };
    }
    if (rest.length === 1 && method === 'POST') {
      return { name: 'notes-create', handler: ({ registry, body }) => {
        const w = registry.writeConn(kb);
        try {
          const out = notes.remember(registry.dir(kb), w, body);
          notes.rebuildIndexFile(registry.dir(kb), w);
          return { __status: out.created ? 201 : 200, __body: out };
        } finally { w.close(); }
      } };
    }
    if (rest[1] === 'reindex' && method === 'POST') {
      return { name: 'notes-reindex', handler: ({ registry }) => {
        const w = registry.writeConn(kb);
        try {
          const out = notes.reindexAll(registry.dir(kb), w);
          notes.rebuildIndexFile(registry.dir(kb), w);
          return out;
        } finally { w.close(); }
      } };
    }
    if (rest[1] && method === 'GET') {
      return { name: 'note-get', handler: ({ registry }) => {
        const note = notes.readNote(registry.dir(kb), rest[1]);
        if (!note) throw err('ERR_NOT_FOUND', `note not found: ${rest[1]}`);
        return { meta: note.meta, body: note.body };
      } };
    }
    if (rest[1] && method === 'PATCH') {
      return { name: 'note-patch', handler: ({ registry, body }) => {
        const w = registry.writeConn(kb);
        try {
          if (body.status) return notes.setStatus(registry.dir(kb), w, rest[1], body.status);
          const cur = notes.readNote(registry.dir(kb), rest[1]);
          if (!cur) throw err('ERR_NOT_FOUND', `note not found: ${rest[1]}`);
          return notes.remember(registry.dir(kb), w, {
            slug: rest[1],
            title: body.title || cur.meta.title,
            kind: cur.meta.kind,
            content: body.content != null ? body.content : cur.body,
            replace: body.content != null,
            tags: body.tags || cur.meta.tags,
            scope: body.scope || cur.meta.scope,
            confidence: body.confidence || cur.meta.confidence,
            source: cur.meta.source,
          });
        } finally { w.close(); }
      } };
    }
    if (rest[1] && method === 'DELETE') {
      return { name: 'note-delete', handler: ({ registry }) => {
        const w = registry.writeConn(kb);
        try {
          const out = notes.removeNote(registry.dir(kb), w, rest[1]);
          notes.rebuildIndexFile(registry.dir(kb), w);
          return out;
        } finally { w.close(); }
      } };
    }
  }

  if (rest[0] === 'build' && method === 'POST') {
    return { name: 'build', handler: async ({ registry, body }) => {
      const builder = require('./builder');
      const kbDir = registry.dir(kb);
      if (!body.corpus || !fs.existsSync(body.corpus)) {
        throw err('ERR_BAD_INPUT', 'body.corpus must be an existing directory');
      }
      registry.invalidate(kb);
      const out = builder.build({
        corpusRoot: body.corpus,
        kbDir,
        incremental: !!body.incremental,
      });
      // Notes are authoritative in Markdown — re-ingest them into the new
      // index (the build replaced the DB file).
      const w = registry.writeConn(kb);
      try {
        const reindexed = notes.reindexAll(kbDir, w);
        notes.rebuildIndexFile(kbDir, w);
        fs.writeFileSync(path.join(kbDir, 'manifest.json'), JSON.stringify({
          name: kb,
          corpus: path.resolve(body.corpus),
          builtAt: new Date().toISOString(),
          ...out,
          notes: reindexed.indexed,
        }, null, 2), 'utf8');
        return { ...out, notes: reindexed.indexed };
      } finally { w.close(); }
    } };
  }

  return null;
}

// ── helpers ─────────────────────────────────────────────────────────────

function authorized(req, token) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

function statusFor(e) {
  switch (e && e.code) {
    case 'ERR_BAD_INPUT': return 400;
    case 'ERR_NOT_FOUND': return 404;
    case 'ERR_EXISTS': return 409;
    case 'ERR_TOO_LARGE': return 413;
    case 'ERR_NO_INDEX': return 503;
    default: return 500;
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(err('ERR_TOO_LARGE', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(err('ERR_BAD_INPUT', 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// ── entrypoint ──────────────────────────────────────────────────────────

function start() {
  const cfg = config.load();
  const { server } = createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[kb] listening on http://${cfg.host}:${cfg.port} (root=${cfg.root})`);
    console.log(`[kb] vector search: ${cfg.embed.url ? `on (${cfg.embed.model})` : 'off (lexical only)'}`);
  });
  const shutdown = (sig) => {
    console.log(`[kb] ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, matchRoute };
