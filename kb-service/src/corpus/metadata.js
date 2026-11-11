// Corpus metadata enrichment.
//
// Three authoritative sources in the math repository:
//   overview.tex          — 17 \cataloguesection{Discipline}{n} + 374
//                           \resultentry{NNN}{title}{summary}{links}
//   CONTENTS.md           — the same families in Markdown, plus per-paper
//                           abstracts and Lean links
//   lean/formalization.yaml — which papers have formalizations, and the
//                           Lean declaration names
//
// Everything here is best-effort: a missing or malformed file yields empty
// metadata rather than a failed build.

'use strict';

const fs = require('fs');
const path = require('path');
const { cleanTex } = require('./tex');

// ── overview.tex ────────────────────────────────────────────────────────

// Parse balanced-brace arguments starting at `from`. Returns
// [{arg, end}] for `count` arguments. LaTeX arguments nest braces, so a
// naive regex would truncate on the first '}'.
function readBracedArgs(src, from, count) {
  const args = [];
  let i = from;
  while (args.length < count) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') return null;
    let depth = 0;
    const start = i + 1;
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return null;
    args.push(src.slice(start, i));
    i++;
  }
  return { args, end: i };
}

// Returns { disciplines: [{name, ordinal}], families: [{id,title,summary,links}] }
function parseOverview(overviewPath) {
  const out = { disciplines: [], families: [] };
  let src;
  try { src = fs.readFileSync(overviewPath, 'utf8'); } catch { return out; }

  const secRe = /\\cataloguesection\s*\{/g;
  let m;
  while ((m = secRe.exec(src)) !== null) {
    const r = readBracedArgs(src, m.index + m[0].length - 1, 2);
    if (!r) continue;
    out.disciplines.push({
      name: cleanTex(r.args[0]),
      ordinal: parseInt(r.args[1], 10) || out.disciplines.length + 1,
    });
  }

  // Track the discipline a family belongs to by source position.
  const sections = [];
  const secPos = /\\cataloguesection\s*\{/g;
  while ((m = secPos.exec(src)) !== null) {
    const r = readBracedArgs(src, m.index + m[0].length - 1, 2);
    if (r) sections.push({ at: m.index, name: cleanTex(r.args[0]) });
  }

  const entryRe = /\\resultentry\s*\{/g;
  while ((m = entryRe.exec(src)) !== null) {
    const r = readBracedArgs(src, m.index + m[0].length - 1, 4);
    if (!r) continue;
    const [id, title, summary, links] = r.args;
    const at = m.index;
    let discipline = null;
    for (const s of sections) if (s.at <= at) discipline = s.name;
    const paperLinks = [];
    const linkRe = /\\href\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g;
    let lm;
    while ((lm = linkRe.exec(links)) !== null) {
      const url = lm[1];
      const idx = url.indexOf('/preprints/');
      if (idx >= 0) {
        const rest = url.slice(idx + '/preprints/'.length);
        paperLinks.push({ slug: rest.split('/')[0], title: cleanTex(lm[2]) });
      }
    }
    out.families.push({
      id: String(id).trim(),
      title: cleanTex(title),
      summary: cleanTex(summary),
      discipline,
      papers: paperLinks,
    });
  }
  return out;
}

// ── CONTENTS.md ─────────────────────────────────────────────────────────

// Markdown table cells with **NNN. Title.** summary, followed by
// "&emsp;[Paper title](preprints/<slug>/<file>.pdf)" + abstract rows.
function parseContents(contentsPath) {
  let src;
  try { src = fs.readFileSync(contentsPath, 'utf8'); } catch { return { families: [], papers: [] }; }

  const families = [];
  const papers = [];
  const lines = src.split('\n');
  let current = null;

  for (const line of lines) {
    const fam = line.match(/^\*\*(\d{3})\.\s*(.+?)\*\*\s*(.*)$/);
    if (fam) {
      current = { id: fam[1], title: fam[2].trim(), summary: fam[3].trim() };
      families.push(current);
      continue;
    }
    const paper = line.match(/\[([^\]]+)\]\((preprints\/[^)]+)\)/);
    if (paper) {
      const slug = paper[2].replace(/^preprints\//, '').split('/')[0];
      const lean = line.match(/\((lean\/docs\/[^)]+)\)/);
      papers.push({
        slug,
        title: paper[1].trim(),
        family_id: current ? current.id : null,
        lean_doc: lean ? lean[1] : null,
        abstract: '',
      });
      continue;
    }
    // The abstract paragraph follows the link row in its own <td>.
    if (current && papers.length && /^[A-Z]/.test(line.trim()) && line.trim().length > 80) {
      const last = papers[papers.length - 1];
      if (!last.abstract && last.family_id === current.id) {
        last.abstract = line.trim();
      }
    }
  }
  return { families, papers };
}

// ── lean/formalization.yaml ─────────────────────────────────────────────

// Minimal YAML reader for the two shapes we need. Avoids a js-yaml dep:
// the file is machine-generated with a stable, simple layout.
//   sources:  - title/id/type
//   results:  - source: <id>  declarations: [{declaration: ...}]
function parseFormalization(yamlPath) {
  const out = { byPdf: new Map(), bySlug: new Map(), declarations: [] };
  let src;
  try { src = fs.readFileSync(yamlPath, 'utf8'); } catch { return out; }

  const lines = src.split('\n');
  let section = null;          // top-level key
  let sub = null;              // nested key (e.g. status.main_results)
  let entry = null;

  const commit = () => {
    if (!entry) return;
    const isSource = section === 'sources';
    const isDecl = sub === 'main_results' || section === 'results';
    if (isSource && entry.id) {
      const idx = entry.id.indexOf('preprints/');
      if (idx >= 0) {
        const slug = entry.id.slice(idx + 'preprints/'.length).split('/')[0];
        out.byPdf.set(slug, { title: entry.title || '', slug });
        out.bySlug.set(slug, { title: entry.title || '', slug });
      }
    }
    if (isDecl && entry.declaration) {
      out.declarations.push({
        declaration: entry.declaration,
        file: entry.file || null,
        comparator_config: entry.comparator_config || null,
      });
    }
    entry = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = line.match(/^([a-zA-Z_]+):\s*$/);
    if (top) { commit(); section = top[1]; sub = null; continue; }
    const nested = line.match(/^ {2}([a-zA-Z_]+):\s*$/);
    if (nested) { commit(); sub = nested[1]; continue; }
    const item = line.match(/^\s*-\s+(\w+):\s*(.*)$/);
    if (item) {
      commit();
      entry = {};
      assign(entry, item[1], item[2]);
      continue;
    }
    if (!entry) continue;
    const kv = line.match(/^\s+(\w+):\s*(.*)$/);
    if (kv) assign(entry, kv[1], kv[2]);
  }
  commit();
  return out;
}

function assign(obj, key, rawValue) {
  const v = unquote(rawValue);
  if (key === 'authors') {
    obj.authors = v.replace(/^\[|\]$/g, '').split(',').map((s) => unquote(s.trim())).filter(Boolean);
  } else {
    obj[key] = v;
  }
}

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

// ── assembly ────────────────────────────────────────────────────────────

// Build the full metadata picture for a corpus root.
// Returns {
//   disciplines, families, familyById, paperMetaBySlug, leanBySlug,
//   leanDeclarations
// }
function loadCorpusMetadata(corpusRoot) {
  const overview = parseOverview(path.join(corpusRoot, 'overview.tex'));
  const contents = parseContents(path.join(corpusRoot, 'CONTENTS.md'));
  const lean = parseFormalization(path.join(corpusRoot, 'lean', 'formalization.yaml'));

  const familyById = new Map();
  for (const f of overview.families) {
    familyById.set(f.id, { ...f, lean_doc: null });
  }
  // CONTENTS.md is the source of truth for family→paper mapping.
  for (const f of contents.families) {
    const existing = familyById.get(f.id);
    if (existing) {
      if (!existing.title) existing.title = f.title;
      if (!existing.summary) existing.summary = f.summary;
    } else {
      familyById.set(f.id, { id: f.id, title: f.title, summary: f.summary, discipline: null, papers: [], lean_doc: null });
    }
  }

  // paper slug → { family_id, title, abstract, lean_doc }
  const paperMetaBySlug = new Map();
  for (const p of contents.papers) {
    paperMetaBySlug.set(p.slug, p);
    const fam = p.family_id ? familyById.get(p.family_id) : null;
    if (fam && p.lean_doc && !fam.lean_doc) fam.lean_doc = p.lean_doc;
  }
  // overview.tex link lists also map slug→family (covers papers whose
  // CONTENTS row is missing).
  for (const f of overview.families) {
    for (const p of f.papers || []) {
      if (!paperMetaBySlug.has(p.slug)) {
        paperMetaBySlug.set(p.slug, { slug: p.slug, title: p.title, family_id: f.id, abstract: '', lean_doc: null });
      } else if (!paperMetaBySlug.get(p.slug).family_id) {
        paperMetaBySlug.get(p.slug).family_id = f.id;
      }
    }
  }

  return {
    disciplines: overview.disciplines,
    families: [...familyById.values()],
    familyById,
    paperMetaBySlug,
    leanBySlug: lean.bySlug,
    leanDeclarations: lean.declarations,
  };
}

// Version key: strip a trailing "-Month-DD-YYYY" from a paper slug.
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_SUFFIX_RE = new RegExp(`-(?:${MONTHS})-\\d{1,2}-\\d{4}$`);

function versionKey(slug) {
  return String(slug || '').replace(DATE_SUFFIX_RE, '');
}

function dateFromSlug(slug) {
  const m = String(slug || '').match(new RegExp(`-((?:${MONTHS})-\\d{1,2}-\\d{4})$`));
  return m ? m[1] : '';
}

const MONTH_INDEX = new Map(
  MONTHS.split('|').map((name, i) => [name, i]),
);

// Sortable key for a slug date ("October-6-2026" → "2026-10-06").
// Lexicographic comparison of the raw month NAME would order
// September before October, which is how the first build picked the
// wrong "latest" version.
function sortableDate(slugOrDate) {
  const m = String(slugOrDate || '').match(
    new RegExp(`(${MONTHS})-(\\d{1,2})-(\\d{4})`),
  );
  if (!m) return '';
  const month = String(MONTH_INDEX.get(m[1]) + 1).padStart(2, '0');
  return `${m[3]}-${month}-${m[2].padStart(2, '0')}`;
}

module.exports = {
  parseOverview,
  parseContents,
  parseFormalization,
  loadCorpusMetadata,
  versionKey,
  dateFromSlug,
  sortableDate,
  readBracedArgs,
};
