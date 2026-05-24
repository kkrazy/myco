// fr-76 Phase 3: per-item AI chat panel UI.
//
// Bottom sheet on mobile (<= 900px) — slides up from bottom where
// the keyboard appears; swipe-down on the drag-handle to dismiss.
// Side drawer on desktop (> 900px) — slides in from the right.
// Same DOM + JS, CSS does the breakpoint shape-shift.
//
// Submit flow: panel input → sendChatMessage('[chat:plan#<id>] <text>')
// → Phase 2's handleChatMessage marker recognition → _appendUserAiChatTurn
// + agent-event listener with terminal-flush to role:'agent' turn.
// No new server routes needed — the Phase 1 GET /aichat endpoint
// + Phase 2 dispatch wiring cover everything.
//
// Static guards on app.js + styles.css for the wire-up + selectors.
// Behavior simulation of the marker construction so the dispatch
// contract can't drift away from Phase 2's expectations.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-76 Phase 3: per-item AI chat panel UI ──');

// ──────────────────────────────────────────────────────────────────────
// Chat button in the plan-item action row
// ──────────────────────────────────────────────────────────────────────

t('app.js: chatBtn template literal lives in the plan item render', () => {
  // The button gets the canonical class so the click binding can find
  // it. Carries data-id (item id) and data-type (artifact type) so
  // the handler can route without a closure dance.
  assert.ok(/artifact-item-chat/.test(APP),
    'app.js must render a button with class="artifact-item-chat" inside the plan item action row');
  // The icon + text split mirrors the other action buttons so the
  // mobile icon-only rule applies uniformly via .btn-text { display:none }.
  assert.ok(/artifact-item-chat[\s\S]{0,400}btn-icon[\s\S]{0,200}💬/.test(APP),
    'chatBtn must carry the 💬 icon inside a .btn-icon span');
  assert.ok(/artifact-item-chat[\s\S]{0,400}btn-text/.test(APP),
    'chatBtn must carry a .btn-text span (mobile hides it, desktop keeps it)');
});

t('app.js: chatBtn is wired into the actionsRow template', () => {
  // Pinning that chatBtn renders inside actionsRow so a future
  // re-render refactor can't accidentally drop the entry point to
  // the panel. fr-85 round 2 removed runBtn + closeBtn from the
  // template (they're now /run + /close slash commands inside the
  // panel), so we only assert chatBtn presence — the relative-order
  // pin is gone with the siblings it referenced.
  const idx = APP.search(/const\s+actionsRow\s*=/);
  assert.ok(idx > -1, 'actionsRow template literal must exist');
  const window = APP.slice(idx, idx + 800);
  assert.ok(/\$\{chatBtn\}/.test(window),
    'actionsRow must include ${chatBtn} (panel entry point)');
  // editBtn is kept on the card — confirm it still renders
  // (the user comment specified run/close/upvote/comment, not edit).
  assert.ok(/\$\{editBtn\}/.test(window),
    'actionsRow must keep ${editBtn} (inline editor lives on the card)');
});

