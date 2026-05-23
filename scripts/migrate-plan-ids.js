#!/usr/bin/env node
// One-shot migration: rewrite plan items' hex ids → prefixed counters
// (fr-N / td-N / bug-N).
//
// Slashcmds.addPlanItem switched to prefixed ids in 2026-05-15 commit
// ca9bcf1, but only for NEW items. Existing items kept their 12-char
// hex ids (e.g. "a3b4c5d6e7f8"). The mixed state is ugly in the plan
// tab and means `/merge` on an old item requires typing the hex
// verbatim. This script does a one-pass rewrite, per session:
//
//   - For each session record in $MYCO_STATE_DIR/sessions.json:
//     - For each layer (Feature/Todo/Bug):
//       - Items already matching <prefix>-N keep their id (idempotent
//         re-run — no churn). Their N participates in the counter.
//       - Hex-id items get reassigned <prefix>-K in addedAt order
//         starting from max(existing N) + 1.
//     - Mirror the rewritten artifact to <absCwd>/_myco_/plan.json
//       (same path the live server uses).
//
// Usage (run from repo root):
//   ./scripts/migrate-plan-ids.js                     # default state dir = /data
//   MYCO_STATE_DIR=/path/to/state ./scripts/migrate-plan-ids.js
//   ./scripts/migrate-plan-ids.js --dry-run           # report only, no writes
//   ./scripts/migrate-plan-ids.js --session <id>      # limit to one session
//
// Run on each host that has a state dir (locally + mycobeta).

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.MYCO_STATE_DIR || '/data';
const PREFIX = { Feature: 'fr', Todo: 'td', Bug: 'bug' };

// ── arg parse ────────────────────────────────────────────────────────────────
let dryRun = false;
let onlySession = null;
const argv = process.argv.slice(2);
while (argv.length) {
  const a = argv.shift();
  if (a === '--dry-run') dryRun = true;
  else if (a === '--session') onlySession = argv.shift();
  else if (a === '-h' || a === '--help') {
    process.stdout.write(`Usage: ./scripts/migrate-plan-ids.js [--dry-run] [--session <id>]\n\n`);
    process.stdout.write(`Default state dir: $MYCO_STATE_DIR or /data\n`);
    process.exit(0);
  }
  else { process.stderr.write(`unknown arg: ${a}\n`); process.exit(2); }
}

const sessionsPath = path.join(STATE_DIR, 'sessions.json');
if (!fs.existsSync(sessionsPath)) {
  process.stderr.write(`[migrate] no sessions.json at ${sessionsPath}\n`);
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function isPrefixedId(id, prefix) {
  return typeof id === 'string' && new RegExp('^' + prefix + '-(\\d+)$').test(id);
}

// Plan one session's migration without mutating yet. Returns:
//   { rewrites: [{ oldId, newId, layer }], maxByLayer, willChange }
function planSessionMigration(items) {
  const rewrites = [];
  if (!Array.isArray(items) || !items.length) return { rewrites, willChange: false };
  // Sort a stable copy by addedAt — falls back to original index when
  // addedAt is missing or equal so the migration is deterministic.
  const indexed = items.map((it, i) => ({ it, i }));
  indexed.sort((a, b) => {
    const ta = (a.it && a.it.addedAt) || '';
    const tb = (b.it && b.it.addedAt) || '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return a.i - b.i;
  });
  // Per-layer counter starts at max(existing prefixed N) so already-
  // migrated items stay put.
  const counters = {};
  for (const layer of Object.keys(PREFIX)) {
    const prefix = PREFIX[layer];
    let maxN = 0;
    for (const it of items) {
      if (!it || !it.id || it.layer !== layer) continue;
      const m = String(it.id).match(new RegExp('^' + prefix + '-(\\d+)$'));
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
    counters[layer] = maxN;
  }
  // Walk in addedAt order; assign new ids only to hex-shaped items.
  for (const { it } of indexed) {
    if (!it || !it.id) continue;
    const prefix = PREFIX[it.layer];
    if (!prefix) continue;                          // skip unknown layer
    if (isPrefixedId(it.id, prefix)) continue;      // already migrated
    const newId = `${prefix}-${++counters[it.layer]}`;
    rewrites.push({ oldId: it.id, newId, layer: it.layer });
    it.id = newId;
  }
  return { rewrites, willChange: rewrites.length > 0 };
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const raw = fs.readFileSync(sessionsPath, 'utf8');
  let store;
  try { store = JSON.parse(raw); }
  catch (err) { process.stderr.write(`[migrate] sessions.json parse failed: ${err.message}\n`); process.exit(1); }
  if (!store || !store.sessions || typeof store.sessions !== 'object') {
    process.stdout.write('[migrate] sessions.json has no sessions object — nothing to do\n');
    return;
  }
  const sids = Object.keys(store.sessions);
  let touched = 0;
  let totalRewrites = 0;
  for (const sid of sids) {
    if (onlySession && sid !== onlySession) continue;
    const rec = store.sessions[sid];
    const items = rec && rec.artifacts && rec.artifacts.plan && rec.artifacts.plan.items;
    if (!Array.isArray(items) || !items.length) continue;
    const plan = planSessionMigration(items);
    if (!plan.willChange) continue;
    touched++;
    totalRewrites += plan.rewrites.length;
    process.stdout.write(`[migrate] session ${sid} — ${plan.rewrites.length} rewrite${plan.rewrites.length === 1 ? '' : 's'}:\n`);
    for (const r of plan.rewrites) {
      process.stdout.write(`    ${r.layer.padEnd(7)}  ${r.oldId}  →  ${r.newId}\n`);
    }
    // Update updatedAt so the plan tab re-reads — but only when we're
    // actually writing. Dry-run leaves the in-memory copy dirty (we
    // don't flush) so this is purely informational.
    rec.artifacts.plan.updatedAt = new Date().toISOString();
    // Mirror to <absCwd>/_myco_/plan.json (live server reads this
    // first, so the on-disk file MUST agree with sessions.json).
    if (!dryRun && rec.absCwd) {
      const planJsonPath = path.join(rec.absCwd, '_myco_', 'plan.json');
      try {
        fs.mkdirSync(path.dirname(planJsonPath), { recursive: true });
        fs.writeFileSync(planJsonPath, JSON.stringify(rec.artifacts.plan, null, 2));
      } catch (err) {
        process.stderr.write(`[migrate]   _myco_/plan.json write failed for ${sid}: ${err.message}\n`);
      }
    }
  }
  if (!touched) {
    process.stdout.write('[migrate] no sessions needed migration — already on prefixed ids.\n');
    return;
  }
  if (dryRun) {
    process.stdout.write(`\n[migrate] DRY RUN — would rewrite ${totalRewrites} id${totalRewrites === 1 ? '' : 's'} across ${touched} session${touched === 1 ? '' : 's'}. Re-run without --dry-run to apply.\n`);
    return;
  }
  // Persist sessions.json. Pretty-print to match the live server's
  // existing layout (loadStore/saveStore uses 2-space indent).
  fs.writeFileSync(sessionsPath, JSON.stringify(store, null, 2));
  process.stdout.write(`\n[migrate] wrote ${totalRewrites} id${totalRewrites === 1 ? '' : 's'} across ${touched} session${touched === 1 ? '' : 's'} → ${sessionsPath}\n`);
  process.stdout.write('[migrate] live server picks up the change on its next loadStore() call (every read goes through it).\n');
}

main();
