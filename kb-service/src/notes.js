// Markdown-first local knowledge: the write-back half of the KB.
//
// Authoritative copy lives in <kbDir>/notes/<kind>/<slug>.md — plain files
// with YAML front matter, so they can be git-tracked, diffed, reviewed and
// reverted. SQLite is a derived index: deleting it and re-running
// `kb notes reindex` reproduces the searchable state from the Markdown.
//
// Layout:
//   notes/README.md          — format documentation (generated once)
//   notes/index.md           — human-readable catalogue (generated)
//   notes/<kind>/<slug>.md   — one knowledge item per file
//
// Front matter fields are documented in README_TEMPLATE below.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const KINDS = ['insight', 'method', 'counterexample', 'failure', 'lemma', 'reference'];
const STATUSES = ['draft', 'verified', 'deprecated'];
const SCOPES = ['project', 'user', 'global'];
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_TITLE_CHARS = 160;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const README_TEMPLATE = `# Local knowledge base

Each \`.md\` file here is one knowledge item. The Markdown is the source of
truth; the search index is derived from it and can be rebuilt at any time.

## Front matter

\`\`\`yaml
---
id: bsd-low-selmer-corank
title: "BSD holds for Selmer corank at most one"
kind: insight            # insight|method|counterexample|failure|lemma|reference
status: draft            # draft|verified|deprecated
scope: project           # project|user|global
tags: ["BSD", "Selmer"]
source:
  session: sess_ab12
  paper: Exact-Birch-Swinnerton-Dyer-Formula-...
  chunks: [10231, 10244]
confidence: medium       # low|medium|high
created_at: 2026-11-11T10:20:31Z
updated_at: 2026-11-11T10:20:31Z
---
\`\`\`

## Body

Use \`## 结论\` / \`## 依据\` / \`## 适用边界\` / \`## 更新记录\` sections.
Only \`draft\` and \`verified\` items are searchable by default.
`;

// ── front matter ────────────────────────────────────────────────────────

// Minimal YAML subset: scalars, quoted strings, inline arrays, one nested
// mapping level (`source:`). Enough for our own files and hand edits.
function parseFrontMatter(text) {
  const src = String(text || '');
  if (!src.startsWith('---')) return { meta: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: src };
  const head = src.slice(3, end).replace(/^\r?\n/, '');
  const body = src.slice(end + 4).replace(/^\r?\n/, '');
  const meta = {};
  let nestedKey = null;

  for (const rawLine of head.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const nested = line.match(/^ {2}([A-Za-z_][\w-]*):\s*(.*)$/);
    if (nested && nestedKey) {
      meta[nestedKey] = meta[nestedKey] || {};
      if (typeof meta[nestedKey] === 'object') {
        meta[nestedKey][nested[1]] = parseScalar(nested[2]);
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value.trim() === '') {
      nestedKey = key;
      continue;
    }
    nestedKey = null;
    meta[key] = parseScalar(value);
  }
  return { meta, body };
}

function parseScalar(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => unquote(s.trim())).filter((s) => s !== '');
  }
  return unquote(v);
}

function unquote(s) {
  const t = String(s || '');
  if (t.startsWith('"') && t.endsWith('"')) {
    // Values written by yamlScalar use JSON.stringify, so unescape them
    // the same way (\" → ", \\ → \). Hand-written plain quotes still work.
    try { return JSON.parse(t); } catch { return t.slice(1, -1); }
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  return t;
}

function yamlScalar(v) {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(String(x))).join(', ')}]`;
  const s = String(v == null ? '' : v);
  if (/^[A-Za-z0-9._/:-]+$/.test(s) && !/^(true|false|null|yes|no|\d+)$/i.test(s)) return s;
  return JSON.stringify(s);
}

function serializeFrontMatter(meta) {
  const lines = ['---'];
  const order = [
    'id', 'title', 'kind', 'status', 'scope', 'tags', 'source',
    'confidence', 'created_at', 'updated_at', 'supersedes',
  ];
  const keys = [...order.filter((k) => meta[k] != null),
    ...Object.keys(meta).filter((k) => !order.includes(k) && meta[k] != null)];
  for (const k of keys) {
    const v = meta[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const [sk, sv] of Object.entries(v)) {
        if (sv == null || sv === '') continue;
        lines.push(`  ${sk}: ${yamlScalar(sv)}`);
      }
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ── slug / sanitize ─────────────────────────────────────────────────────

function slugify(title) {
  const base = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  // CJK-only titles produce no ascii slug; fall back to a hash so the file
  // name stays portable across filesystems.
  if (!base) return 'note-' + crypto.createHash('sha1')
    .update(String(title || '')).digest('hex').slice(0, 10);
  return base;
}

// Strip anything that could be executed or rendered as active content.
// Notes are re-read into future prompts, so this is a write-side guard.
function sanitizeBody(body) {
  let t = String(body || '');
  t = t.replace(/\u0000/g, '');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '');
  t = t.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  t = t.replace(/javascript:/gi, '');
  t = t.replace(/on(?:error|load|click)\s*=/gi, '');
  // Shell blocks are downgraded to plain text so a future agent cannot
  // copy-paste them straight into Bash.
  t = t.replace(/```(?:bash|sh|shell|zsh)\b/gi, '```text');
  if (Buffer.byteLength(t, 'utf8') > MAX_CONTENT_BYTES) {
    t = t.slice(0, MAX_CONTENT_BYTES);
  }
  return t.trim();
}

