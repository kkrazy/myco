// bug-21 regression: parallel canUseTool fires must each get an
// independently resolvable menu — no single-slot overwrite, no
// supersede-on-broadcast, and saving an "Allow always" rule on one
// menu must retroactively resolve any other pending menu whose
// (tool, input) now matches that rule.
//
// Pre-fix symptom (from the user's report, session
// myco-kkrazy-f80476dd, event seqs 3107–3110):
//
//   1. Claude issues two tool_use blocks in parallel (e.g. Bash + WebFetch).
//   2. SDK fires canUseTool for tool A → agent-session sets
//      this.pendingMenu = menuA, emits permission_request A, emits
//      'menu' A. _pendingPermissions has {hashA: resolverA}.
//   3. SDK fires canUseTool for tool B → agent-session OVERWRITES
//      this.pendingMenu = menuB. _pendingPermissions now has
//      {hashA: resolverA, hashB: resolverB} (the Map part was already
//      correct — it's the pendingMenu single-slot + the menu.js
//      _supersedeStaleMenus-on-broadcast sweep that's broken).
//   4. menu.js broadcastMenuToChat for menuB calls _supersedeStaleMenus
//      which marks menuA's chat row as superseded (its comment claims
//      "the SDK only fires a fresh canUseTool when the prior one has
//      already been resolved" — TRUE in serial mode, FALSE under
//      parallel tool calls).
//   5. attach.js bare-digit shortcut uses session.pendingMenu.hash → only
//      hashB is reachable via "1"/"2"/"3" in chat.
//   6. Result: hashA's canUseTool promise stays unresolved forever, the
//      SDK iteration deadlocks, queued user prompts pile up unprocessable.
//
// Fix (per the bug-21 spec):
//   a. session.pendingMenu single-slot → session.pendingMenus Map<hash, menu>.
//      Back-compat: session.pendingMenu getter returns the most-recently-
//      added entry (for the bare-digit shortcut + slashcmds /decide).
//   b. Bare-digit shortcut targets OLDEST pending menu (FIFO) when
//      multiple are pending. Rationale: head-of-queue gets resolved first;
//      explicit per-card button clicks (with their own hash) remain
//      unambiguous.
//   c. menu.js _supersedeStaleMenus call removed from broadcastMenuToChat —
//      a NEW menu arriving no longer marks older menus as answered. The
//      function still exists + is still called from sessions.ensureLiveSession
//      (respawn cleanup — those menus genuinely refer to dead resolver
//      promises).
//   d. resolveMenuPick(hash, 2) — "Allow always" — after persisting the
//      new rule via updatedPermissions, walks the remaining
//      _pendingPermissions entries; for each permission-flavor entry whose
//      (toolName, matchingInput) now matches the saved rule via
//      permissions.decide(rec, ...) === 'allow', auto-resolves with
//      {behavior:'allow'} + emits permission_resolved {auto:true,
//      reason:'matched rule saved via sibling Allow always'}.
//
// Static-grep guards at the bottom anchor the fix onto the prod source so
// future refactors can't silently regress (a) the Map replacement, (b) the
// supersede-on-broadcast removal, (c) the re-evaluate hook.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED behaviors. Each block mirrors the post-fix code in
// agent-session.js / menu.js / attach.js. The tests run against THESE
// in-test functions so we can assert behavior directly without spinning
// up a real SDK session; the static-grep guards at the bottom anchor
// the same shape onto the prod files.

// FIXED agent-session: pendingMenus is a Map; pendingMenu is a getter
// returning the most-recently-added entry (insertion-ordered Map iteration).
class FakeAgentSession {
  constructor(rec) {
    this.rec = rec;                            // { allowList, denyList }
    this._pendingPermissions = new Map();      // hash → { kind, toolName, input, resolve, ... }
    this.pendingMenus = new Map();             // hash → menu  (NEW — replaces single slot)
    this.events = [];                          // captured _emit calls
  }
  get pendingMenu() {
    // back-compat: most-recently-added pending menu. Map preserves
    // insertion order, so the last entry is the newest.
    let last = null;
    for (const m of this.pendingMenus.values()) last = m;
    return last;
  }
  // FIFO oldest — what the bare-digit shortcut targets.
  get oldestPendingMenu() {
    for (const m of this.pendingMenus.values()) return m;
    return null;
  }
  _emit(event) { this.events.push(event); }

