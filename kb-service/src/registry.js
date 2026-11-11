// Knowledge-base registry.
//
// A "knowledge base" is a directory under KB_ROOT containing:
//   index.sqlite   — the searchable index (derived)
//   notes/         — Markdown knowledge items (authoritative)
//   manifest.json  — build provenance (corpus root, counts, timestamps)
//
// The registry owns the open read connections and hands them out to the
// HTTP layer. Connections are reopened when the index file is replaced by
// a rebuild (detected by inode + mtime), so a running service picks up a
// new index without a restart.

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

class Registry {
  constructor(root) {
    this.root = root;
    this._conns = new Map();   // name -> { db, ino, mtimeMs }
    fs.mkdirSync(root, { recursive: true });
  }

  assertName(name) {
    const n = String(name || '');
    if (!NAME_RE.test(n)) throw err('ERR_BAD_INPUT', `invalid knowledge base name: ${JSON.stringify(name)}`);
    return n;
  }

  dir(name) {
    return path.join(this.root, this.assertName(name));
  }

  exists(name) {
    try {
      return fs.existsSync(path.join(this.dir(name), 'index.sqlite'));
    } catch {
      return false;
    }
  }

  // List every KB directory with its manifest (if any).
  list() {
    let entries;
    try { entries = fs.readdirSync(this.root, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
      const dir = path.join(this.root, e.name);
      const indexPath = path.join(dir, 'index.sqlite');
      if (!fs.existsSync(indexPath)) continue;
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { /* none */ }
      let size = 0;
      try { size = fs.statSync(indexPath).size; } catch { /* none */ }
      out.push({
        name: e.name,
        indexBytes: size,
        notes: countNotes(dir),
        ...manifest,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Open (or reuse) a read-only connection, reopening if the file changed.
  conn(name) {
    const n = this.assertName(name);
    const file = path.join(this.dir(n), 'index.sqlite');
    let st;
    try { st = fs.statSync(file); } catch {
      throw err('ERR_NOT_FOUND', `knowledge base not found: ${n}`);
    }
    const cur = this._conns.get(n);
    if (cur && cur.ino === st.ino && cur.mtimeMs === st.mtimeMs) return cur.db;
    if (cur) { try { cur.db.close(); } catch { /* ignore */ } }
    const conn = db.openDb(this.dir(n), { readOnly: true });
    this._conns.set(n, { db: conn, ino: st.ino, mtimeMs: st.mtimeMs });
    return conn;
  }

  // Open a read-write connection for note writes. Not cached: writes are
  // infrequent and a long-lived writer would block index swaps.
  writeConn(name) {
    const n = this.assertName(name);
    const file = path.join(this.dir(n), 'index.sqlite');
    if (!fs.existsSync(file)) throw err('ERR_NOT_FOUND', `knowledge base not found: ${n}`);
    const conn = db.openDb(this.dir(n), { readOnly: false });
    const cached = this._conns.get(n);
    if (cached) { try { cached.db.close(); } catch { /* ignore */ } this._conns.delete(n); }
    return conn;
  }

  // Drop a cached connection (after a rebuild replaces the file).
  invalidate(name) {
    const n = String(name || '');
    const cur = this._conns.get(n);
    if (cur) { try { cur.db.close(); } catch { /* ignore */ } this._conns.delete(n); }
  }

  closeAll() {
    for (const { db: conn } of this._conns.values()) {
      try { conn.close(); } catch { /* ignore */ }
    }
    this._conns.clear();
  }
}

function countNotes(dir) {
  let n = 0;
  const root = path.join(dir, 'notes');
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.md') && !['README.md', 'index.md'].includes(e.name)) n++;
    }
  };
  walk(root);
  return n;
}

module.exports = { Registry, NAME_RE, err };
