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
  chatPaneVisible: window.innerWidth > 900,
  shareMode: false, // kept for compat — no longer gates UI
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
  modal.hidden = false;
  document.getElementById('login-token').focus();
}

function hideLogin() {
  document.getElementById('login-modal').hidden = true;
}

async function tryToken(token) {
  const res = await fetch('/auth/check', { headers: { Authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (body.ok && body.user) state.chatUser = body.user;
  return !!body.ok;
}

async function bootstrap() {
  const shareTok = new URL(window.location.href).searchParams.get('s');

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

function openShareViewer(id) {
  state.activeId = id;
  state.viewerMode = false;
  state.transcriptMessages = [];
  document.getElementById('no-session').hidden = true;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let reconnectDelay = 1000;
  function connectShare() {
    const tokParam = state.token ? `&token=${encodeURIComponent(state.token)}` : '';
    const nameParam = state.shareName ? `&name=${encodeURIComponent(state.shareName)}` : '';
    const ws = new WebSocket(
      `${proto}://${location.host}/attach/${encodeURIComponent(id)}?s=${encodeURIComponent(state.shareToken)}${tokParam}${nameParam}`
    );
    state.ws = ws;
    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'viewer-mode') {
        state.viewerMode = true;
        showConversationView();
      } else if (msg.t === 'transcript-init') {
        state.transcriptMessages = msg.messages || [];
        renderTranscriptMessages(state.transcriptMessages);
      } else if (msg.t === 'transcript-delta') {
        const newMsgs = msg.messages || [];
        state.transcriptMessages.push(...newMsgs);
        appendTranscriptMessages(newMsgs);
      } else if (msg.t === 'transcript-waiting') {
        showTranscriptWaiting();
      } else if (msg.t === 'output') {
        if (!state.viewerMode) ensureXtermForFallback();
        if (state.term) state.term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
      } else if (msg.t === 'pong') {
        state.lastPongAt = Date.now();
      } else if (msg.t === 'chat-history') {
        applyChatHistory(msg.messages);
      } else if (msg.t === 'chat') {
        appendChatMessage(msg.message);
      } else if (msg.t === 'exit') {
        if (state.term) state.term.writeln('\r\n[session ended]');
      } else if (msg.t === 'error') {
        if (state.term) state.term.writeln('\r\n[error: ' + (msg.message || 'unknown') + ']');
        state.activeId = null; // stop the reconnect loop on stale share
      }
    });
    ws.addEventListener('close', () => {
      if (state.activeId !== id) return;
      setTimeout(() => { if (state.activeId === id) connectShare(); }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
    });
  }
  connectShare();
}

function ensureXtermForFallback() {
  if (state.term) return;
  document.getElementById('terminal-wrap').hidden = false;
  state.term = new Terminal({ scrollback: 5000, fontSize: 13, fontFamily: "'JetBrains Mono Nerd Font', 'JetBrains Mono', Menlo, monospace" });
  state.fitAddon = new FitAddon.FitAddon();
  state.term.loadAddon(state.fitAddon);
  const el = document.getElementById('terminal');
  el.innerHTML = '';
  state.term.open(el);
  state.fitAddon.fit();
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
    state.term.loadAddon(webgl);
  } catch {
    try { state.term.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
  }
  setupTouchScroll(state.term);
  refreshXtermAfterFontLoad(state.term);
}

function showConversationView() {
  document.getElementById('terminal-wrap').hidden = true;
  document.getElementById('conversation-wrap').hidden = false;
  updateChatButton();
}

function showTranscriptWaiting() {
  showConversationView();
  const container = document.getElementById('conv-messages');
  container.innerHTML = '<div class="conv-waiting">Waiting for session to start...</div>';
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Full markdown rendering for conversation view via marked library
function renderMd(text) {
  if (typeof marked !== 'undefined' && marked.parse) {
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
    return marked.parse(text, { breaks: true, gfm: true, renderer });
  }
  return escHtml(text);
}

// Render any ```mermaid code blocks into SVG diagrams
async function renderMermaidInContainer(container) {
  if (typeof mermaid === 'undefined') return;
  const blocks = container.querySelectorAll('pre code.language-mermaid');
  for (const block of blocks) {
    const pre = block.parentElement;
    const id = 'mermaid-' + Math.random().toString(36).slice(2, 10);
    try {
      const { svg } = await mermaid.render(id, block.textContent);
      const div = document.createElement('div');
      div.className = 'conv-mermaid';
      div.innerHTML = svg;
      pre.replaceWith(div);
    } catch {
      // Leave as raw code block if mermaid fails
    }
  }
}

function scrollConvToBottom() {
  const wrap = document.getElementById('conversation-wrap');
  requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
}

function isConvAtBottom() {
  const wrap = document.getElementById('conversation-wrap');
  return wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 60;
}

function renderTranscriptMessages(messages) {
  showConversationView();
  const container = document.getElementById('conv-messages');
  container.innerHTML = '';
  let turnEl = null;
  for (const m of messages) {
    const el = renderConvMessage(m);
    // Start a new turn on user messages
    if (m.role === 'user' || m.role === 'title') {
      turnEl = document.createElement('div');
      turnEl.className = 'conv-turn';
      container.appendChild(turnEl);
    }
    if (turnEl) {
      turnEl.appendChild(el);
    } else {
      container.appendChild(el);
    }
  }
  scrollConvToBottom();
  renderMermaidInContainer(container);
}

function appendTranscriptMessages(messages) {
  const wasAtBottom = isConvAtBottom();
  const container = document.getElementById('conv-messages');
  let turnEl = container.lastElementChild;
  for (const m of messages) {
    const el = renderConvMessage(m);
    if (m.role === 'user' || m.role === 'title') {
      turnEl = document.createElement('div');
      turnEl.className = 'conv-turn';
      container.appendChild(turnEl);
    }
    if (turnEl) {
      turnEl.appendChild(el);
    } else {
      container.appendChild(el);
    }
  }
  if (wasAtBottom) scrollConvToBottom();
  renderMermaidInContainer(container);
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
    textEl.textContent = m.text;
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
          body.textContent = rest;
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

async function doLogin() {
  const input = document.getElementById('login-token');
  const errEl = document.getElementById('login-error');
  const token = input.value.trim();
  if (!token) return;
  const ok = await tryToken(token);
  if (ok) {
    state.token = token;
    localStorage.setItem('myco_token', token);
    errEl.hidden = true;
    hideLogin();
    init();
  } else {
    errEl.textContent = 'Invalid token';
    errEl.hidden = false;
    input.select();
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
  // Desktop default: chat pane visible alongside the terminal. Mobile: hidden,
  // user opens it explicitly via the 💬 button (mutually exclusive with the
  // session sidebar).
  setChatPane(window.innerWidth > 900);
  connectLogWs();
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
    if (s.shared) li.classList.add('shared');
    if (s.status) li.dataset.status = s.status;
    li.dataset.id = s.id;
    const dirName = (s.cwd || '').split('/').filter(Boolean).pop() || s.cwd || '~';
    const idShort = s.id.replace(/^myco-/, '').slice(0, 8);
    const summary = s.summary
      ? `<span class="session-summary">${escHtml(s.summary)}</span>`
      : (s.description ? `<span class="session-desc">${escHtml(s.description)}</span>` : '');
    const statusDot = s.status ? `<span class="session-status session-status-${s.status}" aria-label="Status: ${s.status}"></span>` : '';
    const sharedBadge = s.shared
      ? `<span class="shared-badge" title="Shared by ${escHtml(s.owner || 'unknown')} — read-only">${escHtml(s.owner || 'shared')}</span>`
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

function openSession(id) {
  // Re-tap of the same session: reconnect if WS is dead, otherwise just bring into view.
  if (state.activeId === id && state.ws && state.ws.readyState === WebSocket.OPEN) {
    if (window.innerWidth <= 900) setSidebar(true);
    return;
  }

  // tear down previous
  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.term) { state.term.dispose(); state.term = null; }
  state.viewerMode = false;
  state.transcriptMessages = [];
  document.getElementById('terminal').innerHTML = '';
  document.getElementById('terminal-wrap').hidden = true;
  document.getElementById('conversation-wrap').hidden = true;
  document.getElementById('conv-messages').innerHTML = '';

  state.activeId = id;
  state.viewerMode = false;
  state.transcriptMessages = [];
  try { localStorage.setItem('myco_active_id', id); } catch {}
  renderSessionList();
  clearChat();
  updateChatButton();

  if (window.innerWidth <= 900) setSidebar(true);

  // Check if this is a shared session (not owned by current user)
  const session = state.sessions.find((s) => s.id === id);
  const isShared = session && !session.owned;

  document.getElementById('no-session').hidden = true;

  // Only create xterm for owned sessions. Shared sessions wait for
  // the server to send viewer-mode, then show conversation view.
  if (!isShared) {
    const wrap = document.getElementById('terminal-wrap');
    wrap.hidden = false;

    state.term = new Terminal({ scrollback: 5000, fontSize: 13, fontFamily: "'JetBrains Mono Nerd Font', 'JetBrains Mono', Menlo, monospace" });
    state.fitAddon = new FitAddon.FitAddon();
    state.term.loadAddon(state.fitAddon);
    const el = document.getElementById('terminal');
    el.innerHTML = '';
    state.term.open(el);
    state.fitAddon.fit();

    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
      state.term.loadAddon(webgl);
    } catch {
      try { state.term.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
    }

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

    state.term.writeln('\r\n[connecting...]');
  }

  // websocket with auto-reconnect
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tokParam = state.token ? `token=${encodeURIComponent(state.token)}` : '';
  const shareParam = isShared && state.shareToken ? `s=${encodeURIComponent(state.shareToken)}` : '';
  const queryParams = [tokParam, shareParam].filter(Boolean).join('&');
  const qs = queryParams ? `?${queryParams}` : '';
  let reconnectDelay = 1000;
  const maxDelay = 15000;

  function connect() {
    const ws = new WebSocket(`${proto}://${location.host}/attach/${encodeURIComponent(id)}${qs}`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      if (state.term) {
        ws.send(JSON.stringify({ t: 'resize', cols: state.term.cols, rows: state.term.rows }));
      }
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'viewer-mode') {
        state.viewerMode = true;
        if (state.term) { state.term.dispose(); state.term = null; }
        document.getElementById('terminal-wrap').hidden = true;
      } else if (msg.t === 'transcript-init') {
        state.transcriptMessages = msg.messages || [];
        renderTranscriptMessages(state.transcriptMessages);
      } else if (msg.t === 'transcript-delta') {
        const newMsgs = msg.messages || [];
        state.transcriptMessages.push(...newMsgs);
        appendTranscriptMessages(newMsgs);
      } else if (msg.t === 'transcript-waiting') {
        showTranscriptWaiting();
      } else if (msg.t === 'output') {
        state.term?.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
      } else if (msg.t === 'pong') {
        state.lastPongAt = Date.now();
      } else if (msg.t === 'chat-history') {
        applyChatHistory(msg.messages);
      } else if (msg.t === 'chat') {
        appendChatMessage(msg.message);
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
      state.term?.writeln('\r\n[reconnecting...]');
      setTimeout(() => {
        if (state.activeId === id) connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, maxDelay);
    });
  }

  if (state.term) state.term.writeln('\r\n[connecting...]');
  console.log('[myco] openSession', id, 'isShared=', isShared, 'qs=', qs);
  connect();

  // forward xterm keyboard input; auto-collapse sidebar on first keystroke
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
  state.chatPaneVisible = visible;
  document.getElementById('chatpane').hidden = !visible;
  // Mobile: showing chat dismisses the sidebar overlay (mutual exclusion).
  if (visible && window.innerWidth <= 900) {
    document.getElementById('sidebar').hidden = true;
    document.getElementById('btn-expand').hidden = false;
  }
  updateChatButton();
  if (state.fitAddon) requestAnimationFrame(() => state.fitAddon.fit());
}

function updateChatButton() {
  const btn = document.getElementById('btn-chat');
  if (!btn) return;
  const hasContent = !document.getElementById('terminal-wrap').hidden || !document.getElementById('conversation-wrap').hidden;
  btn.hidden = !state.activeId || state.chatPaneVisible || !hasContent;
}

// Replace native viewport scroll with a JS-driven scroll that calls
// term.scrollLines() each frame. This keeps the WebGL canvas position and
// the scroll position in lockstep — native iOS momentum scrolls on the
// compositor while WebGL repaints on the main thread, which desyncs.
function setupTouchScroll(term) {
  const root = term.element;
  if (!root) return;

  const SENSITIVITY = 1.6;

  let active = false;
  let moved = false;
  let dismissedKbd = false;
  let startY = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;     // pixels per ms (positive = scroll toward newer)
  let pixelDebt = 0;    // sub-line-height pixels not yet applied
  let raf = null;

  // If the soft keyboard is up (native-input mode), dismiss it once a
  // real scroll gesture starts so the terminal can use the full screen.
  const dismissSoftKeyboard = () => {
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('kbd-native-input')) {
      ae.blur();
    }
  };

  const cellHeight = () => {
    const rows = term.rows || 0;
    return rows > 0 ? root.clientHeight / rows : 17;
  };

  const applyPx = (dy) => {
    pixelDebt += dy * SENSITIVITY;
    const ch = cellHeight();
    const lines = (pixelDebt > 0 ? Math.floor : Math.ceil)(pixelDebt / ch);
    if (lines !== 0) {
      term.scrollLines(lines);
      pixelDebt -= lines * ch;
    }
  };

  const cancelMomentum = () => {
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  };

  root.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    cancelMomentum();
    active = true;
    moved = false;
    dismissedKbd = false;
    pixelDebt = 0;
    velocity = 0;
    startY = lastY = e.touches[0].clientY;
    lastTime = performance.now();
  }, { passive: true });

  root.addEventListener('touchmove', (e) => {
    if (!active || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const now = performance.now();
    const dy = lastY - y;                       // swipe up => positive => scroll down
    const dt = Math.max(1, now - lastTime);
    if (Math.abs(dy) > 0) moved = true;
    if (!dismissedKbd && Math.abs(y - startY) > 8) {
      dismissedKbd = true;
      dismissSoftKeyboard();
    }
    velocity = velocity * 0.4 + (dy / dt) * 0.6; // EWMA for stable kickoff
    applyPx(dy);
    lastY = y;
    lastTime = now;
  }, { passive: true });

  root.addEventListener('touchend', () => {
    if (!active) return;
    active = false;
    if (!moved || Math.abs(velocity) < 0.05) return;
    let v = velocity;
    let prev = performance.now();
    const tick = () => {
      if (!root.isConnected) { raf = null; return; }
      const now = performance.now();
      const dt = now - prev;
      prev = now;
      applyPx(v * dt);
      v *= Math.pow(0.94, dt / 16);
      if (Math.abs(v) > 0.02) raf = requestAnimationFrame(tick);
      else raf = null;
    };
    raf = requestAnimationFrame(tick);
  });

  root.addEventListener('touchcancel', () => { active = false; cancelMomentum(); }, { passive: true });
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

function openSpawnModal() {
  document.getElementById('spawn-cwd').value = '';
  document.getElementById('spawn-modal').hidden = false;
  document.getElementById('spawn-cwd').focus();
}

function closeSpawnModal() {
  document.getElementById('spawn-modal').hidden = true;
}

async function doSpawn() {
  const cwd = document.getElementById('spawn-cwd').value.trim() || undefined;
  const errEl = document.getElementById('spawn-error');
  errEl.hidden = true;
  errEl.textContent = '';
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
  renderChatPane();
}

function appendChatMessage(message) {
  if (!message || typeof message !== 'object') return;
  state.chatMessages.push(message);
  renderChatPane(/*scrollToBottom*/ true);
}

function clearChat() {
  state.chatMessages = [];
  renderChatPane();
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
  list.innerHTML = state.chatMessages.map(renderChatMessage).join('');
  if (scrollToBottom) list.scrollTop = list.scrollHeight;
}

function renderChatMessage(m) {
  const fromClaude = m.user === 'claude';
  const fromSelf = state.chatUser && m.user === state.chatUser;
  const ts = m.ts ? formatChatTs(m.ts) : '';
  let cls = 'chat-msg';
  if (fromClaude) cls += ' from-claude';
  if (fromSelf) cls += ' from-self';
  return `<div class="${cls}">
    <div class="chat-meta"><span class="chat-user">${escHtml(m.user || '?')}</span><span class="chat-ts">${escHtml(ts)}</span></div>
    <div class="chat-text">${escHtml(m.text || '')}</div>
  </div>`;
}

function formatChatTs(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function sendChatMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ t: 'chat', text: trimmed }));
  return true;
}

function bindChatUi() {
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  if (!form || !input) return;
  if (form.dataset.bound) return;
  form.dataset.bound = '1';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sendChatMessage(input.value)) input.value = '';
  });

  document.getElementById('btn-chat')?.addEventListener('click', () => setChatPane(!state.chatPaneVisible));
  document.getElementById('chatpane-close')?.addEventListener('click', () => setChatPane(false));
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
  document.getElementById('login-ok').addEventListener('click', doLogin);
  document.getElementById('login-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });
  bootstrap();
});
