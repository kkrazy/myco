// TeX → structured chunks.
//
// The corpus is 99.6% TeX, so this is the primary parser. It is
// deliberately regex-based (no LaTeX engine, no Python dep): the goal is
// retrieval-quality text, not typesetting fidelity.
//
// Chunk kinds produced:
//   abstract   — the \begin{abstract} block
//   theorem    — one per theorem/lemma/proposition/corollary/definition/
//                conjecture/claim environment, with its \label
//   proof      — one per proof environment
//   body       — section-delimited prose, split to ~1400 chars
//   refs       — bibliography (indexed, but excluded from search by default)
//
// Math is preserved as symbol soup ($L^2$ → "L^2", $C^*$ → "C^*") because
// those tokens are exactly what researchers search for.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CHUNK_CHARS = 1400;
const MIN_CHUNK_CHARS = 120;

const THEOREM_ENVS = [
  'theorem', 'lemma', 'proposition', 'corollary',
  'definition', 'conjecture', 'claim', 'remark', 'example',
];

const SECTION_RE = /\\(section|subsection|subsubsection|chapter)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/;
const INPUT_RE = /\\(?:input|include)\s*\{([^{}]+)\}/g;

// Formatting/layout commands whose names carry no retrieval value. Every
// other bare command is treated as a math macro and its name is kept.
const LAYOUT_COMMANDS = new Set([
  'noindent', 'indent', 'par', 'newline', 'linebreak', 'pagebreak',
  'clearpage', 'newpage', 'smallskip', 'medskip', 'bigskip', 'vspace',
  'hspace', 'vfill', 'hfill', 'centering', 'raggedright', 'raggedleft',
  'maketitle', 'tableofcontents', 'appendix', 'item', 'quad', 'qquad',
  'textwidth', 'linewidth', 'columnwidth', 'baselineskip', 'small',
  'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize', 'footnotesize',
  'scriptsize', 'tiny', 'bfseries', 'itshape', 'em', 'rmfamily', 'sffamily',
  'ttfamily', 'normalfont', 'selectfont', 'color', 'textcolor', 'textbf',
  'textit', 'emph', 'texttt', 'textrm', 'textsf', 'textsc', 'underline',
  'Needspace', 'nobreak', 'hypertarget', 'pdfbookmark', 'label', 'ref',
  'cite', 'begin', 'end', 'documentclass', 'usepackage', 'setcounter',
  'addtocounter', 'setlength', 'renewcommand', 'newcommand', 'def', 'let',
  'DeclareMathOperator', 'thispagestyle', 'pagestyle', 'fancyhead',
  'fancyfoot', 'renewcommand', 'headrulewidth', 'footrulewidth',
  'bibliographystyle', 'bibliography', 'printbibliography', 'input',
  'include', 'geometry', 'hypersetup', 'titleformat', 'titlespacing',
  'setlist', 'setmainfont', 'setsansfont', 'setmonofont', 'setmathfont',
  'usetikzlibrary', 'tikzset', 'definecolor', 'newtheorem', 'theoremstyle',
  'allowdisplaybreaks', 'emergencystretch', 'parindent', 'parskip',
  'raggedbottom', 'tableofcontents', 'maketitle', 'date', 'author', 'title',
]);

// ── file discovery ──────────────────────────────────────────────────────

// Find the TeX entry point for a paper: the file containing
// \documentclass, preferring build/paper.tex, build/main.tex, then any.
function findEntryTex(paperDir) {
  const candidates = [];
  walk(paperDir, (file) => {
    if (!file.endsWith('.tex')) return;
    let head;
    try { head = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { return; }
    if (!head.includes('\\documentclass')) return;
    candidates.push(file);
  });
  if (!candidates.length) return null;
  const score = (f) => {
    const b = path.basename(f);
    if (b === 'paper.tex') return 0;
    if (b === 'main.tex') return 1;
    if (b === 'article.tex') return 2;
    return 3;
  };
  candidates.sort((a, b) => score(a) - score(b) || a.length - b.length);
  return candidates[0];
}

// Recursively expand \input / \include relative to the entry file's dir.
// Depth-limited; a missing include is skipped rather than fatal.
function expandIncludes(entryFile, depth = 0, seen = new Set()) {
  if (depth > 8) return '';
  const abs = path.resolve(entryFile);
  if (seen.has(abs)) return '';
  seen.add(abs);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch { return ''; }
  const dir = path.dirname(abs);
  return raw.replace(INPUT_RE, (_m, rel) => {
    const name = rel.trim();
    const tries = [name, name + '.tex'];
    for (const t of tries) {
      const p = path.resolve(dir, t);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return '\n' + expandIncludes(p, depth + 1, seen) + '\n';
      }
    }
    return '';   // missing include: drop the directive
  });
}