  // Simplified _handlePermissionRequest — same shape as agent-session.js:
  // synthesize menu, register the resolver, emit permission_request,
  // register the menu in pendingMenus.
  _handlePermissionRequest(toolName, input, ctx = {}) {
    return new Promise((resolve) => {
      const toolUseID = ctx.toolUseID || ('tu-' + Math.random().toString(36).slice(2, 8));
      const hash = 'agent-' + toolUseID;
      const menu = {
        kind: 'permission',
        question: `Allow ${toolName}?`,
        options: [
          { n: 1, label: 'Allow once' },
          { n: 2, label: 'Allow always' },
          { n: 3, label: 'Deny' },
        ],
        hash,
        target: { tool: toolName, input: matchingInputFor(toolName, input) },
      };
      this._pendingPermissions.set(hash, {
        kind: 'permission',
        toolName,
        input,
        suggestions: ctx.suggestions || [],
        resolve,
      });
      this._emit({ type: 'permission_request', toolName, hash, toolUseID });
      this.pendingMenus.set(hash, menu);   // FIXED: set in Map, no overwrite
    });
  }

  resolveMenuPick(hash, n) {
    const pending = this._pendingPermissions.get(hash);
    if (!pending) return false;
    this._pendingPermissions.delete(hash);
    this.pendingMenus.delete(hash);   // FIXED: delete THIS hash only, not all
    if (n === 3) {
      this._emit({ type: 'permission_resolved', toolName: pending.toolName, hash, pickedN: 3, decision: 'deny' });
      pending.resolve({ behavior: 'deny' });
      return true;
    }
    const reply = { behavior: 'allow', updatedInput: pending.input };
    let persistedPattern = null;
    if (n === 2) {
      // "Allow always" — persist a rule that matches this (toolName, input).
      // In prod this comes from ctx.suggestions echoed back as
      // updatedPermissions; the in-test version just adds the
      // pattern directly to the rec for the re-evaluate walk to see.
      persistedPattern = `${pending.toolName}(${matchingInputFor(pending.toolName, pending.input)})`;
      if (!this.rec.allowList.includes(persistedPattern)) {
        this.rec.allowList.push(persistedPattern);
      }
      reply.updatedPermissions = [{ destination: 'localSettings', pattern: persistedPattern }];
    }
    this._emit({ type: 'permission_resolved', toolName: pending.toolName, hash, pickedN: n, decision: n === 2 ? 'allow-always' : 'allow-once' });
    pending.resolve(reply);
    // FIXED: re-evaluate any still-pending permission menus against the
    // newly-saved allow rule. Resolves siblings whose (tool, input) now
    // matches without forcing the user to click each one.
    if (n === 2 && persistedPattern) {
      this._reevaluatePendingAfterAllowAlways();
    }
    return true;
  }

  _reevaluatePendingAfterAllowAlways() {
    const stillPending = Array.from(this._pendingPermissions.entries());
    for (const [siblingHash, sibling] of stillPending) {
      if (sibling.kind !== 'permission') continue;
      const decision = decide(this.rec, sibling.toolName, matchingInputFor(sibling.toolName, sibling.input));
      if (decision === 'allow') {
        this._pendingPermissions.delete(siblingHash);
        this.pendingMenus.delete(siblingHash);
        this._emit({
          type: 'permission_resolved',
          toolName: sibling.toolName,
          hash: siblingHash,
          auto: true,
          reason: 'matched rule saved via sibling Allow always',
          decision: 'allow-once',
        });
        sibling.resolve({ behavior: 'allow', updatedInput: sibling.input });
      }
    }
  }
}

