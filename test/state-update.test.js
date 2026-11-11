// Regression: every state mutation must broadcast via the
// `state-update` session event so concurrent viewers stay in sync
// without waiting for reconnect.
//
// Covered emit paths:
//   1. _markMenuChatAnswered  → state-update { kind: 'menu', meta }
//   2. _toggleMenuChatCheckbox → state-update { kind: 'menu', meta }
//   3. _supersedeStaleMenus    → state-update for each unanswered menu row
//   4. artifacts.js mutation routes → state-update { kind: 'artifact', ... }
//      (via the broadcastArtifact helper registered inside register(deps))
//   5. AgentSession.ingestTranscriptForToolProgress → state-update
//      { kind: 'tool-progress', open: [...] } when the in-flight set changes
//
// We exercise these by source-level grep checks: the helpers aren't
// individually exported, so we pin their wiring via the file contents.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-su-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── state-update emit paths ──');

// --- 1 & 2: menu mutations live in attach.js (post Phase 9 step 2).
t('attach.js: _markMenuChatAnswered emits state-update after saveStore', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const fn = src.match(/function _markMenuChatAnswered[\s\S]+?\n}/);
  assert.ok(fn, '_markMenuChatAnswered not found');
  assert.ok(/saveStore\(\);[\s\S]*?_emitMenuStateUpdate/.test(fn[0]),
    '_markMenuChatAnswered does NOT emit state-update after saveStore');
});

t('attach.js: _toggleMenuChatCheckbox emits state-update after saveStore', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const fn = src.match(/function _toggleMenuChatCheckbox[\s\S]+?\n}/);
  assert.ok(fn, '_toggleMenuChatCheckbox not found');
  assert.ok(/saveStore\(\);[\s\S]*?_emitMenuStateUpdate/.test(fn[0]),
    '_toggleMenuChatCheckbox does NOT emit state-update after saveStore');
});

t('attach.js: _supersedeStaleMenus stamps + emits for each unanswered menu', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const fn = src.match(/function _supersedeStaleMenus[\s\S]+?\n}/);
  assert.ok(fn, '_supersedeStaleMenus not found');
  assert.ok(/m\.meta\.superseded\s*=\s*true/.test(fn[0]), 'stamping superseded missing');
  assert.ok(/_emitMenuStateUpdate/.test(fn[0]), 'emit per row missing');
});

t('menu.js: broadcastMenuToChat does NOT call _supersedeStaleMenus (bug-21)', () => {
  // bug-21 (2026-05-19) reversed the prior contract: pre-fix, this test
  // asserted broadcastMenuToChat MUST call _supersedeStaleMenus before
  // appendChatMessage. That assumption — "the SDK only fires a fresh
  // canUseTool when the prior one has already been resolved" — was
  // TRUE in serial tool-call mode and FALSE under parallel tool calls.
  // Stamping older menus as superseded whenever a new sibling lands
  // orphaned their resolver promises and deadlocked the SDK iteration.
  //
  // FIXED contract: broadcastMenuToChat must NOT call _supersedeStaleMenus.
  // The supersede sweep still exists (and is still legitimately called
  // from sessions.ensureLiveSession on AgentSession respawn — those
  // menus genuinely refer to dead resolver promises from a killed
  // process) — it's just no longer triggered on every menu broadcast.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'menu.js'), 'utf8');
  const fn = src.match(/function broadcastMenuToChat[\s\S]+?\n}/);
  assert.ok(fn, 'broadcastMenuToChat not found in menu.js');
  const supersedeIdx = fn[0].indexOf('_supersedeStaleMenus(');
  assert.strictEqual(supersedeIdx, -1,
    'broadcastMenuToChat must NOT invoke _supersedeStaleMenus(...) — that ' +
    'supersedes sibling parallel menus and was the bug-21 deadlock root cause. ' +
    'See test/bug-21-parallel-permission-menus.test.js for the full contract.');
  // appendChatMessage must still be called (we're still broadcasting the
  // new row to chat — the only change is what we DON'T do before that).
  assert.ok(fn[0].indexOf('appendChatMessage') > 0,
    'appendChatMessage still required in broadcastMenuToChat');
});

