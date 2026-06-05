// bug-67 round 2: permission_resolved (and turn_result) must fold
// into the chrome batch above EVEN when a menu card sits between.
//
// User-reported repro (2026-06-05 trace at 11:59):
//   11:59:36 ▸ × 2 running: WebSearch        ← batch 1 (tool_use + perm_request)
//   11:59:36   🌐 WebSearch "Shenzhen weather"
//   11:59:36   ⊕ perm asked WebSearch
//   11:59:40 ▸ × 2 ✓ result · 2118 bytes     ← batch 2 (perm_resolved + tool_result)
//   11:59:40   ⊕ perm allow-once WebSearch
//   11:59:44   ✓ result 2118 bytes
// Expected: ONE batch with all 4 chrome events.
//
// Root cause: broadcastMenuToChat (menu.js:74) appends a
// `.chat-msg.chat-msg-menu` div to #chat-messages as the user's
// interaction surface for the perm-ask. Between perm_request and
// perm_resolved (4s of user think-time), the menu card is the
// `pane.lastElementChild` — not the chrome batch. The bug-67 r1
// always-folds check (`prev.dataset.evType === '_chrome_batch'`)
// fails, ELSE branch creates a fresh batch.
//
// Fix: new helper `_findChromeBatchAcrossMenus(pane)` in
// web/public/app.js walks backward from pane.lastElementChild,
// skipping only chat-msg-menu / chat-msg-menu-collapsed elements,
// stopping at any other non-chrome element. Wire it into the
// chrome-routing block — when the incoming event is always-fold
// (perm_request, perm_resolved, turn_result) AND prev isn't
// directly chrome batch, use the lookback. Non-perm chrome events
// (tool_use, tool_result, hook_*) keep the strict adjacency rule.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── bug-67 r2: perm_resolved folds across menu card ──');

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────
// PART A — Static guards on the prod implementation
// ─────────────────────────────────────────────────────────────────

t('helper _findChromeBatchAcrossMenus is defined in app.js', () => {
  assert.ok(/function\s+_findChromeBatchAcrossMenus\s*\(\s*pane\s*\)/.test(APP),
    'helper _findChromeBatchAcrossMenus(pane) must be defined');
});

