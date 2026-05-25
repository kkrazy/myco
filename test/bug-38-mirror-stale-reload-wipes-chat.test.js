// bug-38 regression: chat-mode plan-item mutations (running stamp +
// user-turn aiChat append) were lost when ANY subsequent HTTP-route
// artifact mutation fired — because HTTP routes call
// _loadArtifactIntoRecFromFile at the top of every mutation, which
// reloaded the STALE on-disk _myco_/plan.json mirror and replaced
// rec.artifacts.plan in memory with the file's view. Since the
// chat-mode helpers (_stampPlanItemStatus, _appendUserAiChatTurn,
// _stampPlanItemRunOutcome, _appendAgentAiChatTurn) only called
// saveStore() (writes /data/sessions.json), the mirror file stayed
// stale and the next mutation's reload WIPED the just-stamped
// runs[]/aiChat[] entries.
//
// User-reported (kkrazy on opti 2026-05-25 03:04): submitted fr-58 +
// fr-59 to run; fr-58's chat history wiped after fr-59 submitted.
// Verified: fr-58.aiChat=0 + fr-58.runs=0 even though handleChatMessage
// definitely ran (the dispatch text was in rec.chat).
//
// Fix: chat-mode helpers now call artifactsMod.persistArtifact(...)
// instead of bare saveStore. persistArtifact does saveStore +
// writeArtifactToFile — keeping the mirror in sync.
//
// This test exercises the exact race: write to plan via chat-mode
// helpers, then simulate a route-driven mutation calling
// _loadArtifactIntoRecFromFile, then verify the chat-mode mutations
// survived (mirror was up-to-date, reload was a no-op).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-38: mirror-stale reload wipes chat-mode mutations ──');

// ──────────────────────────────────────────────────────────────────────
// Static guards — each chat-mode helper calls persistArtifact (not
// bare saveStore alone).
// ──────────────────────────────────────────────────────────────────────

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');

