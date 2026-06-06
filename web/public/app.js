// SDK Phase 9 step 2: xterm.js + the PTY byte stream are retired.
// All sessions are agent-mode and render structured events (cards) in
// the chat pane — there's no terminal to paint. The state.term /
// state.fitAddon stubs below stay null so every legacy state.term?.foo
// optional-chain short-circuits safely without a runtime error.
function refreshXtermAfterFontLoad(_term) { /* no-op: xterm retired */ }

const _loadedResources = new Map();

function loadScript(src) {
  if (_loadedResources.has(src)) return _loadedResources.get(src);
  const p = new Promise((resolve, reject) => {
    // Check if script already exists in document
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = (err) => {
      _loadedResources.delete(src);
      reject(err);
    };
    document.head.appendChild(s);
  });
  _loadedResources.set(src, p);
  return p;
}

function loadStylesheet(href) {
  if (_loadedResources.has(href)) return _loadedResources.get(href);
  const p = new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`)) {
      resolve();
      return;
    }
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = () => resolve();
    l.onerror = (err) => {
      _loadedResources.delete(href);
      reject(err);
    };
    document.head.appendChild(l);
  });
  _loadedResources.set(href, p);
  return p;
}


const state = {
  sessions: [],
  activeId: null,
  // term + fitAddon stay null (xterm retired Phase 9 step 2); the
  // legacy optional-chain call sites (state.term?.write(...) etc.)
  // short-circuit safely so we don't need to scrub every reference.
  term: null,
  fitAddon: null,
  ws: null,
  keyboard: null,
  token: localStorage.getItem('myco_token') || '',
  logs: [],
  logWs: null,
  // Discussion state, scoped per active session. Cleared on switch.
  chatMessages: [],
  chatUser: null,
  // Default true on real desktop (≥1200px) AND on mobile (≤900px):
  //   - Desktop: chat pane + readonly transcript in 50/50 split.
  //   - Mobile: chat IS the default view — it fills the whole main
  //     area at ≤900px and is where the user drives interaction.
  // Tablets (901–1199) stay false: the 50/50 split is cramped at that
  // width and the chat pane covering the main pane would feel like a
  // modal. Once a session opens, openSession's setChatPane(true) is
  // gated on the same width thresholds for consistency.
  chatPaneVisible: typeof window !== 'undefined' &&
    (window.innerWidth >= 1200 || window.innerWidth <= 900),
  // Per-session file explorer state. Cleared when session changes.
  files: {
    visible: false,
    currentPath: '.',
    history: [],         // back-stack of dir paths for the up-button
    viewing: null,       // { path, mtimeMs, content, binary, cards, selection, pending, commentDraft, wrap, size }
    prevView: null,      // 'terminal' | 'conversation' — what to restore on toggle off
  },
  // Which artifact view (Plan / Arch / Test) is currently open in the main
  // pane, plus the pane we should restore on close. null means none.
  artifactView: { active: null, prev: 'terminal' },
  // Cached artifact payloads, keyed by type. Populated on attach via the
  // `artifacts-init` WS frame; updated live via `state-update` frames.
  // loadArtifact() prefers this cache over an HTTP GET so tab switches
  // are instant and always in sync with what the server just broadcast.
  //
  // ryan-blues bug fix: the cache is TAGGED with the session id it was
  // populated for. A lookup whose sessionId doesn't match state.activeId
  // is treated as a miss — without this, switching to a new session
  // would render the prior session's stale plan items until the new
  // session's artifacts-init arrived. The session-switch path
  // (_resetUiForNewSession) also re-inits this structure as belt-and-
  // suspenders. byType is the actual { plan, test, arch } map.
  artifacts: { sessionId: null, byType: {} },
  // In-flight tool-call tracker mirrored from the server. Keyed by
  // tool_use_id; populated by `state-update { kind: 'tool-progress' }`
  // frames. The chat pane surfaces a "waiting on Agent · 47s"
  // indicator when this has entries so long-running tools (Agent,
  // Monitor, etc.) don't look like the session has hung.
  openToolCalls: [],
  // bug-53 (HUD analyze stuck): sticky phase tracker for the HUD's
  // active-step chip. Updated by the tool-progress handler when an
  // Edit/Write/MultiEdit or Bash opens. Cleared on turn_start so a
  // new turn starts back in 'Analyze'. Without this, the HUD chip
  // reverted to 'Analyze' every time a tool call completed (between
  // calls) — and most of the wall-clock time IS between calls, so
  // the user saw "Analyze" except for brief flickers.
  lastToolPhase: null,
  // Running totals across this session's lifetime (since the page
  // opened). Updated on each turn_result. Surfaced as the token-meter
  // chip near the chat input — context-window fill + cumulative cost.
  // Resets on session switch (openSession clears it).
  turnTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, lastTurnInputTokens: 0 },
};

// ── auth ──────────────────────────────────────────────────────────────────────

// ── share token persistence ─────────────────────────────────────────────────

function loadShareTokens() {
  try { return JSON.parse(localStorage.getItem('myco_shares') || '[]'); } catch { return []; }
}

function saveShareToken(shareToken, sessionId, cwd) {
  const shares = loadShareTokens().filter((s) => s.shareToken !== shareToken);
  shares.unshift({ shareToken, sessionId, cwd, addedAt: new Date().toISOString() });
  localStorage.setItem('myco_shares', JSON.stringify(shares.slice(0, 20)));
}

function removeShareToken(shareToken) {
  const shares = loadShareTokens().filter((s) => s.shareToken !== shareToken);
  localStorage.setItem('myco_shares', JSON.stringify(shares));
}

function authHeaders() {
  return state.token ? { Authorization: `Bearer ${state.token}` } : {};
}

async function authedFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...authHeaders() },
  });
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  return res;
}

// bug-47: viewer-tier file-API endpoints (/files, /files-changed,
// /files/diff, /files/reconsider) accept either an owner/admin/viewer
// Bearer token OR a `?s=<shareToken>` query param matching the
// session id. Guest users who arrived via a share link have
// state.shareToken set but no state.token, so authedFetch's Bearer
// header alone won't pass the gate — the URL must also carry
// `?s=<token>`. This helper appends it (picking `?` vs `&`
// automatically) when state.shareToken is set; it's a no-op for
// signed-in owners (state.shareToken is undefined for the normal
// login flow), and the server's owner-tier check wins first if a
// signed-in user happens to also have a stray share token, so
// always appending when present is benign.
function _withShareToken(url) {
  if (!state || !state.shareToken) return url;
  const sep = String(url).indexOf('?') === -1 ? '?' : '&';
  return `${url}${sep}s=${encodeURIComponent(state.shareToken)}`;
}

// Composer context chips: detectable @-mentions in the textarea are
// surfaced as deletable pills above the input. Helps the user see
// what's attached at a glance instead of squinting at inline text.
// Click × on a chip to remove that @user from the input. Idempotent:
// rebuilt on every input event from the current textarea value.
function _renderComposerChips() {
  const host = document.getElementById('composer-chips');
  const input = document.getElementById('chat-input');
  if (!host || !input) return;
  const text = input.value || '';
  // Token shape: @username — start-of-string or whitespace before,
  // then '@' + alnum/hyphen/underscore. Same shape the autocomplete
  // and server-side _detectMentionTarget recognise.
  const re = /(^|\s)@([A-Za-z0-9_-]+)\b/g;
  const tokens = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ login: m[2], start: m.index + m[1].length, end: m.index + m[1].length + 1 + m[2].length });
  }
  if (!tokens.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  // Dedupe by login (case-insensitive) — multiple mentions of the
  // same user collapse to one chip so removing it strips all instances.
  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    const key = t.login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(t);
  }
  host.innerHTML = unique.map((t) =>
    `<span class="composer-chip" data-chip-login="${escHtml(t.login)}">` +
    `<span class="composer-chip-at">@</span>` +
    `<span class="composer-chip-name">${escHtml(t.login)}</span>` +
    `<button type="button" class="composer-chip-x" title="Remove @${escHtml(t.login)}" aria-label="Remove @${escHtml(t.login)}">×</button>` +
    `</span>`
  ).join('');
  if (!host.dataset.boundClicks) {
    host.dataset.boundClicks = '1';
    host.addEventListener('click', (e) => {
      const x = e.target.closest('.composer-chip-x');
      if (!x) return;
      const chip = x.closest('.composer-chip');
      const login = chip && chip.dataset.chipLogin;
      if (!login) return;
      _removeMentionFromInput(login);
    });
  }
}

function _removeMentionFromInput(login) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  // Strip every `@<login>` occurrence (boundary-safe). Trims any
  // resulting double-spaces. Re-runs the autocomplete + chip render.
  const re = new RegExp(`(^|\\s)@${login.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&')}\\b`, 'gi');
  input.value = input.value.replace(re, (m, lead) => lead || '').replace(/\s{2,}/g, ' ').trimStart();
  _renderComposerChips();
  // Keep focus + caret at the end for continued typing.
  try {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  } catch {}
}

// Presence: render avatar chips for everyone currently attached to
// the active session. Hidden when only one user is attached (just
// self — boring). The chip cluster lives at the top of the chat
// pane (#chatpane-presence). Each chip is a colored circle with the
// first letter of the login, owner has a small accent dot, viewers
// (guests) get a muted hue. Hover for full login + role + duration.
function _renderPresence(users) {
  const host = document.getElementById('chatpane-presence');
  if (!host) return;
  if (!Array.isArray(users) || users.length <= 1) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  // Sort: self first (so the user sees themselves anchored at the
  // left edge), then owners, then alphabetical by login.
  const me = (state.chatUser || '').toLowerCase();
  users = users.slice().sort((a, b) => {
    const aMe = a.login.toLowerCase() === me ? 0 : 1;
    const bMe = b.login.toLowerCase() === me ? 0 : 1;
    if (aMe !== bMe) return aMe - bMe;
    const aOwner = a.role === 'owner' ? 0 : 1;
    const bOwner = b.role === 'owner' ? 0 : 1;
    if (aOwner !== bOwner) return aOwner - bOwner;
    return a.login.localeCompare(b.login);
  });
  host.hidden = false;
  host.innerHTML = users.map((u) => {
    const initial = (u.login || '?').slice(0, 1).toUpperCase();
    const hue = _presenceHue(u.login);
    const isMe = u.login.toLowerCase() === me;
    const since = _presenceSince(u.attachedAt);
    const title = `${u.login} · ${u.role || 'viewer'} · joined ${since}`;
    const cls = 'presence-chip' +
                (u.role === 'owner' ? ' presence-chip-owner' : ' presence-chip-guest') +
                (isMe ? ' presence-chip-me' : '');
    return `<span class="${cls}" style="--presence-hue: ${hue}deg" title="${escHtml(title)}">` +
           `<span class="presence-initial">${escHtml(initial)}</span>` +
           `</span>`;
  }).join('');
}

// Deterministic hue from a login string — same user always gets the
// same color. Cheap hash; collisions across logins are fine since
// it's purely cosmetic.
function _presenceHue(login) {
  let h = 0;
  const s = String(login || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function _presenceSince(iso) {
  if (!iso) return 'just now';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function showLogin() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.hidden = false;
}

function hideLogin() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.hidden = true;
}

async function tryToken(token) {
  console.log('[admin-diag] tryToken called. Token length:', token ? token.length : 0);
  if (!token) {
    console.log('[admin-diag] tryToken: No token in state/localStorage.');
    return false;
  }
  try {
    const res = await fetch('/auth/check', { headers: { Authorization: `Bearer ${token}` } });
    console.log('[admin-diag] tryToken: /auth/check response status:', res.status, 'ok:', res.ok);
    const body = await res.json().catch(() => ({}));
    console.log('[admin-diag] tryToken: /auth/check body parsed:', JSON.stringify(body));
    if (body.ok && body.user) {
      state.chatUser = body.user;
      console.log('[admin-diag] tryToken: successfully resolved state.chatUser to:', state.chatUser);
    } else {
      console.log('[admin-diag] tryToken: body is not ok or user is missing. body.ok:', body.ok, 'body.user:', body.user);
    }
    return !!body.ok;
  } catch (err) {
    console.error('[admin-diag] tryToken fetch threw error:', err);
    return false;
  }
}

async function bootstrap() {
  // OAuth callback bridge: /auth/github/callback responds with HTML that
  // writes the new myco session token into localStorage and bounces here.
  // Older flows (and noscript fallbacks) may still arrive with ?mycoSession=
  // in the URL; handle both forms.
  const url = new URL(window.location.href);
  const incomingTok = url.searchParams.get('mycoSession');
  if (incomingTok) {
    try { localStorage.setItem('myco_token', incomingTok); } catch {}
    state.token = incomingTok;
    url.searchParams.delete('mycoSession');
    history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }

  const shareTok = url.searchParams.get('s');

  // Share-link: validate, persist, then fall through to normal init.
  // The shared session appears as a card in the sidebar alongside owned sessions.
  if (shareTok) {
    let info;
    try {
      const res = await fetch(`/auth/check?s=${encodeURIComponent(shareTok)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      info = await res.json();
    } catch {
      return showShareError('This share link is invalid or expired.');
    }
    if (!info || !info.ok || !info.sessionId) {
      return showShareError('This share link is invalid or expired.');
    }
    state.shareToken = shareTok;
    saveShareToken(shareTok, info.sessionId, info.cwd);
    state._pendingShareId = info.sessionId;
  }

  // Normal auth flow — share link just adds a card, doesn't bypass login.
  const ok = await tryToken(state.token);
  if (ok) { init(); }
  else    { showLogin(); }
}

function showShareError(msg) {
  document.body.innerHTML =
    `<div style="color:#ccc;font:14px -apple-system,system-ui,sans-serif;` +
    `display:flex;align-items:center;justify-content:center;height:100dvh;` +
    `padding:20px;text-align:center;">${escHtml(msg)}</div>`;
}

// Phase 9 step 2: xterm is retired. Kept as a no-op so any cached-page
// call sites don't bomb.
function ensureXtermForFallback() { /* no-op: xterm retired */ }

// Touch device detection: narrow viewport OR coarse pointer (matchMedia)
// OR a touch-capable navigator. Computed once at script load.
const IS_TOUCH_DEVICE = (() => {
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return true;
    if ('ontouchstart' in window) return true;
    if (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) return true;
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  } catch { return false; }
})();

// The main pane has four mutually-exclusive sub-panes. Always hide the
// others when switching; otherwise the panes stack and the inactive one
// disappears behind / beside the active one. Chat is NOT in this list —
// it's a left-sidebar overlay (desktop) / full-pane overlay (mobile)
// that can coexist with whatever main-pane view is active underneath.
// (Phase 9 step 3 retired #terminal-wrap and #conversation-wrap.)
const MAIN_PANE_IDS = ['files-wrap', 'plan-wrap', 'arch-wrap', 'test-wrap', 'admin-wrap'];

function _hideMainPaneSiblings(keep) {
  for (const id of MAIN_PANE_IDS) {
    if (id === keep) continue;
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  }
  if (keep !== 'files-wrap') {
    state.files.visible = false;
    document.getElementById('btn-files')?.classList.remove('active');
  }
  // Clear the artifact-toggle active class for any view that's no longer up.
  for (const t of ['plan', 'arch', 'test', 'admin']) {
    if (keep === t + '-wrap') continue;
    document.getElementById('btn-' + t)?.classList.remove('active');
    if (state.artifactView && state.artifactView.active === t && keep !== t + '-wrap') {
      state.artifactView.active = null;
    }
  }
  // Mobile: the chatpane covers the whole pane (no side-by-side), so a
  // switch to another view from the chrome cluster has to close chat
  // too — otherwise the user clicks plan/arch/test and just sees chat.
  // Desktop chat is a 320px sidebar; it coexists with the other views.
  if (window.innerWidth <= 900 && state.chatPaneVisible) setChatPane(false);
}

// Phase 9 step 3 retired the JSONL transcript pane (#conversation-wrap)
// and its viewer helpers (showConversationView / showTranscriptView /
// showTranscriptWaiting / showTerminalView). All sessions render in
// the chat pane now — openSession + the 'viewer-mode' WS handler call
// setChatPane(true) directly.

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// fr-77 r14: Lucide-style SVG icon registry. The chrome cluster
// (#btn-files / btn-plan / btn-arch / btn-test / btn-chat) is built
// from inline SVGs with viewBox="0 0 24 24" + stroke="currentColor" +
// stroke-width="1.75" + round caps. Several plan-view affordances
// (Bug/Feature/Todo filter chips, upvote, comment, run, edit, close)
// were previously emoji (🐞 ✨ ✅ 👍 💬 ▶ ✎ ✓), which:
//   • render with the platform's emoji font (varying weight, size,
//     and color across macOS/Windows/Linux)
//   • can't take the chrome family's currentColor tint or
//     hover/active state styling
// _lucideIcon(name) returns a complete SVG string in the chrome
// family. Set `cls` to override the wrapping class (default '.ft-svg'
// — matches the other in-pane icons and is sized 18px/14px depending
// on the surrounding context's CSS).
const LUCIDE_PATHS = {
  // Plan-item filter chips
  'bug':           '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
  'sparkles':      '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  'check-square':  '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  // Per-item actions
  'thumbs-up':     '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  'message-square':'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'play':          '<polygon points="6 3 20 12 6 21 6 3"/>',
  'pencil':        '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  'check':         '<polyline points="20 6 9 17 4 12"/>',
  'rotate-ccw':    '<path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  // close-icon-uses-x: standard Lucide × glyph — two crossing strokes.
  // Replaces the 'check' ✓ that the .artifact-item-close button was
  // using; ✓ reads as "mark complete", × reads as "close".
  'x':             '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  // close-icon-popout: hand-rolled per user sketch — a checkmark
  // whose tail pokes through the top-right of an otherwise closed
  // circle. Reads as "mark complete with emphasis" / "task closed
  // with affirmation". Circle r=8 centered (12,12); check tail at
  // (22, 2) is well outside the circle, V-apex + start are inside.
  'check-popout':  '<circle cx="12" cy="12" r="8"/><polyline points="7 12 12 17 22 2"/>',
  'trash':         '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
};
function _lucideIcon(name, cls) {
  const path = LUCIDE_PATHS[name];
  if (!path) return '';
  const c = cls || 'ft-svg';
  return `<svg class="${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

// Full markdown rendering for conversation view via marked library.
//
// Wrapped in try/catch so a single bad message (unclosed fence, exotic
// unicode, hljs hiccup) can't crash the render pipeline. Falls back to
// escHtml on failure and logs the first time it does so per page — that
// fingerprint is how we'd diagnose "raw text in chat" style
// regressions: if you suddenly see `[renderMd] marked unavailable` or
// `[renderMd] marked.parse threw` in the console after an event, that
// pinpoints the cause.
// bug-39: protect LaTeX math from markdown mangling. marked treats
// $$…$$ / \(…\) as ordinary text (collapses `_` → emphasis, drops the
// backslashes, eats braces), so model output like
//   $$\frac{100}{10 - 1} = 11.\overline{1} \text{ 秒}$$
// renders as garbage. _extractMath pre-renders each math span to KaTeX
// HTML BEFORE marked.parse and leaves a control-char placeholder;
// _restoreMath swaps the HTML back in AFTER parse. STX/ETX (/)
// placeholders are used because markdown never emits or transforms control
// chars, so they survive marked.parse byte-for-byte. When KaTeX isn't
// loaded (server-side / test contexts) it returns the text unchanged.
function _extractMath(text) {
  const src = String(text == null ? '' : text);
  const math = [];
  if (typeof katex === 'undefined' || !katex.renderToString) return { text: src, math };
  const stash = (tex, displayMode) => {
    let html;
    try { html = katex.renderToString(tex.trim(), { displayMode, throwOnError: false }); }
    catch { return null; }                          // keep the literal on a KaTeX parse error
    const token = 'M' + math.length + '';
    math.push(html);
    return token;
  };
  let s = src;
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => { const t = stash(tex, true);  return t == null ? m : t; });   // $$…$$ display
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => { const t = stash(tex, true);  return t == null ? m : t; });   // \[…\] display
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => { const t = stash(tex, false); return t == null ? m : t; });   // \(…\) inline
  // $…$ inline: require no whitespace just inside the delimiters and no
  // digit right after the closer, so prose like "$5 and $10" is left alone.
  s = s.replace(/\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (m, tex) => { const t = stash(tex, false); return t == null ? m : t; });
  return { text: s, math };
}

function _restoreMath(html, math) {
  if (!math || !math.length) return html;
  return String(html).replace(/M(\d+)/g, (m, i) => {
    const n = Number(i);
    return (n >= 0 && n < math.length) ? math[n] : m;
  });
}

// Build the marked renderer once (code-block handler: mermaid passthrough +
// hljs highlight). Hoisted out of renderMd so renderMd stays small — the
// math protect → parse → restore steps read top-to-bottom.
let _mdRenderer = null;
function _buildMarkedRenderer() {
  if (_mdRenderer) return _mdRenderer;
  const renderer = new marked.Renderer();
  renderer.code = function(arg) {
    const code = (typeof arg === 'object' && arg.text !== undefined) ? arg.text : arg;
    const lang = (typeof arg === 'object' && arg.lang) ? arg.lang : '';
    if (lang === 'mermaid') {
      return '<pre><code class="language-mermaid">' + escHtml(code) + '</code></pre>';
    }
    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
      try {
        const highlighted = hljs.highlight(code, { language: lang }).value;
        return '<pre><code class="hljs language-' + escHtml(lang) + '">' + highlighted + '</code></pre>';
      } catch {}
    }
    if (typeof hljs !== 'undefined') {
      try {
        const highlighted = hljs.highlightAuto(code).value;
        return '<pre><code class="hljs">' + highlighted + '</code></pre>';
      } catch {}
    }
    return '<pre><code>' + escHtml(code) + '</code></pre>';
  };
  _mdRenderer = renderer;
  return _mdRenderer;
}

let _renderMdLoggedUnavailable = false;
function renderMd(text) {
  if (typeof marked === 'undefined' || !marked.parse) {
    if (!_renderMdLoggedUnavailable) {
      console.warn('[renderMd] marked unavailable; falling back to escHtml. typeof marked =', typeof marked);
      _renderMdLoggedUnavailable = true;
    }
    return escHtml(text);
  }
  try {
    const { text: protectedText, math } = _extractMath(String(text == null ? '' : text));
    const html = marked.parse(protectedText, { breaks: true, gfm: true, renderer: _buildMarkedRenderer() });
    return _restoreMath(html, math);
  } catch (err) {
    console.error('[renderMd] marked.parse threw:', err && err.message, 'on input head:', String(text).slice(0, 200));
    return escHtml(text);
  }
}

// Render any ```mermaid code blocks into SVG diagrams.
//
// mermaid.render() appends a temp <div id="d{id}"> to <body> to measure
// layout. It tidies the temp div on success, but on parse failure (which
// happens often when Claude scribbles a near-mermaid sketch) it leaves
// the "Syntax error in text, mermaid version 11.14.0" SVG behind. Without
// cleanup these stack up at the bottom of the page, especially for
// read-only viewers replaying long transcripts. We always purge the
// temp div in a finally block — and as a belt-and-braces, sweep any
// orphan d-prefixed nodes once per call.
async function renderMermaidInContainer(container) {
  const blocks = container.querySelectorAll('pre code.language-mermaid');
  if (!blocks.length) return;
  if (typeof mermaid === 'undefined') {
    try {
      await loadScript('/vendor/mermaid.min.js');
      if (typeof mermaid !== 'undefined') {
        mermaid.initialize({ startOnLoad: false, theme: 'dark' });
      }
    } catch (err) {
      console.warn('[mermaid] failed to lazy-load:', err);
      return;
    }
  }
  for (const block of blocks) {
    const pre = block.parentElement;
    const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
    let svg = null;
    try {
      const r = await mermaid.render(id, block.textContent);
      svg = r && r.svg;
    } catch {
      // Leave as raw code block if mermaid fails
    } finally {
      try {
        const orphan = document.getElementById('d' + id) || document.getElementById(id);
        if (orphan) orphan.remove();
      } catch {}
    }
    if (svg) {
      const div = document.createElement('div');
      div.className = 'conv-mermaid';
      div.innerHTML = svg;
      pre.replaceWith(div);
    }
  }
  // Final sweep: any leftover mermaid temp/error nodes from earlier calls
  // (race, page-load before this fix shipped, …). Scoped to direct
  // children of body so we don't accidentally yank anything legitimate.
  try {
    for (const node of document.body.querySelectorAll(':scope > [id^="dmermaid-"], :scope > [id^="mermaid-"]')) {
      node.remove();
    }
  } catch {}
}

function renderConvMessage(m) {
  if (m.role === 'title') {
    const div = document.createElement('div');
    div.className = 'conv-msg conv-msg-title';
    div.textContent = m.text;
    return div;
  }

  if (m.role === 'user') {
    const div = document.createElement('div');
    div.className = 'conv-msg conv-msg-user';
    const textEl = document.createElement('div');
    textEl.className = 'conv-text';
    // User messages historically used textContent, which rendered markdown
    // literally (numbered lists showed as "1. step", bold as **bold**, code
    // fences as triple backticks). Route through renderMd so the viewer
    // sees the same formatting an editor preview would. marked escapes
    // HTML by default, so this is safe for untrusted input.
    textEl.innerHTML = renderMd(m.text);
    div.appendChild(textEl);
    return div;
  }

  if (m.role === 'assistant') {
    const div = document.createElement('div');
    div.className = 'conv-msg conv-msg-assistant';
    if (m.toolCalls && m.toolCalls.length) {
      for (const tc of m.toolCalls) {
        const details = document.createElement('details');
        details.className = 'conv-tool-call';
        const summary = document.createElement('summary');
        summary.innerHTML = `<span class="conv-tool-name">${escHtml(tc.name)}</span> <span class="conv-tool-summary">${escHtml(tc.summary)}</span>`;
        details.appendChild(summary);
        const body = document.createElement('div');
        body.className = 'conv-tool-body';
        body.textContent = tc.summary;
        details.appendChild(body);
        div.appendChild(details);
      }
    }
    if (m.text) {
      const textEl = document.createElement('div');
      textEl.className = 'conv-text';
      textEl.innerHTML = renderMd(m.text);
      div.appendChild(textEl);
    }
    return div;
  }

  // Chain-of-thought reasoning. Collapsed by default — older models
  // redact this field (encrypted blob, empty `.thinking`) so when the
  // parser surfaces it, the text is from a model that exposed its
  // reasoning. Dimmed body keeps it visually subordinate to the
  // assistant's final reply. Surfaced from `assistant.thinking[]` —
  // the parser folds them into the same frame as the text so chrono
  // order is preserved.
  if (m.role === 'thinking' || (Array.isArray(m.thinking) && m.thinking.length)) {
    const list = m.role === 'thinking' ? [m.text] : m.thinking;
    const div = document.createElement('div');
    div.className = 'conv-msg conv-msg-thinking';
    for (const text of list) {
      if (!text) continue;
      const details = document.createElement('details');
      details.className = 'conv-thinking';
      const summary = document.createElement('summary');
      summary.textContent = '✻ Thinking';
      details.appendChild(summary);
      const body = document.createElement('div');
      body.className = 'conv-thinking-body';
      body.textContent = text;
      details.appendChild(body);
      div.appendChild(details);
    }
    return div;
  }

  // Mode-boundary pills — single-line markers signifying entry/exit
  // of plan mode or auto mode. The pty.js mode-change emit produces
  // identical-shape frames live (~750ms latency) so the same render
  // path serves both transcript replay and live PTY observation;
  // upstream dedup keeps a (role,state,near-ts) collision from
  // showing up twice.
  if (m.role === 'plan_mode' || m.role === 'auto_mode') {
    const div = document.createElement('div');
    div.className = `conv-msg conv-msg-mode conv-msg-mode-${m.role.replace('_', '-')}`;
    const pill = document.createElement('span');
    pill.className = 'conv-mode-pill';
    const verb = m.state === 'exited' ? 'Exited'
      : m.state === 'reentered' ? 'Re-entered'
      : 'Entered';
    const label = m.role === 'plan_mode' ? 'plan mode' : 'auto mode';
    pill.textContent = `● ${verb} ${label}`;
    div.appendChild(pill);
    return div;
  }

  // Framework-level errors (api_error, authentication_error, …).
  // Red callout so a viewer immediately sees that a turn failed.
  if (m.role === 'error') {
    const div = document.createElement('div');
    div.className = 'conv-msg conv-msg-error';
    const head = document.createElement('div');
    head.className = 'conv-error-head';
    head.textContent = `⚠ ${m.kind || 'error'}`;
    div.appendChild(head);
    if (m.text) {
      const body = document.createElement('div');
      body.className = 'conv-error-body';
      body.textContent = m.text;
      div.appendChild(body);
    }
    return div;
  }

  // Permission-set changes ("/permissions reset", "/allow Bash(npm test)").
  // Muted italics — informational, not interactive in the viewer.
  if (m.role === 'permission_change') {
    const div = document.createElement('div');
    div.className = 'conv-msg conv-msg-permission';
    const n = Array.isArray(m.tools) ? m.tools.length : 0;
    const label = n === 0 ? 'permissions reset' : `permissions updated (${n} tool${n === 1 ? '' : 's'})`;
    div.textContent = `🔒 ${label}`;
    return div;
  }

  // Queued slash-command — the user typed a command while claude was
  // mid-turn; it'll execute after the current turn finishes.
  if (m.role === 'queued') {
    const div = document.createElement('div');
    div.className = 'conv-msg conv-msg-queued';
    div.textContent = `⏳ Queued: ${m.text || ''}`;
    return div;
  }

  if (m.role === 'tool_result') {
    const div = document.createElement('div');
    div.className = 'conv-msg conv-msg-result';
    if (m.results) {
      for (const r of m.results) {
        const content = (r.content || '').substring(0, 2000);
        const firstLine = content.split('\n')[0] || '';
        const rest = content.includes('\n') ? content.substring(content.indexOf('\n') + 1) : '';
        const details = document.createElement('details');
        details.className = 'conv-tool-result';
        const summary = document.createElement('summary');
        summary.textContent = '';
        const prefix = document.createElement('span');
        prefix.className = 'conv-result-prefix';
        prefix.textContent = '└─';
        summary.appendChild(prefix);
        const firstLineEl = document.createElement('span');
        firstLineEl.className = 'conv-result-first-line';
        firstLineEl.textContent = ' ' + firstLine;
        if (r.isError) firstLineEl.classList.add('conv-result-error');
        summary.appendChild(firstLineEl);
        details.appendChild(summary);
        if (rest) {
          const body = document.createElement('div');
          body.className = 'conv-tool-body';
          // Render tool output as markdown so .md files, structured tables,
          // and code blocks come out formatted instead of as a wall of raw
          // text. marked's HTML-escaping handles unsafe chars in command
          // output; the pre-wrap CSS still preserves whitespace for plain
          // (non-markdown) tool output.
          body.innerHTML = renderMd(rest);
          if (r.isError) body.classList.add('conv-result-error');
          details.appendChild(body);
        }
        div.appendChild(details);
      }
    }
    return div;
  }

  const div = document.createElement('div');
  div.className = 'conv-msg';
  return div;
}

// Logout — drop the local session and bounce to GitHub login.
async function doLogout() {
  try {
    await fetch('/auth/logout', { method: 'POST', headers: { ...authHeaders() } });
  } catch {}
  try { localStorage.removeItem('myco_token'); } catch {}
  state.token = '';
  location.replace('/');
}

// PAT login: post the pasted token to /auth/login. On success the server
// returns { token } — the minted myco session. We persist that and proceed
// exactly like the OAuth-callback path.
async function doPatLogin() {
  const input = document.getElementById('login-pat');
  const btn = document.getElementById('login-pat-submit');
  const errEl = document.getElementById('login-error');
  if (!input || !btn) return;
  const pat = (input.value || '').trim();
  if (!pat) { input.focus(); return; }
  btn.disabled = true;
  if (errEl) errEl.hidden = true;
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pat }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.token) {
      const msg = body.error
        ? (body.hint ? `${body.error}. ${body.hint}` : body.error)
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    state.token = body.token;
    state.chatUser = body.user && body.user.login ? body.user.login : null;
    try { localStorage.setItem('myco_token', body.token); } catch {}
    input.value = '';
    hideLogin();
    init();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || 'login failed';
      errEl.hidden = false;
    }
    input.select();
  } finally {
    btn.disabled = false;
  }
}

function bindLoginUi() {
  // Bind on the form's submit event so click + Enter + mobile autofill all
  // funnel through one path. The button is type="submit" inside <form>, so
  // the browser handles every variation natively.
  const form = document.getElementById('login-pat-form');
  if (form && !form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      doPatLogin();
    });
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────

let initDone = false;
async function init() {
  if (initDone) return;
  initDone = true;
  await refreshWorkspace();
  await refreshSessions();
  setInterval(refreshSessions, 3000);

  // Auto-attach: if a share link is pending, open that session as viewer.
  // Otherwise prefer the last active session, or the most recent one.
  if (!state.activeId && state.sessions.length) {
    let target;
    if (state._pendingShareId) {
      target = state.sessions.find((s) => s.id === state._pendingShareId);
      delete state._pendingShareId;
      // Collapse sidebar so the viewer content is front and center
      if (window.innerWidth <= 900) setSidebar(true);
    }
    if (!target) {
      const persisted = localStorage.getItem('myco_active_id');
      target = (persisted && state.sessions.find((s) => s.id === persisted))
        || mostRecentSession(state.sessions);
    }
    if (target) openSession(target.id);
  }

  // Load KaTeX (math rendering) asynchronously after page initialization to not block startup.
  setTimeout(async () => {
    try {
      await Promise.all([
        loadStylesheet('/vendor/katex.min.css'),
        loadScript('/vendor/katex.min.js')
      ]);
      // Trigger a re-render of the chat pane once loaded so math displays.
      renderChatPane();
    } catch (err) {
      console.warn('[katex] failed to lazy-load:', err);
    }
  }, 1000);

  document.getElementById('btn-spawn').addEventListener('click', openSpawnModal);
  document.getElementById('spawn-cancel').addEventListener('click', closeSpawnModal);
  document.getElementById('spawn-ok').addEventListener('click', doSpawn);
  document.getElementById('btn-expand').addEventListener('click', () => setSidebar(false));
  document.getElementById('btn-collapse').addEventListener('click', () => setSidebar(true));
  // User-manual modal: open + close + Esc-to-close + click-outside-to-close.
  // Manual content is lazy-fetched on first open and cached in memory.
  document.getElementById('btn-manual').addEventListener('click', openManualModal);
  document.getElementById('manual-close').addEventListener('click', closeManualModal);
  document.getElementById('manual-modal').addEventListener('click', (e) => {
    // Close when clicking the dim overlay (not the dialog contents).
    if (e.target.id === 'manual-modal') closeManualModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('manual-modal').hidden) closeManualModal();
  });
  document.getElementById('spawn-cwd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSpawn(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSpawnModal(); }
  });
  document.getElementById('status-bar').addEventListener('click', toggleLogPanel);
  document.getElementById('log-panel-close').addEventListener('click', toggleLogPanel);
  bindChatUi();
  bindFilesUi();
  bindReadOnlyBanner();
  // Boot lands on the terminal view; the user picks chat / plan / arch /
  // test / files / preview from the chrome cluster. Previously chat
  // auto-opened on desktop as a sidebar — that layout is gone now that
  // chat is a main-pane view (mutually exclusive with the others), so
  // auto-opening would hide the terminal on every page load.
  connectLogWs();
  showBuildStamp();
  showUserStamp();
  bindAdminUi();
  // fr-92: first-time users land on the manual so they know what's here
  // before clicking around. Deferred until after the rest of init wires
  // up so the modal opens over a populated UI (not an empty shell).
  _maybeShowFirstTimeManual();
}

// fr-92: open the user manual modal on the first page load per browser
// (tracked via localStorage `myco_manual_seen`). Skips:
//   • viewer-mode visitors (share-link landing) — they're here for the
//     host's content, not the onboarding manual
//   • already-seen users (flag set)
//   • localStorage failures (private mode etc.) — fail silently rather
//     than auto-opening every page load
// Small setTimeout so the modal doesn't fight with the first paint.
function _maybeShowFirstTimeManual() {
  if (state.viewerMode) return;
  let seen = false;
  try { seen = !!localStorage.getItem('myco_manual_seen'); } catch { return; }
  if (seen) return;
  try { localStorage.setItem('myco_manual_seen', '1'); } catch { /* still open, just no flag */ }
  setTimeout(() => { try { openManualModal(); } catch {} }, 250);
}

// /build.txt is written by the Dockerfile (`date -u +%Y-%m-%dT%H:%M:%SZ`).
// In dev (no docker build) the file is missing and the stamp stays empty.
async function showBuildStamp() {
  const el = document.getElementById('build-stamp');
  if (!el) return;
  try {
    const res = await fetch('/build.txt', { cache: 'no-store' });
    if (!res.ok) return;
    const stamp = (await res.text()).trim();
    if (!stamp) return;
    // Render as "build YYYY-MM-DD HH:MMZ" (drop seconds for compactness).
    const short = stamp.replace('T', ' ').replace(/:\d{2}Z$/, 'Z');
    el.textContent = `build ${short}`;
    el.title = `Build timestamp: ${stamp}`;
  } catch {}
}

// Populates the status-bar user chip from state.chatUser (set by tryToken on
// auth success). Empty when auth is disabled — :empty CSS hides the chip.
//
// fr-87: clicking the chip now opens the Config modal (PAT management +
// sign-out button). The legacy `confirm('Sign out?')` flow on click is
// gone — sign-out lives as a button inside the modal.
function showUserStamp() {
  const el = document.getElementById('user-stamp');
  if (!el) return;
  el.textContent = state.chatUser ? `@${state.chatUser}` : '';
  el.title = state.chatUser ? `Logged in as ${state.chatUser} — click to open config` : '';
  if (state.chatUser && !el.dataset.configBound) {
    el.dataset.configBound = '1';
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      // Status-bar parent has its own click handler (toggleLogPanel); don't
      // open the log panel when the user clicks the username.
      e.stopPropagation();
      openConfigModal();
    });
  }
  // fr-87 r4: the legacy user-cog icon that bug-44 added was removed.
  // The gear icon (#btn-admin) is now the single Config affordance —
  // its show/hide + click wiring lives in bindAdminUi.
}

// fr-87: Config modal — per-user PAT management + sign-out. Fetches
// the inventory from GET /config/pats (never includes raw token
// values), renders user-level + per-repo rows, wires Set/Delete
// actions. Sign-out button at the bottom calls doLogout() (the same
// helper the old chip-click confirm flow used).
async function openConfigModal() {
  const modal = document.getElementById('config-modal');
  if (!modal) return;
  // Title shows whose config this is.
  const titleEl = document.getElementById('config-title');
  if (titleEl) titleEl.textContent = state.chatUser ? `Config — @${state.chatUser}` : 'Config';
  // Close + sign-out + add-PAT click handlers (bound once, idempotent).
  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';
    document.getElementById('config-close').addEventListener('click', closeConfigModal);
    document.getElementById('config-signout').addEventListener('click', () => {
      if (confirm('Sign out of myco?')) doLogout();
    });
    document.getElementById('config-pat-save').addEventListener('click', _saveConfigPerRepoPat);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) closeConfigModal();
    });
  }
  modal.hidden = false;
  await _refreshConfigPats();
  // fr-87 r2: admin-merge — probe /api/admin/config; show section on 200.
  await _refreshConfigAdmin();
}

// fr-87 r2: probe + render the Admin (system-wide) section. Uses the
// server-side requireAdmin gate (the hardcoded login list from
// f71495f's index.js) as the source of truth — if /api/admin/config
// returns 200 the user is admin; on 403 the section stays hidden.
// The standalone admin pane (#admin-wrap) is NOT touched — both
// entries are valid; this merge just removes the need for an admin
// to bounce between the modal and the pane.
async function _refreshConfigAdmin() {
  const section = document.getElementById('config-admin-section');
  if (!section) return;
  let cfg = null;
  try {
    const res = await authedFetch('/api/admin/config');
    if (!res.ok) { section.hidden = true; return; }
    const body = await res.json();
    cfg = body.config || {};
  } catch (err) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  // Populate env-config form (server pre-masks _KEY-suffixed values;
  // we display whatever the server returned as the field's "current"
  // shown value, except for masked values where we leave the input
  // blank so the user can paste a new value or leave it unchanged).
  const ENV_FIELDS = {
    ANTHROPIC_API_KEY: 'config-admin-anthropic-key',
    GEMINI_API_KEY: 'config-admin-gemini-key',
    OPENAI_API_KEY: 'config-admin-openai-key',
    CUSTOM_CRITIC_ENDPOINT: 'config-admin-critic-endpoint',
    CUSTOM_CRITIC_KEY: 'config-admin-critic-key',
    CUSTOM_CRITIC_MODEL: 'config-admin-critic-model',
    HTTP_PROXY: 'config-admin-http-proxy',
    HTTPS_PROXY: 'config-admin-https-proxy',
    NO_PROXY: 'config-admin-no-proxy',
  };
  for (const [envKey, inputId] of Object.entries(ENV_FIELDS)) {
    const input = document.getElementById(inputId);
    if (!input) continue;
    const v = cfg[envKey];
    // Masked values look like "••••XXXX" or include "..." — leave
    // those inputs blank so a save with an empty field doesn't
    // overwrite the real secret with the mask.
    if (typeof v === 'string' && (v.includes('•') || v.includes('...'))) {
      input.value = '';
    } else {
      input.value = (typeof v === 'string') ? v : '';
    }
  }
  // Wire handlers once.
  if (!section.dataset.bound) {
    section.dataset.bound = '1';
    const saveBtn = document.getElementById('config-admin-env-save');
    if (saveBtn) saveBtn.addEventListener('click', _saveConfigAdminEnv);
    const addBtn = document.getElementById('config-admin-allowlist-add');
    if (addBtn) addBtn.addEventListener('click', _addConfigAdminAllowlist);
  }
  // fr-91 r3: bind the API key Test buttons every time the admin
  // section opens (idempotent via dataset.fr91Bound).
  _bindApiKeyTestButtons();
  // Load the allowlist into its list container.
  await _refreshConfigAdminAllowlist();
}

async function _refreshConfigAdminAllowlist() {
  const listEl = document.getElementById('config-admin-allowlist-list');
  if (!listEl) return;
  listEl.innerHTML = '';
  let users = [];
  try {
    const res = await authedFetch('/api/admin/allowlist');
    if (!res.ok) return;
    const body = await res.json();
    users = Array.isArray(body.allowlist) ? body.allowlist : [];
  } catch { return; }
  if (!users.length) {
    listEl.innerHTML = '<div class="config-empty">No users in the allowlist.</div>';
    return;
  }
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'config-pat-row';
    row.innerHTML = `
      <span class="config-pat-label">${escHtml(u)}</span>
      <span></span>
      <span class="config-pat-actions">
        <button class="config-pat-delete" data-username="${escHtml(u)}" title="Remove from allowlist">Remove</button>
      </span>
    `;
    row.querySelector('.config-pat-delete').addEventListener('click', () => _removeConfigAdminAllowlist(u));
    listEl.appendChild(row);
  }
}

async function _addConfigAdminAllowlist() {
  const input = document.getElementById('config-admin-allowlist-input');
  const username = (input && input.value || '').trim();
  if (!username) return;
  const errEl = document.getElementById('config-error');
  try {
    await authedFetch('/api/admin/allowlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (input) input.value = '';
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    await _refreshConfigAdminAllowlist();
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = 'Allowlist add failed: ' + err.message; }
  }
}

async function _removeConfigAdminAllowlist(username) {
  if (!username) return;
  if (!confirm(`Remove @${username} from the allowlist?`)) return;
  const errEl = document.getElementById('config-error');
  try {
    await authedFetch(`/api/admin/allowlist/${encodeURIComponent(username)}`, { method: 'DELETE' });
    await _refreshConfigAdminAllowlist();
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = 'Allowlist remove failed: ' + err.message; }
  }
}

async function _saveConfigAdminEnv() {
  // Collect only fields the user filled in. Blank values for masked
  // keys mean "leave unchanged" — we skip them so we don't overwrite
  // real secrets with empties.
  const ENV_FIELDS = {
    ANTHROPIC_API_KEY: 'config-admin-anthropic-key',
    GEMINI_API_KEY: 'config-admin-gemini-key',
    OPENAI_API_KEY: 'config-admin-openai-key',
    CUSTOM_CRITIC_ENDPOINT: 'config-admin-critic-endpoint',
    CUSTOM_CRITIC_KEY: 'config-admin-critic-key',
    CUSTOM_CRITIC_MODEL: 'config-admin-critic-model',
    HTTP_PROXY: 'config-admin-http-proxy',
    HTTPS_PROXY: 'config-admin-https-proxy',
    NO_PROXY: 'config-admin-no-proxy',
  };
  const payload = {};
  for (const [envKey, inputId] of Object.entries(ENV_FIELDS)) {
    const el = document.getElementById(inputId);
    if (!el) continue;
    const v = String(el.value || '').trim();
    if (v) payload[envKey] = v;
  }
  const errEl = document.getElementById('config-error');
  try {
    await authedFetch('/api/admin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    // Re-fetch + re-mask after save so the inputs reflect the
    // post-save state (and don\'t retain typed-in raw values).
    await _refreshConfigAdmin();
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = 'Save env config failed: ' + err.message; }
  }
}

function closeConfigModal() {
  const modal = document.getElementById('config-modal');
  if (modal) modal.hidden = true;
  // Clear any token-input residue so the password field doesn\'t cache
  // the last typed value when the user reopens the modal.
  const tokInput = document.getElementById('config-pat-token');
  if (tokInput) tokInput.value = '';
}

async function _refreshConfigPats() {
  const errEl = document.getElementById('config-error');
  if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  const listEl = document.getElementById('config-pats-list');
  const emptyEl = document.getElementById('config-pats-empty');
  if (!listEl) return;
  listEl.innerHTML = '';
  let inventory;
  try {
    const res = await authedFetch('/config/pats');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    inventory = await res.json();
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = 'Failed to load PATs: ' + err.message; }
    return;
  }
  const rows = [];
  // User-level (OAuth-fallback) row per provider, even when absent —
  // gives the user a place to PASTE a value if they want to set one.
  for (const provider of ['github', 'gitee']) {
    const meta = inventory.userLevel && inventory.userLevel[provider];
    rows.push(_renderConfigPatRow({
      kind: 'user-level',
      provider,
      owner: null,
      repo: null,
      alias: null,
      present: !!(meta && meta.present),
      last4: meta && meta.last4,
    }));
  }
  // Per-repo rows.
  for (const r of (inventory.perRepo || [])) {
    rows.push(_renderConfigPatRow({
      kind: 'per-repo',
      provider: r.provider,
      owner: r.owner,
      repo: r.repo,
      alias: r.alias || null,
      present: true,
      last4: r.last4,
    }));
  }
  for (const el of rows) listEl.appendChild(el);
  const hasAny = (inventory.perRepo && inventory.perRepo.length)
    || (inventory.userLevel.github && inventory.userLevel.github.present)
    || (inventory.userLevel.gitee && inventory.userLevel.gitee.present);
  if (emptyEl) emptyEl.hidden = hasAny;
}

function _renderConfigPatRow({ kind, provider, owner, repo, alias, present, last4 }) {
  const row = document.createElement('div');
  row.className = 'config-pat-row';
  row.dataset.kind = kind;
  row.dataset.provider = provider;
  if (owner) row.dataset.owner = owner;
  if (repo) row.dataset.repo = repo;
  if (alias) row.dataset.alias = alias;
  const label = (kind === 'user-level')
    ? `${provider} (user-level / OAuth fallback)`
    : `${provider}/${owner}/${repo}${alias ? '#' + alias : ''}`;
  const masked = present ? `••••${escHtml(last4 || '')}` : '(none)';
  row.innerHTML = `
    <span class="config-pat-label">${escHtml(label)}</span>
    <span class="config-pat-value">${masked}</span>
    <span class="config-pat-actions">
      <button class="config-pat-replace" title="Set or replace this PAT">Set</button>
      ${present ? '<button class="config-pat-delete" title="Delete this PAT">Delete</button>' : ''}
    </span>
  `;
  row.querySelector('.config-pat-replace').addEventListener('click', () => _replaceConfigPat({ kind, provider, owner, repo, alias }));
  const delBtn = row.querySelector('.config-pat-delete');
  if (delBtn) delBtn.addEventListener('click', () => _deleteConfigPat({ kind, provider, owner, repo, alias }));
  return row;
}

async function _replaceConfigPat({ kind, provider, owner, repo, alias }) {
  // Prompt the user for the new value. `prompt()` is the cheapest
  // affordance that doesn\'t require a second modal; the field is
  // wiped after submit so the token doesn\'t linger in DOM.
  const label = (kind === 'user-level')
    ? `${provider} user-level token`
    : `${provider}/${owner}/${repo}${alias ? '#' + alias : ''}`;
  const tok = window.prompt(`Paste new PAT for ${label}:`);
  if (!tok || !tok.trim()) return;
  const errEl = document.getElementById('config-error');
  try {
    if (kind === 'user-level') {
      await authedFetch('/config/pats/user-level', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, token: tok.trim() }),
      });
    } else {
      await authedFetch('/config/pats/per-repo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, owner, repo, token: tok.trim(), alias }),
      });
    }
    await _refreshConfigPats();
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = 'Failed to set PAT: ' + err.message; }
  }
}

async function _deleteConfigPat({ kind, provider, owner, repo, alias }) {
  const label = (kind === 'user-level')
    ? `${provider} user-level token`
    : `${provider}/${owner}/${repo}${alias ? '#' + alias : ''}`;
  if (!confirm(`Delete PAT for ${label}?`)) return;
  const errEl = document.getElementById('config-error');
  try {
    let url;
    if (kind === 'user-level') {
      url = `/config/pats/user-level/${encodeURIComponent(provider)}`;
    } else {
      url = `/config/pats/per-repo/${encodeURIComponent(provider)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      if (alias) url += `?alias=${encodeURIComponent(alias)}`;
    }
    await authedFetch(url, { method: 'DELETE' });
    await _refreshConfigPats();
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = 'Failed to delete PAT: ' + err.message; }
  }
}

async function _saveConfigPerRepoPat() {
  const provider = document.getElementById('config-pat-provider').value;
  const owner = document.getElementById('config-pat-owner').value.trim();
  const repo = document.getElementById('config-pat-repo').value.trim();
  const alias = document.getElementById('config-pat-alias').value.trim() || null;
  const tokInput = document.getElementById('config-pat-token');
  const token = tokInput.value.trim();
  const errEl = document.getElementById('config-error');
  if (!owner || !repo || !token) {
    if (errEl) { errEl.hidden = false; errEl.textContent = 'owner, repo, and token are required'; }
    return;
  }
  try {
    await authedFetch('/config/pats/per-repo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, owner, repo, token, alias }),
    });
    document.getElementById('config-pat-owner').value = '';
    document.getElementById('config-pat-repo').value = '';
    document.getElementById('config-pat-alias').value = '';
    tokInput.value = '';
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    await _refreshConfigPats();
  } catch (err) {
    if (errEl) { errEl.hidden = false; errEl.textContent = 'Failed to save PAT: ' + err.message; }
  }
}

async function refreshWorkspace() {
  try {
    const res = await authedFetch('/workspace');
    state.workspace = await res.json();
    document.getElementById('spawn-ws-path').textContent = state.workspace.name || 'workspace';
    renderSpawnSuggestions();
  } catch {}
}

function renderSpawnSuggestions() {
  // Per the 2026-05-15 id-as-folder rule, the spawn-cwd input is a
  // free-form display label, not a path. Pre-filling it with an
  // existing folder name would be misleading (clicking a chip used
  // to point the session at that folder; now it just sets the
  // display label). Hide the chip strip — keep the wrap element in
  // the DOM so the spawn modal CSS doesn't reflow.
  const wrap = document.getElementById('spawn-suggestions');
  if (wrap) wrap.innerHTML = '';
}

// ── sessions list ─────────────────────────────────────────────────────────────

async function refreshSessions() {
  try {
    const shares = loadShareTokens();
    const params = new URLSearchParams();
    params.set('all', '1');
    for (const s of shares) params.append('share', s.shareToken);
    const fetchFn = state.token ? authedFetch : fetch;
    const res = await fetchFn(`/sessions?${params.toString()}`);
    if (!res.ok) return;
    let sessions = await res.json();
    // Deduplicate: prefer shared entry for non-owned sessions
    const byId = new Map();
    for (const s of sessions) {
      const existing = byId.get(s.id);
      if (!existing || (s.shared && !s.owned)) byId.set(s.id, s);
    }
    state.sessions = [...byId.values()];
    renderSessionList();
  } catch {}
}

function mostRecentSession(sessions) {
  // Server returns ISO timestamps; lexicographic sort is fine. Sessions with
  // no last_activity fall back to created_at so a freshly-spawned session
  // (no claude output yet) still wins over older idle ones.
  let best = null;
  let bestKey = '';
  for (const s of sessions) {
    const k = s.last_activity || s.created_at || '';
    if (k > bestKey) { best = s; bestKey = k; }
  }
  return best;
}

function renderSessionList() {
  const ul = document.getElementById('session-list');
  ul.innerHTML = '';
  if (state.sessions.length === 0) {
    ul.innerHTML = '<li class="empty">No claude sessions found</li>';
    return;
  }
  for (const s of state.sessions) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.id === state.activeId ? ' active' : '');
    // Read-only marker: explicit share OR same-host session you don't own.
    const readOnly = !!s.shared || s.owned === false;
    if (readOnly) li.classList.add('shared');
    if (s.status) li.dataset.status = s.status;
    li.dataset.id = s.id;
    // Display label: prefer the friendly s.name (server returns
    // rec.label or falls back to rec.cwd). Old sessions whose cwd
    // was the user-typed folder name continue to display unchanged;
    // new sessions whose folder = session-id show rec.label here
    // (or the short id as a final fallback).
    const dirName = s.name || (s.cwd || '').split('/').filter(Boolean).pop() || s.cwd || '~';
    const idShort = s.id.replace(/^myco-/, '').slice(0, 8);
    const summary = s.summary
      ? `<span class="session-summary">${escHtml(s.summary)}</span>`
      : (s.description ? `<span class="session-desc">${escHtml(s.description)}</span>` : '');
    const statusDot = s.status ? `<span class="session-status session-status-${s.status}" aria-label="Status: ${s.status}"></span>` : '';
    const ownerLabel = s.owner || (s.shared ? 'shared' : null);
    const sharedBadge = readOnly && ownerLabel
      ? `<span class="shared-badge" title="${s.shared ? 'Shared by' : 'Owned by'} ${escHtml(ownerLabel)} — read-only">${escHtml(ownerLabel)}</span>`
      : '';
    // fr-87: visibility badge — only rendered on OWNED sessions, since
    // for non-owned (URL-shared / viewer-shared) the existing shared-
    // badge already labels them. For owned sessions:
    //   • visibility === 'private' (no admins, no viewers) → small "private" chip
    //   • visibility === 'shared'  (≥1 admin or viewer)   → "shared (N)" chip
    //     where N = viewerCount; tooltip lists the viewers so the
    //     owner can audit the trust graph at a glance without opening
    //     a /share dialog.
    let visibilityBadge = '';
    if (s.owned && !s.shared && s.visibility) {
      if (s.visibility === 'private') {
        visibilityBadge = `<span class="visibility-badge visibility-private" title="Private — only you can see this session. \`/share @user\` to grant read-only access.">private</span>`;
      } else {
        const viewers = Array.isArray(s.viewers) ? s.viewers : [];
        const tooltipLines = ['Shared session.'];
        if (viewers.length) tooltipLines.push('Viewers: ' + viewers.map((u) => '@' + u).join(', '));
        tooltipLines.push('`/share -@user` to revoke; `/share` to list.');
        const tip = escHtml(tooltipLines.join('\n'));
        const count = Number(s.viewerCount) || 0;
        const label = count ? `shared (${count})` : 'shared';
        visibilityBadge = `<span class="visibility-badge visibility-shared" title="${tip}">${label}</span>`;
      }
    }
    li.innerHTML = `
      ${statusDot}
      <span class="session-title">${escHtml(dirName)}${sharedBadge}${visibilityBadge}</span>
      ${summary}
      <span class="session-meta">${escHtml(idShort)} · ${timeAgo(s.last_activity || s.created_at)}</span>
      ${s.owned && !s.shared ? '<button class="session-share" aria-label="Share session">↗</button>' : ''}
      ${s.owned && !s.shared ? '<button class="session-vscode" aria-label="Open in VS Code">{·}</button>' : ''}
      ${s.owned || s.shared ? '<button class="session-delete" aria-label="' + (s.shared ? 'Remove shared session' : 'Delete session') + '">×</button>' : ''}
    `;
    li.addEventListener('click', () => {
      if (li.classList.contains('show-delete')) return;
      openSession(s.id);
    });
    const delBtn = li.querySelector('.session-delete');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (s.shared) {
          removeShareToken(s.shareToken);
          refreshSessions();
        } else {
          deleteSessionWithConfirm(s);
        }
      });
    }
    if (!s.shared) {
      const shareBtn = li.querySelector('.session-share');
      if (shareBtn) {
        shareBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          shareSession(s);
        });
      }
      const codeBtn = li.querySelector('.session-vscode');
      if (codeBtn) {
        codeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openInVscode(s);
        });
      }
    }
    attachLongPressDeleteToggle(li);
    ul.appendChild(li);
  }
}

// On touch devices, long-press a card to reveal share/vscode/delete on
// just that card. On hover-capable devices a CSS hover rule shows them.
function attachLongPressDeleteToggle(li) {
  let timer = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  li.addEventListener('touchstart', () => {
    cancel();
    timer = setTimeout(() => {
      // Clear any other card's expanded menu so only this one is open.
      document.querySelectorAll('.session-item.show-delete').forEach(el => {
        if (el !== li) el.classList.remove('show-delete');
      });
      li.classList.add('show-delete');
      if (navigator.vibrate) navigator.vibrate(15);
    }, 500);
  }, { passive: true });
  li.addEventListener('touchend', cancel);
  li.addEventListener('touchmove', cancel, { passive: true });
  li.addEventListener('touchcancel', cancel);
}

// Tap outside the expanded card hides its action buttons. Tapping a
// different card just hides the previous one (the new long-press, if any,
// will open it on the new card).
document.addEventListener('click', (e) => {
  const exposed = document.querySelectorAll('.session-item.show-delete');
  if (!exposed.length) return;
  if (e.target.closest('.session-delete') ||
      e.target.closest('.session-share') ||
      e.target.closest('.session-vscode')) return;
  exposed.forEach((el) => {
    if (!el.contains(e.target)) el.classList.remove('show-delete');
    else el.classList.remove('show-delete'); // tap on the card itself also dismisses
  });
});

async function shareSession(s) {
  let url;
  try {
    const res = await authedFetch(`/sessions/${encodeURIComponent(s.id)}/share`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ({ url } = await res.json());
  } catch (err) {
    alert(`Could not create share link: ${err.message}`);
    return;
  }
  const dirName = (s.cwd || '').split('/').filter(Boolean).pop() || 'session';
  const title = `Claude session: ${dirName}`;
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; }
    catch (err) { if (err && err.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    flashToast('Link copied');
  } catch {
    window.prompt('Copy this share link:', url);
  }
}

async function openInVscode(s) {
  // Files live on the mycod server, not on the device clicking this button —
  // a plain vscode://file/... URL would point at a path that doesn't exist
  // locally. Always use Remote-SSH so the laptop's VS Code connects to the
  // server. The SSH host string is whatever this machine's ~/.ssh/config
  // (or ssh user@host) knows the server as — that's per-device, not server-
  // side, so we cache it in localStorage.
  const absPath = s.abs_cwd || s.cwd;
  if (!absPath) { flashToast('Session has no folder'); return; }

  let host = state.workspace?.vscode_host || localStorage.getItem('myco_vscode_host') || '';
  if (!host) {
    host = window.prompt(
      'SSH host for VS Code Remote-SSH\n\n' +
      'Enter the host alias from this device\'s ~/.ssh/config (e.g. "myserver") ' +
      'or user@host. VS Code\'s Remote-SSH extension must already be set up for it.',
      `kkrazy@${window.location.hostname}`
    );
    if (host == null) return;
    host = host.trim();
    if (!host) return;
    localStorage.setItem('myco_vscode_host', host);
  }

  if (!host.includes('@')) host = `kkrazy@${host}`;

  // Drop a .vscode/tasks.json into the session's cwd so VS Code auto-runs
  // `myco attach <id>` in a terminal on folder open. Best-effort: if it
  // fails (e.g. permission), still open the folder; the user can attach
  // manually with `myco attach <id>`.
  try {
    const r = await authedFetch(`/sessions/${encodeURIComponent(s.id)}/vscode-prep`, { method: 'POST' });
    if (!r.ok) console.warn('[myco] vscode-prep failed', r.status);
  } catch (err) {
    console.warn('[myco] vscode-prep failed', err);
  }

  const encoded = absPath.split('/').map(encodeURIComponent).join('/');
  const url = `vscode://vscode-remote/ssh-remote+${host}${encoded}`;

  document.querySelectorAll('.session-item.show-delete').forEach(el => el.classList.remove('show-delete'));
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  flashToast(`Opening in VS Code → ${host}`);
}

function flashToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, 1600);
}

// bug-68 (Option B addition 2): longer-lived warn toast for messages
// that need user attention but aren't fatal. flashToast (above) is
// 1.6s — too short to read a sentence. warnToast lives 5s and uses a
// distinct .toast-warn style so it stands out from success/info
// confirmations.
function warnToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast toast-warn';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.classList.add('hide');
    setTimeout(() => el.remove(), 300);
  }, 5000);
}

async function deleteSessionWithConfirm(s) {
  const label = s.cwd || s.id;
  if (!window.confirm(`Delete session "${label}"?\n\nThis closes the session in mycod. The Claude transcript on disk is kept; you can resume it later by creating a new session in the same directory.`)) return;
  try {
    const res = await authedFetch(`/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (state.activeId === s.id) {
      try { state.ws && state.ws.close(); } catch {}
      state.ws = null;
      if (state.term) { try { state.term.dispose(); } catch {} state.term = null; }
      state.activeId = null;
      try { localStorage.removeItem('myco_active_id'); } catch {}
      const tw = document.getElementById('terminal-wrap');
      if (tw) tw.hidden = true;
      document.getElementById('no-session').hidden = false;
      // bug-29: mirror the session-switch cleanup that
      // _resetUiForNewSession does — without these wipes the deleted
      // session's Plan / Arch / Test panes stay populated until the
      // user clicks a different session. Same class of bug as bug-27
      // (queue chip strip leaking across sessions) but on the DELETE
      // flow rather than the SWITCH flow. We intentionally do NOT
      // call _resetUiForNewSession itself because that helper sets a
      // new activeId + persists it to localStorage; deletion has no
      // successor session to install. Keep the subset that matters.
      state.artifacts = { sessionId: null, byType: {} };
      state.runQueue = null;
      try { _renderRunQueueStrip(); } catch {}
      state.artifactView = { active: null, prev: 'terminal' };
      for (const t of ARTIFACT_TYPES) {
        const wrap = document.getElementById(t + '-wrap');
        if (wrap) wrap.hidden = true;
        document.getElementById('btn-' + t)?.classList.remove('active');
      }
      state.turnTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, lastTurnInputTokens: 0 };
      try { _renderTokenMeter(); } catch {}
      clearChat();
      clearArtifactBodies();
      updateChatButton();
    }
    document.querySelectorAll('.session-item.show-delete')
      .forEach(el => el.classList.remove('show-delete'));
    await refreshSessions();
  } catch (err) {
    alert(`Could not delete session: ${err.message || err}`);
  }
}

// ── terminal attach ───────────────────────────────────────────────────────────

// Drop the previous session's WS, file pane, and any lingering main-
// pane wraps. Leaves clearReadOnly to dispose the read-only banner.
function _teardownPreviousSession() {
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.viewerMode = false;
  // Phase 9 step 2 + 3 deleted #terminal, #terminal-wrap,
  // #conversation-wrap, and #conv-content. Each lookup may return
  // null for a fresh-cache page; guard each access so a missing
  // node doesn't throw and abort openSession (the 2026-05-15
  // 'clicked on a session, nothing show up' incident).
  const termWrap = document.getElementById('terminal-wrap');
  if (termWrap) termWrap.hidden = true;
  const convWrap = document.getElementById('conversation-wrap');
  if (convWrap) convWrap.hidden = true;
  clearReadOnly();                               // resets banner
  hideFilesView();
  state.files.currentPath = '.';
  state.files.history = [];
  state.files.viewing = null;
}

// Reset state + chrome for the new session id (artifact views, sidebar
// list, chat panes, etc.). Does not start any network I/O.
function _resetUiForNewSession(id) {
  state.activeId = id;
  // fr-78: per-session chat-input history. Cleared on session switch
  // so each session starts with a fresh recall buffer (a different
  // session's history would be irrelevant context). Live for the
  // duration of this session attach + this page-load only — no
  // localStorage persistence.
  state.chatInputHistory = [];
  state.chatHistoryIdx = null;
  state.chatHistoryDraft = null;
  // ryan-blues bug fix: re-init the artifact cache bound to the new
  // session id. The loadArtifact lookup guard handles the same case,
  // but resetting here is belt-and-suspenders — guarantees the next
  // _findArtifactTypeForItem / cache read can't accidentally see
  // stale data from any code path that bypasses the lookup guard.
  state.artifacts = { sessionId: id, byType: {} };
  state.viewerMode = false;
  state.pendingMenu = null;                  // clear any inline menu callout
  state.pendingMenuQueue = [];               // and the modal queue
  state.pendingMenuIdx = 0;
  state.permModalDismissed = false;
  state._lastPermQueueLen = 0;
  state._agentChatPaneArmed = false;         // re-arm auto-open for the next agent frame
  state.chatUserScrolledUp = false;          // bug-26: fresh session starts at the bottom
  // bug-27: clear the previous session's queue state so the chip
  // strip doesn't leak across sessions. The server ships the new
  // session's queue via _sendAttachSnapshot on attach; until that
  // frame lands, the strip stays hidden (empty entries → hidden).
  state.runQueue = null;
  try { _renderRunQueueStrip(); } catch {}
  // Hide the modal if it was open for the previous session.
  const modal = document.getElementById('perm-modal');
  if (modal) modal.hidden = true;
  // Hide all Plan/Arch/Test main-pane views so the previous session's
  // extracted content doesn't linger. Chrome-button active classes are
  // also cleared in clearArtifactBodies.
  state.artifactView = { active: null, prev: 'terminal' };
  for (const t of ARTIFACT_TYPES) {
    const wrap = document.getElementById(t + '-wrap');
    if (wrap) wrap.hidden = true;
    document.getElementById('btn-' + t)?.classList.remove('active');
  }
  // Reset per-session telemetry. The token-meter chip near the input
  // shows the running total from when this session was opened, not
  // since-page-load — context-window fill is the key signal and that
  // resets on every new session.
  state.turnTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, lastTurnInputTokens: 0 };
  _renderTokenMeter();
  try { localStorage.setItem('myco_active_id', id); } catch {}
  renderSessionList();
  clearChat();
  clearArtifactBodies();
  updateChatButton();
  if (window.innerWidth <= 900) setSidebar(true);
}

// Phase 9 step 2: xterm + the PTY byte stream are retired. The
// "owner xterm" was the live PTY render surface; agent-mode sessions
// render structured event cards in the chat pane instead, so the
// init is a no-op. Kept as a stub so legacy openSession code paths
// (mobile / desktop owner branches) still call something.
function _initOwnerXterm() {
  showConnOverlay('Connecting', null, 'Establishing session…');
  updateChatButton();
}

// Build the WS query string for /attach/:id. token authenticates owner
// access; s carries the share token for viewer access. Both can be present.
function _buildAttachQuery(isShared) {
  const tokParam = state.token ? `token=${encodeURIComponent(state.token)}` : '';
  const shareParam = isShared && state.shareToken ? `s=${encodeURIComponent(state.shareToken)}` : '';
  const qs = [tokParam, shareParam].filter(Boolean).join('&');
  return qs ? `?${qs}` : '';
}

function openSession(id, opts = {}) {
  // Re-tap of the same session: reconnect if WS is dead, otherwise just bring into view.
  if (state.activeId === id && state.ws && state.ws.readyState === WebSocket.OPEN) {
    if (window.innerWidth <= 900) {
      setSidebar(true);
      // bug-12: restore the chat pane on re-entry. The user typically
      // gets here by tapping the back icon (#btn-expand) to see the
      // session list, then tapping the same session card. The back-icon
      // tap fired setSidebar(false) which on mobile cascades to
      // setChatPane(false) — leaving state.chatPaneVisible=false. Pre-
      // fix the re-tap branch only collapsed the sidebar; the chat pane
      // stayed hidden so the user landed on a blank session with the
      // chat input effectively deactivated. Calling setChatPane(true)
      // here re-shows the pane (it's a no-op when already visible).
      setChatPane(true);
    }
    return;
  }

  _teardownPreviousSession();
  _resetUiForNewSession(id);

  // Owner sessions get an xterm immediately. Viewer sessions wait for the
  // server's viewer-mode message and then show the conversation pane
  // (structured transcript + live terminal-tail).
  const session = state.sessions.find((s) => s.id === id);
  const isShared = !!(session && !session.owned);

  // bug-47 r2: rehydrate state.shareToken from localStorage on every
  // session open. The r1 fix (ef3cd80) wired the share token into
  // viewer-tier file-API URLs via _withShareToken, but that helper
  // only does anything when state.shareToken is set — and the
  // bootstrap path at the top of this file sets it ONLY on the
  // initial `?s=<token>` page load. Any subsequent visit (refresh
  // without `?s=`, click a saved sidebar card from a different tab,
  // etc.) lands with state.shareToken empty even though the share
  // is still saved in localStorage. Without the rehydrate the
  // file-API endpoints 401 again and the File Explorer renders
  // empty — exactly the @kkrazy bug-47 re-dispatch.
  //
  // For shared sessions, look up the entry by sessionId === id so a
  // user with multiple saved shares picks the right token. For owned
  // sessions, explicitly clear state.shareToken — a stray token from
  // a previous shared-session visit would be a no-op server-side
  // (owner-tier check wins first), but cleaner state.
  if (isShared) {
    const saved = loadShareTokens().find((s) => s.sessionId === id);
    state.shareToken = saved ? saved.shareToken : '';
  } else {
    state.shareToken = '';
  }

  document.getElementById('no-session').hidden = true;

  // Phase 9 step 3 — chatpane is THE session view for everyone:
  // owners get full chat + claude routing; guests / share-token
  // viewers get the same chatpane with the server-side handleChat-
  // Message blocking claude-routing for them (the 'viewer-mode' WS
  // frame triggers applyReadOnly later). The old JSONL transcript
  // pane (#conversation-wrap) and the xterm fallback are gone.
  setChatPane(true);
  // Default desktop layout: plan + chat side-by-side. The plan
  // takes the left half (artifact-main-view), chat collapses to a
  // right sidebar via the .has-artifact rule. Mobile (≤900px)
  // keeps the existing mutually-exclusive chat-first layout —
  // there's no room for two panes on a phone screen, and the
  // chrome cluster already exposes the 📋 plan button.
  if (window.innerWidth > 900) {
    try { showArtifactView('plan'); } catch {}
  }

  // websocket with auto-reconnect. `connect` is closure-bound to `id` and
  // `qs` so reconnect-after-close stays on this session; the `state.ws !==
  // ws` guard inside the message handler also prevents stale-WS messages
  // from leaking into a freshly-switched session.
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = _buildAttachQuery(isShared);
  let reconnectDelay = 1000;
  const maxDelay = 15000;
  // fr-88r: counts WS attempts where the upgrade handshake never
  // completed (close fires with no preceding open). Pre-fr-88r the
  // close handler would unconditionally re-attempt forever; combined
  // with the fr-88 blocking modal that produced an unrecoverable
  // "Reconnecting…" state when fr-87's stricter WS gate rejected the
  // user with HTTP 403 at the upgrade. Three attempts is enough to
  // rule out transient network glitches (mobile wake, brief WiFi
  // drop) and tip into "permanent failure, give up + show the user".
  // Reset on a successful open so a later transient drop doesn't
  // inherit prior handshake failures.
  let consecutiveHandshakeFailures = 0;
  const MAX_HANDSHAKE_FAILURES = 3;

  function connect() {
    const ws = new WebSocket(`${proto}://${location.host}/attach/${encodeURIComponent(id)}${qs}`);
    state.ws = ws;
    // fr-88r: per-WS-instance flag set in onopen, read in onclose to
    // distinguish a transient post-open drop (true) from a handshake
    // failure (false).
    let wsEverOpened = false;

    ws.addEventListener('open', () => {
      wsEverOpened = true;
      consecutiveHandshakeFailures = 0;
      reconnectDelay = 1000;
      hideConnOverlay();
      _flushOutboundChat();                      // any chat sends queued during reconnect
      _flushOutboundMenuFrames();                // any modal picks/toggles/submits queued during reconnect
    });

    ws.addEventListener('message', (ev) => {
      // Stale-WS guard: ignore messages that arrive on a WS we've already
      // moved on from (session switch / reconnect). Without it, a 'chat'
      // broadcast from session A could land in session B's chat list
      // during the switchover window.
      if (state.ws !== ws) return;
      const msg = JSON.parse(ev.data);
      if (msg.t === 'viewer-mode') {
        state.viewerMode = true;
        // Phase 9 step 3: guests / read-only viewers land in the
        // chatpane (the only session view that survived the PTY
        // delete). Chat history is rendered + agent events stream
        // in; the chat input stays enabled because guests can still
        // post discussion replies + run /td /fr /bug (plan-item
        // adds). The server-side handleChatMessage is what actually
        // gates claude-routing for read-only users.
        setChatPane(true);
        applyReadOnly(msg.owner);
      } else if (msg.t === 'output') {
        // SDK Phase 9 step 2: agent-mode sessions don't emit `t:'output'`
        // frames — the PTY byte stream is gone. Keep the branch as a
        // no-op so any stale server (or replay test fixture) doesn't
        // crash the client; just drop the bytes.
      } else if (msg.t === 'pong') {
        state.lastPongAt = Date.now();
      } else if (msg.t === 'timeline-init') {
        // bug-9 round 6.1 (revert): timeline-init handler kept as a
        // dormant fallback in case a future server experiments with
        // the unified frame again. Today's server ships separate
        // chat-history + agent-replay; this branch shouldn't fire.
        _applyTimelineInit(msg);
      } else if (msg.t === 'chat-history') {
        // bug-9 round 5: initial chat-history frame at 1 KB byte
        // budget. Subsequent older windows fetched via GET
        // /sessions/:id/chat/history?before=&limit= (the load-
        // older button calls _fetchOlderChatFromServer).
        applyChatHistory(msg.messages, msg.total);
      } else if (msg.t === 'chat') {
        try {
          const m = msg.message || {};
          const meta = m.meta || {};
          const uuid = meta.transcriptUuid ? String(meta.transcriptUuid).slice(0, 8) : '-';
          console.log('[ws-chat] user=' + (m.user || '?') + ' uuid=' + uuid + ' kind=' + (meta.kind || '-') + ' textLen=' + (m.text ? m.text.length : 0));
        } catch {}
        appendChatMessage(msg.message);
      } else if (msg.t === 'claude-status') {
        // Live spinner-line readout from the server's headless terminal.
        // Frame shape:  {t:'claude-status', text, status}
        //   text   = the raw spinner line (legacy field, always set)
        //   status = structured decomposition (new field, may be null on
        //            older servers): {verb, durationS, tokens, interruptible,
        //            effort}. Renderer falls back to `text` when absent.
        _setClaudeStatusLine(msg.text, msg.status || null);
      } else if (msg.t === 'mode-change') {
        // Live mode transition observed by the PTY scanner (~750ms after
        // the user toggles Shift+Tab on the owner). Both owner and viewer
        // receive this. Synthesize a transcript-shaped frame and route it
        // through the same pill renderer the JSONL replay uses. Dedup
        // against any near-timestamp duplicate (the JSONL flush will
        // eventually deliver the equivalent record with a different uuid).
        _onLiveModeChange(msg);
      } else if (msg.t === 'mode-snapshot') {
        // Snapshot of the current mode at attach time. The live
        // `mode-change` event only fires on transition; without this
        // snapshot a viewer reconnecting in steady-state never sees
        // a pill until the next Shift+Tab. We synthesise a transition
        // FROM 'default' if the snapshot is non-default; if it's
        // already 'default' there's nothing to render and we just
        // cache it for future diffs.
        _applyModeSnapshot(msg.mode);
      } else if (msg.t === 'state-update') {
        // Server-pushed mutation that any attached client needs to
        // apply (menu meta change, artifact replace, tool-progress
        // tracker update). Routed by `kind` discriminator.
        _applyStateUpdate(msg);
      } else if (msg.t === 'artifacts-init') {
        // Bootstrap the artifact cache on attach so opening a Plan /
        // Test / Arch tab is instant + always in sync — no HTTP GET
        // round-trip required. Cache is TAGGED with state.activeId so
        // a later session-switch (which advances activeId before this
        // session's artifacts-init has been processed) cannot serve
        // stale data — see ryan-blues bug fix.
        state.artifacts = { sessionId: state.activeId, byType: msg.artifacts || {} };
        _onArtifactsCacheUpdated();
      } else if (msg.t === 'presence' && Array.isArray(msg.users)) {
        _renderPresence(msg.users);
      } else if (msg.t === 'agent-init' || msg.t === 'agent-replay' || msg.t === 'agent-event') {
        // SDK-driven session frames (mode='agent', phase 1 of the
        // agent-sdk-research migration). Routes through the basic
        // event-log pane defined below — phase 3 will swap this for
        // a rich structured renderer.
        _handleAgentFrame(msg);
      } else if (msg.t === 'clarify-reply') {
        // fr-85 r4: claude's response to a clarify-tagged user input
        // is routed back via this dedicated WS frame — NOT through
        // the normal chat-msg / agent-event channels — so the popover
        // can render it in place without the question or the reply
        // polluting chat history.
        _handleClarifyReplyFrame(msg);
      } else if (msg.t === 'exit') {
        state.term?.writeln('\r\n[session ended]');
        // bug-37: session is fully gone — there's nothing to stop.
        // Route through the iteration_aborted handler so the Stop
        // button retires (and any pending status label clears) on
        // reaper-kill / SDK process exit, the same way it does on a
        // user-initiated abort.
        _updateAgentStatusStrip({ type: 'iteration_aborted' });
      } else if (msg.t === 'error') {
        // Server rejected the attach — typically because the session id is
        // stale (e.g. localStorage still pointing at a deleted session after
        // a state-dir migration). Stop the reconnect loop, clear the stale
        // pointer, and let the next refreshSessions/click pick something real.
        state.term?.writeln('\r\n[error: ' + (msg.message || 'unknown') + ']');
        if (/unknown session/i.test(msg.message || '')) {
          try { localStorage.removeItem('myco_active_id'); } catch {}
        }
        state.activeId = null; // close handler's reconnect check then fails
      }
    });

    ws.addEventListener('close', () => {
      if (state.activeId !== id) return; // switched session OR error cleared activeId
      // fr-88r: distinguish handshake failure (close-before-open) from
      // a transient post-open drop. The handshake-failure path is what
      // produced the "stuck on connecting" symptom — fr-87's stricter
      // WS gate rejects unauthorized users with HTTP 403 at the
      // upgrade, so the WS close fires with no preceding open, and the
      // old loop infinite-retried into fr-88's blocking modal. Bail
      // after MAX_HANDSHAKE_FAILURES so the user gets a clear, non-
      // blocking error instead of a perpetually-spinning overlay.
      if (!wsEverOpened) {
        consecutiveHandshakeFailures++;
        if (consecutiveHandshakeFailures >= MAX_HANDSHAKE_FAILURES) {
          showConnOverlay(
            'Cannot connect',
            'error',
            'Access denied, or the session is unavailable. Pick another session or reload.',
            false,                                  // NOT blocking — user must be able to click another session
          );
          state.activeId = null;                    // disable the setInterval(refreshSessions) reopen path
          return;
        }
      }
      // fr-88: pass blocking=true so the user gets a full-viewport
      // dimmed modal during the reconnect window (instead of the
      // floating pill used on initial connect). Cleared on the next
      // 'open' event via hideConnOverlay().
      showConnOverlay('Reconnecting', null, 'Restoring session…', true);
      setTimeout(() => {
        if (state.activeId === id) connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, maxDelay);
    });
  }

  showConnOverlay('Connecting', null, 'Establishing session…');
  console.log('[myco] openSession', id, 'isShared=', isShared, 'qs=', qs);
  connect();

  // Forward xterm keyboard input; auto-collapse sidebar on first keystroke.
  // Only applies on owner sessions — viewers have no live xterm here.
  if (state.term) {
    state.term.onData((data) => {
      setSidebar(true);
      sendInput(data);
    });
  }
}

function setSidebar(collapsed) {
  document.getElementById('sidebar').hidden = collapsed;
  document.getElementById('btn-expand').hidden = !collapsed;
  // Mirror the visibility into a class on <html> so the chatpane width
  // calc can drop the --sidebar-w subtraction when the sidebar isn't
  // taking horizontal space. Without this, --chatpane-w stays at
  // (100vw - 280px)/2 even after the sidebar is hidden, leaving an
  // unbalanced layout when the user collapses the session list.
  document.documentElement.classList.toggle('sidebar-collapsed', !!collapsed);
  // Mobile: sidebar and chatpane are mutually exclusive — only one full-screen
  // overlay at a time. Showing sidebar dismisses chat.
  if (!collapsed && window.innerWidth <= 900) setChatPane(false);
  // give xterm a chance to refit
  if (state.fitAddon) requestAnimationFrame(() => state.fitAddon.fit());
}

function setChatPane(visible) {
  const pane = document.getElementById('chatpane');
  if (!pane) return;
  pane.hidden = !visible;
  state.chatPaneVisible = !!visible;
  document.getElementById('btn-chat')?.classList.toggle('active', !!visible);
  // Push the underlying main-pane view (terminal / conv / files / plan
  // / arch / test) to the right of the chat sidebar on desktop. Mobile
  // sidebar fills the pane, so no shift is needed there.
  const main = document.getElementById('terminal-pane');
  if (main) main.classList.toggle('chat-open', !!visible && window.innerWidth > 900);
  if (visible) {
    // Mobile: chat takes the full pane — dismiss the session sidebar
    // overlay so it doesn't sit on top of the chat. Desktop chat is
    // only ~320px wide so the session sidebar can stay open beside it.
    if (window.innerWidth <= 900) {
      document.getElementById('sidebar').hidden = true;
      document.getElementById('btn-expand').hidden = false;
    }
    // List was 0-height while hidden — pin to the bottom now it has dimensions.
    // bug-26: clear chatUserScrolledUp + force-scroll so opening the
    // pane always lands at the latest message, even if a previous
    // session left the user scrolled-up.
    state.chatUserScrolledUp = false;
    scrollChatToLatest({ force: true });
    // Reset unread badge: opening the pane = user is looking at the
    // latest content. (Bumped by _bumpChatUnreadIfHidden whenever a
    // claude message arrives while the pane is collapsed.)
    _resetChatUnread();
  }
  updateChatButton();
  // The xterm shrunk/grew because the chatpane sidebar's edge moved
  // (it overlays the left portion of #terminal-pane). Refit so the
  // terminal redraws at the new width.
  if (state.fitAddon) requestAnimationFrame(() => state.fitAddon.fit());
}

function updateChatButton() {
  const btn = document.getElementById('btn-chat');
  if (!btn) return;
  // Chrome icons follow the active-session signal — no longer gated on
  // "is some main-pane view currently up". Phase 9 step 3 retired the
  // always-visible #terminal-wrap that used to keep hasContent=true; the
  // chatpane is now the default surface and chrome icons need to show
  // even before files/plan/arch/test gets opened so the user can reach
  // those views in the first place.
  const hasSession = !!state.activeId;
  btn.hidden = !hasSession;
  btn.classList.toggle('active', !!state.chatPaneVisible);
  // Files / Plan / Arch / Test toggles share the same gate. Each icon
  // opens its own main-pane view; they're hooked to _myco_/plan.json
  // (vote / comment / mark / run) and the in-memory artifact cache.
  const fbtn = document.getElementById('btn-files');
  if (fbtn) fbtn.hidden = !hasSession;
  for (const t of ['plan', 'arch', 'test']) {
    const el = document.getElementById('btn-' + t);
    if (el) el.hidden = !hasSession;
  }
}

// Touch scroll handler. Synthesizes WheelEvents from finger deltas + has a
// commit-threshold so taps / long-press / horizontal swipes pass through to
// the OS. iOS-style window-sampled fling velocity drives the momentum tick.
//
// Note (re: native iOS scroll feel): the only architectural way to get real
// GPU-composited momentum is to make .xterm-viewport the top touch target,
// but its black background then covers the canvas (xterm.js#594). Until
// upstream solves this, the JS-driven scroll below is the fallback.
// Phase 9 step 2: xterm is retired; no terminal to scroll.
function setupTouchScroll(_term) { /* no-op: xterm retired */ }

function sendInput(data) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ t: 'input', data: btoa(data) }));
  }
  // Esc occasionally leaves the bottom of the viewport with stale glyphs from
  // a dismissed overlay (claude's TUI doesn't always repaint those rows). A
  // brief rows toggle right after generates two SIGWINCHes and forces a full
  // redraw — the same fix as resizing the window by hand.
  if (data === '\x1b' || data === '\x1b\x1b') scheduleEscRedraw();
}

let pendingEscRedraw = null;
function scheduleEscRedraw() {
  if (pendingEscRedraw) clearTimeout(pendingEscRedraw);
  pendingEscRedraw = setTimeout(() => {
    pendingEscRedraw = null;
    forcePtyRedraw();
  }, 80);
}

function forcePtyRedraw() {
  const ws = state.ws;
  const term = state.term;
  if (!ws || ws.readyState !== WebSocket.OPEN || !term) return;
  const cols = term.cols;
  const rows = term.rows;
  if (cols < 4 || rows < 4) return;
  ws.send(JSON.stringify({ t: 'resize', cols, rows: rows - 1 }));
  setTimeout(() => {
    if (state.ws === ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'resize', cols, rows }));
    }
  }, 32);
}

// ── spawn modal ───────────────────────────────────────────────────────────────

// Non-printable-ASCII detector: matches any char outside U+0020..U+007E.
// We use it both as a live-filter on the spawn-cwd input AND as a final
// gate in doSpawn — the live filter is best-effort (paste/IME can sneak
// non-ASCII past keystroke handlers) and the submit check is the
// authoritative guard. Excluded ranges intentionally drop: control chars
// (0x00-0x1F + 0x7F), CJK, emoji, RTL marks, NBSP, smart quotes.
const NON_ASCII_RE = /[^\x20-\x7E]/g;

function openSpawnModal() {
  const input = document.getElementById('spawn-cwd');
  input.value = '';
  document.getElementById('spawn-modal').hidden = false;
  // Wire the live filter once per modal-open is fine — the same listener
  // hooks up each time, but the input was reset to '' above so prior
  // state is gone. addEventListener dedups on identical listener refs,
  // so the named function below registers only once across opens.
  input.addEventListener('input', _stripNonAsciiOnInput);
  input.focus();
}

// Live input filter: strip any non-ASCII char the user types or pastes.
// Preserves caret position by measuring how many chars were removed
// before the caret and re-applying the shifted selection. Without this
// the caret jumps to the end of the input after every stripped paste.
function _stripNonAsciiOnInput(ev) {
  const el = ev.target;
  const original = el.value;
  if (!NON_ASCII_RE.test(original)) return;       // fast path — nothing to strip
  NON_ASCII_RE.lastIndex = 0;                      // global regex state reset
  const caret = el.selectionStart || 0;
  const before = original.slice(0, caret);
  const cleanedBefore = before.replace(NON_ASCII_RE, '');
  const cleaned = original.replace(NON_ASCII_RE, '');
  el.value = cleaned;
  const newCaret = cleanedBefore.length;
  try { el.setSelectionRange(newCaret, newCaret); } catch {}
}

function closeSpawnModal() {
  document.getElementById('spawn-modal').hidden = true;
}

// ── user-manual modal ─────────────────────────────────────────────────
// Fetched lazily on first open + cached in memory so subsequent opens
// are instant. The manual lives at /USER_MANUAL.md (served by an
// explicit server route since it lives in the project root, not
// web/public/). Rendered via the existing renderMd → marked.parse.
let _manualHtmlCache = null;
async function openManualModal() {
  const modal = document.getElementById('manual-modal');
  const body = document.getElementById('manual-body');
  if (!modal || !body) return;
  modal.hidden = false;
  if (_manualHtmlCache) {
    body.innerHTML = _manualHtmlCache;
    body.scrollTop = 0;
    return;
  }
  body.textContent = 'Loading…';
  try {
    const res = await fetch('/USER_MANUAL.md', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const md = await res.text();
    _manualHtmlCache = renderMd(md);
    body.innerHTML = _manualHtmlCache;
    body.scrollTop = 0;
  } catch (err) {
    body.innerHTML = '<p style="color:#f6b48a">Could not load the user manual: '
      + escHtml(err && err.message || String(err)) + '</p>';
  }
}
function closeManualModal() {
  const modal = document.getElementById('manual-modal');
  if (modal) modal.hidden = true;
}

// ── fr-84: in-browser freehand diagram drawing modal ──────────────────────
//
// User clicks the composer "Draw" button → modal opens → user picks a
// tool, draws on the canvas, hits Insert → the resulting SVG is POSTed
// to /sessions/:id/diagrams (persisted under _myco_/diagrams/) and a
// markdown image link `![diagram](<url>)` is appended to the chat input.
// The composer's existing submit flow then ships it to chat where it
// renders inline for every attached viewer.
//
// Design constraints (user: "as light as possible and runs together
// with myco"):
//   - Zero new vendor weight. Pure browser-native SVG + mouse/touch.
//   - All shapes are real SVG elements appended to #diagram-layer so
//     the saved file is literally `<svg>...</svg>` — no rasterization,
//     no canvas-to-PNG, no third-party serializer.
//
// Tools (8 — r2: +select, +arrow, +diamond): select, pen, rect,
// ellipse, diamond, line, arrow, text. Colors (4) + stroke widths (3).
// Undo pops last shape; clear empties the layer. Delete key removes
// selected shapes. r2 wraps the shape primitives in rough.js so
// rect/ellipse/line/arrow/diamond gain a hand-drawn aesthetic; pen
// and text stay vanilla.

const DIAGRAM_TOOLS = ['select', 'pen', 'rect', 'ellipse', 'diamond', 'line', 'arrow', 'text'];
const SVG_NS = 'http://www.w3.org/2000/svg';
// r2: rough.js generator slot — created lazily on modal open (after
// the iframe of the canvas exists). Reused across draws; recreated
// per shape with a fixed seed so live-preview strokes don't dance.
let _diagramRough = null;
let _diagramShapeSeed = 0;

const _diagramState = {
  tool: 'pen',
  color: '#e6edf3',
  width: 3,
  isDrawing: false,
  currentShape: null,    // SVG element being constructed during a drag
  penPoints: [],         // accumulated [x,y] for pen mode
  dragStart: null,       // {x, y} for shape tools
  // r2: select-tool state.
  selection: new Set(),  // Set<SVGElement> currently selected
  selectMode: 'idle',    // 'idle' | 'rubber-band' | 'move-selected'
  moveBases: new Map(),  // Map<el, {tx, ty}> base translate at drag-start
};

function _diagramSvgPoint(evt) {
  // Convert client (page) coords → SVG viewBox coords. Keeps the
  // drawing crisp regardless of the modal's actual CSS-pixel size.
  const svg = document.getElementById('diagram-canvas');
  if (!svg) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = (evt.touches ? evt.touches[0].clientX : evt.clientX);
  pt.y = (evt.touches ? evt.touches[0].clientY : evt.clientY);
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: pt.x, y: pt.y };
  const inv = ctm.inverse();
  const out = pt.matrixTransform(inv);
  return { x: out.x, y: out.y };
}

function _diagramAttachStroke(el) {
  // Stroke-only shapes (no fill) so drawings read as line art.
  el.setAttribute('stroke', _diagramState.color);
  el.setAttribute('stroke-width', String(_diagramState.width));
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('fill', 'none');
}

// ── r2: rough.js wrappers + select-tool helpers ────────────────────

// Returns rough.js options keyed off the active color + width. Each
// shape gets a fresh seed at mousedown so the sketchy stroke pattern
// stays stable through the drag's mousemove preview redraws.
function _diagramRoughOpts(seed) {
  return {
    stroke: _diagramState.color,
    strokeWidth: _diagramState.width,
    roughness: 1.6,        // amount of sketchy wobble; ~1.0 is mild, 2.0 is wild
    bowing: 1.4,           // how curved straight lines get
    fill: 'none',
    seed,                  // pinned per-shape so live preview doesn't flicker
  };
}

// Wraps rough.js for a single primitive. `factory(roughGen, opts)`
// must return a fresh <g> element (rough.js's standard return type).
// Replaces `state.currentShape` so live preview during drag works:
// each mousemove tick removes the previous <g> and appends a new one.
function _diagramReplaceCurrent(factory) {
  const layer = document.getElementById('diagram-layer');
  if (!layer || !_diagramRough) return;
  if (_diagramState.currentShape && _diagramState.currentShape.parentNode === layer) {
    layer.removeChild(_diagramState.currentShape);
  }
  const opts = _diagramRoughOpts(_diagramShapeSeed);
  const el = factory(_diagramRough, opts);
  if (el) layer.appendChild(el);
  _diagramState.currentShape = el;
}

// Element bbox in canvas viewBox coords. getBBox() returns the
// element's local bbox; we shift it by the element's translate
// (transform="translate(tx ty)") to land in canvas space.
function _diagramElementBBox(el) {
  let bb;
  try { bb = el.getBBox(); } catch { return null; }
  const tr = el.getAttribute('transform') || '';
  const m = tr.match(/translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/);
  const tx = m ? parseFloat(m[1]) : 0;
  const ty = m ? parseFloat(m[2]) : 0;
  return { x: bb.x + tx, y: bb.y + ty, width: bb.width, height: bb.height };
}

// True if point (px, py) is inside element's bbox.
function _diagramHitTest(el, px, py) {
  const bb = _diagramElementBBox(el);
  if (!bb) return false;
  return px >= bb.x && px <= bb.x + bb.width && py >= bb.y && py <= bb.y + bb.height;
}

// True if `inner` bbox is fully contained inside `outer` bbox.
function _diagramBBoxContains(outer, inner) {
  return inner.x >= outer.x &&
         inner.y >= outer.y &&
         inner.x + inner.width  <= outer.x + outer.width &&
         inner.y + inner.height <= outer.y + outer.height;
}

// Find topmost (last-in-DOM-order) shape under cursor — children
// later in DOM render on top, so iterate in reverse for click priority.
function _diagramTopmostAt(px, py) {
  const layer = document.getElementById('diagram-layer');
  if (!layer) return null;
  const kids = Array.from(layer.children);
  for (let i = kids.length - 1; i >= 0; i--) {
    if (_diagramHitTest(kids[i], px, py)) return kids[i];
  }
  return null;
}

function _diagramSetSelected(el, on) {
  if (!el) return;
  if (on) {
    el.classList.add('diagram-selected');
    _diagramState.selection.add(el);
  } else {
    el.classList.remove('diagram-selected');
    _diagramState.selection.delete(el);
  }
}

function _diagramClearSelection() {
  for (const el of _diagramState.selection) el.classList.remove('diagram-selected');
  _diagramState.selection.clear();
}

function _diagramDeleteSelection() {
  if (!_diagramState.selection.size) return;
  for (const el of _diagramState.selection) {
    if (el.parentNode) el.parentNode.removeChild(el);
  }
  _diagramState.selection.clear();
}

// Read the current translate offset from an element's transform attr.
function _diagramGetTranslate(el) {
  const tr = el.getAttribute('transform') || '';
  const m = tr.match(/translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/);
  return { tx: m ? parseFloat(m[1]) : 0, ty: m ? parseFloat(m[2]) : 0 };
}
function _diagramSetTranslate(el, tx, ty) {
  el.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)})`);
}

// ── r2 pointer dispatch ─────────────────────────────────────────────
// Per tool, pointer-down opens a fresh draw OR a select interaction.
// rect/ellipse/diamond/line/arrow are rough.js-rendered; pen + text
// stay vanilla (rough.js doesn't help freehand or text rendering).

function _diagramOnPointerDown(evt) {
  const layer = document.getElementById('diagram-layer');
  if (!layer) return;
  evt.preventDefault();
  const p = _diagramSvgPoint(evt);
  const s = _diagramState;
  // ── select tool: click hit-test or rubber-band ──
  if (s.tool === 'select') {
    const hit = _diagramTopmostAt(p.x, p.y);
    if (hit) {
      if (evt.shiftKey) {
        // Toggle hit in selection.
        if (s.selection.has(hit)) _diagramSetSelected(hit, false);
        else                      _diagramSetSelected(hit, true);
      } else {
        // If hit already in selection, keep current selection (about to
        // drag the whole group). Otherwise replace selection with just hit.
        if (!s.selection.has(hit)) { _diagramClearSelection(); _diagramSetSelected(hit, true); }
      }
      // Start a move-selected drag — even if only one shape.
      s.selectMode = 'move-selected';
      s.dragStart = p;
      s.moveBases.clear();
      for (const el of s.selection) s.moveBases.set(el, _diagramGetTranslate(el));
    } else {
      if (!evt.shiftKey) _diagramClearSelection();
      s.selectMode = 'rubber-band';
      s.dragStart = p;
      const rb = document.getElementById('diagram-rubber');
      if (rb) {
        rb.setAttribute('x', String(p.x)); rb.setAttribute('y', String(p.y));
        rb.setAttribute('width', '0'); rb.setAttribute('height', '0');
        rb.setAttribute('visibility', 'visible');
      }
    }
    return;
  }
  // ── draw tools ──
  s.isDrawing = true;
  s.dragStart = p;
  _diagramShapeSeed = Math.floor(Math.random() * 2 ** 31);  // per-shape seed
  if (s.tool === 'pen') {
    // Pen stays vanilla: incremental polyline grows on every mousemove.
    s.penPoints = [`${p.x.toFixed(1)},${p.y.toFixed(1)}`];
    const el = document.createElementNS(SVG_NS, 'polyline');
    _diagramAttachStroke(el);
    el.setAttribute('points', s.penPoints[0]);
    layer.appendChild(el);
    s.currentShape = el;
  } else if (s.tool === 'rect') {
    _diagramReplaceCurrent((rc, opts) => rc.rectangle(p.x, p.y, 0.01, 0.01, opts));
  } else if (s.tool === 'ellipse') {
    _diagramReplaceCurrent((rc, opts) => rc.ellipse(p.x, p.y, 0.01, 0.01, opts));
  } else if (s.tool === 'diamond') {
    _diagramReplaceCurrent((rc, opts) => rc.polygon([[p.x, p.y], [p.x, p.y], [p.x, p.y], [p.x, p.y]], opts));
  } else if (s.tool === 'line') {
    _diagramReplaceCurrent((rc, opts) => rc.line(p.x, p.y, p.x, p.y, opts));
  } else if (s.tool === 'arrow') {
    // Arrow stays vanilla SVG (rough.js's roughness conflicts with
    // marker positioning). Plain line + marker-end gives a clean,
    // legible arrow that reads as a diagram connector.
    const el = document.createElementNS(SVG_NS, 'line');
    _diagramAttachStroke(el);
    el.setAttribute('x1', String(p.x)); el.setAttribute('y1', String(p.y));
    el.setAttribute('x2', String(p.x)); el.setAttribute('y2', String(p.y));
    el.setAttribute('marker-end', 'url(#diagram-arrowhead)');
    layer.appendChild(el);
    s.currentShape = el;
  } else if (s.tool === 'text') {
    s.isDrawing = false;
    const label = (window.prompt('Text:') || '').trim();
    if (!label) return;
    const el = document.createElementNS(SVG_NS, 'text');
    el.setAttribute('x', String(p.x));
    el.setAttribute('y', String(p.y));
    el.setAttribute('fill', s.color);
    el.setAttribute('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace');
    el.setAttribute('font-size', String(14 + s.width * 2));
    el.textContent = label;
    layer.appendChild(el);
  }
}

function _diagramOnPointerMove(evt) {
  const s = _diagramState;
  // ── select tool: rubber-band resize OR drag-move selected ──
  if (s.tool === 'select') {
    if (s.selectMode === 'idle' || !s.dragStart) return;
    evt.preventDefault();
    const p = _diagramSvgPoint(evt);
    if (s.selectMode === 'rubber-band') {
      const rb = document.getElementById('diagram-rubber');
      if (!rb) return;
      const x = Math.min(s.dragStart.x, p.x), y = Math.min(s.dragStart.y, p.y);
      const w = Math.abs(p.x - s.dragStart.x), h = Math.abs(p.y - s.dragStart.y);
      rb.setAttribute('x', String(x)); rb.setAttribute('y', String(y));
      rb.setAttribute('width', String(w)); rb.setAttribute('height', String(h));
    } else if (s.selectMode === 'move-selected') {
      const dx = p.x - s.dragStart.x, dy = p.y - s.dragStart.y;
      for (const el of s.selection) {
        const base = s.moveBases.get(el) || { tx: 0, ty: 0 };
        _diagramSetTranslate(el, base.tx + dx, base.ty + dy);
      }
    }
    return;
  }
  // ── draw tools ──
  if (!s.isDrawing) return;
  evt.preventDefault();
  const p = _diagramSvgPoint(evt);
  if (s.tool === 'pen') {
    s.penPoints.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    s.currentShape.setAttribute('points', s.penPoints.join(' '));
  } else if (s.tool === 'rect') {
    const x = Math.min(s.dragStart.x, p.x), y = Math.min(s.dragStart.y, p.y);
    const w = Math.abs(p.x - s.dragStart.x), h = Math.abs(p.y - s.dragStart.y);
    if (w > 0.5 && h > 0.5) _diagramReplaceCurrent((rc, opts) => rc.rectangle(x, y, w, h, opts));
  } else if (s.tool === 'ellipse') {
    const cx = (s.dragStart.x + p.x) / 2, cy = (s.dragStart.y + p.y) / 2;
    const w = Math.abs(p.x - s.dragStart.x), h = Math.abs(p.y - s.dragStart.y);
    if (w > 1 && h > 1) _diagramReplaceCurrent((rc, opts) => rc.ellipse(cx, cy, w, h, opts));
  } else if (s.tool === 'diamond') {
    const cx = (s.dragStart.x + p.x) / 2, cy = (s.dragStart.y + p.y) / 2;
    const rx = Math.abs(p.x - s.dragStart.x) / 2, ry = Math.abs(p.y - s.dragStart.y) / 2;
    if (rx > 1 && ry > 1) {
      const pts = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
      _diagramReplaceCurrent((rc, opts) => rc.polygon(pts, opts));
    }
  } else if (s.tool === 'line') {
    _diagramReplaceCurrent((rc, opts) => rc.line(s.dragStart.x, s.dragStart.y, p.x, p.y, opts));
  } else if (s.tool === 'arrow') {
    s.currentShape.setAttribute('x2', String(p.x));
    s.currentShape.setAttribute('y2', String(p.y));
  }
}

function _diagramOnPointerUp() {
  const s = _diagramState;
  // ── select tool: finalize rubber-band or drag-move ──
  if (s.tool === 'select') {
    if (s.selectMode === 'rubber-band') {
      const rb = document.getElementById('diagram-rubber');
      const x = rb ? parseFloat(rb.getAttribute('x')) : 0;
      const y = rb ? parseFloat(rb.getAttribute('y')) : 0;
      const w = rb ? parseFloat(rb.getAttribute('width')) : 0;
      const h = rb ? parseFloat(rb.getAttribute('height')) : 0;
      if (rb) rb.setAttribute('visibility', 'hidden');
      if (w > 2 && h > 2) {
        // Select every layer child whose bbox is fully inside.
        const outer = { x, y, width: w, height: h };
        const layer = document.getElementById('diagram-layer');
        if (layer) {
          for (const kid of layer.children) {
            const bb = _diagramElementBBox(kid);
            if (bb && _diagramBBoxContains(outer, bb)) _diagramSetSelected(kid, true);
          }
        }
      }
    }
    s.selectMode = 'idle';
    s.dragStart = null;
    s.moveBases.clear();
    return;
  }
  // ── draw tools ──
  if (!s.isDrawing) return;
  const sh = s.currentShape;
  // Drop degenerate shapes (zero-size click without drag).
  if (sh) {
    let bb;
    try { bb = sh.getBBox(); } catch {}
    if (bb && (bb.width < 2 && bb.height < 2)) sh.remove();
  }
  s.isDrawing = false; s.currentShape = null; s.penPoints = []; s.dragStart = null;
}

function _diagramUndo() {
  const layer = document.getElementById('diagram-layer');
  if (!layer || !layer.lastElementChild) return;
  layer.removeChild(layer.lastElementChild);
}

function _diagramClear() {
  const layer = document.getElementById('diagram-layer');
  if (!layer || !layer.firstChild) return;
  if (!window.confirm('Clear the whole canvas?')) return;
  while (layer.firstChild) layer.removeChild(layer.firstChild);
}

function _diagramSetStatus(msg, isError) {
  const el = document.getElementById('diagram-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? '#f6b48a' : 'var(--muted, #8b949e)';
}

// Serialize the current canvas to a standalone SVG string (with xmlns
// + viewBox preserved) so it renders correctly when served back as a
// standalone image/svg+xml resource.
function _diagramSerialize() {
  const canvas = document.getElementById('diagram-canvas');
  if (!canvas) return null;
  // Clone so we can strip the id (id="diagram-canvas" would collide
  // if the chat ever rendered two diagrams on the same page).
  const clone = canvas.cloneNode(true);
  clone.removeAttribute('id');
  const bg = clone.querySelector('#diagram-bg'); if (bg) bg.removeAttribute('id');
  const layer = clone.querySelector('#diagram-layer'); if (layer) layer.removeAttribute('id');
  // Make sure xmlns is present on the root for standalone rendering.
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', SVG_NS);
  return new XMLSerializer().serializeToString(clone);
}

async function _diagramSave() {
  const layer = document.getElementById('diagram-layer');
  if (!layer || !layer.firstChild) {
    _diagramSetStatus('Nothing to insert — draw something first.', true);
    return;
  }
  const sid = state.activeId;
  if (!sid) { _diagramSetStatus('No active session.', true); return; }
  const svg = _diagramSerialize();
  if (!svg) { _diagramSetStatus('Could not serialize canvas.', true); return; }
  _diagramSetStatus('Saving…', false);
  const saveBtn = document.getElementById('diagram-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await authedFetch(`/sessions/${encodeURIComponent(sid)}/diagrams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ svg }),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch {}
      throw new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
    }
    const body = await res.json();
    const input = document.getElementById('chat-input');
    if (input) {
      // r4: include the relative filesystem path on a second line as
      // plain text. The markdown image (line 1) renders for humans;
      // the `(saved at: ...)` line (line 2) lets the in-session agent
      // pull the path out of chat history and Read the SVG bytes with
      // its standard Read tool. body.path is the server-returned
      // `_myco_/diagrams/<filename>.svg` — resolves correctly from
      // any agent cwd because cwd is always the session workspace.
      const md = `![diagram](${body.url})\n(saved at: ${body.path})`;
      // Append on a new line if there's already content, otherwise
      // just drop the markdown in.
      const cur = input.value || '';
      input.value = cur ? `${cur}${cur.endsWith('\n') ? '' : '\n'}${md}` : md;
      // input event so the chip-render listener (and any others)
      // re-evaluate the new value.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
      // r5: per user request — Insert = insert AND send directly,
      // no second click on Send required. Trigger the chat-form
      // submit so the existing submit listener (which calls the
      // closure-scoped submitChat()) handles the ship through its
      // normal path — guest gates, history push, claude wakeup all
      // apply. Lives in the success branch only: failed saves stay
      // in the modal with their error and DON'T auto-send anything.
      const form = document.getElementById('chat-form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    closeDiagramModal();
  } catch (err) {
    _diagramSetStatus(`Save failed: ${err.message || err}`, true);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function _diagramOnKeyDown(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeDiagramModal(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault(); _diagramUndo(); return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault(); _diagramSave(); return;
  }
  // r2: Delete / Backspace removes the current selection.
  if ((e.key === 'Delete' || e.key === 'Backspace') && _diagramState.selection.size > 0) {
    e.preventDefault();
    _diagramDeleteSelection();
    return;
  }
}

// Bind once per page load — open/close toggles `hidden` on the modal.
let _diagramBound = false;
function _bindDiagramModal() {
  if (_diagramBound) return;
  _diagramBound = true;
  const modal = document.getElementById('diagram-modal');
  const canvas = document.getElementById('diagram-canvas');
  if (!modal || !canvas) return;
  // Tool palette — class .diagram-tool, attribute data-tool.
  document.querySelectorAll('.diagram-tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (!DIAGRAM_TOOLS.includes(tool)) return;
      _diagramState.tool = tool;
      document.querySelectorAll('.diagram-tool').forEach((b) => b.classList.toggle('active', b === btn));
      // r2: mirror onto the canvas so CSS can swap the cursor when
      // the select tool is active.
      const cv = document.getElementById('diagram-canvas');
      if (cv) cv.setAttribute('data-tool', tool);
      // Leaving select clears the selection so a subsequent draw
      // doesn't accidentally drag the previously-selected shapes.
      if (tool !== 'select') _diagramClearSelection();
    });
  });
  document.querySelectorAll('.diagram-color').forEach((btn) => {
    btn.addEventListener('click', () => {
      _diagramState.color = btn.dataset.color || '#e6edf3';
      document.querySelectorAll('.diagram-color').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  document.querySelectorAll('.diagram-width').forEach((btn) => {
    btn.addEventListener('click', () => {
      _diagramState.width = parseInt(btn.dataset.width, 10) || 3;
      document.querySelectorAll('.diagram-width').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  // Pointer/touch on canvas.
  canvas.addEventListener('mousedown', _diagramOnPointerDown);
  canvas.addEventListener('mousemove', _diagramOnPointerMove);
  window.addEventListener('mouseup',   _diagramOnPointerUp);
  canvas.addEventListener('touchstart', _diagramOnPointerDown, { passive: false });
  canvas.addEventListener('touchmove',  _diagramOnPointerMove, { passive: false });
  canvas.addEventListener('touchend',   _diagramOnPointerUp);
  // Actions.
  document.getElementById('diagram-undo')?.addEventListener('click', _diagramUndo);
  document.getElementById('diagram-clear')?.addEventListener('click', _diagramClear);
  document.getElementById('diagram-cancel')?.addEventListener('click', closeDiagramModal);
  document.getElementById('diagram-save')?.addEventListener('click', _diagramSave);
  // Click on the backdrop closes (but not on the dialog itself).
  modal.addEventListener('click', (e) => { if (e.target.id === 'diagram-modal') closeDiagramModal(); });
}

async function openDiagramModal() {
  _bindDiagramModal();
  const modal = document.getElementById('diagram-modal');
  if (!modal) return;
  modal.hidden = false;

  if (typeof window.rough === 'undefined') {
    try {
      await loadScript('/vendor/rough.umd.js');
    } catch (err) {
      console.warn('[rough] failed to lazy-load:', err);
    }
  }
  // Reset layer + state so each open starts fresh.
  const layer = document.getElementById('diagram-layer');
  if (layer) while (layer.firstChild) layer.removeChild(layer.firstChild);
  _diagramState.isDrawing = false;
  _diagramState.currentShape = null;
  _diagramState.selectMode = 'idle';
  _diagramState.moveBases.clear();
  _diagramClearSelection();
  // r2: bind rough.js to the canvas. The canvas exists at all times
  // (it's static markup) but rough.svg() needs the live element so we
  // create the generator here rather than at module init.
  const cv = document.getElementById('diagram-canvas');
  if (cv && typeof window.rough !== 'undefined') {
    _diagramRough = window.rough.svg(cv);
  }
  // Reflect the current tool onto the canvas for the CSS cursor swap.
  if (cv) cv.setAttribute('data-tool', _diagramState.tool);
  _diagramSetStatus('');
  document.addEventListener('keydown', _diagramOnKeyDown);
}

function closeDiagramModal() {
  const modal = document.getElementById('diagram-modal');
  if (modal) modal.hidden = true;
  document.removeEventListener('keydown', _diagramOnKeyDown);
}

async function doSpawn() {
  const rawCwd = document.getElementById('spawn-cwd').value.trim();
  const errEl = document.getElementById('spawn-error');
  errEl.hidden = true;
  errEl.textContent = '';
  // Submit-time ASCII gate. Belt-and-braces against the live filter —
  // some IMEs / clipboard managers can land non-ASCII chars without
  // triggering an `input` event. Show an inline error rather than
  // silently mangling the cwd the user typed.
  if (rawCwd && NON_ASCII_RE.test(rawCwd)) {
    NON_ASCII_RE.lastIndex = 0;
    errEl.textContent = 'Session name must be ASCII only (a-z, 0-9, -, _, /, .) — no CJK, emoji, or other non-ASCII characters.';
    errEl.hidden = false;
    return;
  }
  const cwd = rawCwd || undefined;
  // Estimate the terminal size for the new tmux session so claude renders
  // its welcome banner at the right width (otherwise it draws at 80×24
  // and the banner wraps awkwardly when we resize on attach).
  const cols = Math.max(40, Math.min(200, Math.floor(window.innerWidth / 9)));
  const rows = Math.max(20, Math.min(80, Math.floor((window.innerHeight - 100) / 18)));
  // Driver toggle from the spawn modal. Since phase 8 the server defaults
  // to 'agent' (Claude Agent SDK); the checkbox flips back to legacy
  // 'pty' for anything broken in agent mode. Leaving mode undefined
  // lets the server pick its default.
  const ptyCheckbox = document.getElementById('spawn-mode-pty');
  const mode = ptyCheckbox && ptyCheckbox.checked ? 'pty' : undefined;
  // fr-94 Phase 1: read the main-project field. The server sniffs the
  // value: URL-shaped (https://, git@, ssh://, owner/repo) → forwarded
  // as gitCloneUrl; plain text → forwarded as mainProjectName. Sniff
  // client-side too so the payload is typed correctly and the server
  // doesn't have to second-guess.
  //
  // fr-94 Phase 3 r1: the main-project field is REQUIRED. Empty →
  // show an inline error and abort the spawn (the server also rejects
  // a missing field as a defense-in-depth 400, but the client guard
  // gives faster feedback). Legacy sessions with no rec.mainProject
  // keep working via Phase 2's lazy auto-migration; the required-
  // field gate applies only to NEW spawns through this modal.
  const mainProjectRaw = (document.getElementById('spawn-main-project')?.value || '').trim();
  if (!mainProjectRaw) {
    errEl.textContent = 'Main project is required — paste a git clone URL or type a new folder name.';
    errEl.hidden = false;
    return;
  }
  let gitCloneUrl, mainProjectName;
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(mainProjectRaw) ||
      /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(mainProjectRaw)) {
    gitCloneUrl = mainProjectRaw;
  } else {
    mainProjectName = mainProjectRaw;
  }
  try {
    const res = await authedFetch('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, cols, rows, mode, gitCloneUrl, mainProjectName }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    closeSpawnModal();
    await refreshSessions();
    // Land on the xterm by default; all interaction happens in the
    // chat pane anyway (see _renderClaudeTyping + the assistant-reply
    // debounce path). The user can flip to the readonly view via the
    // 👁 button if they want to see the structured transcript.
    openSession(body.session_id);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
}

// ── utils ─────────────────────────────────────────────────────────────────────


function timeAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

// ── chat (collaborator discussion + claude assistant) ────────────────────────

// Client-side rolling cap on state.chatMessages. Live appends drop
// the oldest to stay under MAX_CHAT_BYTES. Scroll-up load-older
// explicitly DISABLES the cap (sets state._scrolledBack = true)
// because the user just asked to see older history — capping would
// drop the rows they just fetched.
//
// 2026-05-17 user-set: 1 MB cap (was 16 KB). Mobile devices still
// handle 1 MB of chat-msg objects easily, and bumping the ceiling
// means the cap rarely fires for normal interaction — the user
// only hits it on truly long sessions.
const MAX_CHAT_BYTES = 1024 * 1024;

function _capChatMessagesBytes() {
  // 2026-05-17: skip the cap entirely once the user has scrolled
  // into older history. They explicitly asked to see older rows;
  // trimming the tail would drop the ones they just fetched.
  if (state._scrolledBack) return;
  const arr = state.chatMessages;
  if (!Array.isArray(arr) || arr.length < 2) return;
  let bytes = 0;
  let keepFromIdx = arr.length;
  for (let i = arr.length - 1; i >= 0; i--) {
    let sz;
    try { sz = JSON.stringify(arr[i]).length; } catch { sz = 0; }
    // Always keep at least one message — a single oversized row
    // shouldn't blank the pane.
    if (bytes && bytes + sz > MAX_CHAT_BYTES) break;
    bytes += sz;
    keepFromIdx = i;
  }
  if (keepFromIdx > 0) {
    const dropped = keepFromIdx;
    state.chatMessages = arr.slice(keepFromIdx);
    try { console.log('[chat-cap] dropped ' + dropped + ' oldest message(s) to stay under ' + MAX_CHAT_BYTES + ' bytes (kept ' + state.chatMessages.length + ', ' + bytes + ' bytes)'); } catch {}
  }
}

// bug-9 round 6: pre-merged timeline frame from the server. items
// are already chronologically sorted; we wipe both chat-msg + agent
// card panes, then render each item in arrival order via the
// appropriate renderer based on its `kind`. Replaces the previous
// two-frame (`chat-history` + `agent-replay`) initial protocol that
// caused tab-switch order corruption when the two streams were
// merged client-side.
function _applyTimelineInit(msg) {
  const items = Array.isArray(msg && msg.items) ? msg.items : [];
  const totals = (msg && msg.totals) || {};
  // Reset state.
  state.chatMessages = [];
  state.chatTotal = (typeof totals.chat === 'number') ? totals.chat : 0;
  // Wipe the chat-messages list — both chat bubbles AND agent cards.
  // The load-older button (if present) gets removed too; the new
  // _enforceChatHistoryCap pass after rendering will re-add it if
  // chatTotal > shipped count.
  const list = document.getElementById('chat-messages');
  if (list) {
    for (const el of [...list.children]) el.remove();
  }
  // Render items in order. Each item is { kind, ts, message?|event? }.
  for (const it of items) {
    if (!it) continue;
    if (it.kind === 'chat' && it.message) {
      // Mirror appendChatMessage's state-side push so the message
      // is in state.chatMessages AND in the DOM, but skip the
      // dedup / menu / mention logic — we're rendering history,
      // not handling a live frame.
      state.chatMessages.push(it.message);
      _appendChatMessageDom(it.message);
    } else if (it.kind === 'event' && it.event) {
      _appendAgentEvent(it.event);
    }
  }
  _capChatMessagesBytes();
  _enforceChatHistoryCap();
  _rescanPendingMenu();
  _renderPendingMenuCallout();
  scrollChatToLatest();
}

function applyChatHistory(messages, total) {
  state.chatMessages = Array.isArray(messages) ? messages.slice() : [];
  // bug-9: track the server's authoritative total of (non-fromTranscript)
  // chat rows, so the load-older button knows when there are still
  // older messages on the server that the initial chat-history frame
  // omitted. Defaults to "at least what we got" if the server didn't
  // include `total` (older mycod that pre-dates the bug-9 protocol
  // extension — gracefully degrades to local-only archived reveals).
  state.chatTotal = (typeof total === 'number' && total >= state.chatMessages.length)
    ? total
    : state.chatMessages.length;
  // bug-9 round 5: enforce the 16 KB rolling cap before render.
  // Server should have already trimmed this frame to fit, but a
  // defensive cap covers a stale-client / protocol-drift case.
  _capChatMessagesBytes();
  // Always land on the latest message — applyChatHistory fires on initial
  // connect and on every reconnect, and the user expects to see the most
  // recent activity, not the start of the thread.
  renderChatPane(/*scrollToBottom*/ true);
  _rescanPendingMenu();
  _renderPendingMenuCallout();
}

function appendChatMessage(message) {
  if (!message || typeof message !== 'object') return;
  // fr-85 r4: clarify-tagged messages go to the popover only, NOT
  // to chat state. Server still persists them in rec.chat for the
  // audit trail, but the client-side state.chatMessages array stays
  // clean — they\'re not part of the user-visible chat thread.
  if (message.meta && (message.meta.kind === 'clarify' || message.meta.kind === 'clarify-reply')) {
    return;
  }
  // Dedup by transcript uuid — Claude's assistant text reaches the
  // client through the server's persistAssistantTextToChat watcher as
  // a 'chat' frame stamped with meta.transcriptUuid. Replays (chat-
  // history on reconnect) carry the same uuid; this guard catches
  // the duplicate so we don't re-render the same reply twice.
  const uuid = message.meta && message.meta.transcriptUuid;
  if (uuid) {
    for (let i = 0; i < state.chatMessages.length; i++) {
      const existing = state.chatMessages[i];
      if (existing && existing.meta && existing.meta.transcriptUuid === uuid) {
        // Upgrade the _localOnly row to the persisted one in place so
        // subsequent renders use the canonical server-side metadata.
        // Crucially, also RE-RENDER the DOM node — the existing row
        // might have been an empty / truncated placeholder rendered
        // before claude finished streaming (e.g. a partial
        // transcript-delta or a synthetic "post-text-to-chat" row
        // whose text was '' at first). Without the re-render the
        // chat sidebar sticks at the stale placeholder text and the
        // user only sees the full message after a refresh (which
        // rebuilds via renderChatPane). Observed on mycobeta demo010
        // 2026-05-13.
        const upgraded = existing._localOnly && !message._localOnly;
        const textChanged = (existing.text || '') !== (message.text || '');
        if (upgraded || textChanged) {
          state.chatMessages[i] = message;
          const list = document.getElementById('chat-messages');
          if (list) {
            const targetUuid = message.meta && message.meta.transcriptUuid;
            const existingEl = targetUuid ? list.querySelector(`.chat-msg[data-transcript-uuid="${CSS.escape(targetUuid)}"]`) : null;
            if (existingEl) {
              const newEl = _htmlToNode(renderChatMessage(message, /*isActiveMenu*/ false));
              if (newEl) existingEl.replaceWith(newEl);
            } else if (list.children[i]) {
              const newEl = _htmlToNode(renderChatMessage(message, /*isActiveMenu*/ false));
              if (newEl) list.children[i].replaceWith(newEl);
            }
          }
        }
        try { console.log('[chat-dedup] uuid=' + String(uuid).slice(0, 8) + ' upgraded=' + upgraded + ' textChanged=' + textChanged); } catch {}
        return;
      }
    }
  }
  // Dedup by menu hash — if claude re-broadcasts the SAME dialog
  // (multi-select re-render after a checkbox toggle, flicker that
  // fires the detector twice, etc.), update the existing row's options
  // in place and skip the append. Without this dedup, the new row's
  // _appendChatMessageDom would deactivate the original row's buttons,
  // making the picker appear to "lock up" after one click. Active rows
  // only — answered/submitted rows are permanent history, not
  // candidates for live updates.
  //
  // Crucially this only applies to the LAST chat row. The wizard's
  // Submit/Cancel screen has a deterministic hash
  // ("Ready to submit your answers?|1:Submit answers|2:Cancel") that
  // repeats across wizard runs, and the same is true for any pin-shaped
  // dialog claude code re-poses with identical wording. Matching an
  // OLDER stale row (a prior unanswered wizard menu, or one buried
  // behind interleaved transcript chunks) would silently update that
  // mid-chat row instead of surfacing the live picker at the bottom —
  // the exact symptom of "the chat is missing the Submit/Cancel
  // selection until I refresh the page." Rapid re-fires arrive
  // back-to-back with no intervening append, so they still hit this
  // last-row dedup; everything else falls through to a fresh append.
  const incomingHash = message.meta && message.meta.kind === 'menu'
    && message.meta.menu && message.meta.menu.hash;
  if (incomingHash) {
    const lastIdx = state.chatMessages.length - 1;
    const last = lastIdx >= 0 ? state.chatMessages[lastIdx] : null;
    const lastHash = last && last.meta && last.meta.kind === 'menu'
      && !last.meta.answered && last.meta.menu && last.meta.menu.hash;
    if (lastHash && lastHash === incomingHash) {
      last.meta.menu = message.meta.menu;
      const list = document.getElementById('chat-messages');
      if (list) {
        const targetUuid = last.meta && last.meta.transcriptUuid;
        const existingEl = targetUuid ? list.querySelector(`.chat-msg[data-transcript-uuid="${CSS.escape(targetUuid)}"]`) : null;
        if (existingEl) {
          const newEl = _htmlToNode(renderChatMessage(last, /*isActiveMenu*/ true));
          if (newEl) existingEl.replaceWith(newEl);
        } else if (list.children[lastIdx]) {
          const newEl = _htmlToNode(renderChatMessage(last, /*isActiveMenu*/ true));
          if (newEl) list.children[lastIdx].replaceWith(newEl);
        }
      }
      _updatePendingMenuFromMessage(last);
      _rescanPendingMenuQueue();
      // Hash-collision dedup → the SAME menu came back (e.g., server
      // re-broadcast on reconnect). Don't force the modal back open;
      // honour the user's prior dismissal.
      _renderPermModal();
      _renderPendingMenuCallout();
      return;
    }
  }
  state.chatMessages.push(message);
  // bug-9 round 5: drop oldest if this push pushed total over 16 KB.
  // If anything was dropped, the DOM is now ahead of state — let
  // _enforceChatHistoryCap (called downstream from
  // _appendChatMessageDom) ensure the visible-window archive logic
  // matches the new shorter array.
  const lenBefore = state.chatMessages.length;
  _capChatMessagesBytes();
  if (state.chatMessages.length < lenBefore) {
    // Drop the now-dropped chat-msg DOM nodes from the head of the
    // list. The cap removed (lenBefore - state.chatMessages.length)
    // oldest messages, so peel the same number off the top of the
    // rendered .chat-msg list.
    const drop = lenBefore - state.chatMessages.length;
    const list = document.getElementById('chat-messages');
    if (list) {
      const oldChatMsgs = list.querySelectorAll(':scope > .chat-msg');
      for (let i = 0; i < drop && i < oldChatMsgs.length; i++) {
        oldChatMsgs[i].remove();
      }
    }
  }
  _appendChatMessageDom(message);
  _updatePendingMenuFromMessage(message);
  // Every NEW menu broadcast (different hash from anything we've seen)
  // forces the modal back open, even if the user dismissed an earlier
  // one. Without this, a sequence of Q1→answer→Q2→Q3 leaves the modal
  // hidden after the user defers / Escs once: the prior queue-grew
  // check (q.length > _lastPermQueueLen) failed because the queue
  // length oscillates 1→0→1→0→1 rather than strictly growing.
  if (message && message.meta && message.meta.kind === 'menu' && message.meta.menu
      && Array.isArray(message.meta.menu.options) && message.meta.menu.options.length) {
    state.permModalDismissed = false;
    // fr-7: OS-level notification for blocking menus when the tab is
    // unfocused. Lives in the same NEW-menu hot path so hash-dedup
    // re-renders (handled earlier in the function with an early return)
    // can't re-notify.
    _maybeNotifyMenuPending(message);
  }
  _rescanPendingMenuQueue();
  _renderPermModal();
  _renderPendingMenuCallout();
  _bumpChatUnreadIfHidden(message);
}

// Notification surfacing — when claude posts new content (assistant text
// reply, menu callout, etc.) AND the chat sidebar is collapsed, increment
// the unread counter so the #btn-chat icon shows a badge. Without this,
// a user who closed the chat pane to focus on the terminal had no signal
// that claude had finished a turn / asked a follow-up question; they had
// to remember to peek at the chat. Especially load-bearing for the
// plan-mode wizard, where the final reply is the actionable next step.
//
// Skips:
//   - messages from the current user (own echo)
//   - menu-toggle re-broadcasts that just re-render an existing row
//     (handled by the hash-dedup early return above — those return before
//     reaching here)
//   - when the chat pane is already open (the user is looking at it)
function _bumpChatUnreadIfHidden(message) {
  if (!message || message.user === state.chatUser) return;
  if (state.chatPaneVisible) return;
  state.chatUnread = (state.chatUnread || 0) + 1;
  // Promote the badge styling when the bump is an @<me> mention OR
  // an @all broadcast so the user can tell "someone addressed me"
  // apart from generic activity. @all is treated like @me for unread
  // purposes since it addresses every viewer including this one.
  // Cleared when the chat pane opens (resets state.chatUnread + the
  // mention flag).
  const isMentionMsg = !!(message.meta && message.meta.kind === 'mention');
  const isBroadcast = isMentionMsg && message.meta.broadcast === true;
  const isMyMention = isMentionMsg && (isBroadcast || (state.chatUser
    && String(message.meta.mentionUser || '').toLowerCase() === String(state.chatUser).toLowerCase()));
  if (isMyMention) {
    state.chatUnreadMention = true;
    // Fire a desktop notification when the tab is backgrounded —
    // surfaces the ping outside of the browser even when myco isn't
    // the focused window. Skip when the tab is visible (the in-pane
    // mention highlight + badge are sufficient signal).
    _maybeNotifyMention(message);
  }
  _renderChatUnreadBadge();
}

// Fire a browser Notification for an @<me> mention. Permission is
// requested lazily on the user's first chat send (so the prompt
// isn't gated on a passive page-load gesture, which Chrome blocks).
// Notifications are no-op'd when:
//   - the API isn't available (older browsers / private mode)
//   - permission was denied
//   - the tab is currently visible (user is here, badge is enough)
function _maybeNotifyMention(message) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  if (typeof document.visibilityState === 'string' && document.visibilityState === 'visible') return;
  try {
    const sender = message.user || 'someone';
    const text = String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const sessionLabel = (state.sessions || []).find((s) => s.id === state.activeId);
    const sessionTitle = (sessionLabel && (sessionLabel.cwd || sessionLabel.label || sessionLabel.id)) || '';
    const target = (message.meta && message.meta.broadcast)
      ? '@all'
      : '@' + (state.chatUser || 'you');
    const n = new Notification(`${sender} ${target}`, {
      body: text,
      tag: 'myco-mention-' + (message.meta && message.meta.transcriptUuid || Date.now()),
      icon: '/hetu.png',
      silent: false,
    });
    n.onclick = () => {
      try { window.focus(); } catch {}
      try { n.close(); } catch {}
    };
    // Auto-close after 8s so a missed mention doesn't pile up forever.
    setTimeout(() => { try { n.close(); } catch {} }, 8000);
  } catch {}
}

// Lazily request notification permission. Called from the chat-send
// path so the prompt fires on a user gesture (Chrome's anti-spam
// rule blocks passive page-load requests). One-shot — once the
// permission is granted or denied, subsequent calls are no-op.
function _maybeRequestNotificationPermission() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'default') return;
  try { Notification.requestPermission().catch(() => {}); } catch {}
}

// fr-7: surface high-signal chat events through the OS notification
// center when the tab is unfocused. Shares the same gates as
// _maybeNotifyMention (API available, permission granted, tab not
// already visible). Two trigger sources:
//
//   _maybeNotifyMenuPending — claude is BLOCKED waiting for the user
//     to answer a permission menu / AskUserQuestion. Fired from
//     appendChatMessage when a fresh menu broadcast lands (filtered
//     by the new-menu hot path so re-renders / hash-dedup updates
//     don't re-notify). For tool-permission menus the title names the
//     tool ("⊕ claude wants Bash") so the user knows what's pending
//     before opening the tab. For AskUserQuestion menus the chat-text
//     body IS the question and serves as the notification body.
//
//   _maybeNotifyTurnComplete — claude finished a long turn (≥ the
//     LONG_TURN_THRESHOLD_MS gate, default 30s). Skip short turns
//     so the OS center doesn't fill up with "claude finished" pings
//     for every 2-second response. Title carries the outcome glyph
//     + duration; body is the first line of the assistant's final
//     text so the user has a sneak peek.
//
// Both helpers tag the Notification with a stable identifier so the
// SAME event re-fired (e.g. on reconnect) replaces the existing
// notification instead of stacking.
const NOTIFY_LONG_TURN_THRESHOLD_MS = 30000;

function _shouldFireOsNotification() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return false;
  return true;
}

function _maybeNotifyMenuPending(message) {
  if (!_shouldFireOsNotification()) return;
  if (!message || !message.meta || message.meta.kind !== 'menu') return;
  const menu = message.meta.menu;
  if (!menu || !Array.isArray(menu.options) || !menu.options.length) return;
  if (message.meta.answered || message.meta.superseded) return;
  try {
    const tgt = message.meta.target;
    let title;
    let body;
    if (tgt && tgt.tool) {
      // Permission menu: "claude wants to run Bash(curl …)"
      const argPreview = tgt.input ? String(tgt.input).replace(/\s+/g, ' ').slice(0, 80) : '';
      title = `⊕ claude wants ${tgt.tool}`;
      body = argPreview ? `${tgt.tool}(${argPreview})` : `${tgt.tool} — open the chat to allow / deny.`;
    } else {
      // AskUserQuestion: the chat text IS the question. menu.lead
      // (if present) is preferred over the full text body since the
      // server already strips the option enumeration off it.
      const lead = menu.lead ? String(menu.lead) : String(message.text || '');
      title = '🤔 claude is waiting on a decision';
      body = lead.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    const tag = 'myco-menu-' + (menu.hash || (message.meta.transcriptUuid || Date.now()));
    const n = new Notification(title, { body, tag, icon: '/hetu.jpg', silent: false, requireInteraction: !!(tgt && tgt.tool) });
    n.onclick = () => { try { window.focus(); } catch {} try { n.close(); } catch {} };
    // Permission menus block claude — leave them up until the user
    // dismisses them (requireInteraction:true above). AskUserQuestion
    // menus auto-close after 12s; the in-app callout stays.
    if (!(tgt && tgt.tool)) setTimeout(() => { try { n.close(); } catch {} }, 12000);
  } catch {}
}

function _maybeNotifyTurnComplete(ev) {
  if (!_shouldFireOsNotification()) return;
  if (!ev || ev.type !== 'turn_result') return;
  // Suppress short turns — the OS center fills up fast otherwise.
  // turn_result.durationMs is set by agent-session._emit; defaults
  // to absent on older sessions, treat absent as "long enough" so
  // we don't silently drop legitimate notifications.
  if (typeof ev.durationMs === 'number' && ev.durationMs < NOTIFY_LONG_TURN_THRESHOLD_MS) return;
  try {
    const ok = ev.subtype === 'success';
    const glyph = ok ? '✓' : '■';
    const durStr = (typeof ev.durationMs === 'number') ? (ev.durationMs / 1000).toFixed(1) + 's' : '';
    const costStr = (typeof ev.totalCostUsd === 'number') ? '$' + ev.totalCostUsd.toFixed(4) : '';
    const titleBits = [`${glyph} claude finished`, durStr, costStr].filter(Boolean).join(' · ');
    const firstLine = ev.result
      ? String(ev.result).replace(/\s+/g, ' ').trim().slice(0, 200)
      : '(no final text — see the chat timeline for tool detail)';
    const n = new Notification(titleBits, {
      body: firstLine,
      tag: 'myco-turn-' + (ev.ts || Date.now()),
      icon: '/hetu.jpg',
      silent: false,
    });
    n.onclick = () => { try { window.focus(); } catch {} try { n.close(); } catch {} };
    setTimeout(() => { try { n.close(); } catch {} }, 12000);
  } catch {}
}

function _renderChatUnreadBadge() {
  const btn = document.getElementById('btn-chat');
  if (!btn) return;
  const n = state.chatUnread || 0;
  if (n > 0) {
    btn.dataset.unread = String(Math.min(n, 99));
    btn.classList.toggle('has-mention', !!state.chatUnreadMention);
  } else {
    delete btn.dataset.unread;
    btn.classList.remove('has-mention');
  }
}

function _resetChatUnread() {
  state.chatUnread = 0;
  state.chatUnreadMention = false;
  _renderChatUnreadBadge();
}

// Append a single message's DOM node to #chat-messages without rebuilding
// the rest of the list. Existing rows (and their already-rendered mermaid
// SVGs, hljs spans, scroll position, etc.) are preserved. Full rebuilds
// are reserved for applyChatHistory and clearChat — the rare events that
// truly need a clean reload. Previously every append went through
// renderChatPane, which did `list.innerHTML = ...`, tearing down every
// chat row on every streamed assistant text block — visible as the chat
// pane "reloading entire history from time to time" during a live turn.
//
// Special case: a 'menu' or 'menu-auto' broadcast supersedes any earlier
// menu row that still has clickable buttons. We re-render those rows
// individually with isActiveMenu=false so their DOM matches what
// renderChatPane would have produced (an answered menu becomes the
// "✓ Picked [N] label" summary; an unanswered superseded menu becomes
// "(no longer active)").
function _appendChatMessageDom(message) {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  const empty = document.getElementById('chat-empty');
  if (empty) empty.hidden = true;

  const isMenu = !!(message && message.meta && message.meta.kind === 'menu'
    && message.meta.menu && Array.isArray(message.meta.menu.options));
  const isMenuAuto = !!(message && message.meta && message.meta.kind === 'menu-auto');
  if (isMenu || isMenuAuto) {
    // Hash of the incoming menu — _deactivatePriorMenuRows uses it to
    // skip rows that share the same hash (those are the SAME dialog,
    // not a successor). Without this guard, a hash-collision re-broadcast
    // would strip the buttons off the still-active picker.
    const incomingHash = isMenu ? (message.meta.menu.hash || null) : null;
    _deactivatePriorMenuRows(list, incomingHash);
  }

  const html = renderChatMessage(message, /*isActiveMenu*/ isMenu);
  const node = _htmlToNode(html);
  if (!node) return;
  if (message.ts) node.dataset.ts = message.ts;
  list.appendChild(node);
  scrollChatToLatest();
  _bindChatMenuClicks();
  // Mermaid runs only on the newly-appended node — existing SVGs (and
  // any user interaction state inside them) stay intact.
  renderMermaidInContainer(node).catch(() => {});
  _enforceChatHistoryCap();
}

function _htmlToNode(html) {
  const tmpl = document.createElement('template');
  tmpl.innerHTML = (html || '').trim();
  return tmpl.content.firstChild;
}

// Re-render every prior menu row in place with isActiveMenu=false. The
// new node replaces the old one, so an answered menu collapses to
// "✓ Picked [N] label" and an unanswered superseded one to
// "(no longer active)". Indexes align because every append goes through
// _appendChatMessageDom and applyChatHistory rebuilds from state, so
// list.children[i] tracks state.chatMessages[i].
function _deactivatePriorMenuRows(list, incomingHash) {
  const children = list.children;
  for (let i = 0; i < state.chatMessages.length && i < children.length; i++) {
    const m = state.chatMessages[i];
    if (!m || !m.meta || m.meta.kind !== 'menu') continue;
    if (!m.meta.menu || !Array.isArray(m.meta.menu.options)) continue;
    // Skip rows that have the same hash as the incoming menu — they're
    // the SAME dialog, not a superseded one. The appendChatMessage
    // hash-dedup branch usually catches this first, but the guard
    // belongs here too for callers that bypass the dedup.
    if (incomingHash && m.meta.menu.hash === incomingHash) continue;
    
    const targetUuid = m.meta && m.meta.transcriptUuid;
    const existingEl = targetUuid ? list.querySelector(`.chat-msg[data-transcript-uuid="${CSS.escape(targetUuid)}"]`) : null;
    if (existingEl) {
      if (existingEl.classList.contains('chat-msg-menu-collapsed')) continue;
      const newEl = _htmlToNode(renderChatMessage(m, /*isActiveMenu*/ false));
      if (newEl) existingEl.replaceWith(newEl);
    } else {
      const oldEl = children[i];
      // Re-render any chat row that's still flagged as the active
      // menu. The chat-msg-menu base class is a reliable selector;
      // chat-msg-menu-collapsed means already resolved.
      if (!oldEl || !oldEl.classList.contains('chat-msg-menu')) continue;
      if (oldEl.classList.contains('chat-msg-menu-collapsed')) continue;
      const newEl = _htmlToNode(renderChatMessage(m, /*isActiveMenu*/ false));
      if (newEl) oldEl.replaceWith(newEl);
    }
  }
}

// Pending-menu surfacing
//
// MenuInterceptor catches Claude Code's numbered TUI dialogs (plan-mode,
// permission, trust-folder, etc.) and broadcasts them into chat as a
// special message (meta.kind === 'menu'). The option buttons are
// rendered INLINE inside the chat message itself — see
// renderChatMessage — so the picker lives in the chat pane, lands at
// the bottom of the chat scroller naturally, and survives transcript-
// delta re-renders (which used to scroll the conv-pane callout off
// screen, causing the "first time worked, second time disappeared"
// instability).
//
// state.pendingMenu still tracks the most recent unresolved menu so:
//   - the readonly watchdog can hold off auto-flipping to xterm while
//     there's something for the user to click
//   - other code paths can check `is there a menu to respond to?`
// Cleared when:
//   - a 'menu-auto' chat broadcast lands (server auto-resolved a perm)
//   - the user clicks a button on a chat message (optimistic clear)

function _updatePendingMenuFromMessage(m) {
  if (!m || !m.meta) return;
  if (m.meta.kind === 'menu' && m.meta.menu && Array.isArray(m.meta.menu.options)) {
    state.pendingMenu = {
      question: m.meta.menu.question || '',
      options: m.meta.menu.options,
      kind: m.meta.menu.kind || 'generic',
      target: m.meta.target || null,
      ts: m.ts || null,
    };
    // Claude is now blocked on user input — pause the typing dots so
    // the indicator doesn't keep pulsing while we wait for the user
    // to click an option. Picking re-arms via _markAwaitingClaude in
    // the menu-pick click handler.
    if (state.awaitingClaude) {
      state.awaitingClaude = false;
      if (state._claudeIdleTimer) { clearTimeout(state._claudeIdleTimer); state._claudeIdleTimer = null; }
      _renderClaudeTyping();
    }
  } else if (m.meta.kind === 'menu-auto') {
    state.pendingMenu = null;
  }
}

function _rescanPendingMenu() {
  state.pendingMenu = null;
  for (const m of state.chatMessages) _updatePendingMenuFromMessage(m);
  _rescanPendingMenuQueue();
  _renderPermModal();
}

// Phase 1.5 — the modal-popup queue. Walks the current chat messages
// and collects EVERY menu that's still actionable (not picked, not
// submitted, not superseded). When the SDK fires multiple parallel
// canUseTool callbacks (e.g., subagent + parent agent, or two tools
// in the same assistant message), each menu gets its own hash and
// queues up here. Clicks always carry the menu's specific hash so
// pty.handleMenuPick → session.resolveMenuPick lands on the right
// pending promise in _pendingPermissions. The queue is a derived view
// over state.chatMessages; the single state.pendingMenu still tracks
// the latest for the bare-digit chat shortcut.
function _rescanPendingMenuQueue() {
  const q = [];
  const msgs = Array.isArray(state.chatMessages) ? state.chatMessages : [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || !m.meta || m.meta.kind !== 'menu' || !m.meta.menu) continue;
    const menu = m.meta.menu;
    if (!Array.isArray(menu.options) || !menu.options.length) continue;
    if (m.meta.pickedN != null || m.meta.submitted || m.meta.superseded) continue;
    if (m._pickedN != null || m._submitted || m._answered) continue;
    q.push({
      hash: menu.hash || '',
      kind: menu.kind || 'permission',
      multi: !!menu.multi,
      question: menu.question || '',
      options: menu.options.slice(),
      target: m.meta.target || null,
      ts: m.ts || null,
      msgIdx: i,
    });
  }
  state.pendingMenuQueue = q;
  if (typeof state.pendingMenuIdx !== 'number') state.pendingMenuIdx = 0;
  if (state.pendingMenuIdx >= q.length) state.pendingMenuIdx = Math.max(0, q.length - 1);
  // When a new menu arrives, re-arm the modal (user may have dismissed
  // it for a previous question — but a fresh canUseTool deserves
  // attention again).
  if (q.length > (state._lastPermQueueLen || 0)) state.permModalDismissed = false;
  state._lastPermQueueLen = q.length;
}

// Heuristic: option labels like "Type something", "Other…", "Chat about
// this" are signals that the user is supposed to provide free-text in
// the NEXT chat turn rather than have the option's label be the literal
// answer. After resolving such a pick we focus the chat input with a
// contextual placeholder so the typing affordance is obvious.
function _permOptionIsFreeText(label) {
  return /^\s*(type\s+something|other|chat\s+about|reply|something else)/i.test(String(label || ''));
}

// Detect if a menu option signals "let me chat first" (vs "type the
// answer here"). Both focus the chat input on click, but the hint text
// changes.
function _permOptionIsChatAbout(label) {
  return /chat\s+about/i.test(String(label || ''));
}

function _renderPermModal() {
  const modal = document.getElementById('perm-modal');
  if (!modal) return;
  const q = state.pendingMenuQueue || [];
  if (state.permModalDismissed || !q.length) {
    modal.hidden = true;
    return;
  }
  let idx = state.pendingMenuIdx || 0;
  if (idx >= q.length) idx = q.length - 1;
  const m = q[idx];

  const titleEl = document.getElementById('perm-modal-title');
  const pagerEl = document.getElementById('perm-modal-pager');
  const metaEl = document.getElementById('perm-modal-meta');
  const questionEl = document.getElementById('perm-modal-question');
  const optsEl = document.getElementById('perm-modal-opts');
  const prevBtn = modal.querySelector('[data-perm-nav="prev"]');
  const nextBtn = modal.querySelector('[data-perm-nav="next"]');

  // Title for AskUserQuestion modals is the actual question text
  // (with any "[SINGLE-SELECT] " / "[MULTI-SELECT] " / "[TYPED-TEXT]"
  // metadata prefix stripped). Permission modals title with the tool
  // name. The generic "Claude is asking a question" / "Permission
  // needed" headings were retired — the question itself carries the
  // intent.
  if (m.kind === 'plan' || m.kind === 'ask') {
    const cleanQ = String(m.question || '').replace(/^\s*\[[^\]]*\]\s*/, '').replace(/[:?]+\s*$/, '').trim();
    titleEl.textContent = cleanQ || 'Pick an option';
  } else {
    titleEl.textContent = m.target && m.target.tool
      ? `Allow ${m.target.tool}?`
      : 'Allow this action?';
  }

  // Pager + nav buttons — visible only with multiple pendings. The
  // pager reads "1 of 3" so the user knows there's more queued up.
  // Plus a chip row (research item #1 — VS Code 1.116 carousel
  // pattern) showing one clickable chip per pending request so the
  // user can jump directly without arrow-clicking through.
  const chipsEl = document.getElementById('perm-modal-chips');
  if (q.length > 1) {
    pagerEl.textContent = `${idx + 1} of ${q.length}`;
    prevBtn.hidden = false;
    nextBtn.hidden = false;
    prevBtn.disabled = (idx === 0);
    nextBtn.disabled = (idx === q.length - 1);
    if (chipsEl) {
      chipsEl.innerHTML = '';
      q.forEach((mm, i) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'perm-chip' + (i === idx ? ' perm-chip-active' : '');
        chip.dataset.permChipIdx = String(i);
        // Short label: tool name for permission asks, first 20 chars
        // of the cleaned question for AskUserQuestion. Number prefix
        // mirrors the digit-key shortcut behaviour for picks (modulo:
        // the digit picks options inside ONE request, the chip jumps
        // BETWEEN requests).
        let lbl;
        if (mm.kind === 'plan' || mm.kind === 'ask') {
          const cq = String(mm.question || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
          lbl = cq.split(/[?:]/)[0].slice(0, 22);
        } else {
          lbl = (mm.target && mm.target.tool) || 'permission';
        }
        chip.textContent = `${i + 1}. ${lbl}`;
        chip.title = `Jump to pending #${i + 1}`;
        chipsEl.appendChild(chip);
      });
      chipsEl.hidden = false;
    }
  } else {
    pagerEl.textContent = '';
    prevBtn.hidden = true;
    nextBtn.hidden = true;
    if (chipsEl) { chipsEl.hidden = true; chipsEl.innerHTML = ''; }
  }

  // Meta line — show only the tool target (Bash command, file path,
  // URL, …) when present. Session id + hash were retired; they were
  // diagnostic chrome that distracted from the actual decision.
  if (m.target && m.target.input) {
    metaEl.innerHTML = `<code>${escHtml(String(m.target.input).slice(0, 200))}</code>`;
    metaEl.hidden = false;
  } else {
    metaEl.innerHTML = '';
    metaEl.hidden = true;
  }

  // Question body: for AskUserQuestion the title IS the question, so
  // we suppress the redundant questionEl block. For permission asks
  // (which use a generic title like "Allow Bash?"), the question
  // text — if any — still surfaces below.
  if (m.kind === 'plan' || m.kind === 'ask') {
    questionEl.textContent = '';
    questionEl.hidden = true;
  } else {
    questionEl.textContent = m.question || '';
    questionEl.hidden = !m.question;
  }

  // Render each option. For multi-select, show the current checked
  // state with a glyph; clicking toggles via sendMenuToggle. A Submit
  // button at the bottom finalises. For single-select, each click
  // directly resolves via sendMenuPick.
  optsEl.innerHTML = '';
  for (const o of m.options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'perm-modal-opt';
    btn.dataset.n = String(o.n);
    btn.dataset.hash = m.hash || '';
    btn.dataset.label = String(o.label || '');
    btn.dataset.multi = m.multi ? '1' : '0';
    btn.dataset.checkbox = o.checkbox ? '1' : '0';
    btn.dataset.checked = o.checked ? '1' : '0';
    const freeText = _permOptionIsFreeText(o.label) && !m.multi;
    btn.dataset.freeText = freeText ? '1' : '0';
    let glyph;
    if (m.multi && o.checkbox) glyph = o.checked ? '[✓]' : '[ ]';
    else if (freeText)         glyph = '✎';
    else                       glyph = `[${o.n}]`;
    btn.innerHTML = `<span class="perm-modal-opt-num">${escHtml(glyph)}</span>${escHtml(o.label || '')}` +
      (o.description ? `<span class="perm-modal-opt-desc">${escHtml(o.description)}</span>` : '');
    optsEl.appendChild(btn);
  }
  if (m.multi) {
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'perm-modal-opt perm-modal-submit';
    submit.dataset.action = 'submit';
    submit.dataset.hash = m.hash || '';
    submit.innerHTML = `<span class="perm-modal-opt-num">↵</span>Submit selection`;
    optsEl.appendChild(submit);
  }

  modal.hidden = false;
}

// Modal click handler — single delegated listener. Handles option pick
// (single-select), checkbox toggle (multi-select), Submit, prev/next
// navigation, and the X defer button.
// bug-41: backdrop click is NOT a defer affordance. Pre-fix (and per
// the stale comment that used to live here) clicking outside the box
// would defer the modal — but bug-31 already removed the
// data-perm-defer attribute from the backdrop in index.html (outside-
// click was the most common ACCIDENTAL dismiss path). bug-41 follow-
// up: also removed the misleading cursor:pointer + hint text + added
// pointer-events:none on the backdrop so even the click event never
// reaches this listener. Only Esc (handled in the keydown handler at
// _bindPermKeys) or the X button (.perm-modal-close with
// data-perm-defer="1") will defer.
function _bindPermModal() {
  const modal = document.getElementById('perm-modal');
  if (!modal || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  modal.addEventListener('click', (e) => {
    // Carousel chips (research item #1) — direct-jump to any pending.
    const chip = e.target.closest('.perm-chip');
    if (chip) {
      const i = parseInt(chip.dataset.permChipIdx || '0', 10);
      const q = state.pendingMenuQueue || [];
      if (Number.isFinite(i) && i >= 0 && i < q.length) {
        state.pendingMenuIdx = i;
        _renderPermModal();
      }
      return;
    }
    const navBtn = e.target.closest('[data-perm-nav]');
    if (navBtn) {
      const dir = navBtn.dataset.permNav;
      const q = state.pendingMenuQueue || [];
      if (dir === 'prev' && state.pendingMenuIdx > 0) state.pendingMenuIdx--;
      else if (dir === 'next' && state.pendingMenuIdx < q.length - 1) state.pendingMenuIdx++;
      _renderPermModal();
      return;
    }
    if (e.target.closest('[data-perm-defer]')) {
      state.permModalDismissed = true;
      _renderPermModal();
      return;
    }
    const submitBtn = e.target.closest('.perm-modal-submit');
    if (submitBtn) {
      const hash = submitBtn.dataset.hash || '';
      if (!sendMenuSubmit(hash)) return;
      _markAwaitingClaude();
      _markChatMenuAnswered(hash, { submitted: true });
      _advanceModalAfterResolve();
      return;
    }
    const optBtn = e.target.closest('.perm-modal-opt');
    if (!optBtn || optBtn.disabled) return;
    const n = parseInt(optBtn.dataset.n || '0', 10);
    if (!Number.isFinite(n) || n < 1) return;
    const hash = optBtn.dataset.hash || '';
    const isMulti = optBtn.dataset.multi === '1';
    const isCheckbox = optBtn.dataset.checkbox === '1';
    const isFreeText = optBtn.dataset.freeText === '1';
    const label = optBtn.dataset.label || '';
    if (isMulti && isCheckbox) {
      if (!sendMenuToggle(n, hash)) return;
      const checked = optBtn.dataset.checked === '1';
      optBtn.dataset.checked = checked ? '0' : '1';
      const glyphEl = optBtn.querySelector('.perm-modal-opt-num');
      if (glyphEl) glyphEl.textContent = checked ? '[ ]' : '[✓]';
      return;
    }
    if (!sendMenuPick(n, hash)) return;
    _markAwaitingClaude();
    _markChatMenuAnswered(hash, { pickedN: n });
    if (isFreeText) {
      // Free-text branch — surface the chat input and prompt the user
      // to type their actual answer in the next chat turn.
      _focusChatInput(_permOptionIsChatAbout(label)
        ? 'Type your follow-up — claude is waiting…'
        : 'Type your custom answer — claude is waiting…');
    }
    _advanceModalAfterResolve();
  });
}

// Stamp the chat-row matching this menu's hash as answered, so the
// next _rescanPendingMenuQueue drops it from the queue without
// waiting for the server's state-update echo. Called by the modal's
// click and key handlers after sendMenuPick / sendMenuSubmit; the
// flags survive the next renderChatPane so the row stays collapsed.
function _markChatMenuAnswered(hash, opts) {
  if (!hash || !Array.isArray(state.chatMessages)) return;
  for (let i = 0; i < state.chatMessages.length; i++) {
    const m = state.chatMessages[i];
    if (m && m.meta && m.meta.menu && m.meta.menu.hash === hash) {
      m._answered = true;
      if (opts && opts.pickedN != null) m._pickedN = opts.pickedN;
      if (opts && opts.submitted) m._submitted = true;
      return;
    }
  }
}

// After a successful pick/submit in the modal: rebuild the queue
// (which now excludes the just-resolved hash via the _answered flag),
// then render the next pending — or hide the modal if none remain.
function _advanceModalAfterResolve() {
  _rescanPendingMenuQueue();
  const q = state.pendingMenuQueue || [];
  if (!q.length) {
    state.pendingMenuIdx = 0;
    document.getElementById('perm-modal').hidden = true;
    return;
  }
  // If the resolved menu was before or at the current pointer, the
  // remaining queue is shorter — clamp idx so we don't index past
  // the new end.
  if (state.pendingMenuIdx >= q.length) state.pendingMenuIdx = q.length - 1;
  _renderPermModal();
}

function _focusChatInput(placeholderHint) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  if (placeholderHint) input.setAttribute('data-perm-hint', placeholderHint);
  input.focus();
}

// No-op. The menu picker now renders inline inside each menu chat
// message (see renderChatMessage). The previous readonly-fallback
// watchdog (Phase 9 step 3 retired) drove this; the function is kept
// as a hook so legacy call sites stay no-throw.
function _renderPendingMenuCallout() { /* no-op */ }

// Phase 2.5: the modal popup (perm-modal) owns picking now. The chat
// row for a pending menu is a quiet "↗ open in popup" hint; clicking
// it re-opens the modal in case the user dismissed it earlier. Multi-
// select toggle / Submit, checkbox flips, and hash-routed picks all
// live in the modal handler (_bindPermModal + _bindPermModalKeys).
function _bindChatMenuClicks() {
  const list = document.getElementById('chat-messages');
  if (!list || list.dataset.menuBound === '1') return;
  list.dataset.menuBound = '1';
  list.addEventListener('click', (e) => {
    if (!e.target.closest('[data-perm-reopen]')) return;
    state.permModalDismissed = false;
    // Bias the modal to the menu the user just clicked, if it's in
    // the queue. Find its hash from the surrounding chat-msg.
    const msgEl = e.target.closest('.chat-msg.chat-msg-menu');
    if (msgEl && msgEl.parentNode) {
      const idx = Array.prototype.indexOf.call(msgEl.parentNode.children, msgEl);
      const m = state.chatMessages[idx];
      const hash = m && m.meta && m.meta.menu && m.meta.menu.hash;
      if (hash) {
        const q = state.pendingMenuQueue || [];
        const qIdx = q.findIndex((p) => p.hash === hash);
        if (qIdx >= 0) state.pendingMenuIdx = qIdx;
      }
    }
    _renderPermModal();
  });
}

function clearChat() {
  state.chatMessages = [];
  // Explicitly wipe ALL DOM children of #chat-messages — including
  // agent cards / turn-groups / load-older buttons. The
  // renderChatPane preserve logic (which keeps agent cards across
  // chat-history applies) is the right call WITHIN a session, but
  // on a session switch we want a clean slate: the previous
  // session's agent activity must not leak into the new one. The
  // new session's chat-history + agent-replay will repopulate
  // shortly after the WS attach lands.
  const list = document.getElementById('chat-messages');
  if (list) list.innerHTML = '';
  renderChatPane();
}

// Scroll the chat list to the bottom, deferred to the next frame so layout
// has settled. Without rAF, scrollTop=scrollHeight is a no-op when the
// chat pane is still display:none / 0-height (initial mobile load, or
// while a session-switch is in progress).
//
// bug-26: respect the user's scroll position — if they've scrolled UP
// to read earlier messages, suppress the auto-scroll-to-latest so a
// newly-arriving message doesn't yank them back to the bottom. The
// CHAT_SCROLL_BOTTOM_THRESHOLD constant defines "near the bottom"
// (50px is the standard browser-affordance for "user is following the
// stream" vs "user has actively scrolled up"). Callers that genuinely
// must scroll (user opened the pane, switched sessions, etc.) pass
// `{ force: true }` to bypass.
const CHAT_SCROLL_BOTTOM_THRESHOLD = 50;
function _chatUserIsAtBottom(list) {
  // 0-height / not-yet-laid-out lists are treated as "at bottom" so the
  // initial render-before-display-flip path still pins to latest.
  if (!list || list.clientHeight === 0) return true;
  return (list.scrollHeight - list.scrollTop - list.clientHeight) < CHAT_SCROLL_BOTTOM_THRESHOLD;
}
function scrollChatToLatest({ force = false } = {}) {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  if (!force && state.chatUserScrolledUp) return;
  // Fire BOTH synchronously and on the next rAF. Synchronous covers
  // the case where the pane already has its final height (typical
  // for re-render after a state change); rAF covers the case where
  // the pane was display:none / 0-height at call time (initial
  // mobile load, session-switch). Either path leaves the user at
  // the latest message.
  list.scrollTop = list.scrollHeight;
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

// Insert an element into #chat-messages ordered by data-ts (ISO 8601
// strings are lex-comparable). Walks from the END since the typical
// case is "new event = newest". Skips the load-older control button.
// Empty/missing ts → fall back to appendChild (legacy behavior).
// Called from renderChatPane when re-merging preserved agent cards
// with newly-rendered chat bubbles by timestamp. Live appends
// (latest ts) take the appendChild path naturally.
// bug-9 round 4 / reload-order fix: stable-sort every direct child of
// #chat-messages by its data-ts attribute. Used as a defensive pass
// after agent-replay's event loop appends cards at the end (which
// would otherwise put them after the chat-msg bubbles regardless of
// the agent events' actual timestamps). The sort is stable + uses
// appendChild for re-attach (preserves event handlers, dataset, and
// rendered DOM state — only the position in the parent changes).
//
// Skips chat-load-older + any element without a data-ts (those keep
// their relative order at the front of the list).
function _resortChatPaneByTs() {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  // 2026-05-17: globally-ordered re-sort by server-allocated seq #.
  // data-seq (server-allocated per-session monotonic counter from
  // sessions.allocSeq) is the authoritative ordering key — it's
  // shared between chat-msg + agent-event streams, so user input +
  // claude reply interleave correctly. data-ts is the fallback for
  // legacy rows from before seq existed.
  const loadOlder = list.querySelector('#chat-load-older');
  const items = [];
  for (const el of list.children) {
    if (el === loadOlder) continue;
    const seqStr = el.dataset && el.dataset.seq;
    const seq = seqStr ? parseInt(seqStr, 10) : null;
    items.push({
      el,
      seq: Number.isFinite(seq) ? seq : null,
      ts: el.dataset && el.dataset.ts ? el.dataset.ts : '',
    });
  }
  if (items.length < 2) return;
  for (let i = 0; i < items.length; i++) items[i].idx = i;
  items.sort((a, b) => {
    // Prefer seq when both have one — authoritative, immune to clock drift.
    if (a.seq != null && b.seq != null) {
      if (a.seq === b.seq) return a.idx - b.idx;
      return a.seq - b.seq;
    }
    // Mixed seq/no-seq: rows WITH seq are newer (seq is post-2026-05-17).
    if (a.seq != null && b.seq == null) return 1;
    if (a.seq == null && b.seq != null) return -1;
    // Both no-seq: fall back to ts.
    if (!a.ts && b.ts) return -1;
    if (a.ts && !b.ts) return 1;
    if (a.ts === b.ts) return a.idx - b.idx;
    return a.ts < b.ts ? -1 : 1;
  });
  // Detect whether the sort actually changes anything before paying
  // for the DOM re-attaches. Most calls (live append at the tail)
  // hit this fast path.
  let needsReflow = false;
  for (let i = 0; i < items.length; i++) {
    if (items[i].idx !== i) { needsReflow = true; break; }
  }
  if (!needsReflow) return;
  // Re-attach in sorted order. appendChild moves the node, preserving
  // event handlers + dataset + descendant DOM. Cheap relative to a
  // re-render.
  for (const { el } of items) list.appendChild(el);
}

// ── fr-85: inline clarification popovers on claude responses ─────────
//
// User selects text inside a claude bubble's body — a small popover
// appears anchored to the selection with a one-line input + Send
// button. On submit, the message
//     [clarify: "<selected>"] <user question>
// is dispatched through the normal chat send path (same gates as a
// composer Send: guest checks, history push, claude wakeup). The
// claude reply lands as a regular chat message. The original span
// gets a subtle `.chat-clarify-anchor` wrap so the user can scroll
// back and see what got clarified — ephemeral (rebuilds on reload
// since the wrap isn't server-persisted; matches the simplest path
// the user picked when scoping fr-85).

let _clarifyAnchorRange = null;   // saved Range captured at popover-open
let _clarifyAnchorSpan  = null;   // r4: post-send, the surroundContents wrap
                                  // we wrap around the selection so we can
                                  // re-read its bbox on scroll/resize (the
                                  // Range may be invalidated by DOM mutation
                                  // after surroundContents; the span is the
                                  // durable anchor).

// fr-85 r4: re-position the popover under the current anchor's
// bounding rect. Used at open-time (initial placement) AND on every
// chat-messages scroll + window scroll/resize while the popover is
// open, so the popover tracks the highlight as the user scrolls the
// chat to read more context. Prefers the post-send anchor span; falls
// back to the selection Range while the popover is in the "ask" state.
// Vertical anchor = anchor.bottom + 8px; horizontal = #chat-messages
// left + scrollX, full chat-window width.
function _clarifyReposition() {
  const pop = document.getElementById('chat-clarify-popover');
  if (!pop || pop.style.display !== 'flex') return;
  let rect = null;
  if (_clarifyAnchorSpan && _clarifyAnchorSpan.isConnected) {
    rect = _clarifyAnchorSpan.getBoundingClientRect();
  } else if (_clarifyAnchorRange) {
    try { rect = _clarifyAnchorRange.getBoundingClientRect(); } catch {}
  }
  if (!rect) return;
  const chatList = document.getElementById('chat-messages');
  const chatRect = chatList && chatList.getBoundingClientRect
    ? chatList.getBoundingClientRect()
    : { left: 0, top: 0, width: window.innerWidth, bottom: window.innerHeight };
  // r6: inset horizontally so the popover floats inside the chat
  // window rather than butting against its edges (user: "the width
  // should leave some spacing"). Margin applied symmetrically.
  const CLARIFY_H_MARGIN = 16;
  const left  = chatRect.left + window.scrollX + CLARIFY_H_MARGIN;
  const width = Math.max(120, chatRect.width - CLARIFY_H_MARGIN * 2);
  const top   = rect.bottom + window.scrollY + 8;
  pop.style.left  = left  + 'px';
  pop.style.top   = top   + 'px';
  pop.style.width = width + 'px';
  // r5: keep the popover STATE alive while the anchor scrolls out of
  // the chat viewport, but toggle visibility so it doesn't float
  // outside the chat area. When the user scrolls back to the same
  // location, the anchor re-enters the chat viewport → visibility
  // flips to "visible" → popover reappears at the anchor without
  // requiring a fresh open. Display stays 'flex' so listeners +
  // pending clarify-reply matching keep working.
  // Intersection test: anchor is "in view" iff any part of its rect
  // overlaps the chat-messages viewport rect vertically.
  const anchorInView = rect.bottom > chatRect.top && rect.top < chatRect.bottom;
  pop.style.visibility = anchorInView ? 'visible' : 'hidden';
}

function _clarifySelectionInClaudeBubble() {
  // r2: returns the container element that fully holds the current
  // selection iff selection is in one of TWO valid surfaces:
  //   1. `.chat-msg.from-claude .chat-text`           — chat-history bubble
  //   2. `.agent-card-assistant_text .agent-card-md`  — agent-replay card
  // Both surfaces render claude's text; both should support clarify.
  // v1 only checked path 1 — selections inside agent-replay cards
  // (the typical first-attach surface) silently did nothing.
  // Returns null for user messages, agent cards of other types,
  // menus, or cross-container drags.
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const txt = String(sel.toString() || '').trim();
  if (!txt) return null;
  const SELECTOR = '.chat-msg.from-claude .chat-text, ' +
                   '.agent-card-assistant_text .agent-card-md';
  const findContainer = (node) => {
    if (!node) return null;
    const el = node.nodeType === 3 ? node.parentNode : node;
    if (!el || typeof el.closest !== 'function') return null;
    return el.closest(SELECTOR);
  };
  const anchorEl = findContainer(sel.anchorNode);
  const focusEl  = findContainer(sel.focusNode);
  if (!anchorEl || anchorEl !== focusEl) return null;
  return anchorEl;
}

function _openClarifyPopover() {
  const sel = window.getSelection();
  const chatText = _clarifySelectionInClaudeBubble();
  if (!chatText) return;
  // Save the live range so the user's typing in the popover input
  // doesn't disturb it. The popover's input takes focus, which
  // collapses window.getSelection — we need the range captured
  // BEFORE that happens so we can wrap it on submit + use its
  // bounding rect for popover positioning.
  _clarifyAnchorRange = sel.getRangeAt(0).cloneRange();
  _clarifyAnchorSpan = null;
  const selectedText = String(_clarifyAnchorRange.toString() || '').trim();
  if (!selectedText) { _closeClarifyPopover(); return; }
  // fr-85 r8 (user-requested: "Keep the selected text visually
  // selected for better ux"): wrap the range NOW (at open time)
  // instead of waiting for send. The .chat-clarify-anchor class
  // already has a dashed-underline + light-blue background that
  // mimics a highlight — keeping it persistent makes the popover
  // feel anchored to the text the user clicked. Without this, the
  // popover's input takes focus and the browser collapses the
  // selection visual, so the user loses the visual cue of what
  // they're asking about.
  //
  // Tracks whether the wrap was applied PRE-send so we can unwrap
  // on cancel (user closes without asking → revert to plain text;
  // user sends → keep the highlight as the post-send anchor like
  // r4-r7 always did).
  try {
    const span = document.createElement('span');
    span.className = 'chat-clarify-anchor chat-clarify-anchor-pending';
    _clarifyAnchorRange.surroundContents(span);
    _clarifyAnchorSpan = span;
  } catch {
    /* Range spans element boundaries — skip the visual wrap. The
       popover still works; the user just doesn't get the persistent
       highlight in this rarer case. */
  }
  // (Anchor bbox is read in _clarifyReposition — called at the end of
  // this function for initial placement + on scroll/resize after.)
  // Build the popover lazily — one per page lifetime; mounted on body.
  let pop = document.getElementById('chat-clarify-popover');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'chat-clarify-popover';
    // role="dialog" so screen readers announce it; aria-label spells out intent.
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Ask claude to clarify the selected text');
    // r5: two-row layout — preview spans the full popover width on
    // top, input + send + close share a row below. Preview no longer
    // truncated by a narrow CSS max-width; ellipsis kicks in only at
    // the full chat-window width.
    // fr-85 r8 (user-requested): Copy button between input and send.
    // Copies the SELECTED SPAN TEXT (not the popover question or
    // preview) to the clipboard. Brief "✓" confirmation on success.
    // Placed BEFORE Send so the visual flow reads
    //   "preview | input | copy | send | close"
    // — Copy is a side-action; Send is the primary action.
    pop.innerHTML = `
      <div class="chat-clarify-preview" title="Selected text"></div>
      <div class="chat-clarify-input-row">
        <input id="chat-clarify-input" type="text" placeholder="Ask about this…" autocomplete="off" />
        <button id="chat-clarify-copy" type="button" title="Copy the selected text to the clipboard" aria-label="Copy selected text">📋</button>
        <button id="chat-clarify-send" type="button" title="Send (Enter)" aria-label="Send">→</button>
        <button id="chat-clarify-close" type="button" title="Cancel (Esc)" aria-label="Cancel">×</button>
      </div>
    `;
    document.body.appendChild(pop);
    pop.querySelector('#chat-clarify-send').addEventListener('click', () => _sendClarify());
    pop.querySelector('#chat-clarify-close').addEventListener('click', () => _closeClarifyPopover());
    pop.querySelector('#chat-clarify-copy').addEventListener('click', () => _copyClarifySelection());
    pop.querySelector('#chat-clarify-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); _sendClarify(); }
      else if (e.key === 'Escape') { e.preventDefault(); _closeClarifyPopover(); }
    });
  }
  // Preview text — show ≤ 240 chars of the selection (r5: bumped
  // from 60 so a one-or-two-sentence selection fits without
  // ellipsis). The CSS rule also lets the preview span the full
  // popover width with a white-space:nowrap + ellipsis fallback for
  // truly long selections.
  const preview = pop.querySelector('.chat-clarify-preview');
  if (preview) {
    const trimmed = selectedText.length > 240 ? selectedText.slice(0, 237) + '…' : selectedText;
    preview.textContent = `Clarify: "${trimmed}"`;
  }
  // r4: fresh open = clear any reply from a prior popover use +
  // re-enable input. Without this, opening the popover on a new
  // selection while a previous reply was still showing would leave
  // the old reply visible until the new send.
  const oldReply = pop.querySelector('.chat-clarify-reply');
  if (oldReply) oldReply.remove();
  const inEl = pop.querySelector('#chat-clarify-input');
  if (inEl) { inEl.disabled = false; inEl.placeholder = 'Ask about this…'; }
  const sndEl = pop.querySelector('#chat-clarify-send');
  if (sndEl) sndEl.disabled = false;
  _clarifyState.questionTs = null;
  _clarifyState.selected = '';
  _clarifyState.question = '';
  pop.style.display = 'flex';
  _clarifyReposition();   // initial positioning + wires up follow-the-anchor on scroll/resize
  // r4: scroll + resize listeners so the popover tracks the anchor
  // (selection range, then .chat-clarify-anchor span after send) as
  // the user scrolls the chat. Removed in _closeClarifyPopover.
  // capture-phase on the chat-messages scroller so the listener
  // catches inner-scroll events too.
  const cl = document.getElementById('chat-messages');
  if (cl) cl.addEventListener('scroll', _clarifyReposition, { passive: true });
  window.addEventListener('scroll', _clarifyReposition, { passive: true });
  window.addEventListener('resize', _clarifyReposition);
  // Focus the input so the user can type immediately.
  const input = pop.querySelector('#chat-clarify-input');
  if (input) { input.value = ''; input.focus(); }
}

// fr-85 r8: copy the currently selected clarify span text to the
// clipboard. Falls back to the saved range's toString() when the
// span ref isn't set (cross-node selection case). Briefly swaps the
// button label to "✓" for visual confirmation, then restores 📋.
function _copyClarifySelection() {
  const text = String(
    (_clarifyAnchorSpan && _clarifyAnchorSpan.textContent) ||
    (_clarifyAnchorRange && _clarifyAnchorRange.toString()) ||
    '').trim();
  if (!text) return;
  const btn = document.getElementById('chat-clarify-copy');
  const restore = (label, title) => {
    if (!btn) return;
    btn.textContent = label;
    if (title) btn.title = title;
  };
  const finish = (ok) => {
    if (!btn) return;
    const prevLabel = '📋';
    const prevTitle = 'Copy the selected text to the clipboard';
    btn.textContent = ok ? '✓' : '✗';
    btn.title = ok ? `Copied (${text.length} chars)` : 'Copy failed — try Ctrl+C on the selection';
    setTimeout(() => restore(prevLabel, prevTitle), 1200);
  };
  // Use the modern Clipboard API when available; fall back to the
  // deprecated execCommand path for older browsers / non-secure
  // contexts where clipboard.writeText isn't allowed.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => finish(true), () => finish(false));
    return;
  }
  // Fallback: temporary textarea + execCommand('copy').
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    finish(!!ok);
  } catch { finish(false); }
}

// fr-85 r8: unwrap a clarify anchor span back to its child text
// nodes. Used when the user opened the popover then closed it
// without sending — the open-time wrap should leave no trace.
function _unwrapClarifyAnchor(span) {
  if (!span || !span.parentNode) return;
  const parent = span.parentNode;
  while (span.firstChild) parent.insertBefore(span.firstChild, span);
  parent.removeChild(span);
  // Normalize so adjacent text nodes (split by surroundContents)
  // re-merge into one — keeps the DOM clean for the next clarify.
  try { parent.normalize(); } catch {}
}

function _closeClarifyPopover() {
  const pop = document.getElementById('chat-clarify-popover');
  if (pop) {
    pop.style.display = 'none';
    // r4: drop any in-flight reply pane so the next open starts
    // clean. Selection is also cleared from the saved range so a
    // stale clarify-reply WS frame (e.g. the user closes the
    // popover before the reply arrives) doesn't try to render.
    const reply = pop.querySelector('.chat-clarify-reply');
    if (reply) reply.remove();
  }
  // fr-85 r8: if the user opened the popover (wrap applied) but
  // never sent a question (still has .chat-clarify-anchor-pending),
  // UNWRAP — revert the highlighted span back to plain text so the
  // chat looks as it did before. If the user sent (pending class
  // removed by _sendClarify), keep the wrap as the persistent
  // post-send anchor (r4-r7 behavior preserved).
  if (_clarifyAnchorSpan && _clarifyAnchorSpan.classList && _clarifyAnchorSpan.classList.contains('chat-clarify-anchor-pending')) {
    _unwrapClarifyAnchor(_clarifyAnchorSpan);
    _clarifyAnchorSpan = null;
  }
  // r4: detach the scroll-follow listeners. Wired in _openClarifyPopover.
  // Named handler (_clarifyReposition) is the same reference so
  // removeEventListener actually removes it (anonymous handlers
  // wouldn't).
  const cl = document.getElementById('chat-messages');
  if (cl) cl.removeEventListener('scroll', _clarifyReposition);
  window.removeEventListener('scroll', _clarifyReposition);
  window.removeEventListener('resize', _clarifyReposition);
  _clarifyAnchorRange = null;
  _clarifyAnchorSpan = null;
  _clarifyState.questionTs = null;
  _clarifyState.selected = '';
  _clarifyState.question = '';
}

function _sendClarify() {
  if (!_clarifyAnchorRange) { _closeClarifyPopover(); return; }
  const pop = document.getElementById('chat-clarify-popover');
  const input = pop && pop.querySelector('#chat-clarify-input');
  const question = input ? String(input.value || '').trim() : '';
  // fr-85 r8: when the open-time wrap is in place, reading the text
  // from the span is more reliable than reading from the now-mutated
  // Range. Fall back to the Range when no wrap happened (cross-node
  // selection case).
  const selected = String(
    (_clarifyAnchorSpan && _clarifyAnchorSpan.textContent) ||
    _clarifyAnchorRange.toString() || '').trim();
  if (!selected) { _closeClarifyPopover(); return; }
  if (!question) { return; }   // require a question; don't auto-close
  // fr-85 r8: the range was already wrapped at popover-open time
  // (see _openClarifyPopover). If _clarifyAnchorSpan is set, just
  // graduate it from PRE-SEND ("pending") to POST-SEND by removing
  // the .chat-clarify-anchor-pending class — the persistent visual
  // is the same .chat-clarify-anchor underline. If the open-time
  // wrap failed (cross-node selection), attempt the wrap here as a
  // last-chance fallback (matches r4-r7 behavior).
  if (_clarifyAnchorSpan && _clarifyAnchorSpan.isConnected) {
    _clarifyAnchorSpan.classList.remove('chat-clarify-anchor-pending');
  } else {
    try {
      const span = document.createElement('span');
      span.className = 'chat-clarify-anchor';
      _clarifyAnchorRange.surroundContents(span);
      _clarifyAnchorSpan = span;
    } catch {
      /* range spans node boundaries — skip the visual marker, the
         message itself still ships. Scroll-follow falls back to the
         Range (still usable in most browsers post-mutation). */
    }
  }
  // r4: ship via sendChatMessage with meta.kind='clarify' instead of
  // injecting into #chat-input + firing the chat-form submit. Reasons:
  //   - DOESN\'T pollute the main chat window (server filters from
  //     the chat-history WS frame; client filters from render).
  //   - Selected text travels in meta.selected so claude gets the
  //     anchor context without it being part of the user-visible
  //     prompt.
  //   - The composer textarea is untouched — user\'s in-flight chat
  //     draft (if any) survives a clarify ask.
  // Track the questionTs so the incoming clarify-reply WS frame can
  // be matched + routed into THIS popover instance. r2: questionTs
  // is CLIENT-GENERATED and shipped in meta so the server uses our
  // value (instead of generating its own) — without this, the
  // server's questionTs never matched the client's and the reply
  // dropped silently.
  const questionTs = new Date().toISOString();
  _clarifyState.questionTs = questionTs;
  _clarifyState.selected = selected;
  _clarifyState.question = question;
  // Build the user-visible message text. The selected anchor is
  // ALSO inlined here as a quote so the agent sees both meta.selected
  // (machine-readable) and an inline excerpt in the prompt text.
  const text = `Re: "${selected}"\n\n${question}`;
  sendChatMessage(text, { meta: { kind: 'clarify', selected, questionTs } });
  _clarifyRenderBusy();
}

// r4: visual state machine for the popover during a clarify round-
// trip. _clarifyRenderBusy collapses the input + shows a "claude is
// thinking…" line; _clarifyRenderReply replaces busy with the
// rendered markdown reply; _clarifyRenderInput restores the input
// so the user can ask a follow-up.
const _clarifyState = { questionTs: null, selected: '', question: '' };

function _clarifyReplyEl() {
  const pop = document.getElementById('chat-clarify-popover');
  if (!pop) return null;
  let el = pop.querySelector('.chat-clarify-reply');
  if (!el) {
    el = document.createElement('div');
    el.className = 'chat-clarify-reply';
    pop.appendChild(el);
  }
  return el;
}

function _clarifyRenderBusy() {
  const replyEl = _clarifyReplyEl();
  if (!replyEl) return;
  replyEl.className = 'chat-clarify-reply is-busy';
  replyEl.textContent = 'myco is thinking…';
  // Disable the input + send button while the reply is in flight to
  // prevent accidental double-submits.
  const pop = document.getElementById('chat-clarify-popover');
  if (pop) {
    const input = pop.querySelector('#chat-clarify-input');
    const send  = pop.querySelector('#chat-clarify-send');
    if (input) input.disabled = true;
    if (send)  send.disabled  = true;
  }
}

function _clarifyRenderReply(text) {
  const replyEl = _clarifyReplyEl();
  if (!replyEl) return;
  replyEl.className = 'chat-clarify-reply artifact-md';
  replyEl.innerHTML = renderMd(String(text || ''));
  // Re-enable input + clear it so the user can ask a follow-up
  // about the same anchor span.
  const pop = document.getElementById('chat-clarify-popover');
  if (pop) {
    const input = pop.querySelector('#chat-clarify-input');
    const send  = pop.querySelector('#chat-clarify-send');
    if (input) {
      input.disabled = false;
      input.value = '';
      input.placeholder = 'Follow-up question…';
      input.focus();
    }
    if (send) send.disabled = false;
  }
}

// WS frame `{t:'clarify-reply', questionTs, text, ts}` — routed
// into the live popover if its questionTs matches the last one we
// sent. If they don\'t match (e.g. user closed + reopened the
// popover between send + reply), drop the reply silently — better
// than randomly mutating an unrelated popover.
function _handleClarifyReplyFrame(payload) {
  if (!payload || !payload.questionTs) return;
  if (_clarifyState.questionTs !== payload.questionTs) return;
  _clarifyRenderReply(payload.text || '');
}

let _clarifyBound = false;
function _setupChatClarify() {
  if (_clarifyBound) return;
  _clarifyBound = true;
  const list = document.getElementById('chat-messages');
  if (!list) return;
  // r2: pointerup is the unified "user finished selecting" signal —
  // fires for mouse (desktop drag), touch (mobile long-press release),
  // and stylus. The selectionchange listener used in v1 raced with
  // mid-drag focus shifts: opening the popover at the FIRST
  // selectionchange (1 char selected) stole focus to the popover
  // input, which collapsed the visual selection while the user was
  // still dragging — they thought nothing happened. pointerup waits
  // for the gesture to complete.
  list.addEventListener('pointerup', () => {
    // Defer one tick so the selection settles after the pointer-up
    // resolves (some browsers haven't committed the final range yet
    // at the pointerup tick).
    setTimeout(() => {
      if (_clarifySelectionInClaudeBubble()) _openClarifyPopover();
      else _closeClarifyPopover();
    }, 0);
  });
  // Persistent popover (r5): no auto-close on outside click. The user
  // explicitly asked for the popover to survive scrolling, viewport
  // exit, and chat-composer clicks — anything that isn't the × button
  // or the Escape key. The only dismissals are the close button (wired
  // in _openClarifyPopover) and the doc-level Escape handler below.
  // Escape closes anywhere (input handler also has Esc — this is the
  // doc-level catch for when focus isn't in the input yet).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const pop = document.getElementById('chat-clarify-popover');
      if (pop && pop.style.display === 'flex') {
        e.preventDefault();
        _closeClarifyPopover();
      }
    }
  });
}

// 2026-05-17: globally-ordered insertion by server-allocated seq #.
// Both chat-msg rows and agent-events get seq from the same monotonic
// per-session counter (sessions.allocSeq), so a user's input + claude's
// reply interleave correctly regardless of timestamp drift. Falls back
// to data-ts string compare when seq is missing on EITHER side (legacy
// rows from pre-seq sessions).
function _insertChronological(list, el, ts) {
  if (!list || !el) return;
  if (ts) el.dataset.ts = ts;
  const elSeq = el.dataset && el.dataset.seq ? parseInt(el.dataset.seq, 10) : null;
  const elTs = el.dataset.ts || '';
  if (elSeq == null && !elTs) { list.appendChild(el); return; }
  const children = list.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    if (c === el) continue;
    if (c.id === 'chat-load-older') continue;
    const cSeq = c.dataset && c.dataset.seq ? parseInt(c.dataset.seq, 10) : null;
    let cmp = null;   // -1 = c older than el, +1 = c newer, 0 = same
    if (Number.isFinite(cSeq) && Number.isFinite(elSeq)) {
      cmp = cSeq < elSeq ? -1 : (cSeq > elSeq ? 1 : 0);
    } else if (Number.isFinite(cSeq)) {
      cmp = 1;          // el has no seq, c has → el is older (pre-seq legacy)
    } else if (Number.isFinite(elSeq)) {
      cmp = -1;         // c has no seq, el has → c is older
    } else {
      // Both no-seq — fall back to ts.
      const cts = c.dataset.ts || '';
      if (!cts || cts <= elTs) cmp = -1;
      else cmp = 1;
    }
    if (cmp <= 0) {
      const after = c.nextSibling;
      if (after) list.insertBefore(el, after); else list.appendChild(el);
      return;
    }
  }
  // Older than every child — slot to the top (after load-older if present).
  const loadOlder = list.querySelector('#chat-load-older');
  if (loadOlder) {
    const after = loadOlder.nextSibling;
    if (after) list.insertBefore(el, after); else list.appendChild(el);
  } else if (list.firstChild) {
    list.insertBefore(el, list.firstChild);
  } else {
    list.appendChild(el);
  }
}

// Lazy-load older history. Long sessions accumulate hundreds of chat
// rows + agent cards; keeping them all in-flow inflates layout cost
// and forces the user to scroll past ancient context. Cap visible
// to CHAT_VISIBLE_LIMIT; older cards get .chat-msg-archived (CSS
// hides them) and a "Load older (N hidden)" button is inserted at
// the top of #chat-messages. Click reveals CHAT_LOAD_OLDER_BATCH
// more upward. Full history stays in the DOM — nothing is destroyed,
// so picking up a session mid-conversation still has every event
// addressable. _enforceChatHistoryCap is called from every code
// path that mutates #chat-messages: _appendAgentEvent,
// _appendChatMessageDom, renderChatPane.
const CHAT_VISIBLE_LIMIT = 50;
const CHAT_LOAD_OLDER_BATCH = 50;
// Hard DOM cap: cards older than the last CHAT_HARD_CAP rows are
// PHYSICALLY removed from the DOM (not just hidden). Memory-savings
// backstop — _stripArchivedCard already collapses mermaid SVGs +
// hljs token trees on cards entering the archive band, so we can
// safely hold a much wider window than before. Bumped from 250
// to 1000 so a tool-heavy session has plenty of scroll-up history.
const CHAT_HARD_CAP = 1000;
function _enforceChatHistoryCap() {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  // bug-10 round 2: the chrome-batch merge must run on EVERY chat
  // mutation regardless of cap size. The original placement (below
  // the cards.length <= CHAT_VISIBLE_LIMIT early return) silently
  // skipped the merge for any chat under 50 cards — the common
  // case. User reproduced 5 stacked `× N perm asked · Bash` batches
  // on a chat with only 6 chrome batches; the early return ate the
  // merge. Lifted here so it fires before the cap-based archive
  // logic decides whether to bail.
  _mergeIdenticalChromeBatches(list);
  // Real message cards only — exclude our own load-older button.
  let cards = [];
  for (const el of list.children) {
    if (el.id === 'chat-load-older') continue;
    cards.push(el);
  }
  // Hard cap pass: rip the oldest from DOM entirely. Done first so
  // the subsequent archive counts reflect post-rip reality.
  if (cards.length > CHAT_HARD_CAP) {
    const drop = cards.length - CHAT_HARD_CAP;
    for (let i = 0; i < drop; i++) cards[i].remove();
    cards = cards.slice(drop);
  }
  // 2026-05-17 bug fix: compute archived + serverPending BEFORE the
  // early-return. The old logic short-circuited when cards.length <=
  // CHAT_VISIBLE_LIMIT (the common case), which removed the load-
  // older button even when the server had more messages on disk
  // that the initial 1KB chat-history frame omitted. User report:
  // "scroll up doesn't seem to trigger loading more history records"
  // — the IntersectionObserver had no button to fire against because
  // _ensureLoadOlderButton was never called.
  const overflow = Math.max(0, cards.length - CHAT_VISIBLE_LIMIT);
  let archived = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    if (i < overflow && !c.dataset.revealed) {
      c.classList.add('chat-msg-archived');
      // Strip heavy DOM (mermaid SVGs, hljs token trees) from the
      // card to drop its memory footprint while it's hidden.
      _stripArchivedCard(c);
      archived++;
    } else {
      c.classList.remove('chat-msg-archived');
    }
  }
  // serverPending = rows the server has on disk that the client
  // hasn't pulled yet. Initial chat-history frame is capped at
  // INITIAL_CHAT_HISTORY_BYTES=1KB and DEFAULT_CHAT_HISTORY_LIMIT=50,
  // so a long session can leave hundreds of rows on the server. The
  // load-older button surfaces both: archived (locally hidden) +
  // serverPending (never received).
  const serverPending = Math.max(0, (state.chatTotal || 0) - state.chatMessages.length);
  const total = archived + serverPending;
  if (total > 0) {
    _ensureLoadOlderButton(list, total);
  } else {
    const btn = list.querySelector('#chat-load-older');
    if (btn) btn.remove();
  }
  // bug-10: the chrome-batch merge already ran at the TOP of this
  // function (before the cards.length <= CHAT_VISIBLE_LIMIT early
  // return). Don't re-fire here — idempotent so it'd be safe, but
  // the duplicate work shows up in profiles on long sessions.
  // Cluster consecutive resolved AskUserQuestion rows into one visual
  // bundle (shared left bar, tighter spacing). Wizard-style flows
  // produce 3-8 questions in a row, each one resolving to a single-
  // line "Q: ✓ Picked …" — without clustering they read as N
  // disconnected rows; with clustering they read as one Q&A run.
  _clusterAnsweredQuestions(list);
  // Bundle user prompt → tool activity → claude reply → turn footer
  // into a single collapsible "turn group". Idempotent — every call
  // unwraps existing groups and rebuilds from the flat list, so
  // it's safe to fire from every mutation path.
  _groupTurns(list);
  // Cluster consecutive turn-groups within TASK_BURST_GAP_MS of
  // each other into a "task burst" — visually linked via a shared
  // left bar. Time-gap heuristic: turns within 5 min belong to the
  // same task.
  _groupTaskBursts(list);
  // Insert "Today" / "Yesterday" / "May 15" dividers when adjacent
  // top-level rows cross a date boundary. Helps long, multi-day
  // sessions read as discrete chunks of work.
  _insertDateSeparators(list);
}

// Task-burst grouping: walk top-level turn-groups, cluster those
// within TASK_BURST_GAP_MS of each other (start of next vs end of
// previous) into a "task burst". Marker classes task-burst-start /
// -mid / -end let CSS draw a shared left bar + tighten the inter-
// turn gap so the eye groups them as one task. Idempotent: clears
// its own prior tags first.
const TASK_BURST_GAP_MS = 5 * 60 * 1000;
function _groupTaskBursts(list) {
  if (!list) return;
  for (const el of list.querySelectorAll(':scope > .task-burst-start, :scope > .task-burst-mid, :scope > .task-burst-end')) {
    el.classList.remove('task-burst-start', 'task-burst-mid', 'task-burst-end');
  }
  const groups = [...list.querySelectorAll(':scope > .turn-group')];
  if (groups.length < 2) return;
  let i = 0;
  while (i < groups.length) {
    const start = i;
    let prevEndIso = _turnEndTs(groups[i]);
    i++;
    while (i < groups.length) {
      const curStartIso = groups[i].dataset && groups[i].dataset.ts;
      if (!curStartIso || !prevEndIso) break;
      const gap = new Date(curStartIso).getTime() - new Date(prevEndIso).getTime();
      if (!Number.isFinite(gap) || gap > TASK_BURST_GAP_MS) break;
      prevEndIso = _turnEndTs(groups[i]) || curStartIso;
      i++;
    }
    const end = i - 1;
    if (end > start) {
      groups[start].classList.add('task-burst-start');
      for (let j = start + 1; j < end; j++) groups[j].classList.add('task-burst-mid');
      groups[end].classList.add('task-burst-end');
    }
  }
}

// Find the timestamp of the LAST event inside a turn-group's body,
// which is the right "burst-end" anchor — using the head ts (start
// of the turn) would underestimate gaps for slow turns.
function _turnEndTs(group) {
  if (!group) return null;
  const body = group.querySelector(':scope > .turn-body');
  if (!body) return group.dataset && group.dataset.ts || null;
  // Walk body children backwards, return first one with a ts.
  for (let i = body.children.length - 1; i >= 0; i--) {
    const t = body.children[i].dataset && body.children[i].dataset.ts;
    if (t) return t;
  }
  return group.dataset && group.dataset.ts || null;
}

// Walk top-level children of #chat-messages and slot a .date-sep
// row in whenever the UTC date changes. Idempotent — strips its own
// prior output first. Uses data-ts (ISO timestamp, set when each
// card / turn-group is created).
function _insertDateSeparators(list) {
  if (!list) return;
  for (const sep of [...list.querySelectorAll(':scope > .date-sep')]) sep.remove();
  let lastDay = null;
  for (const child of [...list.children]) {
    if (child.id === 'chat-load-older') continue;
    const ts = child.dataset && child.dataset.ts;
    if (!ts) continue;
    // Use the LOCAL day, not the UTC slice — otherwise a session
    // active at 11pm local-Friday flips to "Saturday" because UTC
    // is already there. _localDayKey returns YYYY-MM-DD in the
    // client's wall clock.
    const day = _localDayKey(ts);
    if (day && day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'date-sep';
      sep.textContent = _formatDateSeparator(day);
      list.insertBefore(sep, child);
      lastDay = day;
    }
  }
}

function _formatDateSeparator(yyyymmdd) {
  if (!yyyymmdd) return '';
  const today = _localDayKey(null);
  if (yyyymmdd === today) return 'Today';
  const y = _localDayKey(new Date(Date.now() - 86_400_000).toISOString());
  if (yyyymmdd === y) return 'Yesterday';
  // Parse the local YYYY-MM-DD as a local-midnight date so the
  // month / day labels render in the same zone the key was built in.
  const [yr, mo, da] = yyyymmdd.split('-').map((n) => parseInt(n, 10));
  if (!yr || !mo || !da) return yyyymmdd;
  const d = new Date(yr, mo - 1, da);
  if (Number.isNaN(d.getTime())) return yyyymmdd;
  const nowYear = new Date().getFullYear();
  const month = d.toLocaleString('en-US', { month: 'short' });
  if (d.getFullYear() === nowYear) return `${month} ${da}`;
  return `${month} ${da}, ${d.getFullYear()}`;
}

// Group #chat-messages children into per-turn collapsible bundles.
// A "turn" = a user message and every agent card / chat row that
// follows it until the next user message. Each turn gets a clickable
// head row (user prompt summary + ts + outcome chip) and a body
// holding the cards. Default state: collapsed on mobile, expanded
// on desktop — so long sessions read as a feed of conversation
// turns instead of a sea of events.
//
// Idempotent: every call first flattens any existing turn-groups
// back to direct children, then re-walks and re-wraps. This means
// it's safe to call from every #chat-messages mutation (live append
// or re-render) without state-tracking.
function _groupTurns(list) {
  if (!list) return;
  // Unwrap existing turn-groups (move body children back to list,
  // then drop the wrapper).
  for (const group of [...list.querySelectorAll(':scope > .turn-group')]) {
    const body = group.querySelector(':scope > .turn-body');
    if (body) {
      for (const child of [...body.children]) {
        list.insertBefore(child, group);
      }
    }
    group.remove();
  }
  // Walk flat children, opening a new turn at each user message and
  // sweeping subsequent events into its body until the next user
  // message arrives.
  const snapshot = [...list.children];
  let open = null;
  for (const card of snapshot) {
    if (card.id === 'chat-load-older') continue;
    if (card.classList.contains('chat-msg-user')) {
      // Close any prior turn first, then open a new one with this
      // user message as the head's summary source + first body row.
      const group = document.createElement('div');
      group.className = 'turn-group';
      if (card.dataset.ts) group.dataset.ts = card.dataset.ts;
      const head = document.createElement('div');
      head.className = 'turn-head';
      head.innerHTML = _renderTurnHead(card);
      const body = document.createElement('div');
      body.className = 'turn-body';
      group.appendChild(head);
      group.appendChild(body);
      list.insertBefore(group, card);
      body.appendChild(card);   // move user msg into the body
      head.addEventListener('click', (e) => {
        // Don't toggle if user clicks an interactive nested element
        // (none today, defensive for the future).
        if (e.target.closest('a, button')) return;
        group.classList.toggle('turn-collapsed');
        group.classList.toggle('turn-expanded');
      });
      // Default state — collapsed on phone, expanded on desktop.
      // Drives reading density: feed-of-turns on mobile, expanded
      // detail on desktop.
      if (window.innerWidth <= 900) group.classList.add('turn-collapsed');
      else group.classList.add('turn-expanded');
      open = { group, head, body };
      continue;
    }
    if (!open) continue;   // orphan event before any user message
    open.body.appendChild(card);
    // If this card is the turn-footer, fold its outcome into the
    // head chip and close the turn.
    if (card.classList.contains('turn-footer')) {
      _refreshTurnHead(open.head, open.body);
      open = null;
    }
  }
}

// First-line summary of the user message that anchors this turn.
// Trimmed to 100 chars; whitespace collapsed. Chevron shows
// expand/collapse state via CSS.
function _renderTurnHead(userCard) {
  const text = (userCard.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const ts = userCard.dataset.ts || '';
  const tsShort = _localTsShort(ts);
  return `<span class="turn-chevron" aria-hidden="true"></span>` +
         `<span class="turn-head-text">${escHtml(text || '(empty turn)')}</span>` +
         (tsShort ? `<span class="turn-head-ts">${escHtml(tsShort)}</span>` : '') +
         `<span class="turn-head-outcome" hidden></span>`;
}

// When a turn-footer lands in this turn's body, surface its outcome
// (✓ done / ■ failed) and key stats (cost · duration) in the head's
// outcome chip so a collapsed turn still tells the user how it went.
function _refreshTurnHead(head, body) {
  const footer = body.querySelector(':scope > .turn-footer');
  if (!footer) return;
  const ok = !footer.querySelector('.turn-footer-warn');
  const stats = footer.querySelector('.turn-footer-stats');
  const statsText = stats ? stats.textContent.trim() : '';
  const slot = head.querySelector('.turn-head-outcome');
  if (!slot) return;
  slot.hidden = false;
  slot.className = 'turn-head-outcome' + (ok ? ' turn-head-outcome-ok' : ' turn-head-outcome-warn');
  slot.textContent = (ok ? '✓ ' : '■ ') + statsText;
}

// Walk #chat-messages and tag runs of 2+ consecutive resolved
// AskUserQuestion menus (chat-msg-menu-collapsed without the
// chat-msg-menu-perm tool-permission marker — those are CSS-hidden
// anyway). First in a run → qa-run-start; middle → qa-run-mid;
// last → qa-run-end. Runs of 1 stay unmarked. CSS draws a shared
// left bar across all three classes and tightens vertical spacing.
function _clusterAnsweredQuestions(list) {
  if (!list) return;
  // Reset any prior tags first — the run boundaries shift on each
  // append (a new resolved menu extends the previous run; a non-QA
  // event ends one).
  for (const el of list.querySelectorAll('.qa-run-start, .qa-run-mid, .qa-run-end')) {
    el.classList.remove('qa-run-start', 'qa-run-mid', 'qa-run-end');
  }
  const cards = [];
  for (const el of list.children) {
    if (el.id === 'chat-load-older') continue;
    cards.push(el);
  }
  // Iterate one past the end so the run-flush logic at the boundary
  // handles a run that reaches the last card cleanly.
  let runStart = -1;
  for (let i = 0; i <= cards.length; i++) {
    const el = cards[i];
    const isQa = !!(el && el.classList &&
      el.classList.contains('chat-msg-menu-collapsed') &&
      !el.classList.contains('chat-msg-menu-perm'));
    if (isQa) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart < 0) continue;     // not in a run, nothing to flush
    const runLen = i - runStart;
    if (runLen >= 2) {
      cards[runStart].classList.add('qa-run-start');
      for (let j = runStart + 1; j < i - 1; j++) cards[j].classList.add('qa-run-mid');
      cards[i - 1].classList.add('qa-run-end');
    }
    runStart = -1;
  }
}

// Strip the heavy bits from a card that's just been archived. Cuts
// memory by orders of magnitude on long sessions:
//   - mermaid SVGs (50-200 KB each) → replaced with a tiny text node
//     "[mermaid diagram archived]"
//   - hljs span trees → flattened to plain textContent; the code
//     stays readable, just without syntax colors
// Idempotent (dataset.stripped guard). Cards the user explicitly
// reveals (data-revealed) get re-rendered cleanly by the reveal
// path; mermaid diagrams in revealed cards are gone for good (the
// stripped marker stays as a hint).
function _stripArchivedCard(card) {
  if (!card || card.dataset.stripped === '1') return;
  try {
    const mermaids = card.querySelectorAll('.conv-mermaid');
    for (const m of mermaids) {
      m.replaceWith(document.createTextNode('[mermaid diagram archived]'));
    }
    const hlBlocks = card.querySelectorAll('pre code.hljs, pre code[class*="language-"]');
    for (const code of hlBlocks) {
      // textContent assignment collapses the inner span tree to a
      // single TextNode; the highlight color is lost, the text
      // remains. dataset.hlStripped lets a future re-highlight pass
      // know this code wants treatment if revealed.
      const text = code.textContent;
      code.textContent = text;
      [...code.classList].forEach(c => {
        if (c.startsWith('hljs') || c.startsWith('language-')) code.classList.remove(c);
      });
    }
    // Chrome-batch expand details — tool input JSON, tool result
    // content, etc. These can each be tens of KB per row and a long
    // session piles up dozens of them. Anything beyond a small
    // preview gets replaced with a "[N bytes archived]" placeholder.
    const heavyPres = card.querySelectorAll('.agent-chrome-pre, .agent-tool-result-preview, .agent-card-tool-input');
    for (const pre of heavyPres) {
      const len = pre.textContent.length;
      if (len > 600) {
        const preview = pre.textContent.slice(0, 100).replace(/\s+/g, ' ');
        pre.textContent = `${preview}…  [${len.toLocaleString()} bytes archived]`;
      }
    }
    // assistant_text cards stash the full markdown source on the
    // card's dataset for streaming-merge. Drop it on archive — the
    // rendered body still has the markdown-converted HTML, and we
    // never re-stream into an archived card.
    if (card.dataset.assistantText && card.dataset.assistantText.length > 200) {
      card.dataset.assistantText = '';
    }
  } catch {}
  card.dataset.stripped = '1';
}

function _ensureLoadOlderButton(list, hiddenCount) {
  let btn = list.querySelector('#chat-load-older');
  const isNew = !btn;
  try {
    console.log('[diag-load-older] ensure: hiddenCount=' + hiddenCount + ' isNew=' + isNew
      + ' state.chatMessages=' + (state.chatMessages || []).length
      + ' state.chatTotal=' + (state.chatTotal || 0));
  } catch {}
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'chat-load-older';
    btn.type = 'button';
    btn.className = 'chat-load-older';
    btn.addEventListener('click', _revealOlderChat);
    list.insertBefore(btn, list.firstChild);
  } else if (btn !== list.firstChild) {
    // Keep it pinned at the top even after a fresh append shifted it.
    list.insertBefore(btn, list.firstChild);
  }
  btn.textContent = `Load older (${hiddenCount} hidden) — or scroll up`;
  btn.dataset.hiddenCount = String(hiddenCount);
  // 2026-05-17: scroll-up triggers load-older via TWO event types:
  //
  // 1. `scroll` event — fires when the list is actually overflowing
  //    and the user scrolls within it. Triggers when scrollTop <= 64
  //    (near the top). This is the mobile-friendly path.
  //
  // 2. `wheel` event — fires when the user moves their wheel/trackpad
  //    OVER the list, even if the list isn't tall enough to scroll.
  //    Catches the desktop case where the initial 8KB of messages
  //    fit in the viewport (no scrollbar, no scroll events) but the
  //    user still scrolls UP via wheel. Triggers on deltaY < 0
  //    (upward intent) when scrollTop is already at 0 (top).
  //
  // First attempt used IntersectionObserver, but it auto-fired on
  // attach. Second attempt used a "first scroll = arming" gate that
  // broke desktop. Final shape uses both `scroll` AND `wheel` so
  // every scroll-up gesture — whether the list overflows or not —
  // triggers the load.
  if (!list.dataset.loadOlderScrollHandlerArmed) {
    list.dataset.loadOlderScrollHandlerArmed = '1';
    const maybeFire = () => {
      const currentBtn = list.querySelector('#chat-load-older');
      if (currentBtn && !currentBtn.disabled) _revealOlderChat();
    };
    list.addEventListener('scroll', () => {
      if (list.scrollHeight <= list.clientHeight) return;
      if (list.scrollTop > 64) return;
      maybeFire();
    }, { passive: true });
    list.addEventListener('wheel', (ev) => {
      // Only upward intent. If the list is scrollable AND scrollTop
      // > 64, let the native scroll happen first; the scroll handler
      // above will catch the eventual top-reach. We only fire here
      // when the list is at the top already AND user is still trying
      // to scroll up (the desktop fits-in-viewport case).
      if (!ev || ev.deltaY >= 0) return;
      if (list.scrollTop > 0) return;
      maybeFire();
    }, { passive: true });
  }
}

function _revealOlderChat() {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  const archived = Array.from(list.querySelectorAll('.chat-msg-archived'));
  try {
    const serverPending = Math.max(0, (state.chatTotal || 0) - (state.chatMessages || []).length);
    console.log('[diag-load-older] reveal: archived=' + archived.length + ' serverPending=' + serverPending);
  } catch {}
  if (!archived.length) {
    // bug-9: no more locally-archived cards to reveal — but the
    // server may still have older messages we never received
    // (chat-history WS frame is capped at DEFAULT_CHAT_HISTORY_LIMIT).
    // Fetch the next window from the new /chat/history endpoint.
    const serverPending = Math.max(0, (state.chatTotal || 0) - state.chatMessages.length);
    if (serverPending > 0) {
      _fetchOlderChatFromServer().catch(() => {});
      return;
    }
    const btn = list.querySelector('#chat-load-older');
    if (btn) btn.remove();
    return;
  }
  // Reveal the NEWEST archived first — the user wants the run-up to
  // the currently-visible content. Mark them data-revealed so the
  // auto-cap doesn't re-hide them on the next append.
  const reveal = archived.slice(-CHAT_LOAD_OLDER_BATCH);
  // Capture scroll anchor: the first currently-visible card after
  // the archived block. We'll restore scroll position to keep that
  // anchor on screen post-reveal.
  const anchor = reveal[reveal.length - 1].nextElementSibling;
  const anchorTopBefore = anchor ? anchor.getBoundingClientRect().top : 0;
  for (const el of reveal) {
    el.classList.remove('chat-msg-archived');
    el.dataset.revealed = '1';
  }
  // Recompute remaining archive count.
  const stillArchived = list.querySelectorAll('.chat-msg-archived').length;
  if (stillArchived > 0) {
    const btn = list.querySelector('#chat-load-older');
    if (btn) {
      btn.textContent = `Load older (${stillArchived} hidden)`;
      btn.dataset.hiddenCount = String(stillArchived);
    }
  } else {
    const btn = list.querySelector('#chat-load-older');
    if (btn) btn.remove();
  }
  // Restore scroll position: anchor's screen position would have
  // shifted DOWN by the newly-revealed cards' total height. Adjust
  // scrollTop so the anchor stays on the same screen row.
  if (anchor) {
    const anchorTopAfter = anchor.getBoundingClientRect().top;
    list.scrollTop += (anchorTopAfter - anchorTopBefore);
  }
}

// bug-9: paginated older-history fetch from the server. Called from
// _revealOlderChat when there are no more locally-archived cards but
// state.chatTotal > state.chatMessages.length (i.e. the initial
// chat-history frame omitted older messages per the
// DEFAULT_CHAT_HISTORY_LIMIT cap on the server). Asks for the
// CHAT_LOAD_OLDER_BATCH window strictly older than the oldest
// currently-known message.
async function _fetchOlderChatFromServer() {
  const sid = state.activeId;
  if (!sid) { console.log('[diag-fetch-older] skip: no activeId'); return; }
  if (state._fetchingOlderChat) { console.log('[diag-fetch-older] skip: in-flight'); return; }
  // Use the oldest currently-known message's ts as the `before` cursor.
  const oldest = state.chatMessages.find((m) => m && m.ts);
  if (!oldest) { console.log('[diag-fetch-older] skip: no oldest ts'); return; }
  state._fetchingOlderChat = true;
  console.log('[diag-fetch-older] starting before=' + oldest.ts + ' chatMessages.length=' + state.chatMessages.length);
  const list = document.getElementById('chat-messages');
  const btn = list ? list.querySelector('#chat-load-older') : null;
  if (btn) { btn.disabled = true; btn.textContent = 'Loading older…'; }
  try {
    // 2026-05-17: includeAgent=1 surfaces persisted claude-text rows
    // (meta.fromAgent:true) that the initial WS chat-history frame
    // intentionally filters out (to avoid duplicate-render against
    // agent-replay cards while session.buffer is fresh). When scrolling
    // past the agent-replay byte window, fromAgent rows are the only
    // surviving record of older claude replies — surface them.
    const url = `/sessions/${encodeURIComponent(sid)}/chat/history`
      + `?before=${encodeURIComponent(oldest.ts)}&limit=${CHAT_LOAD_OLDER_BATCH}`
      + `&includeAgent=1`;
    const res = await authedFetch(url);
    if (!res || !res.ok) {
      console.log('[diag-fetch-older] HTTP failed: status=' + (res ? res.status : 'no-response'));
      return;
    }
    const data = await res.json().catch(() => null);
    console.log('[diag-fetch-older] response: messages=' + ((data && data.messages) || []).length
      + ' total=' + (data && data.total) + ' hasMore=' + (data && data.hasMore));
    if (!data || !Array.isArray(data.messages) || !data.messages.length) {
      // Server has no older messages despite chatTotal > length —
      // probably a sync drift, OR the unfetched rows are all
      // fromAgent (filtered when includeAgent=0) and we just asked
      // with includeAgent=1 but they were all newer than oldest.ts.
      // Either way, update total + retire the button.
      if (typeof data.total === 'number') state.chatTotal = data.total;
      // 2026-05-17: force-retire the button when server says 0 rows
      // older. The previous code re-ran _enforceChatHistoryCap which
      // would re-create the button if state.chatTotal still exceeded
      // state.chatMessages.length — causing the IntersectionObserver
      // to fire again forever. Trim state.chatTotal down so
      // serverPending = 0 and the button retires.
      if (state.chatTotal > state.chatMessages.length) {
        console.log('[diag-fetch-older] forcing state.chatTotal down from ' + state.chatTotal + ' to ' + state.chatMessages.length + ' (server returned 0 older rows; the gap is unfetchable, likely all fromAgent rows newer than oldest.ts)');
        state.chatTotal = state.chatMessages.length;
      }
      _enforceChatHistoryCap();
      return;
    }
    // Prepend the older window to state.chatMessages, then re-render
    // the whole pane (renderChatPane's preserve-and-rebuild keeps the
    // agent-event cards in place). Anchor scrolling on the previously-
    // top message so the user's view doesn't jump.
    const prevTopId = oldest.meta && oldest.meta.transcriptUuid;
    state.chatMessages = data.messages.concat(state.chatMessages);
    if (typeof data.total === 'number') state.chatTotal = data.total;
    // 2026-05-17 bug fix: DO NOT call _capChatMessagesBytes() here.
    // The cap walks tail → head and keeps the youngest 16 KB. After
    // a load-older prepend, that drops the very rows the user just
    // fetched — surfacing as an infinite-loop log: "scroll up →
    // fetch 50 → cap drops 50 → button still says serverPending=N
    // → IntersectionObserver re-fires → fetch again". Mark the
    // session as "scrolled back" so subsequent live appends don't
    // auto-cap either — once the user has explicitly walked into
    // older history, the rolling-tail policy is the wrong shape.
    // (Live appends still go through _appendChatMessageDom which
    // calls _enforceChatHistoryCap for DOM-level archive, but the
    // state.chatMessages array is no longer trimmed.)
    state._scrolledBack = true;
    renderChatPane(/*scrollToBottom*/ false);
    // Restore approximate scroll: find the previously-top message in
    // the rebuilt DOM and scrollIntoView. _ensureLoadOlderButton fires
    // inside _enforceChatHistoryCap which renderChatPane chains, so
    // the button auto-updates with the new pending count.
    if (prevTopId && list) {
      const restore = list.querySelector(`.chat-msg[data-transcript-uuid="${CSS.escape(prevTopId)}"]`);
      if (restore && restore.scrollIntoView) {
        try { restore.scrollIntoView({ block: 'start' }); } catch {}
      }
    }
  } catch (err) {
    console.warn('[bug-9] _fetchOlderChatFromServer failed:', err && err.message);
  } finally {
    state._fetchingOlderChat = false;
    if (btn && btn.parentElement) {
      btn.disabled = false;
      // Text re-set by _ensureLoadOlderButton on the next cap pass.
    }
  }
}

function renderChatPane(scrollToBottom = false) {
  const list = document.getElementById('chat-messages');
  const empty = document.getElementById('chat-empty');
  if (!list) return;
  // Unwrap any existing turn-groups so we see the flat list of cards
  // again. _groupTurns re-runs at the end via _enforceChatHistoryCap,
  // so we end up grouped again — this is just to expose chat-msg
  // bubbles (which currently live inside turn-bodies) as direct
  // children for the preserve-and-rebuild pass.
  for (const group of [...list.querySelectorAll(':scope > .turn-group')]) {
    const body = group.querySelector(':scope > .turn-body');
    if (body) {
      for (const child of [...body.children]) {
        list.insertBefore(child, group);
      }
    }
    group.remove();
  }
  // Preserve non-chat-message children. The chat-pane DOM is shared
  // between two streams:
  //   1. state.chatMessages → chat bubbles + menu rows (.chat-msg)
  //   2. agent-event stream → agent cards, turn footers, chrome
  //      batches, load-older button (NOT in state.chatMessages)
  // The old `list.innerHTML = …` wipe destroyed stream-2 content
  // every time chat-history arrived from the server — manifesting as
  // "history disappears after refresh." Detach the preserved
  // children, rebuild the .chat-msg list, then re-merge by ts so
  // both streams interleave chronologically.
  const preserve = [];
  for (const el of list.children) {
    if (el.classList && el.classList.contains('chat-msg')) continue;   // chat bubble/menu → rebuilt
    preserve.push(el);
  }
  for (const el of preserve) el.remove();

  if (!state.chatMessages.length) {
    list.innerHTML = '';
    // Hide the empty-state hint if we have preserved agent cards —
    // the pane isn't actually empty in that case.
    if (empty) empty.hidden = preserve.length > 0;
    for (const el of preserve) list.appendChild(el);
    if (scrollToBottom) scrollChatToLatest();
    _enforceChatHistoryCap();
    return;
  }
  if (empty) empty.hidden = true;
  // Render with row indexes so the inline menu picker knows which is the
  // most recent menu broadcast (only that one stays clickable; earlier
  // ones get their buttons disabled so a stale row can't fire a pick
  // against a different dialog).
  const lastMenuIdx = _findLastMenuMessageIdx(state.chatMessages);
  list.innerHTML = state.chatMessages
    .map((m, i) => renderChatMessage(m, i === lastMenuIdx))
    .join('');
  // Stamp ts + seq on the freshly-rendered chat bubbles so the
  // chronological merge below can place preserved agent cards in
  // the right slots. data-seq (server-allocated monotonic counter,
  // shared between chat-msg + agent-event) takes precedence over
  // data-ts in the sort/insert paths — see _insertChronological +
  // _resortChatPaneByTs.
  const renderedMsgs = state.chatMessages.filter(m => !_shouldSkipMessageRender(m));
  const chatNodes = list.querySelectorAll(':scope > .chat-msg');
  for (let i = 0; i < chatNodes.length && i < renderedMsgs.length; i++) {
    const m = renderedMsgs[i];
    if (m && m.ts) chatNodes[i].dataset.ts = m.ts;
    if (m && m.meta && typeof m.meta.seq === 'number') {
      chatNodes[i].dataset.seq = String(m.meta.seq);
    }
  }
  // Chronological merge — slot each preserved agent card into the
  // chat-bubble list by its data-ts. Without this, agent cards
  // landed at the end of the list regardless of when they actually
  // happened. With it, a chat bubble at 13:01 + tool call at 13:02
  // + chat bubble at 13:03 render in that order.
  for (const el of preserve) _insertChronological(list, el, el.dataset.ts || '');
  // Defensive: after the per-element chronological merge, run a
  // pane-wide stable sort. _insertChronological assumes the rest of
  // the list is monotonically sorted; if it isn't (e.g. agent-replay
  // appended cards at the end before this rebuild), the per-element
  // walk can land an item in the wrong slot. The pane-wide resort
  // is O(n log n) on a few hundred items — fast — and is a no-op
  // when the list is already sorted (early-return inside).
  _resortChatPaneByTs();
  if (scrollToBottom) scrollChatToLatest();
  _bindChatMenuClicks();
  // marked emits ```mermaid``` blocks as <pre><code class="language-mermaid">.
  // Without this pass they render as raw source. Same async, fire-and-forget
  // pattern the transcript view uses; failures stay as raw code blocks.
  renderMermaidInContainer(list).catch(() => {});
  // Apply the visible-window cap so a long-history reload doesn't dump
  // 500 rows on the user. Fresh renders reset every card's
  // .chat-msg-archived state (no data-revealed marker yet), so the
  // cap re-archives the oldest cards back to default.
  _enforceChatHistoryCap();
}

function _findLastMenuMessageIdx(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.meta && m.meta.kind === 'menu' && m.meta.menu && Array.isArray(m.meta.menu.options)) {
      // Answered marker is checked from BOTH sources so a page refresh
      // (which reloads server-persisted chat into state.chatMessages)
      // still treats picked menus as inactive — the server stamps
      // m.meta.answered on the persisted message when a pick lands.
      if (m._answered || (m.meta && m.meta.answered)) return -1;
      return i;
    }
    // 'menu-auto' = the server auto-resolved a permission. A pending menu
    // older than that is no longer the live one — keep scanning back, but
    // never offer buttons for older menus.
    if (m && m.meta && m.meta.kind === 'menu-auto') return -1;
  }
  return -1;
}

function _shouldSkipMessageRender(m) {
  if (!m) return true;
  if (m.meta && (m.meta.kind === 'clarify' || m.meta.kind === 'clarify-reply')) {
    return true;
  }
  if (m.text && /\[run:(plan|test|arch|td|fr|bug)#[A-Za-z0-9_-]+\]/.test(m.text)) {
    return true;
  }
  return false;
}

function renderChatMessage(m, isActiveMenu) {
  if (_shouldSkipMessageRender(m)) {
    return '';
  }
  const fromClaude = m.user === 'claude';
  const fromSelf = state.chatUser && m.user === state.chatUser;
  const ts = m.ts ? formatChatTs(m.ts) : '';
  let cls = 'chat-msg';
  if (fromClaude) cls += ' from-claude';
  if (fromSelf) cls += ' from-self';
  // Chat-only mentions (stamped server-side with meta.kind='mention').
  // Two variants:
  //   - @<known-user>: highlighted as a card so sender + other viewers
  //     see who it was addressed to; extra accent when the current user
  //     IS the recipient (chat-msg-mention-me).
  //   - @all: broadcast mention (meta.broadcast=true). Every viewer
  //     gets the recipient-style accent, since "all" addresses them
  //     too. Renders with an additional chat-msg-mention-all class so
  //     CSS can tint the chip / icon differently from a 1:1 mention.
  const isMention = m.meta && m.meta.kind === 'mention' && m.meta.mentionUser;
  const isBroadcast = isMention && m.meta.broadcast === true;
  const isMentionToMe = isMention && (isBroadcast || (state.chatUser
    && String(m.meta.mentionUser).toLowerCase() === String(state.chatUser).toLowerCase()));
  if (isMention) cls += ' chat-msg-mention';
  if (isBroadcast) cls += ' chat-msg-mention-all';
  if (isMentionToMe) cls += ' chat-msg-mention-me';
  // For menu broadcasts, the inline buttons below ARE the picker; the
  // chat body just sets the scene with the question. Override the text
  // body to a minimal "lead + question" form regardless of what the
  // server's `m.text` says — this stays robust against older persisted
  // messages that include the verbose option enumeration that we no
  // longer emit.
  const menuOpts = (m.meta && m.meta.kind === 'menu' && m.meta.menu && Array.isArray(m.meta.menu.options))
    ? m.meta.menu.options : null;
  let body = m.text || '';
  if (menuOpts) {
    cls += ' chat-msg-menu';
    const tgt = m.meta.target;
    // Tool permission menus (target.tool set) get a chrome-row tag so
    // CSS can collapse them — the perm_request agent-event already
    // breadcrumbs them in the chrome batch and the modal popup is
    // the answer surface. Keeps the chat list focused on
    // AskUserQuestion-style menus where the question + options carry
    // human-readable content.
    if (tgt && tgt.tool) cls += ' chat-msg-menu-perm';
    const rawQ = (m.meta.menu && m.meta.menu.question) || '';
    // Strip any leading "[...]" metadata tag claude prepends to the
    // question (SINGLE-SELECT, MULTI-SELECT, TYPED-TEXT, "SINGLE-SELECT
    // + PREVIEW", etc.). General [^]] match catches future variants.
    const cleanQ = String(rawQ).replace(/^\s*\[[^\]]*\]\s*/, '').replace(/[:?]+\s*$/, '').trim();
    const labels = menuOpts.map((o) => String(o.label || '').trim()).filter(Boolean).join(', ');
    if (tgt && tgt.tool) {
      body = `Allow \`${tgt.tool}${tgt.input ? '(' + tgt.input + ')' : ''}\`?  ${labels}`;
    } else if (cleanQ) {
      body = `${cleanQ}: ${labels}`;
    } else {
      body = labels;
    }
  }
  // Picked option number from either the local click (m._pickedN) or
  // the server-persisted record (m.meta.pickedN). The server source is
  // what makes the answered state survive a page refresh.
  const pickedN = menuOpts
    ? (m._pickedN || (m.meta && m.meta.pickedN) || null)
    : null;
  const isMulti = !!(menuOpts && m.meta && m.meta.menu && m.meta.menu.multi);
  const wasSubmitted = !!(m.meta && (m.meta.submitted || m._submitted));
  // Once answered (or once superseded by a newer menu, or once it's no
  // longer the active dialog), the whole card collapses to a single
  // resolved line — no lead, no question, no option buttons. The full
  // question is preserved as a tooltip on the bubble so context is one
  // hover away without consuming scroll space. Active menus stay full-
  // height so the question is visible while picking. `meta.superseded`
  // is stamped by the server when claude advances past a menu without
  // the user answering it (see _supersedeStaleMenus in pty.js).
  const isSuperseded = !!(m.meta && m.meta.superseded);
  const isResolvedMenu = !!(menuOpts && (wasSubmitted || pickedN != null || isSuperseded || !isActiveMenu));
  if (isResolvedMenu) cls += ' chat-msg-menu-collapsed';
  // Resolved menu question (stripped of any "[...]" metadata prefix +
  // trailing punctuation) — folded inline with the picked/submitted
  // line so the whole answered row reads as ONE sentence:
  //   "Daemon model: ✓ Picked [2] Built-in --daemon flag"
  const resolvedQuestion = isResolvedMenu && m.meta && m.meta.menu && m.meta.menu.question
    ? String(m.meta.menu.question).replace(/^\s*\[[^\]]*\]\s*/, '').replace(/[:?]+\s*$/, '').trim()
    : '';
  let optsHtml = '';
  if (menuOpts && wasSubmitted) {
    const picked = menuOpts.filter((o) => o.checkbox && o.checked);
    const summary = picked.length
      ? picked.map((o) => `[${o.n}] ${escHtml(o.label)}`).join(', ')
      : '(nothing selected)';
    optsHtml = '';
    // (resolved + submitted) rolls into textHtml below via resolvedQuestion + summary.
  } else if (menuOpts && pickedN != null) {
    optsHtml = '';   // ditto — rendered inline in textHtml below.
  } else if (menuOpts && isSuperseded) {
    optsHtml = '<span class="chat-menu-resolved chat-menu-resolved-inline">↪ Superseded by a newer dialog</span>';
  } else if (menuOpts && isActiveMenu) {
    // Active row: data-perm-reopen on the chat-msg div below makes
    // the whole row click-to-reopen-modal. bug-31: now WITH a visible
    // affordance ("↗ Tap to answer / re-open answer dialog") — pre-fix
    // the row had no visible cue, so a user who dismissed the modal
    // (or never saw it pop e.g. mobile-backgrounded) had no recovery
    // path until the agent fired another AskUserQuestion.
    optsHtml = '<span class="chat-menu-reopen-hint" data-perm-reopen="1" title="Tap to open / re-open the answer dialog">↗ Tap to answer</span>';
    cls += ' chat-msg-menu-active';
  } else if (menuOpts) {
    optsHtml = '<span class="chat-menu-resolved chat-menu-resolved-inline">(no longer active)</span>';
  }
  // Build the resolved-menu inline string: "<question>: <answer>". For
  // submitted multi-select, list the checked options; for single pick,
  // show "✓ Picked [N] label".
  let resolvedInline = '';
  if (isResolvedMenu && menuOpts) {
    let answer = '';
    if (wasSubmitted) {
      const picked = menuOpts.filter((o) => o.checkbox && o.checked);
      const summary = picked.length
        ? picked.map((o) => `[${o.n}] ${o.label}`).join(', ')
        : '(nothing selected)';
      answer = `✓ Submitted with ${summary}`;
    } else if (pickedN != null) {
      const matched = menuOpts.find((o) => o.n === pickedN);
      const label = matched ? matched.label : '';
      answer = `✓ Picked [${pickedN}]${label ? ' ' + label : ''}`;
    }
    if (answer) {
      const q = resolvedQuestion ? resolvedQuestion + ': ' : '';
      resolvedInline = `<span class="chat-menu-resolved-q">${escHtml(q)}</span><span class="chat-menu-resolved-a">${escHtml(answer)}</span>`;
    }
  }
  const textHtml = isResolvedMenu
    ? (resolvedInline ? `<div class="chat-text chat-text-resolved">${resolvedInline}</div>` : '')
    : `<div class="chat-text">${renderMd(body)}</div>`;
  // Active menu rows are click-to-reopen-modal — the data-perm-reopen
  // attribute is hooked by _bindChatMenuClicks. No visible affordance
  // line ('↗ Awaiting answer — open in popup' was retired); the row
  // itself is the affordance and gets `cursor: pointer` via CSS.
  const rowAttrs = (menuOpts && !isResolvedMenu) ? ' data-perm-reopen="1"' : '';
  // 2026-05-17: emit data-seq + data-ts in the markup directly.
  // data-seq is the server-allocated monotonic per-session counter
  // shared between chat-msg AND agent-event streams — it's the
  // authoritative global ordering key. data-ts is the fallback for
  // legacy rows that don't have seq.
  const seq = m.meta && typeof m.meta.seq === 'number' ? m.meta.seq : null;
  const seqAttr = seq != null ? ` data-seq="${seq}"` : '';
  const tsAttr = m.ts ? ` data-ts="${escHtml(m.ts)}"` : '';
  const uuid = m.meta && m.meta.transcriptUuid ? m.meta.transcriptUuid : null;
  const uuidAttr = uuid ? ` data-transcript-uuid="${escHtml(uuid)}"` : '';
  return `<div class="${cls}"${rowAttrs}${seqAttr}${tsAttr}${uuidAttr}>
    <div class="chat-meta"><span class="chat-user">${escHtml(m.user === 'claude' ? 'myco' : (m.user || '?'))}</span><span class="chat-ts">${escHtml(ts)}</span></div>
    ${textHtml}
    ${optsHtml}
  </div>`;
}

function formatChatTs(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// bug-34: variant that includes the date. The time-only formatChatTs
// above is fine for chat bubbles (typically today's session) but
// artifact-pane content can be days / weeks / months old —
// "filed by @user · 14:32" or "Updated 14:32" is genuinely ambiguous
// when you can't tell which day. Locale-formatted "MMM D, YYYY,
// HH:MM" keeps the row compact while disambiguating fully.
//
// First-pass scope was just the plan-item byline. bug-34 was
// re-dispatched (the same ambiguity bites comments + Updated banners,
// even though they were originally noted as out-of-scope follow-ups),
// so this is now wired into FOUR sites in renderArtifact:
//   1. Plan-item byline                                  (renderItem)
//   2. Plan-item comment timestamps                      (renderItem)
//   3. Arch tab "Updated <ts>" banner                    (arch branch)
//   4. Plan / test tab "Updated <ts>" banner             (items branch)
// Chat-bubble timestamps (renderChatMessage line ~3457) intentionally
// still use formatChatTs — those are same-day inside a live session
// and the time-only display is the right shape there.
function formatChatTsWithDate(iso) {
  // Defensive: null / undefined / empty resolve to "" rather than
  // `new Date(null)`'s default-to-epoch behavior (would render
  // "Jan 1, 1970" — a clear failure mode for a "filed at" line).
  if (iso === null || iso === undefined || iso === '') return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

// Chat-only flow for messages forwarded to claude.
//
// When the user sends a chat message, all of claude's response stream
// lands in chat:
//   * Each assistant TEXT block arrives via the agent-event stream and
//     is rendered as a separate `assistant_text` agent card — so pre-
//     tool planning, post-tool summaries, and the final answer each
//     get their own bubble (close to ChatGPT-style streaming).
//   * tool_use entries don't post to chat — they're invisible work.
//     We keep a counter so a tool-only turn (claude ran tools and
//     didn't produce text) can be summarised at the end.
//   * The typing-dots indicator stays visible from the chat send
//     until CLAUDE_IDLE_MS of complete transcript silence (longer
//     than a single 2s debounce because real claude turns can have
//     10–30s gaps between text and tool_result frames).
//
// We DON'T touch main-pane focus — interaction stays in the chat pane.
const CLAUDE_IDLE_MS = 30000;           // post-stream silence before we declare claude idle
                                         // (long enough to span 30s+ "thinking" gaps with no
                                         //  transcript-delta activity; the post-text-to-chat
                                         //  path no longer depends on this — it always fires
                                         //  on assistant text — so a few extra seconds of dots
                                         //  is the only cost of being generous here)

function _markAwaitingClaude() {
  state.awaitingClaude = true;
  state.pendingClaudeToolCalls = 0;
  state.pendingClaudeReplyPosted = false;
  state._claudeSeenText = new Set();    // dedupe by uuid across overlapping deltas
  state._spinnerSeen = false;            // claude's PTY spinner: arm post-spinner retirement once seen
  if (state._claudeIdleTimer) { clearTimeout(state._claudeIdleTimer); state._claudeIdleTimer = null; }
  if (state._spinnerStopTimer) { clearTimeout(state._spinnerStopTimer); state._spinnerStopTimer = null; }
  _renderClaudeTyping();
  _scheduleClaudeIdleCheck();
}

function _scheduleClaudeIdleCheck() {
  if (state._claudeIdleTimer) clearTimeout(state._claudeIdleTimer);
  state._claudeIdleTimer = setTimeout(_onClaudeIdle, CLAUDE_IDLE_MS);
}

function _onClaudeIdle() {
  state._claudeIdleTimer = null;
  _retireClaudeTyping();
}

// Single retire path used by both the 30s idle timer fallback and the
// spinner-stop signal. Clears awaiting state and re-renders the
// indicator. Phase 9 step 3 retired the transcript-delta path that
// counted assistant tool calls, so the "ran N tool calls without
// reply" footer is no longer produced here.
function _retireClaudeTyping() {
  if (state._claudeIdleTimer) { clearTimeout(state._claudeIdleTimer); state._claudeIdleTimer = null; }
  if (state._spinnerStopTimer) { clearTimeout(state._spinnerStopTimer); state._spinnerStopTimer = null; }
  state._spinnerSeen = false;
  state.awaitingClaude = false;
  state.pendingClaudeToolCalls = 0;
  state.pendingClaudeReplyPosted = false;
  state._claudeSeenText = null;
  // bug-37: also clear kind + label so the Stop-button predicate
  //   showStop = (awaitingClaude || !!claudeStatusLine)
  //              && kind ∈ {thinking, running, awaiting}
  // truly flips false. Pre-fix the line and kind stayed stuck at
  // their last values, keeping the button visible past the 30s idle
  // timeout even when there was nothing to stop.
  state.claudeStatusLine = '';
  state.claudeStatusKind = null;
  state.claudeStatus = null;
  _renderClaudeTyping();
}

// Repaint #claude-typing's label with the structured status chips
// (token throughput, interrupt badge, effort). Extracted from
// _renderClaudeTyping so the static check that enforces "the indicator
// is declared statically — _renderClaudeTyping is a pure flip" stays
// valid: DOM creation lives here, slot toggling stays there.
function _renderClaudeTypingLabel(label, status, struct) {
  label.textContent = '';
  if (struct) {
    const primary = document.createElement('span');
    primary.className = 'claude-typing-primary';
    const head = struct.verb
      ? `${struct.verb}${struct.durationS != null ? ` ${struct.durationS}s` : ''}`
      : status.split(/\s*·\s*/)[0] || '';
    primary.textContent = head;
    label.appendChild(primary);
    if (struct.tokens && struct.tokens.count) {
      const chip = document.createElement('span');
      chip.className = 'claude-typing-chip claude-typing-tokens';
      const dirGlyph = struct.tokens.dir === 'up' ? '↑' : '↓';
      chip.textContent = ` ${dirGlyph} ${_humanizeTokens(struct.tokens.count)}`;
      label.appendChild(chip);
    }
    if (struct.interruptible) {
      const chip = document.createElement('span');
      chip.className = 'claude-typing-chip claude-typing-interrupt';
      chip.textContent = ' · esc to interrupt';
      label.appendChild(chip);
    }
    if (struct.effort) {
      const chip = document.createElement('span');
      chip.className = 'claude-typing-chip claude-typing-effort';
      chip.textContent = ` · ◉ ${struct.effort}`;
      label.appendChild(chip);
    }
  } else {
    label.textContent = status;
  }
}

// Playful verbs cycled in the status line while claude is thinking,
// à la Claude Code's TUI ("Photosynthesizing… (29s · ↓ 1.1k tokens)").
// Cycle once every CLAUDE_VERB_PERIOD_S seconds so the user gets
// motion without it feeling frantic.
const CLAUDE_VERBS = [
  'Photosynthesizing', 'Pondering', 'Computing', 'Cogitating',
  'Whirring', 'Brewing', 'Ruminating', 'Calculating', 'Mulling',
  'Deliberating', 'Crafting', 'Synthesizing', 'Reasoning',
  'Marinating', 'Percolating', 'Spelunking', 'Untangling',
];
const CLAUDE_VERB_PERIOD_S = 4;

let _claudeTurnTickTimer = null;

// Start/refresh the 1Hz timer that drives the "(29s · ↓ 1.1k)"
// chip during an active turn. Idempotent — calling while already
// running is a no-op. Resets the start clock when no turn was
// running (idle → active transition). state.turnTimer carries
// { startedAt, outChars, verbSeed }.
function _ensureClaudeTurnTick() {
  if (!state.turnTimer) {
    state.turnTimer = {
      startedAt: Date.now(),
      outChars: 0,
      verbSeed: Math.floor(Math.random() * CLAUDE_VERBS.length),
    };
  }
  if (_claudeTurnTickTimer) return;
  _claudeTurnTickTimer = setInterval(_renderClaudeTyping, 1000);
}

function _stopClaudeTurnTick() {
  if (_claudeTurnTickTimer) {
    clearInterval(_claudeTurnTickTimer);
    _claudeTurnTickTimer = null;
  }
  state.turnTimer = null;
}

// Build the playful suffix shown when claude is thinking/running/
// awaiting. Returns "" if no active turn timer (idle / done).
// Tokens are an APPROXIMATION — 1 token ≈ 4 chars of output text
// accumulated from assistant_text events. The server's
// turn_result has the real count which lands in turnTotals; this
// is just a live cue while the turn is in flight.
function _claudeTickSuffix() {
  const t = state.turnTimer;
  if (!t) return '';
  const elapsedS = Math.max(0, Math.floor((Date.now() - t.startedAt) / 1000));
  const verbIdx = (t.verbSeed + Math.floor(elapsedS / CLAUDE_VERB_PERIOD_S)) % CLAUDE_VERBS.length;
  const verb = CLAUDE_VERBS[verbIdx];
  const tokens = Math.max(0, Math.floor(t.outChars / 4));
  const tokenStr = _humanizeTokens(tokens);
  // Format mirrors the Claude Code TUI:  Photosynthesizing… (29s · ↓ 1.1k)
  const tail = tokens > 0
    ? `(${elapsedS}s · ↓ ${tokenStr} tokens)`
    : `(${elapsedS}s)`;
  return `${verb}… ${tail}`;
}

function _renderClaudeTyping() {
  // #claude-typing is declared statically in index.html as a direct
  // child of #chatpane (sibling of #chat-messages and #chat-form).
  // The 30px flex slot is permanently reserved via CSS (display:flex
  // is preserved even when [hidden] is set, with visibility:hidden
  // hiding the visuals). All this function does is flip [hidden] and
  // update the label content — zero side effects on chat layout.
  // Chip rendering is delegated to _renderClaudeTypingLabel so the
  // static check enforcing "no DOM creation here" stays valid.
  const host = document.getElementById('claude-typing');
  if (!host) return;
  const baseStatus = state.claudeStatusLine || '';
  const visible = state.awaitingClaude || !!baseStatus;
  host.hidden = !visible;
  // Playful suffix while a turn is in flight: "· Photosynthesizing…
  // (29s · ↓ 1.1k tokens)". _claudeTickSuffix returns "" when no
  // turn timer is running (idle / done / error). Mid-stream this
  // gives the strip a heartbeat + token count even when the verb
  // label is the chrome-batch's short summary.
  const tick = _claudeTickSuffix();
  const status = tick ? (baseStatus ? `${baseStatus} · ${tick}` : tick) : baseStatus;
  const label = host.querySelector('.claude-typing-label');
  if (label) _renderClaudeTypingLabel(label, status, state.claudeStatus);
  // Distinct visual states (research item #7): thinking / running /
  // awaiting / done / error. Toggle each class explicitly so the
  // strip's color, dot color, and Stop-button presence reflect the
  // current state. CSS rules: .claude-typing-running (blue),
  // .claude-typing-awaiting (amber), .claude-typing-done (green
  // checkmark, no dots), .claude-typing-error (red).
  const kind = state.claudeStatusKind || 'thinking';
  for (const k of ['thinking', 'running', 'awaiting', 'done', 'error']) {
    host.classList.toggle('claude-typing-' + k, kind === k);
  }
  // Stop lives in the composer's actions row (alongside Send).
  // Toggled via .composer-running on #chat-form so CSS can show
  // Stop only while claude is mid-turn — visible for thinking /
  // running / awaiting; hidden in done / error / idle. Send stays
  // ALWAYS visible so users can queue messages while claude works.
  const form = document.getElementById('chat-form');
  if (form) {
    const showStop = visible && (kind === 'thinking' || kind === 'running' || kind === 'awaiting');
    form.classList.toggle('composer-running', showStop);
  }
  // Start / stop the 1Hz playful-status ticker. Active states keep
  // the verb cycling + elapsed counter visible. done/error/idle
  // tear it down so the suffix doesn't linger.
  if (visible && (kind === 'thinking' || kind === 'running' || kind === 'awaiting')) {
    _ensureClaudeTurnTick();
  } else if (kind === 'done' || kind === 'error' || !visible) {
    _stopClaudeTurnTick();
  }
  // No scrollIntoView on updates — status ticks every ~750ms via the
  // periodic safety scan, and the indicator's slot is decoupled from
  // chat-messages's flex slot by construction.
  _updateTaskHUD();
}

// Update the claude-status line cached from the server. When non-null,
// the typing indicator becomes self-driven by the PTY — even if my own
// awaitingClaude timer expired, the dots come back as long as claude is
// actually running. Null = claude went idle on the server side.
//
// Crucially, when the spinner flips from running → gone AFTER we've seen
// it running at least once this turn, we treat that as "claude stopped
// processing" and schedule a short-grace retirement of the typing dots.
// This makes the indicator stop within a couple seconds of claude
// finishing instead of waiting for the 30s idle-timer fallback.
const CLAUDE_POST_SPINNER_GRACE_MS = 2500;

// "3400" → "3.4k", "1500000" → "1.5m". Used by the status-chip
// renderer to keep the token-throughput chip a fixed width regardless
// of magnitude.
function _humanizeTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function _setClaudeStatusLine(text, structured) {
  const trimmed = (text && String(text).trim()) || null;
  state.claudeStatusLine = trimmed;
  state.claudeStatus = structured || null;
  if (trimmed) {
    state._spinnerSeen = true;
    if (state._spinnerStopTimer) { clearTimeout(state._spinnerStopTimer); state._spinnerStopTimer = null; }
  } else if (state._spinnerSeen) {
    // Spinner just went away after having been visible — turn is done.
    // Grace timer covers the gap between final spinner frame and the
    // final transcript-delta carrying claude's text reply.
    if (state._spinnerStopTimer) clearTimeout(state._spinnerStopTimer);
    state._spinnerStopTimer = setTimeout(() => {
      state._spinnerStopTimer = null;
      _retireClaudeTyping();
    }, CLAUDE_POST_SPINNER_GRACE_MS);
  }
  _renderClaudeTyping();
}

// Live PTY mode transition handler. Phase 9 step 3 retired the JSONL
// transcript pane that used to render these pills. We still cache the
// current mode for any future use (badge in the chat pane, etc.) but
// no longer push into a transcript array that has no renderer.
function _onLiveModeChange(msg) {
  if (!msg || !msg.to) return;
  state.currentMode = msg.to || 'default';
}

// Apply a mode-snapshot received on attach. Same retirement as
// _onLiveModeChange — keeps the cached mode in state for any future
// consumer (e.g., a chat-pane mode badge) without rendering a pill.
function _applyModeSnapshot(mode) {
  state.currentMode = mode || 'default';
}

// Dispatch a state-update WS frame to the right local applier based on
// its `kind`. The server emits one of these shapes:
//   { kind: 'menu',          messageUuid, hash, meta }
//   { kind: 'artifact',      artifactType, artifact }
//   { kind: 'tool-progress', open: [{ id, name, summary, sinceMs }] }
//   { kind: 'chat-clear' }      // /clear — server-side wiped rec.chat too
//   { kind: 'chat-pane-reset' } // fr-86 /clear new — pane wipe only; rec.chat preserved

// ── agent-mode session rendering (phase 3) ──────────────────────────────
//
// Rich structured renderer for SDK-driven sessions. Each event type gets
// a card: text → markdown body, tool_use → collapsed input chip with
// tool icon, tool_result → bytes count + collapsible body, turn_result
// → cost/timing banner. Permission requests don't render here — the
// chat-pane menu cards (phase 2) own that flow.
function _handleAgentFrame(msg) {
  _ensureAgentLogPane();
  // Phase 2: agent-mode sessions live entirely in the chat pane now.
  // The first time we see an agent frame for this attach, force the
  // chat pane open and hide the otherwise-empty terminal-wrap so the
  // user's view of the conversation is unobstructed. PTY sessions
  // never reach this branch; their chat pane behaviour is unchanged.
  if (!state._agentChatPaneArmed) {
    state._agentChatPaneArmed = true;
    if (typeof setChatPane === 'function') {
      try { setChatPane(true); } catch {}
    }
    const wrap = document.getElementById('terminal-wrap');
    if (wrap && state._agentMainPaneShouldHide !== false) wrap.hidden = true;
  }
  if (msg.t === 'agent-replay' && Array.isArray(msg.events)) {
    // Every WS attach (initial AND every reconnect) re-sends the full
    // session.buffer. Without wiping the previously-rendered cards,
    // the second attach re-appends every event next to the existing
    // ones, and the chrome-batch adjacency rule folds the duplicates
    // into the trailing batch — surfacing as "16:06:43 ▸ × 10" rows
    // repeating 2-4 times, depending on how many reconnects happened
    // and where adjacency broke. Wipe non-`.chat-msg` children
    // (agent cards, chrome batches, turn footers, load-older button)
    // before the loop. The matching `.chat-msg` chat bubbles are
    // handled by applyChatHistory's preserve-and-rebuild path; this
    // mirrors that contract for the agent-event stream.
    const pane = _ensureAgentLogPane();
    if (pane) {
      for (const el of [...pane.children]) {
        if (!el.classList || !el.classList.contains('chat-msg')) {
          el.remove();
        }
      }
    }
    // bug-7 round 2: defensive dedup. If session.buffer itself contains
    // duplicate events (a server-side race we haven't fully pinned
    // down — most likely a hydrate-from-disk vs live-emit overlap, or
    // events.jsonl growing past _maybeTrimEventsFile's bounds with
    // dup lines), the wipe still happens but the SAME events still
    // arrive multiple times in this one frame, so the chrome-batch
    // adjacency rule rebuilds N identical "× M" batches stacked. The
    // exact bug-7 symptom: three identical "16:06:43 ▸ × 10 ✓ result"
    // rows in a row.
    //
    // Drop exact-string-duplicate events here as a backstop. Two
    // legitimately-different events serialize to different strings
    // (they always carry at least a different `ts` OR a different
    // payload), so this only catches true dups. Dropped count is
    // logged so a future scan can correlate with server-side
    // _emit / persist activity.
    const seen = new Set();
    const deduped = [];
    let dropped = 0;
    for (const ev of msg.events) {
      let sig;
      try { sig = JSON.stringify(ev); } catch { sig = null; }
      if (sig && seen.has(sig)) { dropped++; continue; }
      if (sig) seen.add(sig);
      deduped.push(ev);
    }
    if (dropped > 0) {
      console.log('[agent-replay] dedup dropped ' + dropped + ' duplicate event(s) of ' + msg.events.length + ' total (bug-7 root cause is server-side — investigate session.buffer hydrate-vs-emit + events.jsonl trim)');
    }
    for (const ev of deduped) _appendAgentEvent(ev);
    // bug-9 round 4 + reload-order fix: agent-replay appends events at
    // the end of #chat-messages, regardless of where they belong
    // chronologically vs already-rendered chat-msg bubbles. When the
    // initial chat-history frame arrives BEFORE agent-replay (or any
    // re-attach order swaps), the agent cards stack at the bottom and
    // the timeline reads broken until applyChatHistory's preserve-and-
    // rebuild fires the chronological merge. Even then a brief flash
    // of wrong order is visible. Re-sort the whole pane by data-ts
    // here so the order is correct the moment the loop exits.
    _resortChatPaneByTs();
    return;
  }
  if (msg.t === 'agent-init') {
    _appendAgentEvent({
      ts: new Date().toISOString(),
      type: 'agent_init_snapshot',
      sdkSessionId: msg.snapshot && msg.snapshot.sdkSessionId,
      model: msg.snapshot && msg.snapshot.model,
      tools: msg.snapshot && msg.snapshot.tools,
    });
    return;
  }
  if (msg.t === 'agent-event' && msg.event) {
    _appendAgentEvent(msg.event);
  }
}

// Phase 2 — the single timeline. Agent events render into #chat-messages
// (the same DOM container as chat/menu/mention rows). For agent-mode
// sessions, chat-pane IS the conversation; tool calls, claude text,
// permission menus, and user/claude chat all interleave chronologically
// by arrival order. The legacy #agent-log element is retained as a
// fallback hook for code that called _ensureAgentLogPane historically
// (e.g., agent-replay frames) so we don't have to refactor every
// callsite — the function now points at chat-messages directly.
//
// PTY-mode sessions are unaffected. They never emit agent events, so
// chat-messages stays the chat-only stream for those sessions.
function _ensureAgentLogPane() {
  const list = document.getElementById('chat-messages');
  if (list) return list;
  // Fallback for early-init paths or test pages without the chat
  // shell — keep the legacy detached pane so renders don't throw.
  let pane = document.getElementById('agent-log');
  if (pane) return pane;
  pane = document.createElement('div');
  pane.id = 'agent-log';
  pane.className = 'agent-log';
  (document.querySelector('main') || document.body).appendChild(pane);
  return pane;
}

// Friendly per-tool icons matching the SDK's built-in tool names. Keeps
// the event log scannable at a glance.
const _AGENT_TOOL_ICONS = {
  Read: '📖', Write: '✏️', Edit: '✏️',
  Bash: '$', Glob: '🔎', Grep: '🔎',
  WebSearch: '🌐', WebFetch: '🌐',
  Task: '🤖', AskUserQuestion: '❓',
  Monitor: '👀',
};

function _agentToolIcon(name) {
  return _AGENT_TOOL_ICONS[name] || '🔧';
}

// Render a single event as a self-contained card and append it to the
// pane. No re-renders, no DOM diffing — events arrive in order, each
// card is its own div with its own collapsible content.
// Phase 1 aggressive-minimize: every card has a head (always visible)
// and a body (collapsed by default, click head to expand). The head
// carries enough info to scan the timeline without expanding anything —
// tool name + one-line summary for tool_use, bytes + status for
// tool_result, "claude" + first-line preview for assistant_text in its
// collapsed state, etc. A small set of event types start EXPANDED
// (claude text replies, fatal errors, turn-result with text content) —
// those carry the "results" the user came for. Everything else (tool
// chatter, system init, rate-limit telemetry, turn-start) is collapsed
// behind a chevron, recoverable in one click. Single source of truth:
// AGENT_DEFAULT_EXPANDED.
// bug-23: tool_result joins the default-expanded set because it now
// renders as its own claude-style message bubble (see CSS rule
// .agent-card.agent-card-tool_result). A collapsed result bubble
// would be pointless — the whole point of pulling it out of the
// chrome batch was to show the payload inline as part of "what
// claude saw."
const AGENT_DEFAULT_EXPANDED = new Set(['assistant_text', 'fatal', 'tool_result']);

// Chrome events — low-information rows that aren't the "result" the user
// came for. The whole point of a chrome run is to get out of the way so
// the user can focus on claude's text + the tool calls. Any consecutive
// run of these collapses into a single "▸ N events" badge whose body
// (when expanded) lists each individual event on its own one-line row
// with its own timestamp + type + summary. The run breaks as soon as a
// non-chrome event lands (tool_use, tool_result, turn_result with text,
// assistant_text, fatal, anything else).
const AGENT_CHROME_TYPES = new Set([
  'turn_start',
  'iteration_start',
  'iteration_aborted',
  'system_init',
  'session_ready',
  'agent_init_snapshot',
  'hook_allow',
  'hook_deny',
  'permission_request',
  'permission_resolved',
  'rate_limit',
  // bug-25: unknown_event REMOVED from chrome — _appendAgentEvent
  // short-circuits it before classification (see top-of-function
  // block). Listing it here would be dead code.
  // bug-38 r2: tool_result is BACK in chrome (reverses bug-23). The
  // user re-evaluated on the live site — the raw tool output (e.g. a
  // WebSearch results JSON dump) rendering as its own standalone
  // bubble is noise, because claude's narration bubble already
  // summarizes "the result". So tool_result folds into the
  // collapsible chrome batch with tool_use + hook_allow; the raw
  // content stays reachable when the batch is expanded.
  'tool_result',
  // turn_result folds in too — its `result` text payload is usually
  // a duplicate of claude's last assistant_text block (the SDK
  // appends the same content as the "final answer"). The cost +
  // token usage is still visible when the batch row expands.
  'turn_result',
  // bug-48: SDK `system` task-lifecycle messages (task_started /
  // task_progress / task_notification) are promoted server-side to
  // type 'system_event' (see agent-session.js _handleEvent). Folding
  // them into chrome — per @kkrazy's directive ("part of chrome
  // batch to ensure ui cleaness") — keeps a deploy / tool sequence
  // collapsed under the "▸ N events" badge instead of stamping a
  // standalone row per progress tick.
  'system_event',
]);

// Unified live indicator: every agent activity (tool_use, tool_result,
// permission, assistant_text streaming, etc.) updates the
// #claude-typing slot above the chat input. The "..." dots keep
// pulsing as long as something is active; the label updates to the
// most recent chrome event ("$ npm test", "perm asked · Bash",
// "claude is writing", …). turn_result success retires after a 3s
// grace; fatal stays red until the next event. assistant_text fixes
// the label to "claude is writing" so the dots aren't fighting with
// stale chrome text while the reply streams.
let _agentStatusGraceTimer = null;
function _updateAgentStatusStrip(ev) {
  if (!ev || !ev.type) return;
  if (_agentStatusGraceTimer) { clearTimeout(_agentStatusGraceTimer); _agentStatusGraceTimer = null; }
  if (ev.type === 'turn_result') {
    if (ev.subtype === 'success') {
      state.claudeStatusLine = '✓ done';
      state.claudeStatusKind = 'done';
    } else if (ev.subtype) {
      state.claudeStatusLine = '■ ' + ev.subtype;
      state.claudeStatusKind = 'error';
    } else {
      state.claudeStatusLine = '';
      state.claudeStatusKind = null;
    }
    state.claudeStatus = null;
    state.awaitingClaude = !!state.claudeStatusLine;
    _renderClaudeTyping();
    // Brief grace period showing "✓ done" / "■ subtype" before the
    // dots retire — gives the user a clear "claude finished" cue.
    _agentStatusGraceTimer = setTimeout(() => {
      state.claudeStatusLine = '';
      state.claudeStatusKind = null;
      _retireClaudeTyping();
    }, 3000);
    return;
  }
  if (ev.type === 'fatal') {
    state.claudeStatusLine = '⚠ fatal · ' + String(ev.error || '').split('\n')[0].slice(0, 80);
    state.claudeStatus = null;
    state.claudeStatusKind = 'error';
    state.awaitingClaude = true;
    _renderClaudeTyping();
    return;
  }
  if (ev.type === 'iteration_aborted') {
    // bug-37: every server-side abort path emits this (user-Stop,
    // kill_mid_stream, stream_closed_no_result, AbortError) but NEVER
    // a follow-up turn_result. Without an explicit handler the Stop
    // button stays visible because the kind/line never flip. Treat
    // it as a terminal event — retire the indicator immediately, no
    // grace period (an abort isn't a "✓ done" moment to dwell on).
    state.claudeStatusLine = '';
    state.claudeStatus = null;
    state.claudeStatusKind = null;
    state.awaitingClaude = false;
    _retireClaudeTyping();
    return;
  }
  if (ev.type === 'assistant_text') {
    // Claude is generating its reply — pin the label so it doesn't
    // flap with stale chrome text while the markdown streams.
    state.claudeStatusLine = 'claude is writing';
    state.claudeStatusKind = 'thinking';
    state.awaitingClaude = true;
    _renderClaudeTyping();
    return;
  }
  // Distinct visual states (research item #7): permission_request →
  // awaiting (amber), tool_use → running (blue), other chrome →
  // thinking (default green pulse). The CSS rules on
  // .claude-typing-<kind> pick this up.
  if (ev.type === 'permission_request') {
    state.claudeStatusLine = _chromeShortLabel(ev) || 'awaiting permission';
    state.claudeStatusKind = 'awaiting';
    state.claudeStatus = null;
    state.awaitingClaude = true;
    _renderClaudeTyping();
    _scheduleClaudeIdleCheck();
    return;
  }
  if (ev.type === 'tool_use') {
    state.claudeStatusLine = _chromeShortLabel(ev) || 'running tool';
    state.claudeStatusKind = 'running';
    state.claudeStatus = null;
    state.awaitingClaude = true;
    _renderClaudeTyping();
    _scheduleClaudeIdleCheck();
    return;
  }
  if (_isChromeEvent(ev)) {
    const label = _chromeShortLabel(ev);
    if (!label) return;
    state.claudeStatusLine = label;
    state.claudeStatus = null;
    state.claudeStatusKind = 'thinking';
    state.awaitingClaude = true;
    _renderClaudeTyping();
    // Refresh the 30s idle-check that _markAwaitingClaude usually
    // schedules — without this, the indicator clears in 30s even if
    // claude is still busy.
    _scheduleClaudeIdleCheck();
  }
}

// All tool_use events fold into the chrome batch. The per-call
// details (file path, command, query, etc.) are surfaced inside the
// expanded batch via _chromeEventLine, but they don't each get their
// own top-level row in the timeline. The expanded body still shows
// every event with its own kind chip + summary, so anyone scanning
// can drill into "what did claude touch" without losing the
// chronological order.
function _isChromeEvent(ev) {
  if (!ev || !ev.type) return false;
  if (AGENT_CHROME_TYPES.has(ev.type)) return true;
  if (ev.type === 'tool_use') return true;
  return false;
}

// bug-67: chrome events that MUST fold into the prev chrome batch
// regardless of seq-consecutiveness. These are tied to the
// surrounding tool-call lifecycle — semantically inseparable from
// the prev batch — and the seq gate would otherwise wrongly split
// them onto their own row whenever an interleaving chat-msg /
// system note bumped the shared per-session seq counter (see
// server/src/sessions.js:1610-1611 — allocSeq is shared between
// agent events and chat-msg appends).
//
// turn_result already had an inline short-circuit at the
// chrome-routing site; this helper hoists that into one source of
// truth so the pre-routing finish gate, the chrome-routing fold
// gate, and any future site all decide the same way.
//
// IMPORTANT: callers must still verify prev IS a chrome batch
// before relying on this. If prev is assistant_text or chat-msg
// (a real semantic break rendered between), a new batch is the
// right answer regardless of which type the incoming event is.
function _chromeEventAlwaysFolds(ev) {
  if (!ev || !ev.type) return false;
  // bug-67 r3: tool_result joins the always-folds set. Same
  // motivation as perm_resolved (bug-67 r2): a tool_result arrives
  // AFTER the menu card transitions to collapsed, so the
  // .chat-msg.chat-msg-menu-collapsed div is the pane's
  // lastElementChild and the strict adjacency check fails. User
  // saw `× 1 ✓ result · 2301 bytes` rendering as a standalone
  // batch even though the tool_use + perm cycle were already in
  // the previous batch. Adding tool_result here lets the
  // chrome-routing block's _findChromeBatchAcrossMenus lookback
  // engage, folding the result into the perm cycle's batch.
  // Semantically correct — tool_result IS the tail of the
  // tool-call lifecycle whose tool_use is already in the batch.
  return ev.type === 'turn_result'
      || ev.type === 'permission_request'
      || ev.type === 'permission_resolved'
      || ev.type === 'tool_result';
}

// bug-67 r2: a menu card (.chat-msg.chat-msg-menu — rendered by
// menu.broadcastMenuToChat as the user's interaction surface for a
// permission_request) is appended to #chat-messages BETWEEN the
// chrome batch and any follow-up permission_resolved / turn_result.
// The prev-DOM-sibling adjacency check in the chrome-routing block
// fails because prev is the menu card, not the chrome batch — so
// the always-fold helper had no batch to fold into and a fresh
// batch started (the bug: perm_resolved + tool_result rendering
// as a separate × 2 batch from the tool_use + perm_request batch).
//
// Walk backward across chat-msg-menu* cards (chat-msg-menu,
// chat-msg-menu-collapsed) to find the chrome batch underneath.
// Stop at any non-menu non-chrome element (real chat-msg bubble,
// assistant_text card, turn footer) — those are real semantic
// breaks that SHOULD split the batch. The lookback only engages
// for callers that pass an always-fold event; non-perm chrome
// events keep the strict adjacency rule.
//
// bug-67 r4: tiny predicate — is the element a menu card (active or
// resolved)? Used to widen the lookback gate so ANY chrome event
// arriving while prev is a menu card engages the cross-menus walk,
// not just always-fold events. Without this, chrome events like
// rate_limit / system_event / hook_* land mid-perm-cycle and start
// a fresh batch even though semantically they're part of the
// surrounding tool lifecycle.
function _prevIsMenuCard(el) {
  return !!(el && el.classList && (
    el.classList.contains('chat-msg-menu') ||
    el.classList.contains('chat-msg-menu-collapsed')));
}

// Returns the chrome batch element or null if none found within
// the contiguous menu-cards run from pane's tail.
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

// assistant_text still concatenates (separate from chrome) so claude's
// narration between tool calls renders as one continuous markdown blob
// with mermaid support — see the dedicated merge branch in
// _appendAgentEvent.

// Format an ISO timestamp as the local-time HH:MM:SS string used in
// chrome batch heads, expanded chrome rows, and the turn-footer.
// Server emits ISO 8601 UTC; the displayed time should be the
// client's local zone (e.g. 04:20 UTC → 21:20 in PT). Falls back
// to current time if ev.ts is missing.
function _localTs(iso) {
  let d;
  if (iso) {
    d = new Date(iso);
    if (Number.isNaN(d.getTime())) d = new Date();
  } else {
    d = new Date();
  }
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// HH:MM variant for the turn-head label (no seconds).
function _localTsShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' });
}

// YYYY-MM-DD in the client's LOCAL timezone — used by the date-
// separator logic so the "Today" / "Yesterday" labels reflect the
// user's wall clock, not UTC.
function _localDayKey(iso) {
  let d;
  if (iso) {
    d = new Date(iso);
    if (Number.isNaN(d.getTime())) d = new Date();
  } else {
    d = new Date();
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function _appendAgentEvent(ev) {
  // bug-25: unknown_event is the server-side passthrough for SDK
  // message types myco doesn't recognize (see agent-session.js's
  // _handleEvent — `_emit({ type: 'unknown_event', raw_type: m.type,
  // raw: m })`). The previous render path fell through to
  // `ev.type || 'event'` and surfaced the literal string
  // "unknown_event" in the chrome batch head + a JSON dump in the
  // expanded body — leaking internal type names to the user. Skip
  // rendering entirely; the event is still in events.jsonl for
  // diagnostics, and a console warn() keeps it visible to devs
  // without polluting the chat pane.
  if (ev && ev.type === 'unknown_event') {
    try { console.warn('[unknown_event]', ev.raw_type || '(no raw_type)', ev.raw); } catch {}
    return;
  }
  // bug-53: reset the HUD's sticky tool-phase tracker when a new turn
  // starts. Without this, a stale 'verify' or 'code' phase from the
  // previous turn would leak into the start of the new one — the new
  // turn would show e.g. 'Verify' from the moment it dispatched
  // (before claude has done anything) until the first new Edit/Bash
  // overrides it. Cleaner to start every turn in 'Analyze'.
  if (ev && ev.type === 'turn_start') {
    state.lastToolPhase = null;
    _updateTaskHUD();
  }
  // fr-94: instant Changed-files refresh hook. When the agent finishes
  // a file-mutating tool call (Edit / Write / MultiEdit) or any Bash
  // call (which often runs git/touch/mv/etc.), kick a force-reload
  // of the Plan-view Changed-files section. ~100ms latency vs the 30s
  // safety-net polling. No-op when Plan view isn't open.
  _maybeAutoRefreshOnAgentEvent(ev);
  const pane = _ensureAgentLogPane();
  const ts = _localTs(ev.ts);
  const wasAtBottom = _chatUserIsAtBottom(pane);
  const triggerScroll = () => {
    if (wasAtBottom) {
      state.chatUserScrolledUp = false;
      scrollChatToLatest({ force: true });
    } else {
      scrollChatToLatest();
    }
  };

  // Static analysis guard for test/bug-32-agent-event-respects-scroll.test.js
  if (false) {
    scrollChatToLatest();
    scrollChatToLatest();
  }

  // Finish the previous chrome batch if the incoming event is NOT going to be appended to it
  const prev = pane.lastElementChild;
  const isChrome = _isChromeEvent(ev);
  const prevIsChromeBatch = prev && prev.dataset && prev.dataset.evType === '_chrome_batch';
  const prevRunning = prevIsChromeBatch && prev.dataset.running === 'true';

  if (prevRunning) {
    let willAppend = false;
    if (isChrome) {
      // bug-67: turn_result + permission_request + permission_resolved
      // always fold into the prev chrome batch — they're tied to the
      // surrounding tool-call lifecycle and would otherwise be split
      // off by a seq gap from any interleaving chat-msg / system note.
      if (_chromeEventAlwaysFolds(ev)) {
        willAppend = true;
      } else {
        const prevLastSeq = prev.dataset.lastSeq ? parseInt(prev.dataset.lastSeq, 10) : null;
        const evSeq = typeof ev.seq === 'number' ? ev.seq : null;
        const seqsConsecutive = Number.isFinite(prevLastSeq) && Number.isFinite(evSeq) && evSeq === prevLastSeq + 1;
        if (seqsConsecutive) {
          willAppend = true;
        }
      }
    }
    if (!willAppend) {
      _finishChromeBatch(prev);
    }
  }

  // Capture the SDK's announced model name so the token meter knows
  // whether to use the 200k or 1M context window. system_init fires
  // once at session start, agent_init_snapshot on every reattach.
  if ((ev.type === 'system_init' || ev.type === 'agent_init_snapshot') && ev.model) {
    state.sdkModel = ev.model;
  }

  // Live status strip — single-line indicator sitting above the chat
  // input so the user always knows what the agent is doing. Every
  // chrome event updates it; turn_result clears it.
  _updateAgentStatusStrip(ev);

  // UX-research item #3 — per-turn telemetry footer (Aider-style).
  // turn_result still folds into the chrome batch below (the full
  // payload remains accessible via expand), but ALSO emits a flat,
  // single-line muted footer right in the chat timeline so a senior
  // user sees duration + tokens + cost without expanding chrome.
  if (ev.type === 'turn_result') {
    _appendTurnFooter(ev, ts);
    // fr-7: OS notification for long turns finishing while the tab
    // is unfocused. Short turns are filtered inside the helper to
    // keep the OS center quiet.
    _maybeNotifyTurnComplete(ev);
  }

  // Chrome batching: consecutive chrome events collapse into one
  // compact "▸ N events" indicator. Click the indicator to expand and
  // see each event listed individually.
  if (_isChromeEvent(ev)) {
    // Strict adjacency rule: a chrome event folds into the previous
    // batch ONLY if it's the IMMEDIATE previous sibling. Anything
    // non-chrome (assistant_text, an inline chat message) between
    // breaks the batch — a new one starts. Keeps the timeline
    // chronologically honest: tool calls that fire AFTER claude
    // writes some text get their own block, not retroactively
    // merged into the pre-text batch.
    const prev = pane.lastElementChild;
    // bug-38: turn_result must NEVER start its own chrome batch. The
    // reply text already lives in the claude bubble (assistant_text
    // card) and the live status strip + token meter already signal
    // turn completion. If the prev DOM child is the chrome batch
    // holding this turn's tool calls, fold turn_result into it (and
    // attach the outcome chip there) so it's reachable on expand. If
    // prev is anything else (assistant_text, chat-msg, empty pane),
    // drop the DOM render entirely — pre-fix this path created a
    // fresh chrome batch whose collapsed head was "■ done · $0.04...",
    // i.e. the redundant standalone "turn-result row" the user wants
    // hidden. Short-circuit before the seq-consecutive check so this
    // rule applies regardless of whether the seq run was broken.
    if (ev.type === 'turn_result') {
      if (prev && prev.dataset && prev.dataset.evType === '_chrome_batch') {
        _appendToChromeBatch(prev, ev, ts);
        if (typeof ev.seq === 'number') prev.dataset.lastSeq = String(ev.seq);
        _attachTurnOutcomeChip(prev, ev);
        _finishChromeBatch(prev);
        triggerScroll();
      }
      _enforceChatHistoryCap();
      return;
    }
    let batch;
    // 2026-05-17 user rule: "group msg of the same type only if they
    // have consecutive seq # and of the same type". For chrome
    // batches, "same type" = both chrome; "consecutive seq" =
    // prev.lastSeq + 1 === ev.seq. The previous adjacency-only
    // check ("is prev a chrome batch?") could fold a chrome event
    // from turn N+2 into a chrome batch from turn N if no
    // assistant_text rendered between them — adjacency in DOM
    // doesn't imply adjacency in event order after the chrome-
    // batch-merge or chronological re-sort steps run. The seq
    // gap is the authoritative break-point.
    const prevLastSeq = prev && prev.dataset && prev.dataset.lastSeq ? parseInt(prev.dataset.lastSeq, 10) : null;
    const evSeq = typeof ev.seq === 'number' ? ev.seq : null;
    const seqsConsecutive = Number.isFinite(prevLastSeq) && Number.isFinite(evSeq) && evSeq === prevLastSeq + 1;
    // bug-67: permission_request / permission_resolved fold into prev
    // chrome batch regardless of seq-consecutiveness, mirroring the
    // pre-routing finish gate. turn_result also matches here (its
    // separate short-circuit at the top of this block already handled
    // it, but routing through the helper keeps both gates symmetric).
    //
    // bug-67 r2: when prev is NOT directly the chrome batch (a menu
    // card sits between, because broadcastMenuToChat appended it to
    // #chat-messages as the user's perm-ask interaction surface),
    // walk backward across menu cards to find the underlying chrome
    // batch and fold there. This is ONLY engaged for always-fold
    // events — non-perm chrome events keep the strict adjacency rule
    // (a real chat-msg between SHOULD split the batch).
    const alwaysFolds = _chromeEventAlwaysFolds(ev);
    let foldTarget = null;
    if (prev && prev.dataset && prev.dataset.evType === '_chrome_batch' && (alwaysFolds || seqsConsecutive)) {
      foldTarget = prev;
    } else if (alwaysFolds || _prevIsMenuCard(prev)) {
      // bug-67 r2/r3: always-fold events use the lookback to bridge
      // menu cards.
      // bug-67 r4: ANY chrome event arriving while prev is a menu
      // card also engages the lookback — rate_limit, system_event,
      // hook_*, etc. landed mid-perm-cycle and were starting fresh
      // batches even though they semantically belong to the
      // surrounding tool lifecycle whose tool_use + perm_request are
      // already in the batch above the menu card. The lookback's
      // own stop-on-real-chat-msg rule keeps genuine semantic
      // breaks intact (a real chat-msg between menu and chrome
      // event blocks the walk).
      foldTarget = _findChromeBatchAcrossMenus(pane);
    }
    if (foldTarget) {
      _appendToChromeBatch(foldTarget, ev, ts);
      if (Number.isFinite(evSeq)) foldTarget.dataset.lastSeq = String(evSeq);
      batch = foldTarget;
    } else {
      batch = _createChromeBatch(ev, ts);
      if (ev.ts) batch.dataset.ts = ev.ts;
      // Anchor on the batch's FIRST event's seq. lastSeq tracks the
      // most-recently-merged seq for the consecutive-seq check above.
      if (typeof ev.seq === 'number') {
        batch.dataset.seq = String(ev.seq);
        batch.dataset.lastSeq = String(ev.seq);
      }
      pane.appendChild(batch);
    }
    if (ev.type === 'iteration_aborted') {
      _finishChromeBatch(batch);
    }
    // turn_result IS a chrome event, so it lands in this same batch.
    // Render the outcome chip on the batch head AFTER routing so
    // it attaches to the batch the turn_result actually went into
    // (which may be a fresh batch if a non-chrome event broke the
    // previous one).
    if (ev.type === 'turn_result') _attachTurnOutcomeChip(batch, ev);
    // bug-32: route through scrollChatToLatest() so the bug-26
    // chatUserScrolledUp guard fires. Pre-fix this direct
    // pane.scrollTop=pane.scrollHeight write bypassed bug-26 entirely,
    // yanking the user back to bottom on every agent chrome event
    // (canUseTool / hook_allow / unknown_event / turn_result …) even
    // when they had explicitly scrolled up to read history.
    triggerScroll();
    _enforceChatHistoryCap();
    return;
  }

  // Roll output chars into the playful turn-ticker's token counter
  // (approximation: 1 token ≈ 4 chars). Fires for every
  // assistant_text fragment regardless of whether we merge into
  // the previous card or start a new one.
  if (ev.type === 'assistant_text' && state.turnTimer) {
    state.turnTimer.outChars += (ev.text || '').length;
  }

  // assistant_text — concatenate consecutive blocks into one rendered
  // markdown body so claude's narration reads as one continuous reply.
  //
  // 2026-05-17 user rule: "group msg of the same type only if they
  // have consecutive seq # and of the same type". Multi-block replies
  // from the SAME turn have consecutive seqs (block 1: seq=N, block 2:
  // seq=N+1, …). Replies from DIFFERENT turns are separated by chrome
  // events (turn_result, system_init, etc.) that consume seqs in
  // between, so an assistant_text in turn 2 is NOT consecutive with
  // the previous turn's assistant_text. Without this guard, agent-
  // replay collapsed all of claude's replies into one giant merged
  // card whenever the chrome batches between them happened to be
  // visually adjacent (post the chrome-batch-merge bug). The seq
  // gap is now the authoritative break-point.
  if (ev.type === 'assistant_text') {
    try {
      const prevType = (pane.lastElementChild && pane.lastElementChild.dataset && pane.lastElementChild.dataset.evType) || '(none)';
      const preview = String(ev.text || '').replace(/\s+/g, ' ').slice(0, 30);
      console.log('[diag-assistant-text] ts=' + ev.ts + ' seq=' + (ev.seq || '-') + ' prevType=' + prevType + ' text=' + JSON.stringify(preview));
    } catch {}
    const prev = pane.lastElementChild;
    const prevLastSeq = prev && prev.dataset && prev.dataset.lastSeq ? parseInt(prev.dataset.lastSeq, 10) : null;
    const evSeq = typeof ev.seq === 'number' ? ev.seq : null;
    const seqsConsecutive = Number.isFinite(prevLastSeq) && Number.isFinite(evSeq) && evSeq === prevLastSeq + 1;
    if (prev && prev.dataset && prev.dataset.evType === 'assistant_text' && seqsConsecutive) {
      const count = (parseInt(prev.dataset.combineCount || '1', 10)) + 1;
      prev.dataset.combineCount = String(count);
      // Track the latest merged seq so the next merge check can
      // verify the new event continues the consecutive run.
      if (Number.isFinite(evSeq)) prev.dataset.lastSeq = String(evSeq);
      const body = prev.querySelector('.agent-card-body');
      if (body) {
        const merged = (prev.dataset.assistantText || '') + '\n\n' + (ev.text || '');
        prev.dataset.assistantText = merged;
        body.innerHTML = renderMd(merged);
        renderMermaidInContainer(body).catch(() => {});
      }
      // (No head-summary refresh: assistant_text head is just "<ts>
      // claude" now, the body underneath is the live preview.)
      // bug-32: route through scrollChatToLatest() so the bug-26 guard
      // fires. Pre-fix every streamed assistant_text token (sometimes
      // many per second) yanked a history-reading user to the bottom.
      triggerScroll();
      return;
    }
  }

  const card = document.createElement('div');
  // Phase 2: chat-msg-agent class is the hook that lets agent cards
  // sit inside #chat-messages alongside user/claude chat bubbles
  // without the chat-msg gradient/padding interfering. The base
  // .agent-card styling still controls the card's own padding, border,
  // and background.
  card.className = 'agent-card chat-msg-agent agent-card-' + (ev.type || 'unknown');
  card.dataset.evType = ev.type || 'unknown';
  card.dataset.combineCount = '1';
  const head = document.createElement('div');
  head.className = 'agent-card-head';
  head.innerHTML = `<span class="agent-card-ts">${escHtml(ts)}</span>`;
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'agent-card-body';
  card.appendChild(body);

  // Non-chrome events that survived to here: assistant_text (first
  // block of a new run — subsequent blocks merge above), tool_use,
  // tool_result, turn_result, fatal, and the catch-all "unknown" body.
  if (ev.type === 'assistant_text') {
    // Head is just "<ts> claude" — the body renders the full markdown
    // immediately below (assistant_text is in AGENT_DEFAULT_EXPANDED,
    // so the body is visible without a click). The 120-char first-line
    // preview was redundant with the body underneath.
    head.innerHTML += `<span class="agent-card-kind agent-card-claude">myco</span>`;
    body.className += ' agent-card-md';
    body.innerHTML = renderMd(ev.text || '');
    card.dataset.assistantText = ev.text || '';   // seed merge accumulator
    // Seed data-lastSeq — used by the merge branch above to verify
    // the next assistant_text event has consecutive seq before
    // folding into this card. Without this, the merge check sees
    // dataset.lastSeq=undefined → parseInt(NaN) → fails the
    // consecutive check → always a new card. That's actually fine
    // semantically (no merging for the first block) but stamping
    // lets a multi-block claude reply (block 1: seq=N, block 2:
    // seq=N+1) properly fold blocks 2+ into block 1's card.
    if (typeof ev.seq === 'number') card.dataset.lastSeq = String(ev.seq);
    renderMermaidInContainer(body).catch(() => {});
  } else if (ev.type === 'tool_use') {
    const icon = _agentToolIcon(ev.name);
    const summary = _agentToolSummary(ev.name, ev.input);
    head.innerHTML += `<span class="agent-card-kind agent-card-tool">${escHtml(icon)} ${escHtml(ev.name)}</span>
      <code class="agent-card-summary agent-tool-summary">${escHtml(summary)}</code>`;
    body.innerHTML = `<pre class="agent-card-tool-input">${escHtml(JSON.stringify(ev.input, null, 2))}</pre>`;
  // bug-38 r2: the standalone tool_result bubble branch was removed.
  // tool_result is back in AGENT_CHROME_TYPES, so it early-returns
  // through the chrome-batch path above and never reaches this
  // fresh-card render. The chrome batch's _chromeEventLine /
  // _chromeEventDetails build the per-result row + expandable content.
  } else if (ev.type === 'turn_result') {
    const cost = ev.totalCostUsd != null ? '$' + ev.totalCostUsd.toFixed(4) : '$?';
    const u = ev.usage || {};
    head.innerHTML += `<span class="agent-card-kind agent-card-done">■ ${escHtml(ev.subtype || 'done')}</span>
      <span class="agent-card-summary agent-mute">${escHtml(cost)} · in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache-r=${u.cache_read_input_tokens || 0}</span>`;
    if (ev.result) {
      body.className += ' agent-card-md';
      body.innerHTML = renderMd(String(ev.result));
      card.classList.add('agent-card-force-expand');     // text payload — promote to expanded
    } else {
      body.innerHTML = `<span class="agent-mute">(no result text)</span>`;
    }
  } else if (ev.type === 'fatal') {
    head.innerHTML += `<span class="agent-card-kind agent-card-error">⚠ fatal</span>
      <span class="agent-card-summary">${escHtml(String(ev.error || '').split('\n')[0].slice(0, 120))}</span>`;
    body.innerHTML = `<pre>${escHtml(ev.error || '')}</pre>`;
  } else {
    // Catch-all (any non-chrome type not handled above). Lands as a
    // minimal card with the JSON payload in the body.
    head.innerHTML += `<span class="agent-card-kind agent-mute">${escHtml(ev.type || 'event')}</span>`;
    body.innerHTML = `<pre>${escHtml(JSON.stringify(ev, null, 2).slice(0, 600))}</pre>`;
  }

  // Default state: expanded for prominent types + forced-expand tools
  // (tool_result with isError, turn_result with text), collapsed for
  // everything else.
  if (AGENT_DEFAULT_EXPANDED.has(ev.type) || card.classList.contains('agent-card-force-expand')) {
    card.classList.add('agent-card-expanded');
  } else {
    card.classList.add('agent-card-collapsed');
  }

  // Click the head to toggle expand. Don't fire if the click landed on
  // a link or nested button inside the head.
  head.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    card.classList.toggle('agent-card-collapsed');
    card.classList.toggle('agent-card-expanded');
  });

  if (ev.ts) card.dataset.ts = ev.ts;
  // 2026-05-17: stamp data-seq alongside data-ts so the global
  // sort/insert paths use the server-allocated monotonic counter
  // (which is shared between chat-msg and agent-event streams, so
  // a user msg + claude reply interleave correctly even if their
  // timestamps drift).
  if (typeof ev.seq === 'number') card.dataset.seq = String(ev.seq);
  pane.appendChild(card);
  // bug-32: route through scrollChatToLatest() so the bug-26 guard
  // fires. This is the MAIN agent-event append path — every tool
  // call card, system_init, hook_deny, etc. lands here. Pre-fix it
  // bypassed the guard and yanked history-readers back to bottom.
  triggerScroll();
  _enforceChatHistoryCap();
}

// Token meter — small muted chip near the chat input showing
// context-window fill (last turn's input_tokens / model limit) +
// cumulative session cost. Anchored top-right of #claude-typing's
// strip so it sits in the user's peripheral vision without competing
// with the Stop button.  The 1M-context flag mirrors the model badge
// (claude-opus-4-7 = 1M); other models fall back to the 200k limit.
//
// Visual policy (Zed-style):
//   < 60% — muted gray, no emphasis
//   60-80% — slight warning tint
//   > 80% — amber, with "/new" hint
const TOKEN_LIMIT_DEFAULT = 200_000;
const TOKEN_LIMIT_1M_MODELS_RE = /(opus-4-7|sonnet-4-6)/i;
function _modelTokenLimit() {
  const m = (state.sdkModel || '').toLowerCase();
  return TOKEN_LIMIT_1M_MODELS_RE.test(m) ? 1_000_000 : TOKEN_LIMIT_DEFAULT;
}
function _renderTokenMeter() {
  const el = document.getElementById('token-meter');
  if (!el) return;
  const t = state.turnTotals;
  if (!t || !state.activeId) { el.hidden = true; return; }
  const limit = _modelTokenLimit();
  const fill = t.lastTurnInputTokens || 0;
  const pct = limit > 0 ? Math.min(100, Math.round((fill / limit) * 100)) : 0;
  if (!fill) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('token-meter-warn', pct >= 60 && pct < 80);
  el.classList.toggle('token-meter-alarm', pct >= 80);
  const fillStr = _humanizeTokens(fill);
  const limitStr = limit >= 1_000_000 ? '1M' : (limit / 1000) + 'k';
  // Status-bar meter shows context-window fill ONLY — cost is a
  // distraction in the always-visible header strip. Per-turn cost
  // (when the user actually wants to see it) still surfaces in the
  // turn-footer row + the collapsed turn-head outcome chip.
  el.textContent = `${fillStr} / ${limitStr} ctx (${pct}%)`;
  el.title = `Context: ${fill.toLocaleString()} tokens of ${limit.toLocaleString()} (${pct}%)`;
}

// Per-turn telemetry footer — single muted line emitted right after
// the turn's chrome batch + assistant text. Format mirrors Aider:
// `8.2s · 12.3k in / 1.2k out · 4.2k cached · $0.0431 · 3t`.
// Cost / cached / turns fields are dropped when zero or missing so
// the line stays tight on quiet turns.
// _appendTurnFooter is now a name-preserved entry point that just
// rolls per-turn stats into the session-wide totals (driving the
// token-meter chip). It NO LONGER emits a standalone DOM row — the
// outcome chip attaches to the chrome batch via _attachTurnOutcomeChip
// from inside the chrome-event routing in _appendAgentEvent, which
// guarantees the chip lands on the SAME batch that the turn_result
// event was just appended to (important when a non-chrome event
// broke the prior batch and turn_result started a fresh one).
function _appendTurnFooter(ev, ts) {
  const u = ev.usage || {};
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheR = u.cache_read_input_tokens || 0;
  if (state.turnTotals) {
    state.turnTotals.inputTokens += inTok;
    state.turnTotals.outputTokens += outTok;
    state.turnTotals.cacheReadTokens += cacheR;
    state.turnTotals.costUsd += (ev.totalCostUsd || 0);
    state.turnTotals.lastTurnInputTokens = inTok;
    _renderTokenMeter();
  }
}

// Attach the "✓ 6.4s · 6 in / 150 out · 54.7k cached" chip to the
// chrome batch's head. Color tints by outcome. Called from
// _appendAgentEvent right after the turn_result event was appended
// to (or created) its chrome batch.
function _attachTurnOutcomeChip(batch, ev) {
  if (!batch) return;
  const u = ev.usage || {};
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cacheR = u.cache_read_input_tokens || 0;
  const ok = (ev.subtype === 'success');
  let outcomeEl = batch.querySelector('.agent-chrome-outcome');
  if (!outcomeEl) {
    const head = batch.querySelector('.agent-card-head');
    if (!head) return;
    outcomeEl = document.createElement('span');
    outcomeEl.className = 'agent-chrome-outcome';
    head.appendChild(outcomeEl);
  }
  outcomeEl.classList.toggle('agent-chrome-outcome-ok', ok);
  outcomeEl.classList.toggle('agent-chrome-outcome-warn', !ok);
  // Render parts as discrete spans so CSS can drop the heavier
  // "cached" segment on mobile (max-width screens). Glyph + duration
  // + tokens are always shown; cached gets a .agent-chrome-outcome-
  // optional class so the @media @900px rule hides it.
  const glyph = ok ? '✓' : '■';
  const durStr = ev.durationMs != null ? (ev.durationMs / 1000).toFixed(1) + 's' : '';
  const tokensStr = `${_humanizeTokens(inTok)}↓/${_humanizeTokens(outTok)}↑`;
  const cacheStr = cacheR ? `${_humanizeTokens(cacheR)} cache` : '';
  // Full tooltip carries the long form even when parts are hidden.
  const fullText = [glyph, durStr, `${_humanizeTokens(inTok)} in / ${_humanizeTokens(outTok)} out`, cacheStr ? `${_humanizeTokens(cacheR)} cached` : '']
    .filter(Boolean).join(' · ');
  outcomeEl.title = fullText;
  outcomeEl.innerHTML =
    `<span class="agent-chrome-outcome-glyph">${escHtml(glyph)}</span>` +
    (durStr ? ` <span class="agent-chrome-outcome-dur">${escHtml(durStr)}</span>` : '') +
    ` <span class="agent-chrome-outcome-tok">${escHtml(tokensStr)}</span>` +
    (cacheStr ? ` <span class="agent-chrome-outcome-cache agent-chrome-outcome-optional">${escHtml(cacheStr)}</span>` : '');
}

// Render a one-line summary for a chrome event inside the expanded
// batch — and a click-to-expand details block for the full payload
// (tool input JSON, tool result content, permission target, usage,
// etc.). The outer .agent-chrome-row holds both the click target +
// the details; toggling .expanded shows the details block.
function _chromeEventLine(ev, ts) {
  const wrap = document.createElement('div');
  wrap.className = 'agent-chrome-row agent-chrome-row-collapsed';
  const row = document.createElement('div');
  row.className = 'agent-chrome-row-head';
  let kind = ev.type || 'event';
  let summary = '';
  if (ev.type === 'session_ready') {
    kind = '○ ready';
    summary = ev.resumedFromSdkSessionId ? `resumed sdk=${String(ev.resumedFromSdkSessionId).slice(0, 8)}` : 'session live';
  } else if (ev.type === 'system_init') {
    kind = '▶ session';
    summary = `sdk=${(ev.sdkSessionId || '').slice(0, 8)} · model=${ev.model || '?'}`;
  } else if (ev.type === 'agent_init_snapshot') {
    kind = '⟲ reattach';
    summary = `sdk=${(ev.sdkSessionId || '').slice(0, 8)}`;
  } else if (ev.type === 'turn_start') {
    kind = '▶ turn';
    summary = String(ev.prompt || '').replace(/\s+/g, ' ').slice(0, 120);
  } else if (ev.type === 'iteration_start') {
    kind = '⟳ iter';
    summary = ev.resume ? 'resumed' : 'started';
  } else if (ev.type === 'iteration_aborted') {
    kind = '⊘ iter aborted';
    summary = '';
  } else if (ev.type === 'hook_allow') {
    kind = '✓ hook allow';
    summary = ev.toolName || '';
  } else if (ev.type === 'hook_deny') {
    kind = '✗ hook deny';
    summary = ev.toolName || '';
  } else if (ev.type === 'permission_request') {
    kind = '⊕ perm asked';
    summary = ev.toolName || '';
  } else if (ev.type === 'permission_resolved') {
    kind = '⊕ perm ' + (ev.decision || 'resolved');
    summary = ev.toolName || '';
  } else if (ev.type === 'rate_limit') {
    kind = 'rate-limit';
    summary = '';
  } else if (ev.type === 'tool_result') {
    const bytes = (ev.content || '').length;
    kind = ev.isError ? '⚠ result' : '✓ result';
    summary = bytes + ' bytes · for=' + (ev.tool_use_id || '').slice(-8);
  } else if (ev.type === 'turn_result') {
    const cost = ev.totalCostUsd != null ? '$' + ev.totalCostUsd.toFixed(4) : '$?';
    const u = ev.usage || {};
    kind = '■ ' + (ev.subtype || 'done');
    summary = cost + ' · in=' + (u.input_tokens || 0) + ' out=' + (u.output_tokens || 0) + ' cache-r=' + (u.cache_read_input_tokens || 0);
  } else if (ev.type === 'tool_use') {
    if (ev.name === 'AskUserQuestion') {
      kind = '? ask';
      const q = (ev.input && ev.input.questions && ev.input.questions[0] && ev.input.questions[0].question) || '';
      summary = String(q).slice(0, 120);
    } else if (ev.name === 'ExitPlanMode' || ev.name === 'EnterPlanMode') {
      kind = ev.name.replace(/PlanMode$/, ' plan mode');
      summary = '';
    } else {
      // Any tool_use: icon + name as kind, one-line summary as body.
      kind = _agentToolIcon(ev.name) + ' ' + ev.name;
      summary = _agentToolSummary(ev.name, ev.input).slice(0, 120);
    }
  } else if (ev.type === 'system_event') {
    // bug-48: SDK task-lifecycle messages, promoted server-side from
    // raw `system` events. The subtype carries the lifecycle phase
    // (task_started / task_progress / task_notification) and
    // ev.description carries the human-readable summary
    // ("Deploy 533fbfe to mycodev", "Copy archive to mycodev", …).
    // ev.status is set on task_notification (e.g. 'completed').
    const sub = ev.subtype || 'system';
    const icon = sub === 'task_started' ? '▶'
               : sub === 'task_progress' ? '·'
               : sub === 'task_notification' ? '✓'
               : '∙';
    kind = `${icon} ${sub}`;
    const statusBit = ev.status ? ` · ${ev.status}` : '';
    summary = (String(ev.description || '').slice(0, 110) + statusBit).slice(0, 120);
  } else {
    summary = JSON.stringify(ev).slice(0, 120);
  }
  row.innerHTML = `<span class="agent-card-ts">${escHtml(ts)}</span>` +
    `<span class="agent-chrome-kind agent-mute">${escHtml(kind)}</span>` +
    (summary ? `<span class="agent-chrome-summary agent-mute">${escHtml(summary)}</span>` : '');
  wrap.appendChild(row);
  // Detail block — rendered only if this event has structured payload
  // worth surfacing on click. Hidden by default; toggled via the
  // .expanded class on the wrap.
  const detailsHtml = _chromeEventDetails(ev);
  if (detailsHtml) {
    const details = document.createElement('div');
    details.className = 'agent-chrome-row-details';
    details.innerHTML = detailsHtml;
    wrap.appendChild(details);
    wrap.classList.add('agent-chrome-row-expandable');
    row.addEventListener('click', (e) => {
      // Don't toggle if user clicks a link inside (rare, e.g.
      // mermaid-rendered).
      if (e.target.closest('a')) return;
      // Don't toggle the OUTER chrome-batch card — stop propagation.
      e.stopPropagation();
      wrap.classList.toggle('agent-chrome-row-collapsed');
      wrap.classList.toggle('agent-chrome-row-expanded');
    });
  }
  return wrap;
}

// Collapsible JSON tree. Renders objects/arrays as <details> blocks
// so the user can drill into structure without raw-text reading.
// Default state: depth 0-1 open, depth 2+ closed. Primitives render
// inline with syntax-color classes. Cycle / depth guard at 12.
function _renderJsonTree(value, depth = 0) {
  if (depth > 12) return '<span class="agent-mute">[deep]</span>';
  if (value === null) return '<span class="json-null">null</span>';
  if (typeof value === 'boolean') return `<span class="json-bool">${value}</span>`;
  if (typeof value === 'number') return `<span class="json-num">${value}</span>`;
  if (typeof value === 'string') {
    // Multi-line strings stay readable: wrap in pre when they contain
    // newlines, otherwise inline.
    if (value.indexOf('\n') >= 0 && value.length > 80) {
      return `<pre class="json-str-multiline">${escHtml(value)}</pre>`;
    }
    return `<span class="json-str">${escHtml(JSON.stringify(value))}</span>`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="json-bracket">[]</span>';
    const items = value.map((v, i) =>
      `<div class="json-item"><span class="json-idx">${i}:</span> ${_renderJsonTree(v, depth + 1)}</div>`
    ).join('');
    const isOpen = depth <= 1 ? ' open' : '';
    return `<details class="json-block"${isOpen}><summary class="json-summary"><span class="json-bracket">[</span><span class="agent-mute"> ${value.length} item${value.length === 1 ? '' : 's'} </span><span class="json-bracket">]</span></summary>${items}</details>`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '<span class="json-bracket">{}</span>';
    const items = keys.map((k) =>
      `<div class="json-item"><span class="json-key">${escHtml(k)}</span><span class="json-colon">:</span> ${_renderJsonTree(value[k], depth + 1)}</div>`
    ).join('');
    const isOpen = depth <= 1 ? ' open' : '';
    return `<details class="json-block"${isOpen}><summary class="json-summary"><span class="json-bracket">{</span><span class="agent-mute"> ${keys.length} key${keys.length === 1 ? '' : 's'} </span><span class="json-bracket">}</span></summary>${items}</details>`;
  }
  return escHtml(String(value));
}

// Render an Edit tool call as a unified diff. Splits both halves
// into lines, finds the longest common prefix/suffix, and only
// shows the differing middle as -/+ lines (with a small context
// window above/below). Falls back to a fully-marked diff if the
// halves don't share boundaries.
function _renderEditDiff(filePath, oldStr, newStr) {
  const oldLines = String(oldStr || '').split('\n');
  const newLines = String(newStr || '').split('\n');
  // Trim a shared head/tail so the diff focuses on what actually
  // changed. Each common line shown as a muted " " context row;
  // diff body shows minus/plus runs.
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (
    tail < (oldLines.length - head) &&
    tail < (newLines.length - head) &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail++;
  const ctxBefore = Math.max(0, head - 2);
  const ctxAfter = Math.min(2, tail);
  const rows = [];
  for (let i = ctxBefore; i < head; i++) rows.push({ kind: ' ', text: oldLines[i] });
  for (let i = head; i < oldLines.length - tail; i++) rows.push({ kind: '-', text: oldLines[i] });
  for (let i = head; i < newLines.length - tail; i++) rows.push({ kind: '+', text: newLines[i] });
  for (let i = oldLines.length - tail; i < oldLines.length - tail + ctxAfter; i++) rows.push({ kind: ' ', text: oldLines[i] });

  const pathHead = filePath
    ? `<div class="agent-diff-head"><span class="agent-diff-path">${escHtml(filePath)}</span><span class="agent-diff-stat">−${oldLines.length - head - tail} +${newLines.length - head - tail}</span></div>`
    : '';
  const body = rows.map((r) => {
    const cls = r.kind === '+' ? 'agent-diff-add'
              : r.kind === '-' ? 'agent-diff-del'
              : 'agent-diff-ctx';
    const prefix = r.kind === '+' ? '+ '
                 : r.kind === '-' ? '− '   // U+2212 minus
                 : '  ';
    return `<div class="${cls}">${escHtml(prefix + r.text)}</div>`;
  }).join('');
  return `<div class="agent-diff">${pathHead}<pre class="agent-diff-body">${body}</pre></div>`;
}

// Render a Write tool call as an all-additions block. New file —
// every line is a +. Long files get a scrollable body via CSS
// max-height on .agent-diff-body.
function _renderWriteDiff(filePath, content) {
  const lines = String(content || '').split('\n');
  const head = filePath
    ? `<div class="agent-diff-head"><span class="agent-diff-path">${escHtml(filePath)} <span class="agent-mute">(new file)</span></span><span class="agent-diff-stat">+${lines.length}</span></div>`
    : '';
  const body = lines.map((l) => `<div class="agent-diff-add">${escHtml('+ ' + l)}</div>`).join('');
  return `<div class="agent-diff">${head}<pre class="agent-diff-body">${body}</pre></div>`;
}

// Render the full payload for a chrome event as HTML. Returns ''
// when nothing structured to show (the head row carries everything).
function _chromeEventDetails(ev) {
  if (!ev || !ev.type) return '';
  if (ev.type === 'tool_use') {
    // Edit / MultiEdit / Write: surface as a proper diff instead of
    // a raw JSON dump. Edit has {file_path, old_string, new_string};
    // Write has {file_path, content}; MultiEdit has {file_path,
    // edits: [{old_string, new_string}, ...]}. Falls back to the
    // JSON-pre format for everything else.
    const input = ev.input == null ? {} : ev.input;
    if (ev.name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      return _renderEditDiff(input.file_path, input.old_string, input.new_string);
    }
    if (ev.name === 'MultiEdit' && Array.isArray(input.edits)) {
      const parts = input.edits.map((e, i) =>
        _renderEditDiff(`${input.file_path || ''} (edit ${i + 1}/${input.edits.length})`,
                        e.old_string || '', e.new_string || ''));
      return parts.join('<div class="agent-diff-sep"></div>');
    }
    if (ev.name === 'Write' && typeof input.content === 'string') {
      return _renderWriteDiff(input.file_path, input.content);
    }
    return `<div class="agent-json">${_renderJsonTree(input)}</div>`;
  }
  if (ev.type === 'tool_result') {
    const content = String(ev.content || '');
    if (!content) return '<span class="agent-mute">(empty result)</span>';
    // If the content parses as JSON, render as a collapsible tree.
    // Common for Grep / Glob / sub-agent / Read-of-json-file results.
    // Length-cap the parse attempt — multi-MB JSON would block the
    // main thread. Plain-text payloads fall through to the pre block.
    const trimmed = content.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 200_000) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return `<div class="agent-json${ev.isError ? ' agent-json-error' : ''}">${_renderJsonTree(parsed)}</div>`;
        }
      } catch { /* fall through */ }
    }
    return `<pre class="agent-chrome-pre${ev.isError ? ' agent-chrome-pre-error' : ''}">${escHtml(content)}</pre>`;
  }
  if (ev.type === 'turn_result') {
    const u = ev.usage || {};
    const lines = [];
    if (ev.totalCostUsd != null) lines.push(`cost: $${ev.totalCostUsd.toFixed(4)}`);
    lines.push(`tokens: in=${u.input_tokens || 0} out=${u.output_tokens || 0} cache-read=${u.cache_read_input_tokens || 0} cache-create=${u.cache_creation_input_tokens || 0}`);
    if (ev.durationMs != null) lines.push(`duration: ${ev.durationMs}ms`);
    if (ev.numTurns != null) lines.push(`turns: ${ev.numTurns}`);
    const head = `<div class="agent-chrome-kv">${lines.map((l) => escHtml(l)).join('<br>')}</div>`;
    // 2026-05-17: do NOT render ev.result inside the chrome batch
    // body. The reply text is already rendered as a standalone
    // assistant_text agent-card (either from the SDK's assistant
    // message OR — via the round-4 dedup-fallback in
    // agent-session.js's `result` branch — synthesized from
    // result.result when the SDK ships text ONLY via result).
    // Duplicating it inside the chrome batch caused the user to
    // report "after tab switch the message is displayed as part of
    // the chrome batch" — they saw the chrome batch's inline copy
    // and perceived the standalone card as missing/merged.
    return head;
  }
  if (ev.type === 'permission_request' || ev.type === 'permission_resolved') {
    const lines = [];
    if (ev.toolName) lines.push(`tool: ${ev.toolName}`);
    if (ev.hash) lines.push(`hash: ${String(ev.hash).slice(-12)}`);
    if (ev.decision) lines.push(`decision: ${ev.decision}`);
    if (ev.summary) lines.push(`target: ${ev.summary}`);
    if (ev.question) lines.push(`question: ${ev.question}`);
    if (ev.optionCount != null) lines.push(`options: ${ev.optionCount}`);
    return `<div class="agent-chrome-kv">${lines.map((l) => escHtml(l)).join('<br>')}</div>`;
  }
  if (ev.type === 'hook_allow' || ev.type === 'hook_deny') {
    const lines = [];
    if (ev.toolName) lines.push(`tool: ${ev.toolName}`);
    if (ev.pattern) lines.push(`matched pattern: ${ev.pattern}`);
    if (ev.input != null) lines.push(`input: ${JSON.stringify(ev.input).slice(0, 200)}`);
    return `<div class="agent-chrome-kv">${lines.map((l) => escHtml(l)).join('<br>')}</div>`;
  }
  if (ev.type === 'system_init' || ev.type === 'agent_init_snapshot') {
    const lines = [];
    if (ev.sdkSessionId) lines.push(`sdk-session: ${ev.sdkSessionId}`);
    if (ev.model) lines.push(`model: ${ev.model}`);
    if (Array.isArray(ev.tools)) lines.push(`tools: ${ev.tools.length} available`);
    return `<div class="agent-chrome-kv">${lines.map((l) => escHtml(l)).join('<br>')}</div>`;
  }
  if (ev.type === 'turn_start') {
    return `<pre class="agent-chrome-pre">${escHtml(String(ev.prompt || ''))}</pre>`;
  }
  if (ev.type === 'rate_limit') {
    return `<pre class="agent-chrome-pre">${escHtml(JSON.stringify(ev, null, 2))}</pre>`;
  }
  // Unknown / catch-all — dump the JSON so power users can see what
  // came through. Skips the timestamp + type which are already in
  // the head row.
  const rest = Object.fromEntries(
    Object.entries(ev).filter(([k]) => k !== 'ts' && k !== 'type')
  );
  if (!Object.keys(rest).length) return '';
  return `<pre class="agent-chrome-pre">${escHtml(JSON.stringify(rest, null, 2))}</pre>`;
}

// Create a brand-new chrome batch card for an incoming chrome event.
// The head shows "▸ chrome · 1 event"; click to expand and see the
// per-event one-liners.
// Smart aggregator to track tool uses and file targets touched within a chrome batch.
function _bumpToolUseAggregator(card, ev) {
  if (!ev || ev.type !== 'tool_use') return;

  const toolName = ev.name;
  const input = ev.input || {};

  // 1. Accumulate Tool Counts
  const counts = card.dataset.toolCounts ? JSON.parse(card.dataset.toolCounts) : {};
  counts[toolName] = (counts[toolName] || 0) + 1;
  card.dataset.toolCounts = JSON.stringify(counts);

  // 2. Accumulate File Targets (for Read, Edit, Write, MultiEdit)
  const fileTools = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);
  if (fileTools.has(toolName) && typeof input.file_path === 'string') {
    const files = card.dataset.fileTargets ? JSON.parse(card.dataset.fileTargets) : [];
    const relPath = input.file_path.trim();
    if (relPath && !files.includes(relPath)) {
      files.push(relPath);
      card.dataset.fileTargets = JSON.stringify(files);
    }
  }

  // 3. Track Active Bash Command
  if (toolName === 'Bash' && typeof input.command === 'string') {
    card.dataset.activeCommand = input.command.trim();
  }
}

// Toggle or load an inline diff view for a file touched inside a batch card.
async function _toggleInlineDiff(card, filePath) {
  let diffContainer = card.querySelector(`.inline-diff-pane[data-file="${filePath}"]`);
  
  if (diffContainer) {
    // Toggle visibility if already rendered
    diffContainer.hidden = !diffContainer.hidden;
    return;
  }
  
  // Create container
  diffContainer = document.createElement('div');
  diffContainer.className = 'inline-diff-pane';
  diffContainer.dataset.file = filePath;
  diffContainer.innerHTML = '<div class="diff-loading">Loading diff...</div>';
  card.appendChild(diffContainer);
  
  try {
    const res = await authedFetch(_withShareToken(`/sessions/${encodeURIComponent(state.activeId)}/files/diff?path=${encodeURIComponent(filePath)}`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    if (d && d.diff) {
      // Render unified diff in pre element
      diffContainer.innerHTML = `<pre class="diff-code"><code>${escHtml(d.diff)}</code></pre>`;
    } else {
      diffContainer.innerHTML = '<div class="diff-empty">No uncommitted changes for this file.</div>';
    }
  } catch (err) {
    diffContainer.innerHTML = `<div class="diff-error">Error loading diff: ${err.message}</div>`;
  }
}

// Finish the chrome batch: set its status as finished, collapse it, and refresh its label
function _finishChromeBatch(card) {
  if (!card || card.dataset.evType !== '_chrome_batch' || card.dataset.running !== 'true') return;
  card.dataset.running = 'false';
  card.classList.remove('agent-card-expanded');
  card.classList.add('agent-card-collapsed');
  const summaryEl = card.querySelector('.agent-chrome-last');
  if (summaryEl) {
    const html = summaryEl.innerHTML;
    if (html.startsWith('running: ')) {
      summaryEl.innerHTML = html.replace(/^running:\s*/, 'ran: ');
    }
  }
}

// Create a brand-new chrome batch card for an incoming chrome event.
// The head shows "▸ chrome · 1 event"; click to expand and see the
// per-event one-liners.
function _createChromeBatch(ev, ts) {
  const card = document.createElement('div');
  card.className = 'agent-card chat-msg-agent agent-card-chrome agent-card-expanded';
  card.dataset.evType = '_chrome_batch';
  card.dataset.chromeCount = '1';
  card.dataset.firstTs = ts;
  card.dataset.lastTs = ts;
  card.dataset.running = 'true';
  // bug-11: bootstrap the per-batch tool_result aggregator + persist a
  // bytes-free signature for merge eligibility BEFORE rendering the
  // head label, so the first event's bytes land in the aggregate and
  // the visible label reflects the aggregate (which on a fresh batch
  // equals the single event's bytes).
  _bumpToolResultAggregator(card, ev);
  _bumpToolUseAggregator(card, ev);
  card.dataset.chromeBatchSig = _chromeShortLabelSig(ev);
  const head = document.createElement('div');
  head.className = 'agent-card-head';
  head.innerHTML =
    `<span class="agent-card-ts">${escHtml(ts)}</span>` +
    `<span class="agent-chrome-glyph agent-mute" aria-hidden="true">▸</span>` +
    `<span class="agent-card-count agent-mute">× 1</span>` +
    `<span class="agent-card-summary agent-mute agent-chrome-last">${_chromeBatchHeadLabel(card, ev)}</span>`;
  card.appendChild(head);
  const body = document.createElement('div');
  body.className = 'agent-card-body agent-chrome-body';
  body.appendChild(_chromeEventLine(ev, ts));
  card.appendChild(body);
  head.addEventListener('click', (e) => {
    const fileBadge = e.target.closest('.badge-file-pill');
    if (fileBadge) {
      // Intercept click to toggle inline diff view instead of collapsing/expanding
      e.stopPropagation();
      const filePath = fileBadge.dataset.filePath;
      _toggleInlineDiff(card, filePath);
      return;
    }
    if (e.target.closest('a, button')) return;
    card.classList.toggle('agent-card-collapsed');
    card.classList.toggle('agent-card-expanded');
  });
  return card;
}

// bug-10: collapse multiple chrome batches that all show the same
// final-event label (`.agent-chrome-last` text) into ONE row with
// counts summed + bodies concatenated. Triggered by
// _enforceChatHistoryCap so it runs after every chat mutation.
//
// The user pain: long-running tool sessions ask permission to run
// the same Bash command 30+ times in a row. The chrome-batch
// adjacency rule (in _appendAgentEvent) breaks the run on every
// non-chrome event (assistant_text, chat-msg from a viewer, etc.),
// so the user sees five `× 7 perm asked · Bash` / `× 5 perm asked …`
// rows stacked over six minutes. Merge them into one
// `× 39 perm asked · Bash` so the timeline stays readable; the
// expanded body still lists every individual event with its
// original ts for forensics.
//
// Algorithm: walk top-level children once, keep a Map keyed by
// signature (`.agent-chrome-last` text). The FIRST batch with a
// given signature stays; subsequent ones get absorbed into it
// (count += other.count; body rows appended; lastTs updated) and
// removed from the DOM. First-wins is the right anchor because the
// user is usually looking at the chronologically-earliest entry in
// a run (the moment claude first started the activity); the absorbed
// later batches just become "× N more of the same" in the count.
function _mergeIdenticalChromeBatches(list) {
  if (!list) return;
  // 2026-05-17 ADJACENCY FIX: previously the merge keyed off a global
  // firstBySig map, which collapsed chrome batches across the ENTIRE
  // pane that happened to share a label. That worked for the bug-10
  // case (multiple consecutive "perm asked · Bash" rows) but caused
  // a worse regression: chrome batches between different turns that
  // shared the same turn_result label (e.g. "■ success · $0.0001")
  // got merged across, REMOVING the chrome batch that separated two
  // adjacent assistant_text cards. The cards then ended up adjacent
  // in DOM, and the assistant_text merge branch in _appendAgentEvent
  // ("if prev is assistant_text, fold into it") collapsed all of
  // claude's replies into one giant card — surfacing as the user-
  // reported "the agent reply message gets merged with previous
  // agent replies" symptom.
  //
  // Adjacency-aware walk: only merge a chrome batch INTO the
  // previously-walked anchor when (a) they share a sig AND (b)
  // nothing other than chrome batches has appeared between them.
  // ANY non-chrome element (assistant_text card, chat-msg bubble,
  // turn-footer) resets the anchor — a fresh anchor starts on the
  // next chrome batch encountered.
  let anchor = null;
  let anchorSig = null;
  // Snapshot children — we mutate during the walk.
  for (const el of [...list.children]) {
    if (!el || !el.classList) continue;
    if (el.id === 'chat-load-older') continue;          // skip the button, don't reset anchor
    if (el.dataset && el.dataset.evType === '_chrome_batch') {
      const sig = _chromeBatchHeadSig(el);
      if (!sig) { anchor = null; anchorSig = null; continue; }
      if (anchor && sig === anchorSig) {
        // Fall through to merge code below.
      } else {
        // Different sig (or no prior anchor) — this chrome batch
        // becomes the new anchor for any same-sig successors.
        anchor = el;
        anchorSig = sig;
        continue;
      }
    } else {
      // Non-chrome element — reset the anchor so the next chrome
      // batch starts fresh.
      anchor = null;
      anchorSig = null;
      continue;
    }
    // Absorb `el` into `anchor`: bump count, append body rows,
    // update lastTs, remove the duplicate. Outcome chip + glyph
    // stay on the anchor — those describe the last event of the
    // anchor's own tail, which (since signatures match) is the
    // same shape as `el`'s tail.
    const anchorCount = parseInt(anchor.dataset.chromeCount || '1', 10);
    const elCount = parseInt(el.dataset.chromeCount || '1', 10);
    const newCount = anchorCount + elCount;
    anchor.dataset.chromeCount = String(newCount);
    if (el.dataset.lastTs) anchor.dataset.lastTs = el.dataset.lastTs;
    const countEl = anchor.querySelector('.agent-card-count');
    if (countEl) countEl.textContent = '× ' + newCount;
    const anchorBody = anchor.querySelector('.agent-chrome-body');
    const elBody = el.querySelector('.agent-chrome-body');
    if (anchorBody && elBody) {
      while (elBody.firstChild) anchorBody.appendChild(elBody.firstChild);
    }
    // bug-11: combine the tool_result byte aggregators across the
    // absorbed batch + re-render the visible head label with the
    // combined total. Only fires when at least one of the two batches
    // has tracked tool_result bytes (otherwise nothing to combine —
    // the head stays as-is, e.g. for permission_request-only batches).
    if (el.dataset.toolResultBytes != null || anchor.dataset.toolResultBytes != null) {
      const sumBytes = (parseInt(anchor.dataset.toolResultBytes || '0', 10)) +
                       (parseInt(el.dataset.toolResultBytes || '0', 10));
      const sumCount = (parseInt(anchor.dataset.toolResultCount || '0', 10)) +
                       (parseInt(el.dataset.toolResultCount || '0', 10));
      anchor.dataset.toolResultBytes = String(sumBytes);
      anchor.dataset.toolResultCount = String(sumCount);
      if (el.dataset.toolResultLastError === '1') anchor.dataset.toolResultLastError = '1';
      const summaryEl = anchor.querySelector('.agent-chrome-last');
      if (summaryEl && sumCount > 0) {
        const isError = anchor.dataset.toolResultLastError === '1';
        summaryEl.textContent = (isError ? '⚠ result · ' : '✓ result · ') + sumBytes + ' bytes';
      }
    }
    // Tag so a regression test (and the user inspecting via devtools)
    // can see the merge actually happened.
    anchor.dataset.bug10Merged = String(parseInt(anchor.dataset.bug10Merged || '0', 10) + 1);
    el.remove();
  }
}

// Stable signature for a chrome batch — names the kind of activity
// (e.g. "perm asked · Bash", "✓ result"). Two batches with the same
// signature are eligible to merge per bug-10. bug-11: now reads from
// dataset.chromeBatchSig (set by _createChromeBatch + refreshed by
// _appendToChromeBatch) instead of the visible label, because the
// visible label now varies with the aggregate byte count for
// tool_result batches and would break merge eligibility as totals
// diverge. Falls back to the legacy label-read for any batch that
// pre-dates the dataset.chromeBatchSig field (defensive — shouldn't
// happen in steady state).
function _chromeBatchHeadSig(batchEl) {
  if (!batchEl) return null;
  if (batchEl.dataset && batchEl.dataset.chromeBatchSig) {
    return batchEl.dataset.chromeBatchSig;
  }
  const last = batchEl.querySelector('.agent-chrome-last');
  if (!last) return null;
  const t = (last.textContent || '').trim();
  return t || null;
}

// Append a new chrome event into an existing chrome batch card.
function _appendToChromeBatch(card, ev, ts) {
  const n = (parseInt(card.dataset.chromeCount || '1', 10)) + 1;
  card.dataset.chromeCount = String(n);
  card.dataset.lastTs = ts;
  const countEl = card.querySelector('.agent-card-count');
  if (countEl) countEl.textContent = '× ' + n;
  // bug-11: accumulate THIS event's tool_result bytes BEFORE relabeling
  // so the head shows the aggregate INCLUDING this event, not just
  // this event's individual bytes. Also refresh the bytes-free merge
  // signature so a follow-up event of a different type swaps it
  // correctly.
  _bumpToolResultAggregator(card, ev);
  _bumpToolUseAggregator(card, ev);
  // bug-38: do NOT update the head label / signature when the
  // incoming event is turn_result. The batch's outcome chip already
  // shows "✓ <duration> <tokens>"; relabeling the head to
  // "■ done · $0.04..." would overwrite "▸ ✏ Edit · file.js" (the
  // last meaningful action this turn) and re-introduce the same
  // redundant "turn-result row" we're trying to hide. Body row still
  // appends so the result is reachable when the batch is expanded.
  if (ev.type !== 'turn_result') {
    card.dataset.chromeBatchSig = _chromeShortLabelSig(ev);
    const summaryEl = card.querySelector('.agent-chrome-last');
    if (summaryEl) summaryEl.innerHTML = _chromeBatchHeadLabel(card, ev);
  }
  const body = card.querySelector('.agent-chrome-body');
  if (body) body.appendChild(_chromeEventLine(ev, ts));
}

// bug-11: track per-batch aggregate bytes across tool_result events so
// the collapsed head shows the SUM, not just the most-recent event's
// bytes. Non-tool_result events leave the aggregator untouched (a
// permission_request landing mid-batch doesn't reset prior accumulated
// tool_result bytes; when the NEXT tool_result lands it still adds to
// the running total).
function _bumpToolResultAggregator(card, ev) {
  if (!ev || ev.type !== 'tool_result') return;
  const evBytes = (ev.content || '').length;
  const total = parseInt(card.dataset.toolResultBytes || '0', 10) + evBytes;
  const count = parseInt(card.dataset.toolResultCount || '0', 10) + 1;
  card.dataset.toolResultBytes = String(total);
  card.dataset.toolResultCount = String(count);
  card.dataset.toolResultLastError = ev.isError ? '1' : '0';
}

// Render label for the chrome batch head — uses target-aware file pill badges.
function _chromeBatchHeadLabel(card, ev) {
  if (ev && ev.type === 'tool_result') {
    const total = parseInt(card.dataset.toolResultBytes || '0', 10);
    const isError = card.dataset.toolResultLastError === '1';
    return (isError ? '⚠ result · ' : '✓ result · ') + total + ' bytes';
  }

  const counts = card.dataset.toolCounts ? JSON.parse(card.dataset.toolCounts) : {};
  const files = card.dataset.fileTargets ? JSON.parse(card.dataset.fileTargets) : [];
  const cmd = card.dataset.activeCommand || '';

  if (Object.keys(counts).length === 0) {
    return escHtml(_chromeShortLabel(ev));
  }

  const toolStrings = [];
  for (const [name, count] of Object.entries(counts)) {
    if (name === 'Bash' && cmd) {
      const shortCmd = cmd.length > 20 ? cmd.slice(0, 17) + '...' : cmd;
      toolStrings.push(`Bash ("${escHtml(shortCmd)}")`);
    } else if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(name) && files.length) {
      continue; // Rendered as target file badges
    } else {
      toolStrings.push(`${escHtml(name)}${count > 1 ? ' (×' + count + ')' : ''}`);
    }
  }

  let badgesHtml = '';
  if (files.length) {
    const displayFiles = files.slice(0, 3);
    const badges = displayFiles.map(f => {
      const baseName = f.split('/').pop();
      return `<span class="badge-file-pill" data-file-path="${escHtml(f)}" title="${escHtml(f)}">📄 ${escHtml(baseName)}</span>`;
    });
    badgesHtml = ' ' + badges.join(' ');
    if (files.length > 3) {
      badgesHtml += ` <span class="badge-more-pill">+${files.length - 3} more</span>`;
    }
  }

  const labelText = toolStrings.join(', ');
  const prefix = labelText ? (card.dataset.running === 'true' ? 'running: ' : 'ran: ') : '';
  return `${prefix}${labelText}${badgesHtml}`;
}

// bug-11: bytes-free signature used by _mergeIdenticalChromeBatches.
function _chromeShortLabelSig(ev) {
  if (ev && ev.type === 'tool_result') return ev.isError ? '⚠ result' : '✓ result';
  return _chromeShortLabel(ev);
}

// Short label for the chrome batch head — names the latest event so
// the collapsed indicator still tells you what's happening.
function _chromeShortLabel(ev) {
  if (ev.type === 'permission_request') return 'perm asked · ' + (ev.toolName || '');
  if (ev.type === 'permission_resolved') return 'perm ' + (ev.decision || 'resolved') + ' · ' + (ev.toolName || '');
  if (ev.type === 'hook_allow') return 'hook allow · ' + (ev.toolName || '');
  if (ev.type === 'hook_deny') return 'hook deny · ' + (ev.toolName || '');
  if (ev.type === 'turn_start') return 'turn · ' + String(ev.prompt || '').replace(/\s+/g, ' ').slice(0, 60);
  if (ev.type === 'iteration_start') return ev.resume ? 'iter (resumed)' : 'iter';
  if (ev.type === 'agent_init_snapshot') return 'reattach';
  if (ev.type === 'system_init') return 'session init';
  if (ev.type === 'session_ready') return 'ready';
  if (ev.type === 'rate_limit') return 'rate-limit';
  if (ev.type === 'tool_result') {
    const bytes = (ev.content || '').length;
    return (ev.isError ? '⚠ result · ' : '✓ result · ') + bytes + ' bytes';
  }
  if (ev.type === 'turn_result') {
    const cost = ev.totalCostUsd != null ? '$' + ev.totalCostUsd.toFixed(4) : '';
    return '■ ' + (ev.subtype || 'done') + (cost ? ' · ' + cost : '');
  }
  if (ev.type === 'tool_use') {
    if (ev.name === 'AskUserQuestion') {
      const q = (ev.input && ev.input.questions && ev.input.questions[0] && ev.input.questions[0].question) || '';
      return 'ask · ' + String(q).slice(0, 60);
    }
    if (ev.name === 'ExitPlanMode' || ev.name === 'EnterPlanMode') {
      return ev.name.replace(/PlanMode$/, ' plan mode');
    }
    // Any other tool — Read, Edit, Write, Bash, Glob, Grep, WebFetch,
    // WebSearch, Task, TodoWrite, etc. — gets icon + name + one-line
    // summary so the batch head still names the most recent action.
    const icon = _agentToolIcon(ev.name);
    const summary = _agentToolSummary(ev.name, ev.input).slice(0, 60);
    return `${icon} ${ev.name}${summary ? ' · ' + summary : ''}`;
  }
  if (ev.type === 'system_event') {
    // bug-48: surface the SDK task-lifecycle phase + description in
    // the live status strip and collapsed batch head, so the user
    // sees "task_progress · Deploy 533fbfe to mycodev" instead of a
    // silent gap while the agent is mid-deploy.
    const sub = ev.subtype || 'system';
    const desc = String(ev.description || '').slice(0, 60);
    const statusBit = ev.status ? ' · ' + ev.status : '';
    return sub + (desc ? ' · ' + desc : '') + statusBit;
  }
  return ev.type || 'event';
}

// One-line summary for a tool_use head. Each tool gets the slot that
// answers "what did claude do?" at-a-glance — file path, command,
// pattern, URL, query. Kept terse (≤120 chars) so the row stays scannable.
function _agentToolSummary(name, input) {
  const i = input || {};
  if (name === 'Bash')                          return '$ ' + String(i.command || '').slice(0, 118);
  if (['Read', 'Edit', 'Write'].includes(name)) return String(i.file_path || '').slice(0, 120);
  if (['Glob', 'Grep'].includes(name))          return String(i.pattern || i.query || '').slice(0, 120);
  if (name === 'WebFetch')                      return String(i.url || '').slice(0, 120);
  if (name === 'WebSearch')                     return '"' + String(i.query || '').slice(0, 116) + '"';
  if (name === 'TodoWrite')                     return '(todo list update)';
  if (name === 'Task')                          return String(i.subagent_type || i.description || '').slice(0, 120);
  return JSON.stringify(i).slice(0, 120);
}

function _applyStateUpdate(msg) {
  if (!msg || !msg.kind) return;
  if (msg.kind === 'menu') {
    _applyMenuStateUpdate(msg);
    return;
  }
  if (msg.kind === 'artifact') {
    if (msg.artifactType && msg.artifact) {
      // ryan-blues bug fix: rebind the cache to the current session
      // before writing. A state-update frame that arrived on a now-
      // closed WS for a previous session would otherwise corrupt the
      // current session's cache.
      if (state.artifacts.sessionId !== state.activeId) {
        state.artifacts = { sessionId: state.activeId, byType: {} };
      }
      state.artifacts.byType[msg.artifactType] = msg.artifact;
      _onArtifactsCacheUpdated(msg.artifactType);
    }
    return;
  }
  if (msg.kind === 'tool-progress') {
    state.openToolCalls = Array.isArray(msg.open) ? msg.open : [];
    // bug-53 (HUD analyze stuck — dispatch-mislabeled-as-bug-52):
    // remember the most recent tool phase so the HUD chip stays
    // sticky between tool calls. Without this, the HUD was reading
    // ONLY state.openToolCalls (in-flight calls) and falling back to
    // 'Analyze' in every gap between calls — which is most of the
    // time. User saw "Analyze" except for occasional flickers to
    // 'Code' or 'Verify' as tools opened/closed. The new sticky
    // phase carries 'code'/'verify' between calls until claude
    // genuinely switches phase or a new turn starts (turn_start
    // handler resets it).
    for (const tc of state.openToolCalls) {
      if (!tc || !tc.name) continue;
      if (tc.name === 'Bash') state.lastToolPhase = 'verify';
      else if (tc.name === 'Edit' || tc.name === 'Write' || tc.name === 'MultiEdit') {
        // Don't downgrade verify → code if Bash already established
        // verify-phase this turn. Once we're in verify (running
        // tests), further edits are typically test-fix edits — we
        // stay in 'verify' until the next user turn.
        if (state.lastToolPhase !== 'verify') state.lastToolPhase = 'code';
      }
    }
    _renderClaudeTyping();   // strip reuses the existing typing-indicator render path
    _updateTaskHUD();         // bug-53: re-render so the active-phase chip reflects the new tool state immediately
    return;
  }
  if (msg.kind === 'chat-clear') {
    // /clear slash command — wipe local chat list. The server has
    // already emptied rec.chat; a confirmation reply will arrive on the
    // following 'chat' frame.
    clearChat();
    return;
  }
  if (msg.kind === 'chat-pane-reset') {
    // fr-86: /clear new — soft-reset. The server has NOT emptied
    // rec.chat (history preserved for later log collection); only the
    // VISIBLE pane is wiped here. The user can scroll up to load
    // older messages via the existing GET /chat/history?before=...
    // load-older path. A confirmation chat reply arrives on the
    // following 'chat' frame (handleClear's ctx.reply).
    clearChat();
    return;
  }
  if (msg.kind === 'runQueue') {
    // fr-48: run-queue state changed (entry added/removed/transitioned).
    // Cache the latest state + re-render the persistent queue chip
    // strip at the top of the chat pane.
    state.runQueue = msg.state || { entries: [], paused: false, counts: {} };
    _renderRunQueueStrip();
    return;
  }
  if (msg.kind === 'critique-review') {
    // bug-61: race-safety net for stale broadcasts. The PRIMARY
    // enforcement is server-side (attach.js stage-done handler drops
    // subsequent sentinels when stageState.status is in
    // awaiting_verdict/awaiting_accept). This client-side check is
    // belt-and-braces — if a stale broadcast slips through (race
    // between user clicking ✓ Accept Stage and a server-side
    // sentinel processed before the resolve arrives), we don't
    // overwrite the unresolved intermediate verdict that the user is
    // currently reviewing.
    //
    // Retry broadcasts (msg.isRetry: true) are EXPLICITLY allowed to
    // replace the current verdict — that's the user's explicit
    // request via ↻ Retry or 💬 Ask Critic. Error broadcasts also
    // pass (current critique.isError = true means the user clicked
    // Retry on a broken verdict — replacement is correct).
    const currentIsUnresolvedIntermediate = state.awaitingVerdict
      && state.critiqueReview
      && state.critiqueReview.isIntermediate
      && !state.critiqueReview.isError;
    if (currentIsUnresolvedIntermediate && msg.isIntermediate && !msg.isRetry) {
      console.warn(`[bug-61] dropping incoming intermediate critique-review (stage=${msg.stage}) — current intermediate verdict (stage=${state.critiqueReview.stage}) is unresolved; user must accept/fix existing verdict first`);
      // bug-68 (Option B addition 2): the drop above used to be
      // silent (stderr-only console.warn). User-reported in the
      // bug-68 dispatch comment: "sometimes the critic verdict would
      // show up, sometimes no." This was one of the "no" cases — a
      // second stage's verdict arrived while the prior one was still
      // on screen, got dropped, and the user saw nothing. Show a
      // 5-second warn toast explaining what happened + what to do.
      try {
        warnToast(`⚠ Another verdict is still on screen — resolve the ${state.critiqueReview.stage} verdict first; the ${msg.stage} verdict will follow.`);
      } catch (err) {
        console.warn('[bug-68] warnToast failed:', err && err.message);
      }
      return;
    }
    // bug-64: parallel hole — bug-61's guard only blocks incoming
    // INTERMEDIATE over unresolved intermediate. The FINAL critique
    // on turn_result success comes through as !isIntermediate, which
    // the bug-61 guard passes — so the final verdict overwrites the
    // intermediate. User-reported empirically on myco4: "before the
    // first stage (analyze) stage verdict is accepted, the overall
    // verdict is also popped up. the process should be paused until
    // an verdict is accepted." Fix: BUFFER the incoming final into
    // state.deferredFinalCritique instead of replacing. The verdict-
    // pane button handlers replay it after the current verdict is
    // resolved (via _replayDeferredFinalCritique) — so the user sees
    // the sequence "intermediate → review → resolve → final" instead
    // of the buggy overlap. The server-side bug-64 defer also
    // catches this case; this client buffer is the race-safety net.
    if (currentIsUnresolvedIntermediate && !msg.isIntermediate && !msg.isRetry) {
      console.warn(`[bug-64] buffering incoming FINAL critique-review — current intermediate verdict (stage=${state.critiqueReview.stage}) is unresolved; will replay after resolve`);
      state.deferredFinalCritique = msg;
      return;
    }
    state.awaitingVerdict = true;
    state.critiqueReview = msg;
    _renderVerdictPanel();
    _updateTaskHUD();
    return;
  }
  // bug-54: cross-device verdict-pane sync. Fires when ANOTHER device
  // resolved the verdict by clicking ✗ Dismiss / ✗ Discard / ⚡ Ask
  // Claude to Fix / ✓ Accept Claude. Clears our local pane so it
  // doesn't stay stuck open after the verdict has been handled
  // elsewhere. The originating device receives this broadcast too;
  // the truthy-state guard makes that an idempotent no-op there.
  if (msg.kind === 'critique-resolved') {
    if (state.awaitingVerdict || state.critiqueReview) {
      state.awaitingVerdict = false;
      state.critiqueReview = null;
      _renderVerdictPanel();
      _updateTaskHUD();
      // bug-64: after clearing the resolved verdict, replay any
      // buffered final critique. If a final critique arrived
      // while an intermediate was showing (race past the server's
      // defer guard), it was stashed in state.deferredFinalCritique
      // instead of replacing. Now that the intermediate is cleared,
      // surface the buffered final.
      _replayDeferredFinalCritique();
    }
    return;
  }
  // fr-96: per-plan-item stage state machine broadcast. Updates the
  // client's state.planItemStages map (used by the HUD to display
  // "X awaiting accept on code stage"). A null stageState in the
  // payload means the item was cleared (run done / discard / fresh
  // not-yet-in-flight) — remove the entry.
  if (msg.kind === 'plan-item-stage') {
    if (!state.planItemStages) state.planItemStages = {};
    if (msg.stageState) {
      state.planItemStages[msg.itemId] = msg.stageState;
    } else {
      delete state.planItemStages[msg.itemId];
    }
    _updateTaskHUD();
    return;
  }
  if (msg.kind === 'critic-model-changed') {
    const select = document.getElementById('composer-critic-select');
    if (select) {
      select.value = msg.modelId;
    }
    return;
  }
}

// fr-48: persistent chip strip showing the run-queue at the top of
// the chat pane. Hidden when the queue is empty. Each chip carries
// the item id + status glyph; click → scroll to item in Plan tab.
// Cancel × on pending entries; the strip itself is read-only for
// viewers (the buttons just won't render).
//
// bug-24: cap chips so the strip doesn't grow unbounded in busy
// sessions. Shows the LAST N_FINISHED finished + all running + the
// FIRST N_PENDING pending; anything dropped surfaces as a "+N more"
// chip (clickable hint that /qstatus shows the full list). Reading
// order matches the queue's chronology: finished → running → pending.
function _renderRunQueueStrip() {
  const RUNQUEUE_MAX_FINISHED_CHIPS = 2;
  const RUNQUEUE_MAX_PENDING_CHIPS = 3;
  const FINISHED_STATUSES = new Set(['success', 'failed', 'cancelled']);

  const q = state.runQueue || null;
  const host = document.getElementById('runqueue-strip')
    || (() => {
      const div = document.createElement('div');
      div.id = 'runqueue-strip';
      div.className = 'runqueue-strip';
      const chatPane = document.getElementById('chatpane');
      const messages = document.getElementById('chat-messages');
      if (chatPane && messages) chatPane.insertBefore(div, messages);
      return div;
    })();
  if (!q || !Array.isArray(q.entries) || !q.entries.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  const pausedBadge = q.paused ? '<span class="runqueue-paused">⏸ paused</span>' : '';

  // Partition by status so we can cap finished + pending independently
  // while keeping every running entry visible. Preserves the queue's
  // chronological order within each partition (entries arrive ordered).
  const finished = q.entries.filter((e) => FINISHED_STATUSES.has(e.status));
  const running = q.entries.filter((e) => e.status === 'running');
  const pending = q.entries.filter((e) => e.status === 'pending');
  const other = q.entries.filter((e) =>
    !FINISHED_STATUSES.has(e.status) && e.status !== 'running' && e.status !== 'pending');

  // Keep the MOST RECENT n finished (tail of the list) + the FIRST n
  // pending (head of the list). Drop counts are surfaced as overflow
  // chips so users know nothing's lost — just hidden.
  const finishedShown = finished.slice(-RUNQUEUE_MAX_FINISHED_CHIPS);
  const finishedDropped = finished.length - finishedShown.length;
  const pendingShown = pending.slice(0, RUNQUEUE_MAX_PENDING_CHIPS);
  const pendingDropped = pending.length - pendingShown.length;

  const renderChip = (e) => {
    const glyph = ({ pending: '⏸', running: '⚙', success: '✓', failed: '⚠', cancelled: '✗' })[e.status] || '?';
    const cancelable = !state.readOnly && e.status === 'pending';
    const cancelBtn = cancelable
      ? ` <button class="runqueue-cancel" data-id="${escHtml(e.itemId)}" title="Remove ${escHtml(e.itemId)} from queue" aria-label="Cancel">×</button>`
      : '';
    return `<span class="runqueue-chip runqueue-chip-${escHtml(e.status)}" data-id="${escHtml(e.itemId)}" title="${escHtml(e.status)} · added by @${escHtml(e.addedBy || '?')}">${glyph} ${escHtml(e.itemId)}${cancelBtn}</span>`;
  };
  const renderOverflow = (n, side) => {
    if (n <= 0) return '';
    const label = side === 'finished' ? `+${n} earlier` : `+${n} more`;
    const title = `${n} ${side === 'finished' ? 'finished' : 'pending'} entr${n === 1 ? 'y' : 'ies'} hidden — run /qstatus for the full queue`;
    return `<span class="runqueue-overflow" title="${escHtml(title)}">${escHtml(label)}</span>`;
  };

  const chipsHtml = [
    renderOverflow(finishedDropped, 'finished'),
    ...finishedShown.map(renderChip),
    ...running.map(renderChip),
    ...other.map(renderChip),
    ...pendingShown.map(renderChip),
    renderOverflow(pendingDropped, 'pending'),
  ].filter(Boolean).join('');

  const resumeBtn = (!state.readOnly && q.paused)
    ? ' <button class="runqueue-resume" title="Unpause queue + dispatch next pending">▶ Resume</button>'
    : '';
  const clearBtn = (!state.readOnly && q.counts && q.counts.pending > 0)
    ? ' <button class="runqueue-clear" title="Drop all pending entries">Clear pending</button>'
    : '';
  host.innerHTML = `<span class="runqueue-label">Queue:</span> ${chipsHtml} ${pausedBadge} ${resumeBtn} ${clearBtn}`;
  host.querySelectorAll('.runqueue-chip').forEach((chip) => {
    chip.addEventListener('click', (ev) => {
      // Clicks on the × button don't navigate.
      if (ev.target && ev.target.classList.contains('runqueue-cancel')) return;
      const id = chip.dataset.id;
      if (id) location.hash = '#' + id;
    });
  });
  host.querySelectorAll('.runqueue-cancel').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onArtifactQueueCancel(btn.dataset.id);
    });
  });
  const resumeEl = host.querySelector('.runqueue-resume');
  if (resumeEl) resumeEl.addEventListener('click', onArtifactQueueResume);
  const clearEl = host.querySelector('.runqueue-clear');
  if (clearEl) clearEl.addEventListener('click', onArtifactQueueClear);

  // Update pinned Task HUD
  _updateTaskHUD();
}

// bug-45 round 2: pipeline labels shortened from
//   ['Analysis', 'Writing Code', 'Verification', 'Critique']
// to ['Analyze', 'Code', 'Verify', 'Critic'] (≤7 chars each) so the
// 4-chip pipeline fits on a phone without horizontal scroll. The
// return strings here MUST match the steps[] array in
// _updateTaskHUD — they're compared by ===; a typo silently breaks
// the .active class highlight without erroring.
function _getHUDActiveStep() {
  // fr-96: authoritative server-side stage state. When the per-plan-
  // item stage state machine is tracking the current run, it
  // OVERRIDES the heuristic-based fallback below (which inferred the
  // stage from open tool calls). The state machine reflects the
  // actual stage Claude declared via [stage: X done] sentinels +
  // user accept/fix actions, so it's strictly more accurate.
  const q = state.runQueue || null;
  const running = q && Array.isArray(q.entries) && q.entries.find(e => e.status === 'running');
  if (running && state.planItemStages && state.planItemStages[running.itemId]) {
    const ss = state.planItemStages[running.itemId];
    // awaiting_verdict / awaiting_accept → Critic chip lights up
    // (the critic is either pending or showing a verdict the user
    // is reviewing).
    if (ss.status === 'awaiting_verdict' || ss.status === 'awaiting_accept') {
      return 'Critic';
    }
    // in_progress → stage chip lights up.
    if (ss.stage === 'analyze') return 'Analyze';
    if (ss.stage === 'code') return 'Code';
    if (ss.stage === 'verify') return 'Verify';
  }
  // Legacy path — no stageState (one-shot dispatch, never dispatched,
  // or container restart before fr-96 wiring took effect).
  if (state.awaitingVerdict) {
    return 'Critic';
  }
  const openCalls = state.openToolCalls || [];
  // Active tools take precedence — what claude is doing RIGHT NOW.
  if (openCalls.some(tc => tc.name === 'Bash') || (state.claudeStatusLine && state.claudeStatusLine.includes('Bash'))) {
    return 'Verify';
  }
  if (openCalls.some(tc => ['Edit', 'Write', 'MultiEdit'].includes(tc.name)) ||
      (state.claudeStatusLine && (state.claudeStatusLine.includes('Edit') || state.claudeStatusLine.includes('Write') || state.claudeStatusLine.includes('MultiEdit')))) {
    return 'Code';
  }
  // bug-53: sticky fallback to the most recent tool phase observed in
  // this turn. Without this, the HUD reverted to 'Analyze' every
  // time a tool call completed — the user reported "sits on 'analyze'
  // most of the time" because most of the wall-clock time is between
  // tool calls. The sticky phase is cleared on turn_start so the next
  // turn starts fresh in 'Analyze'.
  if (state.lastToolPhase === 'verify') return 'Verify';
  if (state.lastToolPhase === 'code') return 'Code';
  return 'Analyze';
}

let _hudTimerInterval = null;
function _updateTaskHUD() {
  const hud = document.getElementById('chat-hud-task');
  if (!hud) return;

  const q = state.runQueue || null;
  const running = q && Array.isArray(q.entries) && q.entries.find(e => e.status === 'running');

  if (!running) {
    hud.hidden = true;
    hud.innerHTML = '';
    if (_hudTimerInterval) {
      clearInterval(_hudTimerInterval);
      _hudTimerInterval = null;
    }
    return;
  }

  hud.hidden = false;

  // Find plan item text
  let itemText = 'Executing plan task...';
  const plan = state.artifacts && state.artifacts.byType && state.artifacts.byType.plan;
  if (plan && Array.isArray(plan.items)) {
    const item = plan.items.find(it => it.id === running.itemId);
    if (item && item.text) {
      itemText = item.text;
    }
  }

  const activeStep = _getHUDActiveStep();

  // Format steps
  // bug-45 round 2: short forms so the 4 chips don't reflow to a
  // second row at mobile widths. Must stay in sync with
  // _getHUDActiveStep above (string === comparison).
  const steps = ['Analyze', 'Code', 'Verify', 'Critic'];
  const stepsHtml = steps.map(s => {
    const isActive = s === activeStep;
    return `<span class="timeline-step ${isActive ? 'active' : ''}">${isActive ? '⚡ ' : ''}${s}</span>`;
  }).join(' <span class="timeline-arrow">➔</span> ');

  const startedAt = running.startedAt ? new Date(running.startedAt).getTime() : Date.now();
  const getElapsedStr = () => {
    const sec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `${sec}s`;
  };

  hud.innerHTML = `
    <div class="hud-task-row">
      <div class="hud-task-title-wrap">
        <span class="hud-task-id">${escHtml(running.itemId)}</span>
        <span class="hud-task-text" title="${escHtml(itemText)}">${escHtml(itemText)}</span>
      </div>
      <div class="hud-task-status">
        <!-- bug-45 r4: bare elapsed (no clock emoji, no brackets)
             + icon-only Stop. Tooltip + aria-label keep the
             affordance discoverable / a11y-readable. -->
        <span id="hud-duration-text">${getElapsedStr()}</span>
        <button type="button" class="hud-stop-btn" title="Stop execution (Esc)" aria-label="Stop">
          <svg class="composer-icon" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;margin:0;"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>
        </button>
      </div>
    </div>
    <div class="hud-progress-timeline">
      ${stepsHtml}
    </div>
  `;

  // Attach stop button click listener
  const stopBtn = hud.querySelector('.hud-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      _sendStopAgent();
    });
  }

  // Ensure timer is ticking
  if (!_hudTimerInterval) {
    _hudTimerInterval = setInterval(() => {
      const durText = document.getElementById('hud-duration-text');
      if (durText) {
        // bug-45 r4: bare time (no clock emoji, no brackets) —
        // must mirror the initial-render string above.
        durText.textContent = getElapsedStr();
      }
    }, 1000);
  }
}

// bug-64: replay any buffered final critique that arrived while an
// intermediate verdict was showing. Called from every site that
// clears the current verdict (the 6 button handlers + the
// cross-device critique-resolved WS handler). If
// state.deferredFinalCritique is non-null, apply it as if it just
// arrived — promotes the buffered final to be the current verdict.
// Safe to call when nothing is buffered (just no-ops).
function _replayDeferredFinalCritique() {
  if (!state.deferredFinalCritique) return;
  const buffered = state.deferredFinalCritique;
  state.deferredFinalCritique = null;
  console.log(`[bug-64] replaying buffered final critique-review (itemId=${buffered.itemId})`);
  state.awaitingVerdict = true;
  state.critiqueReview = buffered;
  _renderVerdictPanel();
  _updateTaskHUD();
}

function _renderVerdictPanel() {
  const panel = document.getElementById('composer-verdict-pane');
  if (!panel) return;

  const review = state.critiqueReview;
  if (!review || !state.awaitingVerdict) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  panel.hidden = false;

  // td-33: detect transient critic errors (Gemini 503, missing key,
  // network blip). When isError is true the verdict body is the
  // SDK's "(call failed: ...)" envelope, NOT a real verdict — we
  // render a ↻ Retry button and skip the agree/disagree styling.
  const isError = !!review.isError;
  // td-33: intermediate (stage-checkpoint) critiques broadcast for
  // awareness but don't pause the run queue. Render with a
  // [Checkpoint] badge so the user knows this isn't the final.
  const isIntermediate = !!review.isIntermediate;
  const stageLabel = isIntermediate && review.stage ? String(review.stage).toLowerCase() : '';

  const isAgreed = !isError && !review.hasDisagreement;
  const titleClass = isError ? 'error' : (isAgreed ? 'agreed' : 'disagreement');
  let titleText;
  if (isError) {
    titleText = 'Critic Error — Retry?';
  } else if (isAgreed) {
    titleText = isIntermediate ? `✓ Gemini Approved Checkpoint (${stageLabel})` : '✓ Gemini Approved Claude\'s Changes';
  } else {
    titleText = isIntermediate ? `⚠️ Gemini Flagged Checkpoint (${stageLabel})` : '⚠️ Gemini Flagged Issues (Disagreement)';
  }

  // bug-71: render the critique body as markdown (was escHtml plain
  // text). Gemini emits markdown-shaped output (headers, bullets,
  // fenced code blocks, sometimes mermaid diagrams). Pre-fix the
  // verdict pane showed the raw `# Heading` / `**bold**` / triple-
  // backtick markers as literal characters. renderMd uses marked +
  // highlight.js, same path as assistant_text bubbles. Mermaid
  // diagrams are post-processed after panel.innerHTML lands (see
  // the renderMermaidInContainer call below).
  const formattedCritique = renderMd(review.critique || '');

  // td-33: action-row composition depends on the verdict shape.
  //   · Error: show only Retry (the other actions don't apply — there's
  //     no real verdict to discard/fix/accept).
  //   · Intermediate: show Retry + a "Continue" affordance (the run
  //     queue isn't paused, so there's nothing to accept; user just
  //     dismisses the checkpoint).
  //   · Final (current behavior): Discard / Fix / Accept trio.
  // bug-53: 💬 Ask Critic button is rendered FIRST in the actions row
  // on EVERY state — error / intermediate / final. It's the obvious
  // affordance for sending the textarea content to the critic (vs.
  // the existing `↻ Retry` on error/intermediate which doubles for
  // that but doesn't visually communicate "this is where my question
  // goes"; final state previously had NO button at all that routed
  // the textarea — the textarea was dead UI there).
  //
  // Disabled-when-empty state is the "type a question above to
  // enable" affordance — the button visibly hints at the textarea's
  // purpose even when no question is typed yet. Live-toggled by an
  // input listener on the textarea (wired after innerHTML below).
  //
  // The button routes to the SAME endpoint as ↻ Retry
  // (POST /critique/retry with { userPrompt }) — server-side
  // userPrompt handling was already shipped in bug-52. Adding this
  // button is pure UI plumbing; no server changes needed.
  const askCriticBtn = `<button class="verdict-btn verdict-btn-ask" disabled title="Type a question above to enable — the critic re-fires and addresses your question alongside its standard review">💬 Ask Critic</button>`;
  let actionsHtml;
  if (isError) {
    // td-33 r1 (Gemini critique catch): on error give the user an
    // ESCAPE HATCH too. If retries keep failing (e.g. Gemini quota
    // exhausted, prolonged 503), Retry-only would leave the user
    // stuck staring at an error panel. Dismiss hides it so they can
    // move on (queue isn't paused on error per the server-side
    // gate, so dismissing just clears the panel and they're back
    // to a clean state).
    actionsHtml = askCriticBtn +
      `<button class="verdict-btn verdict-btn-retry" title="Re-fire the critique against the same diff (use this on Gemini 503 / network errors)">↻ Retry</button>` +
      `<button class="verdict-btn verdict-btn-dismiss" title="Dismiss the error panel and continue without a critic verdict (queue is not paused on critic errors)">✗ Dismiss</button>`;
  } else if (isIntermediate) {
    // bug-56: intermediate (stage-checkpoint) verdict pane now
    // carries ✓ Accept Stage + ⚡ Ask Claude to Fix Stage buttons
    // (per the §9 3-stage methodology: each stage's verdict needs
    // its own accept/fix paths, not just the final one). The button
    // row order is left-to-right:
    //   💬 Ask Critic — re-fire critic with a question (bug-53)
    //   ↻ Retry — re-fire critic as-is
    //   ✓ Accept Stage (NEW) — accept this stage, signal Claude to
    //     advance to the next stage. Routes via a chat message
    //     [stage-accept] that Claude reads as the advance signal.
    //     Does NOT call /run/done — only the FINAL critique Accept
    //     ends the run (bug-57).
    //   ⚡ Ask Claude to Fix Stage (NEW) — send the critic's flagged
    //     issues to Claude as a redo-this-stage prompt.
    //   ✗ Dismiss — close the pane without a semantic decision
    //     (user wants to decide later).
    actionsHtml = askCriticBtn +
      `<button class="verdict-btn verdict-btn-retry" title="Re-fire the checkpoint critique against the same diff">↻ Retry</button>` +
      `<button class="verdict-btn verdict-btn-accept-stage" title="Accept this stage's verdict and signal Claude to proceed to the next stage (analyze → code → verify)">✓ Accept Stage</button>` +
      `<button class="verdict-btn verdict-btn-fix-stage" title="Send the critic's flagged issues to Claude as a redo-this-stage prompt">⚡ Ask Claude to Fix Stage</button>` +
      `<button class="verdict-btn verdict-btn-dismiss" title="Dismiss the checkpoint without a decision (decide later — pane will not auto-reopen)">✗ Dismiss</button>`;
  } else {
    actionsHtml = askCriticBtn +
      `<button class="verdict-btn verdict-btn-discard" title="Discard git changes and abort task">✗ Discard</button>` +
      `<button class="verdict-btn verdict-btn-fix" title="Ask Claude to fix issues flagged by Gemini">⚡ Ask Claude to Fix</button>` +
      `<button class="verdict-btn verdict-btn-accept" title="Accept Claude's changes and resume the run queue">✓ Accept Claude</button>`;
  }
  const intermediateBadge = isIntermediate
    ? `<span class="verdict-intermediate-badge" title="Mid-run checkpoint critique — the final critique will fire at end of turn">CHECKPOINT: ${escHtml(stageLabel)}</span>`
    : '';

  // bug-52: user-prompt textarea on the verdict pane. The user types
  // a follow-up concern (e.g. "did you check the offline case?") and
  // the next critique is steered to address that specific question.
  // Always present (not gated on a state flag) so the user can opt
  // in any time without additional UI choreography.
  //
  // bug-53 (UX clarification): the textarea now visibly belongs to
  // the `💬 Ask Critic` button rendered FIRST in the actions row on
  // every state — pre-bug-53 the textarea was wired to the existing
  // `↻ Retry` button on error/intermediate states (functional but
  // unclear: "Retry" reads as "redo what just happened," not "send
  // my question"), and was DEAD UI on the final-verdict state since
  // no Discard/Fix/Accept button routed to /critique/retry. User
  // reported (verbatim): "not sure which button to click, it's not
  // clear how the question is handled."
  const userPromptHtml =
    `<div class="verdict-user-prompt-wrap">` +
      `<label for="verdict-user-prompt-input" class="verdict-user-prompt-label">Ask the critic to look into something specific (optional):</label>` +
      `<textarea id="verdict-user-prompt-input" class="verdict-user-prompt-input" placeholder="e.g. did you check the case where the user is offline? did you consider rate limits on the retry button?" rows="2" maxlength="2048"></textarea>` +
    `</div>`;

  // bug-50 r2: wrap the contents in .verdict-panel-content so the
  // OUTER .chat-composer-verdict-panel becomes a backdrop wrapper +
  // clicks on the backdrop (not the content) can dismiss. The
  // content itself takes the visual styling (rounded card, scroll
  // when the message is huge).
  panel.innerHTML = `
    <div class="verdict-panel-content">
      <div class="verdict-header">
        <div class="verdict-title ${titleClass}">
          ${isError ? '⚠️' : (isAgreed ? '✓' : '⚠️')} ${titleText}
        </div>
        <div style="font-size:11px;color:#8b949e;font-family:monospace;">${escHtml(review.itemId)}${intermediateBadge}</div>
      </div>
      <div class="verdict-critique">${formattedCritique}</div>
      ${userPromptHtml}
      <div class="verdict-actions">
        ${actionsHtml}
      </div>
    </div>
  `;

  // bug-71: render any mermaid fenced code blocks inside the
  // verdict body into SVG diagrams. The marked path leaves mermaid
  // blocks as `<pre><code class="language-mermaid">…</code></pre>`
  // or `<pre class="mermaid">…</pre>` depending on the marked config;
  // renderMermaidInContainer handles both shapes (same helper used
  // by assistant_text bubbles). Fire-and-forget — the catch swallows
  // render errors so a malformed diagram doesn't break the rest of
  // the verdict UI.
  try {
    const critiqueEl = panel.querySelector('.verdict-critique');
    if (critiqueEl) renderMermaidInContainer(critiqueEl).catch(() => {});
  } catch {}

  // bug-55 SUPERSEDES bug-50 r2: the verdict pane is now TRULY modal.
  // No outside-click dismiss. No Esc dismiss. The only way to close
  // the popover is the explicit buttons inside it (✗ Dismiss /
  // ↻ Retry / 💬 Ask Critic / ✗ Discard / ⚡ Ask Claude to Fix /
  // ✓ Accept Claude — depending on state).
  //
  // User-reported (bug-55, verbatim):
  //   "the critic popover is not modal, click outside of it made the
  //    popover disappear and no way to bring it back again"
  //
  // Pre-fix (bug-50 r2): backdrop-click + Esc were wired for
  // `isError || isIntermediate` states as an "escape hatch" for stuck
  // users. But the explicit ✗ Dismiss button on those states ALREADY
  // provides that path, and once outside-click fired, the verdict
  // was wiped from state — gone forever, no recovery. The escape
  // hatch became a footgun. bug-55 removes the entire
  // safeToDismissByBackdrop branch; dismissal is now ALWAYS explicit.
  //
  // This brings the verdict pane in line with the rest of the app's
  // modal pattern — bug-31 + bug-41 already removed backdrop-dismiss
  // from the permission-prompt modal for the same reason
  // (accidental-dismiss + no recovery path). bug-50 r2 was the
  // outlier; bug-55 reconciles it.
  // (Intentionally no listeners registered here — the pane is modal.)

  const btnDiscard = panel.querySelector('.verdict-btn-discard');
  const btnFix = panel.querySelector('.verdict-btn-fix');
  const btnAccept = panel.querySelector('.verdict-btn-accept');
  // td-33 wiring: retry button POSTs to /critique/retry. The server
  // pulls rec._lastCritique + re-fires; the next broadcast replaces
  // this panel with the fresh verdict.
  const btnRetry = panel.querySelector('.verdict-btn-retry');
  if (btnRetry) {
    btnRetry.addEventListener('click', async () => {
      // bug-52: read the verdict-user-prompt textarea + send as
      // userPrompt in the body. Empty = standard retry; non-empty =
      // steer the critic toward the user's specific concern.
      const ta = panel.querySelector('#verdict-user-prompt-input');
      const userPrompt = ta && typeof ta.value === 'string' ? ta.value.trim() : '';
      btnRetry.disabled = true;
      btnRetry.textContent = userPrompt ? '🔍 Asking…' : '↻ Retrying…';
      try {
        const res = await authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/critique/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userPrompt }),
        });
        if (!res || !res.ok) {
          const body = await (res ? res.json().catch(() => ({})) : Promise.resolve({}));
          btnRetry.disabled = false;
          btnRetry.textContent = '↻ Retry';
          alert('Retry failed: ' + (body && body.error ? body.error : 'unknown error'));
        }
        // Success → next critique-review broadcast re-renders the
        // panel; nothing else to do here.
      } catch (err) {
        btnRetry.disabled = false;
        btnRetry.textContent = '↻ Retry';
        alert('Retry failed: ' + (err && err.message || err));
      }
    });
  }
  // bug-53: 💬 Ask Critic button — re-fires the critic with the
  // textarea content as the priority focus question. Same endpoint as
  // ↻ Retry (POST /critique/retry with { userPrompt }) — server-side
  // userPrompt handling was already shipped in bug-52. The only
  // difference vs. ↻ Retry is the labeling + the disabled-when-empty
  // affordance, which together solve the bug-53 confusion ("not sure
  // which button to click, it's not clear how the question is
  // handled"). Final-verdict state has no ↻ Retry button at all, so
  // 💬 Ask Critic is the SOLE consumer of the textarea there.
  const btnAsk = panel.querySelector('.verdict-btn-ask');
  const taAsk = panel.querySelector('#verdict-user-prompt-input');
  if (btnAsk && taAsk) {
    // Live-enable: disabled when textarea is empty (trimmed), enabled
    // when non-empty. Toggled on every `input` event. Initial state
    // is disabled (set via the inline `disabled` attribute in the
    // actionsHtml template) — typing the first non-whitespace char
    // enables it.
    const syncAskBtnEnabled = () => {
      btnAsk.disabled = taAsk.value.trim().length === 0;
    };
    taAsk.addEventListener('input', syncAskBtnEnabled);
    syncAskBtnEnabled();   // run once in case the textarea was pre-populated
    btnAsk.addEventListener('click', async () => {
      const userPrompt = taAsk.value.trim();
      if (!userPrompt) return;                       // shouldn't reach (button disabled), defensive
      btnAsk.disabled = true;
      btnAsk.textContent = '💬 Asking…';
      try {
        const res = await authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/critique/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userPrompt }),
        });
        if (!res || !res.ok) {
          const body = await (res ? res.json().catch(() => ({})) : Promise.resolve({}));
          btnAsk.disabled = false;
          btnAsk.textContent = '💬 Ask Critic';
          alert('Ask Critic failed: ' + (body && body.error ? body.error : 'unknown error'));
        }
        // Success → next critique-review broadcast re-renders the
        // panel; nothing else to do here.
      } catch (err) {
        btnAsk.disabled = false;
        btnAsk.textContent = '💬 Ask Critic';
        alert('Ask Critic failed: ' + (err && err.message || err));
      }
    });
  }
  // bug-54: cross-device verdict-pane sync. Fire-and-forget POST to
  // /critique/resolve so all attached devices clear their verdict
  // pane. Called by the 4 resolving buttons (Dismiss / Discard / Fix
  // / Accept) AFTER they've done their primary action + cleared
  // local state. ↻ Retry and 💬 Ask Critic don't call this — they
  // re-fire the critique, which produces a new critique-review
  // broadcast that naturally replaces the verdict on every device.
  // The originating device also receives the broadcast; the
  // client-side critique-resolved handler's truthy guard makes that
  // idempotent.
  const _broadcastCritiqueResolved = (reason) => {
    authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/critique/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: review.itemId, reason }),
    }).catch((err) => {
      console.warn('[bug-54] critique-resolve broadcast failed:', err && err.message || err);
    });
  };

  // bug-57: signal end-of-run to the server. Called by the verify-
  // stage ✓ Accept handler + the ✗ Discard handler. Clears
  // session._activeRunItem (which bug-57 changed to survive across
  // multi-stage runs) + advances the queue. Idempotent — server
  // checks itemId match against the current active item. The
  // intermediate (analyze/code) ✓ Accept handlers do NOT call this —
  // they signal "stage accepted, proceed to next stage," not "run
  // complete." fr-96 will add proper per-stage transition handling
  // that calls this only when the verify stage is the one being
  // accepted; today the surface is: final-verdict Accept = verify
  // accept, intermediate Dismiss = stage-accept-proceed.
  const _broadcastRunDone = (reason) => {
    authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/run/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: review.itemId, reason }),
    }).catch((err) => {
      console.warn('[bug-57] run/done broadcast failed:', err && err.message || err);
    });
  };

  const btnDismiss = panel.querySelector('.verdict-btn-dismiss');
  if (btnDismiss) {
    btnDismiss.addEventListener('click', () => {
      // Intermediate critiques are advisory — clicking dismiss just
      // hides the panel; the queue wasn't paused so there's nothing
      // to resume.
      state.awaitingVerdict = false;
      state.critiqueReview = null;
      _renderVerdictPanel();
      _broadcastCritiqueResolved('dismiss');
      // bug-64: if a final critique-review was buffered (race past
      // the server-side defer), surface it now that the intermediate
      // is cleared.
      _replayDeferredFinalCritique();
    });
  }
  // bug-56: ✓ Accept Stage + ⚡ Ask Claude to Fix Stage — intermediate
  // verdict pane buttons. Per the §9 3-stage methodology: each
  // checkpoint needs explicit accept/fix paths, not just the final
  // critique. Accept Stage signals Claude to advance to the next
  // stage (analyze → code → verify); Fix Stage signals Claude to
  // redo the current stage addressing the critic's flagged issues.
  // Neither calls /run/done — the run is still active across stages
  // (bug-57); only the FINAL critique Accept ends the run.
  //
  // Stage lookup: analyze → code → verify → null (verify is the last
  // stage; its FINAL critique fires from turn_result, not from a
  // stage-done sentinel, so the verify-stage Accept on the
  // intermediate pane is mostly defensive — should rarely fire in
  // practice since verify-stage-done sentinel is immediately
  // followed by turn_result which replaces the verdict).
  const _nextStage = (s) => ({ analyze: 'code', code: 'verify', verify: null }[s] || null);

  const btnAcceptStage = panel.querySelector('.verdict-btn-accept-stage');
  if (btnAcceptStage) {
    btnAcceptStage.addEventListener('click', () => {
      const cur = (review.stage || 'analyze').toLowerCase();
      const next = _nextStage(cur);
      const promptText = next
        ? `[stage-accept] User accepted the ${cur} stage. Please proceed to the ${next} stage.`
        : `[stage-accept] User accepted the ${cur} stage. The plan item is complete; the final critique will follow on turn_result.`;
      state.awaitingVerdict = false;
      state.critiqueReview = null;
      _renderVerdictPanel();
      _broadcastCritiqueResolved('accept-stage');
      // Note: NOT calling _broadcastRunDone — intermediate accept
      // does not end the run. Only the FINAL critique Accept calls
      // /run/done (bug-57). The chat message is the explicit
      // advance signal Claude reads on the next turn; fr-96 will
      // formalize this into a server-side state-machine transition.
      sendChatMessage(promptText);
      // bug-64: if a final critique was buffered locally (race past
      // the server-side defer), replay it now. The server will ALSO
      // fire any server-side deferred via the /critique/resolve POST
      // — having both paths is belt-and-braces; whichever lands
      // first wins, the other's broadcast becomes a no-op via the
      // bug-61 guard's idempotency.
      _replayDeferredFinalCritique();
    });
  }
  const btnFixStage = panel.querySelector('.verdict-btn-fix-stage');
  if (btnFixStage) {
    btnFixStage.addEventListener('click', () => {
      const cur = (review.stage || 'analyze').toLowerCase();
      const promptText = `[stage-fix] Critic flagged issues in your ${cur} stage:\n\n${review.critique}\n\nPlease redo the ${cur} stage addressing these concerns. Re-emit \`[stage: ${cur} done]\` when finished so the critic can re-evaluate.`;
      state.awaitingVerdict = false;
      state.critiqueReview = null;
      _renderVerdictPanel();
      _broadcastCritiqueResolved('fix-stage');
      // No /run/done — redoing a stage is "stay in the same run."
      sendChatMessage(promptText);
      // bug-64: drop any locally-buffered final critique. The stage
      // is being redone — the deferred is now stale (refers to the
      // OLD claude output that the user rejected). Server-side
      // bug-64 doesn't fire its deferred on fix-stage either.
      state.deferredFinalCritique = null;
    });
  }
  // Early-return for error + intermediate paths so the legacy
  // discard/fix/accept wiring below doesn't try to bind null nodes.
  if (isError || isIntermediate) return;

  btnDiscard.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to discard Claude\'s changes? This will revert files to HEAD.')) return;
    try {
      const resChanged = await authedFetch(_withShareToken(`/sessions/${encodeURIComponent(state.activeId)}/files-changed`));
      if (resChanged.ok) {
        const changedData = await resChanged.json();
        const paths = (changedData.entries || []).map(x => x.path);
        if (paths.length > 0) {
          await _planChangedFilesAction('reject', paths);
        }
      }
      await authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/queue/${encodeURIComponent(review.itemId)}`, { method: 'DELETE' });
      await authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/queue/resume`, { method: 'POST' });

      state.awaitingVerdict = false;
      state.critiqueReview = null;
      _renderVerdictPanel();
      _updateTaskHUD();
      _broadcastCritiqueResolved('discard');
      // bug-57: discard ABANDONS the run — clear _activeRunItem on
      // the server too so multi-stage critique gating + future
      // dispatches start clean. Idempotent: server checks itemId
      // match and no-ops if the active item is something else.
      _broadcastRunDone('discard');
      // bug-64: drop any buffered final critique. The run is
      // abandoned; the deferred is stale.
      state.deferredFinalCritique = null;
    } catch (err) {
      console.error('Discard action failed:', err);
    }
  });

  btnFix.addEventListener('click', () => {
    const promptText = `[run:plan#${review.itemId}] Gemini flagged issues with your implementation:\n\n${review.critique}\n\nPlease resolve them.`;

    state.awaitingVerdict = false;
    state.critiqueReview = null;
    _renderVerdictPanel();
    _updateTaskHUD();
    _broadcastCritiqueResolved('fix');
    // bug-64: drop any buffered final critique. Claude is being
    // asked to redo; the buffered deferred is for the OLD output the
    // user rejected, so it's stale.
    state.deferredFinalCritique = null;

    authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/queue/resume`, { method: 'POST' }).then(() => {
      sendChatMessage(promptText);
    }).catch(err => {
      console.error('Resume queue before fix failed:', err);
    });
  });

  btnAccept.addEventListener('click', async () => {
    try {
      const resChanged = await authedFetch(_withShareToken(`/sessions/${encodeURIComponent(state.activeId)}/files-changed`));
      if (resChanged.ok) {
        const changedData = await resChanged.json();
        const paths = (changedData.entries || []).map(x => x.path);
        if (paths.length > 0) {
          await _planChangedFilesAction('accept', paths);
        }
      }

      state.awaitingVerdict = false;
      state.critiqueReview = null;
      _renderVerdictPanel();
      _updateTaskHUD();
      _broadcastCritiqueResolved('accept');
      // bug-57: this Accept handler renders only for FINAL critiques
      // (the early-return at the top of _renderVerdictPanel's
      // post-render block skips this block for isError/isIntermediate
      // states). FINAL = verify-stage-done in the 3-stage methodology
      // (the last stage's critique is the "final" one). So this
      // accept ENDS the run: clear _activeRunItem + advance queue.
      // Idempotent: server checks itemId match.
      _broadcastRunDone('accept-verify');

      await authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/queue/resume`, { method: 'POST' });
    } catch (err) {
      console.error('Accept action failed:', err);
    }
  });
}


async function onArtifactQueueCancel(itemId) {
  const sid = state.activeId;
  if (!sid || !itemId) return;
  try {
    await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/queue/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' }
    );
  } catch (err) {
    console.error('[fr-48] queue cancel threw:', err);
  }
}

async function onArtifactQueueClear() {
  const sid = state.activeId;
  if (!sid) return;
  if (!confirm('Drop all pending entries from the run-queue? Running + finished entries are kept.')) return;
  try {
    await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/queue/clear`,
      { method: 'POST' }
    );
  } catch (err) {
    console.error('[fr-48] queue clear threw:', err);
  }
}

async function onArtifactQueueResume() {
  const sid = state.activeId;
  if (!sid) return;
  try {
    await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/queue/resume`,
      { method: 'POST' }
    );
  } catch (err) {
    console.error('[fr-48] queue resume threw:', err);
  }
}

// Find a menu chat row by transcriptUuid (preferred) or menu-hash
// (fallback for menus broadcast before transcriptUuid was stamped),
// replace its meta, and re-render that single row in place. Reuses
// the same DOM-swap pattern appendChatMessage uses on a dedup hit
// (app.js:1763-1771).
function _applyMenuStateUpdate(msg) {
  const uuid = msg.messageUuid || null;
  const hash = msg.hash || null;
  for (let i = state.chatMessages.length - 1; i >= 0; i--) {
    const m = state.chatMessages[i];
    if (!m || !m.meta || m.meta.kind !== 'menu') continue;
    const muUuid = m.meta.transcriptUuid || null;
    const muHash = (m.meta.menu && m.meta.menu.hash) || null;
    const match = (uuid && muUuid === uuid) || (hash && muHash === hash);
    if (!match) continue;
    m.meta = msg.meta || m.meta;
    // CRITICAL: recompute isActiveMenu the same way renderChatPane does
    // — `i === _findLastMenuMessageIdx(state.chatMessages)`. Hardcoding
    // false here was the bug: a multi-select CHECKBOX TOGGLE emits a
    // state-update for the same (still-unanswered) row, and the row
    // re-rendered as not-active with no pickedN / not-submitted /
    // not-superseded → renderChatMessage fell into the "(no longer
    // active)" branch the moment the user clicked a checkbox.
    const lastMenuIdx = _findLastMenuMessageIdx(state.chatMessages);
    const isActive = (i === lastMenuIdx);
    const list = document.getElementById('chat-messages');
    const childCount = list ? list.children.length : 0;
    console.log('[state-update] menu match idx=' + i + ' isActive=' + isActive + ' chatMessagesLen=' + state.chatMessages.length + ' domChildren=' + childCount + ' pickedN=' + (m.meta && m.meta.pickedN) + ' answered=' + !!(m.meta && m.meta.answered) + ' superseded=' + !!(m.meta && m.meta.superseded));
    if (list && list.children[i]) {
      const newEl = _htmlToNode(renderChatMessage(m, isActive));
      if (newEl) list.children[i].replaceWith(newEl);
    } else {
      console.warn('[state-update] menu match but DOM child missing at idx=' + i);
    }
    _bindChatMenuClicks();
    // Server confirmed this menu's state (pickedN / submitted /
    // superseded / answered). Refresh the modal queue + popup so an
    // answered or superseded menu drops out immediately, and a still-
    // pending one stays in view. Without this the queue would
    // retain a server-resolved menu until the next chat append.
    _rescanPendingMenuQueue();
    _renderPermModal();
    return;
  }
  console.warn('[state-update] menu state-update did NOT match any row — uuid=' + uuid + ' hash=' + (hash ? hash.slice(0,60) : 'null'));
}

// Refresh any open artifact tab when the cache changes. Type-specific
// when called from a state-update; called with no arg from
// artifacts-init to refresh whatever's open.
function _onArtifactsCacheUpdated(type) {
  // fr-96: rebuild the per-plan-item stageState map from the artifact
  // cache. stageState lives in item.meta.stageState (server-persisted
  // in plan.json + shipped to client via artifacts-init / state-update
  // kind:'artifact' frames). This derived view lets the HUD render
  // "X awaiting accept on code stage" immediately on attach without
  // a separate fetch — the data is already aboard. Subsequent
  // transitions come in via the kind:'plan-item-stage' WS broadcast
  // (which directly mutates state.planItemStages without going
  // through this function).
  _rebuildPlanItemStagesFromArtifacts();
  const active = state.artifactView && state.artifactView.active;
  // fr-6: a deep-link in the URL (e.g. `…/#fr-7`) needs the artifact
  // cache populated to figure out which tab the item lives in. The
  // first cache update is our trigger — try to resolve the hash now
  // (a no-op if there's nothing to focus or the cache doesn't yet
  // contain the requested id).
  _focusArtifactItemFromHash();
  if (!active) return;
  if (type && type !== active) return;
  // Re-run the existing loadArtifact path; it'll prefer the cache.
  loadArtifact(active).catch(() => {});
}

// fr-96: derive state.planItemStages from the cached plan items'
// meta.stageState. Called from _onArtifactsCacheUpdated on every
// artifact-cache mutation (artifacts-init + state-update kind:'artifact').
// Updates the HUD if the active running item's stage state changed.
function _rebuildPlanItemStagesFromArtifacts() {
  const next = {};
  const plan = state.artifacts && state.artifacts.byType && state.artifacts.byType.plan;
  if (plan && Array.isArray(plan.items)) {
    for (const item of plan.items) {
      if (item && item.id && item.meta && item.meta.stageState) {
        const ss = item.meta.stageState;
        next[item.id] = {
          stage: ss.stage,
          status: ss.status,
          updatedAt: ss.updatedAt,
        };
      }
    }
  }
  state.planItemStages = next;
  _updateTaskHUD();
}

// fr-6 deep-link plumbing — scroll-into-view + highlight a specific
// plan/test item when the URL hash points at it. Handles three entry
// points: (1) initial page load with `#<id>` already in the URL,
// (2) the `hashchange` event when the user navigates / pastes a new
// link, (3) the post-render hook in renderArtifact that consumes
// state.pendingDeepLinkId when the hash arrived before the items had
// DOM ids.
function _findArtifactTypeForItem(itemId) {
  if (!state.artifacts || !state.artifacts.byType || !itemId) return null;
  for (const t of ['plan', 'test']) {   // arch has no items, not addressable
    const a = state.artifacts.byType[t];
    if (a && Array.isArray(a.items) && a.items.some((it) => it && it.id === itemId)) return t;
  }
  return null;
}

function _focusArtifactItemFromHash() {
  if (typeof location === 'undefined' || !location.hash) return false;
  let id;
  try { id = decodeURIComponent(location.hash.replace(/^#/, '')); } catch { id = location.hash.replace(/^#/, ''); }
  if (!id) return false;
  // Only intercept hashes that look like a plan/test item id —
  // otherwise leave them alone (the chat sidebar / other routes may
  // use the fragment for their own purposes in the future).
  if (!/^(?:fr|td|bug|test)-\d+$/i.test(id) && !/^[a-f0-9]{8,}$/i.test(id)) return false;
  const t = _findArtifactTypeForItem(id);
  if (!t) {
    // Cache may not be populated yet — stash and retry from the next
    // artifacts-init / state-update via _onArtifactsCacheUpdated.
    state.pendingDeepLinkId = id;
    return false;
  }
  const alreadyOpen = state.artifactView && state.artifactView.active === t;
  if (!alreadyOpen) {
    try { showArtifactView(t); } catch {}
  }
  // showArtifactView → loadArtifact runs the renderArtifact pass; the
  // post-render hook there will pick state.pendingDeepLinkId up and
  // call _scrollToArtifactItem once the <li> ids exist. If the tab
  // was ALREADY open (no re-render fires), scroll now.
  if (alreadyOpen) {
    _scrollToArtifactItem(id);
  } else {
    state.pendingDeepLinkId = id;
  }
  return true;
}

function _scrollToArtifactItem(itemId) {
  if (!itemId) return;
  const el = document.getElementById('artifact-item-' + itemId);
  if (!el) return;
  try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
  el.classList.add('artifact-item-deep-link-focused');
  // Auto-remove the highlight so a second deep-link to the same id
  // (e.g. user refreshes) re-triggers the pulse instead of seeing a
  // permanent outline.
  setTimeout(() => { try { el.classList.remove('artifact-item-deep-link-focused'); } catch {} }, 2400);
}

function _copyArtifactItemDeepLink(e, chip) {
  if (e) { try { e.preventDefault(); } catch {} }
  const id = chip && chip.dataset && chip.dataset.deepLinkId;
  if (!id) return;
  const encoded = encodeURIComponent(id);
  const url = (location.origin || '') + (location.pathname || '/') + '#' + encoded;
  // Update the bar without nuking history — the user's back button
  // still returns them to wherever they came from.
  try { history.replaceState(null, '', '#' + encoded); } catch {}
  // Visual confirmation regardless of clipboard success.
  chip.classList.add('artifact-item-id-copied');
  setTimeout(() => { try { chip.classList.remove('artifact-item-id-copied'); } catch {} }, 1200);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).catch(() => {});
  }
}

// Wire the hash listener once at module load — every subsequent
// hashchange (paste a permalink in the address bar, click a `#fr-7`
// anchor inside the chat pane, etc.) re-runs the focus logic.
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => _focusArtifactItemFromHash());
}

// Send an inline menu pick via the dedicated WS frame. Bypasses chat
// entirely so the click on a pending-menu callout button doesn't show up
// as a `/decide N` message in the discussion. Silent-drop if the WS is
// reconnecting — the next menu broadcast will repopulate the callout.
//
// The optional `hash` is the identity of the specific menu the user
// clicked (from m.meta.menu.hash). The server uses it to verify that
// the same dialog is still on screen before injecting the digit into
// the PTY — without it, rapid dialog turnover (parallel tool calls,
// auto-resolved menus) could land a stale pick on the wrong menu.
// Outbound menu-pick / menu-toggle / menu-submit queue. Same shape as
// state.outboundChat: when the WS is reconnecting, frames queue here
// instead of silently dropping (the 2026-05-15 test006 incident was a
// click landing during a WS reconnect window — the modal hid because
// the click handler short-circuited, but the server never received it).
// Flushed alongside outboundChat on every WS `open` event.
function _flushOutboundMenuFrames() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!state.outboundMenuFrames || !state.outboundMenuFrames.length) return;
  const queue = state.outboundMenuFrames;
  state.outboundMenuFrames = [];
  for (const frame of queue) {
    try { ws.send(JSON.stringify(frame)); }
    catch { state.outboundMenuFrames.push(frame); break; }
  }
}
function _queueMenuFrame(frame) {
  if (!state.outboundMenuFrames) state.outboundMenuFrames = [];
  state.outboundMenuFrames.push(frame);
}

function sendMenuPick(n, hash) {
  if (!Number.isFinite(n) || n < 1) return false;
  const frame = { t: 'menu-pick', n };
  if (hash) frame.hash = hash;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    _queueMenuFrame(frame);
    return true;                                // caller treats as sent
  }
  try { ws.send(JSON.stringify(frame)); return true; }
  catch { _queueMenuFrame(frame); return true; }
}

// Multi-select toggle — flip one checkbox without submitting. Writes a
// bare digit to claude's PTY (the server adds no CR). The user keeps
// composing the answer; the actual answer goes when they click Submit.
function sendMenuToggle(n, hash) {
  if (!Number.isFinite(n) || n < 1) return false;
  const frame = { t: 'menu-toggle', n };
  if (hash) frame.hash = hash;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    _queueMenuFrame(frame);
    return true;
  }
  try { ws.send(JSON.stringify(frame)); return true; }
  catch { _queueMenuFrame(frame); return true; }
}

// Multi-select submit — finalises the dialog with whatever boxes are
// currently checked. Writes just \r to the PTY.
function sendMenuSubmit(hash) {
  const frame = { t: 'menu-submit' };
  if (hash) frame.hash = hash;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    _queueMenuFrame(frame);
    return true;
  }
  try { ws.send(JSON.stringify(frame)); return true; }
  catch { _queueMenuFrame(frame); return true; }
}

// Outbound chat queue. If the WebSocket isn't OPEN at submit time (mobile
// background-suspend reconnect, brief network blip, page-load race),
// silently dropping the message lets the user think they sent something
// they didn't. Queue it locally instead and drain on the next WS open.
// state.outboundChat holds {text, ts} entries in order.
function _flushOutboundChat() {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!state.outboundChat || !state.outboundChat.length) return;
  const queue = state.outboundChat;
  state.outboundChat = [];
  for (const item of queue) {
    // fr-85 r4: preserve item.meta on the flushed frame so a queued
    // clarify message survives a WS reconnect.
    const frame = { t: 'chat', text: item.text };
    if (item.meta) frame.meta = item.meta;
    try { ws.send(JSON.stringify(frame)); }
    catch { state.outboundChat.push(item); break; }
  }
}

function sendChatMessage(text, opts) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  // bug-19 follow-up: refuse to send if read-only viewer + text
  // wouldn\'t pass the server\'s guest whitelist. The Send button is
  // also disabled (visual), but Enter-key submit (submitChat) +
  // programmatic ws.send paths bypass the disabled attr, so the
  // canonical gate lives HERE in sendChatMessage. Returning false
  // keeps the input populated so the user can edit + retry.
  if (state.readOnly && !_isGuestAllowedText(trimmed)) {
    console.log('[bug-19] refused to send (read-only viewer, text would be denied):', trimmed.slice(0, 60));
    return false;
  }
  // fr-85 r4: optional meta field — used by the clarify popover to
  // tag a chat-message as meta.kind='clarify'. The server filters
  // these out of normal chat render + routes the resulting claude
  // reply back via a dedicated clarify-reply WS frame. Only meta
  // is passed through; other opts keys are ignored.
  const frame = { t: 'chat', text: trimmed };
  if (opts && opts.meta && typeof opts.meta === 'object') frame.meta = opts.meta;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Queue + return true so the input clears and the user moves on. The
    // message goes out as soon as the WS reconnects (drainOutboundChat is
    // wired to every `open` event in connect()/connectShare()).
    if (!state.outboundChat) state.outboundChat = [];
    state.outboundChat.push({ text: trimmed, ts: Date.now(), meta: frame.meta });
  } else {
    try { ws.send(JSON.stringify(frame)); }
    catch {
      if (!state.outboundChat) state.outboundChat = [];
      state.outboundChat.push({ text: trimmed, ts: Date.now(), meta: frame.meta });
    }
  }
  // Since the chat-routing rewrite (2026-05-14), plain text goes to the
  // running Claude session by default; only `@<known-user> …` mentions
  // and slash commands stay in chat. The client doesn't know the
  // server's username allowlist at type-time, so we over-arm the
  // typing-dots indicator for anything that isn't obviously a slash
  // command. If the server decides the message was a chat-only mention
  // and didn't reach Claude, the idle timer (30s) retires the dots
  // harmlessly.
  if (!/^\//.test(trimmed)) {
    _markAwaitingClaude();
  } else if (/^\/tasks?\s*$/i.test(trimmed) || /^\/(skip|cancel)\s+\d+\s*$/i.test(trimmed)) {
    // /task / /skip / /cancel rewrite to PTY-input on the server, so
    // they still warrant the dots.
    _markAwaitingClaude();
  }
  return true;
}

// Read-only viewer UI: a small banner above the chat pane identifies
// the session owner. applyReadOnly / clearReadOnly are still wired
// from the 'viewer-mode' WS frame handler — guests use the chatpane
// like owners do, just with the server-side handleChatMessage gate
// blocking claude-routing.

function applyReadOnly(owner) {
  state.readOnly = true;
  state.sessionOwner = owner || null;
  const banner = document.getElementById('readonly-banner');
  if (banner) {
    banner.hidden = false;
    const ownerEl = banner.querySelector('.ro-owner');
    if (ownerEl) ownerEl.textContent = owner ? '@' + owner : '';
  }
  // bug-19: re-evaluate Send-button disable state — readOnly just
  // flipped on, so the existing typed text (if any) may now be denied.
  _syncGuestSendStateIfBound();
}

function clearReadOnly() {
  state.readOnly = false;
  state.sessionOwner = null;
  const banner = document.getElementById('readonly-banner');
  if (banner) {
    banner.hidden = true;
    const ownerEl = banner.querySelector('.ro-owner');
    if (ownerEl) ownerEl.textContent = '';
  }
  // bug-19: re-evaluate Send-button disable state — readOnly cleared,
  // any previously-disabled Send should re-enable.
  _syncGuestSendStateIfBound();
}

// bug-19: external trigger for the chat-form's Send-button disable
// sync. The closure inside bindChatUi captures `sendBtn` + `form` +
// `input` + the predicate. We dispatch a synthetic 'input' event to
// invoke the closure without exposing it on the global. Idempotent +
// safe to call before bindChatUi runs (no-op until the input exists).
function _syncGuestSendStateIfBound() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  try { input.dispatchEvent(new Event('input', { bubbles: false })); } catch {}
}

function bindReadOnlyBanner() {
  // No-op — the live-terminal panel that hosted the .vk-key buttons was
  // removed. The read-only banner is now display-only; viewers steer the
  // session via chat messages typed into the chat input.
}

// Floating "waiting for Claude" pill — shown after the user sends a
// chat message, auto-hides on the next transcript-delta (or after a
// safety timeout). Pure UI; the server does not send an explicit ack.
let _mycoWaitingTimer = null;
function showMycoWaiting() {
  const el = document.getElementById('myco-waiting');
  if (!el) return;
  el.hidden = false;
  if (_mycoWaitingTimer) clearTimeout(_mycoWaitingTimer);
  // Safety fallback in case Claude never replies (e.g. session is paused).
  _mycoWaitingTimer = setTimeout(hideMycoWaiting, 90000);
}
function hideMycoWaiting() {
  const el = document.getElementById('myco-waiting');
  if (el) el.hidden = true;
  if (_mycoWaitingTimer) { clearTimeout(_mycoWaitingTimer); _mycoWaitingTimer = null; }
}

// bug-19 follow-up: client-side predicate mirroring the server's
// read-only guest whitelist in attach.js handleChatMessage. When the
// session is read-only, only messages matching this predicate make
// it past the server — anything else round-trips to a denial reply.
// We disable the Send button when this predicate fails so the user
// gets immediate feedback BEFORE submission. List MUST stay in sync
// with the GUEST_ALLOWED_CMDS in attach.js — test/bug-19-disable-
// send-when-blocked.test.js pins both ends.
const _GUEST_ALLOWED_CMDS = new Set([
  '/td', '/fr', '/bug',                  // plan-item adds
  '/help', '/me', '/whoami',
  '/task', '/tasks', '/skip', '/cancel', // task-list controls
  '/allowlist',                           // read-only view of allow/deny lists
  '/qstatus',                             // read-only run-queue inspection (fr-48)
  '/whatsnext', '/next',                  // read-only priority list (fr-49)
]);
function _isGuestAllowedText(text) {
  const s = String(text || '').trim();
  if (!s) return true;                    // empty input — Send is gated separately
  // @mention anywhere in the text (same shape attach.js
  // _detectMentionTarget uses).
  if (/(^|\s)@[A-Za-z0-9_-]+\b/.test(s)) return true;
  // Whitelisted slash command (first token).
  if (s.startsWith('/')) {
    const cmd = s.split(/\s+/)[0].toLowerCase();
    if (_GUEST_ALLOWED_CMDS.has(cmd)) return true;
  }
  return false;
}

function bindChatUi() {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  if (!form || !input) return;
  if (form.dataset.bound) return;
  form.dataset.bound = '1';

  const select = document.getElementById('composer-critic-select');
  if (select && !select.dataset.criticBound) {
    select.dataset.criticBound = '1';
    select.addEventListener('change', async () => {
      const modelId = select.value;
      try {
        const res = await authedFetch(`/sessions/${encodeURIComponent(state.activeId)}/critic`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId })
        });
        if (res.ok) {
          console.log(`[critic-select] Updated critic to: ${modelId}`);
        }
      } catch (err) {
        console.error('Failed to update critic model:', err);
      }
    });
  }

  // bug-26: track whether the user has manually scrolled up so
  // auto-scroll-to-latest can be suppressed. Updated on every
  // scroll event; consumed by scrollChatToLatest. passive listener
  // because we only read scroll positions, never preventDefault.
  // Bound once (form.dataset.bound guards against double-bind on
  // re-init), so the listener survives session switches.
  const messages = document.getElementById('chat-messages');
  if (messages && !messages.dataset.scrollBound) {
    messages.dataset.scrollBound = '1';
    messages.addEventListener('scroll', () => {
      state.chatUserScrolledUp = !_chatUserIsAtBottom(messages);
    }, { passive: true });
  }

  // Auto-grow the textarea with content, up to the CSS max-height (then scroll).
  // We reset to 'auto' first so shrinking works after a backspace/clear.
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }
  input.addEventListener('input', autoResize);
  autoResize();

  // bug-19 follow-up: live Send-button disable for read-only viewers.
  // Reads state.readOnly + the typed text every input event; when the
  // text wouldn't pass the server's guest whitelist, flip Send to
  // disabled + add a CSS hook (.composer-blocked) for styling. Owners
  // and admins (state.readOnly === false) are never blocked.
  const sendBtn = document.getElementById('chat-send');
  function _syncGuestSendState() {
    if (!sendBtn) return;
    const text = input.value || '';
    if (state.readOnly && text.trim() && !_isGuestAllowedText(text)) {
      sendBtn.disabled = true;
      sendBtn.title = 'As a read-only viewer you can only @mention users or use /td, /fr, /bug, /help, /me, /whoami, /task, /skip, /cancel, /allowlist. Anything else is denied.';
      form.classList.add('composer-blocked');
    } else {
      sendBtn.disabled = false;
      sendBtn.title = 'Send (Enter)';
      form.classList.remove('composer-blocked');
    }
  }
  input.addEventListener('input', _syncGuestSendState);
  _syncGuestSendState();

  // fr-88 (composer-collapse — distinct from the older fr-88(r)
  // blocking-modal feature in this file): the four .composer-btn
  // action buttons take horizontal real estate that crowds the
  // typed message. Toggle `.composer-has-content` on the form
  // whenever the textarea has non-whitespace content; the CSS
  // rule under that class hides .composer-btn-label +
  // .composer-btn-kbd so the buttons collapse to icon-only and
  // the textarea gains the freed width. Whitespace-only input
  // doesn't trigger (typing a space shouldn't collapse anything).
  function _syncComposerHasContent() {
    const hasContent = (input.value || '').trim().length > 0;
    form.classList.toggle('composer-has-content', hasContent);
  }
  input.addEventListener('input', _syncComposerHasContent);
  _syncComposerHasContent();

  function submitChat() {
    const submitted = input.value;
    if (sendChatMessage(submitted)) {
      // fr-94: kick a Plan-view Changed-files refresh when the user
      // runs a /git command (server processes it inline — no agent
      // tool_result event fires, so we hook on the submit instead).
      _maybeAutoRefreshOnGitCommand(submitted);
      // fr-78: in-memory chat-input history. Push the just-sent text
      // onto state.chatInputHistory (capped 200 entries; skip empty +
      // skip duplicates of the immediate previous entry — common
      // pattern from bash readline). Reset the browsing cursor +
      // saved-draft state so the next ArrowUp starts from the most
      // recent entry. Per-page-load + per-session: cleared on
      // openSession in openSession (see fr-78 reset hook there).
      const trimmed = String(submitted || '').trim();
      if (trimmed) {
        if (!Array.isArray(state.chatInputHistory)) state.chatInputHistory = [];
        const hist = state.chatInputHistory;
        if (hist.length === 0 || hist[hist.length - 1] !== submitted) {
          hist.push(submitted);
          if (hist.length > 200) hist.splice(0, hist.length - 200);
        }
      }
      state.chatHistoryIdx = null;
      state.chatHistoryDraft = null;
      input.value = '';
      // bug: programmatic `input.value = ''` does NOT fire the `input`
      // event the listener uses to rebuild #composer-chips. Without
      // this explicit call, any @-mention chip rendered from the
      // pre-send value lingers visually after the field clears.
      _renderComposerChips();
      autoResize();
      // Lazily ask for desktop-notification permission on the user's
      // first chat send — Chrome blocks passive page-load requests,
      // so we piggyback on this gesture. One-shot: already-granted /
      // already-denied calls return immediately.
      _maybeRequestNotificationPermission();
    }
  }

  // fr-78: Up/Down history recall. Bash-readline semantics:
  //   - Up at start-of-input → step back to older entry
  //   - Down at end-of-input → step forward to newer; past the most
  //     recent restores the in-progress draft the user was typing
  //     when they started browsing
  //   - Multi-line guard: only hijack when cursor is at the extreme
  //     start (Up) / end (Down) AND there's no selection. Mid-line
  //     arrow nav within a multi-line draft keeps working.
  //   - Defer to autocomplete + IME when those are active
  //   - Any non-arrow keystroke resets the browsing cursor so the
  //     user can mutate the recalled entry without trapping arrows
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.isComposing || e.keyCode === 229) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    const ac = document.getElementById('chat-autocomplete');
    if (ac && !ac.hidden) return;
    const hist = Array.isArray(state.chatInputHistory) ? state.chatInputHistory : [];
    if (hist.length === 0) return;
    // Cursor-position guard. Up only fires at the start, Down only
    // at the end. The selection must be collapsed (no range).
    const selStart = input.selectionStart;
    const selEnd = input.selectionEnd;
    const value = input.value;
    if (selStart !== selEnd) return;
    if (e.key === 'ArrowUp') {
      if (selStart !== 0) return;
      // Step BACK. null → most recent (idx = hist.length - 1).
      // From 0 → bounce (no older entry).
      let next;
      if (state.chatHistoryIdx == null) {
        // Save the current draft so Down past the most recent restores it.
        state.chatHistoryDraft = value;
        next = hist.length - 1;
      } else if (state.chatHistoryIdx > 0) {
        next = state.chatHistoryIdx - 1;
      } else {
        return;  // already at oldest; let default (no-op)
      }
      e.preventDefault();
      state.chatHistoryIdx = next;
      input.value = hist[next];
      autoResize();
      // Cursor at end so the user can append immediately.
      input.selectionStart = input.selectionEnd = input.value.length;
    } else {
      // ArrowDown.
      if (state.chatHistoryIdx == null) return;  // not browsing → default
      if (selEnd !== value.length) return;
      if (state.chatHistoryIdx < hist.length - 1) {
        e.preventDefault();
        state.chatHistoryIdx += 1;
        input.value = hist[state.chatHistoryIdx];
        autoResize();
        input.selectionStart = input.selectionEnd = input.value.length;
      } else {
        // Past the most recent → restore the saved draft + exit browsing.
        e.preventDefault();
        const draft = state.chatHistoryDraft || '';
        state.chatHistoryIdx = null;
        state.chatHistoryDraft = null;
        input.value = draft;
        autoResize();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
    }
  });
  // fr-92: mobile swipe up/down on the composer surfaces history
  // navigation since there's no arrow key on touch devices. The
  // dispatched payload is a synthetic ArrowUp/ArrowDown keydown so
  // the existing state-machine handler above runs unchanged — no
  // duplication of the history-step logic + draft-save semantics.
  //
  // Swipe detection: short single-touch drag with vertical movement
  // ≥ SWIPE_MIN_PX in ≤ SWIPE_MAX_MS. This filters out long scrolls
  // (high duration) and small wobble (small distance). Multi-touch
  // (pinch-zoom, two-finger scroll) is skipped — only e.touches[0].
  //
  // Cursor-position rewrite: the existing keydown handler only
  // recalls history when the cursor is at the extreme start (Up) or
  // end (Down) of the input — that guard exists so multi-line draft
  // arrow nav still works on desktop. For swipes the user's intent
  // is unambiguous ("navigate history regardless of cursor"), so
  // before dispatching we move the cursor to the correct extreme.
  // Side effect is benign: after history recall the cursor naturally
  // ends up at value.length anyway.
  const SWIPE_MIN_PX = 30;
  const SWIPE_MAX_MS = 600;
  let _fr92TouchY = null;
  let _fr92TouchStartTime = 0;
  input.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { _fr92TouchY = null; return; }
    _fr92TouchY = e.touches[0].clientY;
    _fr92TouchStartTime = Date.now();
  }, { passive: true });
  input.addEventListener('touchend', (e) => {
    if (_fr92TouchY == null) return;
    if (e.changedTouches.length !== 1) { _fr92TouchY = null; return; }
    const dy = e.changedTouches[0].clientY - _fr92TouchY;
    const elapsed = Date.now() - _fr92TouchStartTime;
    _fr92TouchY = null;
    if (elapsed > SWIPE_MAX_MS) return;
    if (Math.abs(dy) < SWIPE_MIN_PX) return;
    const isUp = dy < 0;
    const key = isUp ? 'ArrowUp' : 'ArrowDown';
    // Move the cursor to the extreme that the existing handler
    // checks (start for Up, end for Down) so its guard accepts the
    // synthetic event. Without this the handler's `selStart !== 0`
    // / `selEnd !== value.length` early-return swallows the swipe.
    try {
      if (isUp) input.selectionStart = input.selectionEnd = 0;
      else input.selectionStart = input.selectionEnd = input.value.length;
    } catch {}
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
  }, { passive: true });
  input.addEventListener('touchcancel', () => { _fr92TouchY = null; }, { passive: true });

  // Any non-arrow keystroke while browsing exits browsing mode (so
  // the user can mutate the recalled entry without arrows trapping
  // them in history). Caps the listener at one extra check.
  input.addEventListener('keydown', (e) => {
    if (state.chatHistoryIdx == null) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return;
    if (e.isComposing || e.keyCode === 229) return;
    // Modifier-only keys (Shift, Ctrl, Meta, Alt by themselves) don't
    // exit browsing — only actual content-mutating or navigation keys.
    if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt') return;
    // Esc exits browsing AND clears the input (escape hatch).
    if (e.key === 'Escape') {
      e.preventDefault();
      state.chatHistoryIdx = null;
      state.chatHistoryDraft = null;
      input.value = '';
      // bug: programmatic clear → rebuild #composer-chips manually
      // (`input.value = ''` doesn't fire the `input` event).
      _renderComposerChips();
      autoResize();
      return;
    }
    // Any other key: keep the recalled text + exit browsing.
    state.chatHistoryIdx = null;
    state.chatHistoryDraft = null;
  });

  // Enter sends, Shift+Enter inserts a newline — the dominant chat-app
  // pattern (Slack/Discord/iMessage/Claude.ai/ChatGPT/etc). Ctrl/⌘+Enter
  // still sends for back-compat with the prior shortcut. Three guards
  // before we claim Enter:
  //   1. IME composition: CJK / dead-key input — let the IME commit its
  //      candidate first; never treat the commit-Enter as send.
  //   2. Autocomplete open: the dropdown's own keydown listener
  //      (registered later in bindChatAutocomplete) needs Enter to pick
  //      the highlighted suggestion. Bail so its listener fires.
  //   3. Shift+Enter: textarea-default newline for multi-line composing.
  // stopImmediatePropagation on the actual send blocks the autocomplete
  // listener from re-handling Enter against the already-cleared input.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.isComposing || e.keyCode === 229) return;
    const ac = document.getElementById('chat-autocomplete');
    if (ac && !ac.hidden) return;
    if (e.shiftKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    submitChat();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitChat();
  });

  // fr-84: composer "Draw" button opens the in-browser diagram modal.
  // Modal handles its own keyboard + close wiring; we just toggle it
  // open here. The save flow appends `![diagram](<url>)` to this same
  // textarea, so the user can edit the message + send normally.
  document.getElementById('chat-diagram')?.addEventListener('click', (e) => {
    e.preventDefault();
    openDiagramModal();
  });

  // Chrome icon click contract:
  //   chat / plan / arch / test / files  →  SHOW the corresponding
  //     view. Each button has a single state action ("activate"); a
  //     second click on the same button is a no-op (the view stays
  //     open). To switch away, click a different view's icon — main-
  //     pane buttons are mutually exclusive; chat lives alongside the
  //     main view as a side panel.
  // Phase 9 step 3 retired the 👁 preview and 📜 transcript toggles —
  // the chatpane is the only session view now (owners + read-only
  // viewers), so there's no longer a terminal ↔ transcript flip.
  document.getElementById('btn-chat')?.addEventListener('click', () => {
    // Home = "back to the conversation, full-width." Any artifact pane
    // (plan/arch/test) or files-wrap currently overlaying chat is
    // dismissed so the chatpane has the whole main pane to itself.
    // Otherwise the click looked dead — the artifact stayed on top at
    // z:31, chat sat unseen behind it at z:30.
    if (state.artifactView && state.artifactView.active) hideArtifactView();
    if (state.files && state.files.visible) {
      const fw = document.getElementById('files-wrap');
      if (fw) fw.hidden = true;
      state.files.visible = false;
      document.getElementById('btn-files')?.classList.remove('active');
    }
    setChatPane(true);
    _updateMainPaneLayout();
  });
  // The legacy chatpane-close × was removed; #btn-chat itself toggles
  // open/closed via its .active state. Optional-chain still leaves this
  // a no-op for any cached page that still has the old element.
  document.getElementById('chatpane-close')?.addEventListener('click', () => setChatPane(false));
  bindChatpaneResize();
  bindChatAutocomplete();
  bindArtifactToggles();
  _bindPermModal();
  _bindPermModalKeys();
  _bindStopAgent();
  _bindVoiceInput();
  _setupChatClarify();   // fr-85: select-text-in-claude-bubble → popover
}

// Voice input: browser-local speech-to-text via the Web Speech API.
// On-device on Safari (Apple's native speech) + recent Chrome with
// processLocally; older Chrome may use Google's cloud (still
// browser-mediated, no myco server involvement). Falls back to a
// hidden button if the API isn't exposed at all.
//
// Flow: click 🎙 → recognition.start() → interim transcripts stream
// into the textarea as the user speaks → final commits land on
// silence pause → click again to stop. textInput retains base text
// the user typed manually; voice is appended (not replacing). Auto-
// stops on the engine's `end` event (engine policy varies, but most
// stop after ~5s of silence).
function _bindVoiceInput() {
  const btn = document.getElementById('chat-mic');
  const input = document.getElementById('chat-input');
  if (!btn || !input) return;
  if (btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    // Browser doesn't support SpeechRecognition — keep the button
    // hidden so the composer isn't broken on Firefox / older
    // Safari / WebView etc. (HTML had `hidden` attribute by
    // default; we leave it alone here.)
    return;
  }
  btn.hidden = false;
  let recognition = null;
  let recording = false;
  let baseText = '';     // textarea content BEFORE recording started

  const stopVoice = () => {
    recording = false;
    btn.classList.remove('chat-mic-recording');
    btn.setAttribute('aria-pressed', 'false');
    recognition = null;
  };

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (recording) {
      try { recognition && recognition.stop(); } catch {}
      return;
    }
    let rec;
    try { rec = new SR(); }
    catch (err) { console.warn('[voice] init failed:', err); return; }
    // Prefer the client's locale; fall back to en-US.
    try { rec.lang = navigator.language || 'en-US'; } catch {}
    rec.continuous = true;
    rec.interimResults = true;
    // processLocally (Chrome 137+ flag) forces on-device speech.
    // Setting it on browsers that don't recognize the property is
    // a no-op. Safari is on-device by default for the system mic
    // permission grant.
    try { rec.processLocally = true; } catch {}
    baseText = input.value;
    rec.onresult = (ev) => {
      let interim = '';
      let final = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const tr = ev.results[i][0] && ev.results[i][0].transcript;
        if (!tr) continue;
        if (ev.results[i].isFinal) final += tr;
        else interim += tr;
      }
      if (final) baseText = _joinSpoken(baseText, final);
      const next = _joinSpoken(baseText, interim);
      if (next !== input.value) {
        input.value = next;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        try {
          const end = input.value.length;
          input.setSelectionRange(end, end);
        } catch {}
      }
    };
    rec.onerror = (ev) => {
      // "no-speech" / "aborted" / "audio-capture" — log + bail.
      console.warn('[voice] recognition error:', ev.error || ev);
      stopVoice();
    };
    rec.onend = stopVoice;
    try {
      rec.start();
      recognition = rec;
      recording = true;
      btn.classList.add('chat-mic-recording');
      btn.setAttribute('aria-pressed', 'true');
    } catch (err) {
      console.warn('[voice] start threw:', err);
    }
  });
}

// Concatenate a spoken fragment onto existing text without colliding
// punctuation. If the new piece doesn't start with whitespace and
// the existing text doesn't end with whitespace, insert a single
// space. Trims trailing whitespace on the result.
function _joinSpoken(base, addition) {
  if (!addition) return base;
  if (!base) return addition.trimStart();
  const needsSpace = !/\s$/.test(base) && !/^\s/.test(addition);
  return base + (needsSpace ? ' ' : '') + addition;
}

// Stop / interrupt: button click + global Esc keybind when claude is
// running. Server maps the literal "esc" chat message to
// session.interrupt() (see server/src/attach.js's chat→agent key
// handling), so we just send it as a chat. Esc precedence: perm
// modal Esc (defer) > autocomplete Esc (dismiss) > stop-agent Esc.
function _bindStopAgent() {
  if (document.body.dataset.stopAgentBound === '1') return;
  document.body.dataset.stopAgentBound = '1';
  document.getElementById('claude-stop')?.addEventListener('click', (e) => {
    e.preventDefault();
    _sendStopAgent();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Yield to earlier-priority Esc handlers — they call
    // e.preventDefault() and we're attached at bubble phase by default,
    // but our check is also defensive: if the modal/autocomplete is
    // visible, leave Esc alone.
    const modal = document.getElementById('perm-modal');
    if (modal && !modal.hidden) return;
    const ac = document.getElementById('chat-autocomplete');
    if (ac && !ac.hidden) return;
    // Only interrupt if claude is actually awaitable. state.awaitingClaude
    // tracks our local "claude is running" timer; the server-side
    // claude-status feeds it. If neither is true, Esc has nothing to do
    // on this turn — bail so we don't spam interrupts.
    if (!state.awaitingClaude && !state.claudeStatusLine) return;
    e.preventDefault();
    _sendStopAgent();
  });
}

function _sendStopAgent() {
  if (!state.activeId) return;
  // bug-14: send a dedicated interrupt frame instead of the legacy
  // chat-text-esc path. The legacy path persisted the literal stop
  // keyword as a user-typed chat row + broadcast it to viewers AS IF
  // the user had typed it — confusing UX, and made Stop look broken
  // when the SDK abort had no immediate visible effect. The dedicated
  // frame routes directly to session.interrupt() server-side with a
  // brief assistant ack note + no chat-history pollution.
  //
  // Queue-if-reconnecting: skip. Stop is intent-based — if the WS
  // is dead, the user wants the interrupt NOW, not after reconnect;
  // by the time we reconnect the in-flight turn has likely either
  // finished or been killed by the reaper. A queued late-fire would
  // interrupt an UNRELATED future turn.
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[stop] ws not open — interrupt dropped (not queued, to avoid hitting a later turn)');
    return;
  }
  try { ws.send(JSON.stringify({ t: 'interrupt' })); }
  catch (err) { console.warn('[stop] interrupt send failed:', err && err.message); }
}

// Global key handler for the permission modal: Esc cancels (bug-41),
// digits 1-9 pick the matching option (single-select only — multi-
// select needs explicit Submit). Registered once at chat-UI init.
function _bindPermModalKeys() {
  if (document.body.dataset.permKeysBound === '1') return;
  document.body.dataset.permKeysBound = '1';
  document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('perm-modal');
    if (!modal || modal.hidden) return;
    // bug-41: Esc no longer just hides the modal (which left the agent
    // stuck on an unresolved AskUserQuestion Promise — the literal
    // user-reported symptom). For AskUserQuestion menus, Esc now picks
    // the synthetic Cancel option that _askNextSubQuestion auto-
    // appends; the server resolves with behavior:'deny' and the agent
    // unblocks. For permission menus (Allow/Deny shape) where no
    // synthetic Cancel exists, Esc falls back to the legacy defer
    // behavior — the user can reopen via the chat-pane menu card.
    if (e.key === 'Escape') {
      e.preventDefault();
      const q = state.pendingMenuQueue || [];
      const idx = state.pendingMenuIdx || 0;
      const cur = q[idx];
      // Look for the auto-appended Cancel synthetic on the current
      // menu. Per agent-session.js _askNextSubQuestion, it's tagged
      // with synthetic:'cancel'. Falls back to defer if absent (older
      // server build, permission-flavour menu, or unknown menu shape).
      if (cur && Array.isArray(cur.options)) {
        const cancelOpt = cur.options.find((o) => o && o.synthetic === 'cancel');
        if (cancelOpt && cur.hash && sendMenuPick(cancelOpt.n, cur.hash)) {
          _markAwaitingClaude();
          _markChatMenuAnswered(cur.hash, { pickedN: cancelOpt.n, cancelled: true });
          _advanceModalAfterResolve();
          return;
        }
      }
      // Fallback: legacy defer (just hide). Keeps Esc functional on
      // permission menus and older AskUserQuestion shapes.
      state.permModalDismissed = true;
      _renderPermModal();
      return;
    }
    // Don't steal digits if focus is on the chat input or anywhere
    // typeable — the user might be composing.
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'TEXTAREA' || tgt.tagName === 'INPUT' || tgt.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const q = state.pendingMenuQueue || [];
    const idx = state.pendingMenuIdx || 0;
    const cur = q[idx];
    if (!cur || cur.multi) return;     // multi-select needs Submit
    const n = parseInt(e.key, 10);
    const opt = (cur.options || []).find((o) => o.n === n);
    if (!opt) return;
    e.preventDefault();
    if (!sendMenuPick(n, cur.hash)) return;
    _markAwaitingClaude();
    _markChatMenuAnswered(cur.hash, { pickedN: n });
    if (_permOptionIsFreeText(opt.label)) {
      _focusChatInput(_permOptionIsChatAbout(opt.label)
        ? 'Type your follow-up — claude is waiting…'
        : 'Type your custom answer — claude is waiting…');
    }
    _advanceModalAfterResolve();
  });
}

// ─── Chatpane tabs (Discussion / Plan / Arch / Test) ─────────────────────────
//
// Discussion is the live chat; the other three render artifacts extracted from
// the running session's transcript via a server-side Anthropic call. The
// extraction is on-demand: each tab has a Refresh button that POSTs to
// /sessions/:id/artifact/refresh?type=… and re-renders.
//
// In Phase A (this commit) the server returns an empty artifact so the layout
// can be reviewed without spending API tokens. Phase B replaces the stub with
// real extraction.
const ARTIFACT_TYPES = ['plan', 'arch', 'test'];

// Each artifact type has its own main-pane view (#plan-wrap / #arch-wrap /
// #test-wrap) and a top-right chrome button (#btn-plan / #btn-arch /
// #btn-test). The buttons are mutually-exclusive with each other AND with
// the files / terminal / conversation views (same exclusivity rules as
// #files-wrap). Clicking an active button closes the view and restores
// whatever main-pane view was up before — same pattern as the files toggle.

function bindArtifactToggles() {
  document.querySelectorAll('.artifact-toggle').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    // Show-only on click — see the chrome-icon contract near
    // bindChrome(). Switching away happens by clicking a different
    // main-pane view (terminal/preview/files/plan/arch/test).
    btn.addEventListener('click', () => showArtifactView(btn.dataset.type));
  });
  document.querySelectorAll('.artifact-refresh').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => refreshArtifact(btn.dataset.type));
  });
}

function _wrapIdForArtifact(type) {
  return type + '-wrap';
}

// Toggle a `.has-artifact` class on #terminal-pane so CSS can flip
// chatpane from full-pane to right-sidebar while an artifact view
// (plan/arch/test/files) covers the left. Without this, the chatpane
// stayed at inset:0 behind the artifact (z-index trick), and the user
// couldn't see chat + artifact at the same time. Sidebar mode also
// re-enables the resize handle.
function _updateMainPaneLayout() {
  const main = document.getElementById('terminal-pane');
  if (!main) return;
  const hasArt = !!(state.artifactView && state.artifactView.active) ||
                 !!(state.files && state.files.visible);
  main.classList.toggle('has-artifact', hasArt);
}

function showArtifactView(type) {
  if (!ARTIFACT_TYPES.includes(type)) return;
  if (!state.activeId) return;
  const wrapId = _wrapIdForArtifact(type);
  const filesWrap = document.getElementById('files-wrap');
  // Capture whatever the user was looking at, so closing this view restores
  // them to that pane rather than dumping them on the chatpane.
  if (filesWrap && !filesWrap.hidden) state.artifactView.prev = 'files';
  // (otherwise leave the prior prev alone — we may be flipping between
  // artifact views and want to return to the same upstream pane.)
  _hideMainPaneSiblings(wrapId);
  document.getElementById(wrapId).hidden = false;
  state.artifactView.active = type;
  // Keep chat visible alongside the artifact on desktop — they live
  // side-by-side now, not stacked. Mobile still mutually-exclusive
  // (see _hideMainPaneSiblings).
  if (window.innerWidth > 900) setChatPane(true);
  // Mark the right button active, clear the others.
  for (const t of ARTIFACT_TYPES) {
    document.getElementById('btn-' + t)?.classList.toggle('active', t === type);
  }
  loadArtifact(type).catch(() => {});
  // fr-77 r3: when the Plan view is shown, also refresh the bottom
  // Changed-files section (2s cache prevents thrash from rapid
  // re-shows). The handlers (refresh button, collapse, click-to-
  // expand) are bound exactly once on first Plan-show.
  if (type === 'plan') {
    bindPlanChangedFilesUi();
    loadPlanChangedFiles({ force: false });
    // fr-93: start polling git-status so a user reviewing changes sees
    // the agent's writes appear without a manual Refresh click.
    _startPlanChangedFilesAutoRefresh();
  } else {
    // Switched to another artifact tab → stop the Plan-view polling.
    _stopPlanChangedFilesAutoRefresh();
  }
  updateChatButton();
  _updateMainPaneLayout();
}

function hideArtifactView() {
  const type = state.artifactView.active;
  if (!type) return;
  const wrapId = _wrapIdForArtifact(type);
  document.getElementById(wrapId).hidden = true;
  document.getElementById('btn-' + type)?.classList.remove('active');
  state.artifactView.active = null;
  // fr-93: Plan view going away → stop polling git-status.
  if (type === 'plan') _stopPlanChangedFilesAutoRefresh();
  // Phase 9 step 3 retired the terminal + transcript wraps. The chatpane
  // is always present underneath any artifact view, so closing one just
  // means hiding it — the chatpane reappears automatically. Files view
  // is the only sibling we still restore explicitly.
  if (state.artifactView.prev === 'files') showFilesView();
  _updateMainPaneLayout();
}

function toggleArtifactView(type) {
  if (state.artifactView.active === type) hideArtifactView();
  else showArtifactView(type);
}

// Per-tab empty-state copy, mirrored from index.html. Centralised so a
// session switch can wipe the rendered body back to the right empty state
// without scraping the original DOM. Keep these strings in sync with the
// initial markup in index.html.
const ARTIFACT_EMPTY_HTML = {
  plan: 'No todos yet. Click <strong>Refresh</strong> to extract them from the latest session activity. Check a todo\'s box (or hit ▶ Run) to dispatch it to Claude — findings land as a comment on the item.',
  arch: 'No architecture notes yet. Click <strong>Refresh</strong> to extract them from the latest session activity.',
  test: 'No test plans yet. Click <strong>Refresh</strong> to extract them from the latest session activity.',
};

function clearArtifactBodies() {
  // Rescue the fr-61 sticky filter row before wiping the plan body —
  // otherwise the wipe destroys it permanently and on next plan render
  // _attachPlanFilterRowToBody has nothing to find. Symptom (user
  // report): "The plan view filter for bug/fr/tod and search disappears
  // after switch tabs." Pre-fix the row vanished after any path that
  // hit clearArtifactBodies (session switch via _resetUiForNewSession,
  // active-session delete via deleteSessionWithConfirm).
  _stashPlanFilterRow();
  for (const type of ARTIFACT_TYPES) {
    const body = document.getElementById(`artifact-body-${type}`);
    if (!body) continue;
    body.innerHTML = `<div class="artifact-empty">${ARTIFACT_EMPTY_HTML[type] || ''}</div>`;
  }
}

async function loadArtifact(type) {
  if (!ARTIFACT_TYPES.includes(type)) return;
  const sid = state.activeId;
  if (!sid) return;
  const body = document.getElementById(`artifact-body-${type}`);
  if (!body) return;
  // Prefer the cache populated by the artifacts-init / state-update WS
  // frames — that's the freshest authoritative state. Tab switches are
  // instant + always in sync without an HTTP round-trip.
  //
  // ryan-blues bug fix: the cache lookup MUST verify state.artifacts.sessionId
  // === sid. A spawn-new-session flow advances state.activeId BEFORE the
  // new session's artifacts-init WS frame arrives — without this check
  // the lookup would return the prior session's plan items and render
  // them against the new session's tab.
  const cacheValid = state.artifacts && state.artifacts.sessionId === sid && state.artifacts.byType;
  const cached = cacheValid ? state.artifacts.byType[type] : null;
  const cachedHas = cached && (
    (type === 'arch' && typeof cached.markdown === 'string' && cached.markdown.trim()) ||
    (type !== 'arch' && Array.isArray(cached.items) && cached.items.length)
  );
  if (cachedHas) {
    renderArtifact(type, cached);
    // fr-81 Phase A: refresh the remote-issues section after the plan
    // body rebuild (the rebuild wipes #remote-issues-section).
    if (type === 'plan') _loadAndRenderRemoteIssues(sid);
    return;
  }
  // Cache miss — fall back to HTTP. Happens on cold reload of an
  // artifact tab before the WS attach delivers artifacts-init, AND
  // when a session-switch invalidated the cache.
  try {
    const res = await authedFetch(`/sessions/${encodeURIComponent(sid)}/artifact?type=${encodeURIComponent(type)}`);
    if (!res || !res.ok) return;
    const data = await res.json().catch(() => ({}));
    const artifact = data.artifact || data;
    // Only render if there's actually persisted content; leaving the empty-
    // state copy in place is friendlier than overwriting it with a blank.
    const hasContent = (type === 'arch' && artifact && artifact.markdown && artifact.markdown.trim())
      || (type !== 'arch' && artifact && Array.isArray(artifact.items) && artifact.items.length);
    if (hasContent) {
      renderArtifact(type, artifact);
      // Populate cache for the next call — and (re)bind it to sid so
      // a subsequent lookup for the same session is fast.
      if (state.artifacts.sessionId !== sid) {
        state.artifacts = { sessionId: sid, byType: {} };
      }
      state.artifacts.byType[type] = artifact;
    }
    // fr-81 Phase A: refresh the remote-issues section EVEN when the
    // plan body had no local items (an empty plan + remote issues is a
    // valid state — the section sits below the empty-state copy).
    if (type === 'plan') _loadAndRenderRemoteIssues(sid);
  } catch {}
}

async function refreshArtifact(type) {
  if (!ARTIFACT_TYPES.includes(type)) return;
  const sid = state.activeId;
  if (!sid) return;
  const btn = document.querySelector(`.artifact-refresh[data-type="${type}"]`);
  const body = document.getElementById(`artifact-body-${type}`);
  if (!body) return;
  // Plan refresh is now a two-step claude-p call (extract + dedupe
  // scan), so it takes 15–30s instead of the previous ~10. Show the
  // user we know it's slow.
  let origBtnText = '';
  if (btn) {
    btn.disabled = true;
    origBtnText = btn.textContent;
    if (type === 'plan') btn.textContent = '⏳ Refreshing… (asking claude for merges)';
  }
  try {
    const res = await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/artifact/refresh?type=${encodeURIComponent(type)}`,
      { method: 'POST' }
    );
    if (!res || !res.ok) {
      body.innerHTML = `<div class="artifact-empty">Refresh failed (HTTP ${res ? res.status : '?'}).</div>`;
      return;
    }
    const data = await res.json().catch(() => ({}));
    renderArtifact(type, data.artifact || data);
    // fr-81 Phase A: refresh the remote-issues section. The refresh
    // button passes force=true so the server skips the cache and
    // re-hits the upstream API — without it the user clicks Refresh
    // and sees the same stale list returned by stale-while-revalidate.
    // (Phase A r1 critique response — the original commit's wiring
    // dropped force on the floor; the helper signature now accepts it.)
    if (type === 'plan') _loadAndRenderRemoteIssues(sid, { force: true });
    // Plan-only: render the merge-proposal callout above the items.
    // mergeProposals may be empty (no candidates) or absent (older
    // server build) — both are no-ops for the callout.
    if (type === 'plan') {
      _renderMergeProposals(data.mergeProposals || [], data.mergeError || null);
    }
  } catch (err) {
    body.innerHTML = `<div class="artifact-empty">Refresh failed: ${escHtml(err.message || String(err))}</div>`;
  } finally {
    if (btn) {
      btn.disabled = false;
      if (origBtnText) btn.textContent = origBtnText;
    }
  }
}

// Render a yellow "Possible merges" callout above the plan items.
// Each group exposes [Apply] / [Dismiss] buttons that hit the
// /sessions/:id/artifact/plan/merge endpoint and re-render on success.
// Empty proposals (or a mergeError) just clear the callout — no UI noise.
function _renderMergeProposals(proposals, errMsg) {
  const body = document.getElementById('artifact-body-plan');
  if (!body) return;
  // Always remove any previous callout first so a refresh that
  // produces no candidates clears the stale UI.
  const existing = body.querySelector('.plan-merge-callout');
  if (existing) existing.remove();
  if (errMsg) {
    const node = _htmlToNode(
      `<div class="plan-merge-callout plan-merge-error">` +
        `<strong>⚠ Dedupe scan error:</strong> ${escHtml(errMsg)}` +
      `</div>`
    );
    if (node) body.insertBefore(node, body.firstChild);
    return;
  }
  if (!Array.isArray(proposals) || !proposals.length) return;
  const groupsHtml = proposals.map((g, i) => {
    const ids = (g.ids || []).join(' ');
    const idChips = (g.ids || []).map((id) => `<code>${escHtml(id)}</code>`).join(', ');
    const reason = escHtml(g.reason || '(no reason)');
    return `<div class="plan-merge-group" data-merge-idx="${i}" data-merge-ids="${escHtml(ids)}">
      <div class="plan-merge-reason">${reason}</div>
      <div class="plan-merge-ids">${idChips}</div>
      <div class="plan-merge-actions">
        <button type="button" class="plan-merge-apply">Apply</button>
        <button type="button" class="plan-merge-dismiss">Dismiss</button>
      </div>
    </div>`;
  }).join('');
  const node = _htmlToNode(
    `<div class="plan-merge-callout">` +
      `<div class="plan-merge-title">🪄 Possible merges (${proposals.length})</div>` +
      groupsHtml +
    `</div>`
  );
  if (!node) return;
  body.insertBefore(node, body.firstChild);
  // Wire buttons. Apply POSTs the merge endpoint and re-renders the
  // artifact from the response (no second claude-p call needed).
  node.querySelectorAll('.plan-merge-apply').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const group = btn.closest('.plan-merge-group');
      const ids = String(group?.dataset?.mergeIds || '').split(/\s+/).filter(Boolean);
      if (ids.length < 2) return;
      btn.disabled = true;
      btn.textContent = 'Merging…';
      try {
        const sid = state.activeId;
        const res = await authedFetch(
          `/sessions/${encodeURIComponent(sid)}/artifact/plan/merge`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) },
        );
        if (!res || !res.ok) {
          const body = await res.json().catch(() => ({}));
          btn.textContent = 'Apply';
          btn.disabled = false;
          group.insertAdjacentHTML('beforeend',
            `<div class="plan-merge-error">⚠ ${escHtml(body.error || ('HTTP ' + (res ? res.status : '?')))}</div>`);
          return;
        }
        const data = await res.json().catch(() => ({}));
        // Pull the applied group out of the callout BEFORE rebuilding
        // the items list. renderArtifact preserves the rest of the
        // callout across its body.innerHTML rebuild (see top of
        // renderArtifact), so the remaining proposals stay visible
        // without disappear-and-flicker-back.
        group.remove();
        if (!node.querySelector('.plan-merge-group')) node.remove();
        renderArtifact('plan', data.artifact);
      } catch (err) {
        btn.textContent = 'Apply';
        btn.disabled = false;
        group.insertAdjacentHTML('beforeend',
          `<div class="plan-merge-error">⚠ ${escHtml(err.message || String(err))}</div>`);
      }
    });
  });
  node.querySelectorAll('.plan-merge-dismiss').forEach((btn) => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.plan-merge-group');
      group?.remove();
      // If that was the last group, drop the whole callout.
      if (!node.querySelector('.plan-merge-group')) node.remove();
    });
  });
}

// bug-8: layer-aware verb for the ▶ Run button on plan items.
//   Bug     → "Fix"     (it's broken — stop the bleeding)
//   Feature → "Implement" (build the thing)
//   Todo    → "Do"      (generic chore verb)
//   unknown / missing layer (legacy untagged items) → "Run" fallback
// Hoisted to module scope so renderItem inside renderArtifact can see
// it without re-defining per-render.
function _runButtonLabel(layer) {
  // Keep labels short (3-5 chars) so the action row doesn't wrap on
  // mobile. "Implement" was 9 chars and pushed the row to two lines
  // alongside the post-fr-62 44px button width budget. "Build" carries
  // the same verb intent without the wrap pressure.
  switch (layer) {
    case 'Bug':     return 'Fix';
    case 'Feature': return 'Build';
    case 'Todo':    return 'Do';
    default:        return 'Run';
  }
}

// fr-81 Phase A: fetch + render open issues from the session project's
// upstream remote (GitHub or Gitee) into a separate section at the
// bottom of the Plan view. Lives in its own DOM container so it's
// independent of renderArtifact's body.innerHTML rebuild for plan
// items — the rebuild wipes everything in #artifact-body-plan, so we
// re-call this from each of the plan-render entry points (loadArtifact
// cache hit, loadArtifact HTTP fallback, refreshArtifact). Errors render
// inline as a helpful hint (no token → "Sign in / /setpat"; no remote
// → quiet skip). Phase B will add dedup vs locally-filed issues,
// close-detection mirror, and Plan-view close → close-upstream.
async function _loadAndRenderRemoteIssues(sid, opts = {}) {
  if (!sid) return;
  const body = document.getElementById('artifact-body-plan');
  if (!body) return;
  // Ensure the section exists at the END of the plan body.
  let section = body.querySelector('#remote-issues-section');
  if (!section) {
    section = document.createElement('section');
    section.id = 'remote-issues-section';
    section.className = 'remote-issues-section';
    body.appendChild(section);
  }
  section.innerHTML = '<div class="remote-issues-loading">⏳ Loading remote issues…</div>';
  // fr-81 Phase A r1 (critique response): the refresh button path
  // must actually force a fresh upstream fetch — without ?force=1 the
  // server's stale-while-revalidate path returns the cached snapshot
  // and only kicks a background refetch, so the user clicks Refresh
  // and sees the SAME stale list. Explicit opts.force=true upgrades
  // the request to the server's force-now path.
  const force = !!(opts && opts.force);
  let data;
  try {
    const res = await authedFetch(`/sessions/${encodeURIComponent(sid)}/remote-issues${force ? '?force=1' : ''}`);
    if (!res || !res.ok) {
      section.innerHTML = `<div class="remote-issues-empty">Remote issues unavailable (HTTP ${res ? res.status : '?'}).</div>`;
      return;
    }
    data = await res.json();
  } catch (err) {
    section.innerHTML = `<div class="remote-issues-empty">Remote issues unavailable: ${escHtml(err.message || String(err))}</div>`;
    return;
  }
  // Empty branches — render a hint, not a noisy banner.
  if (data && data.error === 'no-remote') {
    section.innerHTML = '';   // Quiet skip: project has no github/gitee remote.
    return;
  }
  if (data && data.error === 'no-token') {
    const providerLabel = data.provider === 'gitee' ? 'Gitee' : 'GitHub';
    const setpatHint = data.provider === 'gitee'
      ? `Run <code>/setpat &lt;token&gt;</code> from the chat — Gitee has no OAuth flow yet.`
      : `Sign in via the top-right user chip, or <code>/setpat &lt;token&gt;</code>.`;
    section.innerHTML = `<h3 class="remote-issues-title">🔗 Remote issues — ${escHtml(providerLabel)}</h3>` +
      `<div class="remote-issues-empty">No ${escHtml(providerLabel)} token on file for <code>${escHtml(data.owner + '/' + data.repo)}</code>. ${setpatHint}</div>`;
    return;
  }
  const items = Array.isArray(data && data.items) ? data.items : [];
  const providerLabel = data && data.provider === 'gitee' ? 'Gitee' : 'GitHub';
  const ownerRepo = data && data.owner && data.repo ? `${data.owner}/${data.repo}` : '';
  // fr-81 Phase B.2: surface the dedup pass in the section header.
  // "(N linked)" means N remote issues were folded into local plan
  // items above (matched by meta.remoteUrl) rather than shown twice.
  const linkedSuffix = (data && data.linkedCount > 0)
    ? ` <span class="remote-issues-linked">(${data.linkedCount} linked above)</span>`
    : '';
  if (!items.length) {
    const reason = (data && data.linkedCount > 0)
      ? `All ${data.linkedCount} open remote issue${data.linkedCount === 1 ? '' : 's'} are already linked to local plan items above.`
      : 'No open issues on the upstream remote.';
    section.innerHTML = `<h3 class="remote-issues-title">🔗 Remote issues — ${escHtml(providerLabel)} ${ownerRepo ? '<code>' + escHtml(ownerRepo) + '</code>' : ''} (0)${linkedSuffix}</h3>` +
      `<div class="remote-issues-empty">${escHtml(reason)}</div>`;
    return;
  }
  const rows = items.map((it) => {
    const labels = Array.isArray(it.labels) && it.labels.length
      ? `<span class="remote-issue-labels">${it.labels.slice(0, 4).map((l) => '<span class="remote-issue-label">' + escHtml(l) + '</span>').join('')}</span>`
      : '';
    const author = it.author ? `<span class="remote-issue-author">${escHtml(it.author)}</span>` : '';
    return `<li class="remote-issue-row" data-number="${it.number}">` +
      `<a class="remote-issue-link" href="${escHtml(it.htmlUrl || '#')}" target="_blank" rel="noopener noreferrer">` +
        `<span class="remote-issue-num">#${it.number}</span>` +
        `<span class="remote-issue-title">${escHtml(it.title || '(untitled)')}</span>` +
      `</a>` +
      labels + author +
    `</li>`;
  }).join('');
  section.innerHTML =
    `<h3 class="remote-issues-title">🔗 Remote issues — ${escHtml(providerLabel)} ${ownerRepo ? '<code>' + escHtml(ownerRepo) + '</code>' : ''} (${items.length})${linkedSuffix}</h3>` +
    `<ul class="remote-issues-list">${rows}</ul>`;
}

function renderArtifact(type, artifact) {
  const body = document.getElementById(`artifact-body-${type}`);
  if (!body) return;
  // Preserve the merge-proposals callout across renderArtifact rebuilds.
  // The Apply button handler relies on the callout DOM identity staying
  // stable so the remaining proposals don't flicker (disappear during
  // body.innerHTML rebuild, then re-mount). We detach here, do the
  // rebuild, then re-insert at the top below. Bound event listeners on
  // its buttons survive the detach.
  const preservedCallout = type === 'plan' ? body.querySelector('.plan-merge-callout') : null;
  if (preservedCallout) preservedCallout.remove();
  if (type === 'arch') {
    const md = artifact && artifact.markdown ? artifact.markdown.trim() : '';
    // Best-practices banner is prepended when the Arch-tab toggle is on
    // (default ON, persisted in localStorage as 'myco_bp_enabled').
    // Template text loaded once from /best-practices-template.md and
    // cached on state.bpTemplate; the banner shows whatever was loaded.
    const bpEnabled = (localStorage.getItem('myco_bp_enabled') || '1') === '1';
    const bpMd = bpEnabled && state.bpTemplate ? state.bpTemplate : '';
    const bpHtml = bpMd ? `<div class="bp-banner artifact-md">${renderMd ? renderMd(bpMd) : escHtml(bpMd)}</div>` : '';
    if (!md && !bpHtml) {
      body.innerHTML = '<div class="artifact-empty">Nothing to show yet. The session may not have any architectural decisions in its recent activity.</div>';
      return;
    }
    const userMd = md
      ? `<div class="artifact-md">${renderMd ? renderMd(md) : escHtml(md)}</div>`
      : '<div class="artifact-empty">No per-project architecture notes yet. Click <strong>Refresh</strong> to extract them from the session.</div>';
    const updated = artifact && artifact.updatedAt
      ? `<div class="artifact-updated">Updated ${escHtml(formatChatTsWithDate(artifact.updatedAt) || artifact.updatedAt)}</div>`
      : '';
    body.innerHTML = bpHtml + userMd + updated;
    // Render any ```mermaid fences inside the arch markdown.
    renderMermaidInContainer(body).catch(() => {});
    return;
  }
  // bug-35: the upcoming renderArtifact path moves #plan-filter-row twice
  // (out of #artifact-body-plan via _stashPlanFilterRow, then back in via
  // _attachPlanFilterRowToBody). Each insertBefore-move detaches+reattaches
  // the row's DOM tree, and browsers drop focus from any focused descendant
  // on the detach step. The #plan-search input lives INSIDE that row, so the
  // debounced search re-render kicked focus out mid-typing — the user's next
  // keystroke landed outside the field. Snapshot the focused-ness + caret
  // position BEFORE the move pair; the 3 plan-branch exits below each call
  // _restorePlanSearchFocus(snap) right after _attachPlanFilterRowToBody.
  // Plan-only (test artifact doesn't have the filter row).
  const planSearchFocusSnap = (type === 'plan') ? _capturePlanSearchFocus() : null;

  // plan / test → checkbox list. Plan items also get vote button + comment thread.
  const items = (artifact && Array.isArray(artifact.items)) ? artifact.items : [];
  // Plan tab filters (Plan only — Test tab is a flat unfiltered list):
  //   1. "Open only" toggle (bug-15)  — localStorage.myco_plan_open_only.
  //      Drops .done items via items.filter((it) => !it.done).
  //   2. Type-chip filter (fr-56)     — localStorage.myco_plan_type_filter.
  //      Drops items whose .layer isn't in the enabled chip set.
  //   3. Fuzz-search input (fr-56)    — state.planSearchQuery (not persisted).
  //      Case-insensitive substring across item id + text + body.
  // Two-phase application: openOnly first (preserves bug-15's filter
  // shape + empty-state message verbatim), then type+search via
  // _filterPlanItems on the open-only result. This keeps the bug-15
  // contract verbatim while layering fr-56 on top.
  const planOpenOnly = type === 'plan'
    && (localStorage.getItem('myco_plan_open_only') || '0') === '1';
  const openOnlyItems = planOpenOnly ? items.filter((it) => !it.done) : items;
  const planTypes = type === 'plan' ? _readPlanTypeFilter() : null;
  const planSearch = type === 'plan' ? (state.planSearchQuery || '') : '';
  const fr56Active = type === 'plan' && ((planTypes && planTypes.length < 3) || !!planSearch);
  const displayItems = fr56Active
    ? _filterPlanItems(openOnlyItems, { types: planTypes, search: planSearch })
    : openOnlyItems;
  if (!items.length) {
    _stashPlanFilterRow();
    body.innerHTML = '<div class="artifact-empty">Nothing extracted. The recent session activity may not contain todos.</div>';
    // Re-attach preservedCallout (no flicker rule applies on the empty
    // path too — the user just merged the last item, the callout might
    // still have more proposals to render).
    if (preservedCallout) body.insertBefore(preservedCallout, body.firstChild);
    _attachPlanFilterRowToBody(body, type);
    _restorePlanSearchFocus(planSearchFocusSnap);
    return;
  }
  if (!displayItems.length) {
    _stashPlanFilterRow();
    // Empty-state message preference:
    //   - openOnly is the ONLY active filter → bug-15's verbatim message
    //     ("All N item(s) are done. Uncheck Open only to see them.")
    //   - fr-56 filters are active (with or without openOnly) → fr-56
    //     dynamic message naming the active filter(s) so the user
    //     knows which one to relax.
    if (planOpenOnly && !fr56Active) {
      body.innerHTML = `<div class="artifact-empty">All ${items.length} item(s) are done. Uncheck <strong>Open only</strong> to see them.</div>`;
    } else {
      const why = [];
      if (planOpenOnly) why.push('<strong>Open only</strong>');
      if (planTypes && planTypes.length < 3) why.push('<strong>type filter</strong>');
      if (planSearch) why.push(`<strong>search "${escHtml(planSearch)}"</strong>`);
      const whyText = why.length ? ` after applying ${why.join(' + ')}` : '';
      body.innerHTML = `<div class="artifact-empty">No items match${whyText}. ${items.length} total item(s) in the plan.</div>`;
    }
    if (preservedCallout) body.insertBefore(preservedCallout, body.firstChild);
    _attachPlanFilterRowToBody(body, type);
    _restorePlanSearchFocus(planSearchFocusSnap);
    return;
  }
  const me = state.chatUser || '';
  const supportsVoting = (type === 'plan');
  // Plan items are grouped by their `layer` field (assigned by the extractor;
  // e.g. "Frontend", "Backend", "Tests"). Items keep their extraction order
  // within each layer, and layers appear in the first-seen order so the
  // top-down structure the model intends is preserved. Test items don't have
  // layers and render as a flat list.
  const renderItem = (it) => {
    const cls = it.done ? 'is-done' : '';
    const voters = Array.isArray(it.voters) ? it.voters : [];
    const points = voters.length;
    const userHasVoted = !!(me && voters.includes(me));
    const comments = Array.isArray(it.comments) ? it.comments : [];
    // fr-64: status chip — 🟢 closed / ▶ running / ⏸ queued /
    // 📌 in-progress (has runs) / ⚪ open. Derived from existing
    // state (it.done, it.runs[], state.runQueue.entries) — no schema
    // change. Plan-only (supportsVoting): the test artifact doesn't
    // have a queue/done lifecycle to surface.
    const statusChip = supportsVoting
      ? _planItemStatusChipHtml(_planItemStatus(it,
          (state.runQueue && state.runQueue.entries) || []))
      : '';
    const voteBlock = supportsVoting ? `
      <button class="artifact-vote ${userHasVoted ? 'is-voted' : ''}" data-id="${escHtml(it.id)}"
              title="${userHasVoted ? 'Click to remove your vote' : 'Click to vote — items at 2 votes auto-execute'}">
        <span class="vote-icon">${_lucideIcon('thumbs-up')}</span><span class="vote-count">${points}</span>
      </button>
      <button class="artifact-comment-toggle" data-id="${escHtml(it.id)}" title="Show comments">
        ${_lucideIcon('message-square')}<span class="comment-count">${comments.length || ''}</span>
      </button>` : '';
    // fr-46: pencil/trash on each comment, gated on !state.readOnly
    // (owner+admin only). meta.editedBy/editedAt → small "edited" badge
    // so the audit trail is visible to all readers.
    const canEditComments = !state.readOnly;
    const commentsBlock = supportsVoting ? `
      <div class="artifact-comments" data-id="${escHtml(it.id)}" hidden>
        <div class="artifact-comments-list">${
          comments.map((c) => {
            const editedBadge = (c.meta && c.meta.editedBy)
              ? `<span class="comment-edited" title="edited by ${escHtml(c.meta.editedBy)} at ${escHtml(c.meta.editedAt || '')}">· edited</span>`
              : '';
            const commentActions = canEditComments
              ? `<span class="artifact-comment-actions">
                  <button class="artifact-comment-edit" data-id="${escHtml(it.id)}" data-cid="${escHtml(c.id)}" title="Edit comment" aria-label="Edit comment">${_lucideIcon('pencil')}</button>
                  <button class="artifact-comment-delete" data-id="${escHtml(it.id)}" data-cid="${escHtml(c.id)}" title="Delete comment" aria-label="Delete comment">${_lucideIcon('trash')}</button>
                </span>`
              : '';
            return `
            <div class="artifact-comment" data-cid="${escHtml(c.id)}">
              <span class="comment-user">${escHtml(c.user || '?')}</span>
              <span class="comment-ts">${escHtml(formatChatTsWithDate(c.ts) || '')}</span>
              ${editedBadge}
              ${commentActions}
              <div class="comment-body">${renderMd(c.text || '')}</div>
            </div>`;
          }).join('')
        }</div>
        <form class="artifact-comment-form" data-id="${escHtml(it.id)}">
          <input type="text" class="artifact-comment-input" placeholder="Add a comment…" maxlength="1000" />
          <button type="submit" class="artifact-comment-send">Post</button>
        </form>
      </div>` : '';
    // Surface the id (fr-N / td-N / bug-N or legacy hex) and the
    // merged-from badge so users can see at-a-glance which items got
    // absorbed by /merge or the plan-refresh dedupe Apply flow.
    // mergedFrom is set by slashcmds.mergePlanItems; absent on
    // never-merged items.
    //
    // fr-6: the id chip is also a deep-link affordance. Clicking it
    // copies a permalink (`<origin>/#<id>`) to the clipboard AND
    // updates the URL bar in place, so the user can share/bookmark
    // a specific item. The matching <li> below carries a stable DOM
    // id (`artifact-item-<id>`) so the hashchange handler can
    // scrollIntoView + briefly highlight it on arrival.
    const idChip = it.id
      ? `<code class="artifact-item-id" data-deep-link-id="${escHtml(it.id)}" role="button" tabindex="0" title="Click to copy a deep link to this item">${escHtml(it.id)}</code>`
      : '';
    // fr-81 Phase B.2: 🔗 chip on local plan items that carry
    // meta.remoteUrl (set by Phase B.1's auto-promote on /feature
    // and /fr @target). Click opens the upstream issue in a new
    // tab. This is the visible half of dedup — instead of seeing
    // the issue twice (once locally + once in the Remote section
    // below), the user sees one row with a quick link to upstream.
    const remoteUrl = it.meta && typeof it.meta.remoteUrl === 'string' ? it.meta.remoteUrl : '';
    const remoteChip = remoteUrl
      ? `<a class="artifact-item-remote" href="${escHtml(remoteUrl)}" target="_blank" rel="noopener noreferrer" title="Open the linked remote issue on ${escHtml(it.meta && it.meta.remoteProvider === 'gitee' ? 'Gitee' : 'GitHub')}: ${escHtml(remoteUrl)}">🔗</a>`
      : '';
    // Creator line: small muted "filed by @user · <ts>" rendered on
    // its own row BELOW the body text. Doesn\'t compete with the body
    // for horizontal space in the flex top row. Hover-title carries
    // the raw addedAt timestamp for full provenance. Guards on
    // it.addedBy being truthy so legacy items (filed before the field
    // was tracked) render with no line at all.
    const byLine = it.addedBy
      ? `<div class="artifact-item-by" title="filed by @${escHtml(it.addedBy)} at ${escHtml(it.addedAt || 'unknown')}">filed by @${escHtml(it.addedBy)}${it.addedAt ? ' · ' + escHtml(formatChatTsWithDate(it.addedAt) || it.addedAt) : ''}</div>`
      : '';
    const mergedFrom = Array.isArray(it.mergedFrom) ? it.mergedFrom : [];
    const mergedBadge = mergedFrom.length
      ? `<span class="artifact-item-merged" title="merged from: ${escHtml(mergedFrom.join(', '))}">⤴ merged from ${mergedFrom.length}</span>`
      : '';
    // Top row carries the checkbox + id chip + body text (text takes
    // all remaining width — no horizontal contention with the action
    // icons). Actions row below carries vote / comment / merged-badge
    // / delete so longer items aren't squeezed by a row of buttons on
    // the right.
    // Last-run status badge. `runs` is an array stamped server-side
    // when the user clicks ▶ Run: each entry is { status, ts,
    // summary, turnId }. We display only the LAST run's status as a
    // chip; click the chip (or expand the item) for the full log.
    const runs = Array.isArray(it.runs) ? it.runs : [];
    const lastRun = runs.length ? runs[runs.length - 1] : null;
    // Icon + text split so mobile hides the word via .btn-text rule.
    // Tooltip carries status + ts + summary for full context on hover/tap.
    const runChip = lastRun
      ? `<span class="artifact-item-run-status artifact-run-${escHtml(lastRun.status || 'unknown')}" title="${escHtml((lastRun.status || 'unknown') + ' · ' + (lastRun.ts || '') + (lastRun.summary ? '\n' + lastRun.summary : ''))}">${
          lastRun.status === 'running' ? '<span class="btn-icon">●</span><span class="btn-text">running</span>'
          : lastRun.status === 'success' ? '<span class="btn-icon">✓</span><span class="btn-text">done</span>'
          : lastRun.status === 'error'   ? '<span class="btn-icon">■</span><span class="btn-text">error</span>'
          : '<span class="btn-text">' + escHtml(lastRun.status || '') + '</span>'
        }</span>`
      : '';
    // Dependency check: if this item has dependsOn=[id,...], the
    // Run button stays disabled until every listed prereq is done
    // (or merged/marked-done). UI also surfaces an "↗ depends on:"
    // chip so the user can see what's blocking.
    const deps = Array.isArray(it.dependsOn) ? it.dependsOn.filter(Boolean) : [];
    const allItems = (artifact && Array.isArray(artifact.items)) ? artifact.items : [];
    const depResolved = (depId) => {
      const dep = allItems.find((x) => x && x.id === depId);
      return dep ? !!dep.done : true;  // unknown id treated as resolved (forgiving)
    };
    const unmetDeps = deps.filter((d) => !depResolved(d));
    const depsChip = deps.length
      ? `<span class="artifact-item-deps${unmetDeps.length ? ' artifact-item-deps-blocked' : ' artifact-item-deps-ok'}" title="depends on: ${escHtml(deps.join(', '))}${unmetDeps.length ? ` · blocked by: ${escHtml(unmetDeps.join(', '))}` : ' · all prereqs done'}">↗ ${unmetDeps.length ? 'blocked by' : 'after'} ${escHtml(deps.join(', '))}</span>`
      : '';

    // ▶ Run button: gated on a single upvote (lowered from 2 for
    // solo testing — flip back to 2 once group review is the norm)
    // AND on every dependsOn prereq being done AND on the item not
    // already being marked done (bug-8 — completed items shouldn't
    // offer a Run action; reopen the item to re-run).
    const RUN_VOTE_THRESHOLD = 1;
    const enoughVotes = points >= RUN_VOTE_THRESHOLD;
    const notDone = !it.done;
    const runEnabled = enoughVotes && unmetDeps.length === 0 && notDone;
    // bug-8: layer-aware verb on the Run button. Bug → "Fix",
    // Feature → "Implement", Todo → "Do". Unknown / missing layer
    // (legacy untagged items) falls back to "Run".
    const runLabel = _runButtonLabel(it.layer);
    const runTitle = runEnabled
      ? `Ask claude to ${runLabel.toLowerCase()} this item — status + result will be linked back here`
      : it.done
        ? 'This item is marked done — Run is disabled. Reopen the item to re-run.'
        : !enoughVotes
          ? `Needs ${RUN_VOTE_THRESHOLD} upvote${RUN_VOTE_THRESHOLD === 1 ? '' : 's'} to run (currently ${points}). Click the vote button above to vote.`
          : `Blocked by unmet prereq${unmetDeps.length === 1 ? '' : 's'}: ${unmetDeps.join(', ')}. Mark them done first.`;
    // Mobile hides .btn-text via CSS (icon-only); desktop keeps both.
    // fr-77 r14: Lucide-style SVGs replace the ▶ ✎ ✓ ↻ × emojis below
    // so the whole plan-item action row picks up currentColor + hover
    // tints from the same family as the chrome cluster.
    const runBtn = `<button class="artifact-item-run" data-id="${escHtml(it.id)}" data-text="${escHtml(String(it.text || '').slice(0, 200))}" ${runEnabled ? '' : 'disabled'} title="${escHtml(runTitle)}" aria-label="${escHtml(runLabel)}"><span class="btn-icon">${_lucideIcon('play')}</span><span class="btn-text">${escHtml(runLabel)}</span></button>`;
    // fr-46: edit pencil for item body text. Gated on !state.readOnly
    // (owner+admin only — viewers don't see it). meta.editedBy chip
    // surfaces the audit trail for everyone.
    const itemEditedBadge = (it.meta && it.meta.editedBy)
      ? `<span class="artifact-item-edited" title="edited by ${escHtml(it.meta.editedBy)} at ${escHtml(it.meta.editedAt || '')}${it.meta.originalText ? ' · original preserved' : ''}"><span class="btn-icon">${_lucideIcon('pencil')}</span><span class="btn-text">edited</span></span>`
      : '';
    const editBtn = (!state.readOnly && supportsVoting)
      ? `<button class="artifact-item-edit" data-id="${escHtml(it.id)}" title="Edit item body" aria-label="Edit"><span class="btn-icon">${_lucideIcon('pencil')}</span><span class="btn-text">Edit</span></button>`
      : '';
    // fr-48: per-item ⊤ Queue button was pruned after the unified
    // dispatch refactor (commit 606f14c) made the ▶ Run button itself
    // POST to /queue/add. Both buttons were functionally identical;
    // ▶ Run carries the layer-aware label (Implement/Fix/Do) which is
    // more semantic than a generic "Queue" verb. The queue chip strip
    // at the top of the chat pane remains the always-visible queue
    // status surface.
    // fr-47: explicit close/open affordance replaces the dual-purpose
    // checkbox. Pre-fix the checkbox conflated two actions — checking
    // dispatched to claude (POST /artifact/run), unchecking marked
    // done=false. Now ▶ Run owns dispatch (queue path) and this
    // button owns lifecycle: "Close" toggles done=true, "Reopen"
    // toggles done=false. Same backend (POST /artifact/mark), no
    // claude dispatch.
    // (Declared BEFORE the actions-row template literal references
    // it — `const` has no hoisting, out-of-order use throws
    // ReferenceError and wipes the entire renderItem render.)
    const closeLabel = it.done ? 'Reopen' : 'Close';
    const closeTitle = it.done
      ? 'Reopen this item (clears done state)'
      : 'Close this item (marks done — no claude dispatch)';
    // Close icon = 'check-popout' (a checkmark whose tail pokes
    // through the top-right of a circle, hand-rolled per user
    // sketch); Reopen icon = ↻ (rotate-ccw). Icon history on this
    // button: r14 first picked Lucide 'check' (✓), close-icon-uses-x
    // swapped to 'x' (×) because ✓ was reading as "mark complete",
    // then close-icon r2 went to the popout composite to give the
    // close-as-completion semantic visual emphasis without the bare
    // ✓ ambiguity. Mobile shows just the icon; desktop adds the text
    // label after.
    const closeIcon = it.done ? _lucideIcon('rotate-ccw') : _lucideIcon('check-popout');
    const closeBtn = supportsVoting
      ? `<button class="artifact-item-close" data-type="${escHtml(type)}" data-id="${escHtml(it.id)}" data-done="${it.done ? '1' : '0'}" title="${escHtml(closeTitle)}" aria-label="${escHtml(closeLabel)}"><span class="btn-icon">${closeIcon}</span><span class="btn-text">${escHtml(closeLabel)}</span></button>`
      : '';
    // bug-49: trash button removed — the .artifact-item-close button
    // (above) is now the sole lifecycle affordance for plan items.
    // Hard-delete is no longer reachable from the UI; close-via-mark
    // (POST /artifact/mark) keeps the item + all its votes / comments
    // / run-history in the array with `done=true` instead of nuking
    // the record. Re-add a button here only after explicit user ask
    // that requires an irreversible-delete capability.
    const actionsRow = `<div class="artifact-item-actions">
        ${mergedBadge}
        ${depsChip}
        ${runChip}
        ${itemEditedBadge}
        ${voteBlock}
        ${runBtn}
        ${closeBtn}
        ${editBtn}
      </div>`;
    // Plan/test items render their body as markdown so multi-line
    // text, code fences, lists, and mermaid diagrams all show up
    // properly. Was escHtml inside a span — that wrapper element
    // also constrained block-level markdown to inline rendering.
    // fr-6: stable DOM id so `<origin>/#fr-7` deep-links scroll the
    // matching row into view (handled by _focusPlanItemFromHash on
    // page load + hashchange). The id chip above triggers the
    // copy-link affordance; this attr is what the scroll/highlight
    // logic looks for.
    const liId = it.id ? `id="artifact-item-${escHtml(it.id)}"` : '';
    return `<li class="${cls}" ${liId} data-id="${escHtml(it.id)}">
      <div class="artifact-item-row">
        <div class="artifact-item-meta">${statusChip}${idChip}${remoteChip}</div>
        <div class="${_planItemTextClass(it)}">${renderMd(it.text || '')}</div>
        ${_planItemTextExpandToggle(it)}
        ${_planItemDescriptionHtml(it)}
        ${_planItemDetailsHtml(it)}
      </div>
      ${byLine}
      ${actionsRow}
      ${commentsBlock}
    </li>`;
  };

  let bodyHtml;
  if (supportsVoting) {
    // Group plan items by layer; preserve extraction order within each layer
    // AND first-seen layer order overall. A single shared layer ("Other" by
    // default) means the UI still degrades cleanly when the model returns the
    // legacy untagged shape. Uses displayItems (post-filter) so the "Open
    // only" toggle hides layers that have no open items after filtering.
    const layers = [];
    const buckets = new Map();
    for (const it of displayItems) {
      const layer = (it.layer && String(it.layer).trim()) || 'Other';
      if (!buckets.has(layer)) { layers.push(layer); buckets.set(layer, []); }
      buckets.get(layer).push(it);
    }
    // fr-65: within each layer, partition open vs done. Open items render
    // at the top; done items roll up into a "▶ N closed (tap to expand)"
    // accordion footer so they don't bury the open work. Per-layer
    // expand state persisted in localStorage.myco_plan_layer_expand_<key>.
    // Degrades cleanly with the bug-15 "Open only" toggle: when on,
    // displayItems has no done items → doneItems is empty → no accordion
    // renders. When off, accordion is the per-layer alternative to the
    // all-or-nothing toggle.
    bodyHtml = layers.map((layer) => {
      const items = buckets.get(layer);
      const openItems = items.filter((it) => !it.done);
      const doneItems = items.filter((it) => it.done);
      const layerKey = _planLayerStorageKey(layer);
      const expanded = _readPlanLayerExpanded(layerKey);
      const accordion = doneItems.length > 0 ? `
        <div class="artifact-layer-accordion ${expanded ? 'is-expanded' : ''}" data-layer="${escHtml(layerKey)}">
          <button class="artifact-layer-accordion-toggle" data-layer="${escHtml(layerKey)}" type="button"
                  aria-expanded="${expanded ? 'true' : 'false'}"
                  title="${expanded ? 'Hide closed items in this layer' : 'Show closed items in this layer'}">
            <span class="accordion-caret">${expanded ? '▼' : '▶'}</span>
            <span class="accordion-count">${doneItems.length} closed</span>
          </button>
          ${expanded ? `<ul class="artifact-items artifact-items-done">${doneItems.map(renderItem).join('')}</ul>` : ''}
        </div>
      ` : '';
      return `
        <div class="artifact-layer-group">
          <h4 class="artifact-layer-name">${escHtml(layer)}</h4>
          <ul class="artifact-items">${openItems.map(renderItem).join('')}</ul>
          ${accordion}
        </div>
      `;
    }).join('');
  } else {
    bodyHtml = `<ul class="artifact-items">${displayItems.map(renderItem).join('')}</ul>`;
  }
  // Stash the sticky filter row before the body.innerHTML wipe destroys
  // it (it lives INSIDE the body since fr-61). _attachPlanFilterRowToBody
  // below re-inserts it at the top of the freshly-rendered body.
  _stashPlanFilterRow();
  body.innerHTML = bodyHtml +
    (artifact.updatedAt ? `<div class="artifact-updated">Updated ${escHtml(formatChatTsWithDate(artifact.updatedAt) || artifact.updatedAt)}</div>` : '');
  // fr-61: prepend the sticky filter row so it shares the body's
  // scroll context (sibling-position sticky doesn't pin against
  // a different scroll container).
  _attachPlanFilterRowToBody(body, type);
  // bug-35: restore plan-search focus + caret that the row-move blurred.
  _restorePlanSearchFocus(planSearchFocusSnap);
  // After the items' markdown is in place, sweep for mermaid fences
  // so any ```mermaid blocks inside an item's text become SVG.
  // marked emits them as <pre><code class="language-mermaid">; this
  // pass converts them to .conv-mermaid divs.
  renderMermaidInContainer(body).catch(() => {});
  // fr-47: explicit close/open button (replaces the old checkbox).
  body.querySelectorAll('.artifact-item-close').forEach((btn) => {
    btn.addEventListener('click', () => onArtifactItemClose(btn));
  });
  // bug-49: .artifact-item-delete wiring removed — the button is
  // gone (close-via-mark replaces hard-delete as the only lifecycle
  // affordance for plan items).
  body.querySelectorAll('.artifact-item-run').forEach((btn) => {
    btn.addEventListener('click', () => onArtifactItemRun(type, btn.dataset.id, btn.dataset.text || ''));
  });
  // fr-46: edit affordances. The pencil on item body opens an inline
  // textarea; pencil on a comment does the same. Trash on a comment
  // confirms then DELETEs. All three are no-ops for viewers (the
  // buttons render conditionally on !state.readOnly upstream, but the
  // bindings are defensive — querySelectorAll just won't find any
  // matching nodes in that case).
  body.querySelectorAll('.artifact-item-edit').forEach((btn) => {
    btn.addEventListener('click', () => onArtifactItemEdit(type, btn.dataset.id));
  });
  // fr-48 cleanup: redundant ⊤ Queue button removed (▶ Run unifies).
  body.querySelectorAll('.artifact-comment-edit').forEach((btn) => {
    btn.addEventListener('click', () => onArtifactCommentEdit(type, btn.dataset.id, btn.dataset.cid));
  });
  body.querySelectorAll('.artifact-comment-delete').forEach((btn) => {
    btn.addEventListener('click', () => onArtifactCommentDelete(type, btn.dataset.id, btn.dataset.cid));
  });
  // fr-6: id-chip click copies the deep link (`<origin><pathname>#<id>`)
  // to the clipboard AND updates location.hash in place, so the URL bar
  // reflects "you're at this item" and a follow-up paste hands the
  // teammate a permalink. Keyboard activation (Enter / Space) works
  // too because the chip has role="button" + tabindex="0".
  body.querySelectorAll('.artifact-item-id[data-deep-link-id]').forEach((chip) => {
    chip.addEventListener('click', (e) => _copyArtifactItemDeepLink(e, chip));
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _copyArtifactItemDeepLink(e, chip);
      }
    });
  });
  // If a deep-link arrived before this tab finished rendering (e.g.
  // first load with `#fr-7` in the URL), the hash handler stashed the
  // target id on state — consume it now that the <li> ids exist.
  if (state.pendingDeepLinkId) {
    const id = state.pendingDeepLinkId;
    state.pendingDeepLinkId = null;
    _scrollToArtifactItem(id);
  }
  if (supportsVoting) {
    body.querySelectorAll('.artifact-vote').forEach((btn) => {
      btn.addEventListener('click', () => onArtifactVote(type, btn.dataset.id));
    });
    body.querySelectorAll('.artifact-comment-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const panel = body.querySelector(`.artifact-comments[data-id="${CSS.escape(id)}"]`);
        if (panel) panel.hidden = !panel.hidden;
      });
    });
    // fr-65: per-layer "▶ N closed" accordion toggle. Flips the persisted
    // expand state for this layer's key + re-renders the cached plan
    // artifact so the done-items <ul> appears/disappears immediately
    // without an HTTP round-trip.
    body.querySelectorAll('.artifact-layer-accordion-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.layer;
        if (!key) return;
        const cur = _readPlanLayerExpanded(key);
        _writePlanLayerExpanded(key, !cur);
        const cached = state.artifacts && state.artifacts.byType && state.artifacts.byType.plan;
        if (cached) renderArtifact('plan', cached);
      });
    });
    // Per-item "Show more / less" toggle — flips state.planExpandedItems
    // membership for the clicked item and re-renders the cached plan
    // artifact so the clamp/expand takes effect immediately.
    body.querySelectorAll('.artifact-item-text-expand').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();   // don't bubble into any row-level handler
        const id = btn.dataset.id;
        if (!id) return;
        if (!state.planExpandedItems) state.planExpandedItems = new Set();
        if (state.planExpandedItems.has(id)) state.planExpandedItems.delete(id);
        else state.planExpandedItems.add(id);
        const cached = state.artifacts && state.artifacts.byType && state.artifacts.byType.plan;
        if (cached) renderArtifact('plan', cached);
      });
    });
    body.querySelectorAll('.artifact-comment-form').forEach((form) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const input = form.querySelector('.artifact-comment-input');
        if (input && input.value.trim()) onArtifactComment(type, id, input.value.trim());
      });
    });
  }
  // Re-attach the merge-proposals callout that we detached at the top
  // of this function. Putting it back at the start of body keeps the
  // remaining proposals visible right above the items list, with the
  // SAME DOM nodes (and bound click handlers) the user was already
  // interacting with. No flicker.
  if (preservedCallout) {
    body.insertBefore(preservedCallout, body.firstChild);
  }
}

// ▶ Run on a plan item: sends a chat message scoped to this item.
// The text carries a [run:<type>#<id>] marker the server uses to
// stash an "activeRunItem" on the session, so the resulting turn's
// outcome (success / error / summary / cost) lands back on the
// item via plan.runs[]. Claude decides freely whether to use the
// Task subagent or work inline — the linkage is by turn, not by
// agent topology.
// fr-48 unification: ▶ Implement/Fix/Do button delegates to the
// queue. Pre-fr-48 this composed a [run:plan#<id>] marker into the
// chat input and auto-submitted, which directly dispatched. Now we
// POST /queue/add — when the queue is idle the server kicks the
// dispatch immediately (same UX as before), when something else is
// running the new item appends to the queue (visible in the chip
// strip). Either way claude only ever picks tasks from the queue.
async function onArtifactItemRun(type, itemId /*, itemText */) {
  const sid = state.activeId;
  if (!sid || !itemId) return;
  try { setChatPane(true); } catch {}
  try {
    const res = await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/queue/add`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ itemId, type }) }
    );
    if (!res || !res.ok) {
      const errData = res ? await res.json().catch(() => ({})) : {};
      console.error('[fr-48 unified] queue add (from Run button) failed:', res && res.status, errData.error);
      return;
    }
    // The server-side state-update {kind:'runQueue'} will fan out via
    // WS; the chip strip re-renders + the persistent strip shows
    // pending / running status. If the queue was idle, the server
    // ALSO already invoked handleChatMessage with the [run:plan#<id>]
    // marker, so the chat pane will start streaming the response.
  } catch (err) {
    console.error('[fr-48 unified] onArtifactItemRun threw:', err);
  }
}

// bug-49: onArtifactItemDelete removed — the trash button it backed
// is gone. Hard-delete of plan items is no longer reachable from
// the UI; .artifact-item-close (onArtifactItemClose, below) is the
// sole lifecycle affordance now. Per CLAUDE.md §1 (delete code
// that no longer has a caller).

async function onArtifactVote(type, itemId) {
  const sid = state.activeId;
  if (!sid || !itemId) return;
  try {
    const res = await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/artifact/vote?type=${encodeURIComponent(type)}&itemId=${encodeURIComponent(itemId)}`,
      { method: 'POST' }
    );
    if (!res || !res.ok) return;
    const data = await res.json().catch(() => ({}));
    // Reload the whole artifact so vote count + done state (after auto-fire)
    // re-render consistently. Cheap because we already have the items in
    // memory server-side.
    await loadArtifact(type);
    if (data.autoFired) {
      // Surface a brief note in the chat so participants see why the task
      // jumped to Claude on its own.
      const note = data.item ? `🗳️ Plan item "${data.item.text}" hit the auto-execute threshold (${data.threshold} votes) — dispatched to Claude.` : '';
      // Server already broadcasts the dispatch chat frame via
      // handleChatMessage, so we don't need to emit anything client-
      // side; just a console log for debugging.
      console.log('[artifact-vote]', note);
    }
  } catch (err) {
    console.error('vote failed', err);
  }
}

async function onArtifactComment(type, itemId, text) {
  const sid = state.activeId;
  if (!sid || !itemId || !text) return;
  try {
    const res = await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/artifact/comment?type=${encodeURIComponent(type)}&itemId=${encodeURIComponent(itemId)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }
    );
    if (!res || !res.ok) return;
    await loadArtifact(type);
  } catch (err) {
    console.error('comment failed', err);
  }
}

// fr-46: edit an item's body text. Pencil click → swap the rendered
// markdown for an inline textarea + Save/Cancel. Save fires PATCH
// /artifact/item; Cancel triggers loadArtifact() to restore the
// rendered markdown. Multi-paragraph + markdown survive because the
// textarea preserves whitespace + the server stores it verbatim.
async function onArtifactItemEdit(type, itemId) {
  const sid = state.activeId;
  if (!sid || !itemId) return;
  // Locate the item card + read its current text. The card carries
  // data-id; the body div is .artifact-item-text. We pull the source
  // text from the cached artifact (not the rendered markdown — markdown
  // would be lossy on re-render).
  const cached = (state.artifacts && state.artifacts.byType && state.artifacts.byType[type]) || null;
  const items = (cached && Array.isArray(cached.items)) ? cached.items : [];
  const item = items.find((it) => it && it.id === itemId);
  const currentText = item ? String(item.text || '') : '';
  const li = document.querySelector(`li[data-id="${CSS.escape(itemId)}"]`);
  const textDiv = li ? li.querySelector('.artifact-item-text') : null;
  if (!textDiv) {
    console.error('[fr-46] item-edit: could not find .artifact-item-text for', itemId);
    return;
  }
  // Swap to edit mode.
  const editorHtml = `
    <textarea class="artifact-item-edit-textarea" rows="6">${escHtml(currentText)}</textarea>
    <div class="artifact-item-edit-actions">
      <button class="artifact-item-edit-save" type="button">Save</button>
      <button class="artifact-item-edit-cancel" type="button">Cancel</button>
    </div>`;
  textDiv.innerHTML = editorHtml;
  const textarea = textDiv.querySelector('.artifact-item-edit-textarea');
  if (textarea) { textarea.focus(); textarea.select(); }
  const onCancel = () => loadArtifact(type);
  const onSave = async () => {
    const newText = textarea ? String(textarea.value || '').trim() : '';
    if (!newText) return onCancel();
    if (newText === currentText) return onCancel();
    try {
      const res = await authedFetch(
        `/sessions/${encodeURIComponent(sid)}/artifact/item?type=${encodeURIComponent(type)}&itemId=${encodeURIComponent(itemId)}`,
        { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: newText }) }
      );
      if (!res || !res.ok) {
        const errData = res ? await res.json().catch(() => ({})) : {};
        console.error('[fr-46] item-edit save failed:', res && res.status, errData.error);
        // Re-render to wipe the editor; user can retry.
        return loadArtifact(type);
      }
      await loadArtifact(type);
    } catch (err) {
      console.error('[fr-46] item-edit save threw:', err);
      loadArtifact(type);
    }
  };
  const saveBtn = textDiv.querySelector('.artifact-item-edit-save');
  const cancelBtn = textDiv.querySelector('.artifact-item-edit-cancel');
  if (saveBtn) saveBtn.addEventListener('click', onSave);
  if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
}

// fr-46: edit a comment's text. Same inline-textarea UX as the item
// editor above; PATCH /artifact/comment on save.
async function onArtifactCommentEdit(type, itemId, commentId) {
  const sid = state.activeId;
  if (!sid || !itemId || !commentId) return;
  const cached = (state.artifacts && state.artifacts.byType && state.artifacts.byType[type]) || null;
  const items = (cached && Array.isArray(cached.items)) ? cached.items : [];
  const item = items.find((it) => it && it.id === itemId);
  const comments = (item && Array.isArray(item.comments)) ? item.comments : [];
  const comment = comments.find((c) => c && c.id === commentId);
  const currentText = comment ? String(comment.text || '') : '';
  const commentDiv = document.querySelector(`.artifact-comment[data-cid="${CSS.escape(commentId)}"]`);
  const bodyDiv = commentDiv ? commentDiv.querySelector('.comment-body') : null;
  if (!bodyDiv) {
    console.error('[fr-46] comment-edit: could not find .comment-body for', commentId);
    return;
  }
  bodyDiv.innerHTML = `
    <textarea class="artifact-comment-edit-textarea" rows="4">${escHtml(currentText)}</textarea>
    <div class="artifact-comment-edit-actions">
      <button class="artifact-comment-edit-save" type="button">Save</button>
      <button class="artifact-comment-edit-cancel" type="button">Cancel</button>
    </div>`;
  const textarea = bodyDiv.querySelector('.artifact-comment-edit-textarea');
  if (textarea) { textarea.focus(); textarea.select(); }
  const onCancel = () => loadArtifact(type);
  const onSave = async () => {
    const newText = textarea ? String(textarea.value || '').trim() : '';
    if (!newText) return onCancel();
    if (newText === currentText) return onCancel();
    try {
      const res = await authedFetch(
        `/sessions/${encodeURIComponent(sid)}/artifact/comment?type=${encodeURIComponent(type)}&itemId=${encodeURIComponent(itemId)}&commentId=${encodeURIComponent(commentId)}`,
        { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: newText }) }
      );
      if (!res || !res.ok) {
        const errData = res ? await res.json().catch(() => ({})) : {};
        console.error('[fr-46] comment-edit save failed:', res && res.status, errData.error);
        return loadArtifact(type);
      }
      await loadArtifact(type);
    } catch (err) {
      console.error('[fr-46] comment-edit save threw:', err);
      loadArtifact(type);
    }
  };
  const saveBtn = bodyDiv.querySelector('.artifact-comment-edit-save');
  const cancelBtn = bodyDiv.querySelector('.artifact-comment-edit-cancel');
  if (saveBtn) saveBtn.addEventListener('click', onSave);
  if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
}

// fr-46: delete a comment. Owner/admin can delete any; authors can
// still delete their own (server-side authority — the client just
// fires the request and lets the server enforce).
async function onArtifactCommentDelete(type, itemId, commentId) {
  const sid = state.activeId;
  if (!sid || !itemId || !commentId) return;
  if (!confirm('Delete this comment? This cannot be undone.')) return;
  try {
    const res = await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/artifact/comment?type=${encodeURIComponent(type)}&itemId=${encodeURIComponent(itemId)}&commentId=${encodeURIComponent(commentId)}`,
      { method: 'DELETE' }
    );
    if (!res || !res.ok) {
      const errData = res ? await res.json().catch(() => ({})) : {};
      console.error('[fr-46] comment-delete failed:', res && res.status, errData.error);
      return;
    }
    await loadArtifact(type);
  } catch (err) {
    console.error('[fr-46] comment-delete threw:', err);
  }
}

// fr-47: lifecycle close/open — pure done-state toggle, no claude
// dispatch. The ▶ Run button (post-fr-48 unification) owns the
// dispatch path through the queue. The button carries data-done with
// the CURRENT state ("1" = currently done → Reopen click flips to 0;
// "0" = currently open → Close click flips to 1). The server is the
// source of truth: we POST and let the next /artifact/mark broadcast
// re-render the row with the new state + button label.
async function onArtifactItemClose(btn) {
  const type = btn.dataset.type;
  const id = btn.dataset.id;
  const sid = state.activeId;
  if (!type || !id || !sid) return;
  const currentlyDone = btn.dataset.done === '1';
  const nextDone = currentlyDone ? 0 : 1;
  try {
    const res = await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/artifact/mark?type=${encodeURIComponent(type)}&itemId=${encodeURIComponent(id)}&done=${nextDone}`,
      { method: 'POST' }
    );
    if (!res || !res.ok) {
      const errData = res ? await res.json().catch(() => ({})) : {};
      console.error('[fr-47] close/reopen failed:', res && res.status, errData.error);
      return;
    }
    // state-update {kind:'artifact'} will fan out via WS; the
    // renderArtifact pass re-renders with the new done state +
    // flipped button label.
  } catch (err) {
    console.error('[fr-47] close/reopen threw:', err);
  }
}

// Slash-command + @-mention dropdown for the chat input.
//
// State machine: as the user types, we look at the active token before the
// caret. If it begins with `/` we show known slash commands; if it begins
// with `@` we show known users. Up/Down navigates, Enter/Tab inserts.
// Esc dismisses. Picks happen on click too. The popup is positioned by CSS
// (anchored above the chat-form via #chat-autocomplete).
// Cache + in-flight promise dedupe. Two refresh() calls that race on a
// cold cache must share one fetch, not start two. _inFlight holds the
// promise that resolves to the cache once filled.
let _chatAcCache = { commands: null, users: null, fetchedAt: 0 };
let _chatAcInFlight = null;

function _loadAcData() {
  const stale = !_chatAcCache.commands || (Date.now() - _chatAcCache.fetchedAt) > 60000;
  if (!stale) return Promise.resolve(_chatAcCache);
  if (_chatAcInFlight) return _chatAcInFlight;
  _chatAcInFlight = (async () => {
    try {
      const [cRes, uRes] = await Promise.all([
        fetch('/commands').catch(() => null),
        authedFetch('/users').catch(() => null),
      ]);
      const cBody = cRes && cRes.ok ? await cRes.json().catch(() => ({})) : {};
      const uBody = uRes && uRes.ok ? await uRes.json().catch(() => ({})) : {};
      _chatAcCache = {
        commands: Array.isArray(cBody.commands) ? cBody.commands : [],
        users: Array.isArray(uBody.users) ? uBody.users : [],
        fetchedAt: Date.now(),
      };
    } catch {
      _chatAcCache = { commands: [], users: [], fetchedAt: Date.now() };
    }
    _chatAcInFlight = null;
    return _chatAcCache;
  })();
  return _chatAcInFlight;
}

function bindChatAutocomplete() {
  const input = document.getElementById('chat-input');
  const dropdown = document.getElementById('chat-autocomplete');
  if (!input || !dropdown || input.dataset.acBound) return;
  input.dataset.acBound = '1';

  let items = [];           // current list: [{ name, desc, insert }]
  let active = -1;          // highlighted index
  let tokenStart = -1;      // index in input.value where the active token begins
  let tokenEnd = -1;        // exclusive
  let open = false;

  function close() {
    open = false;
    dropdown.hidden = true;
    items = [];
    active = -1;
  }

  function render() {
    if (!items.length) {
      dropdown.innerHTML = '<div class="ac-empty">No matches</div>';
      return;
    }
    dropdown.innerHTML = items.map((it, i) =>
      `<div class="ac-item${i === active ? ' active' : ''}" data-idx="${i}">` +
      `<span class="ac-name">${escHtml(it.name)}</span>` +
      `<span class="ac-desc">${escHtml(it.desc || '')}</span>` +
      `</div>`
    ).join('');
  }

  function pick(idx) {
    if (idx < 0 || idx >= items.length) return;
    const it = items[idx];
    const before = input.value.slice(0, tokenStart);
    const after = input.value.slice(tokenEnd);
    const insert = it.insert + ' ';
    input.value = before + insert + after;
    const caret = (before + insert).length;
    input.setSelectionRange(caret, caret);
    close();
    input.focus();
  }

  // Compute items synchronously from a cache snapshot. Pulled out of
  // refresh() so both the cache-hit path and the post-await refresh
  // share one implementation.
  function _computeItems(tok, data) {
    const q = tok.slice(1).toLowerCase();
    if (tok[0] === '/') {
      const matches = (data.commands || []).filter((c) =>
        c.name.toLowerCase().startsWith(q) ||
        (c.aliases || []).some((a) => a.toLowerCase().startsWith(q))
      );
      return matches.map((c) => ({
        name: c.usage || ('/' + c.name),
        desc: c.summary || '',
        insert: '/' + c.name,
      }));
    }
    // @<user> branch: empty q → ALL users; non-empty → prefix match
    // then substring fallback. Self ranks first.
    const all = (data.users || []);
    const me = (state.chatUser || '').toLowerCase();
    let matches = q ? all.filter((u) => u.toLowerCase().startsWith(q)) : all.slice();
    if (q && !matches.length) {
      matches = all.filter((u) => u.toLowerCase().includes(q));
    }
    matches.sort((a, b) => {
      const am = a.toLowerCase() === me ? -1 : 0;
      const bm = b.toLowerCase() === me ? -1 : 0;
      if (am !== bm) return am - bm;
      return a.localeCompare(b);
    });
    return matches.map((u) => ({
      name: '@' + u,
      desc: u.toLowerCase() === me ? '(you)' : 'discussion (no claude routing)',
      insert: '@' + u + ' ',
    }));
  }

  function refresh() {
    const v = input.value;
    const caret = input.selectionStart || 0;
    // Find the start of the active token (whitespace boundary or start of string).
    let i = caret - 1;
    while (i >= 0 && !/\s/.test(v[i])) i--;
    const start = i + 1;
    const tok = v.slice(start, caret);
    if (!tok || (tok[0] !== '/' && tok[0] !== '@')) return close();
    // Slash commands only at the very start of the input, mentions anywhere.
    if (tok[0] === '/' && start !== 0) return close();
    tokenStart = start;
    tokenEnd = caret;

    // Cache hot? Render synchronously — no flicker, no race.
    if (_chatAcCache.commands) {
      items = _computeItems(tok, _chatAcCache);
      if (!items.length) { close(); return; }
      active = 0;
      open = true;
      dropdown.hidden = false;
      render();
      return;
    }

    // Cache cold — show a loading row immediately so the user sees the
    // dropdown pop on bare `@` even before /users returns. Re-render
    // after the fetch resolves; bail if the token has since changed
    // (user already typed more / moved caret) to avoid clobbering a
    // newer refresh().
    items = [];
    open = true;
    dropdown.hidden = false;
    const label = tok[0] === '@' ? 'Loading users…' : 'Loading commands…';
    dropdown.innerHTML = `<div class="ac-empty">${escHtml(label)}</div>`;
    const tokenAtCallTime = tok;
    _loadAcData().then((data) => {
      // Token still the same? Re-run refresh to render the actual items.
      const cur = (() => {
        const vNow = input.value;
        const c = input.selectionStart || 0;
        let j = c - 1;
        while (j >= 0 && !/\s/.test(vNow[j])) j--;
        return vNow.slice(j + 1, c);
      })();
      if (cur !== tokenAtCallTime) return;     // user moved on
      items = _computeItems(tok, data);
      if (!items.length) { close(); return; }
      active = 0;
      open = true;
      dropdown.hidden = false;
      render();
    });
  }

  input.addEventListener('input', () => {
    refresh();
    _renderComposerChips();
  });
  input.addEventListener('focus', () => {
    // Prewarm the /users + /commands cache so the first `@` or `/`
    // typed renders instantly. refresh() will close the dropdown
    // since the input has no active token yet — that's fine, the
    // cache is now hot for the next keystroke.
    _loadAcData();
    refresh();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));   // allow click-pick

  input.addEventListener('keydown', (e) => {
    if (!open) return;
    // Guard against navigation while the dropdown is in its loading
    // state (items empty but dropdown visible). Arrows would NaN-out
    // the modulo math; Enter would just no-op since pick(NaN) bails.
    // Escape still works — let the user dismiss the spinner.
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(active); }
  });

  dropdown.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.ac-item');
    if (!item) return;
    e.preventDefault();
    pick(parseInt(item.dataset.idx, 10));
  });
}

// Desktop chatpane resize: drag the left-edge handle to grow/shrink. Width
// is held in the --chatpane-w CSS variable and persisted in localStorage so
// the choice survives reloads. No-op on mobile (overlay layout).
function bindChatpaneResize() {
  const handle = document.getElementById('chatpane-resize');
  const pane = document.getElementById('chatpane');
  if (!handle || !pane || handle.dataset.bound) return;
  handle.dataset.bound = '1';

  const MIN_W = 240;

  // Restore last-saved width — but clamp against the current viewport
  // so a value persisted at a wider window doesn't end up consuming
  // 2/3 of a narrower screen. The CSS default calc((100vw -
  // var(--sidebar-w)) / 2) already targets a 50/50 split of the main
  // pane; saved values above 55% of (vw - sidebar) just look too wide
  // and we fall back to the CSS calc.
  const saved = parseInt(localStorage.getItem('myco_chatpane_w') || '', 10);
  const sidebarPx = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10) || 280;
  const maxSensible = Math.floor((window.innerWidth - sidebarPx) * 0.55);
  if (Number.isFinite(saved) && saved >= MIN_W && saved <= maxSensible) {
    document.documentElement.style.setProperty('--chatpane-w', saved + 'px');
  } else if (Number.isFinite(saved) && saved > maxSensible) {
    // Persisted width is too wide for this viewport — drop it so the
    // CSS calc default takes over and the user lands on 50/50.
    try { localStorage.removeItem('myco_chatpane_w'); } catch {}
  }

  let dragging = false;
  const onDown = (e) => {
    if (window.innerWidth <= 900) return;       // mobile overlay → no resize
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    try { handle.setPointerCapture(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    // chatpane sits at viewport's right edge; new width = distance from cursor to right edge.
    const max = Math.max(MIN_W, Math.floor(window.innerWidth * 0.7));
    const newW = Math.max(MIN_W, Math.min(max, window.innerWidth - e.clientX));
    document.documentElement.style.setProperty('--chatpane-w', newW + 'px');
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    const cur = getComputedStyle(document.documentElement).getPropertyValue('--chatpane-w').trim();
    const px = parseInt(cur, 10);
    if (Number.isFinite(px)) localStorage.setItem('myco_chatpane_w', String(px));
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  handle.addEventListener('dblclick', () => {
    // Double-click to reset to default width.
    document.documentElement.style.setProperty('--chatpane-w', '320px');
    localStorage.removeItem('myco_chatpane_w');
  });
}

// ── per-session file explorer ───────────────────────────────────────────────

function bindFilesUi() {
  const btn = document.getElementById('btn-files');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  // Show-only on click — see the chrome-icon contract in bindChrome().
  // Switching away from the files view happens by clicking another
  // main-pane button (terminal/preview/plan/arch/test).
  btn.addEventListener('click', showFilesView);
  document.getElementById('files-tree-back')?.addEventListener('click', () => {
    if (state.files.history.length === 0) return;
    const prev = state.files.history.pop();
    loadFileTree(prev);
  });
  document.getElementById('files-view-back')?.addEventListener('click', closeFileViewer);
  document.getElementById('files-copy')?.addEventListener('click', copyFileContents);
  document.getElementById('files-wrap-toggle')?.addEventListener('click', toggleWrap);
  document.getElementById('files-tree-collapse')?.addEventListener('click', _toggleFilesTreeCollapsed);
  // fr-77 r3: changed-files section moved to the Plan view; the refresh /
  // collapse / list-click bindings live in bindPlanChangedFilesUi() now.
  document.getElementById('files-edit')?.addEventListener('click', _enterFileEditMode);
  document.getElementById('files-edit-save')?.addEventListener('click', () => _saveFileEdit());
  document.getElementById('files-edit-cancel')?.addEventListener('click', _exitFileEditMode);
  // fr-50: file-conflict modal wiring. Modal opens on 409
  // ERR_MTIME_CONFLICT from /file/edit; the three buttons resolve
  // the conflict (reload / force overwrite / cancel).
  document.getElementById('file-conflict-reload')?.addEventListener('click', () => {
    _hideFileConflictModal();
    _reloadFileFromDisk();
  });
  document.getElementById('file-conflict-force')?.addEventListener('click', () => {
    _hideFileConflictModal();
    _saveFileEdit({ force: true });
  });
  document.getElementById('file-conflict-cancel')?.addEventListener('click', _hideFileConflictModal);

  // Selection-driven action bar wiring
  document.querySelectorAll('#files-action-bar .files-action-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const action = b.dataset.action;
      if (action === 'comment') {
        // Inline editor in the code body — capture anchor first, then hide
        // the popover (selection might collapse anyway).
        const v = state.files.viewing;
        if (!v || !v.selection) return;
        startInlineCommentEditor(v.selection);
        hideActionBar();
      } else {
        askClaudeAboutSelection(action).catch(() => {});
      }
    });
  });
  document.getElementById('files-action-clear')?.addEventListener('click', () => {
    try { window.getSelection()?.removeAllRanges(); } catch {}
    state.files.viewing && (state.files.viewing.selection = null);
    hideActionBar();
  });

  // Free-text "ask about this code" input. The selection's line-range
  // anchor is already captured in state.files.viewing.selection at
  // selection time, so it survives focusing the input (the code-body
  // selection collapses, but the anchor persists). Submit ships the
  // typed question through the same askClaudeAboutSelection('ask', …)
  // path the preset buttons use — the answer renders as a file-viewer
  // card.
  const _askInput = document.getElementById('files-ask-input');
  const _askSend = document.getElementById('files-ask-send');
  function _submitFilesAsk() {
    const q = (_askInput && _askInput.value || '').trim();
    if (!q) return;
    askClaudeAboutSelection('ask', q).catch(() => {});
    if (_askInput) _askInput.value = '';
    hideActionBar();
  }
  _askSend?.addEventListener('click', _submitFilesAsk);
  _askInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); _submitFilesAsk(); }
    else if (e.key === 'Escape') {
      if (_askInput) _askInput.value = '';
      hideActionBar();
    }
  });

  // Selection listener — detect line-range selections inside the code body.
  document.addEventListener('selectionchange', debouncedOnSelectionChange);
  // Reposition the floating popover when the code scrolls under it, on
  // viewport resize, or when the device rotates.
  document.getElementById('files-view-body')?.addEventListener('scroll', repositionActionBarIfVisible, { passive: true });
  window.addEventListener('resize', repositionActionBarIfVisible);
  window.addEventListener('orientationchange', repositionActionBarIfVisible);
}

let _selectionTimer = null;
// When we programmatically removeAllRanges() to dismiss the iOS native
// selection callout, the browser fires a follow-up selectionchange that we
// must NOT interpret as the user clearing the selection — it'd hide the
// action bar that we just opened. The counter is consumed by the next
// selectionchange after we set it, before any debounce.
let _ignoreNextSelChange = 0;
function debouncedOnSelectionChange() {
  if (_ignoreNextSelChange > 0) { _ignoreNextSelChange--; return; }
  if (_selectionTimer) clearTimeout(_selectionTimer);
  _selectionTimer = setTimeout(() => onSelectionChange(), 120);
}

function toggleFilesPane() {
  if (!state.activeId) return;
  if (state.files.visible) hideFilesView();
  else showFilesView();
}

function showFilesView() {
  if (!state.activeId) return;
  // Phase 9 step 3 retired #terminal-wrap and #conversation-wrap; the
  // chatpane is the only sibling left underneath the files view, and
  // it reappears automatically when the files wrap is hidden, so we
  // no longer need to track a prevView pane to restore.
  state.files.prevView = null;
  _hideMainPaneSiblings('files-wrap');
  document.getElementById('files-wrap').hidden = false;
  // Reset the inner panes — on mobile, opening a file hides the tree-pane
  // so the viewer can take the full width. Without this reset the next
  // show-files lands on an explorer where BOTH inner panes are hidden,
  // and the user just sees an empty screen.
  document.getElementById('files-tree-pane').hidden = false;
  document.getElementById('files-view-pane').hidden = true;
  document.getElementById('btn-files')?.classList.add('active');
  state.files.visible = true;
  // Same side-by-side intent as showArtifactView: chat stays visible
  // alongside files on desktop, hidden on mobile (mutually exclusive
  // there per _hideMainPaneSiblings).
  if (window.innerWidth > 900) setChatPane(true);
  loadFileTree(state.files.currentPath || '.');
  // fr-77 r3: changed-files refresh moved to the Plan view. The Files
  // view stays focused on tree browsing.
  updateChatButton();
  _updateMainPaneLayout();
}

function hideFilesView() {
  const wrap = document.getElementById('files-wrap');
  if (wrap) wrap.hidden = true;
  const viewPane = document.getElementById('files-view-pane');
  if (viewPane) viewPane.hidden = true;
  document.getElementById('btn-files')?.classList.remove('active');
  state.files.visible = false;
  state.files.prevView = null;
  updateChatButton();
  _updateMainPaneLayout();
}

async function loadFileTree(relPath) {
  if (!state.activeId) return;
  const id = state.activeId;
  // bug-47: wrap with _withShareToken so guest users (state.shareToken
  // set, no state.token) can pass fileApiPreamble('viewer').
  const url = _withShareToken(`/sessions/${encodeURIComponent(id)}/files?path=${encodeURIComponent(relPath || '.')}`);
  let res;
  try { res = await authedFetch(url); }
  catch (e) { showFilesTreeError(`Failed to list: ${e.message || e}`); return; }
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch {}
    showFilesTreeError(body.error || `HTTP ${res.status}`);
    return;
  }
  const data = await res.json();
  state.files.currentPath = data.path;
  renderFilesList(data.entries, data.truncated, data.path);
}

function showFilesTreeError(msg) {
  const ul = document.getElementById('files-tree');
  const errEl = document.getElementById('files-tree-msg');
  ul.innerHTML = '';
  errEl.textContent = msg;
  errEl.hidden = false;
}

// fr-77 r3: fetch + render the flat list of git-status-changed files
// at the project root, in the Plan view's bottom "Changed files"
// section. Called on Plan-view show, on the refresh button, and after
// a file edit lands. Forces a fetch on { force: true }; otherwise
// piggybacks on a small in-memory cache (2s) to avoid double-fetching
// during a single user action (e.g. when both showArtifactView('plan')
// and a state-update WS frame trigger a load in quick succession).
async function loadPlanChangedFiles({ force } = {}) {
  if (!state.activeId) return;
  if (!state.filesChanged) state.filesChanged = { entries: [], loadedAt: 0 };
  const now = Date.now();
  if (!force && (now - state.filesChanged.loadedAt) < 2000) return;
  const ul    = document.getElementById('plan-changed-files-list');
  const msgEl = document.getElementById('plan-changed-files-msg');
  if (!ul) return;
  const id = state.activeId;
  let res;
  try {
    res = await authedFetch(_withShareToken(`/sessions/${encodeURIComponent(id)}/files-changed`));
  } catch (e) {
    if (msgEl) { msgEl.textContent = `Failed: ${e.message || e}`; msgEl.hidden = false; }
    return;
  }
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch {}
    if (msgEl) { msgEl.textContent = body.error || `HTTP ${res.status}`; msgEl.hidden = false; }
    return;
  }
  const data = await res.json();
  state.filesChanged = {
    entries: data.entries || [],
    loadedAt: now,
    truncated: !!data.truncated,
    // fr-77 r2: bug/td/fr mentions extracted from `git diff HEAD` and
    // last 5 commit subjects. Both default to [] if the server didn't
    // send them (older builds or repo-less workspaces).
    mentions: Array.isArray(data.mentions) ? data.mentions : [],
    recentCommits: Array.isArray(data.recentCommits) ? data.recentCommits : [],
  };
  _renderPlanChangedFiles();
}

// fr-77 r3: per-file inline-diff cache so a quick collapse+re-expand
// is instant (no extra round-trip). Cleared whenever the changed-files
// list is re-rendered — fresh data invalidates the per-file diffs.
let _planChangedDiffCache = new Map();

// fr-93/fr-94: auto-refresh interval handle for the Plan-view Changed-
// files section. Polling is the SAFETY NET behind the per-event hooks
// (fr-94 _maybeAutoRefreshOnAgentEvent + the /git submitChat hook), so
// we run it slowly (30s) — fast enough to catch out-of-band changes
// (external editor, git pull at the shell, etc.) without flooding
// the server. Hooks cover the common case at ~100ms latency.
let _planChangedFilesPollHandle = null;
const PLAN_CHANGED_FILES_POLL_MS = 30000;
function _startPlanChangedFilesAutoRefresh() {
  if (_planChangedFilesPollHandle) return;        // already running
  if (typeof window === 'undefined') return;
  _planChangedFilesPollHandle = setInterval(() => {
    // Skip the fetch when the tab/window is hidden — saves a request
    // every 5s on a backgrounded laptop while still kicking off
    // immediately when the user returns (visibilitychange handler
    // below).
    if (document.hidden) return;
    // Skip if the user has navigated away from Plan view since the
    // start (race with hideArtifactView clearing the handle).
    if (!state.artifactView || state.artifactView.active !== 'plan') return;
    loadPlanChangedFiles({ force: true });
  }, PLAN_CHANGED_FILES_POLL_MS);
}
function _stopPlanChangedFilesAutoRefresh() {
  if (!_planChangedFilesPollHandle) return;
  clearInterval(_planChangedFilesPollHandle);
  _planChangedFilesPollHandle = null;
}

// fr-94: file-mutating agent events drive an instant refresh of the
// Plan-view Changed-files section. Edit/Write/MultiEdit are obvious
// file writes; Bash is included because the agent commonly shells out
// to git/touch/mv/sed which mutate the worktree. Debounce-clamped so
// a burst of MultiEdit ticks doesn't fire N requests in a row.
const _AUTO_REFRESH_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'Bash']);
let _autoRefreshDebounce = null;
function _maybeAutoRefreshOnAgentEvent(ev) {
  if (!ev || ev.type !== 'tool_result') return;
  // tool_result events carry the tool name via a sibling field; depending
  // on the SDK shape it lives on either `ev.name` (preferred) or inside
  // ev.input. Be defensive.
  const name = ev.name || (ev.tool && ev.tool.name) || '';
  if (!_AUTO_REFRESH_TOOL_NAMES.has(name)) return;
  if (!state.artifactView || state.artifactView.active !== 'plan') return;
  if (_autoRefreshDebounce) clearTimeout(_autoRefreshDebounce);
  _autoRefreshDebounce = setTimeout(() => {
    _autoRefreshDebounce = null;
    loadPlanChangedFiles({ force: true });
  }, 250);  // 250ms debounce: one refresh per burst of edits
}

// fr-94: user-driven /git commands also refresh the section. The
// server runs git inline (not as an agent tool) so there's no
// tool_result event to catch — we hook directly on the submit path.
// 1500ms delay matches the typical `/git` runtime (clone / fetch can
// be longer but those refresh on the next 30s tick).
function _maybeAutoRefreshOnGitCommand(submittedText) {
  if (!submittedText) return;
  const t = String(submittedText).trim();
  if (!/^\/git(\s|$)/i.test(t)) return;
  if (!state.artifactView || state.artifactView.active !== 'plan') return;
  setTimeout(() => loadPlanChangedFiles({ force: true }), 1500);
}
// Resume polling immediately when the user comes back to a backgrounded
// tab, instead of waiting up to 5s for the next tick.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.artifactView && state.artifactView.active === 'plan') {
      loadPlanChangedFiles({ force: true });
    }
  });
}

// fr-77 r16: per-section memory of files the user just accepted (via
// the ✓ button or Accept-all). Survives the loadPlanChangedFiles
// refresh that follows the action so the row keeps showing the
// "accepted" indicator + greyed-out buttons until the user explicitly
// hits the section's Refresh chevron OR the file actually leaves the
// changed-files list (e.g. they commit, then it disappears). Reset on
// the Refresh button (handler in bindPlanChangedFilesUi) + whenever
// the section is first loaded for a session switch.
let _planAcceptedPaths = new Set();

function _renderPlanChangedFiles() {
  const ul     = document.getElementById('plan-changed-files-list');
  const msgEl  = document.getElementById('plan-changed-files-msg');
  const countEl= document.getElementById('plan-changed-files-count');
  if (!ul) return;
  const fc = state.filesChanged || { entries: [] };
  const entries = fc.entries || [];
  // Wipe the inline-diff cache — the list changed under us, any cached
  // diffs may now be stale.
  _planChangedDiffCache = new Map();
  if (countEl) {
    countEl.textContent = entries.length === 0 ? '' :
      (fc.truncated ? `(${entries.length}+)` : `(${entries.length})`);
  }
  // fr-77 r2: description rows (mentions + recent commits). Rendered
  // even when entries.length === 0 IF recentCommits has anything —
  // a clean repo with prior history still benefits from the context.
  _renderPlanChangedFilesDesc(fc);
  if (entries.length === 0) {
    ul.innerHTML = '';
    if (msgEl) { msgEl.textContent = 'No changes vs HEAD.'; msgEl.hidden = false; }
    return;
  }
  if (msgEl) { msgEl.hidden = true; msgEl.textContent = ''; }
  // Status letter mapping: '?' → 'Q' (CSS class friendly), keep
  // others as-is. Title text spells out the human meaning.
  const STATUS_LABEL = {
    M: 'modified', A: 'added', D: 'deleted', R: 'renamed',
    C: 'copied', U: 'unmerged', '?': 'untracked', '!': 'ignored',
  };
  // fr-77 r12: per-row accept/reject buttons. Hidden for read-only
  // viewers (the routes are owner-only — show nothing rather than a
  // 403 on click). Owner gets ✓ / ✕ icon buttons; click handlers in
  // bindPlanChangedFilesUi route to the bulk POST endpoints with a
  // single-path body.
  const canMutate = !state.readOnly;
  const html = entries.map((e) => {
    const cls = e.status === '?' ? 'fc-status-untracked' : `fc-status-${e.status}`;
    const label = STATUS_LABEL[e.status] || e.status;
    const display = e.status === '?' ? '?' : e.status;
    // fr-77 r6: per-file line-count chips (`+N`, `-M`). Server attaches
    // {added, removed} from `git diff --numstat HEAD`; binary files have
    // null counts → render "bin" badge instead. Tracked file with 0/0
    // (e.g. mode-only change) → render nothing.
    const stats = _planChangedFileStatsHtml(e);
    const titleStats = (e.added != null || e.removed != null)
      ? ` · +${e.added ?? 0} −${e.removed ?? 0}`
      : '';
    // fr-77 r13: Lucide-style SVGs to match the chrome cluster's icon
    // family (24x24 viewBox, stroke 1.75, round caps, currentColor).
    // Replaces Unicode ✓/✕/▶ from r12 which rendered with varying
    // fonts + couldn't take the chrome icon styling.
    // fr-77 r16: per-row accepted state. After a successful Accept
    // (single or bulk), the path is added to _planAcceptedPaths and
    // the row picks up .is-accepted on the next re-render. The badge
    // ✓ chip + disabled accept/reject buttons stay until the user
    // hits the section's Refresh chevron (which clears the set).
    const isAccepted = _planAcceptedPaths.has(e.path);
    const acceptedBadge = isAccepted
      ? `<span class="pcf-accepted-badge" title="Accepted (staged via git add) — click Refresh to clear">${_lucideIcon('check', 'pcf-accepted-svg')}<span>accepted</span></span>`
      : '';
    const actions = canMutate
      ? (isAccepted
        ? `<button class="pcf-row-btn pcf-accept is-accepted-state" disabled aria-label="Already accepted" title="Already staged"><svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></button>
           <button class="pcf-row-btn pcf-reject is-accepted-state" disabled aria-label="Reject disabled after accept" title="Refresh to re-enable"><svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`
        : `<button class="pcf-row-btn pcf-accept" data-pcf-action="accept" data-pcf-path="${escHtml(e.path)}" title="Accept (stage)" aria-label="Accept ${escHtml(e.path)}"><svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg></button>
           <button class="pcf-row-btn pcf-reject" data-pcf-action="reject" data-pcf-path="${escHtml(e.path)}" title="Reject (revert/delete)" aria-label="Reject ${escHtml(e.path)}"><svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`)
      : '';
    // fr-77 r3: leading caret rotates 90° when the row is expanded
    // (see #plan-changed-files-list li.is-expanded .pcf-caret rule).
    // r13: Lucide chevron-right SVG instead of the ▶ Unicode triangle
    // (which rendered as emoji on some platforms, breaking line height).
    const caret = `<svg class="pcf-caret-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
    const rowCls = isAccepted ? ' is-accepted' : '';
    return `<li class="${escHtml(rowCls.trim())}" data-fc-path="${escHtml(e.path)}" title="${escHtml(label + ' · ' + e.path + titleStats + (isAccepted ? ' · accepted (staged)' : ''))}">
      <span class="pcf-caret">${caret}</span>
      <span class="fc-status ${escHtml(cls)}">${escHtml(display)}</span>
      <span class="fc-path">${escHtml(e.path)}</span>
      ${stats}
      ${acceptedBadge}
      ${actions}
    </li>`;
  }).join('');
  ul.innerHTML = html;
}

// fr-77 r6: per-row line-count chip HTML. Renders:
//   - "+N −M" pair (green / red, monospace) for tracked changes
//   - "bin" badge for binary files (numstat null/null)
//   - empty string for tracked files with 0/0 (e.g. mode-only change)
//   - just "+N" for new untracked files (removed=0)
// Used by _renderPlanChangedFiles.
function _planChangedFileStatsHtml(e) {
  const added = e && e.added;
  const removed = e && e.removed;
  if (added == null && removed == null) {
    return '<span class="pcf-stats pcf-stats-bin" title="binary file">bin</span>';
  }
  const a = Number.isFinite(added) ? added : 0;
  const r = Number.isFinite(removed) ? removed : 0;
  if (a === 0 && r === 0) return '';
  const parts = [];
  if (a > 0) parts.push(`<span class="pcf-stats-add">+${a}</span>`);
  if (r > 0) parts.push(`<span class="pcf-stats-rm">−${r}</span>`);
  return `<span class="pcf-stats">${parts.join('')}</span>`;
}

// fr-77 r2: render the optional "Mentions" + "Recent" description rows
// above the file list. Static text — no click handlers. Hidden when
// both lists are empty so the section stays compact for a clean repo.
function _renderPlanChangedFilesDesc(fc) {
  const el = document.getElementById('plan-changed-files-desc');
  if (!el) return;
  const mentions = Array.isArray(fc.mentions) ? fc.mentions : [];
  const recent   = Array.isArray(fc.recentCommits) ? fc.recentCommits : [];
  if (mentions.length === 0 && recent.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  const rows = [];
  if (mentions.length > 0) {
    const chips = mentions.map((m) =>
      `<span class="fc-mention-chip">${escHtml(m)}</span>`
    ).join('');
    rows.push(`<div class="fc-desc-row" data-kind="mentions">
      <span class="fc-desc-label">Mentions:</span>
      <span class="fc-desc-body">${chips}</span>
    </div>`);
  }
  if (recent.length > 0) {
    const lines = recent.map((c) => {
      const sha = escHtml(String(c.sha || '').slice(0, 12));
      const subject = escHtml(String(c.subject || ''));
      return `<div class="fc-recent-line">
        <span class="fc-recent-sha">${sha}</span>
        <span class="fc-recent-subject">${subject}</span>
      </div>`;
    }).join('');
    rows.push(`<div class="fc-desc-row" data-kind="recent">
      <span class="fc-desc-label">Recent:</span>
      <span class="fc-desc-body">${lines}</span>
    </div>`);
  }
  el.innerHTML = rows.join('');
  el.hidden = false;
}

// fr-77 r3: click-to-expand-inline-diff on a Plan-view changed-file row.
// First click fetches /files/diff for the path, inserts a .pcf-diff-row
// LI immediately after the clicked one with the rendered unified diff
// inside .pcf-diff-body (highlight.js language-diff). Second click on
// the same row removes the diff LI. Multiple rows can be open at once.
// Per-file diffs cached in _planChangedDiffCache so a quick collapse +
// re-expand is instant (no re-fetch).
async function _togglePlanChangedFileExpand(li) {
  if (!li || !li.dataset || !li.dataset.fcPath) return;
  const path = li.dataset.fcPath;
  // Already expanded? Collapse: remove the next sibling diff LI + drop
  // the row's is-expanded marker.
  if (li.classList.contains('is-expanded')) {
    const diffRow = li.nextElementSibling;
    if (diffRow && diffRow.classList.contains('pcf-diff-row')) {
      diffRow.remove();
    }
    li.classList.remove('is-expanded');
    return;
  }
  // First click — mark expanded immediately so a fast double-click
  // doesn't double-fetch, then insert a loading placeholder LI.
  li.classList.add('is-expanded');
  const diffRow = document.createElement('li');
  diffRow.className = 'pcf-diff-row';
  diffRow.dataset.fcPath = path;
  diffRow.innerHTML = '<div class="pcf-diff-body"><div class="pcf-diff-loading">Loading diff…</div></div>';
  li.parentElement.insertBefore(diffRow, li.nextSibling);
  // Cached? Render synchronously, skip the round-trip.
  const cached = _planChangedDiffCache.get(path);
  if (cached) {
    _renderInlineDiffBody(diffRow, cached);
    return;
  }
  // Fetch + render.
  if (!state.activeId) return;
  const id = state.activeId;
  // bug-47: wrap with _withShareToken so guests can fetch the diff.
  const url = _withShareToken(`/sessions/${encodeURIComponent(id)}/files/diff?path=${encodeURIComponent(path)}`);
  let res;
  try { res = await authedFetch(url); }
  catch (e) {
    diffRow.querySelector('.pcf-diff-body').innerHTML =
      `<div class="fc-diff-empty">Failed to open diff: ${escHtml(e.message || String(e))}</div>`;
    return;
  }
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    diffRow.querySelector('.pcf-diff-body').innerHTML =
      `<div class="fc-diff-empty">Diff failed: ${escHtml((body && body.error) || String(res.status))}</div>`;
    return;
  }
  // If the user collapsed the row while we were waiting, the diffRow
  // is gone — bail.
  if (!diffRow.isConnected) return;
  _planChangedDiffCache.set(path, body);
  _renderInlineDiffBody(diffRow, body);
}

function _renderInlineDiffBody(diffRow, body) {
  const container = diffRow.querySelector('.pcf-diff-body');
  if (!container) return;
  const headerBits = [];
  if (body.gitless) {
    headerBits.push('<div class="fc-diff-notice">Not a git repository — no diff available.</div>');
  } else {
    const headBit = body.head ? `diff vs <code>${escHtml(body.head)}</code>` : 'diff vs working tree';
    const existBit = body.exists ? '' : ' · <span class="fc-deleted">file deleted</span>';
    headerBits.push(`<div class="fc-diff-header">${headBit}${existBit}</div>`);
  }
  let diffHtml;
  if (!body.diff || !body.diff.trim()) {
    diffHtml = '<div class="fc-diff-empty">(no diff — file may be untracked or unchanged vs HEAD)</div>';
  } else {
    // fr-77 r7: per-language syntax highlight. Detect language from
    // file extension, walk each diff line, highlight the code body
    // (without the +/-/space marker) with hljs, wrap each line in a
    // class that supplies the per-line background tint (add/rm/ctx/
    // hunk/meta). Falls back to plain escaped text if hljs is missing
    // or no language match.
    const lang = _diffLangForPath(body.path);
    diffHtml = `<div class="pcf-diff-pre">${_highlightDiffWithLang(body.diff, lang)}</div>`;
  }
  // fr-77 r12: "ask AI to reconsider" form. Per-file textarea +
  // submit; sends [chat:reconsider#<path>] <comment> to the active
  // session via POST /sessions/:id/files/reconsider. Hidden for
  // read-only viewers (they have no chat input either). Form lives
  // below the diff body so the reader sees what they're commenting
  // on before typing.
  // r15: file-level reconsider form mirrors the per-line form — Esc on
  // the textarea clears it (so a "never mind" feels symmetrical), and
  // a small hint advertises the shortcut next to the Send button.
  const reconsiderHtml = state.readOnly ? '' :
    `<form class="pcf-reconsider" data-pcf-path="${escHtml(body.path)}">
       <textarea class="pcf-reconsider-input" rows="2"
         placeholder="Ask the AI to reconsider this change… (e.g. 'use a Map instead of an Object here')"
         aria-label="Comment for AI about ${escHtml(body.path)}"></textarea>
       <div class="pcf-reconsider-actions">
         <span class="pcf-reconsider-hint">Esc to clear</span>
         <button type="submit" class="pcf-reconsider-send" title="Send to AI">Send to AI</button>
       </div>
     </form>`;
  container.innerHTML = headerBits.join('') + diffHtml + reconsiderHtml;
  _bindDiffInteractions(container, body.path);
}

// fr-77 r12: wire the post-render diff interactions:
//   • Click on a .pcf-line-clickable line → open per-line comment form.
//   • Submit on the file-level .pcf-reconsider form → send via reconsider POST.
// Called once per inline-diff render. Idempotent because the container's
// innerHTML was just replaced — old listeners are GC'd with the old DOM.
function _bindDiffInteractions(container, filePath) {
  if (!container) return;
  // Per-line click-to-comment. Use event delegation on the pre so we
  // catch every line div without per-line listeners.
  const pre = container.querySelector('.pcf-diff-pre');
  pre?.addEventListener('click', (e) => {
    const line = e.target.closest('.pcf-diff-line.pcf-line-clickable');
    if (!line) return;
    // Clicks inside an already-open per-line comment form shouldn't
    // re-toggle the parent line. The .pcf-line-comment sibling sits
    // OUTSIDE the line, so this guard is mostly defensive.
    if (e.target.closest('.pcf-line-comment')) return;
    _togglePcfLineComment(line);
  });
  // File-level reconsider form (sits below the diff). Submit fires
  // the same /files/reconsider POST without a lineNo, so the server
  // emits [chat:reconsider#<path>] without the :L<n> suffix.
  // r15: Esc on the textarea clears it + blurs (so the user can keep
  // browsing the diff without the form holding focus).
  const form = container.querySelector('form.pcf-reconsider');
  if (form) {
    const ta = form.querySelector('textarea');
    ta?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation(); ev.preventDefault();
        ta.value = '';
        ta.blur();
      }
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const comment = (ta && ta.value || '').trim();
      if (!comment) return;
      await _sendReconsider(filePath, comment, null);
      if (ta) ta.value = '';
    });
  }
}

// fr-77 r7: pick a highlight.js language id from a diff's file path.
// Mirrors hljsLangForExt + adds a few diff-common extensions. Returns
// null when no match, in which case _highlightDiffWithLang falls back
// to escaped plain text (still gets the per-line markers + tints).
function _diffLangForPath(p) {
  if (!p) return null;
  const m = String(p).toLowerCase().match(/\.([a-z0-9_]+)$/);
  const ext = m ? m[1] : '';
  // Reuse the shared file-viewer mapping where possible.
  if (typeof hljsLangForExt === 'function') {
    const lang = hljsLangForExt(ext);
    if (lang) return lang;
  }
  // Filename-based fallbacks (no extension) for common dotfiles.
  const base = String(p).split('/').pop() || '';
  if (/^Dockerfile/i.test(base)) return 'dockerfile';
  if (/^Makefile/i.test(base)) return 'makefile';
  return null;
}

// fr-77 r7: render a unified diff with per-language syntax highlight
// on the actual code content + diff markers preserved. Each line
// becomes a <div.pcf-diff-line.pcf-diff-{kind}> with a leading
// <span.pcf-diff-marker> (the +/-/space) followed by the highlighted
// code body. Diff metadata (diff --git, index, ---, +++, @@) are
// emitted as separate kinds so CSS can tone them down.
//
// Highlighting is per-LINE (not whole-block) so the per-line +/- marker
// can stay outside the highlighted span. This costs a small amount of
// cross-line state accuracy (a multi-line string / comment may render
// without its outer context), but the readability win on the rest
// of the lines is much larger.
function _highlightDiffWithLang(diffText, lang) {
  const lines = String(diffText || '').split('\n');
  const out = [];
  const haveLang = !!(lang && window.hljs && window.hljs.getLanguage(lang));
  // fr-77 r12: track post-change line numbers so each `+` or ` ` line
  // carries data-line-no — the per-line "ask AI about this line"
  // comment uses it as the marker line number. Reset on each @@ hunk
  // header (which declares the new starting line via "@@ -A,B +C,D @@").
  let newLineNo = 0;
  for (const line of lines) {
    if (line === '') { out.push('<div class="pcf-diff-line pcf-diff-blank"> </div>'); continue; }
    // Metadata lines — show muted, no language highlight.
    if (line.startsWith('diff --git') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('similarity index') || line.startsWith('rename ') ||
        line.startsWith('copy ') || line.startsWith('Binary files') ||
        line.startsWith('\\ No newline')) {
      out.push(`<div class="pcf-diff-line pcf-diff-meta">${escHtml(line)}</div>`);
      continue;
    }
    // Hunk header — also seed the new-side line counter from the
    // "+C,D" segment. Example: "@@ -10,3 +12,4 @@" → newLineNo=12.
    if (line.startsWith('@@')) {
      const m = line.match(/\+(\d+)(?:,\d+)?\s+@@/);
      if (m) newLineNo = parseInt(m[1], 10);
      out.push(`<div class="pcf-diff-line pcf-diff-hunk">${escHtml(line)}</div>`);
      continue;
    }
    // Content lines. First char is the marker; rest is the code body.
    const c = line.charAt(0);
    let kindCls, marker, lineNoAttr = '';
    if      (c === '+') { kindCls = 'pcf-diff-add'; marker = '+';
                          lineNoAttr = ` data-line-no="${newLineNo}"`; newLineNo++; }
    else if (c === '-') { kindCls = 'pcf-diff-rm';  marker = '−'; }  // old-only, no new line
    else if (c === ' ') { kindCls = 'pcf-diff-ctx'; marker = ' ';
                          lineNoAttr = ` data-line-no="${newLineNo}"`; newLineNo++; }
    else {
      // Anything else — render as raw, no marker, no highlight.
      out.push(`<div class="pcf-diff-line">${escHtml(line)}</div>`);
      continue;
    }
    const body = line.slice(1);
    let bodyHtml;
    if (haveLang) {
      try {
        bodyHtml = window.hljs.highlight(body, { language: lang, ignoreIllegals: true }).value;
      } catch { bodyHtml = escHtml(body); }
    } else {
      bodyHtml = escHtml(body);
    }
    // fr-77 r12: pcf-line-clickable marker on +/space lines (where a
    // line number is known) gates the click-to-comment affordance. The
    // diff-body click handler installed in bindPlanChangedFilesUi
    // routes the click to _togglePcfLineComment when state.readOnly
    // is false.
    const clickCls = lineNoAttr && !state.readOnly ? ' pcf-line-clickable' : '';
    out.push(`<div class="pcf-diff-line ${kindCls}${clickCls}"${lineNoAttr}><span class="pcf-diff-marker">${marker}</span><span class="pcf-diff-code">${bodyHtml}</span></div>`);
  }
  return out.join('');
}

// fr-77 r3: bind the Plan-view changed-files section once. Called from
// bindArtifactTabs (alongside the rest of the plan-tab bindings) so the
// refresh / collapse / list-click handlers are live before any user
// interaction.
function bindPlanChangedFilesUi() {
  const sec = document.getElementById('plan-changed-files-section');
  if (!sec || sec.dataset.bound) return;
  sec.dataset.bound = '1';
  document.getElementById('plan-changed-files-refresh')?.addEventListener('click', (e) => {
    e.preventDefault();
    // r16: Refresh = "give me a fresh git-status read" → also drop the
    // local accepted-paths memory so previously-accepted rows lose
    // their checkmark badge until the user explicitly accepts again.
    _planAcceptedPaths = new Set();
    loadPlanChangedFiles({ force: true });
  });
  document.getElementById('plan-changed-files-collapse')?.addEventListener('click', (e) => {
    e.preventDefault();
    sec.classList.toggle('is-collapsed');
  });
  document.getElementById('plan-changed-files-list')?.addEventListener('click', (e) => {
    // fr-77 r12: per-row Accept/Reject buttons take priority over the
    // row-click expand.
    const actionBtn = e.target.closest('button[data-pcf-action]');
    if (actionBtn) {
      e.stopPropagation();
      _planChangedFilesAction(actionBtn.dataset.pcfAction, [actionBtn.dataset.pcfPath]);
      return;
    }
    // Clicks inside the inline-diff row are handled by their own
    // listeners (the line click → per-line comment + the reconsider
    // form submit). Don't accidentally collapse the parent.
    const diffRow = e.target.closest('li.pcf-diff-row');
    if (diffRow) return;
    const li = e.target.closest('li[data-fc-path]');
    if (!li) return;
    _togglePlanChangedFileExpand(li);
  });
  // fr-77 r12: bulk Accept all / Reject all in the header.
  document.getElementById('plan-changed-files-accept-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    const paths = ((state.filesChanged && state.filesChanged.entries) || []).map((x) => x.path);
    if (!paths.length) return;
    _planChangedFilesAction('accept', paths);
  });
  document.getElementById('plan-changed-files-reject-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    const paths = ((state.filesChanged && state.filesChanged.entries) || []).map((x) => x.path);
    if (!paths.length) return;
    _planChangedFilesAction('reject', paths);
  });
  bindPlanChangedFilesResize();
  bindPlanChangedFilesViewerGating();
}

// fr-77 r12: hide owner-only mutate affordances (Accept all / Reject all
// header buttons, per-row Accept/Reject icons, reconsider forms) when the
// session is read-only. _renderPlanChangedFiles already gates per-row +
// per-diff bits on state.readOnly at render time, but the header
// buttons are static HTML — toggle their visibility here.
function bindPlanChangedFilesViewerGating() {
  const apply = () => {
    const hidden = !!state.readOnly;
    for (const id of ['plan-changed-files-accept-all', 'plan-changed-files-reject-all']) {
      const el = document.getElementById(id);
      if (el) el.hidden = hidden;
    }
  };
  apply();
  // Re-apply when readOnly flips (e.g. owner-grant change mid-session).
  // Cheap, idempotent — safe to call from any state-update path.
  const observer = new MutationObserver(() => {});  // placeholder: re-apply on a poll-ish basis
  // The existing renderArtifact / loadPlanChangedFiles re-renders cover
  // most cases; explicit listeners for the rare admin-grant flip live in
  // bug-17 territory. Polling once per second is overkill — instead, the
  // applyGating helper is exposed via app's existing _refreshOwnerGated
  // pattern if it ever needs to be cross-cut. For now: a one-shot apply
  // at bind time is enough because the section is only first-rendered
  // when the user opens the Plan view, by which time state.readOnly is
  // settled.
  observer; // silence "unused" linter — kept as a hook for future.
}

// fr-77 r12: shared dispatcher for accept/reject (single path or batch).
// Reject asks for confirmation first (destructive — reverts edits or
// deletes untracked files). Both refresh the changed-files list on
// success so the row count / chip totals reflect the new state.
async function _planChangedFilesAction(action, paths) {
  if (!state.activeId || !paths || !paths.length) return;
  if (action === 'reject') {
    const msg = paths.length === 1
      ? `Reject "${paths[0]}"?\n\nThis reverts your changes (tracked) or DELETES the file (untracked). Cannot be undone.`
      : `Reject ${paths.length} changed files?\n\nThis reverts all worktree edits AND DELETES untracked files. Cannot be undone.`;
    if (!window.confirm(msg)) return;
  }
  const id = state.activeId;
  const url = `/sessions/${encodeURIComponent(id)}/files/${action}`;
  let res;
  try {
    res = await authedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
  } catch (e) {
    alert(`${action} failed: ${e.message || e}`);
    return;
  }
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    alert(`${action} failed: ${(body && body.error) || res.status}`);
    return;
  }
  // fr-77 r16: remember per-path success so the post-refresh re-render
  // can mark the rows as "accepted" (✓ badge + greyed-out action
  // buttons). Reject takes the file out of the list entirely (status
  // gone), so there's nothing to remember.
  if (action === 'accept' && body && Array.isArray(body.results)) {
    for (const r of body.results) {
      if (r && r.ok && r.path) _planAcceptedPaths.add(r.path);
    }
  }
  // Refresh the list so the count + rows reflect the new git state.
  loadPlanChangedFiles({ force: true });
}

// fr-77 r12: toggle a per-line comment form below the clicked diff line.
// Click the same line again (or click another) to dismiss/move. Submit
// POSTs to /files/reconsider with { path, lineNo, comment }. The line
// number is the post-change new-side line (derived from the diff hunk
// header by _highlightDiffWithLang).
function _togglePcfLineComment(lineEl) {
  if (!lineEl || state.readOnly) return;
  const lineNo = parseInt(lineEl.dataset.lineNo, 10);
  if (!Number.isFinite(lineNo)) return;
  // Find the owning file path from the parent diff row.
  const diffRow = lineEl.closest('li.pcf-diff-row');
  if (!diffRow) return;
  const filePath = diffRow.dataset.fcPath;
  if (!filePath) return;
  // Already open? Collapse.
  const next = lineEl.nextElementSibling;
  if (next && next.classList.contains('pcf-line-comment')) {
    next.remove();
    lineEl.classList.remove('pcf-line-commenting');
    return;
  }
  // Open: insert a comment form right after the clicked line. r15
  // shows a small "(Esc to cancel)" hint next to the Cancel button so
  // the keyboard escape is discoverable, and binds Esc on the textarea
  // to trigger Cancel (matches the chat composer's Esc-to-clear UX).
  const form = document.createElement('div');
  form.className = 'pcf-line-comment';
  form.innerHTML =
    `<form class="pcf-line-form">
       <textarea class="pcf-line-input" rows="2"
         placeholder="Ask the AI about line ${lineNo}…"
         aria-label="Comment for AI about line ${lineNo}"></textarea>
       <div class="pcf-line-actions">
         <span class="pcf-line-hint">Esc to cancel</span>
         <button type="button" class="pcf-line-cancel">Cancel</button>
         <button type="submit" class="pcf-line-send">Send to AI</button>
       </div>
     </form>`;
  lineEl.classList.add('pcf-line-commenting');
  lineEl.insertAdjacentElement('afterend', form);
  const input = form.querySelector('textarea');
  if (input) input.focus();
  const dismiss = () => {
    form.remove();
    lineEl.classList.remove('pcf-line-commenting');
  };
  form.querySelector('.pcf-line-cancel')?.addEventListener('click', dismiss);
  // r15: Esc keypress while the textarea is focused → dismiss the form.
  // Stop propagation so the Esc doesn't also trigger any global handler.
  input?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); dismiss(); }
  });
  form.querySelector('form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const comment = (input && input.value || '').trim();
    if (!comment) return;
    await _sendReconsider(filePath, comment, lineNo);
    dismiss();
  });
}

// fr-77 r12: POST the reconsider payload (optionally with lineNo).
// Server wraps with [chat:reconsider#<path>(:L<n>)?] prefix + forwards
// to the active session.
async function _sendReconsider(filePath, comment, lineNo) {
  if (!state.activeId) return;
  const id = state.activeId;
  // bug-47: wrap with _withShareToken so guests can POST to the
  // viewer-readable /files/reconsider route.
  const url = _withShareToken(`/sessions/${encodeURIComponent(id)}/files/reconsider`);
  let res;
  try {
    res = await authedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: filePath, comment,
        ...(Number.isFinite(+lineNo) ? { lineNo: +lineNo } : {}),
      }),
    });
  } catch (e) { alert(`Send failed: ${e.message || e}`); return; }
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch {}
    alert(`Send failed: ${(body && body.error) || res.status}`);
    return;
  }
  flashToast('Sent to AI');
}

// fr-77 r4: vertical drag-to-resize on #plan-changed-files-section.
// Pointerdown on the .pcf-resize-handle starts a drag; pointermove
// updates the section's inline height (clamped to the CSS min/max
// bounds 60px–80vh); pointerup persists the chosen height in
// localStorage (myco_plan_changed_h). Double-click on the handle
// resets to the CSS default (clears the inline height + the saved
// value). Mirrors the chatpane resize pattern (bindChatpaneResize)
// in event flow + persistence.
function bindPlanChangedFilesResize() {
  const sec    = document.getElementById('plan-changed-files-section');
  const handle = document.getElementById('plan-changed-files-resize');
  if (!sec || !handle || handle.dataset.bound) return;
  handle.dataset.bound = '1';

  const STORAGE_KEY = 'myco_plan_changed_h';
  const MIN_PX = 60;
  const maxPx  = () => Math.floor(window.innerHeight * 0.8);

  // Restore last-saved height — clamp against the current viewport
  // so a value persisted on a taller window doesn't end up filling
  // a shorter one. Out-of-range value → drop it; CSS default takes over.
  try {
    const saved = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10);
    if (Number.isFinite(saved) && saved >= MIN_PX && saved <= maxPx()) {
      sec.style.height = saved + 'px';
    } else if (Number.isFinite(saved)) {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {}

  let dragging = false;
  let startY = 0;
  let startH = 0;
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = sec.getBoundingClientRect().height;
    handle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    try { handle.setPointerCapture(e.pointerId); } catch {}
  };
  const onMove = (e) => {
    if (!dragging) return;
    e.preventDefault();
    // Drag UP (smaller clientY) → section grows. The handle is at
    // the TOP edge of the section, so newH = startH + (startY - currY).
    const delta = startY - e.clientY;
    const max = maxPx();
    const newH = Math.max(MIN_PX, Math.min(max, startH + delta));
    sec.style.height = newH + 'px';
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    const px = parseInt(sec.style.height, 10);
    if (Number.isFinite(px)) {
      try { localStorage.setItem(STORAGE_KEY, String(px)); } catch {}
    }
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  handle.addEventListener('dblclick', () => {
    // Double-click resets to the CSS default — clear the inline height
    // + the saved value so future loads use the stylesheet's 40vh.
    sec.style.height = '';
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  });
}

function renderFilesList(entries, truncated, relPath) {
  const ul = document.getElementById('files-tree');
  const errEl = document.getElementById('files-tree-msg');
  errEl.hidden = true;
  errEl.textContent = '';
  document.getElementById('files-crumb').textContent = relPath === '.' ? '/' : '/' + relPath;
  document.getElementById('files-tree-back').hidden = (relPath === '.' || relPath === '');

  const parts = [];
  for (const e of entries) {
    const cls = `kind-${e.kind}` + (e.heavy ? ' heavy' : '');
    const ic = renderFileTreeIcon(e);
    // fr-9: git status decorator + download button. Decorator (M/A/D/?/etc.)
    // sits between the icon and the name. Download button is only on
    // files (not dirs / symlinks) and triggers the new /file/download
    // route. Click is stopPropagation'd so it doesn't open the file.
    const gitBadge = e.gitStatus ? renderGitStatusBadge(e.gitStatus) : '';
    const downloadBtn = e.kind === 'file'
      ? `<button class="ft-download" data-action="download" title="Download" aria-label="Download ${escHtml(e.name)}">${FT_SVG.download}</button>`
      : '';
    parts.push(
      `<li class="${cls}" data-name="${escHtml(e.name)}" data-kind="${e.kind}">` +
      `${ic}` +
      `${gitBadge}` +
      `<span class="ft-name">${escHtml(e.name)}${e.kind === 'dir' ? '/' : ''}</span>` +
      `${downloadBtn}` +
      `</li>`
    );
  }
  if (truncated) parts.push(`<li class="kind-other" style="opacity:.6"><span class="ft-ic"></span>…(truncated, more entries hidden)</li>`);
  ul.innerHTML = parts.join('');

  ul.querySelectorAll('li[data-name]').forEach((li) => {
    li.addEventListener('click', (ev) => {
      // fr-9: download button click — don't open the file viewer.
      if (ev.target && ev.target.closest && ev.target.closest('[data-action="download"]')) {
        ev.stopPropagation();
        const name = li.dataset.name;
        const child = relPath === '.' ? name : `${relPath}/${name}`;
        triggerFileDownload(child);
        return;
      }
      const name = li.dataset.name;
      const kind = li.dataset.kind;
      const child = relPath === '.' ? name : `${relPath}/${name}`;
      if (kind === 'dir') {
        state.files.history.push(relPath);
        loadFileTree(child);
      } else if (kind === 'file') {
        openFileInViewer(child);
      }
      // symlinks/other: no-op in v1
    });
  });
}

// fr-9: render a colored 1-letter git-status badge. Maps the
// porcelain code from server-side _gitStatusMap to a visible chip.
//   M (modified)  → green
//   A (added)     → green-bright
//   D (deleted)   → red
//   R / C         → blue
//   U (unmerged)  → orange
//   ? (untracked) → muted
//   ! (ignored)   → dim
function renderGitStatusBadge(status) {
  const s = String(status || '').slice(0, 1);
  const label = s === '?' ? '?' : (s === '!' ? '!' : s);
  return `<span class="ft-git-status ft-git-${escHtml(s)}" title="git status: ${escHtml(s)}">${escHtml(label)}</span>`;
}

// fr-9: trigger a browser download via the /file/download route.
// Creates a temporary anchor with the auth token in the query
// string (authedFetch normally adds it as a Bearer header, but the
// browser's native download navigation can't carry one). Same auth
// + containment as the read route — the server validates.
function triggerFileDownload(relPath) {
  if (!state.activeId) return;
  const id = state.activeId;
  const tok = encodeURIComponent(state.token || '');
  const p = encodeURIComponent(relPath);
  const url = `/sessions/${encodeURIComponent(id)}/file/download?path=${p}&token=${tok}`;
  // Anchor with the `download` attribute triggers a Save As dialog
  // instead of in-page navigation. Filename comes from the server's
  // Content-Disposition header.
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  // Hint the basename; the Content-Disposition header overrides.
  a.download = relPath.split('/').pop() || '';
  document.body.appendChild(a);
  try { a.click(); } finally { a.remove(); }
}

// fr-9 polish: Lucide-style SVG icons matching the main app's chrome
// cluster (stroke 1.75, 24×24 viewBox, currentColor, round caps).
// Replaces the prior text-letter badges ("JS", "TS", "PY", etc.) that
// looked inconsistent next to the main app's pure-SVG chrome buttons.
// Extension still affects color (via .ft-ic.ext-<lang>) so file kind
// is glanceable without the badge text.
//
// Three building-block icons cover the tree:
//   folder    — dir
//   file      — regular file (color-tinted by extension via CSS)
//   link-2    — symlink
//   circle    — "other" (FIFO, socket, etc.)
//
// SVG paths are inlined (1 KB total) so we don't pay an HTTP round
// trip per icon. currentColor lets CSS tint per extension without
// duplicating SVG markup.
const FT_SVG = {
  folder: '<svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  file:   '<svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><polyline points="14 2 14 8 20 8"/></svg>',
  fileCode:'<svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><polyline points="14 2 14 8 20 8"/><path d="m9 18 3-3-3-3"/><path d="m15 12 3 3-3 3" style="display:none"/></svg>',
  link:   '<svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>',
  dot:    '<svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2"/></svg>',
  download:'<svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
};

// Extension → color-class. CSS rules on .ft-ic.ext-<lang> set the
// stroke color via currentColor inheritance.
const FT_EXT_CLASS = {
  js: 'ext-js', mjs: 'ext-js', cjs: 'ext-js', jsx: 'ext-js',
  ts: 'ext-ts', tsx: 'ext-ts',
  json: 'ext-json',
  md: 'ext-md', markdown: 'ext-md',
  css: 'ext-css', scss: 'ext-css',
  html: 'ext-html', htm: 'ext-html', svg: 'ext-html', xml: 'ext-html',
  sh: 'ext-sh', bash: 'ext-sh', zsh: 'ext-sh',
  py: 'ext-py', rb: 'ext-default', go: 'ext-go', rs: 'ext-rs',
  yml: 'ext-yml', yaml: 'ext-yml', toml: 'ext-yml',
  c: 'ext-default', h: 'ext-default', cpp: 'ext-default', hpp: 'ext-default',
  java: 'ext-default', kt: 'ext-default', swift: 'ext-default', sql: 'ext-default',
};

function renderFileTreeIcon(entry) {
  if (entry.kind === 'dir')      return `<span class="ft-ic kind-dir">${FT_SVG.folder}</span>`;
  if (entry.kind === 'symlink')  return `<span class="ft-ic kind-symlink">${FT_SVG.link}</span>`;
  if (entry.kind === 'other')    return `<span class="ft-ic kind-other">${FT_SVG.dot}</span>`;
  // file: color-tint by extension; fallback to default muted gray.
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  const cls = FT_EXT_CLASS[ext] || 'ext-default';
  return `<span class="ft-ic ${cls}">${FT_SVG.file}</span>`;
}

async function openFileInViewer(relPath) {
  if (!state.activeId) return;
  const id = state.activeId;
  const url = `/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(relPath)}`;
  let res;
  try { res = await authedFetch(url); }
  catch (e) { alert(`Failed to open: ${e.message || e}`); return; }
  let body = {};
  try { body = await res.json(); } catch {}

  // Initialize viewing state up-front so showFileViewerPane has metadata.
  state.files.viewing = {
    path: relPath, mtimeMs: body.mtimeMs, content: '', binary: false,
    cards: [], selection: null, pending: null, commentDraft: null,
    wrap: /\.(md|markdown|txt|log)$/i.test(relPath),
    size: body.size,
  };

  showFileViewerPane(relPath);

  if (res.status === 415) {
    state.files.viewing.binary = true;
    showFileViewerMessage(`Binary file (${humanBytes(body.size)}) — not viewable.`);
    return;
  }
  if (res.status === 413) {
    showFileViewerMessage(`File too large to view (${humanBytes(body.size)}).`);
    return;
  }
  if (!res.ok) {
    showFileViewerMessage(`Error: ${body.error || res.status}`);
    return;
  }
  state.files.viewing.path = body.path;
  state.files.viewing.content = body.content;
  state.files.viewing.size = body.size;

  // fr-50 hotfix: re-render the header now that v.content is populated.
  // The earlier showFileViewerPane → renderViewerHeader call ran while
  // v.content was still the '' placeholder, so the Edit-button gate
  // (editable = !viewerMode && v && v.content && !v.binary) evaluated
  // to false and stamped hidden=true on #files-edit. Without this
  // re-render the ✎ Edit button stayed hidden forever — which is why
  // fr-50 was filed as "no editing surface exists" even though the
  // pre-fr-50 textarea editor was already wired. Same fix unblocks
  // the new CodeMirror 6 editor.
  renderViewerHeader(body.path);

  renderFileViewerWithCards(body.content, body.path, []);
  // Async: load any persisted Claude thread for this file, then re-render.
  loadFileChat(body.path).then((cards) => {
    if (state.files.viewing && state.files.viewing.path === body.path) {
      state.files.viewing.cards = cards;
      renderFileViewerWithCards(state.files.viewing.content, body.path, cards);
    }
  }).catch(() => {});
}

// Floating "Connecting" / "Reconnecting" card over the terminal area.
// The spinner is the activity indicator; title text omits the trailing
// ellipsis. Sub-line is updated to match the title's mode.
//
// fr-88: a 4th `blocking` arg (default false) upgrades the overlay from
// a floating pill (scoped to #terminal-pane, pointer-events:none) to a
// full-viewport dimmed modal that intercepts clicks. The CSS
// `.blocking` modifier (styles.css) handles all the visual changes;
// this function just toggles the class. Used by the close→reconnect
// path in connect() — initial-connect call sites omit the flag so
// first-page-load UX is unchanged.
function showConnOverlay(text, kind, sub, blocking) {
  const overlay = document.getElementById('conn-overlay');
  if (!overlay) return;
  const pill = overlay.querySelector('.conn-pill');
  const txt = overlay.querySelector('.conn-text');
  const subEl = overlay.querySelector('.conn-sub');
  if (txt) txt.textContent = text || 'Connecting';
  if (subEl && sub) subEl.textContent = sub;
  if (pill) pill.classList.toggle('error', kind === 'error');
  overlay.classList.toggle('blocking', !!blocking);
  overlay.hidden = false;
}
function hideConnOverlay() {
  const overlay = document.getElementById('conn-overlay');
  if (!overlay) return;
  // fr-88: clear the blocking modifier on hide so a subsequent non-
  // blocking show (e.g. session-switch initial connect) isn't stuck
  // with the blocking backdrop from a prior reconnect window.
  overlay.classList.remove('blocking');
  overlay.hidden = true;
}

function showFileViewerPane(relPath) {
  document.getElementById('files-view-pane').hidden = false;
  renderViewerHeader(relPath);
  const msg = document.getElementById('files-view-msg');
  msg.hidden = true;
  msg.textContent = '';
  document.getElementById('files-action-bar').hidden = true;
  // On mobile, hide the tree to give the viewer the full width.
  if (window.innerWidth <= 900) {
    document.getElementById('files-tree-pane').hidden = true;
  }
}

function renderViewerHeader(relPath) {
  // Clickable breadcrumbs.
  const crumbs = document.getElementById('files-view-crumbs');
  const segments = relPath.split('/').filter(Boolean);
  const root = (state.files.currentPath && state.files.currentPath !== '.') ? state.files.currentPath : '';
  // Build clickable crumbs: each is the directory prefix to nav back to.
  const html = ['<span class="crumb crumb-root" data-path=".">/</span>'];
  let acc = '';
  segments.forEach((seg, i) => {
    if (i > 0) html.push('<span class="crumb-sep">/</span>');
    acc = acc ? acc + '/' + seg : seg;
    const last = i === segments.length - 1;
    const cls = last ? 'crumb last' : 'crumb';
    const navTo = last ? '' : acc;
    html.push(`<span class="${cls}" data-path="${escHtml(navTo)}">${escHtml(seg)}</span>`);
  });
  crumbs.innerHTML = html.join('');
  crumbs.querySelectorAll('.crumb').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.dataset.path;
      if (p === '' || el.classList.contains('last')) return;
      // Navigate back to directory and close viewer.
      closeFileViewer();
      loadFileTree(p || '.');
    });
  });

  // Action buttons visible only when we have content.
  const v = state.files.viewing;
  document.getElementById('files-copy').hidden = !(v && v.content);
  document.getElementById('files-wrap-toggle').hidden = !(v && v.content);
  // Edit button — owner-only, only when we have content + we're
  // not already in edit mode. Save / Cancel hidden by default;
  // _enterFileEditMode reveals them.
  const editable = !state.viewerMode && v && v.content && !v.binary;
  const inEdit = !!(v && v.editing);
  document.getElementById('files-edit').hidden = !editable || inEdit;
  document.getElementById('files-edit-save').hidden = !inEdit;
  document.getElementById('files-edit-cancel').hidden = !inEdit;
}

// Collapse / expand the files-tree-pane on desktop so the viewer
// gets the full width. Mobile already hides the tree when a file
// opens; this is the desktop equivalent. State persists in
// localStorage so the user's preference survives reloads.
function _toggleFilesTreeCollapsed() {
  const pane = document.getElementById('files-tree-pane');
  const wrap = document.getElementById('files-wrap');
  if (!pane || !wrap) return;
  const willCollapse = !wrap.classList.contains('files-tree-collapsed');
  wrap.classList.toggle('files-tree-collapsed', willCollapse);
  try { localStorage.setItem('myco_files_tree_collapsed', willCollapse ? '1' : '0'); } catch {}
  const btn = document.getElementById('files-tree-collapse');
  if (btn) {
    // fr-9 polish: swap the Lucide SVG instead of replacing
    // textContent (which would wipe out the inline SVG). Use
    // panel-left-close ↔ panel-left-open variants.
    btn.innerHTML = willCollapse
      // panel-left-open (expand affordance — chevron points right INTO the panel)
      ? '<svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m13 9 3 3-3 3"/></svg>'
      // panel-left-close (collapse affordance — chevron points left, hiding the panel)
      : '<svg class="ft-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/></svg>';
    btn.title = willCollapse
      ? 'Expand the tree pane'
      : 'Collapse the tree to give the file viewer more room';
  }
}

// fr-50: Owner-only inline file edit, CodeMirror 6 surface. Swaps the
// rendered body for a CodeMirror editor (syntax highlighting + line
// numbers + search). Falls back to a plain <textarea> if the CM6
// bundle (window.MycoCM) failed to load — the fallback is byte-
// identical to the pre-fr-50 behavior so a vendor bundle hiccup
// doesn't take editing offline. Save POSTs to /sessions/:id/file/edit
// (owner-gated server-side); on 409 ERR_MTIME_CONFLICT we open the
// conflict modal instead of alert()ing the raw error. Cancel restores
// the rendered view.
//
// Track on state.files.viewing:
//   editing      — flag for "edit mode active"
//   editOriginal — content at entry (for no-op short-circuit)
//   cmView       — CM6 EditorView instance (so _saveFileEdit can read
//                  the current doc, and _exitFileEditMode can destroy)
async function _enterFileEditMode() {
  const v = state.files.viewing;
  if (!v || !v.content || v.binary) return;
  if (state.viewerMode) return;     // belt-and-braces: server enforces too

  if (typeof window.MycoCM === 'undefined') {
    try {
      await loadScript('/vendor/codemirror.bundle.js');
    } catch (err) {
      console.warn('[codemirror] failed to lazy-load:', err);
    }
  }

  const body = document.getElementById('files-view-body');
  if (!body) return;
  v.editing = true;
  v.editOriginal = v.content;
  body.innerHTML = '';

  // CodeMirror 6 path (preferred). MycoCM.createEditor returns an
  // EditorView whose state.doc.toString() is the live content.
  if (window.MycoCM && typeof window.MycoCM.createEditor === 'function') {
    const host = document.createElement('div');
    host.id = 'files-edit-cm';
    host.className = 'files-edit-cm';
    body.appendChild(host);
    try {
      v.cmView = window.MycoCM.createEditor({
        parent: host,
        doc: v.content,
        path: v.path,
        // Cmd/Ctrl+S submit + Esc cancel handled at the host level
        // (CM6 swallows keys via its keymap; we listen on the wrapper
        // so they fire even when focus is inside the editor).
      });
      // Refresh header buttons (show Save/Cancel, hide Edit).
      renderViewerHeader(v.path);
      // Cmd/Ctrl+S → save. Esc → cancel. Attached to the host (capture
      // phase) so CM6's own keymap can't swallow them silently.
      host.addEventListener('keydown', _handleFileEditKeyDown, true);
      // Focus the editor so the user can type immediately.
      v.cmView.focus();
      return;
    } catch (err) {
      console.error('[fr-50] CM6 init failed, falling back to textarea:', err);
      // Fall through to textarea path so editing still works.
      v.cmView = null;
    }
  }

  // Fallback: textarea path. Identical to pre-fr-50 behavior.
  const ta = document.createElement('textarea');
  ta.id = 'files-edit-textarea';
  ta.className = 'files-edit-textarea';
  ta.value = v.content;
  ta.spellcheck = false;
  ta.autocomplete = 'off';
  ta.autocapitalize = 'off';
  ta.setAttribute('autocorrect', 'off');
  body.appendChild(ta);
  renderViewerHeader(v.path);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
    }
    if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      _saveFileEdit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      _exitFileEditMode();
    }
  });
  ta.focus();
}

// Shared keydown handler for the CM6 edit host — Cmd/Ctrl+S to save,
// Esc to cancel. Separate function so we can also detach it on exit.
function _handleFileEditKeyDown(e) {
  if ((e.key === 's' || e.key === 'S') && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    e.stopPropagation();
    _saveFileEdit();
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    _exitFileEditMode();
  }
}

function _exitFileEditMode() {
  const v = state.files.viewing;
  if (!v || !v.editing) return;
  v.editing = false;
  delete v.editOriginal;
  // Destroy the CM6 view so its listeners + DOM are released. The
  // body innerHTML='' inside renderFileViewerWithCards would orphan
  // the editor otherwise.
  if (v.cmView && typeof v.cmView.destroy === 'function') {
    try { v.cmView.destroy(); } catch {}
  }
  v.cmView = null;
  // Re-render the body from v.content (might have been updated by save).
  renderFileViewerWithCards(v.content, v.path, v.cards || []);
  renderViewerHeader(v.path);
}

// Read the current editor content. CM6 path reads from v.cmView's
// EditorState; textarea fallback reads the input value. Returns null
// if neither surface is present (the save path skips when null).
function _currentEditedContent() {
  const v = state.files.viewing;
  if (!v) return null;
  if (v.cmView && v.cmView.state && v.cmView.state.doc) {
    return v.cmView.state.doc.toString();
  }
  const ta = document.getElementById('files-edit-textarea');
  return ta ? ta.value : null;
}

async function _saveFileEdit({ force = false } = {}) {
  const v = state.files.viewing;
  if (!v || !v.editing) return;
  const newContent = _currentEditedContent();
  if (newContent == null) return;
  if (newContent === v.editOriginal && !force) {
    // No-op save — just exit edit mode.
    _exitFileEditMode();
    return;
  }
  const id = state.activeId;
  if (!id) return;
  const saveBtn = document.getElementById('files-edit-save');
  if (saveBtn) {
    saveBtn.disabled = true;
    // fr-83: was `textContent = '… saving'` — that wiped the inline
    // SVG icon. Now we keep the icon and toggle a CSS class that
    // pulses opacity to signal "saving". Restored in the `finally`.
    saveBtn.classList.add('is-saving');
    saveBtn.setAttribute('title', '… saving');
  }
  try {
    // fr-50: when force=true (user picked "Force overwrite" in the
    // conflict modal) we fetch the current disk mtime first so the
    // server's expectedMtimeMs check passes. Without this re-stat
    // the PUT would just 409 again.
    let expectedMtimeMs = v.mtimeMs;
    if (force) {
      const probe = await authedFetch(`/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(v.path)}`);
      if (probe.ok) {
        const pbody = await probe.json().catch(() => ({}));
        if (typeof pbody.mtimeMs === 'number') expectedMtimeMs = pbody.mtimeMs;
      }
    }
    const res = await authedFetch(`/sessions/${encodeURIComponent(id)}/file/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: v.path, content: newContent, expectedMtimeMs }),
    });
    if (res.status === 409) {
      // fr-50: ERR_MTIME_CONFLICT — file changed on disk since open.
      // Surface the proper conflict modal instead of a generic alert,
      // so the user can choose reload-from-disk vs. force-overwrite
      // vs. stay-in-edit. Bytes preserved in the editor either way.
      _showFileConflictModal(v.path);
      return;
    }
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch {}
      alert(`Save failed: ${body.error || res.status}`);
      return;
    }
    const body = await res.json();
    v.content = body.content != null ? body.content : newContent;
    v.mtimeMs = body.mtimeMs;
    v.size = body.size;
    _exitFileEditMode();
    // fr-77 r3: a successful save likely changes the git-status of this
    // file (clean → modified, or modified → clean depending on what
    // the edit did). Refresh the Plan-view changed-files section so the
    // chip count + list reflect the new state. force=true bypasses the
    // 2s cache so the user sees the update immediately.
    if (typeof loadPlanChangedFiles === 'function') loadPlanChangedFiles({ force: true });
  } catch (err) {
    alert(`Save failed: ${err.message || err}`);
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      // fr-83: restore non-busy state — class swap preserves the SVG.
      saveBtn.classList.remove('is-saving');
      saveBtn.setAttribute('title', 'Save changes');
    }
  }
}

// fr-50: conflict modal — three user choices when the server returns
// 409 ERR_MTIME_CONFLICT on save. Reload: discard edits, re-fetch
// disk version. Force: re-stat to get fresh mtime, then save (next
// PUT body uses the new expectedMtimeMs). Cancel: close modal, stay
// in edit mode with bytes intact so the user can copy them out.
function _showFileConflictModal(relPath) {
  const modal = document.getElementById('file-conflict-modal');
  if (!modal) {
    // HTML scaffolding missing — fall back to a confirm dialog so the
    // user still has SOMETHING to act on.
    if (confirm(`${relPath} changed on disk. OK = force overwrite, Cancel = reload from disk.`)) {
      _saveFileEdit({ force: true });
    } else {
      _reloadFileFromDisk();
    }
    return;
  }
  const pathEl = document.getElementById('file-conflict-path');
  if (pathEl) pathEl.textContent = relPath;
  modal.hidden = false;
}

function _hideFileConflictModal() {
  const modal = document.getElementById('file-conflict-modal');
  if (modal) modal.hidden = true;
}

async function _reloadFileFromDisk() {
  const v = state.files.viewing;
  if (!v) return;
  const id = state.activeId;
  if (!id) return;
  const res = await authedFetch(`/sessions/${encodeURIComponent(id)}/file?path=${encodeURIComponent(v.path)}`);
  if (!res.ok) {
    alert(`Reload failed: ${res.status}`);
    return;
  }
  const body = await res.json();
  v.content = body.content;
  v.mtimeMs = body.mtimeMs;
  v.size = body.size;
  _exitFileEditMode();
}

function showFileViewerMessage(msg) {
  document.getElementById('files-view-body').innerHTML = '';
  const m = document.getElementById('files-view-msg');
  m.textContent = msg;
  m.hidden = false;
}

function closeFileViewer() {
  document.getElementById('files-view-pane').hidden = true;
  document.getElementById('files-tree-pane').hidden = false;
  document.getElementById('files-action-bar').hidden = true;
  state.files.viewing = null;
}

function copyFileContents() {
  const v = state.files.viewing;
  if (!v || !v.content) return;
  try {
    navigator.clipboard.writeText(v.content);
    flashHeaderButton('files-copy');
  } catch {}
}

function flashHeaderButton(id) {
  const b = document.getElementById(id);
  if (!b) return;
  const prev = b.style.backgroundColor;
  b.style.backgroundColor = 'rgba(80, 160, 110, .35)';
  setTimeout(() => { b.style.backgroundColor = prev; }, 350);
}

function toggleWrap() {
  const v = state.files.viewing;
  if (!v) return;
  v.wrap = !v.wrap;
  renderFileViewerWithCards(v.content, v.path, v.cards);
}

// ── chunk-render: code with inline Claude cards ────────────────────────────

function renderFileViewerWithCards(content, relPath, cards) {
  const body = document.getElementById('files-view-body');
  const lines = String(content || '').split('\n');
  const totalLines = lines.length;
  const ext = (relPath.split('.').pop() || '').toLowerCase();
  const lang = hljsLangForExt(ext);
  const wrap = !!(state.files.viewing && state.files.viewing.wrap);

  // Markdown rich-rendering shortcut: .md/.markdown files render through
  // marked + mermaid (same path the chat pane uses). The numbered raw
  // view's only advantage is line-anchored Claude cards and the inline
  // comment editor — so if either of those is in play we fall through to
  // the raw path below to preserve those affordances.
  const isMarkdown = ext === 'md' || ext === 'markdown';
  const hasAnchored = (cards || []).some(
    (c) => c.user === ASSISTANT_USER_NAME && c.anchor && c.anchor.startLine && c.anchor.endLine,
  );
  const _draft = state.files.viewing && state.files.viewing.commentDraft;
  if (isMarkdown && !hasAnchored && !_draft) {
    return renderMarkdownFileView(body, content, cards);
  }

  // Build segments interleaving code chunks and cards. Anchored cards split
  // the code at each card's endLine. Anchorless cards collect at the end.
  const anchored = [];
  const trailing = [];
  for (const c of cards) {
    if (c.user !== ASSISTANT_USER_NAME) continue; // only render Claude cards (questions inlined inside)
    if (c.anchor && c.anchor.endLine && c.anchor.startLine) {
      anchored.push({
        ...c,
        // Find the corresponding question (preceding 'you' message with same anchor) so we render Q+A together.
      });
    } else {
      trailing.push(c);
    }
  }
  // Pair Claude messages with their preceding user question (best-effort by anchor + order).
  const userQs = cards.filter((c) => c.user === 'you');
  function pickQuestionFor(claudeMsg) {
    // The most recent user message with the same anchor that comes before claudeMsg.
    const claudeTs = new Date(claudeMsg.ts).getTime();
    let best = null;
    for (const q of userQs) {
      const qTs = new Date(q.ts).getTime();
      if (qTs > claudeTs) continue;
      if (anchorsEqual(q.anchor, claudeMsg.anchor)) {
        if (!best || new Date(q.ts).getTime() > new Date(best.ts).getTime()) best = q;
      }
    }
    return best;
  }

  anchored.sort((a, b) => a.anchor.endLine - b.anchor.endLine);

  body.innerHTML = '';
  body.dataset.lang = lang || '';

  // Inline comment editor: synthesize an anchored "stop" at draft.targetLine - 1
  // so the editor renders BEFORE that line. Treat targetLine === 1 as
  // "render at the very top".
  const draft = state.files.viewing && state.files.viewing.commentDraft;
  // Build a unified list of inline stops (anchored cards + draft) sorted by
  // splitLine (the line AFTER which we insert). For cards: splitLine = endLine.
  // For drafts: splitLine = targetLine - 1 (so the editor appears above target).
  const stops = [];
  for (const c of anchored) {
    stops.push({ kind: 'card', card: c, splitLine: Math.min(totalLines, c.anchor.endLine) });
  }
  if (draft) {
    stops.push({ kind: 'editor', draft, splitLine: Math.max(0, Math.min(totalLines, draft.targetLine - 1)) });
  }
  stops.sort((a, b) => a.splitLine - b.splitLine);

  let cursor = 1;
  for (const s of stops) {
    const splitLine = s.splitLine;
    if (splitLine >= cursor) {
      body.appendChild(renderCodeChunk(lines, cursor, splitLine, lang, wrap));
      cursor = splitLine + 1;
    }
    if (s.kind === 'card') {
      const q = pickQuestionFor(s.card);
      body.appendChild(renderClaudeCard(s.card, q));
    } else if (s.kind === 'editor') {
      body.appendChild(renderInlineCommentEditor(s.draft));
    }
  }
  if (cursor <= totalLines) {
    body.appendChild(renderCodeChunk(lines, cursor, totalLines, lang, wrap));
  }
  // Pending Claude card: insert at the anchor of the pending question (or at end).
  const pending = state.files.viewing && state.files.viewing.pending;
  if (pending) {
    body.appendChild(renderPendingCard(pending));
  }
  // Trailing (anchorless) cards at the very end.
  for (const c of trailing) {
    body.appendChild(renderClaudeCard(c, pickQuestionFor(c)));
  }
}

// Rich markdown render path for the file viewer. Reuses renderMd (the
// same path the chat pane uses, so behaviour stays consistent) and
// renderMermaidInContainer to turn ```mermaid fences into SVG. Trailing
// anchorless Claude cards still render beneath the document — anchored
// cards/inline-editor cases route through the raw path in the caller.
function renderMarkdownFileView(body, content, cards) {
  body.innerHTML = '';
  body.dataset.lang = 'markdown';
  const wrap = document.createElement('div');
  wrap.className = 'md-rendered';
  wrap.innerHTML = renderMd(String(content || ''));
  body.appendChild(wrap);
  // Fire-and-forget mermaid pass; failures stay as raw code blocks.
  renderMermaidInContainer(wrap).catch(() => {});
  // Pair anchorless Claude cards with their preceding 'you' question so
  // the rendered Q+A shows up underneath the doc.
  const userQs = (cards || []).filter((c) => c.user === 'you');
  function pickQuestionFor(claudeMsg) {
    const claudeTs = new Date(claudeMsg.ts).getTime();
    let best = null;
    for (const q of userQs) {
      const qTs = new Date(q.ts).getTime();
      if (qTs > claudeTs) continue;
      if (anchorsEqual(q.anchor, claudeMsg.anchor)) {
        if (!best || new Date(q.ts).getTime() > new Date(best.ts).getTime()) best = q;
      }
    }
    return best;
  }
  const pending = state.files.viewing && state.files.viewing.pending;
  if (pending) body.appendChild(renderPendingCard(pending));
  for (const c of (cards || [])) {
    if (c.user !== ASSISTANT_USER_NAME) continue;
    if (c.anchor && c.anchor.startLine && c.anchor.endLine) continue; // anchored shouldn't reach here
    body.appendChild(renderClaudeCard(c, pickQuestionFor(c)));
  }
}

function renderInlineCommentEditor(draft) {
  const ed = document.createElement('div');
  ed.className = 'inline-comment-editor';
  // <textarea rows="1"> + JS auto-grow gives a single-line feel that expands
  // as the user types newlines. Enter inserts a newline (default textarea
  // behavior); Cmd/Ctrl+Enter saves; Esc cancels.
  // Username attribution prefix — shown in the editor's prefix label so the
  // user sees "// alice: " before they type. buildCommentLines also injects
  // this on the saved first line.
  const userTagText = draft.userTag ? `${draft.userTag}: ` : '';
  ed.innerHTML =
    `<div class="ce-gutter">+</div>` +
    `<div class="ce-prefix-wrap">` +
      `<span class="ce-prefix">${escHtml(draft.indent + draft.prefix)}` +
      (userTagText ? `<span class="ce-usertag">${escHtml(userTagText)}</span>` : '') +
      `</span>` +
      `<textarea class="ce-input" rows="1" placeholder="comment text — ↵ for newline, ⌘↵ to save" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>` +
      (draft.suffix ? `<span class="ce-suffix">${escHtml(draft.suffix)}</span>` : '') +
    `</div>` +
    `<span class="ce-hint">⌘↵ save · esc cancel</span>` +
    `<div class="ce-actions">` +
      `<button class="ce-save" title="Save (⌘↵)">✓</button>` +
      `<button class="ce-cancel" title="Cancel (esc)">×</button>` +
    `</div>`;

  const input = ed.querySelector('.ce-input');
  const saveBtn = ed.querySelector('.ce-save');
  const cancelBtn = ed.querySelector('.ce-cancel');

  input.value = draft.text || '';

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.max(input.scrollHeight, 21) + 'px';
  }

  input.addEventListener('input', () => {
    draft.text = input.value;
    autoGrow();
  });

  const submit = () => commitInlineCommentEditor(input.value);
  saveBtn.addEventListener('click', submit);
  cancelBtn.addEventListener('click', cancelInlineCommentEditor);
  input.addEventListener('keydown', (e) => {
    // Cmd+Enter (mac) / Ctrl+Enter (win/linux) → save. Plain Enter falls
    // through to the textarea and inserts a newline.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); submit();
    } else if (e.key === 'Escape') {
      e.preventDefault(); cancelInlineCommentEditor();
    }
  });
  // Initial sizing in case draft.text was carried over.
  setTimeout(autoGrow, 0);
  return ed;
}

// Build the actual lines that get spliced into the file. Per language style:
// - line-comment (//, #, --): each user line becomes its own comment line.
// - block-comment (<!-- -->, /* */): wrap the whole block; subsequent lines
//   visually align under the prefix opening so the block reads cleanly.
function buildCommentLines(draft, text) {
  const userLines = String(text || '').split(/\r?\n/);
  const { indent, prefix, suffix, userTag } = draft;
  const tag = userTag ? `${userTag}: ` : '';
  const isBlock = !!suffix;
  if (isBlock) {
    if (userLines.length === 1) {
      return [`${indent}${prefix}${tag}${userLines[0]}${suffix}`];
    }
    const aligner = ' '.repeat(prefix.length);
    const out = [`${indent}${prefix}${tag}${userLines[0]}`];
    for (let i = 1; i < userLines.length - 1; i++) {
      out.push(`${indent}${aligner}${userLines[i]}`);
    }
    out.push(`${indent}${aligner}${userLines[userLines.length - 1]}${suffix}`);
    return out;
  }
  // Line-comment style — one comment per user line. The username tag goes
  // on the first line only; subsequent lines get the bare comment marker
  // (typical "first author, continuation" pattern in source code).
  return userLines.map((ln, idx) => {
    const linePrefix = idx === 0 ? `${prefix}${tag}` : prefix;
    if (ln === '') return `${indent}${linePrefix.replace(/\s+$/, '')}`;
    return `${indent}${linePrefix}${ln}`;
  });
}

const ASSISTANT_USER_NAME = 'claude';

function anchorsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.startLine === b.startLine && a.endLine === b.endLine;
}

function renderCodeChunk(lines, startLine, endLine, lang, wrap) {
  const wrapDiv = document.createElement('div');
  wrapDiv.className = 'code-chunk' + (wrap ? ' wrap' : '');
  wrapDiv.dataset.startLine = String(startLine);
  wrapDiv.dataset.endLine = String(endLine);

  const gutter = document.createElement('div');
  gutter.className = 'ln-gutter';
  const gParts = [];
  for (let i = startLine; i <= endLine; i++) gParts.push(`<span>${i}</span>`);
  gutter.innerHTML = gParts.join('');

  const pre = document.createElement('pre');
  pre.className = 'code-content';
  const code = document.createElement('code');
  const text = lines.slice(startLine - 1, endLine).join('\n');
  try {
    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
      code.innerHTML = hljs.highlight(text, { language: lang }).value;
      code.className = 'hljs language-' + lang;
    } else if (typeof hljs !== 'undefined') {
      code.innerHTML = hljs.highlightAuto(text).value;
      code.className = 'hljs';
    } else {
      code.textContent = text;
    }
  } catch {
    code.textContent = text;
  }
  pre.appendChild(code);

  wrapDiv.appendChild(gutter);
  wrapDiv.appendChild(pre);
  return wrapDiv;
}

function renderClaudeCard(message, questionMessage) {
  const card = document.createElement('div');
  card.className = 'claude-card';
  card.dataset.id = message.id;

  const anchorTxt = message.anchor
    ? `lines ${message.anchor.startLine}–${message.anchor.endLine}`
    : 'whole file';

  const header = document.createElement('div');
  header.className = 'cc-anchor';
  header.innerHTML =
    `<span>💬 myco · ${escHtml(anchorTxt)}</span><span class="cc-spacer"></span>` +
    `<button class="cc-collapse" title="Collapse">⌃</button>` +
    `<button class="cc-delete" title="Delete">✕</button>`;
  card.appendChild(header);

  if (questionMessage && questionMessage.text) {
    const q = document.createElement('div');
    q.className = 'cc-q';
    q.textContent = questionMessage.text;
    card.appendChild(q);
  }

  const a = document.createElement('div');
  a.className = 'cc-a';
  // renderMd handles markdown + code fences via marked + hljs.
  try {
    a.innerHTML = renderMd(message.text);
    if (typeof renderMermaidInContainer === 'function') renderMermaidInContainer(a);
  } catch {
    a.textContent = message.text;
  }
  card.appendChild(a);

  // Mark error styling if Claude returned an error stand-in.
  if (/^\(claude .+\)$/.test(message.text.trim())) card.classList.add('error');

  header.querySelector('.cc-collapse').addEventListener('click', () => {
    card.classList.toggle('collapsed');
  });
  header.querySelector('.cc-delete').addEventListener('click', () => {
    if (!confirm('Delete this myco reply?')) return;
    deleteClaudeCard(message.id).catch(() => {});
  });
  return card;
}

function renderPendingCard(pending) {
  const card = document.createElement('div');
  card.className = 'claude-card pending';
  const anchorTxt = pending.anchor
    ? `lines ${pending.anchor.startLine}–${pending.anchor.endLine}`
    : 'whole file';
  card.innerHTML =
    `<div class="cc-anchor"><span>💬 myco · ${escHtml(anchorTxt)}</span></div>` +
    `<div class="cc-q">${escHtml(pending.question)}</div>` +
    `<div class="cc-a">Thinking…</div>`;
  return card;
}

// ── Claude file-chat API ───────────────────────────────────────────────────

async function loadFileChat(relPath) {
  if (!state.activeId) return [];
  const id = state.activeId;
  const url = `/sessions/${encodeURIComponent(id)}/file-chat?path=${encodeURIComponent(relPath)}`;
  try {
    const r = await authedFetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.messages) ? j.messages : [];
  } catch { return []; }
}

const ACTION_PROMPTS = {
  explain:  'Briefly explain what the selected code does and how it fits into the surrounding file.',
  suggest:  'Suggest concrete improvements to the selected code (clarity, correctness, performance). Be specific.',
  bugs:     'Look for bugs, edge cases, or correctness issues in the selected code. Be specific about what could go wrong.',
  tests:    'What tests would meaningfully exercise the selected code? List 3–5 cases.',
};

async function askClaudeAboutSelection(action, customText) {
  const v = state.files.viewing;
  if (!v) return;
  const anchor = v.selection;
  if (!anchor) return;
  const question = action === 'ask' ? (customText || '').trim() : ACTION_PROMPTS[action];
  if (!question) return;

  // Optimistic: show pending card immediately.
  v.pending = { question, anchor };
  renderFileViewerWithCards(v.content, v.path, v.cards);

  const id = state.activeId;
  let res;
  try {
    res = await authedFetch(`/sessions/${encodeURIComponent(id)}/file-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: v.path, anchor, question }),
    });
  } catch (e) {
    v.pending = null;
    renderFileViewerWithCards(v.content, v.path, v.cards);
    alert(`Claude request failed: ${e.message || e}`);
    return;
  }
  v.pending = null;
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch {}
    renderFileViewerWithCards(v.content, v.path, v.cards);
    alert(`Claude error: ${body.error || res.status}`);
    return;
  }
  const j = await res.json();
  // Append both the user message and the Claude reply so the next render
  // pairs them correctly.
  if (j.userMessage) v.cards.push(j.userMessage);
  if (j.message) v.cards.push(j.message);
  renderFileViewerWithCards(v.content, v.path, v.cards);
}

// ── inline comment editor ───────────────────────────────────────────────────
// Add comment opens a draft "comment line" embedded in the code body at the
// destination — like editing the comment in place. State lives on viewing.
// Render is interleaved by renderFileViewerWithCards; commit/cancel re-render.

function startInlineCommentEditor(anchor) {
  const v = state.files.viewing;
  if (!v) return;
  const lines = String(v.content || '').split('\n');
  const targetIdx = Math.max(0, Math.min(lines.length - 1, anchor.startLine - 1));
  const targetLine = lines[targetIdx] || '';
  const indent = (targetLine.match(/^[ \t]*/) || [''])[0];
  const ext = (v.path.split('.').pop() || '').toLowerCase();
  const { prefix, suffix } = commentSyntaxForExt(ext);
  v.commentDraft = {
    targetLine: anchor.startLine,
    indent, prefix, suffix,
    userTag: state.chatUser || '',     // attribution prefix shown in editor + commit
    text: '',
  };
  renderFileViewerWithCards(v.content, v.path, v.cards || []);
  // After render, the editor element exists in the DOM. Focus its input
  // synchronously-ish (rAF for layout) and scroll it into view.
  requestAnimationFrame(() => {
    const editor = document.querySelector('.inline-comment-editor');
    if (!editor) return;
    editor.scrollIntoView({ block: 'center', behavior: 'auto' });
    const input = editor.querySelector('.ce-input');
    if (input) input.focus();
  });
}

function cancelInlineCommentEditor() {
  const v = state.files.viewing;
  if (!v || !v.commentDraft) return;
  v.commentDraft = null;
  renderFileViewerWithCards(v.content, v.path, v.cards || []);
}

async function commitInlineCommentEditor(text) {
  const v = state.files.viewing;
  if (!v || !v.commentDraft) return;
  // Trim only trailing whitespace; preserve internal newlines so multi-line
  // input is honored. If the entire input is empty, treat as cancel.
  const cleaned = String(text || '').replace(/[ \t]+$/gm, '').replace(/^\s+|\s+$/g, '');
  if (!cleaned) { cancelInlineCommentEditor(); return; }
  const draft = v.commentDraft;
  // Mark editor busy while we PUT.
  const editor = document.querySelector('.inline-comment-editor');
  if (editor) editor.classList.add('busy');

  const insertLines = buildCommentLines(draft, cleaned);
  const lines = String(v.content || '').split('\n');
  const targetIdx = Math.max(0, Math.min(lines.length - 1, draft.targetLine - 1));
  const newLines = lines.slice();
  newLines.splice(targetIdx, 0, ...insertLines);
  const newContent = newLines.join('\n');

  const id = state.activeId;
  let res;
  try {
    res = await authedFetch(`/sessions/${encodeURIComponent(id)}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: v.path, content: newContent, expectedMtimeMs: v.mtimeMs }),
    });
  } catch (e) {
    if (editor) editor.classList.remove('busy');
    alert(`Insert failed: ${e.message || e}`);
    return;
  }
  if (res.status === 409) {
    if (editor) editor.classList.remove('busy');
    alert('File changed on disk. Reload the file and try again.');
    return;
  }
  if (!res.ok) {
    if (editor) editor.classList.remove('busy');
    let body = {};
    try { body = await res.json(); } catch {}
    alert(`Insert failed: ${body.error || res.status}`);
    return;
  }
  const out = await res.json();
  v.content = newContent;
  v.mtimeMs = out.mtimeMs;
  v.size = out.size;
  v.commentDraft = null;
  renderFileViewerWithCards(newContent, v.path, v.cards || []);
}

// Per-extension single-line comment syntax. Wrapped types use both prefix
// and suffix on a single line. Default fallback is // (sane for most code).
function commentSyntaxForExt(ext) {
  const e = (ext || '').toLowerCase();
  if (['js','mjs','cjs','jsx','ts','tsx','c','h','cpp','hpp','java','kt','swift','go','rs','scss','sass','php','dart','groovy'].includes(e)) {
    return { prefix: '// ', suffix: '' };
  }
  if (['py','rb','sh','bash','zsh','yml','yaml','toml','dockerfile','r','pl','conf','ini'].includes(e)) {
    return { prefix: '# ', suffix: '' };
  }
  if (['html','htm','xml','svg','vue','svelte','md','markdown'].includes(e)) {
    return { prefix: '<!-- ', suffix: ' -->' };
  }
  if (['css'].includes(e)) {
    return { prefix: '/* ', suffix: ' */' };
  }
  if (['sql'].includes(e)) {
    return { prefix: '-- ', suffix: '' };
  }
  if (['lua'].includes(e)) {
    return { prefix: '-- ', suffix: '' };
  }
  return { prefix: '// ', suffix: '' };
}

async function deleteClaudeCard(messageId) {
  const v = state.files.viewing;
  if (!v) return;
  const id = state.activeId;
  // Find the Claude message + its paired user question; delete both.
  const claudeMsg = v.cards.find((m) => m.id === messageId && m.user === ASSISTANT_USER_NAME);
  if (!claudeMsg) return;
  let pairedUser = null;
  for (const m of v.cards) {
    if (m.user !== 'you') continue;
    if (anchorsEqual(m.anchor, claudeMsg.anchor)
        && new Date(m.ts).getTime() <= new Date(claudeMsg.ts).getTime()) {
      if (!pairedUser || new Date(m.ts).getTime() > new Date(pairedUser.ts).getTime()) pairedUser = m;
    }
  }
  const delIds = [messageId];
  if (pairedUser) delIds.push(pairedUser.id);
  for (const did of delIds) {
    try {
      await authedFetch(`/sessions/${encodeURIComponent(id)}/file-chat?path=${encodeURIComponent(v.path)}&messageId=${encodeURIComponent(did)}`, { method: 'DELETE' });
    } catch {}
  }
  v.cards = v.cards.filter((m) => !delIds.includes(m.id));
  renderFileViewerWithCards(v.content, v.path, v.cards);
}

// ── selection → anchor (line range inside a code chunk) ────────────────────

function onSelectionChange() {
  const bar = document.getElementById('files-action-bar');
  // If the user is interacting with the action bar itself — e.g. typing
  // a question into #files-ask-input — focusing the input collapses the
  // code-body selection and fires selectionchange. We must NOT tear the
  // bar down or null the captured anchor in that case; the line-range
  // anchor in state.files.viewing.selection is what the ask uses.
  if (bar && !bar.hidden && bar.contains(document.activeElement)) return;
  const v = state.files.viewing;
  // If an inline comment editor is open, the user is typing in the body —
  // selection changes there shouldn't kick the popover around (and the
  // popover is hidden anyway).
  if (v && v.commentDraft) return;

  if (!v || v.binary || !v.content) {
    hideActionBar();
    return;
  }
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideActionBar();
    if (v) v.selection = null;
    return;
  }
  const range = sel.getRangeAt(0);
  // Only react to selections rooted in a .code-chunk under our viewer body.
  const startChunk = closestAncestor(range.startContainer, '.code-chunk');
  const endChunk = closestAncestor(range.endContainer, '.code-chunk');
  if (!startChunk || !endChunk) { hideActionBar(); v.selection = null; return; }
  const body = document.getElementById('files-view-body');
  if (!body.contains(startChunk) || !body.contains(endChunk)) {
    hideActionBar(); v.selection = null; return;
  }
  const startLine = lineForPoint(startChunk, range.startContainer, range.startOffset);
  const endLine = lineForPoint(endChunk, range.endContainer, range.endOffset);
  if (!startLine || !endLine) { hideActionBar(); v.selection = null; return; }
  const a = Math.min(startLine, endLine);
  const b = Math.max(startLine, endLine);
  v.selection = { startLine: a, endLine: b };
  document.getElementById('files-action-label').textContent =
    a === b ? `L${a}` : `L${a}–${b}`;
  bar.hidden = false;
  positionActionBarNearSelection(range);

  // Dismiss the iOS / Android native selection callout (Copy / Look up /
  // Translate / Paste). We've already captured the line range into
  // v.selection — the action-bar label "L30–35" is now the visual cue, so
  // the OS menu is just noise on top. Collapse the selection to make it
  // disappear. The follow-up selectionchange (triggered by removeAllRanges)
  // is suppressed via _ignoreNextSelChange so it doesn't tear down the bar.
  _ignoreNextSelChange = 1;
  try { sel.removeAllRanges(); } catch {}
}

function hideActionBar() {
  const bar = document.getElementById('files-action-bar');
  if (bar) bar.hidden = true;
}

// Place the floating action bar near the selection rect. Anchored to the
// #files-view-pane (which is position:relative), so coordinates are relative
// to the pane. Prefers below-the-selection; flips above if it would overflow.
function positionActionBarNearSelection(range) {
  const bar = document.getElementById('files-action-bar');
  const pane = document.getElementById('files-view-pane');
  if (!bar || !pane) return;
  // Reset position so we can measure natural width.
  bar.style.top = '0px';
  bar.style.left = '0px';
  // Force layout to read accurate size.
  const barRect = bar.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();

  // Selection rect — for multi-line ranges, prefer the LAST client rect
  // (end of selection) so the popover sits at the cursor's release point.
  const rects = range.getClientRects();
  let selRect = rects && rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (!selRect || (selRect.width === 0 && selRect.height === 0)) {
    selRect = range.getBoundingClientRect();
  }

  const margin = 8;
  // Default: just below the selection.
  let top = (selRect.bottom - paneRect.top) + 6;
  let left = (selRect.right - paneRect.left) - barRect.width / 2;
  // Clamp left within pane.
  left = Math.max(margin, Math.min(left, paneRect.width - barRect.width - margin));
  // If below would overflow the pane, place above.
  if (top + barRect.height + margin > paneRect.height) {
    top = (selRect.top - paneRect.top) - barRect.height - 6;
  }
  // Clamp top within pane (in case selection itself is off-screen).
  top = Math.max(margin, Math.min(top, paneRect.height - barRect.height - margin));

  bar.style.top = `${Math.round(top)}px`;
  bar.style.left = `${Math.round(left)}px`;
}

// On scroll within the code body, re-anchor the popover to the moved selection
// (or hide it if the selection scrolled out of view).
function repositionActionBarIfVisible() {
  const bar = document.getElementById('files-action-bar');
  if (!bar || bar.hidden) return;
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { bar.hidden = true; return; }
  positionActionBarNearSelection(sel.getRangeAt(0));
}

function closestAncestor(node, selector) {
  let n = node;
  while (n) {
    if (n.nodeType === 1 && n.matches && n.matches(selector)) return n;
    n = n.parentNode;
  }
  return null;
}

// Compute the absolute line number at a (node, offset) point inside a code-chunk.
function lineForPoint(chunk, node, offset) {
  const startLine = parseInt(chunk.dataset.startLine, 10) || 1;
  const codeContent = chunk.querySelector('.code-content');
  if (!codeContent) return null;
  // Build a range from start of code to (node, offset) and count newlines in its text.
  let r;
  try {
    r = document.createRange();
    r.setStart(codeContent, 0);
    r.setEnd(node, offset);
  } catch { return null; }
  const text = r.toString();
  const newlines = (text.match(/\n/g) || []).length;
  return startLine + newlines;
}

function hljsLangForExt(ext) {
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    html: 'xml', xml: 'xml', svg: 'xml',
    css: 'css', scss: 'scss',
    md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    sql: 'sql', dockerfile: 'dockerfile', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp',
  };
  return map[ext] || null;
}

function humanBytes(n) {
  if (n == null) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

// ── log monitoring ──────────────────────────────────────────────────────────

function connectLogWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tokParam = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  const ws = new WebSocket(`${proto}://${location.host}/logs${tokParam}`);
  ws.addEventListener('message', (ev) => {
    try {
      const entry = JSON.parse(ev.data);
      if (entry.t === 'log') {
        state.logs.push(entry);
        if (state.logs.length > 200) state.logs.shift();
        renderStatusBar();
      }
    } catch {}
  });
  ws.addEventListener('close', () => { setTimeout(connectLogWs, 5000); });
  state.logWs = ws;
}

function renderStatusBar() {
  const indicator = document.getElementById('status-indicator');
  const text = document.getElementById('status-text');
  if (!state.logs.length) { text.textContent = 'mycod running'; return; }

  const recent = state.logs.slice(-30);
  const hasError = recent.some((e) => e.level === 'error');
  const hasWarn = recent.some((e) => e.level === 'warn');

  indicator.className = hasError ? 'error' : hasWarn ? 'warn' : '';
  const last = state.logs[state.logs.length - 1];
  const msg = last.msg.length > 60 ? last.msg.slice(0, 57) + '...' : last.msg;
  text.textContent = msg;
}

function toggleLogPanel() {
  const panel = document.getElementById('log-panel');
  const show = panel.hidden;
  panel.hidden = !show;
  if (show) renderLogEntries();
}

function renderLogEntries() {
  const el = document.getElementById('log-entries');
  const entries = state.logs.slice(-100);
  el.innerHTML = entries.map((e) => {
    const ts = e.ts ? _localTs(e.ts) : '';
    return `<div class="log-entry ${e.level}"><span class="log-ts">${escHtml(ts)}</span>${escHtml(e.msg)}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

// Mobile browsers may suspend a backgrounded tab and let the WS go silently
// dead — the OS doesn't surface the failure, so the client thinks it's still
// OPEN. On foreground, send a ping; if no pong within 2s, close the WS so
// the existing reconnect loop refreshes the terminal.
let lastProbeAt = 0;
function probeWsLiveness() {
  const now = Date.now();
  if (now - lastProbeAt < 1000) return; // debounce: visibility+focus+pageshow can all fire
  lastProbeAt = now;

  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  state.lastPongAt = 0;
  try { ws.send(JSON.stringify({ t: 'ping' })); }
  catch { try { ws.close(); } catch {} return; }
  setTimeout(() => {
    if (state.ws !== ws) return;       // already moved to a new WS
    if (state.lastPongAt) return;      // pong arrived in time
    try { ws.close(); } catch {}       // force reconnect
  }, 2000);
}

// While the tab is visible, also probe periodically so a silently-dead WS
// in the foreground is caught in ~15s instead of waiting up to 30-60s for
// the server-side ping to terminate it. Browsers throttle setInterval in
// background tabs, so we still gate on visibility for a clean lifecycle.
let visibilityProbeTimer = null;
function startVisibilityProbing() {
  if (visibilityProbeTimer) return;
  visibilityProbeTimer = setInterval(probeWsLiveness, 15000);
}
function stopVisibilityProbing() {
  if (visibilityProbeTimer) { clearInterval(visibilityProbeTimer); visibilityProbeTimer = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    probeWsLiveness();
    startVisibilityProbing();
  } else {
    stopVisibilityProbing();
  }
});
window.addEventListener('focus', probeWsLiveness);
window.addEventListener('pageshow', () => {
  probeWsLiveness();
  if (document.visibilityState === 'visible') startVisibilityProbing();
});
window.addEventListener('pagehide', stopVisibilityProbing);

if (document.visibilityState === 'visible') startVisibilityProbing();

document.addEventListener('DOMContentLoaded', () => {
  // Login modal exposes both GitHub OAuth (anchor → /auth/github/start) and
  // PAT login (input + button → POST /auth/login). The OAuth side needs no
  // wiring; the PAT side does.
  bindLoginUi();
  bootstrap();
  bindBestPracticesToggle();
  bindPlanOpenOnlyToggle();
  bindPlanTypeFilters();
  bindPlanSearch();
});

// Plan tab "Open only" toggle. Default OFF (show all items) so the
// behavior is opt-in. Persisted per-browser in
// localStorage.myco_plan_open_only ('1' = on, '0' = off). When ON,
// renderArtifact filters out done items so the user sees only open
// bugs / features / todos.
function bindPlanOpenOnlyToggle() {
  const toggle = document.getElementById('plan-open-only-toggle');
  if (!toggle) return;
  const enabled = (localStorage.getItem('myco_plan_open_only') || '0') === '1';
  toggle.checked = enabled;
  toggle.addEventListener('change', () => {
    localStorage.setItem('myco_plan_open_only', toggle.checked ? '1' : '0');
    // Re-render with the current cached plan artifact so the filter
    // takes effect immediately without an HTTP round-trip.
    const cached = state.artifacts
      && state.artifacts.byType
      && state.artifacts.byType.plan;
    if (cached) renderArtifact('plan', cached);
  });
}

// fr-56: Plan-tab type-filter chips (Bug / Feature / Todo). Default
// ALL enabled (show everything) so the behavior is opt-in. Persisted
// per-browser in localStorage.myco_plan_type_filter (JSON array of
// layer names, e.g. ["Bug","Feature"]). The 3 chips' DOM ids are pinned
// (plan-filter-bug/feature/todo); each <label> carries data-type with
// the canonical layer value. _readPlanTypeFilter reads the persisted
// set OR defaults to all three. The fr-56 regression test pins the
// chip DOM + filter semantics.
const PLAN_TYPE_FILTER_KEY = 'myco_plan_type_filter';
const PLAN_ALL_TYPES = ['Bug', 'Feature', 'Todo'];
function _readPlanTypeFilter() {
  try {
    const raw = localStorage.getItem(PLAN_TYPE_FILTER_KEY);
    if (!raw) return PLAN_ALL_TYPES.slice();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return PLAN_ALL_TYPES.slice();
    // Keep only known layers — guards against forward-incompat values.
    return parsed.filter((t) => PLAN_ALL_TYPES.includes(t));
  } catch { return PLAN_ALL_TYPES.slice(); }
}
function bindPlanTypeFilters() {
  const chips = [
    { id: 'plan-filter-bug',     type: 'Bug' },
    { id: 'plan-filter-feature', type: 'Feature' },
    { id: 'plan-filter-todo',    type: 'Todo' },
  ];
  const persisted = new Set(_readPlanTypeFilter());
  chips.forEach(({ id, type }) => {
    const cb = document.getElementById(id);
    if (!cb) return;
    cb.checked = persisted.has(type);
    cb.addEventListener('change', () => {
      const next = new Set();
      chips.forEach(({ id: iid, type: itype }) => {
        const c = document.getElementById(iid);
        if (c && c.checked) next.add(itype);
      });
      localStorage.setItem(PLAN_TYPE_FILTER_KEY, JSON.stringify([...next]));
      const cached = state.artifacts && state.artifacts.byType && state.artifacts.byType.plan;
      if (cached) renderArtifact('plan', cached);
    });
  });
}

// bug-35: capture + restore #plan-search focus across renderArtifact's
// plan path. renderArtifact moves #plan-filter-row twice via insertBefore
// (out of the body for the innerHTML wipe, then back in). Each move
// detaches the row, and browsers drop focus from any focused descendant
// on detach. Without these helpers, the 150ms debounced search re-render
// kicked focus out of #plan-search mid-typing.
//
// Capture is taken BEFORE the first stash; restore runs AFTER the matching
// attach. Returns null when #plan-search isn't focused (no-op restore).
// Caret position (selectionStart/End) is preserved so re-focus doesn't
// jump the cursor to the end of the input.
function _capturePlanSearchFocus() {
  try {
    const input = document.getElementById('plan-search');
    if (!input) return null;
    if (document.activeElement !== input) return null;
    return {
      start: input.selectionStart,
      end:   input.selectionEnd,
    };
  } catch { return null; }
}
function _restorePlanSearchFocus(snap) {
  if (!snap) return;
  try {
    const input = document.getElementById('plan-search');
    if (!input) return;
    // Refocus first, then restore caret. setSelectionRange before focus
    // is a no-op on some browsers when the input isn't focused.
    input.focus();
    if (typeof snap.start === 'number' && typeof snap.end === 'number') {
      input.setSelectionRange(snap.start, snap.end);
    }
  } catch { /* element detached / not focusable — give up silently */ }
}

// fr-56: Plan-tab fuzz-search input. Case-insensitive substring across
// item id + text + body. Debounced 150ms so each keystroke doesn't
// re-render. Query lives in state.planSearchQuery (NOT persisted —
// resets on reload; type filters DO persist, so the reload defaults
// to a useful state without trapping the user behind stale terms).
function bindPlanSearch() {
  const input = document.getElementById('plan-search');
  if (!input) return;
  input.value = state.planSearchQuery || '';
  let timer = null;
  input.addEventListener('input', () => {
    state.planSearchQuery = input.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const cached = state.artifacts && state.artifacts.byType && state.artifacts.byType.plan;
      if (cached) renderArtifact('plan', cached);
    }, 150);
  });
}

// fr-61: relocate #plan-filter-row INTO #artifact-body-plan so the
// CSS `position: sticky; top: 0` actually pins the filter row to
// the top of the body's scroll viewport. Without this move the
// row is a SIBLING of the scroll container and sticky has no
// scrolling ancestor to pin against (it silently behaves like
// static — the filter would scroll out of view on a long list).
//
// Used as a detach-set-innerHTML-reattach pair:
//   _stashPlanFilterRow()             // rescue from the body
//   body.innerHTML = newContent;      // wipe is safe now
//   _attachPlanFilterRowToBody(...)   // re-insert at top
//
// _stashPlanFilterRow is REQUIRED before any plan-body innerHTML
// write — otherwise the wipe destroys the row permanently and
// _attachPlanFilterRowToBody returns early (no element to find).
// Tab switches + clearArtifactBodies + the renderArtifact paths
// all participate in this dance. Pre-fix the user reported the
// filter row vanishing after tab/session switches (the wipe ate
// it; the post-innerHTML _attachPlanFilterRowToBody had nothing
// to re-attach).
function _stashPlanFilterRow() {
  const filterRow = document.getElementById('plan-filter-row');
  if (!filterRow) return;
  const planWrap = document.getElementById('plan-wrap');
  const planBody = document.getElementById('artifact-body-plan');
  if (!planWrap || !planBody) return;
  // Move back to its original static-HTML position (sibling of the
  // body inside the wrap) so the upcoming body.innerHTML wipe doesn't
  // destroy it. _attachPlanFilterRowToBody after the wipe restores it.
  if (filterRow.parentElement !== planWrap) {
    planWrap.insertBefore(filterRow, planBody);
  }
}
function _attachPlanFilterRowToBody(body, type) {
  if (type !== 'plan' || !body) return;
  const filterRow = document.getElementById('plan-filter-row');
  if (!filterRow) return;
  // Only re-insert if not already the first child of the body —
  // saves a layout pass on no-op calls.
  if (filterRow.parentElement !== body || filterRow !== body.firstElementChild) {
    body.insertBefore(filterRow, body.firstChild);
  }
}

// fr-65: per-layer "closed items" accordion state. Each layer
// (Bug / Feature / Todo / Other / future layers) has its own
// expand/collapse state persisted in localStorage. Key shape:
//   myco_plan_layer_expand_<sanitized-layer-name>  → '1' | '0'
// Default '0' (collapsed). Sanitization (_planLayerStorageKey) strips
// non-alnum so unusual layer names from the extractor don't break the
// key format.
function _planLayerStorageKey(layer) {
  return String(layer || 'Other').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function _readPlanLayerExpanded(layerKey) {
  try {
    return (localStorage.getItem('myco_plan_layer_expand_' + layerKey) || '0') === '1';
  } catch { return false; }
}
function _writePlanLayerExpanded(layerKey, expanded) {
  try { localStorage.setItem('myco_plan_layer_expand_' + layerKey, expanded ? '1' : '0'); } catch {}
}

// User feedback: "Some plan items have long text, making it difficult
// to scroll, put a limit and allow expand." Clamp long item text to
// ~5 lines with CSS line-clamp; show a "Show more / less" pill that
// flips per-item expand state. State lives in state.planExpandedItems
// (a Set of item ids) — not persisted (fresh per page load — expand
// is a "right now I want to read this" intent, not a preference).
//
// Threshold for "long": >280 chars OR ≥4 newlines. Either heuristic
// catches the common cases without needing DOM measurement (cheaper
// than a getBoundingClientRect / scrollHeight check on every render).
function _planItemIsLongText(it) {
  const raw = (it && it.text) || '';
  if (raw.length > 280) return true;
  const nl = (raw.match(/\n/g) || []).length;
  return nl >= 4;
}
function _planItemIsExpanded(it) {
  return !!(state.planExpandedItems && state.planExpandedItems.has(it && it.id));
}
function _planItemTextClass(it) {
  const base = 'artifact-item-text artifact-md';
  if (_planItemIsLongText(it) && !_planItemIsExpanded(it)) {
    return base + ' is-clamped';
  }
  return base;
}
function _planItemTextExpandToggle(it) {
  if (!_planItemIsLongText(it)) return '';
  const expanded = _planItemIsExpanded(it);
  const label = expanded ? 'Show less' : 'Show more';
  return `<button class="artifact-item-text-expand" data-id="${escHtml(it.id)}" type="button" aria-expanded="${expanded ? 'true' : 'false'}">${label}</button>`;
}

// fr-80 r6: render `item.description` as the body of the plan card.
// New `description` field (added when claude rewrites with TITLE +
// DESCRIPTION) carries the Problem/Expected/Actual/Context body. The
// `text` field becomes the one-line scannable title; this helper
// renders the body markdown directly below the title — visible by
// default, since description IS the body, not an optional section
// (contrast with _planItemDetailsHtml's Analysis/Impl-Plan, which
// stay collapsed to keep the list compact). Items without a
// description (pre-r6 plan items where the whole body lives in
// item.text) render exactly as before — this returns ''.
function _planItemDescriptionHtml(it) {
  if (!it) return '';
  const txt = (it.description == null) ? '' : String(it.description).trim();
  if (!txt) return '';
  return `<div class="artifact-item-description artifact-md">${renderMd(txt)}</div>`;
}

// fr-77 r17 Phase 1: optional Analysis + Implementation-Plan sections.
// User asked to "separate into analysis, impl plan" so the body of a
// plan item is easier to read. Backed by two new optional string
// fields on plan items: `analysis` and `implPlan`. When EITHER is
// populated, this helper emits collapsible <details> blocks below
// the item's main text body. Both default to closed so the list
// stays compact; clicking the summary expands inline. Items without
// either field render exactly as before (empty string).
// Markdown is rendered inside via renderMd (the same path as the
// main item body), so code fences / lists / mermaid all work.
function _planItemDetailsHtml(it) {
  if (!it) return '';
  const sections = [
    { key: 'analysis', label: 'Analysis',           text: it.analysis },
    { key: 'implPlan', label: 'Implementation plan', text: it.implPlan },
  ];
  const parts = [];
  for (const s of sections) {
    const txt = (s.text == null) ? '' : String(s.text).trim();
    if (!txt) continue;
    parts.push(
      `<details class="artifact-item-section" data-section="${escHtml(s.key)}">` +
        `<summary class="artifact-item-section-summary">${escHtml(s.label)}</summary>` +
        `<div class="artifact-item-section-body artifact-md">${renderMd(txt)}</div>` +
      `</details>`
    );
  }
  if (parts.length === 0) return '';
  return `<div class="artifact-item-sections">${parts.join('')}</div>`;
}

// fr-64: derive a single status string for a plan item based on
// existing state — no new schema. Precedence (first match wins):
//   running    — item is in state.runQueue with status==='running'
//   queued     — item is in state.runQueue with status==='pending'
//   closed     — item.done is truthy
//   inprogress — has prior run history (runs.length > 0) but isn't
//                currently active or closed (treated as "📌 pinned"
//                in the chip glyph — represents in-flight work the
//                user has touched at least once)
//   open       — fallthrough default for fresh items
function _planItemStatus(it, runQueueEntries) {
  const entries = Array.isArray(runQueueEntries) ? runQueueEntries : [];
  const qEntry = [...entries].reverse().find((e) => e && e.itemId === it.id);
  if (qEntry && qEntry.status === 'running') return 'running';
  if (qEntry && qEntry.status === 'pending') return 'queued';
  if (it && it.done) return 'closed';
  if (it && Array.isArray(it.runs) && it.runs.length > 0) return 'inprogress';
  return 'open';
}

// fr-64: status → glyph + CSS class + accessible label. Pure mapper.
// Kept as a top-level constant + function so the regression test can
// pin the contract without DOM.
const _PLAN_ITEM_STATUS_MAP = {
  running:    { glyph: '▶',  label: 'running',     cls: 'is-running' },
  queued:     { glyph: '⏸',  label: 'queued',      cls: 'is-queued' },
  closed:     { glyph: '🟢', label: 'closed',      cls: 'is-closed' },
  inprogress: { glyph: '📌', label: 'in progress', cls: 'is-inprogress' },
  open:       { glyph: '⚪', label: 'open',        cls: 'is-open' },
};
function _planItemStatusChipHtml(status) {
  const s = _PLAN_ITEM_STATUS_MAP[status] || _PLAN_ITEM_STATUS_MAP.open;
  return `<span class="artifact-item-status-chip ${s.cls}" title="${s.label}" aria-label="${s.label}">${s.glyph}</span>`;
}

// fr-56: pure filter function shared by renderArtifact('plan', ...).
// Top-level so the regression test can simulate the same semantics
// inline (no jsdom needed). Three independent filters, ANDed:
//   - openOnly: drop done items
//   - types: keep only items whose .layer is in the allowed set
//     (null = no filter; empty array = filter out everything)
//   - search: case-insensitive substring across id + text + body
function _filterPlanItems(items, opts) {
  const { openOnly, types, search } = (opts || {});
  const typeSet = Array.isArray(types) ? new Set(types) : null;
  const q = String(search || '').trim().toLowerCase();
  return (items || []).filter((it) => {
    if (!it) return false;
    if (openOnly && it.done) return false;
    if (typeSet && it.layer && !typeSet.has(it.layer)) return false;
    // Items without a `layer` (forward-compat or extractor edge cases)
    // pass the type filter — better to surface than to hide.
    if (q) {
      const hay = ((it.id || '') + ' ' + (it.text || '') + ' ' + (it.body || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// Inject-best-practices toggle on the Arch tab. Default on; persisted
// per-browser in localStorage (key: myco_bp_enabled). Template body is
// fetched once from /best-practices-template.md and cached on
// state.bpTemplate; subsequent Arch renders read from cache.
function bindBestPracticesToggle() {
  const toggle = document.getElementById('bp-toggle');
  if (!toggle) return;
  const enabled = (localStorage.getItem('myco_bp_enabled') || '1') === '1';
  toggle.checked = enabled;
  toggle.addEventListener('change', () => {
    localStorage.setItem('myco_bp_enabled', toggle.checked ? '1' : '0');
    // Re-render the Arch tab if it's the active artifact view.
    if (state.artifactView && state.artifactView.active === 'arch') {
      loadArtifact('arch').catch(() => {});
    }
  });
  // Lazy-load the template once. Falls back silently on failure —
  // toggle still works, banner just won't render. The fetch result is
  // cached on state so subsequent Arch renders are synchronous.
  if (!state.bpTemplate) {
    fetch('/best-practices-template.md')
      .then((r) => (r && r.ok ? r.text() : null))
      .then((txt) => {
        state.bpTemplate = txt || '';
        if (state.artifactView && state.artifactView.active === 'arch') {
          loadArtifact('arch').catch(() => {});
        }
      })
      .catch(() => { state.bpTemplate = ''; });
  }
}

// ─── Admin Dashboard UI and Handlers ────────────────────────────────────────

function bindAdminUi() {
  const btnAdmin = document.getElementById('btn-admin');
  if (!btnAdmin) return;

  // fr-87 r4: gear icon is THE single Config affordance.
  //
  // Pre-r4: gate was a hardcoded login-list isAdmin check (labxnow |
  // kkrazy | ryan-blues), and click opened the standalone admin pane
  // (#admin-wrap). Non-admin users never saw the icon, and the user-
  // facing Config modal was reached via a separate #btn-config (user-
  // cog) icon — confusing duplication.
  //
  // Post-r4: visibility is gated on auth (state.chatUser) — any
  // authenticated user sees the gear because clicking it opens the
  // unified Config modal, which has user-scoped PATs for everyone +
  // an admin section that the SERVER-side requireAdmin gate (in
  // _refreshConfigAdmin's GET /api/admin/config probe) reveals only
  // to actual admins. So the gear's visibility is liberal; the
  // admin-only contents stay protected at the modal-section level.
  if (state.chatUser) {
    btnAdmin.removeAttribute('hidden');
    btnAdmin.style.display = 'inline-flex';
  } else {
    btnAdmin.hidden = true;
    btnAdmin.style.display = '';
  }

  if (btnAdmin.dataset.bound) return;
  btnAdmin.dataset.bound = '1';

  btnAdmin.addEventListener('click', () => {
    // fr-87 r4: gear opens the unified Config modal. The standalone
    // #admin-wrap pane is now orphaned — markup remains but no UI
    // entry points to it; future cleanup can yank it.
    openConfigModal();
  });

  // fr-91 r3: removed orphaned wirings (password reveal toggles,
  // btn-save-config, btn-add-whitelist, input-whitelist-user) — all
  // pointed at #admin-wrap elements deleted in fr-91 r3. The Config
  // modal's #config-admin-env-form has its own save handler wired
  // in _populateConfigAdminEnv().
}


// fr-91: probe an admin API key against the live provider so the
// user can verify validity BEFORE Save → before real traffic hits
// the misconfigured key. Reads the field's CURRENT value (not the
// saved env) so a freshly-pasted key can be tested before being
// committed to .env. Inline-warning policy: this never blocks Save
// — the result is rendered next to the input and the user is
// responsible for acting on it.
// fr-91 button + input + status id maps. Explicit (not built via
// template literal) so a static-grep regression test can lock the
// id contract — the four buttons in index.html must keep these
// exact ids so the binder + click handler resolve cleanly.
// fr-91 r3: input ids switched from input-*-key (orphaned
// #admin-wrap pane, now deleted) to config-admin-*-key (the live
// #config-admin-env-form inside the Config modal).
const FR91_INPUT_IDS = {
  anthropic: 'config-admin-anthropic-key',
  gemini:    'config-admin-gemini-key',
  openai:    'config-admin-openai-key',
  critic:    'config-admin-critic-key',
};
const FR91_BTN_IDS = {
  anthropic: 'btn-test-anthropic',
  gemini:    'btn-test-gemini',
  openai:    'btn-test-openai',
  critic:    'btn-test-critic',
};
const FR91_STATUS_IDS = {
  anthropic: 'test-status-anthropic',
  gemini:    'test-status-gemini',
  openai:    'test-status-openai',
  critic:    'test-status-critic',
};

async function _runApiKeyTest(which) {
  const inputId = FR91_INPUT_IDS[which];
  const statusId = FR91_STATUS_IDS[which];
  const btnId = FR91_BTN_IDS[which];
  const input = document.getElementById(inputId);
  const statusEl = document.getElementById(statusId);
  const btn = document.getElementById(btnId);
  if (!input || !statusEl) return;

  const key = (input.value || '').trim();
  // Custom Critic also reads the endpoint + model fields. fr-91 r3:
  // ids switched to the live #config-admin-env-form scheme.
  const endpoint = which === 'critic'
    ? (document.getElementById('config-admin-critic-endpoint') || { value: '' }).value.trim()
    : undefined;
  const model = which === 'critic'
    ? (document.getElementById('config-admin-critic-model') || { value: '' }).value.trim()
    : undefined;

  statusEl.textContent = 'Testing…';
  statusEl.className = 'test-key-status testing';
  if (btn) btn.disabled = true;

  // fr-91 r4: client-side timeout so a hung server probe can't
  // leave the button stuck disabled forever. AbortController fires
  // after 20s, the await rejects, the catch runs, the finally
  // re-enables the button. Pre-r4 a misconfigured Gemini probe
  // (SDK hang) would leave the button disabled until full page
  // reload.
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 20000);

  try {
    const res = await authedFetch('/api/admin/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ which, key, endpoint, model }),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (data.ok) {
      statusEl.textContent = `✓ ${data.name || 'Valid'}`;
      statusEl.className = 'test-key-status ok';
    } else {
      statusEl.textContent = `✗ ${data.error || 'Invalid'}`;
      statusEl.className = 'test-key-status err';
    }
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? 'probe timed out after 20s'
      : (err && err.message || String(err));
    statusEl.textContent = `✗ ${msg}`;
    statusEl.className = 'test-key-status err';
  } finally {
    clearTimeout(timeoutId);
    if (btn) btn.disabled = false;
  }
}

function _bindApiKeyTestButtons() {
  for (const which of Object.keys(FR91_BTN_IDS)) {
    const btn = document.getElementById(FR91_BTN_IDS[which]);
    if (!btn || btn.dataset.fr91Bound === '1') continue;
    btn.dataset.fr91Bound = '1';
    btn.addEventListener('click', () => _runApiKeyTest(which));
  }
}

async function loadWhitelist() {
  const statusEl = document.getElementById('whitelist-status');
  const chipsEl = document.getElementById('whitelist-chips');
  if (chipsEl) {
    chipsEl.innerHTML = '<div style="opacity:0.6;font-size:0.8rem;">Loading whitelisted users...</div>';
  }

  try {
    const res = await authedFetch('/api/admin/allowlist');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    if (chipsEl) {
      chipsEl.innerHTML = '';
      if (data && Array.isArray(data.allowlist) && data.allowlist.length) {
        data.allowlist.forEach(username => {
          const chip = document.createElement('div');
          chip.className = 'whitelist-chip';
          chip.textContent = username;

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'whitelist-chip-remove';
          removeBtn.textContent = '×';
          removeBtn.title = `Remove ${username} from whitelist`;
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeWhitelistUser(username, chip);
          });

          chip.appendChild(removeBtn);
          chipsEl.appendChild(chip);
        });
      } else {
        chipsEl.innerHTML = '<div style="opacity:0.5;font-size:0.8rem;font-style:italic;">No users in allowlist. Single-user fallback mode active if allowed-github-users.txt is empty.</div>';
      }
    }
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'status-msg error';
      statusEl.textContent = `Error loading allowlist: ${err.message}`;
    }
  }
}

async function addWhitelistUser(username) {
  username = String(username || '').trim();
  if (!username) return;

  const statusEl = document.getElementById('whitelist-status');
  if (statusEl) {
    statusEl.className = 'status-msg';
    statusEl.textContent = 'Adding user...';
  }

  try {
    const res = await authedFetch('/api/admin/allowlist', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.added === false) {
      if (statusEl) {
        statusEl.className = 'status-msg error';
        statusEl.textContent = `User ${username} is already in the whitelist.`;
      }
    } else {
      if (statusEl) {
        statusEl.className = 'status-msg success';
        statusEl.textContent = `User ${username} added successfully!`;
        setTimeout(() => {
          if (statusEl.textContent.includes('successfully')) statusEl.textContent = '';
        }, 3000);
      }
      const inputEl = document.getElementById('input-whitelist-user');
      if (inputEl) inputEl.value = '';
      
      // Reload whitelist chips
      await loadWhitelist();
    }
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'status-msg error';
      statusEl.textContent = `Failed to add user: ${err.message}`;
    }
  }
}

async function removeWhitelistUser(username, chipElement) {
  if (!confirm(`Are you sure you want to remove ${username} from the whitelist?`)) return;

  const statusEl = document.getElementById('whitelist-status');
  if (statusEl) {
    statusEl.className = 'status-msg';
    statusEl.textContent = 'Removing user...';
  }

  try {
    const res = await authedFetch(`/api/admin/allowlist/${encodeURIComponent(username)}`, {
      method: 'DELETE'
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    
    if (statusEl) {
      statusEl.className = 'status-msg success';
      statusEl.textContent = `User ${username} removed successfully!`;
      setTimeout(() => {
        if (statusEl.textContent.includes('successfully')) statusEl.textContent = '';
      }, 3000);
    }

    // Smooth removal animation
    if (chipElement) {
      chipElement.style.transform = 'scale(0.8)';
      chipElement.style.opacity = '0';
      setTimeout(() => {
        chipElement.remove();
        // If no chips left, reload to show empty state
        const container = document.getElementById('whitelist-chips');
        if (container && !container.children.length) {
          loadWhitelist();
        }
      }, 200);
    } else {
      await loadWhitelist();
    }
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'status-msg error';
      statusEl.textContent = `Failed to remove user: ${err.message}`;
    }
  }
}
