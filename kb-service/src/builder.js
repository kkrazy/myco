// Corpus index builder.
//
// Walks <corpus>/preprints/, parses each paper's TeX, enriches it with
// family/discipline/Lean metadata, and writes chunks into the KB's SQLite
// index. Incremental: a paper whose content_sha is unchanged is skipped.
//
// The build is staged into a temp DB and atomically renamed into place, so
// a running service never sees a half-built index. Local notes
// (source='local') are carried over from the existing index — they are
// authoritative in Markdown under <kb>/notes/ and are re-ingested from
// there, not from the corpus build.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DatabaseSync } = require('node:sqlite');
const db = require('./db');
const tex = require('./corpus/tex');
const metadata = require('./corpus/metadata');

const PREPRINTS_DIR = 'preprints';

function listPaperDirs(corpusRoot) {
  const root = path.join(corpusRoot, PREPRINTS_DIR);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

// One paper → { slug, version_key, is_latest, ...paperRow, chunks }.
function buildPaper(corpusRoot, slug, meta) {
  const dir = path.join(corpusRoot, PREPRINTS_DIR, slug);
  const parsed = tex.parsePaper(dir);
  if (!parsed) return null;

  const pm = meta.paperMetaBySlug.get(slug) || {};
  const familyId = pm.family_id || null;
  const family = familyId ? meta.familyById.get(familyId) : null;
  const discipline = family ? family.discipline : null;

  const title = pm.title || family?.title || slug.replace(/-/g, ' ');
  const date = metadata.dateFromSlug(slug);

  // Attach family + discipline context to every chunk's section path so a
  // search hit carries the taxonomy without a second query.
  const contextPrefix = [discipline, family ? `${family.id} ${family.title}` : null]
    .filter(Boolean).join(' · ');

  const chunks = parsed.chunks.map((c) => ({
    ...c,
    source: 'corpus',
    family_id: familyId,
    title,
    section_path: [contextPrefix, c.section_path].filter(Boolean).join(' · '),
    source_path: path.relative(corpusRoot, parsed.entry),
    sha: crypto.createHash('sha256').update(c.text).digest('hex').slice(0, 16),
  }));

  return {
    slug,
    version_key: metadata.versionKey(slug),
    title,
    date,
    family_id: familyId,
    abstract: parsed.abstract || pm.abstract || '',
    tex_root: path.relative(corpusRoot, parsed.entry),
    pdf_path: null,
    content_sha: parsed.sha,
    chunks,
  };
}

// Mark every paper but the newest of each version_key as is_latest=0.
function computeLatest(papers) {
  const best = new Map();
  for (const p of papers) {
    const cur = best.get(p.version_key);
    if (!cur || p.date > cur.date) best.set(p.version_key, p);
  }
  for (const p of papers) {
    p.is_latest = best.get(p.version_key) === p ? 1 : 0;
  }
  return papers;
}

// Full or incremental build into <kbDir>/index.sqlite.
// opts: { corpusRoot, kbDir, incremental, onProgress }
function build(opts) {
  const { corpusRoot, kbDir } = opts;
  const incremental = !!opts.incremental;
  const onProgress = opts.onProgress || (() => {});

  fs.mkdirSync(kbDir, { recursive: true });
  const targetFile = path.join(kbDir, 'index.sqlite');
  const tmpFile = targetFile + '.tmp';
  for (const f of [tmpFile, tmpFile + '-wal', tmpFile + '-shm']) {
    try { fs.unlinkSync(f); } catch { /* absent */ }
  }

  const meta = metadata.loadCorpusMetadata(corpusRoot);

  // Existing index (for incremental skip + carrying local notes over).
  let oldDb = null;
  if (fs.existsSync(targetFile)) {
    try { oldDb = new DatabaseSync(targetFile, { readOnly: true }); } catch { oldDb = null; }
  }
  const oldSha = new Map();
  if (oldDb) {
    try {
      for (const r of oldDb.prepare('SELECT slug, content_sha FROM papers').all()) {
        oldSha.set(r.slug, r.content_sha);
      }
    } catch { /* fresh/foreign db */ }
  }

  const work = db.openRaw(tmpFile);

  const stats = { papers: 0, skipped: 0, chunks: 0, failed: [] };
  const allPapers = [];

  db.tx(work, () => {
    for (const d of meta.disciplines) {
      work.prepare('INSERT OR IGNORE INTO disciplines(name,ordinal) VALUES(?,?)')
        .run(d.name, d.ordinal);
    }
    const discIdByName = new Map(
      work.prepare('SELECT id,name FROM disciplines').all().map((r) => [r.name, r.id]),
    );
    for (const f of meta.families) {
      work.prepare('INSERT OR REPLACE INTO families(id,title,summary,discipline_id,lean_doc) VALUES(?,?,?,?,?)')
        .run(f.id, f.title || '', f.summary || '',
          f.discipline ? (discIdByName.get(f.discipline) ?? null) : null,
          f.lean_doc || null);
    }
  });

  const slugs = listPaperDirs(corpusRoot);
  let done = 0;

  for (const slug of slugs) {
    done++;
    let paper = null;
    try {
      paper = buildPaper(corpusRoot, slug, meta);
    } catch (e) {
      stats.failed.push({ slug, error: e.message });
      continue;
    }
    if (!paper) { stats.failed.push({ slug, error: 'no TeX entry point' }); continue; }
    allPapers.push(paper);

    if (incremental && oldSha.get(slug) === paper.content_sha) {
      stats.skipped++;
      // Carry the paper row + chunks over verbatim from the old index.
      copyPaperFromOld(oldDb, work, slug);
      continue;
    }

    db.tx(work, () => {
      work.prepare('DELETE FROM chunks WHERE paper_id=(SELECT id FROM papers WHERE slug=?)').run(slug);
      work.prepare('DELETE FROM papers WHERE slug=?').run(slug);
      const info = work.prepare(`
        INSERT INTO papers(slug,version_key,family_id,title,date,abstract,tex_root,pdf_path,content_sha,is_latest)
        VALUES(?,?,?,?,?,?,?,?,?,1)`).run(
        paper.slug, paper.version_key, paper.family_id, paper.title, paper.date,
        paper.abstract, paper.tex_root, paper.pdf_path, paper.content_sha,
      );
      const paperId = Number(info.lastInsertRowid);
      for (const c of paper.chunks) {
        db.insertChunk(work, { ...c, paper_id: paperId });
        stats.chunks++;
      }
    });
    stats.papers++;
    if (done % 50 === 0) onProgress({ done, total: slugs.length, stats });
  }

  // is_latest across versions (only meaningful for the full set).
  db.tx(work, () => {
    const rows = work.prepare('SELECT id, version_key, date FROM papers').all();
    const best = new Map();
    for (const r of rows) {
      // Compare sortable dates (YYYY-MM-DD), not raw month names —
      // "September" > "October" lexicographically and picks the wrong one.
      const key = metadata.sortableDate(r.date);
      const cur = best.get(r.version_key);
      if (!cur || key > cur.key) best.set(r.version_key, { id: r.id, key });
    }
    const upd = work.prepare('UPDATE papers SET is_latest=? WHERE id=?');
    for (const r of rows) upd.run(best.get(r.version_key).id === r.id ? 1 : 0, r.id);
  });

  // Rebuild FTS from the final chunk set (cheaper than per-row maintenance
  // for a bulk build, and guarantees no drift).
  db.rebuildFts(work);

  db.tx(work, () => {
    db.setMeta(work, 'built_at', new Date().toISOString());
    db.setMeta(work, 'corpus_root', path.resolve(corpusRoot));
    db.setMeta(work, 'paper_count', String(stats.papers + stats.skipped));
    db.setMeta(work, 'chunk_count', String(
      work.prepare('SELECT COUNT(*) n FROM chunks').get().n,
    ));
    db.setMeta(work, 'family_count', String(meta.families.length));
    db.setMeta(work, 'discipline_count', String(meta.disciplines.length));
    db.setMeta(work, 'lean_declarations', String(meta.leanDeclarations.length));
  });

  work.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  work.close();
  if (oldDb) { try { oldDb.close(); } catch { /* ignore */ } }

  // Atomic swap.
  try { fs.renameSync(targetFile + '.prev', targetFile + '.prev.old'); } catch { /* none */ }
  try { fs.unlinkSync(targetFile + '.prev.old'); } catch { /* none */ }
  if (fs.existsSync(targetFile)) fs.renameSync(targetFile, targetFile + '.prev');
  for (const f of [targetFile + '-wal', targetFile + '-shm']) {
    try { fs.unlinkSync(f); } catch { /* none */ }
  }
  fs.renameSync(tmpFile, targetFile);

  return { ...stats, total: slugs.length };
}

// Copy a paper row + its chunks from the old index into the new one.
function copyPaperFromOld(oldDb, work, slug) {
  if (!oldDb) return;
  let p;
  try { p = oldDb.prepare('SELECT * FROM papers WHERE slug=?').get(slug); } catch { return; }
  if (!p) return;
  db.tx(work, () => {
    const info = work.prepare(`
      INSERT INTO papers(slug,version_key,family_id,title,date,abstract,tex_root,pdf_path,content_sha,is_latest)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      p.slug, p.version_key, p.family_id, p.title, p.date, p.abstract,
      p.tex_root, p.pdf_path, p.content_sha, p.is_latest,
    );
    const newId = Number(info.lastInsertRowid);
    const rows = oldDb.prepare('SELECT * FROM chunks WHERE paper_id=?').all(p.id);
    for (const c of rows) {
      db.insertChunk(work, { ...c, id: undefined, paper_id: newId });
    }
  });
}

module.exports = {
  build,
  listPaperDirs,
  buildPaper,
  computeLatest,
};
