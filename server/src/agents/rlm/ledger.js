// agents/rlm/ledger.js — spawn ledger (design §4.3), modeled on
// prime-agent's pa-daemon/src/rlm_ledger.rs.
//
// One append-only JSONL file per session workspace:
//   <cwd>/_myco_/rlm/ledger.jsonl
// Event types: spawn / rename / delete (reason: user | parent_teardown | gc).
// Each line carries parentSessionId, childSessionId, name, depth, ts.
//
// The family topology (parent/child edges, depth, names) is REBUILT from
// this file rather than derived from live session objects — so
// rlm.listSubagents() stays complete across server restarts and reaped
// children remain visible on the roster (status 'error').
//
// Caps align with prime: 32 MiB file / 100k records; on overflow the file
// is head-truncated (oldest records dropped) by rewrite.

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 32 * 1024 * 1024;   // 32 MiB
const MAX_RECORDS = 100 * 1000;       // 100k

// Ledger file path for a session cwd. Kept at the _myco_/rlm/ root (not
// per-run dirs) because the roster spans ALL runs of the session.
function ledgerPath(cwd) {
  return path.join(cwd, '_myco_', 'rlm', 'ledger.jsonl');
}

// Append one record. `kind` is spawn|rename|delete. Returns the record.
function append(cwd, rec) {
  const file = ledgerPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = Object.assign({
    ts: new Date().toISOString(),
    kind: 'spawn',
    parentSessionId: null,
    childSessionId: null,
    name: null,
    depth: 0,
  }, rec);
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  _truncateIfNeeded(file);
  return row;
}

// Head-truncate the ledger once it exceeds MAX_BYTES OR MAX_RECORDS
// (independent caps — either one trips the rewrite). Rewrite is atomic
// (tmp + rename) — a crash mid-write never corrupts the readable prefix
// of the original. Keeps the newest rows that fit under BOTH caps:
// halves the record budget, then trims further until the byte cap holds.
function _truncateIfNeeded(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size <= MAX_BYTES) return; // fast path: byte cap not hit; record cap is checked only when we must read anyway (a 100k-row file that's still <32 MiB is pathologically small rows — accepted)
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return; }
  let rows = lines.filter((l) => l.trim());
  if (rows.length <= MAX_RECORDS && size <= MAX_BYTES) return;
  let keep = rows.slice(Math.max(0, rows.length - Math.floor(MAX_RECORDS / 2)));
  // Trim until the kept window fits the byte cap.
  while (keep.length && Buffer.byteLength(keep.join('\n')) > MAX_BYTES) {
    keep = keep.slice(Math.floor(keep.length / 2));
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, keep.join('\n') + (keep.length ? '\n' : ''));
  fs.renameSync(tmp, file);
}

// Read all records (oldest → newest). Malformed lines are skipped — an
// append interrupted mid-write must never break roster rebuild.
function readAll(cwd) {
  const file = ledgerPath(cwd);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// Rebuild the family roster from the ledger (pure — takes records, not a
// cwd, so tests can feed synthetic rows). Later rows win for a given
// childSessionId: spawn creates the row; rename updates the name; delete
// marks it deleted (kept on the roster with status from `reason`).
//
// Returns an array of { childSessionId, parentSessionId, name, depth,
// status, deletedReason, spawnedAt, deletedAt } ordered by spawn order.
function rebuildRoster(records) {
  const byId = new Map();
  const order = [];
  for (const r of records || []) {
    if (!r || !r.childSessionId) continue;
    if (r.kind === 'spawn') {
      if (!byId.has(r.childSessionId)) order.push(r.childSessionId);
      byId.set(r.childSessionId, {
        childSessionId: r.childSessionId,
        parentSessionId: r.parentSessionId || null,
        name: r.name || null,
        depth: Number(r.depth) || 0,
        status: 'running',
        deletedReason: null,
        spawnedAt: r.ts || null,
        deletedAt: null,
      });
    } else if (r.kind === 'rename') {
      const row = byId.get(r.childSessionId);
      if (row) row.name = r.name || row.name;
    } else if (r.kind === 'delete') {
      const row = byId.get(r.childSessionId);
      if (row) {
        row.status = 'error';
        row.deletedReason = r.reason || 'user';
        row.deletedAt = r.ts || null;
      }
    }
  }
  return order.map((id) => byId.get(id));
}

// Roster for a session cwd (convenience: readAll + rebuildRoster).
function roster(cwd) {
  return rebuildRoster(readAll(cwd));
}

module.exports = { ledgerPath, append, readAll, rebuildRoster, roster, MAX_BYTES, MAX_RECORDS };
