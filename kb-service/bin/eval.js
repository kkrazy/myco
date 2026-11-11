#!/usr/bin/env node
// Retrieval quality evaluation.
//
// Builds a query set from the corpus itself: take each paper's abstract,
// derive a keyword query from it, and check whether the paper it came from
// appears in the top-k. That is a proxy for "can the KB find the right
// paper from a description of the result".
//
//   node bin/eval.js --kb math [--n 120] [--k 5]
//
// Also evaluates a hand-written golden set when one exists at
// <kb>/golden.jsonl (one {"query": "...", "expect": "<paper-slug>"} per line).

'use strict';

const path = require('path');
const fs = require('fs');

const config = require('../src/config');
const db = require('../src/db');
const retriever = require('../src/retriever');
const q = require('../src/query');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// Derive a keyword query from an abstract: drop stopwords, keep the first
// few content words. This mirrors how a researcher would search.
function queryFromAbstract(abstract) {
  const norm = q.normalize(abstract);
  return norm.terms.slice(0, 8).join(' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = config.load();
  const kb = args.kb || 'math';
  const dir = path.join(cfg.root, kb);
  const limit = parseInt(args.n, 10) || 120;
  const k = parseInt(args.k, 10) || 5;

  if (!fs.existsSync(path.join(dir, 'index.sqlite'))) {
    console.error(`no index at ${dir}`);
    process.exit(1);
  }
  const conn = db.openDb(dir, { readOnly: true });

  // ── abstract-derived set ──
  const papers = conn.prepare(`
    SELECT id, slug, abstract FROM papers
    WHERE is_latest = 1 AND length(abstract) > 120
    ORDER BY id`).all();
  const step = Math.max(1, Math.floor(papers.length / limit));
  const sample = papers.filter((_, i) => i % step === 0).slice(0, limit);

  let hitK = 0, hit10 = 0, mrr = 0;
  const latencies = [];
  const misses = [];

  for (const p of sample) {
    const query = queryFromAbstract(p.abstract);
    if (!query) continue;
    const t0 = process.hrtime.bigint();
    const out = await retriever.search(conn, query, { k: Math.max(k, 10) });
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const rank = out.results.findIndex((r) => r.paperSlug === p.slug) + 1;
    if (rank && rank <= k) hitK++;
    if (rank && rank <= 10) hit10++;
    if (rank) mrr += 1 / rank;
    else if (misses.length < 5) misses.push({ slug: p.slug, query });
  }

  const n = sample.length || 1;
  latencies.sort((a, b) => a - b);
  const report = {
    kb,
    n: sample.length,
    k,
    recall_at_k: +(hitK / n).toFixed(3),
    recall_at_10: +(hit10 / n).toFixed(3),
    mrr: +(mrr / n).toFixed(3),
    latency_p50_ms: +(latencies[Math.floor(latencies.length / 2)] || 0).toFixed(2),
    latency_p95_ms: +(latencies[Math.floor(latencies.length * 0.95)] || 0).toFixed(2),
  };

  // ── hand-written golden set (optional) ──
  const goldenFile = path.join(dir, 'golden.jsonl');
  if (fs.existsSync(goldenFile)) {
    const rows = fs.readFileSync(goldenFile, 'utf8').split('\n').filter(Boolean);
    let ok = 0;
    const failures = [];
    for (const line of rows) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const out = await retriever.search(conn, item.query, { k });
      const found = out.results.some((r) => r.paperSlug === item.expect || r.noteSlug === item.expect);
      if (found) ok++;
      else failures.push(item);
    }
    report.golden = { n: rows.length, pass: ok, failures: failures.slice(0, 5) };
  }

  if (misses.length) report.sample_misses = misses;
  console.log(JSON.stringify(report, null, 2));
  conn.close();
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
