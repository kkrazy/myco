// SQLite schema + connection helpers for the KB service.
//
// Uses Node's built-in `node:sqlite` (Node >= 22.5). No native deps, no
// external database process — the index is one file per knowledge base.
//
// Two FTS5 tables are maintained over the same `chunks` rows:
//   chunks_fts      unicode61 — word-based BM25, best for English/math terms
//   chunks_fts_cjk  bigram    — CJK bigram index. unicode61 treats a whole
//                               CJK run as ONE token, so a 2-character
//                               query never matches; storing bigrams fixes it.
// Queries hit one or both and merge with RRF (see retriever.js).

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS kb_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS disciplines (
  id      INTEGER PRIMARY KEY,
  name    TEXT UNIQUE NOT NULL,
  ordinal INTEGER
);

CREATE TABLE IF NOT EXISTS families (
  id            TEXT PRIMARY KEY,          -- '001' .. '373'
  title         TEXT,
  summary       TEXT,
  discipline_id INTEGER,
  lean_doc      TEXT
);

CREATE TABLE IF NOT EXISTS papers (
  id          INTEGER PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,        -- directory name (includes date)
  version_key TEXT,                        -- slug minus the trailing date
  family_id   TEXT,
  title       TEXT,
  date        TEXT,
  abstract    TEXT,
  tex_root    TEXT,
  pdf_path    TEXT,
  content_sha TEXT,
  is_latest   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft',
  scope         TEXT NOT NULL DEFAULT 'project',
  title         TEXT,
  tags          TEXT,                      -- JSON array
  source_session TEXT,
  source_paper  TEXT,
  source_chunks TEXT,                      -- JSON array of chunk ids
  path          TEXT NOT NULL,             -- relative to <kb>/notes/
  content_sha   TEXT,
  confidence    TEXT,
  supersedes    TEXT,
  created_at    TEXT,
  updated_at    TEXT,
  hits          INTEGER NOT NULL DEFAULT 0,
  useful        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY,
  source       TEXT NOT NULL DEFAULT 'corpus',   -- 'corpus' | 'local'
  paper_id     INTEGER,
  family_id    TEXT,
  note_id      INTEGER,
  kind         TEXT,
  title        TEXT,                        -- denormalized for FTS
  section      TEXT,
  section_path TEXT,
  ord          INTEGER,
  text         TEXT NOT NULL,
  sha          TEXT,
  anchor_label TEXT,
  anchor_name  TEXT,
  source_path  TEXT,
  line_start   INTEGER,
  line_end     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_paper  ON chunks(paper_id);
CREATE INDEX IF NOT EXISTS idx_chunks_family ON chunks(family_id);
CREATE INDEX IF NOT EXISTS idx_chunks_note   ON chunks(note_id);
CREATE INDEX IF NOT EXISTS idx_chunks_kind   ON chunks(kind);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
CREATE INDEX IF NOT EXISTS idx_notes_status  ON notes(status);
CREATE INDEX IF NOT EXISTS idx_notes_kind    ON notes(kind);
CREATE INDEX IF NOT EXISTS idx_papers_vkey   ON papers(version_key);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, title, section,
  content='chunks', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- CJK index. unicode61 tokenizes a whole CJK run as ONE token, so a
-- 2-character query never matches. The fix is the standard bigram trick:
-- store a bigram-expanded copy of the text and query with bigrams. This
-- table is NOT external-content (the text is transformed), and it only
-- holds chunks that actually contain CJK — the corpus has none, so in
-- practice it indexes local notes only and stays tiny.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_cjk USING fts5(
  text, title, section,
  tokenize='unicode61 remove_diacritics 2'
);
`;

// Open (creating if needed) the index for a knowledge base directory.
function openDb(kbDir, { readOnly = false } = {}) {
  const file = path.join(kbDir, 'index.sqlite');
  if (readOnly && !fs.existsSync(file)) {
    const e = new Error(`knowledge base index not found: ${file}`);
    e.code = 'ERR_NO_INDEX';
    throw e;
  }
  if (!readOnly) fs.mkdirSync(kbDir, { recursive: true });
  const db = new DatabaseSync(file, { readOnly });
  if (!readOnly) {
    db.exec(SCHEMA);
    migrate(db);
    db.prepare('INSERT OR REPLACE INTO kb_meta(key,value) VALUES(?,?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }
  return db;
}

// Additive column migrations for indexes built by an older schema.
// `CREATE TABLE IF NOT EXISTS` does not add columns to an existing table.
function migrate(db) {
  const cols = new Set(
    db.prepare('PRAGMA table_info(notes)').all().map((r) => r.name),
  );
  if (!cols.has('supersedes')) {
    try { db.exec('ALTER TABLE notes ADD COLUMN supersedes TEXT'); } catch { /* raced */ }
  }
}

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM kb_meta WHERE key=?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO kb_meta(key,value) VALUES(?,?)')
    .run(String(key), String(value));
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

// Expand every CJK run into space-separated bigrams:
//   "椭圆曲线" → "椭圆 圆曲 曲线"
// Latin text is passed through unchanged. This is what makes 2-character
// Chinese queries match against the word index.
function bigramExpand(text) {
  return String(text || '').replace(CJK_RUN_RE, (run) => {
    const chars = [...run];
    if (chars.length === 1) return chars[0];
    const out = [];
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
    return ' ' + out.join(' ') + ' ';
  });
}

// Rebuild the FTS tables from `chunks`.
//
// The CJK table is only populated for chunks that actually contain CJK:
// bigram-expanding 133k English chunks would triple the index for no gain
// (the corpus has no CJK; local notes do).
function rebuildFts(db) {
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
  db.exec('DELETE FROM chunks_fts_cjk');
  const rows = db.prepare('SELECT id, text, title, section FROM chunks').all();
  const ins = db.prepare('INSERT INTO chunks_fts_cjk(rowid,text,title,section) VALUES(?,?,?,?)');
  for (const r of rows) {
    if (CJK_RE.test(r.text) || CJK_RE.test(r.title || '')) {
      ins.run(r.id, bigramExpand(r.text), bigramExpand(r.title || ''), bigramExpand(r.section || ''));
    }
  }
}

// Insert one chunk and keep both FTS tables in sync.
function insertChunk(db, c) {
  const stmt = db.prepare(`
    INSERT INTO chunks
      (source, paper_id, family_id, note_id, kind, title, section, section_path,
       ord, text, sha, anchor_label, anchor_name, source_path, line_start, line_end)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const info = stmt.run(
    c.source || 'corpus', c.paper_id ?? null, c.family_id ?? null, c.note_id ?? null,
    c.kind ?? null, c.title ?? null, c.section ?? null, c.section_path ?? null,
    c.ord ?? 0, c.text, c.sha ?? null, c.anchor_label ?? null, c.anchor_name ?? null,
    c.source_path ?? null, c.line_start ?? null, c.line_end ?? null,
  );
  const id = Number(info.lastInsertRowid);
  const fts = db.prepare('INSERT INTO chunks_fts(rowid,text,title,section) VALUES(?,?,?,?)');
  fts.run(id, c.text, c.title ?? '', c.section ?? '');
  // CJK rows are bigram-expanded and only stored when CJK is present.
  if (CJK_RE.test(c.text) || CJK_RE.test(c.title || '')) {
    db.prepare('INSERT INTO chunks_fts_cjk(rowid,text,title,section) VALUES(?,?,?,?)')
      .run(id, bigramExpand(c.text), bigramExpand(c.title ?? ''), bigramExpand(c.section ?? ''));
  }
  return id;
}

// Delete every chunk belonging to one note, keeping FTS in sync.
function deleteChunksForNote(db, noteId) {
  const rows = db.prepare('SELECT id FROM chunks WHERE note_id=?').all(noteId);
  for (const r of rows) {
    db.prepare('DELETE FROM chunks_fts WHERE rowid=?').run(r.id);
    db.prepare('DELETE FROM chunks_fts_cjk WHERE rowid=?').run(r.id);
    db.prepare('DELETE FROM chunks WHERE id=?').run(r.id);
  }
  return rows.length;
}

// Open a raw connection at an explicit file path and apply the schema.
// Used by the builder to work against a temp file before the atomic swap.
function openRaw(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA,
  openDb,
  openRaw,
  getMeta,
  setMeta,
  tx,
  rebuildFts,
  insertChunk,
  deleteChunksForNote,
  bigramExpand,
  CJK_RE,
};
