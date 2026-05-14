/* global Terminal, FitAddon, WebglAddon, CanvasAddon, Keyboard */

// Kick off font load as soon as the script runs. The browser doesn't fetch
// @font-face fonts until something references them, and xterm's WebGL/Canvas
// renderer caches glyphs at terminal init — if we open xterm before the
// Nerd Font is loaded, the atlas is built with the fallback font and box
// drawing characters render at the wrong widths, scrambling Claude's splash.
const fontsReady = (typeof document !== 'undefined' && document.fonts)
  ? Promise.all([
      document.fonts.load("13px 'JetBrains Mono Nerd Font'"),
      document.fonts.load("bold 13px 'JetBrains Mono Nerd Font'"),
    ]).catch(() => {})
  : Promise.resolve();

// Force xterm to rebuild its glyph atlas once the font is actually loaded.
// Setting fontFamily to itself triggers an internal re-measure; refresh()
// repaints the visible buffer with the new atlas.
function refreshXtermAfterFontLoad(term) {
  if (!term || !fontsReady) return;
  fontsReady.then(() => {
    try {
      const ff = term.options.fontFamily;
      term.options.fontFamily = ff;
      term.refresh(0, Math.max(0, (term.rows || 1) - 1));
    } catch {}
  });
}

const state = {
  sessions: [],
  activeId: null,
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
  // Default false on all viewports — chat is a toggle-on view now, not
  // a default-on sidebar. Earlier `window.innerWidth > 900` left the
  // bit set to true on desktop boot, so the very first click on the
  // 💬 icon computed `setChatPane(!true)` → setChatPane(false), which
  // routes to showTerminalView() and the chat appears never to open.
  chatPaneVisible: false,
  shareMode: false, // kept for compat — no longer gates UI
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
  artifacts: {},
  // In-flight tool-call tracker mirrored from the server. Keyed by
  // tool_use_id; populated by `state-update { kind: 'tool-progress' }`
  // frames. The chat pane surfaces a "waiting on Agent · 47s"
  // indicator when this has entries so long-running tools (Agent,
  // Monitor, etc.) don't look like the session has hung.
  openToolCalls: [],
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

function showLogin() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.hidden = false;
}

function hideLogin() {
  const modal = document.getElementById('login-modal');
  if (modal) modal.hidden = true;
}