t('attach.js: _emitMenuStateUpdate sends transcriptUuid + meta payload', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const fn = src.match(/function _emitMenuStateUpdate[\s\S]+?\n}/);
  assert.ok(fn, '_emitMenuStateUpdate not found');
  assert.ok(/kind:\s*'menu'/.test(fn[0]), 'kind: menu missing');
  assert.ok(/messageUuid/.test(fn[0]), 'messageUuid field missing');
  assert.ok(/meta:\s*m\.meta/.test(fn[0]), 'meta payload missing');
});

// --- 4: artifacts.js broadcasts on every mutation
t('artifacts.js: broadcastArtifact helper exists + called from each route', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
  assert.ok(/function broadcastArtifact/.test(src), 'broadcastArtifact helper missing');
  const routes = ['/artifact/refresh', '/artifact/run', '/artifact/mark', '/artifact/vote', '/artifact/comment', '/artifact/item'];
  for (const route of routes) {
    const escaped = route.replace(/\//g, '\\/');
    // fr-95 follow-up: include `patch` — the /artifact/item route was
    // migrated to app.patch(...) (see artifacts.js:930, fr-46 edit-item
    // route). Pre-fix the regex only matched post|delete and the test
    // flagged the patch route as missing the broadcastArtifact call
    // even though it's plainly there at artifacts.js:956. The actual
    // behavior contract (broadcastArtifact must fire on every mutation
    // route) is unchanged; only the test's verb list was stale.
    const re = new RegExp(`app\\.(?:post|patch|delete)\\('/sessions/:id${escaped}'[\\s\\S]+?broadcastArtifact\\(`);
    assert.ok(re.test(src), 'broadcastArtifact not called from ' + route + ' route');
  }
});

t("artifacts.js: broadcastArtifact emits state-update { kind: 'artifact' }", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
  const fn = src.match(/function broadcastArtifact[\s\S]+?\n  }/);
  assert.ok(fn, 'broadcastArtifact body not found');
  assert.ok(/emit\('state-update'/.test(fn[0]), 'emit state-update missing');
  assert.ok(/kind:\s*'artifact'/.test(fn[0]), "kind: 'artifact' missing");
  assert.ok(/artifactType:\s*type/.test(fn[0]), 'artifactType field missing');
});

// --- 5: in-flight tool-call tracker lives on AgentSession. Phase 9
// step 2 retired the PTY's `ingestTranscriptForToolProgress` JSONL-
// watcher hook because the agent SDK pushes tool_use / tool_result
// blocks directly through _handleEvent — same `openToolCalls` Map,
// same `state-update {kind:'tool-progress'}` emit, no transcript-
// watcher detour.
t('agent-session.js: openToolCalls map + tool_use/result wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
  assert.ok(/this\.openToolCalls\s*=\s*new Map/.test(src), 'openToolCalls map not initialised on AgentSession');
  assert.ok(/openToolCalls\.set/.test(src), 'openToolCalls.set (insert on tool_use) missing');
  assert.ok(/openToolCalls\.delete/.test(src), 'openToolCalls.delete (drain on tool_result) missing');
  assert.ok(/emit\('state-update'[\s\S]*kind:\s*'tool-progress'/.test(src),
    "tool-progress state-update emit missing");
});

t('attach.js: streamTranscriptToWs guards optional ingestTranscriptForToolProgress', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  // The hook is optional — AgentSession doesn't have it but the
  // attach.js code path is defensive in case a future session driver
  // exposes one. The optional-chain (typeof === 'function') call must
  // be present so the watcher loop doesn't TypeError when it's absent.
  assert.ok(/typeof session\.ingestTranscriptForToolProgress === 'function'/.test(src),
    'attach.js missing typeof guard for optional ingestTranscriptForToolProgress hook');
});

// --- Attach snapshot wires the new frames
t('attach.js: _sendAttachSnapshot sends mode-snapshot + artifacts-init', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const fn = src.match(/function _sendAttachSnapshot[\s\S]+?\n}/);
  assert.ok(fn, '_sendAttachSnapshot not found');
  assert.ok(/t:\s*'claude-status'/.test(fn[0]), 'claude-status replay missing');
  assert.ok(/t:\s*'mode-snapshot'/.test(fn[0]), 'mode-snapshot frame missing');
  assert.ok(/t:\s*'artifacts-init'/.test(fn[0]), 'artifacts-init frame missing');
  assert.ok(/tool-progress/.test(fn[0]), 'tool-progress snapshot missing');
});