t('helper walks backward across chat-msg-menu / chat-msg-menu-collapsed', () => {
  const m = APP.match(/function\s+_findChromeBatchAcrossMenus\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'helper body must be greppable');
  const body = m[1];
  // Must reference both menu class variants — collapsed (resolved)
  // and active.
  assert.ok(/['"`]chat-msg-menu['"`]/.test(body),
    'helper must check for `chat-msg-menu` class');
  assert.ok(/['"`]chat-msg-menu-collapsed['"`]/.test(body),
    'helper must check for `chat-msg-menu-collapsed` class (resolved menus)');
  // Stop on _chrome_batch — that's the target we're hunting for.
  assert.ok(/_chrome_batch/.test(body),
    'helper must stop when it finds a _chrome_batch element');
  // Walk backward via previousElementSibling.
  assert.ok(/previousElementSibling/.test(body),
    'helper must walk backward via previousElementSibling');
});

t('chrome-routing block invokes the helper for always-fold events', () => {
  // The call must sit inside _appendAgentEvent, gated on alwaysFolds.
  const fnStart = APP.search(/function\s+_appendAgentEvent\s*\(/);
  assert.ok(fnStart > -1, '_appendAgentEvent must exist');
  const fnSlice = APP.slice(fnStart, fnStart + 80000);
  assert.ok(/_findChromeBatchAcrossMenus\s*\(\s*pane\s*\)/.test(fnSlice),
    '_appendAgentEvent must call _findChromeBatchAcrossMenus(pane)');
  // The call must be gated on alwaysFolds — non-perm chrome events
  // must NOT engage the lookback.
  const callBlock = fnSlice.match(/else if\s*\(\s*alwaysFolds\s*\)\s*\{[\s\S]{0,200}?_findChromeBatchAcrossMenus/);
  assert.ok(callBlock,
    'the call to _findChromeBatchAcrossMenus must be gated by `else if (alwaysFolds)` so non-perm chrome events keep strict adjacency');
});

t('bug-67 r1 chrome-batch direct-prev path still exists (fast path preserved)', () => {
  // Defense: the lookback is the FALLBACK, not the primary path.
  // When prev IS directly the chrome batch, no lookback should run
  // (the existing prev.dataset.evType === '_chrome_batch' check
  // handles it).
  const fnStart = APP.search(/function\s+_appendAgentEvent\s*\(/);
  const fnSlice = APP.slice(fnStart, fnStart + 80000);
  assert.ok(/prev\.dataset\.evType\s*===\s*['"]_chrome_batch['"]/.test(fnSlice),
    'direct-prev chrome-batch check must remain in _appendAgentEvent — the lookback is the fallback only');
});

// ─────────────────────────────────────────────────────────────────
// PART B — Behavioral simulation of _findChromeBatchAcrossMenus
// ─────────────────────────────────────────────────────────────────

// Inlined reference (must mirror the prod helper). Static guards
// above pin the prod version's contract.
function _findChromeBatchAcrossMenus(pane) {
  let el = pane && pane.lastElementChild;
  while (el) {
    if (el.dataset && el.dataset.evType === '_chrome_batch') return el;
    if (el.classList && (
        el.classList.contains('chat-msg-menu') ||
        el.classList.contains('chat-msg-menu-collapsed'))) {
      el = el.previousElementSibling;
      continue;
    }
    return null;
  }
  return null;
}

// Fake-DOM helpers. classList implemented as a Set wrapped in the
// minimal shape the helper needs.
function makeClassList(...names) {
  const set = new Set(names);
  return {
    contains(name) { return set.has(name); },
    add(name) { set.add(name); },
  };
}
function makeChromeBatch(label) {
  return {
    _label: label || 'chrome',
    dataset: { evType: '_chrome_batch' },
    classList: makeClassList('agent-card'),
    previousElementSibling: null,
  };
}
function makeMenuCard(opts = {}) {
  const cls = ['chat-msg', 'chat-msg-menu'];
  if (opts.collapsed) cls.push('chat-msg-menu-collapsed');
  return {
    _label: 'menu',
    dataset: {},
    classList: makeClassList(...cls),
    previousElementSibling: null,
  };
}
function makeChatMsg() {
  return {
    _label: 'chat-msg',
    dataset: {},
    classList: makeClassList('chat-msg'),
    previousElementSibling: null,
  };
}
function makeAssistantText() {
  return {
    _label: 'assistant_text',
    dataset: { evType: 'assistant_text' },
    classList: makeClassList('agent-card'),
    previousElementSibling: null,
  };
}
function makePane(...children) {
  // Wire previousElementSibling pointers.
  for (let i = 0; i < children.length; i++) {
    children[i].previousElementSibling = i > 0 ? children[i - 1] : null;
  }
  return {
    lastElementChild: children[children.length - 1] || null,
  };
}

t('lookback finds chrome_batch when prev is a single chat-msg-menu', () => {
  const batch = makeChromeBatch('B1');
  const menu = makeMenuCard();
  const pane = makePane(batch, menu);
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, batch, 'lookback must skip the menu card and return the chrome batch beneath');
});

t('lookback finds chrome_batch when prev is a chat-msg-menu-collapsed (resolved menu)', () => {
  const batch = makeChromeBatch('B1');
  const menu = makeMenuCard({ collapsed: true });
  const pane = makePane(batch, menu);
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, batch, 'lookback must also skip resolved menus (chat-msg-menu-collapsed)');
});

t('lookback finds chrome_batch when prev is multiple menu cards stacked', () => {
  const batch = makeChromeBatch('B1');
  const menu1 = makeMenuCard();
  const menu2 = makeMenuCard({ collapsed: true });
  const pane = makePane(batch, menu1, menu2);
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, batch, 'lookback must walk past multiple consecutive menu cards');
});

t('lookback returns null when prev is a real chat-msg (NOT a menu)', () => {
  const batch = makeChromeBatch('B1');
  const realMsg = makeChatMsg();
  const pane = makePane(batch, realMsg);
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, null, 'lookback must STOP at a real chat-msg — that is a real semantic break');
});

t('lookback returns null when prev is an assistant_text card', () => {
  const batch = makeChromeBatch('B1');
  const text = makeAssistantText();
  const pane = makePane(batch, text);
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, null, 'lookback must stop at assistant_text — a real semantic break');
});

t('lookback returns null when pane is empty', () => {
  const pane = makePane();
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, null, 'lookback on empty pane returns null');
});