function walk(dir, fn) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else if (e.isFile()) fn(p);
  }
}

// ── cleaning ────────────────────────────────────────────────────────────

// Strip LaTeX scaffolding while keeping prose + math symbols.
function cleanTex(src) {
  let t = String(src || '');
  // Comments: % to end of line, but not \%.
  t = t.replace(/(^|[^\\])%.*$/gm, '$1');
  // Preamble: everything before \begin{document}, and the trailing \end.
  const docStart = t.indexOf('\\begin{document}');
  if (docStart >= 0) t = t.slice(docStart + '\\begin{document}'.length);
  const docEnd = t.lastIndexOf('\\end{document}');
  if (docEnd >= 0) t = t.slice(0, docEnd);
  // Cross-reference machinery — the arguments carry no retrieval value.
  t = t.replace(/\\(?:cite|citep|citet|ref|eqref|autoref|cref|Cref|label|href|url|input|include|bibliography|bibliographystyle|usepackage|documentclass|newcommand|renewcommand|DeclareMathOperator)\*?\s*(?:\[[^\]]*\])?\s*\{[^{}]*\}/g, ' ');
  // Environment shells: keep inner text.
  t = t.replace(/\\(?:begin|end)\s*\{[^{}]*\}(?:\s*\[[^\]]*\])?/g, ' ');
  // Remaining commands: drop the command, keep any braced argument text
  // (e.g. \emph{word} → word) by handling the common one-arg shape.
  t = t.replace(/\\[a-zA-Z@]+\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, ' $1 ');
  // Bare commands with no argument. Layout/formatting commands carry no
  // meaning and are dropped; short math macros (\Z, \C, \SL, \Otwo) are
  // user-defined shorthands for symbols, so their NAME is kept — that is
  // exactly what a researcher types when searching.
  t = t.replace(/\\([a-zA-Z@]+)\*?/g, (_m, name) => (
    LAYOUT_COMMANDS.has(name) ? ' ' : ` ${name} `
  ));
  // Math delimiters → keep the symbols.
  t = t.replace(/\$\$?/g, ' ');
  t = t.replace(/\\[()[\]]/g, ' ');
  // Braces and stray backslashes.
  t = t.replace(/[{}]/g, ' ');
  t = t.replace(/\\/g, ' ');
  // Whitespace normalization.
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n[ \t]+/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// Extract the abstract before general cleaning (it must not be swallowed
// by the environment-shell stripper).
function extractAbstract(raw) {
  const m = raw.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/);
  return m ? cleanTex(m[1]).slice(0, 2000) : '';
}

function extractRefs(raw) {
  const m = raw.match(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/);
  if (m) return cleanTex(m[0]).slice(0, 20000);
  return '';
}

// ── chunking ────────────────────────────────────────────────────────────

