// fr-49: /whatsnext + /next priority list.
//
// User report: "No surfaced queue of 'what to implement next' —
// priorities have to be re-derived manually each session."
// "the list should be persisted in plan.json and displayed via
// /whatsnext command in the chat pane, suggest a better shortcut."
//
// Phase A (this fix):
//   * server/src/whatsnext.js — heuristic scoring + LLM rerank +
//     2h-TTL cache in plan.whatsNext
//   * /whatsnext slash command + /next short alias
//   * Read-only — guests can call it (mirrors /qstatus); added to the
//     GUEST_ALLOWED_CMDS sets in both attach.js (server) and app.js
//     (client send-button gate) so the mirror contract holds
//
// Tests are mostly pure-function checks on the heuristic + parser; the
// LLM rerank itself is mocked or skipped (we'd need a real API key to
// hit runClaudeP, and the LLM rerank is best-effort by design — falls
// back to the heuristic on any failure, which the heuristic tests
// already cover).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── fr-49: /whatsnext priority list ──');

const whatsnext = require('../server/src/whatsnext');
const SLASH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

// ──────────────────────────────────────────────────────────────────────
// Heuristic scoring
// ──────────────────────────────────────────────────────────────────────

t('done items are excluded from the shortlist', () => {
  const items = [
    { id: 'bug-1', layer: 'Bug', done: true, voters: ['a', 'b', 'c'] },
    { id: 'bug-2', layer: 'Bug', done: false, voters: ['a'] },
  ];
  const out = whatsnext.computeHeuristicShortlist(items, []);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'bug-2');
});

t('items currently in the run-queue are excluded (no double-work)', () => {
  const items = [
    { id: 'bug-1', layer: 'Bug', done: false, voters: ['a'] },
    { id: 'fr-1', layer: 'Feature', done: false, voters: ['a', 'b'] },
  ];
  const runQueue = [
    { itemId: 'bug-1', status: 'running' },
    { itemId: 'fr-1', status: 'pending' },
    { itemId: 'old', status: 'success' },                    // success NOT excluded
  ];
  const out = whatsnext.computeHeuristicShortlist(items, runQueue);
  assert.strictEqual(out.length, 0, 'both items were queued — nothing left to suggest');
});

t('Bug layer outranks Feature outranks Todo when other factors are equal', () => {
  const now = Date.parse('2026-05-21T00:00:00Z');
  const items = [
    { id: 'td-x', layer: 'Todo',    done: false, voters: ['a'], addedAt: '2026-05-15T00:00:00Z' },
    { id: 'bug-x', layer: 'Bug',    done: false, voters: ['a'], addedAt: '2026-05-15T00:00:00Z' },
    { id: 'fr-x', layer: 'Feature', done: false, voters: ['a'], addedAt: '2026-05-15T00:00:00Z' },
  ];
  const out = whatsnext.computeHeuristicShortlist(items, [], { now });
  assert.deepStrictEqual(out.map((s) => s.id), ['bug-x', 'fr-x', 'td-x']);
});

t('more voters → higher score (voter weight beats layer bias at scale)', () => {
  const now = Date.parse('2026-05-21T00:00:00Z');
  const items = [
    // Bug with 0 voters vs Todo with 5 voters — the voter heap wins.
    { id: 'bug-q', layer: 'Bug',  done: false, voters: [], addedAt: '2026-05-15T00:00:00Z' },
    { id: 'td-p', layer: 'Todo', done: false, voters: ['a', 'b', 'c', 'd', 'e'], addedAt: '2026-05-15T00:00:00Z' },
  ];
  const out = whatsnext.computeHeuristicShortlist(items, [], { now });
  assert.strictEqual(out[0].id, 'td-p', '5 voters beats 0-voter Bug');
});

t('comments score is capped (chatty items don\'t dominate forever)', () => {
  const now = Date.parse('2026-05-21T00:00:00Z');
  const mkComments = (n) => Array.from({ length: n }, (_, i) => ({ id: 'c' + i, user: 'u', text: 'comment ' + i }));
  // 5-comment cap: 5 comments and 50 comments must score identically on the comment axis.
  const items = [
    { id: 'a', layer: 'Bug', done: false, voters: [], addedAt: '2026-05-15T00:00:00Z', comments: mkComments(5) },
    { id: 'b', layer: 'Bug', done: false, voters: [], addedAt: '2026-05-15T00:00:00Z', comments: mkComments(50) },
  ];
  const out = whatsnext.computeHeuristicShortlist(items, [], { now });
  assert.strictEqual(out[0].score, out[1].score, 'comment cap means 5 and 50 score the same');
});

t('recent items (<7d) get a recency boost', () => {
  const now = Date.parse('2026-05-21T00:00:00Z');
  const items = [
    { id: 'fresh', layer: 'Feature', done: false, voters: ['a'], addedAt: '2026-05-20T00:00:00Z' },
    { id: 'older', layer: 'Feature', done: false, voters: ['a'], addedAt: '2026-04-15T00:00:00Z' },
  ];
  const out = whatsnext.computeHeuristicShortlist(items, [], { now });
  assert.strictEqual(out[0].id, 'fresh', 'fresh item ranks above older one with same vote/layer');
});