t('lookback returns null when pane has only menu cards (no chrome batch underneath)', () => {
  const menu1 = makeMenuCard();
  const menu2 = makeMenuCard();
  const pane = makePane(menu1, menu2);
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, null, 'lookback exhausts its walk without finding a chrome batch → null');
});

t('lookback returns immediately when prev IS already chrome_batch (fast path)', () => {
  const batch = makeChromeBatch('B1');
  const pane = makePane(batch);
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, batch);
});

t('lookback returns null when chrome_batch is BEFORE a real chat-msg + menu (the chat breaks it)', () => {
  // [chrome_batch, real_chat_msg, menu_card]
  // Walking from tail: menu_card → skip → real_chat_msg → STOP → return null.
  // The chrome batch exists but the chat-msg breaks the lookback.
  const batch = makeChromeBatch('B1');
  const realMsg = makeChatMsg();
  const menu = makeMenuCard();
  const pane = makePane(batch, realMsg, menu);
  const found = _findChromeBatchAcrossMenus(pane);
  assert.strictEqual(found, null, 'lookback must NOT cross a real chat-msg even if a menu card follows it');
});

// ─────────────────────────────────────────────────────────────────
// PART C — End-to-end repro of the user-reported scenario
// ─────────────────────────────────────────────────────────────────

// Simulate the routing decision: given the pane state and an
// incoming chrome event, return whether it folds into an existing
// batch and which one.
// bug-67 r3 added tool_result to the always-folds set.
function _chromeEventAlwaysFolds(ev) {
  if (!ev || !ev.type) return false;
  return ev.type === 'turn_result'
      || ev.type === 'permission_request'
      || ev.type === 'permission_resolved'
      || ev.type === 'tool_result';
}
function simulateChromeRouting(pane, ev) {
  const prev = pane.lastElementChild;
  const alwaysFolds = _chromeEventAlwaysFolds(ev);
  let foldTarget = null;
  if (prev && prev.dataset && prev.dataset.evType === '_chrome_batch') {
    foldTarget = prev;
  } else if (alwaysFolds) {
    foldTarget = _findChromeBatchAcrossMenus(pane);
  }
  return foldTarget; // null = new batch would be created
}

t('end-to-end: user repro — tool_use → perm_request → menu → perm_resolved → tool_result yields ONE batch', () => {
  // Build the state at each step and verify the routing decision.
  const batch = makeChromeBatch('B1');
  // Step 1: tool_use folded into batch (already there).
  // Step 2: perm_request folded into batch (bug-67 r1).
  // Step 3: menu card appended after batch.
  const menu = makeMenuCard();
  let pane = makePane(batch, menu);

  // Step 4: perm_resolved arrives. It should fold into batch via
  // the cross-menu lookback (bug-67 r2 fix).
  const permResolved = { type: 'permission_resolved', toolName: 'WebSearch', decision: 'allow-once', seq: 100 };
  const target = simulateChromeRouting(pane, permResolved);
  assert.strictEqual(target, batch,
    'perm_resolved must fold into the chrome batch even though a menu card displaces it from prev — this is the bug-67 r2 fix');

  // Step 5: After the fold, the menu card transitions to collapsed
  // (server marks it resolved). The tool_result arrives next.
  menu.classList.add('chat-msg-menu-collapsed');
  const toolResult = { type: 'tool_result', tool_use_id: 'toolu_x', content: 'x'.repeat(2118), seq: 101 };
  // bug-67 r3 (follow-up after user report 2026-06-05 17:01):
  // tool_result was moved INTO _chromeEventAlwaysFolds so the
  // lookback also engages for tool_result events arriving after
  // a menu card. The user-reported repro at 17:00 showed
  // `× 1 ✓ result · 2301 bytes` as a separate batch — bug-67 r3
  // fixes that. tool_result now folds into batch 1 via the same
  // _findChromeBatchAcrossMenus path.
  const tr_target = simulateChromeRouting(pane, toolResult);
  assert.strictEqual(tr_target, batch,
    'tool_result post-menu MUST fold into the chrome batch via _findChromeBatchAcrossMenus (bug-67 r3) — yielding ONE unified batch for the entire tool-call lifecycle');
});

