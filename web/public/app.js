/* global Terminal, FitAddon, Keyboard */

const state = {
  sessions: [],
  activeId: null,
  term: null,
  fitAddon: null,
  ws: null,
  keyboard: null,
  token: localStorage.getItem('myco_token') || '',
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
  const ok = await tryToken(state.token);
  if (ok) { init(); }
  else    { showLogin(); }
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


  document.getElementById('btn-spawn').addEventListener('click', openSpawnModal);
  document.getElementById('spawn-cancel').addEventListener('click', closeSpawnModal);
  document.getElementById('spawn-ok').addEventListener('click', doSpawn);
  document.getElementById('btn-expand').addEventListener('click', () => setSidebar(false));
  document.getElementById('btn-collapse').addEventListener('click', () => setSidebar(true));
  document.getElementById('spawn-cwd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSpawn(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSpawnModal(); }
  });
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
    li.dataset.id = s.id;
    const dirName = (s.cwd || '').split('/').filter(Boolean).pop() || s.cwd || '~';
    const idShort = s.id.replace(/^myco-/, '').slice(0, 8);
    const desc = s.description
      ? `<span class="session-desc">${escHtml(s.description)}</span>`
      : '';
    li.innerHTML = `
      <span class="session-title">${escHtml(dirName)}</span>
      ${desc}
      <span class="session-meta">${escHtml(idShort)} · ${timeAgo(s.created_at)}</span>
      <button class="session-delete" aria-label="Delete session">×</button>
    `;
    li.addEventListener('click', () => openSession(s.id));
    const delBtn = li.querySelector('.session-delete');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSessionWithConfirm(s);
    });
    attachLongPressDeleteToggle(li);
    ul.appendChild(li);
  }
}

// On touch devices, long-press a card to reveal the × on every card.
// On hover-capable devices a CSS hover rule already shows it, so this is a
// no-op there.
function attachLongPressDeleteToggle(li) {
  let timer = null;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  li.addEventListener('touchstart', () => {
    cancel();
    timer = setTimeout(() => {
      document.getElementById('session-list').classList.add('show-delete');
      if (navigator.vibrate) navigator.vibrate(15);
    }, 500);
  }, { passive: true });
  li.addEventListener('touchend', cancel);
  li.addEventListener('touchmove', cancel, { passive: true });
  li.addEventListener('touchcancel', cancel);
}

// Tap outside any card or × button exits delete-mode on mobile.
document.addEventListener('click', (e) => {
  const list = document.getElementById('session-list');
  if (!list || !list.classList.contains('show-delete')) return;
  if (e.target.closest('.session-delete')) return;
  if (e.target.closest('.session-item')) return;
  list.classList.remove('show-delete');
});

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
      document.getElementById('terminal-wrap').hidden = true;
      document.getElementById('no-session').hidden = false;
    }
    document.getElementById('session-list').classList.remove('show-delete');
    await refreshSessions();
  } catch (err) {
    alert(`Could not delete session: ${err.message || err}`);
  }
}

// ── terminal attach ───────────────────────────────────────────────────────────

function openSession(id) {
  // Re-tap of the same already-attached session - just bring it into view.
  if (state.activeId === id && state.ws) {
    if (window.innerWidth <= 900) setSidebar(true);
    return;
  }

  // tear down previous
  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.term) { state.term.dispose(); state.term = null; }

  state.activeId = id;
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

  // websocket
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const tokParam = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  state.ws = new WebSocket(`${proto}://${location.host}/attach/${encodeURIComponent(id)}${tokParam}`);

  state.ws.addEventListener('open', () => {
    state.ws.send(JSON.stringify({ t: 'resize', cols: state.term.cols, rows: state.term.rows }));
  });

  state.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'output') {
      state.term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
    } else if (msg.t === 'exit') {
      state.term.writeln('\r\n[session ended]');
    }
  });

  state.ws.addEventListener('close', () => {
    state.term?.writeln('\r\n[disconnected]');
  });

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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-ok').addEventListener('click', doLogin);
  document.getElementById('login-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
  });
  bootstrap();
});