// Inlined matchingInputFor — mirror of agent-session.js:_matchingInputFor.
// Bash: the command. Everything else: empty string (the rule matches by
// toolName alone, e.g. "Read" matches every Read).
function matchingInputFor(toolName, input) {
  if (toolName === 'Bash') return String((input && input.command) || '');
  return '';
}

// Inlined permissions.decide — same matcher as the FIXED prod code (no
// changes needed to permissions.js for bug-21).
function decide(rec, tool, input) {
  if (!rec || !tool) return 'ask';
  for (const p of (rec.denyList || [])) if (matchesPattern(p, tool, input)) return 'deny';
  for (const p of (rec.allowList || [])) if (matchesPattern(p, tool, input)) return 'allow';
  return 'ask';
}
function matchesPattern(pattern, tool, input) {
  const m = String(pattern || '').trim().match(/^([A-Za-z_]\w*)(?:\(([^)]*)\))?\s*$/);
  if (!m) return false;
  if (m[1].toLowerCase() !== String(tool).toLowerCase()) return false;
  const inner = m[2];
  if (inner == null) return true;
  const stripped = inner.replace(/[:\s]?\*$/, '').trim();
  if (!stripped || stripped === '*') return true;
  const escaped = stripped.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '(?:\\s|$)');
  return re.test(String(input || '').trimStart());
}

// FIXED menu.js broadcastMenuToChat: NO _supersedeStaleMenus call. We
// model this by asserting that after registering a second pending menu,
// the first's chat-row meta.superseded stays falsy.
function fakeBroadcastMenuToChat(rec, menu) {
  if (!Array.isArray(rec.chat)) rec.chat = [];
  // FIXED: no supersede sweep here. (Pre-fix: this is where the bug
  // marked older unanswered menus as superseded.)
  rec.chat.push({
    user: 'claude',
    text: '🤔 Claude wants permission to run …',
    ts: new Date().toISOString(),
    meta: { kind: 'menu', menu, answered: false },
  });
}

// FIXED attach.js bare-digit shortcut: targets oldest pending menu (FIFO).
function fakeBareDigitDispatch(session, digit) {
  const target = session.oldestPendingMenu;
  if (!target) return { dispatched: false, reason: 'no-pending' };
  return { dispatched: true, hash: target.hash, n: digit, totalPending: session.pendingMenus.size };
}

// ──────────────────────────────────────────────────────────────────────────

console.log('── bug-21: parallel permission_requests deadlock ──');

t('two parallel canUseTool fires register independent Map entries', async () => {
  const rec = { allowList: [], denyList: [] };
  const s = new FakeAgentSession(rec);
  const pA = s._handlePermissionRequest('Bash', { command: 'git status' }, { toolUseID: 'A' });
  const pB = s._handlePermissionRequest('WebFetch', { url: 'https://example.com' }, { toolUseID: 'B' });
  // Both menus registered, neither overwritten.
  assert.strictEqual(s.pendingMenus.size, 2,
    `expected 2 pendingMenus after 2 parallel canUseTool fires, got ${s.pendingMenus.size}`);
  assert.ok(s.pendingMenus.has('agent-A'), 'menu A still in pendingMenus');
  assert.ok(s.pendingMenus.has('agent-B'), 'menu B still in pendingMenus');
  // Resolve both — both promises must settle.
  s.resolveMenuPick('agent-A', 1);
  s.resolveMenuPick('agent-B', 1);
  const [rA, rB] = await Promise.all([pA, pB]);
  assert.strictEqual(rA.behavior, 'allow');
  assert.strictEqual(rB.behavior, 'allow');
});