t('stale items (>90d) get a penalty', () => {
  const now = Date.parse('2026-05-21T00:00:00Z');
  const items = [
    { id: 'stale', layer: 'Feature', done: false, voters: ['a'], addedAt: '2026-01-01T00:00:00Z' },
    { id: 'mid',   layer: 'Feature', done: false, voters: ['a'], addedAt: '2026-03-15T00:00:00Z' },
  ];
  const out = whatsnext.computeHeuristicShortlist(items, [], { now });
  assert.strictEqual(out[0].id, 'mid', 'stale-penalty pushes the older item down');
});

t('last-run failed → item demoted', () => {
  const now = Date.parse('2026-05-21T00:00:00Z');
  const items = [
    { id: 'no-runs', layer: 'Bug', done: false, voters: ['a'], addedAt: '2026-05-15T00:00:00Z' },
    { id: 'failed-run', layer: 'Bug', done: false, voters: ['a'], addedAt: '2026-05-15T00:00:00Z',
      runs: [{ status: 'error', ts: '2026-05-20T00:00:00Z' }] },
  ];
  const out = whatsnext.computeHeuristicShortlist(items, [], { now });
  assert.strictEqual(out[0].id, 'no-runs', 'item with no prior run beats one whose last run errored');
});

t('shortlist respects the limit parameter', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    id: 'i-' + i, layer: 'Feature', done: false, voters: ['a'], addedAt: '2026-05-15T00:00:00Z',
  }));
  const out = whatsnext.computeHeuristicShortlist(items, [], { limit: 5 });
  assert.strictEqual(out.length, 5, 'limit honored');
});

t('scoreItem returns reasons[] so the user sees why an item ranked where it did', () => {
  const items = [{ id: 'x', layer: 'Bug', done: false, voters: ['a', 'b'], addedAt: '2026-05-20T00:00:00Z' }];
  const out = whatsnext.computeHeuristicShortlist(items, [], { now: Date.parse('2026-05-21T00:00:00Z') });
  assert.ok(Array.isArray(out[0].reasons) && out[0].reasons.length > 0,
    'reasons array is the heuristic\'s "why" — surfaced in the /whatsnext output');
  assert.ok(out[0].reasons.some((r) => /voter/i.test(r)), 'voter reason present');
  assert.ok(out[0].reasons.some((r) => /Bug/i.test(r)), 'layer reason present');
});

// ──────────────────────────────────────────────────────────────────────
// LLM rerank parser — defends against hallucinated ids
// ──────────────────────────────────────────────────────────────────────

t('parseLLMRerank: numbered list "1. id" form', () => {
  const out = whatsnext.parseLLMRerank('1. bug-1\n2. fr-2\n3. td-3', ['bug-1', 'fr-2', 'td-3']);
  assert.deepStrictEqual(out, ['bug-1', 'fr-2', 'td-3']);
});

t('parseLLMRerank: "1) id" + bare id forms also work', () => {
  const out = whatsnext.parseLLMRerank('1) bug-1\nfr-2\n- td-3', ['bug-1', 'fr-2', 'td-3']);
  assert.deepStrictEqual(out, ['bug-1', 'fr-2', 'td-3']);
});

t('parseLLMRerank: rejects ids the LLM hallucinated (not in candidate list)', () => {
  const out = whatsnext.parseLLMRerank('1. bug-1\n2. bug-99\n3. fr-2', ['bug-1', 'fr-2']);
  assert.deepStrictEqual(out, ['bug-1', 'fr-2'], 'bug-99 was not in the input — rejected');
});

t('parseLLMRerank: dedups repeated ids', () => {
  const out = whatsnext.parseLLMRerank('1. bug-1\n2. bug-1\n3. fr-2', ['bug-1', 'fr-2']);
  assert.deepStrictEqual(out, ['bug-1', 'fr-2']);
});

t('parseLLMRerank: tolerates surrounding chatter (model preamble/postamble)', () => {
  const reply = `Here is my ranked list:\n\n1. bug-1\n2. fr-2\n\nLet me know if you need adjustments.`;
  const out = whatsnext.parseLLMRerank(reply, ['bug-1', 'fr-2']);
  assert.deepStrictEqual(out, ['bug-1', 'fr-2']);
});

// ──────────────────────────────────────────────────────────────────────
// Cache TTL behavior
// ──────────────────────────────────────────────────────────────────────

ta('getCachedOrGenerate returns cached payload when < TTL', async () => {
  const cachedAt = new Date('2026-05-21T00:00:00Z').toISOString();
  const rec = {
    artifacts: { plan: {
      items: [{ id: 'bug-1', layer: 'Bug', done: false, voters: ['a'] }],
      whatsNext: { items: [{ id: 'cached', score: 99 }], generatedAt: cachedAt, llmReranked: true },
    }},
    runQueue: [],
  };
  // 1h after cachedAt — under the 2h TTL.
  const now = Date.parse('2026-05-21T01:00:00Z');
  const out = await whatsnext.getCachedOrGenerate(rec, '/tmp', { now });
  assert.strictEqual(out.items[0].id, 'cached', 'returned the cached payload, did not regenerate');
});

