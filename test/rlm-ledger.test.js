// RLM hard implementation — spawn ledger (agents/rlm/ledger.js).
// myco-rlm-design.md §4.3 / §7: the family topology is REBUILT from the
// append-only ledger, not derived from live sessions — so the roster
// survives server restarts and reaped children stay visible. Pure
// functions: rebuildRoster takes records, append/readAll use a tmp cwd.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('../server/src/agents/rlm/ledger');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-ledger-'));
}

console.log('── RLM hard impl: spawn ledger ──');

t('append writes JSONL rows under <cwd>/_myco_/rlm/ledger.jsonl', () => {
  const cwd = tmpCwd();
  const rec = ledger.append(cwd, { kind: 'spawn', parentSessionId: 'p1', childSessionId: 'c1', name: 'finder', depth: 1 });
  const file = ledger.ledgerPath(cwd);
  assert.ok(fs.existsSync(file), 'ledger file must exist after append');
  assert.strictEqual(path.basename(file), 'ledger.jsonl', 'file name');
  assert.ok(file.includes(path.join('_myco_', 'rlm')), 'file lives under _myco_/rlm/');
  const line = fs.readFileSync(file, 'utf8').trim();
  const row = JSON.parse(line);
  assert.strictEqual(row.childSessionId, 'c1', 'row carries childSessionId');
  assert.strictEqual(row.kind, 'spawn', 'row kind');
  assert.ok(row.ts, 'row auto-stamps ts');
  assert.strictEqual(rec.childSessionId, 'c1', 'append returns the record');
});

t('readAll tolerates a torn (partial JSON) line — never breaks roster rebuild', () => {
  const cwd = tmpCwd();
  ledger.append(cwd, { kind: 'spawn', childSessionId: 'c1', name: 'a', depth: 1 });
  const file = ledger.ledgerPath(cwd);
  fs.appendFileSync(file, '{"kind":"spawn","childSessionId":"c2","na'); // torn tail
  const rows = ledger.readAll(cwd);
  assert.strictEqual(rows.length, 1, 'only the intact record is read (torn line skipped)');
  assert.strictEqual(rows[0].childSessionId, 'c1');
});

t('rebuildRoster: spawn → rename → delete lifecycle on one child', () => {
  const rows = [
    { kind: 'spawn', childSessionId: 'c1', parentSessionId: 'p1', name: 'finder', depth: 1, ts: 't1' },
    { kind: 'rename', childSessionId: 'c1', name: 'grepper', ts: 't2' },
    { kind: 'delete', childSessionId: 'c1', reason: 'user', ts: 't3' },
  ];
  const roster = ledger.rebuildRoster(rows);
  assert.strictEqual(roster.length, 1, 'one child row');
  const c = roster[0];
  assert.strictEqual(c.name, 'grepper', 'rename updates the name');
  assert.strictEqual(c.status, 'error', 'delete marks the child error (visible on roster)');
  assert.strictEqual(c.deletedReason, 'user', 'delete reason carried');
  assert.strictEqual(c.spawnedAt, 't1', 'spawn ts preserved');
  assert.strictEqual(c.deletedAt, 't3', 'delete ts recorded');
});

t('rebuildRoster: multi-child family with depths, spawn order preserved', () => {
  const rows = [
    { kind: 'spawn', childSessionId: 'c1', parentSessionId: 'p1', name: 'a', depth: 1, ts: 't1' },
    { kind: 'spawn', childSessionId: 'c2', parentSessionId: 'c1', name: 'b', depth: 2, ts: 't2' },
    { kind: 'spawn', childSessionId: 'c3', parentSessionId: 'p1', name: 'd', depth: 1, ts: 't3' },
  ];
  const roster = ledger.rebuildRoster(rows);
  assert.deepStrictEqual(roster.map((r) => r.childSessionId), ['c1', 'c2', 'c3'],
    'roster order = spawn order');
  assert.strictEqual(roster[1].parentSessionId, 'c1', 'parent edge (child of child)');
  assert.strictEqual(roster[1].depth, 2, 'depth carried through');
  assert.ok(roster.every((r) => r.status === 'running'), 'no deletes → all running');
});

t('rebuildRoster: unknown kinds + malformed rows are ignored', () => {
  const roster = ledger.rebuildRoster([
    null,
    { kind: 'weird', childSessionId: 'x' },
    'not-an-object',
    { kind: 'spawn', childSessionId: 'c1', name: 'ok', depth: 1 },
  ]);
  assert.strictEqual(roster.length, 1, 'only the valid spawn survives');
  assert.strictEqual(roster[0].childSessionId, 'c1');
});

t('roster(cwd) = readAll + rebuildRoster convenience', () => {
  const cwd = tmpCwd();
  ledger.append(cwd, { kind: 'spawn', childSessionId: 'c1', name: 'a', depth: 1 });
  const roster = ledger.roster(cwd);
  assert.strictEqual(roster.length, 1);
  assert.strictEqual(roster[0].name, 'a');
});

t('caps: MAX_BYTES 32 MiB / MAX_RECORDS 100k align with prime ledger', () => {
  assert.strictEqual(ledger.MAX_BYTES, 32 * 1024 * 1024, '32 MiB cap (prime parity)');
  assert.strictEqual(ledger.MAX_RECORDS, 100000, '100k record cap (prime parity)');
});

t('head-truncate: oversized ledger keeps only the newest half of records', () => {
  const cwd = tmpCwd();
  const file = ledger.ledgerPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write past MAX_BYTES with cheap rows.
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    rows.push(JSON.stringify({ kind: 'spawn', childSessionId: 'c' + i, name: 'n'.repeat(8000), depth: 1, ts: 't' + i }));
  }
  fs.writeFileSync(file, rows.join('\n') + '\n');
  const sizeBefore = fs.statSync(file).size;
  assert.ok(sizeBefore > ledger.MAX_BYTES, `pre: file exceeds 32 MiB (got ${sizeBefore})`);
  ledger.append(cwd, { kind: 'spawn', childSessionId: 'newest', name: 'z', depth: 1 });
  const sizeAfter = fs.statSync(file).size;
  assert.ok(sizeAfter < sizeBefore, 'post: file shrank (head truncated)');
  const after = ledger.readAll(cwd);
  assert.ok(after.length < 5001, 'records were dropped from the head');
  assert.strictEqual(after[after.length - 1].childSessionId, 'newest', 'newest record survives');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
