// fr-88 migration 1: /comment → mcp__myco__add_comment tool.
//
// First migration under the fr-88 design rule (CLAUDE.md §Code Style #3):
// "all slash commands should be implemented as MCP tools whenever
// possible". Two surfaces, one source of truth — the new MCP tool
// `mcp__myco__add_comment` and the existing HTTP POST
// /artifact/comment route BOTH call the shared `appendCommentToItem`
// helper exported from artifacts.js. The agent can now leave
// closeout summaries on plan items without asking the user to type
// /comment …, replacing the older "write a one-shot node script to
// mutate plan.json" pattern.
//
// Static guards on artifacts.js (helper + export + HTTP-route
// delegation) + myco-mcp.js (tool definition + helper invocation) +
// CLAUDE.md (closeout etiquette). Behavior simulation exercises the
// helper end-to-end against a real temp dir session.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ARTIFACTS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const MYCO_MCP_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'myco-mcp.js'), 'utf8');
const CLAUDE_MD = fs.readFileSync(
  path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

console.log('── fr-88 migration 1: mcp__myco__add_comment ──');

// ──────────────────────────────────────────────────────────────────────
// Shared helper extracted to module scope + exported
// ──────────────────────────────────────────────────────────────────────

t('artifacts.js: appendCommentToItem is defined at module scope', () => {
  // The whole point of the migration: two surfaces (HTTP + MCP) call
  // ONE backend helper. The helper must be reachable from both —
  // module-scope export, not closure-captured inside register(app).
  assert.ok(/^function\s+appendCommentToItem\s*\(/m.test(ARTIFACTS_SRC),
    'appendCommentToItem must be defined at module scope (^^ anchor)');
});

t('artifacts.js: appendCommentToItem validates length + type + non-empty', () => {
  const idx = ARTIFACTS_SRC.search(/function\s+appendCommentToItem\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 2500);
  assert.ok(/ARTIFACT_TYPES\.includes\(type\)/.test(win),
    'must validate type is in ARTIFACT_TYPES');
  assert.ok(/type\s*===\s*['"]arch['"]/.test(win),
    'must reject arch (no comment thread on arch)');
  assert.ok(/!cleaned/.test(win),
    'must reject empty text after trim');
  assert.ok(/COMMENT_TEXT_MAX/.test(win),
    'must enforce COMMENT_TEXT_MAX length cap');
});

t('artifacts.js: appendCommentToItem tail-trims at COMMENTS_PER_ITEM_MAX', () => {
  // Same ring-buffer pattern as appendAiChatTurn — preserves the
  // pre-migration behavior on the HTTP route.
  const idx = ARTIFACTS_SRC.search(/function\s+appendCommentToItem\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 2500);
  assert.ok(/slice\(-COMMENTS_PER_ITEM_MAX\)/.test(win),
    'overflow must be handled via slice(-COMMENTS_PER_ITEM_MAX) (ring buffer)');
});

t('artifacts.js: appendCommentToItem returns the artifact for broadcast', () => {
  // Each caller does its own broadcast (HTTP uses
  // broadcastArtifact in register-closure; MCP uses
  // attach.getSession()+emit). Helper just returns the data.
  const idx = ARTIFACTS_SRC.search(/function\s+appendCommentToItem\s*\(/);
  const win = ARTIFACTS_SRC.slice(idx, idx + 2500);
  assert.ok(/return\s*\{\s*ok:\s*true[\s\S]{0,200}artifact/.test(win),
    'success return must include `artifact` so the caller can broadcast');
});

t('artifacts.js: HTTP POST /artifact/comment route delegates to appendCommentToItem', () => {
  // This is the core "two surfaces, one source of truth" pin: the
  // HTTP route MUST go through the same helper the MCP tool uses,
  // otherwise the migration is just code duplication.
  const idx = ARTIFACTS_SRC.search(/app\.post\(['"]\/sessions\/:id\/artifact\/comment['"]/);
  assert.ok(idx > -1, 'POST /artifact/comment route must exist');
  const win = ARTIFACTS_SRC.slice(idx, idx + 1500);
  assert.ok(/appendCommentToItem\s*\(/.test(win),
    'POST route must delegate to appendCommentToItem (shared backend)');
});

t('artifacts.js: appendCommentToItem + COMMENT_TEXT_MAX + COMMENTS_PER_ITEM_MAX exported', () => {
  // module.exports must include the helper + the constants so
  // tests + other modules can reference them without re-defining.
  const exportsIdx = ARTIFACTS_SRC.search(/module\.exports\s*=\s*\{/);
  const win = ARTIFACTS_SRC.slice(exportsIdx, exportsIdx + 1500);
  assert.ok(/\bappendCommentToItem\b/.test(win),
    'module.exports must include appendCommentToItem');
  assert.ok(/\bCOMMENT_TEXT_MAX\b/.test(win),
    'module.exports must include COMMENT_TEXT_MAX (constant exposed for tests)');
  assert.ok(/\bCOMMENTS_PER_ITEM_MAX\b/.test(win),
    'module.exports must include COMMENTS_PER_ITEM_MAX');
});

// ──────────────────────────────────────────────────────────────────────
// MCP tool definition
// ──────────────────────────────────────────────────────────────────────

t('myco-mcp.js declares the add_comment tool', () => {
  assert.ok(/['"]add_comment['"]/.test(MYCO_MCP_SRC),
    'myco-mcp must define a tool named "add_comment"');
});

t('myco-mcp.js: add_comment schema includes itemId + text + optional type', () => {
  const idx = MYCO_MCP_SRC.search(/['"]add_comment['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/itemId:\s*z\.string/.test(win),
    'schema must require itemId: z.string');
  assert.ok(/text:\s*z\.string/.test(win),
    'schema must require text: z.string');
  assert.ok(/type:\s*z\.enum/.test(win),
    'schema must accept an optional type enum (plan/test)');
});

t('myco-mcp.js: add_comment handler delegates to artifactsMod.appendCommentToItem', () => {
  // The shared-backend invariant — tool must NOT re-implement the
  // append logic. It must call the artifacts helper.
  const idx = MYCO_MCP_SRC.search(/['"]add_comment['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/appendCommentToItem\s*\(\s*sessionId\s*,/.test(win),
    'add_comment handler must call artifactsMod.appendCommentToItem(sessionId, …)');
});

t('myco-mcp.js: add_comment broadcasts state-update to attached clients', () => {
  // After a successful append, the tool must emit state-update so
  // live clients re-render. Same pattern _appendPlanItems uses.
  const idx = MYCO_MCP_SRC.search(/['"]add_comment['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 3000);
  assert.ok(/attachMod\.getSession\s*\(\s*sessionId\s*\)/.test(win),
    'add_comment must look up the session via attach.getSession to emit state-update');
  assert.ok(/state-update[\s\S]{0,300}artifact/.test(win),
    'state-update emit must include the artifact payload');
});

t('myco-mcp.js: add_comment author defaults to "claude" (the agent)', () => {
  // When the AGENT calls the tool, the comment must be attributed
  // to claude. Pre-fix the manual node-script pattern attributed
  // comments to "claude" too — preserving that.
  const idx = MYCO_MCP_SRC.search(/['"]add_comment['"]/);
  const win = MYCO_MCP_SRC.slice(idx, idx + 2500);
  assert.ok(/['"]claude['"]/.test(win),
    'add_comment must pass "claude" as the author to appendCommentToItem');
});

// ──────────────────────────────────────────────────────────────────────
// CLAUDE.md etiquette
// ──────────────────────────────────────────────────────────────────────

t('CLAUDE.md: closeout-comment etiquette instructs the agent to use the tool', () => {
  // The whole VALUE of the tool: agent leaves closeouts on items
  // automatically. CLAUDE.md is the contract that makes it happen.
  assert.ok(/mcp__myco__add_comment/.test(CLAUDE_MD),
    'CLAUDE.md must reference mcp__myco__add_comment');
  assert.ok(/closeout/i.test(CLAUDE_MD),
    'CLAUDE.md must use the word "closeout" to anchor when to call the tool');
  // Should explicitly mention this REPLACES the node-script pattern,
  // so the agent doesn't keep doing both.
  assert.ok(/node script/i.test(CLAUDE_MD) || /node-script/i.test(CLAUDE_MD),
    'CLAUDE.md must note the tool replaces the manual node-script-to-mutate-plan.json pattern');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation: helper round-trip against a real temp session
// ──────────────────────────────────────────────────────────────────────

t('behavior: appendCommentToItem appends a real comment + persists to plan.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr88-test-'));

  // artifacts.findProjectRoot walks up looking for a .git directory
  // — seed one so the artifact mirror path resolves to tmpDir/_myco_/.
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

  // Seed a fake plan with one item.
  const mycoDir = path.join(tmpDir, '_myco_');
  fs.mkdirSync(mycoDir, { recursive: true });
  const planPath = path.join(mycoDir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    items: [{
      id: 'fr-test', text: 'test item', layer: 'Feature', done: false,
      addedAt: '2026-05-24T00:00:00Z', addedBy: 'kkrazy', source: 'user',
      voters: [], comments: [],
    }],
    updatedAt: '2026-05-24T00:00:00Z',
  }, null, 2));

  const sessionsMod = require('../server/src/sessions');
  const origLoadStore = sessionsMod.loadStore;
  const origSaveStore = sessionsMod.saveStore;
  const fakeSid = 'fr88-test-session';
  const fakeRec = {
    absCwd: tmpDir,
    cwd: tmpDir,
    user: 'kkrazy',
    artifacts: {},
  };
  sessionsMod.loadStore = () => ({ sessions: { [fakeSid]: fakeRec } });
  sessionsMod.saveStore = () => {};  // no-op (rec is in-memory)

  try {
    delete require.cache[require.resolve('../server/src/artifacts')];
    const artifactsMod = require('../server/src/artifacts');

    const r = artifactsMod.appendCommentToItem(
      fakeSid, 'plan', 'fr-test', 'claude',
      'closeout: shipped fr-88 migration 1');
    assert.strictEqual(r.ok, true, 'append should succeed: ' + JSON.stringify(r));
    assert.ok(r.comment && r.comment.id && /^[0-9a-f]{12}$/.test(r.comment.id),
      'returned comment must have a 12-hex id');
    assert.strictEqual(r.comment.user, 'claude');
    assert.strictEqual(r.comment.text, 'closeout: shipped fr-88 migration 1');
    assert.ok(r.comment.ts, 'comment must have ts');

    // The item in rec.artifacts.plan reflects the append.
    const planItem = fakeRec.artifacts.plan.items.find((x) => x.id === 'fr-test');
    assert.strictEqual(planItem.comments.length, 1);
    assert.strictEqual(planItem.comments[0].text, 'closeout: shipped fr-88 migration 1');

    // plan.json mirror file got persisted.
    const parsed = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const parsedItem = parsed.items.find((x) => x.id === 'fr-test');
    assert.strictEqual(parsedItem.comments.length, 1);
  } finally {
    sessionsMod.loadStore = origLoadStore;
    sessionsMod.saveStore = origSaveStore;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server/src/artifacts')];
  }
});

t('behavior: appendCommentToItem rejects validation failures with HTTP-style codes', () => {
  // Validation cases the helper must reject — each with the
  // appropriate {ok:false, error, status} shape so the HTTP route
  // can pass through to res.status().json() unchanged.
  delete require.cache[require.resolve('../server/src/artifacts')];
  const artifactsMod = require('../server/src/artifacts');

  // Empty text → 400.
  let r = artifactsMod.appendCommentToItem('s1', 'plan', 'fr-1', 'k', '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
  assert.ok(/required/i.test(r.error), 'error must mention "required"');

  // Unknown type → 400.
  r = artifactsMod.appendCommentToItem('s1', 'zorf', 'fr-1', 'k', 'hello');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
  assert.ok(/unknown type/i.test(r.error));

  // arch type → 400 (no comment thread).
  r = artifactsMod.appendCommentToItem('s1', 'arch', 'fr-1', 'k', 'hello');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
  assert.ok(/arch/i.test(r.error));

  // Missing itemId → 400.
  r = artifactsMod.appendCommentToItem('s1', 'plan', '', 'k', 'hello');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
  assert.ok(/itemId/i.test(r.error));

  // Text over the cap → 400.
  const tooLong = 'x'.repeat(1001);
  r = artifactsMod.appendCommentToItem('s1', 'plan', 'fr-1', 'k', tooLong);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
  assert.ok(/too long/i.test(r.error));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