async function tryToken(token) {
  if (!token) return false;
  const res = await fetch('/auth/check', { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (body.ok && body.user) state.chatUser = body.user;
  return !!body.ok;
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

function ensureXtermForFallback() {
  if (state.term) return;
  document.getElementById('terminal-wrap').hidden = false;
  state.term = new Terminal({
    scrollback: IS_TOUCH_DEVICE ? 1500 : 5000,  // smaller buffer on mobile = less GC pressure
    fontSize: 13,
    fontFamily: "'JetBrains Mono Nerd Font', 'JetBrains Mono', Menlo, monospace",
    cursorBlink: false,                           // idle blinks force needless repaints
    smoothScrollDuration: 0,                      // we drive scroll ourselves
  });
  state.fitAddon = new FitAddon.FitAddon();
  state.term.loadAddon(state.fitAddon);
  const el = document.getElementById('terminal');
  el.innerHTML = '';
  state.term.open(el);
  state.fitAddon.fit();
  // Renderer choice: Canvas on mobile, WebGL on desktop. WebGL on mobile
  // Safari is expensive — every scroll dirties the canvas, and the
  // GPU/CPU sync penalty on tile-based mobile GPUs makes scroll feel
  // chunky. CanvasAddon does direct pixel writes, which is genuinely
  // faster for terminal-style content on phones.
  if (IS_TOUCH_DEVICE) {
    try { state.term.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
  } else {
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
      state.term.loadAddon(webgl);
    } catch {
      try { state.term.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
    }
  }
  // Custom touch handler on both mobile and desktop — native scroll doesn't
  // reach .xterm-viewport because .xterm-screen overlays it in the DOM.
  setupTouchScroll(state.term);
  refreshXtermAfterFontLoad(state.term);
}

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

// The main pane has six mutually-exclusive sub-panes. Always hide the
// others when switching; otherwise the panes stack and the inactive one
// disappears behind / beside the active one. Chat is NOT in this list —
// it's a left-sidebar overlay (desktop) / full-pane overlay (mobile)
// that can coexist with whatever main-pane view is active underneath.
const MAIN_PANE_IDS = ['terminal-wrap', 'conversation-wrap', 'files-wrap', 'plan-wrap', 'arch-wrap', 'test-wrap'];

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
  for (const t of ['plan', 'arch', 'test']) {
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

function showConversationView() {
  _hideMainPaneSiblings('conversation-wrap');
  document.getElementById('conversation-wrap').hidden = false;
  updateChatButton();
  // Always land on the latest content when the conv pane opens. While
  // the pane was hidden it had 0 height, so any earlier scrollConvToBottom
  // call was effectively a no-op; without this re-pin the user sees the
  // top of the transcript on each show.
  scrollConvToBottom();
}

function showTerminalView() {
  _hideMainPaneSiblings('terminal-wrap');
  document.getElementById('terminal-wrap').hidden = false;
  updateChatButton();
  // xterm canvas needs a refit after being unhidden since clientWidth was 0.
  if (state.fitAddon) requestAnimationFrame(() => state.fitAddon.fit());
  // Same rationale as showConversationView — land on the latest output
  // every time the terminal becomes visible.
  if (state.term) requestAnimationFrame(() => { try { state.term.scrollToBottom(); } catch {} });
}

function showTranscriptWaiting() {
  showConversationView();
  const content = document.getElementById('conv-content');
  if (content) content.innerHTML = '<div class="conv-waiting">Waiting for session to start...</div>';
  // Re-attach a pending-menu callout (if any) — innerHTML wipe just
  // dropped it. Keeps trust-folder / plan / permission dialogs visible
  // while the JSONL transcript is still empty.
  _renderPendingMenuCallout();
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Full markdown rendering for conversation view via marked library.
//
// Wrapped in try/catch so a single bad message (unclosed fence, exotic
// unicode, hljs hiccup) can't crash the render pipeline. Falls back to
// escHtml on failure and logs the first time it does so per page — that
// fingerprint is how we'd diagnose "raw text after @myco" style
// regressions: if you suddenly see `[renderMd] marked unavailable` or
// `[renderMd] marked.parse threw` in the console after an event, that
// pinpoints the cause.
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
    return marked.parse(String(text == null ? '' : text), { breaks: true, gfm: true, renderer });
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
  if (typeof mermaid === 'undefined') return;
  const blocks = container.querySelectorAll('pre code.language-mermaid');
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

function scrollConvToBottom() {
  // The transcript scroller used to be #conversation-wrap; once #terminal-tail
  // was docked at the bottom, #conv-messages became the actual scroller.
  const wrap = document.getElementById('conv-messages');
  if (!wrap) return;
  requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
}

function isConvAtBottom() {
  const wrap = document.getElementById('conv-messages');
  if (!wrap) return true;
  return wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 60;
}

// Cap the number of transcript messages rendered. Long sessions accumulate
// thousands of turns in the JSONL; without a cap the read-only viewer ends
// up holding the whole history in DOM, which gets slow on mobile and
// memory-hungry on long-running sessions. We keep the most-recent slice and
// drop the oldest. State retains the full array so we can re-render the
// trailing window after each delta.
const TRANSCRIPT_RENDER_CAP = 500;

function tailMessages(messages) {
  if (!Array.isArray(messages)) return [];
  if (messages.length <= TRANSCRIPT_RENDER_CAP) return messages;
  return messages.slice(messages.length - TRANSCRIPT_RENDER_CAP);
}

// Transcript turns are inserted into #conv-content (a child of #conv-messages
// that lives ABOVE #terminal-tail). Wiping conv-content via innerHTML never
// touches the sibling tail card, so the embedded mini xterm survives every
// transcript reset/append.
function renderTranscriptMessages(messages) {
  showConversationView();
  const content = document.getElementById('conv-content');
  if (!content) return;
  content.innerHTML = '';
  const tailed = tailMessages(messages);
  if (Array.isArray(messages) && messages.length > tailed.length) {
    const banner = document.createElement('div');
    banner.className = 'conv-truncation-note';
    banner.textContent = `… ${messages.length - tailed.length} earlier message${messages.length - tailed.length === 1 ? '' : 's'} hidden (showing the most recent ${tailed.length})`;
    content.appendChild(banner);
  }
  let turnEl = null;
  for (const m of tailed) {
    const el = renderConvMessage(m);
    // Start a new turn on user messages
    if (m.role === 'user' || m.role === 'title') {
      turnEl = document.createElement('div');
      turnEl.className = 'conv-turn';
      content.appendChild(turnEl);
    }
    if (turnEl) {
      turnEl.appendChild(el);
    } else {
      content.appendChild(el);
    }
  }
  scrollConvToBottom();
  renderMermaidInContainer(content);
  // Re-attach the pending-menu callout (if any) at the top — the
  // innerHTML wipe above removed it. Keeps the menu visible across
  // transcript re-renders so the user can still pick an option.
  _renderPendingMenuCallout();
}

function appendTranscriptMessages(messages) {
  // Once the running transcript exceeds the render cap, switch from append
  // to a re-render of the trailing window so oldest entries fall off the
  // top. Under-cap appends stay fast.
  if (Array.isArray(state.transcriptMessages) && state.transcriptMessages.length > TRANSCRIPT_RENDER_CAP) {
    renderTranscriptMessages(state.transcriptMessages);
    return;
  }
  // Defensive out-of-order guard. The caller pushes `messages` onto
  // state.transcriptMessages BEFORE invoking us. If any incoming msg
  // carries a ts older than the last pre-push entry, the array is now
  // out of order — typically after a reconnect that delivered a delta
  // for a transcript-flush that happened mid-network-blip, or after a
  // subagent/Monitor event arriving asynchronously. Sort + re-render
  // so the chronology stays correct. Rare path; cheap when it fires.
  if (Array.isArray(state.transcriptMessages) && state.transcriptMessages.length > messages.length) {
    const prevLen = state.transcriptMessages.length - messages.length;
    const lastPrevTs = state.transcriptMessages[prevLen - 1] && state.transcriptMessages[prevLen - 1].ts;
    const anyOlder = lastPrevTs && messages.some((m) => m && m.ts && m.ts < lastPrevTs);
    if (anyOlder) {
      state.transcriptMessages.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
      renderTranscriptMessages(state.transcriptMessages);
      return;
    }
  }
  const content = document.getElementById('conv-content');
  if (!content) return;
  let turnEl = content.lastElementChild;
  if (turnEl && !turnEl.classList?.contains('conv-turn')) turnEl = null;
  for (const m of messages) {
    const el = renderConvMessage(m);
    if (m.role === 'user' || m.role === 'title') {
      turnEl = document.createElement('div');
      turnEl.className = 'conv-turn';
      content.appendChild(turnEl);
    }
    if (turnEl) {
      turnEl.appendChild(el);
    } else {
      content.appendChild(el);
    }
  }
  // Always pin to latest — per the chat-pane/conv contract, these views
  // are tail-readers: new messages should always pull the viewport
  // down. Previously this only scrolled when isConvAtBottom() was true,
  // which silently stranded the user on old content if they were
  // anywhere above the last ~60px of the scroller.
  scrollConvToBottom();
  renderMermaidInContainer(content);
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

  document.getElementById('btn-spawn').addEventListener('click', openSpawnModal);
  document.getElementById('spawn-cancel').addEventListener('click', closeSpawnModal);
  document.getElementById('spawn-ok').addEventListener('click', doSpawn);
  document.getElementById('btn-expand').addEventListener('click', () => setSidebar(false));
  document.getElementById('btn-collapse').addEventListener('click', () => setSidebar(true));
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
function showUserStamp() {
  const el = document.getElementById('user-stamp');
  if (!el) return;
  el.textContent = state.chatUser ? `@${state.chatUser}` : '';
  el.title = state.chatUser ? `Logged in as ${state.chatUser} — click to sign out` : '';
  if (state.chatUser && !el.dataset.logoutBound) {
    el.dataset.logoutBound = '1';
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      // Status-bar parent has its own click handler (toggleLogPanel); don't
      // open the log panel when the user clicks the username.
      e.stopPropagation();
      if (confirm('Sign out of myco?')) doLogout();
    });
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
  const wrap = document.getElementById('spawn-suggestions');
  wrap.innerHTML = '';
  if (!state.workspace?.entries?.length) return;
  for (const name of state.workspace.entries) {
    const chip = document.createElement('button');
    chip.className = 'dir-chip';
    chip.textContent = name;
    chip.addEventListener('click', () => {
      document.getElementById('spawn-cwd').value = name;
    });
    wrap.appendChild(chip);
  }
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
    const dirName = (s.cwd || '').split('/').filter(Boolean).pop() || s.cwd || '~';
    const idShort = s.id.replace(/^myco-/, '').slice(0, 8);
    const summary = s.summary
      ? `<span class="session-summary">${escHtml(s.summary)}</span>`
      : (s.description ? `<span class="session-desc">${escHtml(s.description)}</span>` : '');
    const statusDot = s.status ? `<span class="session-status session-status-${s.status}" aria-label="Status: ${s.status}"></span>` : '';
    const ownerLabel = s.owner || (s.shared ? 'shared' : null);
    const sharedBadge = readOnly && ownerLabel
      ? `<span class="shared-badge" title="${s.shared ? 'Shared by' : 'Owned by'} ${escHtml(ownerLabel)} — read-only">${escHtml(ownerLabel)}</span>`
      : '';
    li.innerHTML = `
      ${statusDot}
      <span class="session-title">${escHtml(dirName)}${sharedBadge}</span>
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
      document.getElementById('terminal-wrap').hidden = true;
      document.getElementById('no-session').hidden = false;
    }
    document.querySelectorAll('.session-item.show-delete')
      .forEach(el => el.classList.remove('show-delete'));
    await refreshSessions();
  } catch (err) {
    alert(`Could not delete session: ${err.message || err}`);
  }
}

// ── terminal attach ───────────────────────────────────────────────────────────

// Drop the previous session's WS, xterm, transcript, file pane, and the
// terminal/conversation wraps. Leaves clearReadOnly to dispose the
// read-only banner + tail xterm so we don't double-dispose them here.
function _teardownPreviousSession() {
  _cancelReadonlyFallback();
  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.term) { state.term.dispose(); state.term = null; }
  state.viewerMode = false;
  state.transcriptMessages = [];
  document.getElementById('terminal').innerHTML = '';
  document.getElementById('terminal-wrap').hidden = true;
  document.getElementById('conversation-wrap').hidden = true;
  // Wipe only the transcript content; leave the sibling #terminal-tail
  // (and its embedded mini xterm) for clearReadOnly to dispose properly.
  const conv = document.getElementById('conv-content');
  if (conv) conv.innerHTML = '';
  clearReadOnly();                               // resets banner + tail term
  // Reset file pane on session switch — paths and mtimes are session-scoped.
  hideFilesView();
  state.files.currentPath = '.';
  state.files.history = [];
  state.files.viewing = null;
}

// Reset state + chrome for the new session id (preview toggle, artifact
// views, sidebar list, chat panes, etc.). Does not start any network I/O.
function _resetUiForNewSession(id) {
  state.activeId = id;
  state.viewerMode = false;
  state.transcriptMessages = [];
  state.previewAsViewer = false;             // reset preview toggle on session switch
  state.pendingMenu = null;                  // clear any inline menu callout
  document.getElementById('btn-preview-readonly')?.classList.remove('active');
  // Hide all Plan/Arch/Test main-pane views so the previous session's
  // extracted content doesn't linger. Chrome-button active classes are
  // also cleared in clearArtifactBodies.
  state.artifactView = { active: null, prev: 'terminal' };
  for (const t of ARTIFACT_TYPES) {
    const wrap = document.getElementById(t + '-wrap');
    if (wrap) wrap.hidden = true;
    document.getElementById('btn-' + t)?.classList.remove('active');
  }
  try { localStorage.setItem('myco_active_id', id); } catch {}
  renderSessionList();
  clearChat();
  clearArtifactBodies();
  updateChatButton();
  if (window.innerWidth <= 900) setSidebar(true);
}

// Owner-only: build the live xterm in #terminal, load addons, hook up
// touch-scroll + ResizeObserver + virtual keyboard. Viewer sessions skip
// this and render the structured-transcript pane instead.
function _initOwnerXterm() {
  document.getElementById('terminal-wrap').hidden = false;

  state.term = new Terminal({
    scrollback: IS_TOUCH_DEVICE ? 1500 : 5000,
    fontSize: 13,
    fontFamily: "'JetBrains Mono Nerd Font', 'JetBrains Mono', Menlo, monospace",
    cursorBlink: false,
    smoothScrollDuration: 0,
  });
  state.fitAddon = new FitAddon.FitAddon();
  state.term.loadAddon(state.fitAddon);
  const el = document.getElementById('terminal');
  el.innerHTML = '';
  state.term.open(el);
  state.fitAddon.fit();

  // See createTerm — Canvas on mobile, WebGL on desktop.
  if (IS_TOUCH_DEVICE) {
    try { state.term.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
  } else {
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
      state.term.loadAddon(webgl);
    } catch {
      try { state.term.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
    }
  }

  // Custom touch handler on both mobile and desktop. Native viewport scroll
  // doesn't work on mobile because .xterm-screen sits on top of
  // .xterm-viewport in the DOM and absorbs touch events; the JS handler is
  // the only thing that reliably reaches term.scrollLines.
  setupTouchScroll(state.term);
  refreshXtermAfterFontLoad(state.term);

  state.xtermTextarea = el.querySelector('.xterm-helper-textarea');
  if (state.xtermTextarea) state.xtermTextarea.setAttribute('inputmode', 'none');

  const ro = new ResizeObserver(() => {
    state.fitAddon.fit();
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ t: 'resize', cols: state.term.cols, rows: state.term.rows }));
    }
  });
  ro.observe(el);

  if (!state.keyboard) {
    state.keyboard = new Keyboard(document.getElementById('keyboard-bar'), sendInput);
  }

  showConnOverlay('Connecting', null, 'Establishing session…');
  // updateChatButton was called earlier when both panes were still hidden,
  // so the toggle was hidden too. Now that terminal-wrap is visible, the
  // toggle should reappear (mobile only — desktop keeps the chat pane open).
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
    if (window.innerWidth <= 900) setSidebar(true);
    return;
  }

  _teardownPreviousSession();
  _resetUiForNewSession(id);

  // Owner sessions get an xterm immediately. Viewer sessions wait for the
  // server's viewer-mode message and then show the conversation pane
  // (structured transcript + live terminal-tail).
  const session = state.sessions.find((s) => s.id === id);
  const isShared = !!(session && !session.owned);

  document.getElementById('no-session').hidden = true;

  if (isShared) {
    showConversationView();
    const conv = document.getElementById('conv-content');
    if (conv) conv.innerHTML = '<div class="conv-waiting">Connecting…</div>';
  } else {
    _initOwnerXterm();
    // Newly-spawned sessions: prefer the structured-transcript pane over
    // an empty xterm while Claude is initialising. The xterm is built
    // anyway (so the readonly-preview toggle has somewhere to flip back
    // to once Claude is ready), but it's hidden behind the conv pane.
    // The old `startInReadonly` auto-switch to the conv pane was removed
    // — interaction now happens in the chat pane (typing-dots indicator
    // + debounced assistant-reply posting). The xterm stays mounted so
    // the 👁 toggle has somewhere to flip back to.
  }

  // websocket with auto-reconnect. `connect` is closure-bound to `id` and
  // `qs` so reconnect-after-close stays on this session; the `state.ws !==
  // ws` guard inside the message handler also prevents stale-WS messages
  // from leaking into a freshly-switched session.
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = _buildAttachQuery(isShared);
  let reconnectDelay = 1000;
  const maxDelay = 15000;

  function connect() {
    const ws = new WebSocket(`${proto}://${location.host}/attach/${encodeURIComponent(id)}${qs}`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      hideConnOverlay();
      _flushOutboundChat();                      // any sends queued during reconnect
      if (state.term) {
        ws.send(JSON.stringify({ t: 'resize', cols: state.term.cols, rows: state.term.rows }));
      }
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
        if (state.term) { state.term.dispose(); state.term = null; }
        // Force the conversation pane visible — defensive in case the
        // server never follows up with transcript-init/transcript-waiting
        // (e.g. transcript file unreadable). Without this, ryan attaching
        // to a non-owned session sees an empty <main>.
        showConversationView();
        applyReadOnly(msg.owner);
      } else if (msg.t === 'transcript-init') {
        state.transcriptMessages = msg.messages || [];
        if (state.transcriptMessages.length) _cancelReadonlyFallback();
        renderTranscriptMessages(state.transcriptMessages);
      } else if (msg.t === 'transcript-delta') {
        const newMsgs = msg.messages || [];
        if (newMsgs.length) _cancelReadonlyFallback();
        state.transcriptMessages.push(...newMsgs);
        appendTranscriptMessages(newMsgs);
        _onTranscriptDeltaForChat(newMsgs);
        if (newMsgs.some((m) => m && m.role === 'assistant')) {
          // Claude is now producing transcript output → any earlier
          // pending menu (trust-folder etc.) has been resolved.
          if (state.pendingMenu) {
            state.pendingMenu = null;
            _renderPendingMenuCallout();
          }
        }
      } else if (msg.t === 'transcript-waiting') {
        showTranscriptWaiting();
      } else if (msg.t === 'output') {
        state.term?.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
        // Pin to the latest output. xterm's default behavior only
        // auto-scrolls when the viewport was already at the bottom;
        // per the always-tail contract for chat/conv/xterm, force the
        // scroll on every output frame. Users who want to inspect
        // history can pause output by sending Ctrl+S to the shell.
        try { state.term?.scrollToBottom(); } catch {}
      } else if (msg.t === 'pong') {
        state.lastPongAt = Date.now();
      } else if (msg.t === 'chat-history') {
        applyChatHistory(msg.messages);
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
        // round-trip required.
        state.artifacts = msg.artifacts || {};
        _onArtifactsCacheUpdated();
      } else if (msg.t === 'exit') {
        state.term?.writeln('\r\n[session ended]');
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
      showConnOverlay('Reconnecting', null, 'Restoring session…');
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
    scrollChatToLatest();
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
  const hasContent = MAIN_PANE_IDS.some((id) => !document.getElementById(id)?.hidden);
  // Chat button stays visible whenever there's a live session — same
  // pattern the other chrome toggles use. Open/closed state is shown
  // via the .active class (CSS swaps the background tint) so the icon
  // doesn't morph mid-click. The earlier behaviour hid btn-chat while
  // the chatpane was open, which read as "the 💬 icon became ×"
  // because the chatpane's own close button sits in roughly the same
  // viewport corner.
  btn.hidden = !state.activeId || !hasContent;
  btn.classList.toggle('active', !!state.chatPaneVisible);
  // The files toggle is bound to the same active-session condition; its
  // visibility doesn't depend on the chatpane.
  const fbtn = document.getElementById('btn-files');
  if (fbtn) fbtn.hidden = !state.activeId || !hasContent;
  // Preview-as-viewer toggle: only show for the actual session owner, since
  // a shared viewer is already in viewer mode and a "preview" is meaningless
  // for them.
  const pbtn = document.getElementById('btn-preview-readonly');
  if (pbtn) {
    const session = state.activeId && state.sessions
      ? state.sessions.find((s) => s.id === state.activeId) : null;
    const isOwner = !!(session && session.owned);
    pbtn.hidden = !state.activeId || !isOwner || !hasContent;
  }
  // Plan / Arch / Test toggles: available to everyone with an active session
  // (owners + viewers can both inspect/refresh extracted artifacts).
  for (const t of ['plan', 'arch', 'test']) {
    const el = document.getElementById('btn-' + t);
    if (el) el.hidden = !state.activeId || !hasContent;
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
function setupTouchScroll(term) {
  const root = term.element;
  if (!root) return;

  const SCROLL_COMMIT_PX = 6;
  const VERTICAL_RATIO = 1.4;
  // Discrete-tick scrolling — used on touch only. Emit one wheel tick per
  // PX_PER_TICK pixels of finger travel, sized to one xterm wheel tick.
  // This avoids the line-quantization jitter that fractional smoothing
  // produced on small/slow scrolls (Claude's TUI scrolls in whole lines,
  // so fractional wheel deltaY rounds inconsistently and visibly chops).
  // Larger PX_PER_TICK = less sensitive; DELTA_PER_TICK matches xterm's
  // built-in expectation of ~100px/tick.
  const PX_PER_TICK = 28;
  const DELTA_PER_TICK = 50;

  let touchActive = false;
  let scrolling = false;
  let moved = false;
  let dismissedKbd = false;
  let startX = 0, startY = 0, lastY = 0, lastTime = 0;
  let pixelDebt = 0, pendingDy = 0;
  let scrollRaf = null, momentumRaf = null;
  let cachedCellHeight = 17;

  const SAMPLE_WINDOW_MS = 120;
  const samples = [];
  const pruneSamples = (now) => {
    const cutoff = now - SAMPLE_WINDOW_MS;
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
  };
  const flingVelocity = () => {
    if (samples.length < 2) return 0;
    const first = samples[0], last = samples[samples.length - 1];
    const dt = last.t - first.t;
    if (dt < 8) return 0;
    return (first.y - last.y) / dt;
  };

  const dismissSoftKeyboard = () => {
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('kbd-native-input')) ae.blur();
  };
  const recomputeCellHeight = () => {
    const rows = term.rows || 0;
    cachedCellHeight = rows > 0 ? root.clientHeight / rows : 17;
  };

  // Discrete-tick scroll: emit a whole number of xterm wheel ticks per
  // PX_PER_TICK of accumulated finger movement, holding the sub-tick
  // residual until enough has built up. Eliminates the line-quantization
  // jitter that fractional wheel events produced on small/slow scrolls.
  const flushScroll = () => {
    scrollRaf = null;
    if (pendingDy === 0) return;
    const ticks = (pendingDy > 0 ? Math.floor : Math.ceil)(pendingDy / PX_PER_TICK);
    if (ticks === 0) return;            // not enough finger travel for a tick
    pendingDy -= ticks * PX_PER_TICK;
    const dy = ticks * DELTA_PER_TICK;
    try {
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true,
      });
      root.dispatchEvent(wheelEvent);
    } catch {
      // WheelEvent constructor unavailable — scroll xterm's buffer directly.
      pixelDebt += dy;
      const ch = cachedCellHeight;
      if (ch > 0) {
        const lines = (pixelDebt > 0 ? Math.floor : Math.ceil)(pixelDebt / ch);
        if (lines !== 0) { term.scrollLines(lines); pixelDebt -= lines * ch; }
      }
    }
  };
  const queueScroll = (dy) => {
    pendingDy += dy;
    if (scrollRaf == null) scrollRaf = requestAnimationFrame(flushScroll);
  };
  const cancelMomentum = () => {
    if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
    if (scrollRaf)   { cancelAnimationFrame(scrollRaf);   scrollRaf = null;   }
  };

  let ro = null;
  try { ro = new ResizeObserver(recomputeCellHeight); ro.observe(root); } catch {}

  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    cancelMomentum();
    recomputeCellHeight();
    touchActive = true; scrolling = false; moved = false; dismissedKbd = false;
    pixelDebt = 0; pendingDy = 0; samples.length = 0;
    const now = performance.now();
    const t0 = e.touches[0];
    startX = t0.clientX;
    startY = lastY = t0.clientY;
    lastTime = now;
    samples.push({ t: now, y: startY });
  }, { passive: true });

  root.addEventListener('touchmove', (e) => {
    if (!touchActive || e.touches.length !== 1) return;
    const t0 = e.touches[0];
    const y = t0.clientY, x = t0.clientX;
    const now = performance.now();
    const dy = lastY - y;
    const totalDy = startY - y, totalDx = startX - x;

    if (!scrolling) {
      const absDy = Math.abs(totalDy), absDx = Math.abs(totalDx);
      if (absDy < SCROLL_COMMIT_PX && absDx < SCROLL_COMMIT_PX) {
        samples.push({ t: now, y }); pruneSamples(now);
        lastY = y; lastTime = now; return;
      }
      if (absDy < absDx * VERTICAL_RATIO) { touchActive = false; return; }
      scrolling = true;
      if (!dismissedKbd) { dismissedKbd = true; dismissSoftKeyboard(); }
    }

    if (Math.abs(dy) > 0) moved = true;
    samples.push({ t: now, y }); pruneSamples(now);
    queueScroll(dy);
    lastY = y; lastTime = now;
  }, { passive: true });

  root.addEventListener('touchend', () => {
    if (!touchActive) return;
    touchActive = false;
    if (!scrolling) return;
    scrolling = false;
    flushScroll();
    if (!moved) return;
    let v = flingVelocity();
    if (Math.abs(v) < 0.10) return;
    if (v > 6)  v = 6;
    if (v < -6) v = -6;
    let prev = performance.now();
    const tick = () => {
      if (!root.isConnected) { momentumRaf = null; return; }
      const now = performance.now();
      const dt = now - prev; prev = now;
      pendingDy += v * dt;
      flushScroll();
      v *= Math.pow(0.96, dt / 16);
      if (Math.abs(v) > 0.04) momentumRaf = requestAnimationFrame(tick);
      else momentumRaf = null;
    };
    momentumRaf = requestAnimationFrame(tick);
  });

  root.addEventListener('touchcancel', () => {
    touchActive = false; scrolling = false; cancelMomentum();
  }, { passive: true });
}

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
  try {
    const res = await authedFetch('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, cols, rows }),
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

function applyChatHistory(messages) {
  state.chatMessages = Array.isArray(messages) ? messages.slice() : [];
  // Always land on the latest message — applyChatHistory fires on initial
  // connect and on every reconnect, and the user expects to see the most
  // recent activity, not the start of the thread.
  renderChatPane(/*scrollToBottom*/ true);
  _rescanPendingMenu();
  _renderPendingMenuCallout();
}

function appendChatMessage(message) {
  if (!message || typeof message !== 'object') return;
  // Dedup by transcript uuid — Claude's assistant text reaches the
  // client through two paths now: the live transcript-delta (which
  // posts a _localOnly row via _postClaudeStreamToChat) AND a 'chat'
  // frame from persistAssistantTextToChat on the server. If
  // transcript-delta arrived first the local row is already in chat;
  // skip the server-side push to avoid rendering the same reply twice.
  // (If chat arrives first the existing _onTranscriptDeltaForChat dedup
  // handles the reverse direction.)
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
          if (list && list.children[i]) {
            const newEl = _htmlToNode(renderChatMessage(message, /*isActiveMenu*/ false));
            if (newEl) list.children[i].replaceWith(newEl);
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
      if (list && list.children[lastIdx]) {
        const newEl = _htmlToNode(renderChatMessage(last, /*isActiveMenu*/ true));
        if (newEl) list.children[lastIdx].replaceWith(newEl);
      }
      _updatePendingMenuFromMessage(last);
      _renderPendingMenuCallout();
      return;
    }
  }
  state.chatMessages.push(message);
  _appendChatMessageDom(message);
  _updatePendingMenuFromMessage(message);
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
  _renderChatUnreadBadge();
}

function _renderChatUnreadBadge() {
  const btn = document.getElementById('btn-chat');
  if (!btn) return;
  const n = state.chatUnread || 0;
  if (n > 0) {
    btn.dataset.unread = String(Math.min(n, 99));
  } else {
    delete btn.dataset.unread;
  }
}

function _resetChatUnread() {
  state.chatUnread = 0;
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
  list.appendChild(node);
  scrollChatToLatest();
  _bindChatMenuClicks();
  // Mermaid runs only on the newly-appended node — existing SVGs (and
  // any user interaction state inside them) stay intact.
  renderMermaidInContainer(node).catch(() => {});
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
    const oldEl = children[i];
    if (!oldEl || !oldEl.querySelector('.chat-menu-opts')) continue;
    const newEl = _htmlToNode(renderChatMessage(m, /*isActiveMenu*/ false));
    if (newEl) oldEl.replaceWith(newEl);
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
}

// Readonly-view safety net for new sessions. If 8 seconds pass without
// a menu callout or any transcript content, flip back to the live xterm
// so the user can see whatever Claude is showing (banner + interactive
// prompt) and respond directly. Cancelled by any signal that the
// readonly view actually has something useful: pending menu, transcript
// content, or a manual flip via btn-preview-readonly.
const READONLY_FALLBACK_MS = 8000;

function _armReadonlyFallback(id) {
  _cancelReadonlyFallback();
  state._readonlyFallbackTimer = setTimeout(() => {
    state._readonlyFallbackTimer = null;
    // Bail if the user already navigated away, manually flipped out of
    // readonly, or the readonly view has filled in with real content.
    if (state.activeId !== id) return;
    if (!state.previewAsViewer) return;
    if (state.pendingMenu) return;
    if (Array.isArray(state.transcriptMessages) && state.transcriptMessages.length) return;
    console.log('[myco] readonly fallback: no menu/transcript after', READONLY_FALLBACK_MS, 'ms — flipping to xterm');
    // Same effect as clicking btn-preview-readonly to turn it off.
    state.previewAsViewer = false;
    document.getElementById('btn-preview-readonly')?.classList.remove('active');
    clearReadOnly();
    showTerminalView();
    updateChatButton();
  }, READONLY_FALLBACK_MS);
}

function _cancelReadonlyFallback() {
  if (state._readonlyFallbackTimer) {
    clearTimeout(state._readonlyFallbackTimer);
    state._readonlyFallbackTimer = null;
  }
}

// No-op. The menu picker now renders inline inside each menu chat
// message (see renderChatMessage). We still keep the existing call
// sites (after applyChatHistory / appendChatMessage / transcript
// renders / waiting swaps) so the watchdog-cancel side effect runs
// on every menu event.
function _renderPendingMenuCallout() {
  if (state.pendingMenu) _cancelReadonlyFallback();
}

// Click delegation: any chat-message option button anywhere in the
// chat list. Sends the pick through the dedicated menu-pick frame
// (no chat pollution) and visually marks the message as resolved so
// the user can see which option they took, plus prevents double-fire.
function _bindChatMenuClicks() {
  const list = document.getElementById('chat-messages');
  if (!list || list.dataset.menuBound === '1') return;
  list.dataset.menuBound = '1';
  list.addEventListener('click', (e) => {
    // Multi-select Submit button — sends just Enter, finalising the dialog.
    const submitBtn = e.target.closest('.chat-menu-submit');
    if (submitBtn && !submitBtn.disabled) {
      const hash = submitBtn.dataset.hash || '';
      if (!sendMenuSubmit(hash)) return;
      _resolveMenuRow(submitBtn, { submitted: true });
      _markAwaitingClaude();
      return;
    }
    const btn = e.target.closest('.chat-menu-opt');
    if (!btn || btn.disabled) return;
    const n = Number(btn.dataset.n);
    if (!Number.isFinite(n) || n < 1) return;
    const hash = btn.dataset.hash || '';
    const isToggle = btn.classList.contains('chat-menu-toggle');
    if (isToggle) {
      // Multi-select toggle — flip checkbox state, send digit-only frame.
      if (!sendMenuToggle(n, hash)) return;
      _toggleCheckboxOnRow(btn, n);
      return;   // do NOT mark answered or yank pendingMenu — user is still composing
    }
    // Plain pick (single-select OR non-checkbox option in a multi-select
    // dialog like "Done" — both behave as digit+CR final pick).
    if (!sendMenuPick(n, hash)) return;
    state.pendingMenu = null;
    _resolveMenuRow(btn, { pickedN: n });
    _markAwaitingClaude();
  });
}

// Stamp the chat row + the chat-messages DOM as resolved. opts.pickedN
// for single-select / Done in multi-select. opts.submitted=true for
// multi-select Submit. Without this, the next renderChatPane / inline
// re-render would reconstruct the picker (claude's streaming reply
// triggers many of those) and the disabled state would vanish.
function _resolveMenuRow(btn, opts) {
  const msgEl = btn.closest('.chat-msg');
  if (msgEl && msgEl.parentNode) {
    const idx = Array.prototype.indexOf.call(msgEl.parentNode.children, msgEl);
    if (idx >= 0 && state.chatMessages[idx]) {
      state.chatMessages[idx]._answered = true;
      if (opts.pickedN != null) state.chatMessages[idx]._pickedN = opts.pickedN;
      if (opts.submitted) state.chatMessages[idx]._submitted = true;
    }
  }
  // Disable every option in this row immediately — don't wait for the
  // next renderChatPane.
  const grp = btn.closest('.chat-menu-opts');
  if (grp) {
    grp.querySelectorAll('.chat-menu-opt, .chat-menu-submit').forEach((b) => {
      b.disabled = true;
      if (b === btn) b.classList.add('chat-menu-picked');
    });
  }
}

// Optimistic checkbox flip on a multi-select toggle click. The server
// also persists the new state on the chat row (see _toggleMenuChatCheckbox
// in pty.js), but this gives instant feedback without waiting for the
// 'chat' frame round-trip.
function _toggleCheckboxOnRow(btn, n) {
  const msgEl = btn.closest('.chat-msg');
  if (msgEl && msgEl.parentNode) {
    const idx = Array.prototype.indexOf.call(msgEl.parentNode.children, msgEl);
    const m = state.chatMessages[idx];
    if (m && m.meta && m.meta.menu && Array.isArray(m.meta.menu.options)) {
      const opt = m.meta.menu.options.find((o) => o.n === n);
      if (opt && opt.checkbox) opt.checked = !opt.checked;
    }
  }
  const checked = btn.classList.toggle('is-checked');
  btn.setAttribute('aria-pressed', checked ? 'true' : 'false');
  const glyph = btn.querySelector('.chat-menu-glyph');
  if (glyph) glyph.textContent = checked ? '☑' : '☐';
}

function clearChat() {
  state.chatMessages = [];
  renderChatPane();
}

// Scroll the chat list to the bottom, deferred to the next frame so layout
// has settled. Without rAF, scrollTop=scrollHeight is a no-op when the
// chat pane is still display:none / 0-height (initial mobile load, or
// while a session-switch is in progress).
function scrollChatToLatest() {
  const list = document.getElementById('chat-messages');
  if (!list) return;
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function renderChatPane(scrollToBottom = false) {
  const list = document.getElementById('chat-messages');
  const empty = document.getElementById('chat-empty');
  if (!list) return;
  if (!state.chatMessages.length) {
    list.innerHTML = '';
    if (empty) empty.hidden = false;
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
  if (scrollToBottom) scrollChatToLatest();
  _bindChatMenuClicks();
  // marked emits ```mermaid``` blocks as <pre><code class="language-mermaid">.
  // Without this pass they render as raw source. Same async, fire-and-forget
  // pattern the transcript view uses; failures stay as raw code blocks.
  renderMermaidInContainer(list).catch(() => {});
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

function renderChatMessage(m, isActiveMenu) {
  const fromClaude = m.user === 'claude';
  const fromSelf = state.chatUser && m.user === state.chatUser;
  const ts = m.ts ? formatChatTs(m.ts) : '';
  let cls = 'chat-msg';
  if (fromClaude) cls += ' from-claude';
  if (fromSelf) cls += ' from-self';
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
    cls += ' chat-msg-menu';   // unifies the bubble + the option rows into one card (see styles.css)
    const tgt = m.meta.target;
    const lead = tgt
      ? `🤔 Claude wants permission to run \`${tgt.tool}(${tgt.input || ''})\``
      : '🤔 Claude is waiting on a decision';
    const q = m.meta.menu && m.meta.menu.question ? '\n\n> ' + m.meta.menu.question : '';
    body = lead + q;
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
  let optsHtml = '';
  if (menuOpts && wasSubmitted) {
    // Multi-select submitted: summarize the checked set.
    const picked = menuOpts.filter((o) => o.checkbox && o.checked);
    const summary = picked.length
      ? picked.map((o) => `[${o.n}] ${escHtml(o.label)}`).join(', ')
      : '(nothing selected)';
    optsHtml = `<div class="chat-menu-resolved">✓ Submitted with ${summary}</div>`;
  } else if (menuOpts && pickedN != null) {
    const matched = menuOpts.find((o) => o.n === pickedN);
    const label = matched ? matched.label : '';
    optsHtml = `<div class="chat-menu-resolved">✓ Picked [${pickedN}]${label ? ' ' + escHtml(label) : ''}</div>`;
  } else if (menuOpts && isSuperseded) {
    // Claude advanced the dialog before this menu was answered. Show a
    // muted note instead of leaving stale buttons live (which would
    // silently no-op against the hash-guard on the server side).
    optsHtml = '<div class="chat-menu-resolved">↪ Superseded by a newer dialog</div>';
  } else if (menuOpts && isActiveMenu) {
    // data-hash stamps the click with the specific menu's identity so
    // the server can validate that the user's pick still corresponds
    // to the menu currently displayed in Claude's TUI — if another
    // menu has since taken its place (parallel tool calls, rapid
    // dialog turnover), the pick is dropped instead of silently
    // answering the wrong question.
    const menuHash = (m.meta.menu && m.meta.menu.hash) || '';
    if (isMulti) {
      // Multi-select: each checkbox option is a toggle (click sends
      // menu-toggle frame); non-checkbox options are plain picks (final
      // "Done"/"Submit" rendered by claude inside the dialog options).
      // Plus an explicit Submit button at the end for dialogs that don't
      // include their own "Done" option.
      const buttons = menuOpts.map((o) => {
        if (o.checkbox) {
          const checked = !!o.checked;
          const glyph = checked ? '☑' : '☐';
          return `<button type="button" class="chat-menu-opt chat-menu-toggle${checked ? ' is-checked' : ''}" data-n="${o.n}" data-hash="${escHtml(menuHash)}" aria-pressed="${checked ? 'true' : 'false'}"><span class="chat-menu-glyph">${glyph}</span> [${o.n}] ${escHtml(o.label)}</button>`;
        }
        return `<button type="button" class="chat-menu-opt" data-n="${o.n}" data-hash="${escHtml(menuHash)}">[${o.n}] ${escHtml(o.label)}</button>`;
      }).join('');
      optsHtml = `<div class="chat-menu-opts chat-menu-opts-multi">${buttons}<button type="button" class="chat-menu-submit" data-hash="${escHtml(menuHash)}">↵ Submit</button><div class="chat-menu-hint">Click to toggle; Submit when done.</div></div>`;
    } else {
      optsHtml = `<div class="chat-menu-opts">${menuOpts.map((o) =>
        `<button type="button" class="chat-menu-opt" data-n="${o.n}" data-hash="${escHtml(menuHash)}">[${o.n}] ${escHtml(o.label)}</button>`
      ).join('')}<div class="chat-menu-hint">Pick here — goes straight to the session, no chat post.</div></div>`;
    }
  } else if (menuOpts) {
    // Menu broadcast that's no longer the latest AND has no recorded
    // pick (e.g. older menu in history that got superseded). Show
    // nothing extra — the lead + question above is enough.
    optsHtml = '<div class="chat-menu-resolved">(no longer active)</div>';
  } else if (m.meta && m.meta.kind === 'menu') {
    // Defensive: a "menu" message landed without an options array.
    // Shouldn't happen with the current server (broadcastMenuToChat
    // always populates meta.menu.options), but if a stale broadcast
    // or a bundle/data mismatch hides the buttons, surface that fact
    // instead of silently rendering only the lead + question.
    optsHtml = '<div class="chat-menu-resolved">(buttons unavailable — try a hard-refresh of this page)</div>';
  }
  // Collapsed menu card: skip the lead+question body, surface the
  // question on hover instead. Keeps history scrollable without losing
  // recoverability.
  const tooltip = isResolvedMenu && m.meta && m.meta.menu && m.meta.menu.question
    ? ` title="${escHtml(m.meta.menu.question)}"` : '';
  const textHtml = isResolvedMenu
    ? ''
    : `<div class="chat-text">${renderMd(body)}</div>`;
  return `<div class="${cls}"${tooltip}>
    <div class="chat-meta"><span class="chat-user">${escHtml(m.user || '?')}</span><span class="chat-ts">${escHtml(ts)}</span></div>
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

// Chat-only flow for @myco messages.
//
// When the user @myco's, all of claude's response stream lands in chat:
//   * Each assistant TEXT block arrives via transcript-delta and is
//     immediately appended as a separate `claude` chat message — so
//     pre-tool planning, post-tool summaries, and the final answer
//     each get their own bubble (close to ChatGPT-style streaming).
//   * tool_use entries don't post to chat — they're invisible work.
//     We keep a counter so a tool-only turn (claude ran tools and
//     didn't produce text) can be summarised at the end.
//   * The typing-dots indicator stays visible from the @myco send
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

// Called from the transcript-delta WS frame handler whenever new
// transcript messages arrive. Streams every assistant text into chat
// as it lands. Critically, this does NOT gate on state.awaitingClaude —
// claude can think silently for 30–60s before producing any output, and
// that quiet period used to retire the typing dots AND make this
// handler return early via an `if (!awaitingClaude) return` guard, so
// the eventual "Generated 4 sample files…" reply never reached chat.
// The dots are managed by a separate timer for visual feedback only;
// they don't gate posting.
function _onTranscriptDeltaForChat(messages) {
  let sawSomething = false;
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'assistant') {
      sawSomething = true;
      const tools = Array.isArray(m.toolCalls) ? m.toolCalls.length : 0;
      state.pendingClaudeToolCalls = (state.pendingClaudeToolCalls || 0) + tools;
      if (m.text && m.text.trim()) {
        // Dedupe — transcript-delta can re-emit the same uuid after a
        // reconnect (server replays from startByte) and we don't want
        // to double-post in chat. Two layers of dedup:
        //   1. _claudeSeenText: within-tab repeat (cheap Set).
        //   2. chatMessages scan by meta.transcriptUuid: catches the
        //      case where the server has ALREADY persisted this message
        //      into rec.chat and the client got it via chat-history /
        //      'chat' push, so the live transcript-delta should skip it.
        if (!state._claudeSeenText) state._claudeSeenText = new Set();
        const key = m.uuid || (m.ts + '|' + m.text.slice(0, 40));
        const alreadyInChat = m.uuid && state.chatMessages.some(
          (c) => c && c.meta && c.meta.transcriptUuid === m.uuid,
        );
        if (!state._claudeSeenText.has(key) && !alreadyInChat) {
          state._claudeSeenText.add(key);
          _postClaudeStreamToChat(m.text.trim(), m.uuid);
          state.pendingClaudeReplyPosted = true;
        }
      }
    } else if (m.role === 'tool_result' || m.role === 'user') {
      // tool_result = claude got data back; user = our own @myco echo.
      // Both count as "still alive" for the idle timer.
      sawSomething = true;
    }
  }
  // Reset the typing-dots idle timer only when dots are currently up.
  if (sawSomething && state.awaitingClaude) _scheduleClaudeIdleCheck();
  // Fresh transcript activity means claude is still streaming — if a
  // spinner-stop retirement was queued from a momentary spinner blip,
  // cancel it so we don't yank the dots mid-turn.
  if (sawSomething && state._spinnerStopTimer) {
    clearTimeout(state._spinnerStopTimer);
    state._spinnerStopTimer = null;
  }
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
// spinner-stop signal. Posts the "ran N tool calls without reply"
// summary if applicable, then clears awaiting state and re-renders.
function _retireClaudeTyping() {
  if (state._claudeIdleTimer) { clearTimeout(state._claudeIdleTimer); state._claudeIdleTimer = null; }
  if (state._spinnerStopTimer) { clearTimeout(state._spinnerStopTimer); state._spinnerStopTimer = null; }
  state._spinnerSeen = false;
  if (!state.awaitingClaude) { _renderClaudeTyping(); return; }
  if (!state.pendingClaudeReplyPosted && state.pendingClaudeToolCalls > 0) {
    const n = state.pendingClaudeToolCalls;
    _postClaudeStreamToChat(`_(Claude ran ${n} tool call${n === 1 ? '' : 's'} and didn't post a text reply.)_`);
  }
  state.awaitingClaude = false;
  state.pendingClaudeToolCalls = 0;
  state.pendingClaudeReplyPosted = false;
  state._claudeSeenText = null;
  _renderClaudeTyping();
}

function _postClaudeStreamToChat(text, uuid) {
  // Local-only chat row for INSTANT live feedback. The server now
  // mirrors assistant text into rec.chat via persistAssistantTextToChat
  // (with meta.transcriptUuid), so on reconnect the chat-history path
  // brings the same message back as a properly persisted row. Stamping
  // the uuid here means the chat-history-driven dedup in
  // _onTranscriptDeltaForChat can recognize "this is the same message"
  // and won't double-render.
  const row = {
    user: 'claude',
    text: text,
    ts: new Date().toISOString(),
    _localOnly: true,
  };
  if (uuid) row.meta = { transcriptUuid: uuid };
  state.chatMessages.push(row);
  _appendChatMessageDom(row);
  // Re-render the typing indicator so it slots back below the newest
  // message (the indicator is a sibling of the list; the new message
  // bumps it visually).
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
  const status = state.claudeStatusLine || '';
  const visible = state.awaitingClaude || !!status;
  host.hidden = !visible;
  const label = host.querySelector('.claude-typing-label');
  if (label) _renderClaudeTypingLabel(label, status, state.claudeStatus);
  // No scrollIntoView on updates — status ticks every ~750ms via the
  // periodic safety scan, and the indicator's slot is decoupled from
  // chat-messages's flex slot by construction.
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

// Live PTY mode transition handler. Appends a transcript-shaped pill
// frame ({role:'plan_mode'|'auto_mode', state, ts}) so renderConvMessage
// emits the same pill it would for a JSONL-replayed event. Dedup window
// is 5 seconds — the JSONL flush eventually delivers an equivalent
// record (often with a slightly different timestamp), so without this
// guard the viewer would see "Entered plan mode" twice.
function _onLiveModeChange(msg) {
  if (!msg || !msg.to) return;
  // 'default' is the absence of a mode — render as "Exited <prior>"
  // pill so the viewer sees a single transition narrative rather than
  // a contentless "Entered default" line.
  const toMode = msg.to === 'default' ? msg.from : msg.to;
  if (!toMode || toMode === 'default') return;
  const role = (toMode === 'plan') ? 'plan_mode'
    : (toMode === 'accept' || toMode === 'auto') ? 'auto_mode'
    : null;
  if (!role) return;
  const state_ = msg.to === 'default' ? 'exited' : 'entered';
  const frame = { role, state: state_, ts: msg.ts, _live: true };
  if (_isDuplicateModeFrame(frame)) return;
  if (!Array.isArray(state.transcriptMessages)) state.transcriptMessages = [];
  state.transcriptMessages.push(frame);
  appendTranscriptMessages([frame]);
}

// Apply a mode-snapshot received on attach. Pre-fix, mode pills only
// rendered on the next Shift+Tab because mode-change emits only on
// transition. The snapshot lets a viewer reconnecting mid-session see
// the current mode without waiting for the next change. Idempotent:
// if the snapshot mode matches the most-recent rendered pill, no-op.
function _applyModeSnapshot(mode) {
  state.currentMode = mode || 'default';
  if (state.currentMode === 'default') return;          // nothing to render
  const role = state.currentMode === 'plan' ? 'plan_mode'
    : state.currentMode === 'accept' ? 'auto_mode'
    : null;
  if (!role) return;                                      // bypass / unknown — no pill
  const frame = { role, state: 'entered', ts: new Date().toISOString(), _live: true };
  if (_isDuplicateModeFrame(frame)) return;
  if (!Array.isArray(state.transcriptMessages)) state.transcriptMessages = [];
  state.transcriptMessages.push(frame);
  appendTranscriptMessages([frame]);
}

// Dispatch a state-update WS frame to the right local applier based on
// its `kind`. The server emits one of three shapes:
//   { kind: 'menu',     messageUuid, hash, meta }
//   { kind: 'artifact', artifactType, artifact }
//   { kind: 'tool-progress', open: [{ id, name, summary, sinceMs }] }
function _applyStateUpdate(msg) {
  if (!msg || !msg.kind) return;
  if (msg.kind === 'menu') {
    _applyMenuStateUpdate(msg);
    return;
  }
  if (msg.kind === 'artifact') {
    if (msg.artifactType && msg.artifact) {
      state.artifacts[msg.artifactType] = msg.artifact;
      _onArtifactsCacheUpdated(msg.artifactType);
    }
    return;
  }
  if (msg.kind === 'tool-progress') {
    state.openToolCalls = Array.isArray(msg.open) ? msg.open : [];
    _renderClaudeTyping();   // strip reuses the existing typing-indicator render path
    return;
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
    const list = document.getElementById('chat-messages');
    if (list && list.children[i]) {
      const newEl = _htmlToNode(renderChatMessage(m, /*isActiveMenu*/ false));
      if (newEl) list.children[i].replaceWith(newEl);
    }
    _bindChatMenuClicks();
    return;
  }
}

// Refresh any open artifact tab when the cache changes. Type-specific
// when called from a state-update; called with no arg from
// artifacts-init to refresh whatever's open.
function _onArtifactsCacheUpdated(type) {
  const active = state.artifactView && state.artifactView.active;
  if (!active) return;
  if (type && type !== active) return;
  // Re-run the existing loadArtifact path; it'll prefer the cache.
  loadArtifact(active).catch(() => {});
}

// True if an existing transcript row already announces this mode
// transition within ±5s — guards against JSONL replay + live PTY
// dual-delivery for the same event.
function _isDuplicateModeFrame(frame) {
  const list = state.transcriptMessages;
  if (!Array.isArray(list) || !list.length) return false;
  const ts = Date.parse(frame.ts || '');
  if (!Number.isFinite(ts)) return false;
  for (let i = list.length - 1; i >= Math.max(0, list.length - 20); i--) {
    const m = list[i];
    if (!m || m.role !== frame.role || m.state !== frame.state) continue;
    const prevTs = Date.parse(m.ts || '');
    if (Number.isFinite(prevTs) && Math.abs(prevTs - ts) < 5000) return true;
  }
  return false;
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
function sendMenuPick(n, hash) {
  if (!Number.isFinite(n) || n < 1) return false;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const frame = { t: 'menu-pick', n };
  if (hash) frame.hash = hash;
  try { ws.send(JSON.stringify(frame)); return true; }
  catch { return false; }
}

// Multi-select toggle — flip one checkbox without submitting. Writes a
// bare digit to claude's PTY (the server adds no CR). The user keeps
// composing the answer; the actual answer goes when they click Submit.
function sendMenuToggle(n, hash) {
  if (!Number.isFinite(n) || n < 1) return false;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const frame = { t: 'menu-toggle', n };
  if (hash) frame.hash = hash;
  try { ws.send(JSON.stringify(frame)); return true; }
  catch { return false; }
}

// Multi-select submit — finalises the dialog with whatever boxes are
// currently checked. Writes just \r to the PTY.
function sendMenuSubmit(hash) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  const frame = { t: 'menu-submit' };
  if (hash) frame.hash = hash;
  try { ws.send(JSON.stringify(frame)); return true; }
  catch { return false; }
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
    try { ws.send(JSON.stringify({ t: 'chat', text: item.text })); }
    catch { state.outboundChat.push(item); break; }
  }
}

function sendChatMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // Queue + return true so the input clears and the user moves on. The
    // message goes out as soon as the WS reconnects (drainOutboundChat is
    // wired to every `open` event in connect()/connectShare()).
    if (!state.outboundChat) state.outboundChat = [];
    state.outboundChat.push({ text: trimmed, ts: Date.now() });
  } else {
    try { ws.send(JSON.stringify({ t: 'chat', text: trimmed })); }
    catch {
      if (!state.outboundChat) state.outboundChat = [];
      state.outboundChat.push({ text: trimmed, ts: Date.now() });
    }
  }
  // @<word> messages go into the running Claude session (server-side
  // rule: any prefix that isn't a known username). `/m <body>` is the
  // short alias that the server rewrites to @myco. Keep the user in
  // the chat pane — that's where the typing-dots indicator and claude's
  // reply will land. The transcript view stays available via the 👁
  // toggle for users who want the raw stream. The client doesn't know
  // the username list at type-time, so we optimistically arm the dots
  // for any @<word> prefix; if the server decides it was actually a
  // user mention and didn't route to PTY, the idle timer (30s) will
  // retire the dots harmlessly.
  if (/^@[A-Za-z][\w-]{0,30}\s+\S/.test(trimmed) || /^\/m\s+\S/i.test(trimmed)
      || /^\/tasks?\s*$/i.test(trimmed)
      || /^\/(skip|cancel)\s+\d+\s*$/i.test(trimmed)) {
    _markAwaitingClaude();
  }
  return true;
}

// Read-only viewer UI: a small banner above the structured transcript
// identifies the session owner. The transcript pane renders the JSONL
// (user/assistant/tool messages); the live terminal-tail pane below it
// surfaces interactive PTY prompts (which never make it into the JSONL).
// Owner-only "preview as viewer" toggle. Flips between the live PTY terminal
// view and the structured-transcript + read-only banner view that shared
// viewers see. Doesn't change actual permissions — the owner's WS still
// allows input + chat + everything else; this is a pure presentation swap
// so the owner can sanity-check what's visible to viewers.
function toggleOwnerReadonlyPreview() {
  // Manual toggle: the user has made a deliberate choice, so the
  // auto-flip-back watchdog should never override it.
  _cancelReadonlyFallback();
  state.previewAsViewer = !state.previewAsViewer;
  const btn = document.getElementById('btn-preview-readonly');
  if (btn) btn.classList.toggle('active', state.previewAsViewer);
  if (state.previewAsViewer) {
    // Re-render the transcript from state in case the conv-content was
    // wiped by a session switch since we last viewed it.
    if (Array.isArray(state.transcriptMessages) && state.transcriptMessages.length) {
      renderTranscriptMessages(state.transcriptMessages);
    } else {
      showConversationView();
      const content = document.getElementById('conv-content');
      if (content && !content.innerHTML.trim()) {
        content.innerHTML = '<div class="conv-waiting">Waiting for transcript… (Claude may not have produced any output yet)</div>';
      }
    }
    applyReadOnly(state.chatUser || 'you');
  } else {
    clearReadOnly();
    showTerminalView();
  }
  updateChatButton();
}

function applyReadOnly(owner) {
  state.readOnly = true;
  state.sessionOwner = owner || null;
  const banner = document.getElementById('readonly-banner');
  if (!banner) return;
  banner.hidden = false;
  const ownerEl = banner.querySelector('.ro-owner');
  if (ownerEl) ownerEl.textContent = owner ? '@' + owner : '';
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
}

function bindReadOnlyBanner() {
  // No-op — the live-terminal panel that hosted the .vk-key buttons was
  // removed. The read-only banner is now display-only; viewers steer the
  // session via @myco messages typed into the chat input.
}

// Floating "waiting for Claude" pill — shown after sending @myco, auto-hides
// on the next transcript-delta (or after a safety timeout). Pure UI; the
// server does not send an explicit ack.
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

function bindChatUi() {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  if (!form || !input) return;
  if (form.dataset.bound) return;
  form.dataset.bound = '1';

  // Auto-grow the textarea with content, up to the CSS max-height (then scroll).
  // We reset to 'auto' first so shrinking works after a backspace/clear.
  function autoResize() {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }
  input.addEventListener('input', autoResize);
  autoResize();

  function submitChat() {
    if (sendChatMessage(input.value)) {
      input.value = '';
      autoResize();
    }
  }

  // Plain Enter inserts a newline (textarea default). Ctrl/⌘+Enter sends.
  // stopImmediatePropagation prevents the autocomplete keydown listener
  // (registered after us in bindChatAutocomplete) from also running and
  // picking an item against an already-cleared input.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      submitChat();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitChat();
  });

  // Chrome icon click contract:
  //   chat / plan / arch / test / files  →  SHOW the corresponding
  //     view. Each button has a single state action ("activate"); a
  //     second click on the same button is a no-op (the view stays
  //     open). To switch away, click a different view's icon — main-
  //     pane buttons are mutually exclusive; chat lives alongside the
  //     main view as a side panel.
  //   preview                              →  TOGGLE between terminal
  //     and readonly transcript. This is the only button with two
  //     states, because the two views are reciprocal (one or the
  //     other is always visible in the main pane).
  document.getElementById('btn-chat')?.addEventListener('click', () => setChatPane(true));
  document.getElementById('btn-preview-readonly')?.addEventListener('click', toggleOwnerReadonlyPreview);
  // The legacy chatpane-close × was removed; #btn-chat itself toggles
  // open/closed via its .active state. Optional-chain still leaves this
  // a no-op for any cached page that still has the old element.
  document.getElementById('chatpane-close')?.addEventListener('click', () => setChatPane(false));
  bindChatpaneResize();
  bindChatAutocomplete();
  bindArtifactToggles();
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

function showArtifactView(type) {
  if (!ARTIFACT_TYPES.includes(type)) return;
  if (!state.activeId) return;
  const wrapId = _wrapIdForArtifact(type);
  const termWrap = document.getElementById('terminal-wrap');
  const convWrap = document.getElementById('conversation-wrap');
  const filesWrap = document.getElementById('files-wrap');
  // Capture whatever the user was looking at, so closing this view restores
  // them to that pane rather than dumping them on the terminal.
  if (!termWrap.hidden) state.artifactView.prev = 'terminal';
  else if (!convWrap.hidden) state.artifactView.prev = 'conversation';
  else if (filesWrap && !filesWrap.hidden) state.artifactView.prev = 'files';
  // (otherwise leave the prior prev alone — we may be flipping between
  // artifact views and want to return to the same upstream pane.)
  _hideMainPaneSiblings(wrapId);
  document.getElementById(wrapId).hidden = false;
  state.artifactView.active = type;
  // Mark the right button active, clear the others.
  for (const t of ARTIFACT_TYPES) {
    document.getElementById('btn-' + t)?.classList.toggle('active', t === type);
  }
  loadArtifact(type).catch(() => {});
  updateChatButton();
}

function hideArtifactView() {
  const type = state.artifactView.active;
  if (!type) return;
  const wrapId = _wrapIdForArtifact(type);
  document.getElementById(wrapId).hidden = true;
  document.getElementById('btn-' + type)?.classList.remove('active');
  state.artifactView.active = null;
  // Restore whichever main-pane view the user was on before opening this.
  const prev = state.artifactView.prev || 'terminal';
  if (prev === 'conversation') showConversationView();
  else if (prev === 'files') showFilesView();
  else showTerminalView();
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
  plan: 'No todos yet. Click <strong>Refresh</strong> to extract them from the latest session activity. Check a todo\'s box to send it back to Claude as <code>@myco</code>.',
  arch: 'No architecture notes yet. Click <strong>Refresh</strong> to extract them from the latest session activity.',
  test: 'No test plans yet. Click <strong>Refresh</strong> to extract them from the latest session activity.',
};

function clearArtifactBodies() {
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
  const cached = state.artifacts && state.artifacts[type];
  const cachedHas = cached && (
    (type === 'arch' && typeof cached.markdown === 'string' && cached.markdown.trim()) ||
    (type !== 'arch' && Array.isArray(cached.items) && cached.items.length)
  );
  if (cachedHas) {
    renderArtifact(type, cached);
    return;
  }
  // Cache miss — fall back to HTTP. Happens on cold reload of an
  // artifact tab before the WS attach delivers artifacts-init.
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
      state.artifacts[type] = artifact;   // populate cache so the next call is instant
    }
  } catch {}
}

async function refreshArtifact(type) {
  if (!ARTIFACT_TYPES.includes(type)) return;
  const sid = state.activeId;
  if (!sid) return;
  const btn = document.querySelector(`.artifact-refresh[data-type="${type}"]`);
  const body = document.getElementById(`artifact-body-${type}`);
  if (!body) return;
  if (btn) btn.disabled = true;
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
  } catch (err) {
    body.innerHTML = `<div class="artifact-empty">Refresh failed: ${escHtml(err.message || String(err))}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderArtifact(type, artifact) {
  const body = document.getElementById(`artifact-body-${type}`);
  if (!body) return;
  if (type === 'arch') {
    const md = artifact && artifact.markdown ? artifact.markdown.trim() : '';
    if (!md) {
      body.innerHTML = '<div class="artifact-empty">Nothing to show yet. The session may not have any architectural decisions in its recent activity.</div>';
      return;
    }
    body.innerHTML = `<div class="artifact-md">${renderMd ? renderMd(md) : escHtml(md)}</div>` +
      (artifact.updatedAt ? `<div class="artifact-updated">Updated ${escHtml(formatChatTs(artifact.updatedAt) || artifact.updatedAt)}</div>` : '');
    return;
  }
  // plan / test → checkbox list. Plan items also get vote button + comment thread.
  const items = (artifact && Array.isArray(artifact.items)) ? artifact.items : [];
  if (!items.length) {
    body.innerHTML = '<div class="artifact-empty">Nothing extracted. The recent session activity may not contain todos.</div>';
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
    const voteBlock = supportsVoting ? `
      <button class="artifact-vote ${userHasVoted ? 'is-voted' : ''}" data-id="${escHtml(it.id)}"
              title="${userHasVoted ? 'Click to remove your vote' : 'Click to vote — items at 2 votes auto-execute'}">
        <span class="vote-icon">👍</span><span class="vote-count">${points}</span>
      </button>
      <button class="artifact-comment-toggle" data-id="${escHtml(it.id)}" title="Show comments">
        💬<span class="comment-count">${comments.length || ''}</span>
      </button>` : '';
    const commentsBlock = supportsVoting ? `
      <div class="artifact-comments" data-id="${escHtml(it.id)}" hidden>
        <div class="artifact-comments-list">${
          comments.map((c) => `
            <div class="artifact-comment" data-cid="${escHtml(c.id)}">
              <span class="comment-user">${escHtml(c.user || '?')}</span>
              <span class="comment-ts">${escHtml(formatChatTs(c.ts) || '')}</span>
              <div class="comment-body">${renderMd(c.text || '')}</div>
            </div>`).join('')
        }</div>
        <form class="artifact-comment-form" data-id="${escHtml(it.id)}">
          <input type="text" class="artifact-comment-input" placeholder="Add a comment…" maxlength="1000" />
          <button type="submit" class="artifact-comment-send">Post</button>
        </form>
      </div>` : '';
    return `<li class="${cls}" data-id="${escHtml(it.id)}">
      <div class="artifact-item-row">
        <input class="artifact-item-checkbox" type="checkbox" ${it.done ? 'checked' : ''} data-type="${escHtml(type)}" data-id="${escHtml(it.id)}" />
        <span class="artifact-item-text">${escHtml(it.text || '')}</span>
        ${voteBlock}
        <button class="artifact-item-delete" data-id="${escHtml(it.id)}" title="Delete this item" aria-label="Delete">×</button>
      </div>
      ${commentsBlock}
    </li>`;
  };

  let bodyHtml;
  if (supportsVoting) {
    // Group plan items by layer; preserve extraction order within each layer
    // AND first-seen layer order overall. A single shared layer ("Other" by
    // default) means the UI still degrades cleanly when the model returns the
    // legacy untagged shape.
    const layers = [];
    const buckets = new Map();
    for (const it of items) {
      const layer = (it.layer && String(it.layer).trim()) || 'Other';
      if (!buckets.has(layer)) { layers.push(layer); buckets.set(layer, []); }
      buckets.get(layer).push(it);
    }
    bodyHtml = layers.map((layer) => `
      <div class="artifact-layer-group">
        <h4 class="artifact-layer-name">${escHtml(layer)}</h4>
        <ul class="artifact-items">${buckets.get(layer).map(renderItem).join('')}</ul>
      </div>
    `).join('');
  } else {
    bodyHtml = `<ul class="artifact-items">${items.map(renderItem).join('')}</ul>`;
  }
  body.innerHTML = bodyHtml +
    (artifact.updatedAt ? `<div class="artifact-updated">Updated ${escHtml(formatChatTs(artifact.updatedAt) || artifact.updatedAt)}</div>` : '');
  body.querySelectorAll('.artifact-item-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => onArtifactItemToggle(cb));
  });
  body.querySelectorAll('.artifact-item-delete').forEach((btn) => {
    btn.addEventListener('click', () => onArtifactItemDelete(type, btn.dataset.id));
  });
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
    body.querySelectorAll('.artifact-comment-form').forEach((form) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const id = form.dataset.id;
        const input = form.querySelector('.artifact-comment-input');
        if (input && input.value.trim()) onArtifactComment(type, id, input.value.trim());
      });
    });
  }
}

async function onArtifactItemDelete(type, itemId) {
  const sid = state.activeId;
  if (!sid || !itemId) return;
  // Confirm so a fat-finger doesn't lose comments + votes silently.
  if (!confirm('Delete this item? Its votes and comments will be gone too.')) return;
  try {
    const res = await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/artifact/item?type=${encodeURIComponent(type)}&itemId=${encodeURIComponent(itemId)}`,
      { method: 'DELETE' }
    );
    if (!res || !res.ok) return;
    await loadArtifact(type);
  } catch (err) {
    console.error('item delete failed', err);
  }
}

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
      // Server already broadcasts the @myco via handleChatMessage, so we
      // don't need to emit anything client-side; just a console log for
      // debugging.
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

async function onArtifactItemToggle(cb) {
  const type = cb.dataset.type;
  const id = cb.dataset.id;
  const sid = state.activeId;
  if (!type || !id || !sid) return;
  const li = cb.closest('li');
  // For 'plan' items, checking the box also dispatches the todo back to the
  // running Claude session as `@myco <text>`. The server is the source of
  // truth — we POST and let the response confirm.
  const action = (type === 'plan' && cb.checked) ? 'run' : 'mark';
  try {
    const res = await authedFetch(
      `/sessions/${encodeURIComponent(sid)}/artifact/${action}?type=${encodeURIComponent(type)}&itemId=${encodeURIComponent(id)}&done=${cb.checked ? '1' : '0'}`,
      { method: 'POST' }
    );
    if (!res || !res.ok) {
      cb.checked = !cb.checked;
      return;
    }
    if (li) li.classList.toggle('is-done', cb.checked);
  } catch {
    cb.checked = !cb.checked;
  }
}

// Slash-command + @-mention dropdown for the chat input.
//
// State machine: as the user types, we look at the active token before the
// caret. If it begins with `/` we show known slash commands; if it begins
// with `@` we show known users. Up/Down navigates, Enter/Tab inserts.
// Esc dismisses. Picks happen on click too. The popup is positioned by CSS
// (anchored above the chat-form via #chat-autocomplete).
let _chatAcCache = { commands: null, users: null, fetchedAt: 0 };

async function _loadAcData() {
  const stale = !_chatAcCache.commands || (Date.now() - _chatAcCache.fetchedAt) > 60000;
  if (!stale) return _chatAcCache;
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
  return _chatAcCache;
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

  async function refresh() {
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
    const data = await _loadAcData();
    const q = tok.slice(1).toLowerCase();
    if (tok[0] === '/') {
      const matches = (data.commands || []).filter((c) =>
        c.name.toLowerCase().startsWith(q) ||
        (c.aliases || []).some((a) => a.toLowerCase().startsWith(q))
      );
      items = matches.map((c) => ({
        name: c.usage || ('/' + c.name),
        desc: c.summary || '',
        insert: '/' + c.name,
      }));
    } else {
      const matches = (data.users || []).filter((u) => u.toLowerCase().startsWith(q));
      items = matches.map((u) => ({ name: '@' + u, desc: '', insert: '@' + u }));
    }
    if (!items.length) { close(); return; }
    active = 0;
    open = true;
    dropdown.hidden = false;
    render();
  }

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
  input.addEventListener('blur', () => setTimeout(close, 120));   // allow click-pick

  input.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
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

  // Restore last-saved width.
  const saved = parseInt(localStorage.getItem('myco_chatpane_w') || '', 10);
  if (Number.isFinite(saved) && saved >= MIN_W && saved <= 1200) {
    document.documentElement.style.setProperty('--chatpane-w', saved + 'px');
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
  const termWrap = document.getElementById('terminal-wrap');
  const convWrap = document.getElementById('conversation-wrap');
  state.files.prevView = !termWrap.hidden ? 'terminal' : (!convWrap.hidden ? 'conversation' : null);
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
  loadFileTree(state.files.currentPath || '.');
  updateChatButton();
}

function hideFilesView() {
  document.getElementById('files-wrap').hidden = true;
  document.getElementById('files-view-pane').hidden = true;
  document.getElementById('btn-files')?.classList.remove('active');
  state.files.visible = false;
  // Restore the previous main view (terminal or conversation).
  if (state.activeId) {
    const which = state.files.prevView;
    if (which === 'terminal') document.getElementById('terminal-wrap').hidden = false;
    else if (which === 'conversation') document.getElementById('conversation-wrap').hidden = false;
  }
  state.files.prevView = null;
  if (state.fitAddon) requestAnimationFrame(() => { try { state.fitAddon.fit(); } catch {} });
  updateChatButton();
}

async function loadFileTree(relPath) {
  if (!state.activeId) return;
  const id = state.activeId;
  const url = `/sessions/${encodeURIComponent(id)}/files?path=${encodeURIComponent(relPath || '.')}`;
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
    parts.push(
      `<li class="${cls}" data-name="${escHtml(e.name)}" data-kind="${e.kind}">` +
      `${ic}` +
      `<span class="ft-name">${escHtml(e.name)}${e.kind === 'dir' ? '/' : ''}</span>` +
      `</li>`
    );
  }
  if (truncated) parts.push(`<li class="kind-other" style="opacity:.6"><span class="ft-ic"></span>…(truncated, more entries hidden)</li>`);
  ul.innerHTML = parts.join('');

  ul.querySelectorAll('li[data-name]').forEach((li) => {
    li.addEventListener('click', () => {
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

// Compact uppercase badge per file kind/extension. CSS colors it by class.
function renderFileTreeIcon(entry) {
  if (entry.kind === 'dir' || entry.kind === 'symlink' || entry.kind === 'other') {
    return `<span class="ft-ic"></span>`;
  }
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  const map = {
    js: 'JS', mjs: 'JS', cjs: 'JS', jsx: 'JS',
    ts: 'TS', tsx: 'TS',
    json: 'JSON', md: 'MD', markdown: 'MD',
    css: 'CSS', scss: 'CSS',
    html: 'HTML', htm: 'HTML', svg: 'HTML', xml: 'HTML',
    sh: 'SH', bash: 'SH', zsh: 'SH',
    py: 'PY', rb: 'RB', go: 'GO', rs: 'RS',
    yml: 'YML', yaml: 'YML', toml: 'YML',
    c: 'C', h: 'C', cpp: 'C++', hpp: 'C++',
    java: 'JV', kt: 'KT', swift: 'SW', sql: 'SQL',
  };
  const cls = map[ext] ? `ext-${ext.replace('+', '')}` : 'ext-default';
  const label = map[ext] || '';
  return `<span class="ft-ic ${cls}">${escHtml(label)}</span>`;
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
function showConnOverlay(text, kind, sub) {
  const overlay = document.getElementById('conn-overlay');
  if (!overlay) return;
  const pill = overlay.querySelector('.conn-pill');
  const txt = overlay.querySelector('.conn-text');
  const subEl = overlay.querySelector('.conn-sub');
  if (txt) txt.textContent = text || 'Connecting';
  if (subEl && sub) subEl.textContent = sub;
  if (pill) pill.classList.toggle('error', kind === 'error');
  overlay.hidden = false;
}
function hideConnOverlay() {
  const overlay = document.getElementById('conn-overlay');
  if (overlay) overlay.hidden = true;
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
    `<span>💬 Claude · ${escHtml(anchorTxt)}</span><span class="cc-spacer"></span>` +
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
    if (!confirm('Delete this Claude reply?')) return;
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
    `<div class="cc-anchor"><span>💬 Claude · ${escHtml(anchorTxt)}</span></div>` +
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
    const ts = e.ts ? e.ts.slice(11, 19) : '';
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
});
