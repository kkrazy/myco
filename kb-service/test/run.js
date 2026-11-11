// KB service unit tests. Pure Node — no network, no Docker.
// Run: node test/run.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const db = require('../src/db');
const q = require('../src/query');
const tex = require('../src/corpus/tex');
const metadata = require('../src/corpus/metadata');
const notes = require('../src/notes');
const retriever = require('../src/retriever');

let passed = 0;
let failed = 0;

async function t(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (e) {
    console.log('  ✗ ' + name + ' — ' + (e && e.stack ? e.stack : e));
    failed++;
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
}

async function main() {
  console.log('── query ──');

  await t('normalize strips stopwords and expands LaTeX', () => {
    const r = q.normalize('What is the \\mathbb{Z} ultrapower of a C^* algebra?');
    assert.ok(r.terms.includes('Z'));
    assert.ok(r.terms.includes('ultrapower'));
    assert.ok(!r.terms.includes('the'));
    assert.strictEqual(r.cjk, false);
  });

  await t('normalize detects CJK', () => {
    assert.strictEqual(q.normalize('椭圆曲线').cjk, true);
    assert.strictEqual(q.normalize('Selmer 群').cjk, true);
  });

  await t('buildMatch quotes every term (hyphen is not an operator)', () => {
    const expr = q.buildMatch(['zero-free', 'region']);
    assert.strictEqual(expr, '"zero-free" AND "region"');
  });

  await t('buildMatch modes', () => {
    assert.strictEqual(q.buildMatch(['a1', 'b2'], 'or'), '"a1" OR "b2"');
    assert.strictEqual(q.buildMatch(['a1', 'b2'], 'prefix'), '"a1" AND "b2"*');
  });

  await t('cjkBigrams', () => {
    assert.deepStrictEqual(q.cjkBigrams('椭圆曲线'), ['椭圆', '圆曲', '曲线']);
    assert.deepStrictEqual(q.cjkBigrams('群'), ['群']);
  });

  await t('buildCjkMatch mixes CJK bigrams and latin', () => {
    const expr = q.buildCjkMatch(['椭圆曲线', 'Selmer']);
    assert.ok(expr.includes('"椭圆"'));
    assert.ok(expr.includes('"曲线"'));
    assert.ok(expr.includes('"Selmer"'));
  });

  await t('classify picks a kind hint', () => {
    assert.strictEqual(q.classify('prove the following theorem'), 'theorem');
    assert.strictEqual(q.classify('what is a good approach'), 'method');
    assert.strictEqual(q.classify('find a counterexample'), 'counterexample');
    assert.strictEqual(q.classify('Kakeya dimension'), null);
  });

  console.log('── tex ──');

  await t('cleanTex keeps math symbols, drops layout', () => {
    const out = tex.cleanTex(
      '\\section{Intro}\nWe have $C^*$-algebras and \\emph{more}.\\noindent Done.',
    );
    assert.ok(out.includes('C^*'));
    assert.ok(out.includes('more'));
    assert.ok(!out.includes('noindent'));
    assert.ok(!out.includes('\\section'));
  });

  await t('cleanTex strips comments but keeps escaped percent', () => {
    const out = tex.cleanTex('a % comment\nb 50\\% c');
    assert.ok(!out.includes('comment'));
    assert.ok(out.includes('50'));
  });

  await t('splitProse respects the size cap', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const parts = tex.splitProse(text, 200);
    assert.ok(parts.length > 1);
    for (const p of parts) assert.ok(p.length <= 260, `piece too long: ${p.length}`);
  });

  await t('extractEnvironments finds theorem + proof with label', () => {
    // Bodies under 40 chars are dropped as fragments, so use realistic text.
    const raw = '\\begin{theorem}[Main]\\label{thm:main} Every object X in this '
      + 'category is isomorphic to a Y.\\end{theorem}'
      + '\\begin{proof}Because Z follows from the universal property, and the '
      + 'diagram commutes by naturality.\\end{proof}';
    const out = tex.extractEnvironments(raw);
    const thm = out.find((e) => e.kind === 'theorem');
    assert.ok(thm);
    assert.strictEqual(thm.anchor_label, 'thm:main');
    assert.ok(thm.text.includes('Main'));
    assert.ok(out.some((e) => e.kind === 'proof'));
  });

  await t('extractAbstract + extractRefs', () => {
    const raw = '\\begin{abstract}Short summary.\\end{abstract}'
      + '\\begin{thebibliography}{9}\\bibitem{a} A.\\end{thebibliography}';
    assert.strictEqual(tex.extractAbstract(raw), 'Short summary.');
    assert.ok(tex.extractRefs(raw).includes('A.'));
  });

  await t('chunkBody tracks section path', () => {
    const raw = '\\section{Intro}\n' + 'A sentence that is long enough to survive filtering. '.repeat(4)
      + '\n\\subsection{Details}\n' + 'Another sentence that is long enough to survive. '.repeat(4);
    const out = tex.chunkBody(raw);
    assert.ok(out.length >= 2);
    assert.ok(out.some((c) => c.section_path === 'Intro > Details'));
  });

  console.log('── metadata ──');

  await t('versionKey strips the date suffix', () => {
    assert.strictEqual(
      metadata.versionKey('Fontaine-Mazur-modularity-at-the-prime-2-October-6-2026'),
      'Fontaine-Mazur-modularity-at-the-prime-2',
    );
  });

  await t('sortableDate orders months correctly', () => {
    const a = metadata.sortableDate('September-23-2026');
    const b = metadata.sortableDate('October-6-2026');
    assert.ok(a < b, `${a} should sort before ${b}`);
  });

  await t('readBracedArgs handles nested braces', () => {
    const src = '{a {b} c}{second}';
    const r = metadata.readBracedArgs(src, 0, 2);
    assert.deepStrictEqual(r.args, ['a {b} c', 'second']);
  });

  console.log('── notes ──');

  await t('front matter round-trips', () => {
    const meta = {
      id: 'x-1', title: 'A "quoted" title', kind: 'insight', status: 'draft',
      scope: 'project', tags: ['a', 'b'], confidence: 'medium',
      source: { session: 's1', paper: 'p1', chunks: [1, 2] },
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    };
    const text = notes.serializeFrontMatter(meta) + '\n\n## 结论\n\nBody.\n';
    const parsed = notes.parseFrontMatter(text);
    assert.strictEqual(parsed.meta.title, 'A "quoted" title');
    assert.deepStrictEqual(parsed.meta.tags, ['a', 'b']);
    assert.strictEqual(parsed.meta.source.session, 's1');
    assert.ok(parsed.body.includes('Body.'));
  });

  await t('sanitizeBody neutralizes active content', () => {
    const out = notes.sanitizeBody('<script>alert(1)</script>```bash\nrm -rf /\n```javascript:x');
    assert.ok(!out.includes('<script'));
    assert.ok(!out.includes('```bash'));
    assert.ok(!out.includes('javascript:'));
  });

  await t('slugify is stable and CJK-safe', () => {
    assert.strictEqual(notes.slugify('BSD at Selmer corank 1'), 'bsd-at-selmer-corank-1');
    assert.ok(notes.slugify('椭圆曲线').length > 0);
    assert.ok(notes.slugify('!!!').startsWith('note-'));
  });

  await t('chunkNoteBody splits on H2 and skips the update log', () => {
    const body = '## 结论\n\nA conclusion that is long enough to be indexed.\n\n'
      + '## 更新记录\n\n- 2026-01-01 changed';
    const out = notes.chunkNoteBody(body);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].section, '结论');
    assert.ok(!out[0].text.includes('changed'));
  });

  await t('remember creates then merges, keeping created_at', () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    const first = notes.remember(dir, conn, {
      title: 'Test note', kind: 'insight', content: '## 结论\n\nFirst body.',
      tags: ['x'], source: { session: 's1' },
    });
    assert.strictEqual(first.created, true);
    const second = notes.remember(dir, conn, {
      title: 'Test note', kind: 'insight', content: 'Second body.', tags: ['y'],
    });
    assert.strictEqual(second.created, false);
    assert.strictEqual(second.merged, true);
    const note = notes.readNote(dir, first.slug);
    assert.ok(note.body.includes('First body.'));
    assert.ok(note.body.includes('Second body.'));
    assert.ok(note.body.includes('## 更新记录'));
    assert.ok(note.meta.tags.includes('x') && note.meta.tags.includes('y'));
    conn.close();
  });

  await t('setStatus and removeNote', () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    const out = notes.remember(dir, conn, { title: 'Status note', kind: 'lemma', content: 'Body text here.' });
    notes.setStatus(dir, conn, out.slug, 'verified');
    assert.strictEqual(notes.readNote(dir, out.slug).meta.status, 'verified');
    notes.removeNote(dir, conn, out.slug);
    assert.strictEqual(notes.readNote(dir, out.slug), null);
    assert.strictEqual(notes.listNotes(conn).length, 0);
    conn.close();
  });

  await t('reindexAll rebuilds the index from Markdown', () => {
    const dir = tmpDir();
    let conn = db.openDb(dir);
    notes.remember(dir, conn, { title: 'Persisted', kind: 'method', content: 'Body that survives.' });
    conn.close();
    // Simulate a corpus rebuild: replace the DB, then re-ingest notes.
    fs.unlinkSync(path.join(dir, 'index.sqlite'));
    conn = db.openDb(dir);
    const out = notes.reindexAll(dir, conn);
    assert.strictEqual(out.indexed, 1);
    assert.strictEqual(notes.listNotes(conn).length, 1);
    conn.close();
  });

  console.log('── retriever ──');

  await t('search finds corpus chunks and shapes citations', async () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    const paperId = Number(conn.prepare(`
      INSERT INTO papers(slug,version_key,title,date,is_latest) VALUES(?,?,?,?,1)`)
      .run('test-paper-October-1-2026', 'test-paper', 'Test Paper', 'October-1-2026')
      .lastInsertRowid);
    db.insertChunk(conn, {
      source: 'corpus', paper_id: paperId, kind: 'body', title: 'Test Paper',
      section: 'Intro', section_path: 'Intro',
      text: 'We prove the Kakeya conjecture in four dimensions using polynomial methods.',
    });
    const out = await retriever.search(conn, 'Kakeya conjecture', { k: 3 });
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.results[0].citation, '[KB:test-paper-October-1-2026 §Intro]');
    assert.strictEqual(out.results[0].source, 'corpus');
    conn.close();
  });

  await t('search excludes refs and non-latest versions by default', async () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    const oldId = Number(conn.prepare(`
      INSERT INTO papers(slug,version_key,title,date,is_latest) VALUES(?,?,?,?,0)`)
      .run('p-September-1-2026', 'p', 'P', 'September-1-2026').lastInsertRowid);
    const newId = Number(conn.prepare(`
      INSERT INTO papers(slug,version_key,title,date,is_latest) VALUES(?,?,?,?,1)`)
      .run('p-October-1-2026', 'p', 'P', 'October-1-2026').lastInsertRowid);
    db.insertChunk(conn, { source: 'corpus', paper_id: oldId, kind: 'body', title: 'P', text: 'unique-token old version text' });
    db.insertChunk(conn, { source: 'corpus', paper_id: newId, kind: 'body', title: 'P', text: 'unique-token new version text' });
    db.insertChunk(conn, { source: 'corpus', paper_id: newId, kind: 'refs', title: 'P', text: 'unique-token bibliography entry' });
    const out = await retriever.search(conn, 'unique-token', { k: 10 });
    assert.strictEqual(out.count, 1);
    assert.ok(out.results[0].snippet.includes('new version'));
    const all = await retriever.search(conn, 'unique-token', { k: 10, includeVersions: true, includeRefs: true });
    assert.strictEqual(all.count, 3);
    conn.close();
  });

  await t('search finds local notes and marks them', async () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    notes.remember(dir, conn, {
      title: 'Local finding', kind: 'insight',
      content: '## 结论\n\nThe zeta-gap constant equals seven eighths.',
    });
    const out = await retriever.search(conn, 'zeta-gap constant', { k: 3 });
    assert.ok(out.count >= 1);
    assert.strictEqual(out.results[0].source, 'local');
    assert.ok(out.results[0].citation.startsWith('[LOCAL:'));
    conn.close();
  });

  await t('search finds CJK notes via bigrams', async () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    notes.remember(dir, conn, {
      title: '椭圆曲线结论', kind: 'insight',
      content: '## 结论\n\n椭圆曲线的解析秩等于 Mordell-Weil 秩。',
    });
    const out = await retriever.search(conn, '椭圆曲线', { k: 3 });
    assert.ok(out.count >= 1, 'expected a CJK hit');
    assert.strictEqual(out.results[0].source, 'local');
    conn.close();
  });

  await t('diversify caps per paper and per section', () => {
    const rows = [
      { id: 1, paper_slug: 'p', section_path: 's', source: 'corpus' },
      { id: 2, paper_slug: 'p', section_path: 's', source: 'corpus' },
      { id: 3, paper_slug: 'p', section_path: 's', source: 'corpus' },
      { id: 4, paper_slug: 'p', section_path: 't', source: 'corpus' },
      { id: 5, paper_slug: 'q', section_path: 's', source: 'corpus' },
    ];
    const out = retriever.diversify(rows, { perPaper: 2, perSection: 1 });
    assert.deepStrictEqual(out.map((r) => r.id), [1, 4, 5]);
  });

  await t('rrf merges ranked lists', () => {
    const a = [{ id: 1 }, { id: 2 }];
    const b = [{ id: 2 }, { id: 3 }];
    const out = retriever.rrf([a, b]);
    assert.strictEqual(out[0].id, 2);
  });

  await t('empty query returns no results without throwing', async () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    const out = await retriever.search(conn, '   ', {});
    assert.strictEqual(out.count, 0);
    conn.close();
  });

  await t('stats counts corpus and local separately', () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    notes.remember(dir, conn, { title: 'S', kind: 'insight', content: 'Body.' });
    const s = retriever.stats(conn);
    assert.strictEqual(s.localChunks, 1);
    assert.strictEqual(s.notes, 1);
    conn.close();
  });

  console.log('── db ──');

  await t('bigramExpand expands CJK runs only', () => {
    assert.strictEqual(db.bigramExpand('椭圆曲线').trim(), '椭圆 圆曲 曲线');
    assert.strictEqual(db.bigramExpand('Selmer group').trim(), 'Selmer group');
  });

  await t('deleteChunksForNote clears both FTS tables', () => {
    const dir = tmpDir();
    const conn = db.openDb(dir);
    const out = notes.remember(dir, conn, { title: 'Del', kind: 'insight', content: '椭圆曲线 body.' });
    const before = conn.prepare('SELECT COUNT(*) n FROM chunks_fts_cjk').get().n;
    assert.ok(before > 0);
    db.deleteChunksForNote(conn, out.noteId || conn.prepare('SELECT id FROM notes WHERE slug=?').get(out.slug).id);
    assert.strictEqual(conn.prepare('SELECT COUNT(*) n FROM chunks_fts_cjk').get().n, 0);
    conn.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