t('resolving one menu does NOT clear the other (no single-slot overwrite)', () => {
  const rec = { allowList: [], denyList: [] };
  const s = new FakeAgentSession(rec);
  s._handlePermissionRequest('Bash', { command: 'ls' }, { toolUseID: 'A' });
  s._handlePermissionRequest('WebFetch', { url: 'https://x' }, { toolUseID: 'B' });
  s.resolveMenuPick('agent-A', 1);
  // After resolving A, B must still be alive in BOTH the resolver map
  // AND the menu map (so a refreshing client still sees it).
  assert.strictEqual(s._pendingPermissions.size, 1, 'B resolver still pending');
  assert.strictEqual(s.pendingMenus.size, 1, 'B menu still in pendingMenus');
  assert.ok(s.pendingMenus.has('agent-B'), 'B menu specifically');
});

t('pendingMenu getter returns the most recent (back-compat for old single-slot readers)', () => {
  const s = new FakeAgentSession({ allowList: [], denyList: [] });
  s._handlePermissionRequest('Bash', { command: 'ls' }, { toolUseID: 'A' });
  s._handlePermissionRequest('WebFetch', { url: 'https://x' }, { toolUseID: 'B' });
  assert.ok(s.pendingMenu, 'getter returns something');
  assert.strictEqual(s.pendingMenu.hash, 'agent-B',
    'most-recently-added menu is what the back-compat getter exposes');
});

t('bare-digit shortcut targets OLDEST pending menu when multiple (FIFO)', () => {
  const s = new FakeAgentSession({ allowList: [], denyList: [] });
  s._handlePermissionRequest('Bash', { command: 'ls' }, { toolUseID: 'A' });
  s._handlePermissionRequest('WebFetch', { url: 'https://x' }, { toolUseID: 'B' });
  s._handlePermissionRequest('Read', { file_path: '/etc/hosts' }, { toolUseID: 'C' });
  const dispatch = fakeBareDigitDispatch(s, 1);
  assert.strictEqual(dispatch.dispatched, true);
  assert.strictEqual(dispatch.hash, 'agent-A',
    'oldest-first FIFO: A is the head of the queue');
  assert.strictEqual(dispatch.totalPending, 3,
    'reports total pending count so chat note can clarify');
});

t('bare-digit shortcut with no pending menu reports cleanly', () => {
  const s = new FakeAgentSession({ allowList: [], denyList: [] });
  const dispatch = fakeBareDigitDispatch(s, 1);
  assert.strictEqual(dispatch.dispatched, false);
  assert.strictEqual(dispatch.reason, 'no-pending');
});

t('Allow always on menu B retroactively resolves matching pending menu A', async () => {
  const rec = { allowList: [], denyList: [] };
  const s = new FakeAgentSession(rec);
  // Two parallel Bash calls — same command shape.
  const pA = s._handlePermissionRequest('Bash', { command: 'git status' }, { toolUseID: 'A' });
  const pB = s._handlePermissionRequest('Bash', { command: 'git diff' }, { toolUseID: 'B' });
  // User picks "Allow always" on B with persisted rule "Bash(git)".
  // (In the in-test setup, resolveMenuPick(_, 2) auto-derives the
  // pattern from the pending input — here matchingInputFor returns
  // "git diff", so the saved pattern is `Bash(git diff)` which only
  // matches "git diff", not "git status". To make the retroactive-
  // resolve case real, we pre-seed the broader rule via /allow
  // before clicking n=2. This mirrors the production flow where the
  // saved rule from suggestions.echoBack can be broader than the exact
  // command.)
  rec.allowList.push('Bash(git)');
  s.resolveMenuPick('agent-B', 2);
  // A must auto-resolve because Bash(git) now matches "git status".
  const rA = await pA;
  assert.strictEqual(rA.behavior, 'allow', 'A auto-allowed by sibling rule');
  // A's resolution should be marked auto:true for transparency.
  const autoEvent = s.events.find((e) =>
    e.type === 'permission_resolved' && e.hash === 'agent-A' && e.auto === true);
  assert.ok(autoEvent, 'emits permission_resolved with auto:true for retroactive resolve');
  assert.match(autoEvent.reason || '', /sibling|allow always|rule/i,
    'reason explains the retroactive auto-resolve');
  // B itself resolved normally (not auto).
  const rB = await pB;
  assert.strictEqual(rB.behavior, 'allow');
});

