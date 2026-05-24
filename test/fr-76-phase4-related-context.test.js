// fr-76 Phase 4: related-item context in chat panel dispatch.
//
// When a [chat:plan#<id>] dispatch arrives, the agent-bound text
// gets augmented with a "[Related context for <id>]" block:
//   - Layer + done state
//   - Body (capped)
//   - dependsOn neighbors (resolved against plan.items)
//   - Text-mentioned items (regex match fr-N|bug-N|td-N in body+comments,
//     deduped against dependsOn, capped)
//   - Most recent run summary (if any)
//
// Persisted user turn (item.aiChat[]) stays unaugmented — only the
// SDK-bound dispatch text gets the context.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ARTIFACTS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const ATTACH_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

console.log('── fr-76 Phase 4: related-item context ──');

// ──────────────────────────────────────────────────────────────────────
// artifacts.js — helper defined + exported
// ──────────────────────────────────────────────────────────────────────

t('artifacts.js: getRelatedItemsContext defined + exported', () => {
  assert.ok(/^function\s+getRelatedItemsContext\s*\(/m.test(ARTIFACTS_SRC),
    'getRelatedItemsContext must be at module scope');
  const exportsIdx = ARTIFACTS_SRC.search(/module\.exports\s*=\s*\{/);
  const win = ARTIFACTS_SRC.slice(exportsIdx, exportsIdx + 2500);
  assert.ok(/\bgetRelatedItemsContext\b/.test(win),
    'must be in module.exports');
});

t('artifacts.js: helper signature is (rec, itemId, opts?)', () => {
  assert.ok(/function\s+getRelatedItemsContext\s*\(\s*rec\s*,\s*itemId\s*,\s*opts\s*\)/.test(ARTIFACTS_SRC),
    'signature must be (rec, itemId, opts) — opts.maxChars cap');
});

t('artifacts.js: helper caps output at opts.maxChars (default 2000)', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+getRelatedItemsContext\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 4000);
  // Code shape: `(opts && opts.maxChars) || 2000` — match the
  // default-value chunk independently of the surrounding paren.
  assert.ok(/\|\|\s*2000/.test(win),
    'default cap must be 2000 chars (fallback when opts.maxChars not given)');
  assert.ok(/out\.length\s*>\s*maxChars/.test(win),
    'must truncate when output exceeds cap');
});

t('artifacts.js: helper extracts mentions via regex /\\b(?:fr|bug|td)-\\d+\\b/', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+getRelatedItemsContext\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 4000);
  assert.ok(/\(?:fr\|bug\|td\)/.test(win),
    'mention extraction must regex-match fr-N|bug-N|td-N pattern');
});

t('artifacts.js: helper dedupes mentions vs dependsOn (no double-listing)', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+getRelatedItemsContext\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 4000);
  assert.ok(/seenSet/.test(win) || /(?:Set|new Set)/.test(win),
    'must use a Set to dedupe mentions vs dependsOn');
});

// ──────────────────────────────────────────────────────────────────────
// attach.js — injection in handleChatMessage
// ──────────────────────────────────────────────────────────────────────

t('attach.js: handleChatMessage injects context for [chat:...] markers', () => {
  // The whole point — when a chat marker is present, the agent-bound
  // text gets augmented with the context block before session.write.
  const idx = ATTACH_SRC.search(/Normal forward[\s\S]{0,200}session\.write/);
  assert.ok(idx > -1, 'session.write dispatch site must exist');
  // Right before the write, fr-76 Phase 4 builds agentText with the
  // marker test + context lookup.
  const win = ATTACH_SRC.slice(Math.max(0, idx - 1500), idx + 200);
  assert.ok(/chatMarkerMatch/.test(win),
    'must compute chatMarkerMatch from input');
  assert.ok(/getRelatedItemsContext/.test(win),
    'must call artifacts.getRelatedItemsContext to build the context block');
  assert.ok(/session\.write\(agentText\)/.test(win),
    'session.write must use agentText (the augmented form), not input directly');
});

t('attach.js: context injection is in try/catch (graceful skip)', () => {
  const idx = ATTACH_SRC.search(/Normal forward[\s\S]{0,200}session\.write/);
  const win = ATTACH_SRC.slice(Math.max(0, idx - 1500), idx + 200);
  assert.ok(/try\s*\{[\s\S]{0,800}getRelatedItemsContext[\s\S]{0,400}\}\s*catch/.test(win),
    'context lookup must be in try/catch — failure must not break the dispatch');
});

