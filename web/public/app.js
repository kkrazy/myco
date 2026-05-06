/* global Terminal, FitAddon, WebglAddon, CanvasAddon, Keyboard */

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
};

// ── auth ──────────────────────────────────────────────────────────────────────

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
  return !!body.ok;
}

async function bootstrap() {
  // Share-link viewer: ?s=<token> bypasses login and attaches read-only.
  const shareTok = new URL(window.location.href).searchParams.get('s');
  if (shareTok) return enterShareMode(shareTok);

  const ok = await tryToken(state.token);
  if (ok) { init(); }
  else    { showLogin(); }
}

async function enterShareMode(shareTok) {
  state.shareMode = true;
  state.shareToken = shareTok;
  document.body.classList.add('share-mode');
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
  openShareViewer(info.sessionId);
}

function showShareError(msg) {
  document.body.innerHTML =
    `<div style="color:#ccc;font:14px -apple-system,system-ui,sans-serif;` +
    `display:flex;align-items:center;justify-content:center;height:100dvh;` +
    `padding:20px;text-align:center;">${escHtml(msg)}</div>`;
}

function openShareViewer(id) {
  state.activeId = id;
  document.getElementById('no-session').hidden = true;
  document.getElementById('terminal-wrap').hidden = false;

  state.term = new Terminal({ scrollback: 5000, fontSize: 13, disableStdin: true });
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

  new ResizeObserver(() => state.fitAddon && state.fitAddon.fit()).observe(el);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let reconnectDelay = 1000;
  function connectShare() {
    const ws = new WebSocket(
      `${proto}://${location.host}/attach/${encodeURIComponent(id)}?s=${encodeURIComponent(state.shareToken)}`
    );
    state.ws = ws;
    ws.addEventListener('open', () => { reconnectDelay = 1000; });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'output') {
        state.term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
      } else if (msg.t === 'exit') {
        state.term.writeln('\r\n[session ended]');
      }
    });
    ws.addEventListener('close', () => {
      state.term?.writeln('\r\n[reconnecting...]');
      setTimeout(() => { if (state.shareMode) connectShare(); }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
    });
  }
  connectShare();
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

  // Auto-attach: prefer the session this browser was last on (so a mycod
  // restart + page reload lands you back where you were). If it's gone,
  // fall back to the most-recently-active session on the server.
  if (!state.activeId && state.sessions.length) {
    const persisted = localStorage.getItem('myco_active_id');
    const target = (persisted && state.sessions.find((s) => s.id === persisted))
      || mostRecentSession(state.sessions);
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
    const res = await authedFetch('/sessions');
    state.sessions = await res.json();
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
    if (s.status) li.dataset.status = s.status;
    li.dataset.id = s.id;
    const dirName = (s.cwd || '').split('/').filter(Boolean).pop() || s.cwd || '~';
    const idShort = s.id.replace(/^myco-/, '').slice(0, 8);
    const summary = s.summary
      ? `<span class="session-summary">${escHtml(s.summary)}</span>`
      : (s.description ? `<span class="session-desc">${escHtml(s.description)}</span>` : '');
    const statusDot = s.status ? `<span class="session-status session-status-${s.status}" aria-label="Status: ${s.status}"></span>` : '';
    li.innerHTML = `
      ${statusDot}
      <span class="session-title">${escHtml(dirName)}</span>
      ${summary}
      <span class="session-meta">${escHtml(idShort)} · ${timeAgo(s.last_activity || s.created_at)}</span>
      <button class="session-share" aria-label="Share session">↗</button>
      <button class="session-vscode" aria-label="Open in VS Code">{·}</button>
      <button class="session-delete" aria-label="Delete session">×</button>
    `;
    li.addEventListener('click', () => {
      // If the long-press menu is showing on this card, the tap just dismisses
      // it (handled by the document click listener). A second tap opens.
      if (li.classList.contains('show-delete')) return;
      openSession(s.id);
    });
    const delBtn = li.querySelector('.session-delete');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSessionWithConfirm(s);
    });
    const shareBtn = li.querySelector('.session-share');
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shareSession(s);
    });
    const codeBtn = li.querySelector('.session-vscode');
    codeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openInVscode(s);
    });
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

  state.activeId = id;
  try { localStorage.setItem('myco_active_id', id); } catch {}
  renderSessionList();

  // On mobile, collapse the (full-width) sidebar so the terminal is visible
  if (window.innerWidth <= 900) setSidebar(true);

  document.getElementById('no-session').hidden = true;
  const wrap = document.getElementById('terminal-wrap');
  wrap.hidden = false;

  state.term = new Terminal({ scrollback: 5000, fontSize: 13 });
  state.fitAddon = new FitAddon.FitAddon();
  state.term.loadAddon(state.fitAddon);
  const el = document.getElementById('terminal');
  el.innerHTML = '';
  state.term.open(el);
  state.fitAddon.fit();

  // GPU/canvas renderer — the default DOM renderer is too slow for Claude's
  // styled output. Try WebGL first, fall back to 2D canvas if it fails
  // (e.g. WebGL blocked, low-end mobile GPU).
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
    state.term.loadAddon(webgl);
  } catch {
    try { state.term.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
  }

  setupTouchScroll(state.term);

  // Suppress iOS soft keyboard. xterm keeps a hidden <textarea> focused; on iOS,
  // tapping any button blurs+refocuses it, which raises the OS keyboard. Setting
  // inputmode="none" tells iOS not to show the keyboard. The Keyboard component
  // can flip this when the user explicitly wants native typing.
  state.xtermTextarea = el.querySelector('.xterm-helper-textarea');
  if (state.xtermTextarea) state.xtermTextarea.setAttribute('inputmode', 'none');

  // resize observer
  const ro = new ResizeObserver(() => {
    state.fitAddon.fit();
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ t: 'resize', cols: state.term.cols, rows: state.term.rows }));
    }
  });
  ro.observe(el);

  // keyboard
  if (!state.keyboard) {
    state.keyboard = new Keyboard(document.getElementById('keyboard-bar'), sendInput);
  }

  // websocket with auto-reconnect
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tokParam = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  let reconnectDelay = 1000;
  const maxDelay = 15000;

  function connect() {
    const ws = new WebSocket(`${proto}://${location.host}/attach/${encodeURIComponent(id)}${tokParam}`);
    state.ws = ws;

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ t: 'resize', cols: state.term.cols, rows: state.term.rows }));
    });

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'output') {
        state.term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
      } else if (msg.t === 'exit') {
        state.term.writeln('\r\n[session ended]');
      }
    });

    ws.addEventListener('close', () => {
      if (state.activeId !== id) return; // switched to another session
      state.term?.writeln('\r\n[reconnecting...]');
      setTimeout(() => {
        if (state.activeId === id) connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, maxDelay);
    });
  }

  state.term.writeln('\r\n[connecting...]');
  connect();

  // forward xterm keyboard input; auto-collapse sidebar on first keystroke
  state.term.onData((data) => {
    setSidebar(true);
    sendInput(data);
  });
}

function setSidebar(collapsed) {
  document.getElementById('sidebar').hidden = collapsed;
  document.getElementById('btn-expand').hidden = !collapsed;
  // give xterm a chance to refit
  if (state.fitAddon) requestAnimationFrame(() => state.fitAddon.fit());
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

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function timeAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-ok').addEventListener('click', doLogin);
  document.getElementById('login-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });
  bootstrap();
});