// Split prose into ~MAX_CHUNK_CHARS pieces on sentence-ish boundaries.
function splitProse(text, max = MAX_CHUNK_CHARS) {
  const out = [];
  let cur = '';
  const parts = text.split(/(?<=[.;:!?])\s+(?=[A-Z(\[])|(?<=\n)\s*\n/);
  for (const p of parts) {
    if (!p) continue;
    if (cur && cur.length + p.length > max) {
      out.push(cur.trim());
      cur = p;
    } else {
      cur += (cur ? ' ' : '') + p;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((c) => c.length >= MIN_CHUNK_CHARS);
}

// Pull out theorem-like environments with their labels, replacing them in
// the prose stream with a placeholder so the same text is not indexed twice.
function extractEnvironments(raw) {
  const found = [];
  const envAlt = THEOREM_ENVS.join('|');
  // The optional title has a NON-GREEDY body: `[Main]` then `\label{...}`.
  // A greedy `[^\]]*` would swallow `]\label{thm:main}` into the title and
  // the body would start after the label, losing it.
  const re = new RegExp(
    `\\\\begin\\{(${envAlt})\\}(?:\\s*\\[([^\\]]*?)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`,
    'g',
  );
  let m;
  while ((m = re.exec(raw)) !== null) {
    const [full, env, optTitle, body] = m;
    const labelM = body.match(/\\label\{([^{}]+)\}/);
    const text = cleanTex(body);
    if (text.length < 40) continue;
    found.push({
      kind: 'theorem',
      env,
      anchor_label: labelM ? labelM[1] : null,
      anchor_name: optTitle ? cleanTex(optTitle) : null,
      text: (optTitle ? `[${cleanTex(optTitle)}] ` : '') + text,
      start: m.index,
      end: m.index + full.length,
    });
  }
  // Proofs, kept separate so "how was X proved" is a distinct query.
  const proofRe = /\\begin\{proof\}(?:\[([^\]]*)\])?([\s\S]*?)\\end\{proof\}/g;
  while ((m = proofRe.exec(raw)) !== null) {
    const text = cleanTex(m[2]);
    if (text.length < 60) continue;
    found.push({
      kind: 'proof',
      env: 'proof',
      anchor_label: null,
      anchor_name: m[1] ? cleanTex(m[1]) : null,
      text,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  found.sort((a, b) => a.start - b.start);
  return found;
}

// Section-aware body chunking. Returns [{kind, section, section_path, text}].
function chunkBody(raw) {
  const blocks = [];
  let section = '';
  let subsection = '';
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    const text = cleanTex(buf.join('\n'));
    const sectionPath = [section, subsection].filter(Boolean).join(' > ');
    for (const piece of splitProse(text)) {
      blocks.push({
        kind: 'body',
        section: subsection || section || '',
        section_path: sectionPath,
        text: piece,
      });
    }
    buf = [];
  };
  for (const line of raw.split('\n')) {
    const m = line.match(SECTION_RE);
    if (m) {
      flush();
      const level = m[1];
      const title = cleanTex(m[2]);
      if (level === 'section' || level === 'chapter') {
        section = title; subsection = '';
      } else {
        subsection = title;
      }
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

// Parse one paper directory into a paper record + chunks.
function parsePaper(paperDir) {
  const entry = findEntryTex(paperDir);
  if (!entry) return null;
  const raw = expandIncludes(entry);
  if (!raw.trim()) return null;

  const abstract = extractAbstract(raw);
  const refs = extractRefs(raw);
  const envs = extractEnvironments(raw);
  const body = chunkBody(raw);

  let ord = 0;
  const chunks = [];
  if (abstract) {
    chunks.push({ kind: 'abstract', section: 'Abstract', section_path: 'Abstract', ord: ord++, text: abstract });
  }
  for (const e of envs) {
    chunks.push({
      kind: e.kind,
      section: '',
      section_path: '',
      ord: ord++,
      text: e.text,
      anchor_label: e.anchor_label,
      anchor_name: e.anchor_name,
    });
  }
  for (const b of body) {
    chunks.push({ ...b, ord: ord++ });
  }
  if (refs) {
    chunks.push({ kind: 'refs', section: 'References', section_path: 'References', ord: ord++, text: refs });
  }

  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  return { entry, raw, abstract, chunks, sha };
}

module.exports = {
  findEntryTex,
  expandIncludes,
  cleanTex,
  extractAbstract,
  extractRefs,
  extractEnvironments,
  chunkBody,
  splitProse,
  parsePaper,
  walk,
  MAX_CHUNK_CHARS,
  MIN_CHUNK_CHARS,
};
