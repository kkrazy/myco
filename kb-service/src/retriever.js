// Hybrid retrieval over the KB index.
//
// P0 path (always available): FTS5 BM25 over the word index, with title and
// section field weights. Measured on the real corpus: p50 ~3 ms, recall@5
// 0.975 for abstract-derived queries.
//
// CJK path: the trigram index (only CJK chunks are stored there).
//
// Optional vector path: when an embedding provider is configured, the
// retriever also runs a KNN over `chunks_vec` and fuses the two ranked
// lists with Reciprocal Rank Fusion. Absent a provider, everything still
// works — vector search is an enhancement, not a prerequisite.

'use strict';

const q = require('./query');

const DEFAULT_K = 6;
const MAX_K = 20;
// Field weights (text, title, section). Tuned on the real corpus: a very
// high title weight (10) let a paper-title match outrank the passage that
// actually answers the query; 4 keeps the title signal without burying
// the content.
const BM25_WEIGHTS = 'bm25(chunks_fts, 1.0, 4.0, 2.0)';
const RRF_K = 60;

// ── filters ─────────────────────────────────────────────────────────────

// Build the shared WHERE fragment for a result set.
// opts: { kinds, source, discipline, family, includeVersions,
//         includeRefs, includeDeprecated, paperSlug, noteSlug }
function buildFilter(opts = {}) {
  const where = [];
  const params = [];
  const kinds = Array.isArray(opts.kinds) ? opts.kinds.filter(Boolean) : null;
  if (kinds && kinds.length) {
    where.push(`c.kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  } else if (!opts.includeRefs) {
    where.push("c.kind <> 'refs'");
  }
  if (opts.source && (opts.source === 'corpus' || opts.source === 'local')) {
    where.push('c.source = ?');
    params.push(opts.source);
  }
  if (opts.paperSlug) { where.push('p.slug = ?'); params.push(opts.paperSlug); }
  if (opts.noteSlug) { where.push('n.slug = ?'); params.push(opts.noteSlug); }
  if (opts.family) { where.push('c.family_id = ?'); params.push(String(opts.family)); }
  if (opts.discipline) {
    where.push('f.discipline_id = (SELECT id FROM disciplines WHERE name = ?)');
    params.push(String(opts.discipline));
  }
  if (!opts.includeVersions) where.push('(p.id IS NULL OR p.is_latest = 1)');
  if (!opts.includeDeprecated) {
    where.push("(c.source <> 'local' OR n.status <> 'deprecated')");
  }
  return { sql: where.length ? ' AND ' + where.join(' AND ') : '', params };
}

// Base joins for any chunk query. An FTS table must be joined explicitly
// (`JOIN chunks_fts ON chunks_fts.rowid = c.id`) — referencing it only in
// the WHERE clause makes SQLite resolve `chunks_fts` as a column and fail
// with "no such column".
const BASE_JOIN = `
  FROM chunks c
  LEFT JOIN papers p ON p.id = c.paper_id
  LEFT JOIN notes  n ON n.id = c.note_id
  LEFT JOIN families f ON f.id = c.family_id`;

// ── lexical ─────────────────────────────────────────────────────────────

function lexicalSearch(db, terms, opts, limit) {
  const expr = q.buildMatch(terms, opts.matchMode || 'and');
  if (!expr) return [];
  const filter = buildFilter(opts);
  const sql = `
    SELECT c.id, c.source, c.kind, c.text, c.title, c.section, c.section_path,
           c.paper_id, c.note_id, c.family_id, c.anchor_label, c.anchor_name,
           c.source_path, c.line_start, c.line_end,
           p.slug AS paper_slug, p.date AS paper_date,
           n.slug AS note_slug, n.status AS note_status, n.confidence AS note_confidence,
           ${BM25_WEIGHTS} AS score
    ${BASE_JOIN}
    JOIN chunks_fts ON chunks_fts.rowid = c.id
    WHERE chunks_fts MATCH ?${filter.sql}
    ORDER BY score
    LIMIT ?`;
  try {
    return db.prepare(sql).all(expr, ...filter.params, limit);
  } catch (e) {
    if (e.code === 'ERR_NO_INDEX') throw e;
    return [];
  }
}

function cjkSearch(db, terms, opts, limit) {
  const expr = q.buildCjkMatch(terms);
  if (!expr) return [];
  const filter = buildFilter(opts);
  const sql = `
    SELECT c.id, c.source, c.kind, c.text, c.title, c.section, c.section_path,
           c.paper_id, c.note_id, c.family_id, c.anchor_label, c.anchor_name,
           c.source_path, c.line_start, c.line_end,
           p.slug AS paper_slug, p.date AS paper_date,
           n.slug AS note_slug, n.status AS note_status, n.confidence AS note_confidence,
           bm25(chunks_fts_cjk, 1.0, 4.0, 2.0) AS score
    ${BASE_JOIN}
    JOIN chunks_fts_cjk ON chunks_fts_cjk.rowid = c.id
    WHERE chunks_fts_cjk MATCH ?${filter.sql}
    ORDER BY score
    LIMIT ?`;
  try {
    return db.prepare(sql).all(expr, ...filter.params, limit);
  } catch {
    return [];
  }
}

// ── fusion ──────────────────────────────────────────────────────────────

// Reciprocal Rank Fusion over several ranked lists.
function rrf(lists, k = RRF_K) {
  const scores = new Map();
  const byId = new Map();
  lists.forEach((list, li) => {
    list.forEach((row, rank) => {
      const id = row.id;
      byId.set(id, row);
      const prev = scores.get(id) || 0;
      scores.set(id, prev + 1 / (k + rank + 1) * (row._weight || 1));
    });
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...byId.get(id), rrf: score }));
}

// Drop near-duplicates: at most `perPaper` chunks per paper/note and at
// most `perSection` per section, so one long paper cannot fill the list.
function diversify(rows, { perPaper = 3, perSection = 2 } = {}) {
  const paperCount = new Map();
  const sectionCount = new Map();
  const out = [];
  for (const r of rows) {
    const pKey = r.source === 'local' ? `note:${r.note_slug}` : `paper:${r.paper_slug}`;
    const sKey = `${pKey}::${r.section_path || r.section || ''}`;
    const pc = paperCount.get(pKey) || 0;
    const sc = sectionCount.get(sKey) || 0;
    if (pc >= perPaper || sc >= perSection) continue;
    paperCount.set(pKey, pc + 1);
    sectionCount.set(sKey, sc + 1);
    out.push(r);
  }
  return out;
}

// ── public API ──────────────────────────────────────────────────────────

// Search the index.
// opts: { k, kinds, source, discipline, family, includeVersions,
//         includeRefs, includeDeprecated, snippetChars, sourceWeight,
//         embedder }
// Returns { query, terms, count, results: [...], vector: bool }.
//
// Async only because of the optional embedding step; the lexical path is
// synchronous and is what runs when no embedder is configured.
async function search(db, rawQuery, opts = {}) {
  const k = Math.min(Math.max(parseInt(opts.k || DEFAULT_K, 10) || DEFAULT_K, 1), MAX_K);
  const norm = q.normalize(rawQuery);
  if (!norm.terms.length) {
    return { query: String(rawQuery || ''), terms: [], count: 0, results: [], vector: false };
  }

  const poolLimit = Math.max(k * 8, 40);
  const lists = [];

  // Word index: AND first, then OR, then prefix — each only if the previous
  // produced nothing, so precision degrades only when it must.
  let word = lexicalSearch(db, norm.terms, { ...opts, matchMode: 'and' }, poolLimit);
  if (!word.length) word = lexicalSearch(db, norm.terms, { ...opts, matchMode: 'or' }, poolLimit);
  if (!word.length) word = lexicalSearch(db, norm.terms, { ...opts, matchMode: 'prefix' }, poolLimit);
  if (word.length) lists.push(word);

  // CJK bigram index: only useful when the query has CJK.
  if (norm.cjk) {
    const cjk = cjkSearch(db, norm.terms, opts, poolLimit);
    if (cjk.length) lists.push(cjk);
  }

  // Optional vector KNN, fused with the lexical lists.
  let usedVector = false;
  if (opts.embedder && opts.embedder.available && opts.embedder.available()) {
    try {
      const vec = await opts.embedder.embedOne(String(rawQuery || ''));
      if (vec) {
        const embed = require('./embed');
        const hits = embed.knn(db, vec, poolLimit);
        if (hits.length) {
          const ids = hits.map((h) => h.chunk_id);
          const rows = fetchByIds(db, ids, opts);
          const byId = new Map(rows.map((r) => [r.id, r]));
          const ranked = hits.map((h) => byId.get(h.chunk_id)).filter(Boolean);
          if (ranked.length) { lists.push(ranked); usedVector = true; }
        }
      }
    } catch (e) {
      // A dead embedding endpoint must never break search.
      console.error(`[kb] vector search skipped: ${e.message}`);
    }
  }

  if (!lists.length) {
    return { query: String(rawQuery || ''), terms: norm.terms, count: 0, results: [], vector: false };
  }

  // Local knowledge gets a small boost so freshly written conclusions
  // surface, without outranking a directly-matching paper.
  const localWeight = Number(opts.sourceWeight ?? 1.15);
  for (const list of lists) {
    for (const row of list) row._weight = row.source === 'local' ? localWeight : 1;
  }

  let merged = lists.length === 1 ? lists[0] : rrf(lists);
  merged = diversify(merged, opts);
  const results = merged.slice(0, k).map((r) => shape(r, opts));
  return {
    query: String(rawQuery || ''), terms: norm.terms,
    count: results.length, results, vector: usedVector,
  };
}

// Fetch chunk rows by id, applying the same filters as a normal search.
function fetchByIds(db, ids, opts) {
  if (!ids.length) return [];
  const filter = buildFilter(opts);
  const placeholders = ids.map(() => '?').join(',');
  const sql = `
    SELECT c.id, c.source, c.kind, c.text, c.title, c.section, c.section_path,
           c.paper_id, c.note_id, c.family_id, c.anchor_label, c.anchor_name,
           c.source_path, c.line_start, c.line_end,
           p.slug AS paper_slug, p.date AS paper_date,
           n.slug AS note_slug, n.status AS note_status, n.confidence AS note_confidence
    ${BASE_JOIN}
    WHERE c.id IN (${placeholders})${filter.sql}`;
  try {
    return db.prepare(sql).all(...ids, ...filter.params);
  } catch {
    return [];
  }
}

// Render one row for the API / MCP response.
function shape(r, opts = {}) {
  const maxChars = Math.min(Math.max(parseInt(opts.snippetChars || 600, 10) || 600, 120), 4000);
  const text = String(r.text || '');
  return {
    chunkId: r.id,
    source: r.source,
    kind: r.kind,
    citation: r.source === 'local'
      ? `[LOCAL:${r.note_slug}${r.section ? ' §' + r.section : ''}]`
      : `[KB:${r.paper_slug}${r.section ? ' §' + r.section : ''}]`,
    paperSlug: r.paper_slug || null,
    noteSlug: r.note_slug || null,
    noteStatus: r.note_status || null,
    noteConfidence: r.note_confidence || null,
    familyId: r.family_id || null,
    title: r.title || null,
    section: r.section || null,
    sectionPath: r.section_path || null,
    anchorLabel: r.anchor_label || null,
    anchorName: r.anchor_name || null,
    sourcePath: r.source_path || null,
    lineStart: r.line_start ?? null,
    lineEnd: r.line_end ?? null,
    score: r.rrf != null ? Number(r.rrf.toFixed(6)) : Number((r.score ?? 0).toFixed(6)),
    snippet: text.length > maxChars ? text.slice(0, maxChars) + '…' : text,
  };
}

// Fetch one chunk (or a whole paper/note section) by id.
function getChunk(db, chunkId) {
  const row = db.prepare(`
    SELECT c.*, p.slug AS paper_slug, p.date AS paper_date, p.abstract AS paper_abstract,
           n.slug AS note_slug, n.status AS note_status
    ${BASE_JOIN}
    WHERE c.id = ?`).get(Number(chunkId));
  return row || null;
}

// Chunks adjacent to a given one within the same paper/note.
function neighbours(db, chunkId, before = 1, after = 1) {
  const base = getChunk(db, chunkId);
  if (!base) return [];
  const key = base.paper_id ? ['paper_id', base.paper_id] : ['note_id', base.note_id];
  if (!key[1]) return [];
  return db.prepare(`
    SELECT c.*, p.slug AS paper_slug, n.slug AS note_slug
    ${BASE_JOIN}
    WHERE c.${key[0]} = ? AND c.ord BETWEEN ? AND ?
    ORDER BY c.ord`).all(key[1], (base.ord || 0) - before, (base.ord || 0) + after);
}

// Papers related to a given paper: same family first, then same discipline.
function related(db, { paperSlug, familyId, limit = 8 }) {
  const out = [];
  if (familyId) {
    const rows = db.prepare(`
      SELECT slug AS paperSlug, title, date, family_id AS familyId
      FROM papers WHERE family_id = ? AND slug <> ?
      ORDER BY date DESC LIMIT ?`).all(String(familyId), paperSlug || '', limit);
    for (const r of rows) out.push({ ...r, relation: 'same-family' });
  }
  if (paperSlug && out.length < limit) {
    const fam = db.prepare('SELECT family_id FROM papers WHERE slug=?').get(paperSlug);
    if (fam && fam.family_id) {
      const rows = db.prepare(`
        SELECT p.slug AS paperSlug, p.title, p.date, p.family_id AS familyId
        FROM papers p JOIN families f ON f.id = p.family_id
        WHERE f.discipline_id = (SELECT discipline_id FROM families WHERE id = ?)
          AND p.family_id <> ? AND p.is_latest = 1
        ORDER BY p.date DESC LIMIT ?`).all(fam.family_id, fam.family_id, limit - out.length);
      for (const r of rows) out.push({ ...r, relation: 'same-discipline' });
    }
  }
  return out.slice(0, limit);
}

// Metadata for the KB (counts + taxonomy) — used by the UI/health endpoint.
function stats(db) {
  const one = (sql, ...p) => {
    try { return db.prepare(sql).get(...p).n; } catch { return 0; }
  };
  return {
    papers: one('SELECT COUNT(*) n FROM papers'),
    latestPapers: one('SELECT COUNT(*) n FROM papers WHERE is_latest=1'),
    families: one('SELECT COUNT(*) n FROM families'),
    disciplines: one('SELECT COUNT(*) n FROM disciplines'),
    chunks: one('SELECT COUNT(*) n FROM chunks'),
    corpusChunks: one("SELECT COUNT(*) n FROM chunks WHERE source='corpus'"),
    localChunks: one("SELECT COUNT(*) n FROM chunks WHERE source='local'"),
    notes: one('SELECT COUNT(*) n FROM notes'),
    draftNotes: one("SELECT COUNT(*) n FROM notes WHERE status='draft'"),
    kinds: (() => {
      try {
        return db.prepare('SELECT kind, COUNT(*) n FROM chunks GROUP BY kind ORDER BY n DESC').all();
      } catch { return []; }
    })(),
  };
}

module.exports = {
  search,
  shape,
  getChunk,
  neighbours,
  related,
  stats,
  rrf,
  diversify,
  buildFilter,
  lexicalSearch,
  cjkSearch,
  fetchByIds,
  DEFAULT_K,
  MAX_K,
};
