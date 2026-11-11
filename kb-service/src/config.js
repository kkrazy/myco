// Service configuration.
//
// Everything is env-driven so the service can run as a plain process, a
// container, or a systemd unit without a config file:
//
//   KB_ROOT            where knowledge bases live      (default ./kb-data)
//   KB_PORT            HTTP listen port                (default 7317)
//   KB_HOST            bind address                    (default 127.0.0.1)
//   KB_TOKEN           shared bearer token (optional; when set, every
//                      request must send Authorization: Bearer <token>)
//   KB_EMBED_URL       OpenAI-compatible /v1/embeddings base URL (optional)
//   KB_EMBED_MODEL     embedding model name            (default bge-m3)
//   KB_EMBED_API_KEY   bearer token for the embedding endpoint
//   KB_EMBED_DIM       expected vector dimension       (default 1024)
//   KB_RERANK_CANDIDATES  lexical pool size to rerank  (default 100)

'use strict';

const path = require('path');
const os = require('os');

function intEnv(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function load() {
  const root = process.env.KB_ROOT
    || path.join(process.cwd(), 'kb-data');
  return {
    root: path.resolve(root),
    host: process.env.KB_HOST || '127.0.0.1',
    port: intEnv('KB_PORT', 7317),
    token: process.env.KB_TOKEN || '',
    embed: {
      url: (process.env.KB_EMBED_URL || '').replace(/\/+$/, ''),
      model: process.env.KB_EMBED_MODEL || 'bge-m3',
      apiKey: process.env.KB_EMBED_API_KEY || '',
      dim: intEnv('KB_EMBED_DIM', 1024),
      timeoutMs: intEnv('KB_EMBED_TIMEOUT_MS', 20000),
    },
    rerankCandidates: intEnv('KB_RERANK_CANDIDATES', 100),
    maxSnippetChars: intEnv('KB_MAX_SNIPPET_CHARS', 1200),
    // Auto-write defaults. The service never writes unless asked; myco's
    // research mode is what turns this on per session.
    autoWrite: process.env.KB_AUTO_WRITE === '1',
    version: require('../package.json').version,
    nodeVersion: process.version,
    hostname: os.hostname(),
  };
}

module.exports = { load };