t('artifacts.js: persistArtifact exported publicly (was __test-only)', () => {
  // Must be reachable from attach.js as artifactsMod.persistArtifact.
  // Pre-fix it was only in module.exports.__test.
  const exportsIdx = ARTIFACTS.search(/module\.exports\s*=\s*\{/);
  const win = ARTIFACTS.slice(exportsIdx);
  // The TEST sub-namespace also lists it; we need the TOP-LEVEL one.
  // Find a `  persistArtifact,` (top-level) line that's NOT inside __test.
  const testIdx = win.search(/__test\s*:\s*\{/);
  const topLevel = win.slice(0, testIdx);
  assert.ok(/\bpersistArtifact\b/.test(topLevel),
    'persistArtifact must be in the top-level module.exports (not just __test)');
});

t('attach.js: _stampPlanItemStatus calls persistArtifact (not bare saveStore)', () => {
  const idx = ATTACH.search(/function\s+_stampPlanItemStatus\s*\(/);
  const win = ATTACH.slice(idx, idx + 1500);
  assert.ok(/persistArtifact\s*\(/.test(win),
    '_stampPlanItemStatus must call persistArtifact (writes mirror too)');
  // Make sure no bare saveStore is the LAST persist call in this fn.
  // It's fine to have additional saveStores but the LAST one must
  // be a persistArtifact (the one that the mirror lookup-on-reload needs).
  // Simpler check: no bare sessionsMod.saveStore() in the body.
  assert.ok(!/sessionsMod\.saveStore\(\)/.test(win),
    '_stampPlanItemStatus must NOT call bare sessionsMod.saveStore() (would leave mirror stale)');
});

t('attach.js: _stampPlanItemRunOutcome calls persistArtifact', () => {
  const idx = ATTACH.search(/function\s+_stampPlanItemRunOutcome\s*\(/);
  // Function body spans ~6KB (includes auto-summary comment building).
  // Slice to the NEXT function definition to scope precisely.
  const after = ATTACH.slice(idx + 50);
  const endRel = after.search(/^function\s+_\w+\s*\(/m);
  const win = endRel < 0 ? ATTACH.slice(idx) : ATTACH.slice(idx, idx + 50 + endRel);
  assert.ok(/persistArtifact\s*\(/.test(win),
    '_stampPlanItemRunOutcome must call persistArtifact');
  assert.ok(!/sessionsMod\.saveStore\(\)/.test(win),
    '_stampPlanItemRunOutcome must NOT call bare sessionsMod.saveStore()');
});

t('attach.js: _appendUserAiChatTurn calls persistArtifact', () => {
  const idx = ATTACH.search(/function\s+_appendUserAiChatTurn\s*\(/);
  const win = ATTACH.slice(idx, idx + 1500);
  assert.ok(/persistArtifact\s*\(/.test(win),
    '_appendUserAiChatTurn must call persistArtifact');
  assert.ok(!/sessionsMod\.saveStore\(\)/.test(win),
    '_appendUserAiChatTurn must NOT call bare sessionsMod.saveStore()');
});

t('attach.js: _appendAgentAiChatTurn calls persistArtifact', () => {
  const idx = ATTACH.search(/function\s+_appendAgentAiChatTurn\s*\(/);
  const win = ATTACH.slice(idx, idx + 1800);
  assert.ok(/persistArtifact\s*\(/.test(win),
    '_appendAgentAiChatTurn must call persistArtifact');
  assert.ok(!/sessionsMod\.saveStore\(\)/.test(win),
    '_appendAgentAiChatTurn must NOT call bare sessionsMod.saveStore()');
});

// ──────────────────────────────────────────────────────────────────────
// End-to-end behavior — mirror stays in sync after chat-mode mutations
// so the next _loadArtifactIntoRecFromFile reload is a no-op (or
// reloads the SAME data, preserving mutations).
// ──────────────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bug38-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\nkkrazy\n');

const { execFileSync } = require('child_process');
const sessionsMod = require('../server/src/sessions');
const artifactsMod = require('../server/src/artifacts');
const attach = require('../server/src/attach');

function makeProject(name) {
  const dir = path.join(process.env.MYCO_WORKSPACE, name);
  fs.mkdirSync(dir, { recursive: true });
  // Need a .git/ for findProjectRoot to consider this a project.
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  // Seed an empty plan.json mirror so writeArtifactToFile has a target.
  const mycoDir = path.join(dir, '_myco_');
  fs.mkdirSync(mycoDir, { recursive: true });
  return dir;
}

function seedSession(sid, projectRoot, items) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: projectRoot,
    createdAt: new Date().toISOString(),
    chat: [],
    artifacts: { plan: { items, updatedAt: null } },
  };
  sessionsMod.saveStore();
  // Also mirror the items to plan.json so first-load aligns.
  artifactsMod.persistArtifact(store.sessions[sid], 'plan', store.sessions[sid].artifacts.plan);
}

t('e2e: chat-mode mutations survive a subsequent _loadArtifactIntoRecFromFile reload', () => {
  const projectRoot = makeProject('proj-bug38-1');
  const sid = 'sess-bug38-1';
  seedSession(sid, projectRoot, [
    { id: 'fr-58', text: 'feature 58', layer: 'Feature', voters: [], comments: [] },
    { id: 'fr-59', text: 'feature 59', layer: 'Feature', voters: [], comments: [] },
  ]);

  const session = { emit() {}, alive: true };
  attach._registerExternalSession(sid, session);

  // Simulate handleChatMessage for fr-58 — stamp running + append user
  // turn. (We exercise the exported test surface via _registerExternalSession
  // + the chat-mode helpers reachable via runtime.)
  //
  // Use the same call sites that handleChatMessage uses internally.
  // attach.js doesn't export these directly, so we exercise via the
  // mock-session pattern from plan-run-comment.test.js: push to FIFO
  // then emit events. But for THIS test we want to test the WRITE
  // path of the user-turn + running stamp, which fire SYNCHRONOUSLY
  // in handleChatMessage's marker block (NOT via the listener).
  //
  // The cleanest test is: call the equivalent via artifactsMod
  // directly + ensure persistArtifact is what gets called. We've
  // already pinned that with the static guards above. Here we test
  // the END RESULT: mutations survive the reload cycle.
  const rec = sessionsMod.getSessionRecord(sid);
  const planArtifact = rec.artifacts.plan;
  const fr58 = planArtifact.items.find((i) => i.id === 'fr-58');

  // Simulate _stampPlanItemStatus + _appendUserAiChatTurn writes — using
  // the same helpers they internally invoke, then persistArtifact.
  fr58.runs = [{ status: 'running', ts: new Date().toISOString(), summary: null }];
  artifactsMod.appendAiChatTurn(fr58, { user: 'kkrazy', role: 'user', text: 'user turn for fr-58' });
  artifactsMod.persistArtifact(rec, 'plan', planArtifact);

  // Now simulate fr-59's HTTP-route mutation: at the top, it calls
  // _loadArtifactIntoRecFromFile('plan'). Pre-fix, this would have
  // wiped fr-58.runs + fr-58.aiChat because the mirror was stale.
  // Post-fix, the mirror is up-to-date so reload is harmless.
  artifactsMod.__test._loadArtifactIntoRecFromFile(rec, 'plan');

  const fr58After = rec.artifacts.plan.items.find((i) => i.id === 'fr-58');
  assert.ok(fr58After, 'fr-58 must still exist after reload');
  assert.ok(Array.isArray(fr58After.runs) && fr58After.runs.length === 1,
    'fr-58.runs must survive reload: ' + JSON.stringify(fr58After.runs));
  assert.strictEqual(fr58After.runs[0].status, 'running');
  assert.ok(Array.isArray(fr58After.aiChat) && fr58After.aiChat.length === 1,
    'fr-58.aiChat must survive reload: ' + JSON.stringify(fr58After.aiChat));
  assert.strictEqual(fr58After.aiChat[0].text, 'user turn for fr-58');
});

t('e2e: PRE-FIX repro — bare saveStore + reload WOULD wipe mutations', () => {
  // This is the negative test that captures the pre-fix behavior. If
  // you call saveStore (no mirror write) then reload from mirror, the
  // in-memory mutations are LOST. This confirms our diagnosis was
  // correct + locks the symptom into a test so we can red-flip on
  // regression.
  const projectRoot = makeProject('proj-bug38-2');
  const sid = 'sess-bug38-2';
  seedSession(sid, projectRoot, [
    { id: 'fr-58', text: 'feature 58', layer: 'Feature', voters: [], comments: [] },
  ]);
  const rec = sessionsMod.getSessionRecord(sid);
  const fr58 = rec.artifacts.plan.items.find((i) => i.id === 'fr-58');

  // PRE-FIX behavior: mutate in-memory + bare saveStore (skip mirror).
  fr58.runs = [{ status: 'running', ts: new Date().toISOString() }];
  artifactsMod.appendAiChatTurn(fr58, { user: 'kkrazy', role: 'user', text: 'PRE-FIX test' });
  sessionsMod.saveStore();   // intentionally bare — no writeArtifactToFile

  // Reload from mirror (stale — has empty runs + aiChat for fr-58).
  artifactsMod.__test._loadArtifactIntoRecFromFile(rec, 'plan');

  const fr58After = rec.artifacts.plan.items.find((i) => i.id === 'fr-58');
  // PRE-FIX outcome: mutations gone.
  assert.ok(!Array.isArray(fr58After.runs) || fr58After.runs.length === 0,
    'PRE-FIX: runs WERE wiped (this asserts the WAS-broken behavior to lock the symptom)');
  assert.ok(!Array.isArray(fr58After.aiChat) || fr58After.aiChat.length === 0,
    'PRE-FIX: aiChat WAS wiped (same)');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