t('attach.js: both attach handlers call _sendAttachSnapshot', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  // attachWebSocket delegates to _attachAgentWebSocket, so both the
  // agent-attach helper and the viewer helper must call the snapshot.
  const ownerAgent = src.match(/function _attachAgentWebSocket[\s\S]+?\nfunction /);
  const viewer = src.match(/function attachViewerWebSocket[\s\S]+?^}/m);
  assert.ok(ownerAgent && /_sendAttachSnapshot/.test(ownerAgent[0]), 'owner attach missing _sendAttachSnapshot');
  assert.ok(viewer && /_sendAttachSnapshot/.test(viewer[0]), 'viewer attach missing _sendAttachSnapshot');
});

t('attach.js: both attach handlers subscribe to state-update + clean up', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
  const ownerAgent = src.match(/function _attachAgentWebSocket[\s\S]+?\nfunction /);
  const viewer = src.match(/function attachViewerWebSocket[\s\S]+?^}/m);
  assert.ok(ownerAgent && /session\.on\('state-update'/.test(ownerAgent[0]), 'owner not subscribed to state-update');
  assert.ok(ownerAgent && /session\.off\('state-update'/.test(ownerAgent[0]), 'owner not unsubscribing state-update on close');
  assert.ok(viewer && /session\.on\('state-update'/.test(viewer[0]), 'viewer not subscribed to state-update');
  assert.ok(viewer && /session\.off\('state-update'/.test(viewer[0]), 'viewer not unsubscribing state-update on close');
});

// --- Client side
t("app.js: WS router dispatches state-update / artifacts-init / mode-snapshot", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/msg\.t === 'state-update'/.test(src), 'router missing state-update branch');
  assert.ok(/msg\.t === 'artifacts-init'/.test(src), 'router missing artifacts-init branch');
  assert.ok(/msg\.t === 'mode-snapshot'/.test(src), 'router missing mode-snapshot branch');
  assert.ok(/function _applyStateUpdate/.test(src), '_applyStateUpdate dispatcher missing');
  assert.ok(/function _applyMenuStateUpdate/.test(src), '_applyMenuStateUpdate missing');
  assert.ok(/function _applyModeSnapshot/.test(src), '_applyModeSnapshot missing');
});

t('app.js: loadArtifact reads cache before HTTP', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const fn = src.match(/async function loadArtifact[\s\S]+?\n}/);
  assert.ok(fn, 'loadArtifact not found');
  const cacheIdx = fn[0].indexOf('state.artifacts');
  const fetchIdx = fn[0].indexOf('authedFetch');
  assert.ok(cacheIdx > 0 && cacheIdx < fetchIdx, 'cache must be checked before HTTP fetch');
});

t('app.js: meta.superseded triggers resolved card', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  assert.ok(/isSuperseded\s*=\s*!!\(m\.meta && m\.meta\.superseded\)/.test(src),
    'isSuperseded gate missing');
  assert.ok(/Superseded by a newer dialog/.test(src), 'superseded chip copy missing');
});

// Phase 9 step 9 retired appendTranscriptMessages (the JSONL transcript
// pane is gone). The defensive out-of-order timestamp sort is no longer
// needed because there's no transcript-delta WS frame anymore.

t('app.js: _applyMenuStateUpdate recomputes isActiveMenu, does NOT hardcode false', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
  const fn = src.match(/function _applyMenuStateUpdate[\s\S]+?\n}/);
  assert.ok(fn, '_applyMenuStateUpdate not found');
  assert.ok(/_findLastMenuMessageIdx\(state\.chatMessages\)/.test(fn[0]),
    '_applyMenuStateUpdate does not consult _findLastMenuMessageIdx — checkbox toggle will collapse the row');
  assert.ok(/renderChatMessage\(m,\s*isActive\)/.test(fn[0]),
    '_applyMenuStateUpdate still passing a fixed boolean instead of the computed isActive');
});

// --- Keepalive regression — pin the 30s server ping so it doesn't silently shrink
t('index.js: server PING_INTERVAL_MS pinned at 30000', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
  assert.ok(/PING_INTERVAL_MS\s*=\s*30000/.test(src),
    'PING_INTERVAL_MS no longer 30000 — silent keepalive regression');
});

console.log(`\n${passed} passed, ${failed} failed`);
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
if (failed) process.exit(1);