t('end-to-end (bug-67 r3): tool_result post-menu folds into the chrome batch', () => {
  // Direct repro of the user-reported 2026-06-05 17:01 trace:
  //   batch_1 = [tool_use ToolSearch, tool_result, …, perm_request, perm_resolved]
  //   menu_card (collapsed after click)
  //   tool_result (2301 bytes WebSearch result) — was its own batch pre-r3.
  const batch = makeChromeBatch('B1');
  const menu = makeMenuCard({ collapsed: true });
  const pane = makePane(batch, menu);
  const tr = { type: 'tool_result', tool_use_id: 'toolu_WS', content: 'x'.repeat(2301), seq: 99 };
  const target = simulateChromeRouting(pane, tr);
  assert.strictEqual(target, batch,
    'bug-67 r3: tool_result must fold into chrome_batch even when a collapsed menu card sits between');
});

t('end-to-end (bug-67 r3): tool_result still breaks batch when prev is a REAL chat-msg', () => {
  // Defense: tool_result joining always-folds must NOT cause it to
  // retro-merge across REAL semantic breaks. The _findChromeBatchAcrossMenus
  // helper stops at any non-menu non-chrome element, including real
  // chat-msg bubbles. So tool_result + [batch, chat_msg] yields null
  // (fresh batch is correct).
  const batch = makeChromeBatch('B1');
  const realMsg = makeChatMsg();
  const pane = makePane(batch, realMsg);
  const tr = { type: 'tool_result', tool_use_id: 'toolu_x', content: 'hi', seq: 50 };
  const target = simulateChromeRouting(pane, tr);
  assert.strictEqual(target, null,
    'bug-67 r3: tool_result after a real chat-msg must NOT retro-merge across the semantic break');
});

t('end-to-end: chat-msg between batch and menu correctly breaks the chain', () => {
  // [chrome_batch, real_chat_msg, menu_card] → perm_resolved arrives.
  // The real chat-msg is a semantic break → fresh batch must start,
  // NOT fold into the older chrome batch (that would be misleading).
  const batch = makeChromeBatch('B1');
  const realMsg = makeChatMsg();
  const menu = makeMenuCard();
  const pane = makePane(batch, realMsg, menu);
  const permResolved = { type: 'permission_resolved', toolName: 'Bash', seq: 50 };
  const target = simulateChromeRouting(pane, permResolved);
  assert.strictEqual(target, null,
    'a real chat-msg between the chrome batch and the menu card must break the lookback — fresh batch is correct here');
});

t('end-to-end: non-perm chrome event (tool_use) with menu prev does NOT engage lookback', () => {
  // Strict adjacency for non-perm events: tool_use arriving after a
  // menu card must NOT retro-merge into an older chrome batch.
  const batch = makeChromeBatch('B1');
  const menu = makeMenuCard();
  const pane = makePane(batch, menu);
  const toolUse = { type: 'tool_use', name: 'Bash', seq: 100 };
  const target = simulateChromeRouting(pane, toolUse);
  assert.strictEqual(target, null,
    'tool_use is NOT in always-folds → lookback must not engage. Strict adjacency means new batch.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