ta('getCachedOrGenerate regenerates when > TTL', async () => {
  const cachedAt = new Date('2026-05-21T00:00:00Z').toISOString();
  const rec = {
    artifacts: { plan: {
      items: [{ id: 'bug-1', layer: 'Bug', done: false, voters: ['a'] }],
      whatsNext: { items: [{ id: 'cached', score: 99 }], generatedAt: cachedAt, llmReranked: true },
    }},
    runQueue: [],
  };
  // 3h after cachedAt — past the 2h TTL. We pass a phony cwd so the
  // LLM call will fail/timeout, but the heuristic fallback fires.
  const now = Date.parse('2026-05-21T03:00:00Z');
  const out = await whatsnext.getCachedOrGenerate(rec, '/tmp/no-such-dir-fr49', { now });
  assert.notStrictEqual(out.items[0].id, 'cached', 'cache was stale — regenerated');
  assert.strictEqual(out.items[0].id, 'bug-1', 'heuristic placed bug-1 first');
});

ta('getCachedOrGenerate honors force=true even when cache is fresh', async () => {
  const cachedAt = new Date('2026-05-21T00:00:00Z').toISOString();
  const rec = {
    artifacts: { plan: {
      items: [{ id: 'bug-1', layer: 'Bug', done: false, voters: ['a'] }],
      whatsNext: { items: [{ id: 'cached', score: 99 }], generatedAt: cachedAt, llmReranked: true },
    }},
    runQueue: [],
  };
  const now = Date.parse('2026-05-21T00:30:00Z');   // 30 min — fresh
  const out = await whatsnext.getCachedOrGenerate(rec, '/tmp/no-such-dir-fr49', { now, force: true });
  assert.strictEqual(out.items[0].id, 'bug-1', 'force=true bypassed cache, regenerated from heuristic');
});

// ──────────────────────────────────────────────────────────────────────
// Slash command registration + guest whitelist mirror
// ──────────────────────────────────────────────────────────────────────

t('slashcmds.js registers /whatsnext and /next as aliases of the same handler', () => {
  // COMMANDS array entry with names: ['whatsnext', 'next']
  assert.ok(/names:\s*\[\s*['"]whatsnext['"]\s*,\s*['"]next['"]\s*\]/.test(SLASH),
    'COMMANDS must register both names so /whatsnext and /next resolve to the same handler');
  assert.ok(/handler:\s*handleWhatsNext/.test(SLASH),
    'handler must be handleWhatsNext');
});

t('handleWhatsNext function exists in slashcmds.js', () => {
  assert.ok(/async\s+function\s+handleWhatsNext\s*\(/.test(SLASH),
    'handleWhatsNext must be defined');
});

t('attach.js GUEST_ALLOWED_CMDS includes /whatsnext + /next (read-only, like /qstatus)', () => {
  // Both must appear as quoted strings inside the GUEST_ALLOWED_CMDS Set.
  assert.ok(/GUEST_ALLOWED_CMDS[\s\S]{0,800}?['"]\/whatsnext['"]/.test(ATTACH),
    'attach.js must allow guests to call /whatsnext');
  assert.ok(/GUEST_ALLOWED_CMDS[\s\S]{0,800}?['"]\/next['"]/.test(ATTACH),
    'attach.js must allow guests to call /next');
});

t('app.js _GUEST_ALLOWED_CMDS mirror includes /whatsnext + /next (Send-button gate)', () => {
  // Mirror is required by bug-19's contract so the Send button is enabled when
  // a guest types /whatsnext.
  assert.ok(/_GUEST_ALLOWED_CMDS[\s\S]{0,800}?['"]\/whatsnext['"]/.test(APP),
    'client mirror must allow /whatsnext or the Send button stays disabled for guests');
  assert.ok(/_GUEST_ALLOWED_CMDS[\s\S]{0,800}?['"]\/next['"]/.test(APP),
    'client mirror must allow /next');
});

// ──────────────────────────────────────────────────────────────────────
// Defaults / module exports sanity
// ──────────────────────────────────────────────────────────────────────

t('TWO_HOURS_MS matches the 2h refresh cadence stated in the feature request', () => {
  assert.strictEqual(whatsnext.TWO_HOURS_MS, 2 * 60 * 60 * 1000);
});

t('RETURN_N is a sane non-empty cap', () => {
  assert.ok(whatsnext.RETURN_N >= 5 && whatsnext.RETURN_N <= 20,
    'cached output should be 5-20 items, not a single one or the whole plan');
});

// ──────────────────────────────────────────────────────────────────────

(async () => {
  // wait a tick so async-scheduled tests register before the report.
  await new Promise((r) => setImmediate(r));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