t('Allow always on menu B does NOT touch pending menus whose tool differs', async () => {
  const rec = { allowList: [], denyList: [] };
  const s = new FakeAgentSession(rec);
  const pA = s._handlePermissionRequest('WebFetch', { url: 'https://x' }, { toolUseID: 'A' });
  const pB = s._handlePermissionRequest('Bash', { command: 'git diff' }, { toolUseID: 'B' });
  rec.allowList.push('Bash(git)');
  s.resolveMenuPick('agent-B', 2);
  // A is WebFetch — Bash(git) doesn't match. A must still be pending.
  assert.ok(s._pendingPermissions.has('agent-A'), 'A still pending — different tool');
  assert.ok(s.pendingMenus.has('agent-A'), 'A still in pendingMenus');
  // Now resolve A explicitly so the test doesn't leak a hanging promise.
  s.resolveMenuPick('agent-A', 1);
  await pA;
  await pB;
});

t('Deny on menu B does NOT auto-resolve any pending menu (no rule saved)', async () => {
  const rec = { allowList: [], denyList: [] };
  const s = new FakeAgentSession(rec);
  const pA = s._handlePermissionRequest('Bash', { command: 'git status' }, { toolUseID: 'A' });
  const pB = s._handlePermissionRequest('Bash', { command: 'git diff' }, { toolUseID: 'B' });
  s.resolveMenuPick('agent-B', 3);  // Deny
  // A is untouched — Deny doesn't save a rule, doesn't trigger re-evaluate.
  assert.ok(s._pendingPermissions.has('agent-A'), 'A still pending after B deny');
  assert.ok(s.pendingMenus.has('agent-A'), 'A still in pendingMenus');
  s.resolveMenuPick('agent-A', 1);
  await Promise.all([pA, pB]);
});

t('new menu arriving does NOT mark prior unanswered menu as superseded', () => {
  // Pre-fix: menu.js _supersedeStaleMenus was called inside
  // broadcastMenuToChat, so as soon as menuB landed in chat menuA
  // was stamped meta.superseded=true and the chat-pane button was
  // grayed out. FIXED broadcastMenuToChat does not call _supersedeStaleMenus.
  const rec = { chat: [] };
  fakeBroadcastMenuToChat(rec, { hash: 'agent-A', kind: 'permission', options: [] });
  fakeBroadcastMenuToChat(rec, { hash: 'agent-B', kind: 'permission', options: [] });
  assert.strictEqual(rec.chat.length, 2);
  assert.strictEqual(rec.chat[0].meta.superseded, undefined,
    'menu A NOT stamped superseded just because menu B arrived');
  assert.strictEqual(rec.chat[0].meta.answered, false, 'menu A still unanswered');
});

t('three parallel menus all resolve independently', async () => {
  const s = new FakeAgentSession({ allowList: [], denyList: [] });
  const ps = ['A', 'B', 'C'].map((id, i) =>
    s._handlePermissionRequest('Bash', { command: 'cmd' + i }, { toolUseID: id }));
  assert.strictEqual(s.pendingMenus.size, 3);
  s.resolveMenuPick('agent-B', 1);  // middle first
  s.resolveMenuPick('agent-A', 3);  // oldest deny
  s.resolveMenuPick('agent-C', 1);  // newest last
  const [rA, rB, rC] = await Promise.all(ps);
  assert.strictEqual(rA.behavior, 'deny');
  assert.strictEqual(rB.behavior, 'allow');
  assert.strictEqual(rC.behavior, 'allow');
  assert.strictEqual(s.pendingMenus.size, 0, 'all menus cleared');
  assert.strictEqual(s._pendingPermissions.size, 0, 'all resolvers cleared');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards — anchor the fix shape onto prod source so a future
// refactor can't silently regress to single-slot pendingMenu.

const PROD_AGENT = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
const PROD_MENU = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'menu.js'), 'utf8');
const PROD_ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