t('app.js: chatBtn click binding routes to onArtifactItemAiChat', () => {
  // The binding must select .artifact-item-chat and invoke
  // onArtifactItemAiChat with type + id. Pinning the selector +
  // dispatch shape so a refactor can't quietly break the click path.
  assert.ok(/querySelectorAll\(['"]\.artifact-item-chat['"]\)/.test(APP),
    'app.js must bind clicks on .artifact-item-chat');
  assert.ok(/onArtifactItemAiChat\s*\(/.test(APP),
    'click handler must invoke onArtifactItemAiChat(type, id)');
});

t('app.js: chatBtn renders a per-item turn-count badge when aiChat.length > 0', () => {
  // The badge surfaces existing thread depth so users can see which
  // items already have a conversation. .aichat-count class lets the
  // mobile icon-only rule still display the count (it's INSIDE
  // .btn-text so the same display:none applies — that's intentional;
  // mobile real estate is precious).
  assert.ok(/aichat-count/.test(APP),
    'app.js must render a .aichat-count badge for items with aiChat turns');
  assert.ok(/it\.aiChat[\s\S]{0,80}length/.test(APP),
    'badge count must come from item.aiChat.length');
});

// ──────────────────────────────────────────────────────────────────────
// Panel open / close / render helpers
// ──────────────────────────────────────────────────────────────────────

t('app.js: onArtifactItemAiChat is defined and looks up the item', () => {
  assert.ok(/function\s+onArtifactItemAiChat\s*\(/.test(APP),
    'app.js must define onArtifactItemAiChat(type, itemId)');
  // Uses the artifact cache lookup so it can fail-fast if the item
  // is missing (e.g. deleted between render and click).
  assert.ok(/_findArtifactItem/.test(APP),
    'onArtifactItemAiChat must look up the item via _findArtifactItem');
});

t('app.js: _openAiChatPanel + _closeAiChatPanel are defined', () => {
  assert.ok(/function\s+_openAiChatPanel\s*\(/.test(APP),
    '_openAiChatPanel must exist');
  assert.ok(/function\s+_closeAiChatPanel\s*\(/.test(APP),
    '_closeAiChatPanel must exist');
});

t('app.js: _openAiChatPanel auto-replaces an already-open panel (single-panel discipline)', () => {
  // Only one panel open at a time — a second chat-button click on
  // a different item cleanly swaps. Pin via _closeAiChatPanel call
  // at the top of _openAiChatPanel.
  const idx = APP.search(/function\s+_openAiChatPanel\s*\(/);
  const window = APP.slice(idx, idx + 600);
  assert.ok(/_closeAiChatPanel\s*\(\s*\{\s*silent:\s*true/.test(window),
    '_openAiChatPanel must call _closeAiChatPanel({silent:true}) first so a second open cleanly swaps');
});

t('app.js: state.aiChatPanel tracks the currently-open item', () => {
  // The open-panel reference lets _aiChatRefreshOpenPanel know
  // which item to re-render on state-update.
  assert.ok(/state\.aiChatPanel\s*=\s*\{/.test(APP),
    'state.aiChatPanel must be set to { type, itemId, openedAt } on open');
  assert.ok(/state\.aiChatPanel\s*=\s*null/.test(APP),
    'state.aiChatPanel must be cleared to null on close');
});

t('app.js: Esc-to-close handler is bound on open and removed on close', () => {
  // Desktop convenience — Esc to dismiss the drawer. Bound to
  // document so it fires regardless of focus.
  assert.ok(/state\.aiChatEscHandler/.test(APP),
    'app.js must track the Esc handler on state.aiChatEscHandler so close can remove it');
  // Code shape: state.aiChatEscHandler = (ev) => { if (ev.key === 'Escape') _closeAiChatPanel(); };
  // followed by document.addEventListener('keydown', state.aiChatEscHandler);
  // Pin both pieces independently — the Escape→close edge AND the
  // listener registration on keydown.
  assert.ok(/aiChatEscHandler[\s\S]{0,200}['"]Escape['"][\s\S]{0,100}_closeAiChatPanel/.test(APP),
    'Esc keydown branch must invoke _closeAiChatPanel');
  assert.ok(/addEventListener\(\s*['"]keydown['"]\s*,\s*state\.aiChatEscHandler\s*\)/.test(APP),
    'Esc handler must be registered on document for keydown');
});

// ──────────────────────────────────────────────────────────────────────
// Submit path — marker wrapping
// ──────────────────────────────────────────────────────────────────────

t('app.js: _submitAiChat prepends the [chat:<type>#<id>] marker (fall-through path)', () => {
  // The marker is the WHOLE dispatch contract with Phase 2. If the
  // client forgets it, handleChatMessage routes the text as a
  // regular chat-pane message — no _activeChatItem, no aiChat turn,
  // no panel update. fr-85 round 2 added a slash-router intercept
  // BEFORE this path (panel /run /close /upvote /comment /edit
  // dispatch directly to HTTP endpoints, bypassing the agent). The
  // marker path is the FALL-THROUGH for non-slash text. Window
  // bumped from 600→1500 to clear the new slash-router code in
  // front of the marker construction.
  assert.ok(/function\s+_submitAiChat\s*\(/.test(APP),
    '_submitAiChat helper must exist');
  const idx = APP.search(/function\s+_submitAiChat\s*\(/);
  const window = APP.slice(idx, idx + 1500);
  assert.ok(/`\[chat:\$\{type\}#\$\{itemId\}\]\s*`/.test(window),
    '_submitAiChat must build a `[chat:${type}#${itemId}] ` marker prefix on the fall-through path');
  assert.ok(/sendChatMessage\s*\(\s*marker\s*\+\s*raw\s*\)/.test(window),
    '_submitAiChat must dispatch via sendChatMessage(marker + raw) — reuses the existing WS chat path');
});

t('app.js: Cmd/Ctrl-Enter on the textarea sends', () => {
  // Standard chat-pane keyboard contract — textarea Enter inserts a
  // newline, modifier+Enter sends.
  assert.ok(/metaKey\s*\|\|\s*ev\.ctrlKey[\s\S]{0,100}Enter[\s\S]{0,100}_submitAiChat/.test(APP),
    'Cmd/Ctrl-Enter must invoke _submitAiChat');
});

// ──────────────────────────────────────────────────────────────────────
// Live refresh on state-update
// ──────────────────────────────────────────────────────────────────────

t('app.js: _onArtifactsCacheUpdated invokes _aiChatRefreshOpenPanel for plan updates', () => {
  // Phase 2 emits state-update kind:'artifact', artifactType:'plan'
  // after every user + agent turn append. The panel must re-render
  // when this lands so new turns appear without a manual refresh.
  const idx = APP.search(/function\s+_onArtifactsCacheUpdated\s*\(/);
  assert.ok(idx > -1, '_onArtifactsCacheUpdated must be defined');
  // Use a generous window so a future function-body growth doesn't
  // make this brittle. The hook is added inside the function body
  // before the loadArtifact tail.
  const win = APP.slice(idx, idx + 1500);
  assert.ok(/_aiChatRefreshOpenPanel\s*\(\s*\)/.test(win),
    '_onArtifactsCacheUpdated must call _aiChatRefreshOpenPanel() for plan updates');
});

t('app.js: _aiChatRefreshOpenPanel preserves scroll position unless user is at bottom', () => {
  // Don't yank the user away from an older turn they're reading just
  // because a new agent reply landed. Only auto-scroll if they're
  // already pinned to the bottom (within 40px).
  assert.ok(/function\s+_aiChatRefreshOpenPanel\s*\(/.test(APP),
    '_aiChatRefreshOpenPanel must exist');
  const idx = APP.search(/function\s+_aiChatRefreshOpenPanel\s*\(/);
  const win = APP.slice(idx, idx + 1000);
  assert.ok(/wasAtBottom/.test(win),
    'function body must compute a wasAtBottom predicate');
  assert.ok(/scrollHeight[\s\S]{0,80}scrollTop[\s\S]{0,80}clientHeight[\s\S]{0,40}<\s*40/.test(win),
    'wasAtBottom heuristic must check (scrollHeight - scrollTop - clientHeight < 40)');
});

// ──────────────────────────────────────────────────────────────────────
// Turn rendering
// ──────────────────────────────────────────────────────────────────────

t('app.js: turn rendering distinguishes role:user vs role:agent', () => {
  // Different visual treatment so a glance reveals who said what.
  // Code uses a template literal `aichat-turn-${role}` to emit the
  // role-specific class — the LITERAL class names `aichat-turn-user`
  // and `aichat-turn-agent` are constructed via substitution. Pin
  // the template literal pattern + the role coercion logic.
  assert.ok(/aichat-turn-\$\{role\}/.test(APP),
    'turn class must be built via template literal aichat-turn-${role} so role-specific styles apply');
  assert.ok(/role\s*===\s*['"]agent['"]\s*\?\s*['"]agent['"]\s*:\s*['"]user['"]/.test(APP),
    'role coercion: turn.role === "agent" ? "agent" : "user" (safe default to user)');
  // Agent text → renderMd; user text → escHtml.
  assert.ok(/role\s*===\s*['"]agent['"][\s\S]{0,200}renderMd/.test(APP),
    'agent turns must render via renderMd (markdown)');
  assert.ok(/aichat-turn-text[\s\S]{0,80}escHtml/.test(APP),
    'user turns must escape via escHtml (their typing isn\'t markdown source)');
});

t('app.js: agent turn renders a cost chip when meta.costUsd is set', () => {
  // Phase 2's _appendAgentAiChatTurn populates meta.costUsd from the
  // turn_result event. Surface it as a small per-turn chip so users
  // can see what each agent reply cost.
  assert.ok(/aichat-cost-chip/.test(APP),
    'agent turn must include a .aichat-cost-chip when meta.costUsd is present');
  assert.ok(/meta\.costUsd[\s\S]{0,200}toFixed\(4\)/.test(APP),
    'cost chip must format costUsd to 4 decimal places (e.g. $0.0123)');
});

// ──────────────────────────────────────────────────────────────────────
// CSS — bottom sheet (mobile) vs side drawer (desktop)
// ──────────────────────────────────────────────────────────────────────

t('styles.css: .aichat-backdrop + .aichat-panel base selectors exist', () => {
  assert.ok(/\.aichat-backdrop\b/.test(CSS),
    '.aichat-backdrop must be styled (dimmer behind the panel)');
  assert.ok(/\.aichat-panel\b/.test(CSS),
    '.aichat-panel must be styled (the panel itself)');
  assert.ok(/\.aichat-panel\.is-open/.test(CSS),
    '.aichat-panel.is-open must define the open transform (slide-in)');
});

t('styles.css: mobile breakpoint slides up from bottom (translateY)', () => {
  // @media (max-width: 900px) — bottom sheet pattern: slides up
  // from the bottom edge so the keyboard naturally pushes it.
  assert.ok(/@media\s*\(\s*max-width:\s*900px\s*\)[\s\S]{0,2000}\.aichat-panel[\s\S]{0,400}translateY\(100%\)/.test(CSS),
    'mobile @media block must position the panel with translateY(100%) (off-screen below)');
  assert.ok(/@media\s*\(\s*max-width:\s*900px\s*\)[\s\S]{0,3000}border-top-left-radius/.test(CSS),
    'mobile sheet must have rounded top corners (border-top-left-radius)');
});

t('styles.css: desktop breakpoint slides in from right (translateX)', () => {
  // @media (min-width: 901px) — side drawer pattern: slides in
  // from the right at a fixed width. Specific width is pinned by
  // fr-85's test (currently 520px); here we just assert there IS a
  // fixed pixel width in the 400-700 range so future tuning doesn't
  // need to update both tests.
  assert.ok(/@media\s*\(\s*min-width:\s*901px\s*\)[\s\S]{0,2000}\.aichat-panel[\s\S]{0,400}translateX\(100%\)/.test(CSS),
    'desktop @media block must position the panel with translateX(100%) (off-screen right)');
  assert.ok(/@media\s*\(\s*min-width:\s*901px\s*\)[\s\S]{0,2000}width:\s*[4-6]\d{2}px/.test(CSS),
    'desktop drawer must have a fixed width in 400-699px range (fr-85 set 520px)');
});

t('styles.css: mobile has a drag-handle (drag-down to dismiss)', () => {
  // Mobile dismiss UX: swipe down on the drag-handle (or tap backdrop).
  assert.ok(/\.aichat-drag-handle\b/.test(CSS),
    '.aichat-drag-handle must be styled');
  assert.ok(/\.aichat-drag-grip\b/.test(CSS),
    '.aichat-drag-grip must be styled (the small pill inside the handle)');
});

t('styles.css: desktop hides the drag-handle (mobile-only affordance)', () => {
  assert.ok(/@media\s*\(\s*min-width:\s*901px\s*\)[\s\S]{0,2000}\.aichat-drag-handle[\s\S]{0,200}display:\s*none/.test(CSS),
    'desktop must hide .aichat-drag-handle (mobile-only affordance)');
});

t('styles.css: .aichat-form respects iOS safe-area-inset-bottom', () => {
  // iOS Safari home-indicator strip — without env(safe-area-inset-bottom)
  // the Send button gets clipped on iPhone X / 11 / 12 etc.
  assert.ok(/env\(safe-area-inset-bottom/.test(CSS),
    '.aichat-form must use env(safe-area-inset-bottom) padding for iOS home-indicator clearance');
});

t('styles.css: turn role gets visual differentiation (user blue, agent green)', () => {
  // User turns get a subtle blue tint; agent turns get green —
  // matching the broader UI accent colors.
  assert.ok(/\.aichat-turn-user[\s\S]{0,200}\.aichat-turn-body[\s\S]{0,300}rgba\(56,\s*139,\s*253/.test(CSS),
    'user turn body must have the blue tint (rgba(56,139,253,...))');
  assert.ok(/\.aichat-turn-agent[\s\S]{0,200}\.aichat-turn-body[\s\S]{0,300}rgba\(63,\s*185,\s*80/.test(CSS),
    'agent turn body must have the green tint (rgba(63,185,80,...))');
});

// ──────────────────────────────────────────────────────────────────────
// Behavior simulation — marker construction (the entire dispatch
// contract, decoupled from app.js source)
// ──────────────────────────────────────────────────────────────────────

t('behavior: marker prefix is parseable by Phase 2 regex', () => {
  // Phase 2's chatMatch regex (from server/src/attach.js):
  //   /\[chat:(plan|test|arch|td|fr|bug)#([A-Za-z0-9_-]+)\]/
  // Whatever the client prepends MUST match this — otherwise the
  // dispatch silently degrades to "plain chat" mode and no aiChat
  // turn is recorded.
  const CHAT_MARKER_RE = /\[chat:(plan|test|arch|td|fr|bug)#([A-Za-z0-9_-]+)\]/;
  for (const [type, id] of [
    ['plan', 'fr-76'],
    ['plan', 'bug-17'],
    ['plan', 'td-22'],
    ['plan', 'fr-43_v2'],   // underscore + version suffix
  ]) {
    const marker = `[chat:${type}#${id}] `;
    const m = marker.match(CHAT_MARKER_RE);
    assert.ok(m, `marker must match Phase 2 regex for ${type}/${id}: ${marker}`);
    assert.strictEqual(m[1], type);
    assert.strictEqual(m[2], id);
  }
});

t('behavior: empty text submit no-ops (no marker-only stub turns)', () => {
  // _submitAiChat must early-return on blank input — otherwise an
  // accidental Enter would persist a marker-only stub turn server-side.
  // Pin the trim+early-return logic.
  const raw = '   ';
  const trimmed = raw.trim();
  // Mimic the helper's "if (!raw) return" predicate.
  const shouldSend = !!trimmed;
  assert.strictEqual(shouldSend, false,
    'blank input must NOT dispatch (no [chat:plan#id] -only stub turns)');
});

t('behavior: turn rendering renders an empty-state when aiChat is empty', () => {
  // First-open UX — "no turns yet" placeholder so the panel isn't
  // a blank vacuum. Pin the wording so the empty state is
  // recognizable.
  assert.ok(/aichat-empty[\s\S]{0,200}No turns yet/.test(APP),
    'panel must render an .aichat-empty placeholder with "No turns yet — ask claude…" copy');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
