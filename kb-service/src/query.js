// Query understanding + FTS5 MATCH construction.
//
// Pure functions only — this is the most heavily unit-tested module.
//
// Two problems this solves:
//   1. FTS5 treats `-` and some punctuation as operators. A user query like
//      "zero-free" becomes `zero NOT free` and errors with
//      "no such column: free". Every term must be quoted.
//   2. unicode61 tokenizes a CJK run as a single token, so 2-character
//      Chinese queries never match. CJK terms are expanded into bigrams and
//      routed at the trigram table instead (see retriever.js).

'use strict';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'to', 'in', 'on', 'at', 'by',
  'with', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this',
  'that', 'these', 'those', 'as', 'we', 'our', 'can', 'how', 'what', 'why',
  'show', 'me', 'find', 'about', 'please', 'give', 'tell',
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

// LaTeX / math shorthands → the token a paper's cleaned text will contain.
const SYMBOL_EXPANSIONS = [
  [/\\mathbb\s*\{?([A-Za-z])\}?/g, '$1'],
  [/\\mathcal\s*\{?([A-Za-z0-9]+)\}?/g, '$1'],
  [/\\mathrm\s*\{?([A-Za-z]+)\}?/g, '$1'],
  [/\\text\s*\{([^{}]*)\}/g, '$1'],
  [/\\[a-zA-Z]+\s*/g, ' '],       // remaining macros: keep the prose
  [/\^\{?([^}\s]+)\}?/g, '^$1'],
  [/_\{?([^}\s]+)\}?/g, '_$1'],
];

function hasCjk(s) {
  return CJK_RE.test(String(s || ''));
}

// Normalize a raw user query into a list of terms.
// Returns { terms: string[], raw: string, cjk: boolean }.
function normalize(raw) {
  let q = String(raw || '');
  q = q.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0));   // full-width → ASCII
  for (const [re, rep] of SYMBOL_EXPANSIONS) q = q.replace(re, rep);
  q = q.replace(/[“”„«»]/g, '"').replace(/[‘’]/g, "'");
  q = q.replace(/["'`]/g, ' ');

  const tokens = q
    .split(/[\s,;|/\\()[\]{}<>!?=+*&^%$#@~]+/)
    .map((t) => t.replace(/^[.:-]+|[.:-]+$/g, ''))
    .filter(Boolean);

  const terms = [];
  for (const t of tokens) {
    // Single-character terms are dropped EXCEPT uppercase math symbols
    // (Z, R, C, Q) — those are meaningful in this corpus and are exactly
    // what \mathbb{Z} expands to.
    if (t.length < 2 && !/^[A-Z]$/.test(t)) continue;
    if (!hasCjk(t) && t.length > 1 && STOPWORDS.has(t.toLowerCase())) continue;
    terms.push(t);
  }
  return { terms, raw: String(raw || ''), cjk: hasCjk(q) };
}

// CJK bigrams for the trigram index. "椭圆曲线" → ["椭圆","圆曲","曲线"].
function cjkBigrams(term) {
  const chars = [...String(term || '')];
  if (chars.length < 2) return chars.length ? [chars[0]] : [];
  const out = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

// Quote one term for FTS5. Embedded double quotes are doubled.
function quoteTerm(t) {
  return '"' + String(t).replace(/"/g, '""') + '"';
}

// Build an FTS5 MATCH expression.
//   mode 'and'  — all terms must appear (default; best precision)
//   mode 'or'   — any term (fallback when 'and' returns nothing)
//   mode 'prefix' — last term gets a `*` (fallback for partial words)
function buildMatch(terms, mode = 'and') {
  const list = (terms || []).filter(Boolean);
  if (!list.length) return '';
  if (mode === 'prefix') {
    const head = list.slice(0, -1).map(quoteTerm);
    const last = quoteTerm(list[list.length - 1]) + '*';
    return [...head, last].join(' AND ');
  }
  const joiner = mode === 'or' ? ' OR ' : ' AND ';
  return list.map(quoteTerm).join(joiner);
}

// Build a MATCH expression for the bigram-expanded CJK index.
// CJK terms expand to bigrams; latin terms are included as-is so a mixed
// query like "Selmer 余秩" works against the same table.
function buildCjkMatch(terms) {
  const grams = [];
  for (const t of terms || []) {
    if (hasCjk(t)) grams.push(...cjkBigrams(t));
    else if (t.length >= 2) grams.push(t);
  }
  const uniq = [...new Set(grams)].filter(Boolean);
  if (!uniq.length) return '';
  return uniq.map(quoteTerm).join(' OR ');
}

// Classify a query so the retriever can pick a sensible default kind filter.
// e.g. "prove that ..." → theorem/proof; "how to approach" → method/trace.
function classify(raw) {
  const q = String(raw || '').toLowerCase();
  if (/\b(theorem|lemma|proposition|corollary|conjecture|claim)\b/.test(q)) return 'theorem';
  if (/\b(proof|prove|proved|argument)\b/.test(q)) return 'proof';
  if (/\b(method|approach|technique|strategy|how)\b/.test(q)) return 'method';
  if (/\b(counterexample|refute|disprove|fails?)\b/.test(q)) return 'counterexample';
  return null;
}

module.exports = {
  normalize,
  cjkBigrams,
  quoteTerm,
  buildMatch,
  buildCjkMatch,
  classify,
  hasCjk,
  STOPWORDS,
};