t('agent-session.js declares pendingMenus as a Map', () => {
  assert.match(PROD_AGENT, /this\.pendingMenus\s*=\s*new\s+Map\s*\(\s*\)/,
    'pendingMenus Map<hash, menu> must be initialised in the constructor');
});

t('agent-session.js sets pendingMenus by hash (NOT single-slot)', () => {
  assert.match(PROD_AGENT, /this\.pendingMenus\.set\s*\([^)]*hash/i,
    'permission/ask paths must store via pendingMenus.set(hash, …)');
});

t('agent-session.js no longer overwrites pendingMenu single-slot in canUseTool', () => {
  // Allow the back-compat getter declaration to keep the word
  // "pendingMenu" — but disallow plain assignments like
  // "this.pendingMenu = menu" or "this.pendingMenu = null" in the
  // permission-request / ask-question paths.
  const overwrites = PROD_AGENT.match(/this\.pendingMenu\s*=\s*(?:menu|null)\b/g) || [];
  assert.strictEqual(overwrites.length, 0,
    `single-slot assignment pattern still present (${overwrites.length}): ` +
    'pendingMenu must be a getter, not a writable field. ' +
    'Use pendingMenus.set(hash, menu) / pendingMenus.delete(hash) instead.');
});

t('agent-session.js has a re-evaluate hook for newly-saved Allow always rules', () => {
  assert.match(PROD_AGENT, /_reevaluatePendingAfterAllowAlways/,
    '_reevaluatePendingAfterAllowAlways must exist + be called from resolveMenuPick');
});

t('menu.js broadcastMenuToChat does NOT call _supersedeStaleMenus', () => {
  // Find the broadcastMenuToChat body and assert _supersedeStaleMenus
  // is NOT called from inside it. The function itself can still exist
  // for sessions.ensureLiveSession to call on respawn (that's a
  // genuinely-stale case — the AgentSession died, those resolvers are
  // dead promises). What we forbid is the supersede-on-broadcast trigger.
  const fnStart = PROD_MENU.search(/function\s+broadcastMenuToChat\b/);
  assert.ok(fnStart > -1, 'broadcastMenuToChat must exist');
  // Find next top-level function or end of file
  const restAfter = PROD_MENU.slice(fnStart);
  const nextFn = restAfter.slice(1).search(/\nfunction\s+[A-Za-z_]/);
  const body = nextFn === -1 ? restAfter : restAfter.slice(0, nextFn + 1);
  assert.ok(!/_supersedeStaleMenus\s*\(/.test(body),
    'broadcastMenuToChat must NOT call _supersedeStaleMenus — that supersedes ' +
    'sibling parallel menus and was the bug-21 root cause. The supersede sweep ' +
    'only runs on actual resolve (or AgentSession respawn from sessions.js).');
});

t('attach.js bare-digit shortcut uses oldest-pending FIFO selector', () => {
  // We accept either an explicit `oldestPendingMenu` reference OR an
  // iteration over pendingMenus.values() that breaks on the first hit
  // — both express "head of queue" semantics. What we forbid is the
  // back-compat `session.pendingMenu` (which now returns the NEWEST,
  // not oldest) being used in the bare-digit path. Anchor on the
  // distinctive `handleMenuPick(sessionId, session, asDigit, hash)`
  // call rather than a bare "handleMenuPick" (which would also match
  // the comment's first mention 49 chars in).
  const window = PROD_ATTACH.match(
    /Bare-digit menu pick[\s\S]{0,2000}handleMenuPick\s*\(\s*sessionId\s*,\s*session\s*,\s*asDigit/);
  assert.ok(window, 'bare-digit pick block (up through handleMenuPick call site) must still exist');
  const block = window[0];
  assert.ok(
    /oldestPendingMenu|pendingMenus\.values\(\)|for\s*\([^)]*of\s+(?:this\.)?pendingMenus/.test(block),
    'bare-digit shortcut must iterate pendingMenus / use oldestPendingMenu, ' +
    'not the back-compat session.pendingMenu single getter (which returns newest)');
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
