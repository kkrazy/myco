// Optional embedding provider.
//
// Talks to any OpenAI-compatible /v1/embeddings endpoint (HF Text
// Embeddings Inference, vLLM, Ollama, a gateway). Entirely optional: when
// KB_EMBED_URL is unset, `available()` is false and the retriever silently
// runs lexical-only. Nothing else in the service depends on this module.
//
// Vectors are stored in a plain `chunk_vectors` table rather than a
// sqlite-vec virtual table. Rationale: the extension is not present in the
// Node runtime, and brute-force cosine over a few thousand local notes is
// well under a millisecond. If the corpus itself is ever vectorised
// (133k chunks), swap this table for sqlite-vec behind the same API.

'use strict';

const db = require('./db');

function makeProvider(cfg) {
  const { url, model, apiKey, dim, timeoutMs } = cfg.embed;
  const enabled = !!url;

  async function embedBatch(texts) {
    if (!enabled) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${url}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`embedding endpoint ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = await res.json();
      const data = Array.isArray(json.data) ? json.data : [];
      return data
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  }

  async function embedOne(text) {
    const out = await embedBatch([text]);
    return out && out[0] ? out[0] : null;
  }

  return {
    enabled,
    model,
    dim,
    embedBatch,
    embedOne,
    available: () => enabled,
  };
}

// ── storage ─────────────────────────────────────────────────────────────

const VECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS chunk_vectors (
  chunk_id INTEGER PRIMARY KEY,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL,
  model    TEXT
);
`;

function ensureVectorTable(database) {
  database.exec(VECTOR_SCHEMA);
}

function packVector(arr) {
  const f = Float32Array.from(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function unpackVector(buf) {
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f);
}

function storeVector(database, chunkId, vec, model) {
  ensureVectorTable(database);
  database.prepare('INSERT OR REPLACE INTO chunk_vectors(chunk_id,dim,vec,model) VALUES(?,?,?,?)')
    .run(chunkId, vec.length, packVector(vec), model || null);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

// Brute-force KNN over stored vectors. Returns [{chunk_id, score}].
// Only used when the provider is configured AND vectors exist.
function knn(database, queryVec, limit = 50) {
  let rows;
  try {
    rows = database.prepare('SELECT chunk_id, vec FROM chunk_vectors').all();
  } catch {
    return [];
  }
  const scored = [];
  for (const r of rows) {
    const v = unpackVector(r.vec);
    if (v.length !== queryVec.length) continue;
    scored.push({ chunk_id: r.chunk_id, score: cosine(queryVec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

module.exports = {
  makeProvider,
  ensureVectorTable,
  storeVector,
  knn,
  cosine,
  packVector,
  unpackVector,
};
