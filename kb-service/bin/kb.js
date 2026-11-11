#!/usr/bin/env node
// KB service CLI.
//
//   kb serve                          start the HTTP service
//   kb build --corpus <dir> [--kb math] [--incremental]
//   kb search <query> [--kb math] [-k 6] [--kind theorem]
//   kb stats [--kb math]
//   kb notes list [--kb math] [--status draft]
//   kb notes add --title <t> --kind insight --content <text> [--kb math]
//   kb notes verify <slug> | deprecate <slug> | rm <slug>
//   kb notes reindex
//
// All commands operate on $KB_ROOT (default ./kb-data).

'use strict';

const path = require('path');
const fs = require('fs');

const config = require('../src/config');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next == null || next.startsWith('-')) out[key] = true;
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function kbName(args) {
  return args.kb || 'math';
}

function kbDir(cfg, args) {
  return path.join(cfg.root, kbName(args));
}

function requireIndex(cfg, args) {
  const dir = kbDir(cfg, args);
  if (!fs.existsSync(path.join(dir, 'index.sqlite'))) {
    console.error(`no index at ${dir} — run: kb build --corpus <dir> --kb ${kbName(args)}`);
    process.exit(1);
  }
  return dir;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));
  const cfg = config.load();

  if (!cmd || cmd === 'help' || args.help) return usage();

  if (cmd === 'serve') {
    require('../src/server').start();
    return;
  }

  if (cmd === 'build') {
    const corpus = args.corpus;
    if (!corpus || !fs.existsSync(corpus)) {
      console.error('--corpus <dir> is required and must exist');
      process.exit(1);
    }
    const dir = kbDir(cfg, args);
    const builder = require('../src/builder');
    const notesMod = require('../src/notes');
    const db = require('../src/db');
    const t0 = Date.now();
    console.log(`[kb] building ${kbName(args)} from ${corpus} → ${dir}`);
    const out = builder.build({
      corpusRoot: path.resolve(corpus),
      kbDir: dir,
      incremental: !!args.incremental,
      onProgress: (p) => {
        if (p.done % 100 === 0) console.log(`  ${p.done}/${p.total} papers, ${p.stats.chunks} chunks`);
      },
    });
    // Re-ingest Markdown notes into the fresh index.
    const w = db.openDb(dir, { readOnly: false });
    const reindexed = notesMod.reindexAll(dir, w);
    notesMod.rebuildIndexFile(dir, w);
    const stats = require('../src/retriever').stats(w);
    w.close();
    const manifest = {
      name: kbName(args),
      corpus: path.resolve(corpus),
      builtAt: new Date().toISOString(),
      ...out,
      notes: reindexed.indexed,
      stats,
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`[kb] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  papers=${stats.papers} chunks=${stats.chunks} notes=${stats.notes}`);
    if (out.failed.length) {
      console.log(`  ${out.failed.length} paper(s) skipped:`);
      for (const f of out.failed.slice(0, 10)) console.log(`    - ${f.slug}: ${f.error}`);
    }
    return;
  }

  if (cmd === 'search') {
    const query = args._.join(' ');
    if (!query) { console.error('usage: kb search <query>'); process.exit(1); }
    const dir = requireIndex(cfg, args);
    const db = require('../src/db').openDb(dir, { readOnly: true });
    const ret = require('../src/retriever');
    const out = await ret.search(db, query, {
      k: parseInt(args.k, 10) || 6,
      kinds: args.kind ? String(args.kind).split(',') : undefined,
      source: args.source,
    });
    console.log(`${out.count} result(s) for "${query}"${out.vector ? ' (hybrid)' : ''}\n`);
    for (const r of out.results) {
      console.log(`${r.citation}  [${r.kind}]`);
      console.log('  ' + r.snippet.replace(/\n+/g, ' ').slice(0, 300));
      console.log('');
    }
    db.close();
    return;
  }

  if (cmd === 'stats') {
    const dir = requireIndex(cfg, args);
    const db = require('../src/db').openDb(dir, { readOnly: true });
    console.log(JSON.stringify(require('../src/retriever').stats(db), null, 2));
    db.close();
    return;
  }

  if (cmd === 'notes') {
    const sub = args._[0] || 'list';
    const dir = kbDir(cfg, args);
    const notes = require('../src/notes');
    const db = require('../src/db');

    if (sub === 'list') {
      requireIndex(cfg, args);
      const conn = db.openDb(dir, { readOnly: true });
      const rows = notes.listNotes(conn, {
        kind: args.kind, status: args.status,
        limit: parseInt(args.limit, 10) || 100,
      });
      if (!rows.length) console.log('(no notes)');
      for (const r of rows) {
        console.log(`${r.slug}  [${r.kind}/${r.status}]  ${r.title}  (hits=${r.hits})`);
      }
      conn.close();
      return;
    }

    if (sub === 'add') {
      const conn = db.openDb(dir, { readOnly: false });
      const body = args.content || (args.file ? fs.readFileSync(args.file, 'utf8') : '');
      const out = notes.remember(dir, conn, {
        title: args.title,
        kind: args.kind || 'insight',
        content: body,
        tags: args.tags ? String(args.tags).split(',') : [],
        source: { session: args.session || 'cli' },
      });
      notes.rebuildIndexFile(dir, conn);
      conn.close();
      console.log(`${out.created ? 'created' : 'merged'} ${out.kind}/${out.slug}.md`);
      return;
    }

    if (sub === 'verify' || sub === 'deprecate') {
      const slug = args._[1];
      if (!slug) { console.error(`usage: kb notes ${sub} <slug>`); process.exit(1); }
      const conn = db.openDb(dir, { readOnly: false });
      const out = notes.setStatus(dir, conn, slug, sub === 'verify' ? 'verified' : 'deprecated');
      conn.close();
      console.log(`${out.slug} → ${out.status}`);
      return;
    }

    if (sub === 'rm') {
      const slug = args._[1];
      if (!slug) { console.error('usage: kb notes rm <slug>'); process.exit(1); }
      const conn = db.openDb(dir, { readOnly: false });
      notes.removeNote(dir, conn, slug);
      notes.rebuildIndexFile(dir, conn);
      conn.close();
      console.log(`removed ${slug}`);
      return;
    }

    if (sub === 'reindex') {
      const conn = db.openDb(dir, { readOnly: false });
      const out = notes.reindexAll(dir, conn);
      notes.rebuildIndexFile(dir, conn);
      conn.close();
      console.log(`reindexed ${out.indexed}/${out.total} note(s)`);
      return;
    }

    console.error(`unknown notes subcommand: ${sub}`);
    process.exit(1);
  }

  console.error(`unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

function usage() {
  console.log(`myco-kb — domain knowledge base service

  kb serve                                   start the HTTP API
  kb build --corpus <dir> [--kb math] [--incremental]
  kb search <query> [--kb math] [-k 6] [--kind theorem] [--source local]
  kb stats [--kb math]
  kb notes list [--kind insight] [--status draft]
  kb notes add --title <t> --kind insight --content <text> [--tags a,b]
  kb notes verify|deprecate|rm <slug>
  kb notes reindex

Environment:
  KB_ROOT     knowledge base directory (default ./kb-data)
  KB_PORT     HTTP port (default 7317)
  KB_TOKEN    bearer token required on every non-health request
  KB_EMBED_URL  optional OpenAI-compatible embeddings endpoint
`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