t('attach.js: persisted user turn stays unaugmented (only agent dispatch gets the block)', () => {
  // _appendUserAiChatTurn (called earlier in handleChatMessage) reads
  // from `text` / `fullText` — NOT from agentText. The context block
  // never lands in aiChat[].
  // Pin: agentText must be assigned AFTER appendChatMessage (which
  // persists the user message in raw form).
  const appendIdx = ATTACH_SRC.search(/sessionsMod\.appendChatMessage\s*\(\s*sessionId\s*,\s*message\s*\)/);
  const agentTextIdx = ATTACH_SRC.search(/let\s+agentText\s*=\s*input/);
  assert.ok(appendIdx > -1, 'appendChatMessage (persistence) must exist');
  assert.ok(agentTextIdx > -1, 'agentText must be declared');
  assert.ok(appendIdx < agentTextIdx,
    'persistence must happen BEFORE the agent-text augmentation — otherwise the context block would leak into the chat record');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — exercise the real helper
// ──────────────────────────────────────────────────────────────────────

t('behavior: full context for an item with dependsOn + mentions + last run', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const rec = {
    artifacts: { plan: { items: [
      { id: 'fr-1', text: 'main feature — depends on fr-2 and mentions bug-17 in body',
        layer: 'Feature', done: false,
        dependsOn: ['fr-2'],
        comments: [{ user: 'k', text: 'also blocked by td-9 maybe' }],
        runs: [{ status: 'success', ts: '2026-05-24T01:00:00Z', summary: '4.2s · 100→200 tok' }],
      },
      { id: 'fr-2', text: 'prerequisite for fr-1', layer: 'Feature', done: true },
      { id: 'bug-17', text: 'admin grant propagation bug', layer: 'Bug', done: false },
      { id: 'td-9', text: 'reorganize the build', layer: 'Todo', done: false },
    ]}},
  };
  const ctx = artifacts.getRelatedItemsContext(rec, 'fr-1');
  // Must include the item's body.
  assert.ok(/main feature/.test(ctx), 'context must include item body');
  // dependsOn neighbor with its body.
  assert.ok(/fr-2[\s\S]*prerequisite for fr-1[\s\S]*DONE/.test(ctx),
    'must include dependsOn neighbor + body + DONE marker');
  // Mentioned items (bug-17, td-9) — pulled from body + comment regex.
  assert.ok(/bug-17/.test(ctx) && /admin grant propagation bug/.test(ctx),
    'must surface bug-17 mention with body');
  assert.ok(/td-9/.test(ctx) && /reorganize the build/.test(ctx),
    'must surface td-9 mention from comment text');
  // dependsOn vs mention dedupe: fr-2 already in dependsOn, must NOT appear in mentions.
  // Count fr-2 occurrences — should appear once (in dependsOn block).
  const fr2Matches = ctx.match(/fr-2/g) || [];
  assert.ok(fr2Matches.length <= 2,   // once in dependsOn body, possibly once in self-body
    'fr-2 must not duplicate between dependsOn + mentions');
  // Last run.
  assert.ok(/Last run/.test(ctx) && /success/.test(ctx),
    'must include last run status');
});

t('behavior: missing item → empty context (graceful)', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const rec = { artifacts: { plan: { items: [] } } };
  assert.strictEqual(artifacts.getRelatedItemsContext(rec, 'nonexistent'), '');
});

t('behavior: missing rec / no plan → empty (no throw)', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  assert.strictEqual(artifacts.getRelatedItemsContext(null, 'fr-1'), '');
  assert.strictEqual(artifacts.getRelatedItemsContext({}, 'fr-1'), '');
  assert.strictEqual(artifacts.getRelatedItemsContext({ artifacts: {} }, 'fr-1'), '');
});

t('behavior: cap truncates output at maxChars', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  // Big body to force overflow.
  const longBody = 'x'.repeat(5000);
  const rec = {
    artifacts: { plan: { items: [
      { id: 'fr-1', text: longBody, layer: 'Feature' },
    ]}},
  };
  const ctx = artifacts.getRelatedItemsContext(rec, 'fr-1', { maxChars: 500 });
  assert.ok(ctx.length <= 500, 'output must be <= maxChars: ' + ctx.length);
  assert.ok(ctx.endsWith('...'), 'truncated output must end in ...');
});

t('behavior: no dependsOn + no mentions → just body + (maybe) layer', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const rec = {
    artifacts: { plan: { items: [
      { id: 'fr-1', text: 'simple isolated item', layer: 'Feature' },
    ]}},
  };
  const ctx = artifacts.getRelatedItemsContext(rec, 'fr-1');
  assert.ok(/Related context for fr-1/.test(ctx));
  assert.ok(/simple isolated item/.test(ctx));
  assert.ok(!/dependsOn/.test(ctx), 'no dependsOn block when empty');
  assert.ok(!/Mentioned items/.test(ctx), 'no mentions block when empty');
});

t('behavior: mention regex skips self-id (no fr-1 mention inside fr-1)', () => {
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifacts = require('../server/src/artifacts');
  const rec = {
    artifacts: { plan: { items: [
      { id: 'fr-1', text: 'See fr-1 and fr-2 for context', layer: 'Feature' },
      { id: 'fr-2', text: 'other thing', layer: 'Feature' },
    ]}},
  };
  const ctx = artifacts.getRelatedItemsContext(rec, 'fr-1');
  // fr-2 should be in mentions; fr-1 should NOT.
  assert.ok(/fr-2/.test(ctx) && /other thing/.test(ctx));
  // The mentioned-items BLOCK must NOT list fr-1 (self).
  const mentionsBlockIdx = ctx.indexOf('Mentioned items:');
  if (mentionsBlockIdx >= 0) {
    const mentionsBlock = ctx.slice(mentionsBlockIdx);
    assert.ok(!/\- fr-1:/.test(mentionsBlock), 'self-id must not appear in mentions');
  }
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