// ── filesystem ──────────────────────────────────────────────────────────

function notesRoot(kbDir) {
  return path.join(kbDir, 'notes');
}

function notePath(kbDir, kind, slug) {
  return path.join(notesRoot(kbDir), kind, `${slug}.md`);
}

function ensureLayout(kbDir) {
  const root = notesRoot(kbDir);
  fs.mkdirSync(root, { recursive: true });
  for (const k of KINDS) fs.mkdirSync(path.join(root, k), { recursive: true });
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README_TEMPLATE, 'utf8');
  return root;
}

function listNoteFiles(kbDir) {
  const root = notesRoot(kbDir);
  const out = [];
  for (const kind of KINDS) {
    const dir = path.join(root, kind);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      out.push({ kind, file: path.join(dir, name), slug: name.slice(0, -3) });
    }
  }
  return out;
}

function readNoteFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseFrontMatter(raw);
  return { meta, body, raw };
}

// Atomic write: temp file in the same dir, fsync, rename.
function writeNoteFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// ── CRUD + indexing ─────────────────────────────────────────────────────

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Split note body into chunks on `##` headings.
function chunkNoteBody(body, max = 1200) {
  const src = String(body || '').trim();
  if (!src) return [];
  const parts = [];
  let section = '';
  let buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    // Notes are short by nature — a 20-char floor would silently drop
    // sections like "## 依据\n\n[KB:...]" and collapse the whole note into
    // one unsectioned chunk. Keep anything with real content.
    if (text.length >= 5) {
      for (const piece of splitLong(text, max)) parts.push({ section, text: piece });
    }
    buf = [];
  };
  let skipSection = false;
  for (const line of src.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      section = m[1].trim();
      // The update log is provenance, not knowledge — indexing it makes
      // every note match its own history on each revision.
      skipSection = /更新记录|change ?log|history/i.test(section);
      continue;
    }
    if (/^#\s+/.test(line)) continue;   // H1 duplicates the title
    if (skipSection) continue;
    buf.push(line);
  }
  flush();
  if (!parts.length) parts.push({ section: '', text: src.slice(0, max) });
  return parts;
}

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  for (const p of text.split(/(?<=[.;:!?])\s+|\n\n/)) {
    if (!p) continue;
    if (cur && cur.length + p.length > max) { out.push(cur.trim()); cur = p; }
    else cur += (cur ? ' ' : '') + p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Upsert one note into the index (delete old chunks, insert new).
function upsertIndex(database, kbDir, note) {
  const { meta, body, file } = note;
  const relPath = path.relative(kbDir, file).split(path.sep).join('/');
  const contentSha = sha256(body);
  const now = new Date().toISOString();

  return db.tx(database, () => {
    const existing = database.prepare('SELECT id, created_at FROM notes WHERE slug=?').get(meta.id);
    let noteId;
    if (existing) {
      noteId = existing.id;
      database.prepare(`
        UPDATE notes SET kind=?, status=?, scope=?, title=?, tags=?, source_session=?,
          source_paper=?, source_chunks=?, path=?, content_sha=?, confidence=?,
          updated_at=?, supersedes=?
        WHERE id=?`).run(
        meta.kind, meta.status, meta.scope, meta.title,
        JSON.stringify(meta.tags || []),
        (meta.source && meta.source.session) || null,
        (meta.source && meta.source.paper) || null,
        JSON.stringify((meta.source && meta.source.chunks) || []),
        relPath, contentSha, meta.confidence || null,
        meta.updated_at || now, meta.supersedes || null, noteId,
      );
      db.deleteChunksForNote(database, noteId);
    } else {
      const info = database.prepare(`
        INSERT INTO notes(slug,kind,status,scope,title,tags,source_session,source_paper,
          source_chunks,path,content_sha,confidence,created_at,updated_at,supersedes)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        meta.id, meta.kind, meta.status, meta.scope, meta.title,
        JSON.stringify(meta.tags || []),
        (meta.source && meta.source.session) || null,
        (meta.source && meta.source.paper) || null,
        JSON.stringify((meta.source && meta.source.chunks) || []),
        relPath, contentSha, meta.confidence || null,
        meta.created_at || now, meta.updated_at || now, meta.supersedes || null,
      );
      noteId = Number(info.lastInsertRowid);
    }
    let ord = 0;
    for (const c of chunkNoteBody(body)) {
      db.insertChunk(database, {
        source: 'local',
        note_id: noteId,
        kind: meta.kind,
        title: meta.title,
        section: c.section,
        section_path: c.section,
        ord: ord++,
        text: c.text,
        sha: sha256(c.text).slice(0, 16),
        source_path: relPath,
      });
    }
    return { noteId, chunks: ord };
  });
}

// Create or merge a note. Returns { slug, path, created, merged }.
//
// Merge semantics: same slug (or same kind + slugified title) reuses the
// file, keeps created_at, appends to `## 更新记录`, and refreshes the body
// only when `replace` is set. This keeps one conclusion from being recorded
// as N near-identical files.
function remember(kbDir, database, input) {
  ensureLayout(kbDir);
  const kind = KINDS.includes(input.kind) ? input.kind : 'insight';
  const title = String(input.title || '').trim().slice(0, MAX_TITLE_CHARS);
  if (!title) {
    const e = new Error('title required');
    e.code = 'ERR_BAD_INPUT';
    throw e;
  }
  const body = sanitizeBody(input.content || input.body || '');
  if (!body) {
    const e = new Error('content required');
    e.code = 'ERR_BAD_INPUT';
    throw e;
  }
  const slug = input.slug && SLUG_RE.test(input.slug) ? input.slug : slugify(title);
  const file = notePath(kbDir, kind, slug);
  const now = new Date().toISOString();

  let meta;
  let finalBody = body;
  let created = true;
  let merged = false;

  if (fs.existsSync(file)) {
    const prev = readNoteFile(file);
    created = false;
    merged = true;
    meta = {
      ...prev.meta,
      title: input.title ? title : prev.meta.title,
      kind,
      status: prev.meta.status || 'draft',
      scope: input.scope && SCOPES.includes(input.scope) ? input.scope : (prev.meta.scope || 'project'),
      tags: mergeTags(prev.meta.tags, input.tags),
      confidence: input.confidence || prev.meta.confidence || 'medium',
      updated_at: now,
    };
    finalBody = input.replace
      ? body
      : appendUpdate(prev.body, body, now, input.source && input.source.session);
  } else {
    meta = {
      id: slug,
      title,
      kind,
      status: 'draft',
      scope: input.scope && SCOPES.includes(input.scope) ? input.scope : 'project',
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 8).map(String) : [],
      source: {
        session: (input.source && input.source.session) || null,
        paper: (input.source && input.source.paper) || null,
        chunks: Array.isArray(input.source && input.source.chunks)
          ? input.source.chunks.slice(0, 20) : [],
      },
      confidence: input.confidence || 'medium',
      created_at: now,
      updated_at: now,
    };
  }
  meta.id = slug;

  const content = serializeFrontMatter(cleanMeta(meta)) + '\n\n' + finalBody.trim() + '\n';
  writeNoteFile(file, content);
  upsertIndex(database, kbDir, { meta: cleanMeta(meta), body: finalBody.trim(), file });
  return { slug, path: file, created, merged, kind, status: meta.status };
}

function cleanMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = {};
      for (const [sk, sv] of Object.entries(v)) {
        if (sv == null || sv === '' || (Array.isArray(sv) && !sv.length)) continue;
        nested[sk] = sv;
      }
      if (Object.keys(nested).length) out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function mergeTags(a, b) {
  const out = new Set();
  for (const t of [].concat(a || [], b || [])) {
    const s = String(t || '').trim();
    if (s) out.add(s);
  }
  return [...out].slice(0, 8);
}

// Append a dated entry to the `## 更新记录` section (creating it if absent).
function appendUpdate(prevBody, newBody, now, session) {
  const entry = `- ${now}${session ? ` 由会话 ${session}` : ''} 更新：\n\n${indent(newBody)}`;
  const idx = prevBody.indexOf('## 更新记录');
  if (idx < 0) {
    return `${prevBody.trim()}\n\n## 更新记录\n\n${entry}\n`;
  }
  const head = prevBody.slice(0, idx + '## 更新记录'.length);
  const tail = prevBody.slice(idx + '## 更新记录'.length);
  return `${head}\n\n${tail.trim()}\n${entry}\n`;
}

function indent(text) {
  return String(text || '').split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
}

// Read one note from disk by slug (searches every kind dir).
function readNote(kbDir, slug) {
  for (const kind of KINDS) {
    const file = notePath(kbDir, kind, slug);
    if (fs.existsSync(file)) {
      const { meta, body } = readNoteFile(file);
      return { meta: { ...meta, id: meta.id || slug }, body, file };
    }
  }
  return null;
}

// Update status (draft → verified → deprecated).
function setStatus(kbDir, database, slug, status) {
  if (!STATUSES.includes(status)) {
    const e = new Error(`invalid status ${status}`);
    e.code = 'ERR_BAD_INPUT';
    throw e;
  }
  const note = readNote(kbDir, slug);
  if (!note) {
    const e = new Error(`note not found: ${slug}`);
    e.code = 'ERR_NOT_FOUND';
    throw e;
  }
  const meta = { ...note.meta, status, updated_at: new Date().toISOString() };
  const content = serializeFrontMatter(cleanMeta(meta)) + '\n\n' + note.body.trim() + '\n';
  writeNoteFile(note.file, content);
  upsertIndex(database, kbDir, { meta: cleanMeta(meta), body: note.body.trim(), file: note.file });
  return { slug, status };
}

// Delete a note: file + index rows.
function removeNote(kbDir, database, slug) {
  const note = readNote(kbDir, slug);
  if (!note) {
    const e = new Error(`note not found: ${slug}`);
    e.code = 'ERR_NOT_FOUND';
    throw e;
  }
  fs.unlinkSync(note.file);
  db.tx(database, () => {
    const row = database.prepare('SELECT id FROM notes WHERE slug=?').get(slug);
    if (row) {
      db.deleteChunksForNote(database, row.id);
      database.prepare('DELETE FROM notes WHERE id=?').run(row.id);
    }
  });
  return { slug, removed: true };
}

// List notes from the index (optionally filtered).
function listNotes(database, { kind, status, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind=?'); params.push(kind); }
  if (status) { where.push('status=?'); params.push(status); }
  const sql = `SELECT slug,kind,status,scope,title,tags,confidence,created_at,updated_at,hits,useful
    FROM notes ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY updated_at DESC LIMIT ?`;
  return database.prepare(sql).all(...params, Math.min(Number(limit) || 100, 500));
}

// Rebuild the whole local index from the Markdown files. Used after a
// corpus rebuild (which replaces the DB) and by `kb notes reindex`.
function reindexAll(kbDir, database) {
  ensureLayout(kbDir);
  const files = listNoteFiles(kbDir);
  let indexed = 0;
  for (const f of files) {
    try {
      const { meta, body } = readNoteFile(f.file);
      if (!meta.id) meta.id = f.slug;
      if (!meta.kind) meta.kind = f.kind;
      if (!KINDS.includes(meta.kind)) meta.kind = f.kind;
      if (!STATUSES.includes(meta.status)) meta.status = 'draft';
      upsertIndex(database, kbDir, { meta, body, file: f.file });
      indexed++;
    } catch (e) {
      console.error(`[kb notes] failed to index ${f.file}: ${e.message}`);
    }
  }
  return { indexed, total: files.length };
}

// Regenerate notes/index.md — a human-readable catalogue.
function rebuildIndexFile(kbDir, database) {
  ensureLayout(kbDir);
  const rows = database.prepare(
    'SELECT slug,kind,status,title,updated_at FROM notes ORDER BY kind, slug',
  ).all();
  const byKind = new Map();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  const lines = ['# Knowledge index', '', `_Generated ${new Date().toISOString()} — do not edit._`, ''];
  if (!rows.length) lines.push('_No notes yet._');
  for (const [kind, items] of byKind) {
    lines.push(`## ${kind}`, '');
    for (const it of items) {
      lines.push(`- [${it.title}](./${kind}/${it.slug}.md) — \`${it.status}\` · ${it.updated_at}`);
    }
    lines.push('');
  }
  const file = path.join(notesRoot(kbDir), 'index.md');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { file, count: rows.length };
}

// Bump hit counters (batched by the service; failures are non-fatal).
function bumpHits(database, slugs) {
  if (!Array.isArray(slugs) || !slugs.length) return;
  const stmt = database.prepare('UPDATE notes SET hits = hits + 1 WHERE slug = ?');
  db.tx(database, () => { for (const s of slugs) stmt.run(s); });
}

module.exports = {
  KINDS,
  STATUSES,
  SCOPES,
  README_TEMPLATE,
  parseFrontMatter,
  serializeFrontMatter,
  slugify,
  sanitizeBody,
  chunkNoteBody,
  notesRoot,
  notePath,
  ensureLayout,
  listNoteFiles,
  readNoteFile,
  writeNoteFile,
  upsertIndex,
  remember,
  readNote,
  setStatus,
  removeNote,
  listNotes,
  reindexAll,
  rebuildIndexFile,
  bumpHits,
};
