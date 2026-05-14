const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const { EventEmitter } = require('events');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { MenuInterceptor } = require('./menu-interceptor');
const permissions = require('./permissions');
// Late-bound: sessions.js requires this module, so destructuring at load
// time would capture undefined values from the partial export.
const sessionsMod = require('./sessions');
const { askAssistant, shouldAskAssistant, ASSISTANT_USER } = require('./btw');
const { stripAnsi, tailLines } = require('./text-utils');
const menuMod = require('./menu');
const {
  MODE_ACCEPT_RE, MODE_PLAN_RE, MODE_BYPASS_RE,
  SPINNER_RUNNING_RE, SPINNER_DURATION_RE,
  MULTI_SELECT_CURSOR_RE, SUBMIT_ROW_RE, MENU_OPT_LINE_RE,
  STATUS_TOKEN_TRAILER_RE, STATUS_INTERRUPT_RE, EFFORT_CHIP_RE,
  WIZARD_TAB_BAR_RE, WIZARD_RICH_FOOTER_RE,
} = require('./pty-patterns');
const slashcmds = require('./slashcmds');
const transcriptMod = require('./transcript');
const authMod = require('./auth');
// Late-bound: requiring artifacts.js at module load time pulled
// extractor.js into the partial-load window of the
// sessions.js ↔ pty.js cycle. extractor.js destructures
// { projectsDir, encodeCwdForClaude, getChatHistory } from sessions —
// which at that point hadn't yet evaluated its module.exports
// assignment, so the destructured names were undefined. Result:
// "projectsDir is not a function" at every /artifact/refresh call.
// Resolve lazily inside _sendAttachSnapshot via this getter so the
// require runs AFTER all cycle modules have finished loading.
let _artifactsMod = null;
function getArtifactsMod() {
  if (!_artifactsMod) _artifactsMod = require('./artifacts');
  return _artifactsMod;
}

// "@<word> <body>" chat messages get routed to the running Claude PTY.
// Historically this only matched "@myco"; users typed "@generate" /
// "@claude" / etc. and the message silently stayed in chat. Now any
// @<word> prefix routes to claude UNLESS <word> matches a known
// username — so genuine user mentions (@kkrazy) still work as chat.
const CHAT_TO_PTY_PREFIX_RE = /^@([A-Za-z][\w-]{0,30})\s+([\s\S]+)/;

function _isKnownChatUser(word) {
  if (!word) return false;
  const w = word.toLowerCase();
  try {
    for (const u of authMod.listUsernames()) {
      if (String(u || '').toLowerCase() === w) return true;
    }
  } catch {}
  try {
    const allow = authMod.loadAllowlist();
    if (allow && typeof allow.has === 'function') {
      for (const u of allow) {
        if (String(u || '').toLowerCase() === w) return true;
      }
    }
  } catch {}
  return false;
}

const MAX_BUFFER = 1024 * 1024;
const CHAT_TEXT_LIMIT = 4000;
const ASSISTANT_SCROLLBACK_LINES = 40;
const ASSISTANT_CHAT_CONTEXT = 20;

class PtySession extends EventEmitter {
  constructor(sessionId, ptyProcess) {
    super();
    this.sessionId = sessionId;
    this.pty = ptyProcess;
    this.buffer = [];
    this.bufferSize = 0;
    this.alive = true;
    this.cols = ptyProcess.cols;
    this.rows = ptyProcess.rows;

    // Server-side headless terminal emulator. We mirror every PTY byte
    // through it so we can hand viewers a clean, layout-resolved snapshot
    // of the current visible screen — alt-screen, cursor positioning,
    // wraparound and clears all collapse into plain text per row.
    // allowProposedApi exposes the buffer reading API; logLevel:'off'
    // silences xterm's chatty info logs.
    this.headless = new HeadlessTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: 1000,
      allowProposedApi: true,
      logLevel: 'off',
    });

    // Detects when Claude shows a TUI menu (plan-finalization etc.) so we
    // can forward it to the discussion panel. The session caches the most
    // recent fired menu in `pendingMenu` so the /decide slash command knows
    // which dialog the user is responding to.
    this.menuInterceptor = new MenuInterceptor();
    this.pendingMenu = null;
    this._menuDebounce = null;
    // In-flight tool-call tracker. Keyed by tool_use id; populated when
    // an assistant message lands with a tool_use block, drained when the
    // matching user-message tool_result arrives. The chat pane uses this
    // to surface a "waiting on Agent · 47s" indicator so long-running
    // tools (Agent, Monitor, Bash with sleeps, …) don't look like the
    // session has hung. _seenToolMsgUuids dedups the cross-fire from
    // multiple transcript watchers (one per attached WS) all seeing the
    // same JSONL append.
    this.openToolCalls = new Map();
    this._seenToolMsgUuids = new Set();
    // Separate throttle for status emits. Decoupled from menu detection
    // because status frames don't need the 250ms alt-screen quiet period
    // (the spinner line lives in main scrollback, not the alt-screen
    // dialog buffer) and pre-decouple the status emit was riding on the
    // same debounce — which during a busy turn KEPT RESETTING and never
    // fired, so only the 750ms periodic scan got status out. On a
    // far-region link (Singapore from non-APAC viewer = ~220ms RTT) that
    // turned every status step into ~1s of perceived lag. Throttle is
    // trailing-edge at 100ms: one timer covers a burst of data, fires
    // once per window. Cheap: each fire is one regex scan of the
    // spinner line.
    this._statusThrottle = null;

    this.pty.onData((data) => {
      this._push(data);
      try { this.headless.write(data); } catch {}
      // Debounce menu detection — wait until the alt-screen render settles
      // before reading it, otherwise we'd scan partially-painted dialogs.
      if (this._menuDebounce) clearTimeout(this._menuDebounce);
      this._menuDebounce = setTimeout(() => this._checkMenu(), 250);
      // Schedule a status emit on the 100ms throttle (if not already
      // pending). A trailing-edge throttle is the right shape here: the
      // first byte of a burst arms a 100ms timer, all subsequent bytes
      // in that window are coalesced into one emit at the end.
      if (!this._statusThrottle) {
        this._statusThrottle = setTimeout(() => {
          this._statusThrottle = null;
          try { this._emitStatusIfChanged(); } catch {}
        }, 100);
      }
      this.emit('data', data);
    });
    // Periodic safety scan — the data-event debounce only fires when
    // bytes stop flowing for 250ms. During a busy turn with rapid
    // back-to-back dialogs (parallel tool calls, fast-resolving permission
    // prompts) the debounce can keep resetting, so only the LAST menu of
    // the burst ever gets hashed and any intermediate dialogs are missed
    // entirely. This interval guarantees a scan on a fixed cadence
    // regardless of data activity, so no menu can live on screen
    // longer than ~750ms without being seen. Cheap: each tick is one
    // viewport scan (~30 lines × regex).
    this._periodicMenuScan = setInterval(() => this._checkMenu(), 750);
    this.pty.onExit(({ exitCode }) => {
      this.alive = false;
      if (this._periodicMenuScan) { clearInterval(this._periodicMenuScan); this._periodicMenuScan = null; }
      if (this._menuDebounce) { clearTimeout(this._menuDebounce); this._menuDebounce = null; }
      if (this._statusThrottle) { clearTimeout(this._statusThrottle); this._statusThrottle = null; }
      this.emit('exit', exitCode);
    });
  }

  // Back-compat alias preserved across the structured-status refactor.
  // The function name is referenced by older callers (and a regression
  // check in test.sh) — keep it as a one-line wrapper around the new
  // _findSpinnerLine() internal helper so nobody downstream breaks.
  _extractStatusLine() { return this._findSpinnerLine(); }

  // Find the spinner row in the bottom of the viewport. Returns the
  // raw line text (trimmed) or null if no spinner is rendered.
  // Internal helper — callers want _extractStatus() (structured) for
  // anything that flows to a client.
  _findSpinnerLine() {
    if (!this.headless || !this.headless.buffer) return null;
    try {
      const buf = this.headless.buffer.active;
      const rows = this.headless.rows;
      // Walk from the bottom up. The attached detail block (corner ⎿
      // + indented checklist) is deliberately ignored — only the top
      // spinner row goes to the chat-pane status strip. Look further
      // than the original 12-row window (20 rows) since the detail
      // block can push the spinner higher up the viewport.
      for (let i = rows - 1; i >= Math.max(0, rows - 20); i--) {
        const line = buf.getLine(buf.viewportY + i);
        if (!line) continue;
        const text = line.translateToString(true).trim();
        if (!text) continue;
        if (SPINNER_RUNNING_RE.test(text) || SPINNER_DURATION_RE.test(text)) return text;
      }
    } catch {}
    return null;
  }

  // Decompose the spinner status line into structured fields so the
  // readonly viewer can render chips instead of one opaque blob:
  //
  //   { text:    "✽ Cerebrating for 12s · ↓ 3.4k tokens · esc to interrupt",
  //     verb:    "Cerebrating",
  //     durationS: 12,
  //     tokens:  { dir: 'down', count: 3400 },
  //     interruptible: true,
  //     effort:  null }
  //
  // Returns null when no spinner is on screen (claude is idle). The
  // `text` field is preserved so older clients reading `claude-status.text`
  // keep working — `status` is purely additive.
  _extractStatus() {
    const text = this._findSpinnerLine();
    if (!text) return null;
    const verbMatch = text.match(/[A-Z][a-z]+ing/);
    const verb = verbMatch ? verbMatch[0] : null;
    const durMatch = text.match(/for\s+(?:(\d+)h\s+)?(?:(\d+)m\s+)?(\d+)s/);
    let durationS = null;
    if (durMatch) {
      const h = parseInt(durMatch[1] || '0', 10);
      const m = parseInt(durMatch[2] || '0', 10);
      const s = parseInt(durMatch[3] || '0', 10);
      durationS = h * 3600 + m * 60 + s;
    }
    let tokens = null;
    const tokMatch = STATUS_TOKEN_TRAILER_RE.exec(text);
    if (tokMatch) {
      const dir = tokMatch[1] === '↑' ? 'up' : 'down';
      let count = parseFloat(tokMatch[2]);
      const scale = (tokMatch[3] || '').toLowerCase();
      if (scale === 'k') count *= 1000;
      else if (scale === 'm') count *= 1000000;
      tokens = { dir, count: Math.round(count) };
    }
    const interruptible = STATUS_INTERRUPT_RE.test(text);
    let effort = null;
    const effMatch = EFFORT_CHIP_RE.exec(text);
    if (effMatch) effort = effMatch[1].toLowerCase();
    return { text, verb, durationS, tokens, interruptible, effort };
  }

  // Read claude's mode-bar line from the bottom of the viewport and
  // classify into 'plan'|'accept'|'bypass'|'default'. Scans separately
  // from the spinner (mode bar is visible both busy and idle, spinner
  // only when busy). Defensive try/catch matches _findSpinnerLine.
  _extractMode() {
    if (!this.headless || !this.headless.buffer) return 'default';
    try {
      const buf = this.headless.buffer.active;
      const rows = this.headless.rows;
      for (let i = rows - 1; i >= Math.max(0, rows - 10); i--) {
        const line = buf.getLine(buf.viewportY + i);
        if (!line) continue;
        const text = line.translateToString(true).trim();
        if (!text) continue;
        if (MODE_BYPASS_RE.test(text)) return 'bypass';
        if (MODE_PLAN_RE.test(text)) return 'plan';
        if (MODE_ACCEPT_RE.test(text)) return 'accept';
      }
    } catch {}
    return 'default';
  }

  // Read the headless terminal for the current spinner status and emit
  // a `claude-status` event ONLY when the structured status changes.
  // Pulled out of _checkMenu so onData can drive its own (much shorter)
  // throttle without dragging menu detection along — see _statusThrottle.
  // Pass the structured object; the WS forwarder still surfaces the
  // legacy `text` field for older clients.
  _emitStatusIfChanged() {
    if (!this.headless) return;
    const status = this._extractStatus();
    const statusKey = status ? JSON.stringify(status) : null;
    if (statusKey !== this._lastStatusKey) {
      this._lastStatusKey = statusKey;
      this._lastStatus = status;          // back-compat for attach-time replay
      this.emit('claude-status', status);
    }
  }

  _checkMenu() {
    this._menuDebounce = null;
    if (!this.headless) return;
    // Safety net: the periodic 750ms scan still drives a status check
    // for the case where no data is flowing (claude paused, status line
    // updated by a tick somewhere we can't observe directly).
    this._emitStatusIfChanged();
    // Mode-transition detection — owner-facing autoAcceptToggleBytes
    // logic still drives the Shift+Tab cycle elsewhere; this is an
    // additive observation channel so viewers see the same mode-pill
    // narrative the JSONL replay produces, but ~750ms after the PTY
    // shows it (vs minutes for the JSONL flush). First scan
    // ESTABLISHES baseline without emitting — no fictitious "entered
    // default" pill on every reconnect.
    const mode = this._extractMode();
    if (this._lastMode == null) {
      this._lastMode = mode;
    } else if (mode !== this._lastMode) {
      const from = this._lastMode;
      this._lastMode = mode;
      this.emit('mode-change', { from, to: mode, ts: new Date().toISOString() });
    }
    const change = this.menuInterceptor.detectChange(this.headless);
    // Debug: when MYCO_MENU_DEBUG=1, dump the headless visible text on
    // every detectChange call so we can correlate what the scanner sees
    // with what claude is actually rendering. Throttled to one dump per
    // 3s per session to keep logs readable.
    if (process.env.MYCO_MENU_DEBUG === '1') {
      const now = Date.now();
      if (!this._lastMenuDump || now - this._lastMenuDump > 3000) {
        this._lastMenuDump = now;
        let snap = '';
        try { snap = this.getVisibleText().slice(-1200); } catch (e) { snap = `(getVisibleText threw: ${e.message})`; }
        const tag = change ? change.kind : 'noChange';
        console.log(`[menu-debug] ${this.sessionId} scan=${tag} headless tail:\n${snap}\n[menu-debug end]`);
      }
    }
    if (!change) return;
    if (change.kind === 'newMenu' || change.kind === 'cleared') {
      // Stamp any prior unanswered menu rows as superseded before
      // broadcasting the new one (or clearing). The chat-pane picker
      // collapses superseded rows to a one-line resolved card (see
      // isResolvedMenu in app.js) so old buttons can't be clicked
      // against a dialog claude has already advanced past.
      _supersedeStaleMenus(this.sessionId);
    }
    if (change.kind === 'newMenu') {
      this.pendingMenu = change.menu;
      this.emit('menu', change.menu);
    } else if (change.kind === 'cleared') {
      this.pendingMenu = null;
      this.emit('menu-cleared');
    }
  }

  _push(data) {
    this.buffer.push(data);
    this.bufferSize += data.length;
    while (this.bufferSize > MAX_BUFFER && this.buffer.length > 1) {
      const removed = this.buffer.shift();
      this.bufferSize -= removed.length;
    }
  }

  write(data) {
    if (this.alive) this.pty.write(data);
  }

  resize(cols, rows) {
    if (!this.alive) return;
    try {
      this.pty.resize(cols, rows);
      this.cols = cols;
      this.rows = rows;
      try { this.headless.resize(cols, rows); } catch {}
      this.emit('resize', { cols, rows });
    } catch {}
  }

  // Read the headless terminal's currently-visible screen as plain text.
  // One line per row of the active buffer (alt-screen-aware), trailing
  // whitespace stripped per row, blank rows preserved up to the last
  // non-empty one (so a "Y/n" prompt with empty rows below it doesn't
  // grow into pages of blank space).
  getVisibleText() {
    const buf = this.headless.buffer.active;
    const rows = this.headless.rows;
    const lines = [];
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (!line) { lines.push(''); continue; }
      lines.push(line.translateToString(true).replace(/\s+$/, ''));
    }
    // Trim trailing blank rows for compactness.
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    return lines.join('\n');
  }

  // Walk a batch of transcript-delta messages and update openToolCalls.
  // Each WS attach spins up its own transcript watcher, so the same
  // batch can arrive multiple times — `_seenToolMsgUuids` dedups by the
  // parsed message uuid so we update the map (and emit) at most once
  // per message. Assistant frames with `toolCalls` insert; tool_result
  // user frames delete. Emits a `state-update { kind: 'tool-progress' }`
  // when anything changed; idempotent if not.
  ingestTranscriptForToolProgress(messages) {
    if (!Array.isArray(messages) || !messages.length) return;
    let changed = false;
    for (const m of messages) {
      if (!m || !m.uuid) continue;
      if (this._seenToolMsgUuids.has(m.uuid)) continue;
      this._seenToolMsgUuids.add(m.uuid);
      if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          if (!tc || !tc.id) continue;
          if (this.openToolCalls.has(tc.id)) continue;
          this.openToolCalls.set(tc.id, {
            name: tc.name || 'tool',
            summary: (tc.summary || '').slice(0, 200),
            ts: m.ts || new Date().toISOString(),
          });
          changed = true;
        }
      } else if (m.role === 'tool_result' && Array.isArray(m.results)) {
        for (const r of m.results) {
          if (!r || !r.toolUseId) continue;
          if (this.openToolCalls.delete(r.toolUseId)) changed = true;
        }
      }
    }
    if (changed) this._emitToolProgress();
  }

  _emitToolProgress() {
    const now = Date.now();
    const open = [];
    for (const [id, info] of this.openToolCalls) {
      open.push({
        id,
        name: info.name,
        summary: info.summary,
        sinceMs: Math.max(0, now - new Date(info.ts).getTime()),
      });
    }
    this.emit('state-update', { kind: 'tool-progress', open });
  }

  kill() {
    if (this.alive) {
      try { this.pty.kill(); } catch {}
      this.alive = false;
    }
    try { this.headless.dispose(); } catch {}
    this.headless = null;
    this.buffer = [];
    this.bufferSize = 0;
    this.openToolCalls.clear();
    this._seenToolMsgUuids.clear();
    this.removeAllListeners();
  }
}

const sessions = new Map(); // sessionId -> PtySession

function buildClaudeArgs({ resumeId } = {}) {
  // --permission-mode acceptEdits sets Claude's mode at spawn time so file
  // edits go through unattended (Bash and other tool permissions still flow
  // through our menu interceptor / per-session allow list). Doing it at
  // spawn replaces the old runtime Shift+Tab auto-toggle which relied on
  // pattern-matching banner text in the headless terminal and could land
  // in the wrong mode if Claude's UI strings drifted or a frame was
  // mid-render. State is correct by construction now.
  //
  // (--dangerously-skip-permissions is rejected when running as root, which
  // is our container user. acceptEdits has no such restriction.)
  const args = ['--permission-mode', 'acceptEdits'];
  if (resumeId) args.push('--resume', resumeId);
  return args;
}

function spawnClaude(sessionId, { cwd, resumeId, cols = 120, rows = 30 }) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);
  const args = buildClaudeArgs({ resumeId });
  const proc = pty.spawn('claude', args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      TERM_PROGRAM: 'vscode',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'C.UTF-8',
    },
  });
  const wrapped = new PtySession(sessionId, proc);
  sessions.set(sessionId, wrapped);
  wrapped.on('menu', (menu) => menuMod.handleSessionMenu(sessionId, wrapped, menu));
  wrapped.on('exit', () => {
    setTimeout(() => {
      const cur = sessions.get(sessionId);
      if (cur === wrapped) sessions.delete(sessionId);
    }, 250);
  });
  return wrapped;
}

function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

function killSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) { s.kill(); sessions.delete(sessionId); }
}

// Handle a `{t:'menu-pick', n, hash?}` frame from the client — the
// inline-callout alternative to typing `/decide N` in chat.
//
// Two effects, independently gated:
//
//   (A) PERSIST the answered state on the corresponding chat message
//       in rec.chat so a page refresh / WS reconnect / future
//       container restart all keep the picker disabled. When the
//       client provides `hash`, the row is located by that exact menu
//       identity — preventing rapid-dialog-turnover races where
//       multiple menus were broadcast and the user clicks an older one.
//       Falls back to "latest unanswered" for back-compat with clients
//       that haven't been upgraded yet.
//
//   (B) PTY WRITE the digit + \r to send the pick into the live
//       Claude session. Gated on (session alive AND session.pendingMenu
//       still matches the hash). If the dialog claude is currently
//       showing isn't the one the user clicked (claude already moved
//       on to a new menu), DROP the PTY write — landing the digit on
//       the wrong menu would silently answer the wrong question.
//
// Back-compat: when `hash` is omitted (older client), only `pendingMenu
// .options` is consulted (the original behaviour). New clients always
// send the hash and get the race-free path.
function handleMenuPick(sessionId, session, n, hash) {
  if (!Number.isFinite(n) || n < 1 || n > 9) return;
  _markMenuChatAnswered(sessionId, n, hash);
  if (!session || !session.alive) return;
  const pending = session.pendingMenu;
  if (!pending || !Array.isArray(pending.options)) return;
  // Reject the PTY write if the click targeted a menu that is no
  // longer the one claude is showing — the digit would land on a
  // different question.
  if (hash && pending.hash && pending.hash !== hash) {
    // Find where the two hashes diverge so we can tell whether the
    // mismatch is the question, the option labels, or trailing chars.
    let div = 0;
    while (div < hash.length && div < pending.hash.length && hash[div] === pending.hash[div]) div++;
    console.log(`[menu-pick] ${sessionId} dropped pick n=${n} — stale (diverge@${div} clickedLen=${hash.length} pendingLen=${pending.hash.length})`);
    console.log(`[menu-pick]   clicked: ${JSON.stringify(hash)}`);
    console.log(`[menu-pick]   pending: ${JSON.stringify(pending.hash)}`);
    return;
  }
  if (!pending.options.some((o) => o.n === n)) return;
  // Plan-mode interview wizard auto-advances on a bare digit — the
  // digit selects + commits + moves to the next question in one event.
  // Sending `digit + "\r"` was harmless on the FIRST screen (the CR
  // was consumed as the commit), but the WIZARD ALREADY ADVANCED on
  // the digit alone, so the trailing CR landed on the NEXT screen and
  // pressed whatever sat under the default cursor. Symptoms observed
  // on mycobeta demo010 (2026-05-13):
  //
  //   • Q1 (Framework) "2\r" → "2" picks Flask + advances to Q2.
  //     "\r" then advanced past Q2 (Database) entirely — Q2 was never
  //     broadcast to chat, breadcrumb showed it as ☐ unanswered.
  //   • Q4 (Deployment) "3\r" → "3" picks Serverless + advances to
  //     the Submit tab. "\r" landed on the Submit tab's default cursor
  //     position (Cancel) → wizard returned "user rejected".
  //
  // Detection by WIZARD_TAB_BAR_RE in the viewport. BUT — the wizard
  // has two rendering variants:
  //
  //   SIMPLE  → digit auto-commits + advances; CR LEAKS. Send bare digit.
  //   RICH    → digit moves cursor, Enter commits + advances. Send "n\r".
  //
  // Detected by the rich variant's distinctive footer (the "n to add
  // notes" / "Tab to switch questions" affordances are unique to it).
  // Non-wizard dialogs (trust prompt, permission prompt, plan-confirm)
  // all still need CR. Verified on mycobeta demo010 (2026-05-13):
  // simple wizard's "2\r" skipped Database; rich wizard's bare "1"
  // moved cursor but never committed.
  const wizardInfo = _detectWizard(session);
  const useCr = !wizardInfo.simple;     // true when no wizard OR rich wizard
  const bytes = useCr ? String(n) + '\r' : String(n);
  session.write(bytes);
  console.log(`[menu-pick] ${sessionId} wrote ${JSON.stringify(bytes)} wizard=${wizardInfo.kind}`);
  session.pendingMenu = null;
}

// Classify the current dialog into one of:
//
//   { kind: 'none',   simple: false }  — no wizard on screen, send digit+CR
//   { kind: 'simple', simple: true  }  — wizard tab bar present, NO rich footer,
//                                         send bare digit (R-02)
//   { kind: 'rich',   simple: false }  — wizard tab bar present AND rich
//                                         footer ("n to add notes" / "Tab to
//                                         switch questions"); send digit+CR
//                                         because Enter is needed to commit.
function _detectWizard(session) {
  if (!session || !session.headless || !session.headless.buffer) {
    return { kind: 'none', simple: false };
  }
  let tabBar = false, richFooter = false;
  try {
    const buf = session.headless.buffer.active;
    const rows = session.headless.rows;
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (!line) continue;
      const txt = line.translateToString(true);
      if (!tabBar && WIZARD_TAB_BAR_RE.test(txt)) tabBar = true;
      if (!richFooter && WIZARD_RICH_FOOTER_RE.test(txt)) richFooter = true;
      if (tabBar && richFooter) break;
    }
  } catch {}
  if (!tabBar) return { kind: 'none', simple: false };
  if (richFooter) return { kind: 'rich', simple: false };
  return { kind: 'simple', simple: true };
}

// Back-compat alias: _isWizardActive returns a boolean for callers that
// just need a single yes/no. The richer state comes from _detectWizard.
function _isWizardActive(session) { return _detectWizard(session).kind !== 'none'; }

// Multi-select half of menu-pick: TOGGLE one checkbox without submitting.
// Claude code's multi-select dialog responds to a bare digit (no CR) by
// flipping checkbox <n>'s state. We persist the toggle on the chat row
// so a refresh / reconnect shows the updated state, and write the digit
// to the PTY so claude's TUI reflects it. Submit happens via the
// separate `menu-submit` frame (Enter alone).
//
// Stale-dialog guard mirrors handleMenuPick: if the hash no longer
// matches what claude is showing, drop the write to avoid toggling the
// wrong dialog.
function handleMenuToggle(sessionId, session, n, hash) {
  if (!Number.isFinite(n) || n < 1 || n > 9) return;
  if (!session || !session.alive) return;
  const pending = session.pendingMenu;
  if (!pending || !Array.isArray(pending.options) || !pending.multi) return;
  if (hash && pending.hash && pending.hash !== hash) {
    console.log(`[menu-toggle] ${sessionId} dropped n=${n} — stale (clicked hash=${hash.slice(0,16)} != pending=${pending.hash.slice(0,16)})`);
    return;
  }
  const opt = pending.options.find((o) => o.n === n);
  if (!opt || !opt.checkbox) return;
  // Persist the new checked state on the chat row so reconnects see
  // the most recent UI. The hash stays constant across toggles (see
  // hashMenu — it excludes checked state on purpose).
  //
  // Critical: _toggleMenuChatCheckbox already flips opt.checked on the
  // persisted record, and the persisted record + this pending menu
  // hold the SAME option object reference (broadcastMenuToChat doesn't
  // clone — appendChatMessage pushes the object as-is). Doing
  // `opt.checked = !opt.checked` here used to double-flip, net zero,
  // so the chat picker's checkbox UI never reflected the user's clicks
  // and the menu-multi diagnostic always logged the initial state.
  // Verified 2026-05-13 on mycobeta demo010 — every toggle log line
  // said "unchecked" even when the user was checking. Just persist.
  _toggleMenuChatCheckbox(sessionId, n, hash);
  // Drive the actual TUI toggle — bare digit, no CR.
  session.write(String(n));
  console.log(`[menu-toggle] ${sessionId} toggled n=${n} → ${opt.checked ? 'checked' : 'unchecked'}`);
}

// Multi-select half of menu-pick: SUBMIT the current checkbox set.
//
// Claude's multi-select dialog ships with a separate "Submit" navigable
// row below the numbered options (visible as the indented "Submit"
// sub-line under the last option). Plain Enter on the current cursor
// position just operates on whatever the cursor's sitting on — it does
// NOT finalize the selection. To submit, the user normally arrow-downs
// onto the Submit row and hits Enter.
//
// Earlier we over-sent 12 down-arrows in one PTY write hoping the
// cursor would clamp at the bottom. That apparently wrapped (cursor
// landed back on option 1) and the trailing Enter submitted option 1
// only. Two fixes here:
//
//   1. PRECISE row count from the headless terminal — find the `❯`
//      cursor row and the "Submit" row, send exactly (submit - cursor)
//      down-arrows. No overshoot, no wrap risk.
//   2. PACED arrows — emit one key every 30ms so claude's TUI
//      processes each as a separate input event. The rapid 12-byte
//      burst from the earlier version may have been read as a single
//      event by claude's input loop (some Ink builds debounce
//      consecutive arrow keys), so only one navigation step actually
//      registered.
//
// If the headless lookup can't find either row, fall back to a small
// fixed count (6) — much safer than the original 12, and still enough
// for a dialog with 4-5 numbered options + Submit.
//
// Cursor + Submit recognition lives in pty-patterns.js
// (MULTI_SELECT_CURSOR_RE / SUBMIT_ROW_RE) so claude code's TUI
// shifts only need patching in one place. Both regexes are STRICT
// on purpose:
//
//   - MULTI_SELECT_CURSOR_RE requires `❯` on a line that ALSO carries
//     a `[ ]`/`[x]` checkbox. Earlier we just looked for the first
//     `❯` anywhere in the viewport, which latched onto the breadcrumb
//     tab bar's selection cursor when the wizard's step pointer was
//     painted (e.g. "←  ☒ Feature ❯ ☐ Stack  →") — inflating cursor→
//     Submit by 10+ rows and overshooting the burst.
//
//   - SUBMIT_ROW_RE requires the line to be ONLY "Submit" (with
//     whitespace), so a footer hint like "Enter to submit" doesn't
//     win the "last match" race and push submitRow past the real one.
//
// Falls back to the FIRST `❯` (legacy behavior) if no checkbox-cursor
// line is found — covers exotic layouts where the cursor lands on a
// non-checkbox row (e.g. on Submit itself, in which case navCount = 0
// and we just hit Enter).
const ARROW_DOWN = '\x1b[B';
// Diagnostic dump for the cursor→Submit nav calculation. Off by
// default; flip MYCO_MENU_SUBMIT_DEBUG=1 in the container env (or set
// it in the deploy config) to capture every parse step the next time
// the user reports a "moved past Next / past last selection" failure.
// Logs include each scanned row + its classification (cursor / option
// / submit / other) so the user can paste a snippet back and we can
// see exactly what claude rendered.
const MENU_SUBMIT_DEBUG = process.env.MYCO_MENU_SUBMIT_DEBUG === '1';

function _findSubmitNavCount(session) {
  if (!session.headless || !session.headless.buffer) return 6;
  try {
    const buf = session.headless.buffer.active;
    const rows = session.headless.rows;
    let cursorRow = -1, fallbackCursorRow = -1, submitRow = -1;
    const scanned = [];                  // (row, text, tag) for debug
    for (let i = 0; i < rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (!line) continue;
      const txt = line.translateToString(true);
      let tag = '';
      if (cursorRow < 0 && MULTI_SELECT_CURSOR_RE.test(txt)) { cursorRow = i; tag = 'cursor'; }
      else if (fallbackCursorRow < 0 && txt.includes('❯')) { fallbackCursorRow = i; if (!tag) tag = 'cursor-fallback'; }
      if (SUBMIT_ROW_RE.test(txt)) { submitRow = i; tag = (tag ? tag + '+' : '') + 'submit'; }
      else if (MENU_OPT_LINE_RE.test(txt)) { tag = tag || 'option'; }
      if (MENU_SUBMIT_DEBUG && (tag || txt.trim())) {
        scanned.push({ row: i, tag, text: txt.replace(/\s+$/, '').slice(0, 100) });
      }
    }
    if (cursorRow < 0) cursorRow = fallbackCursorRow;
    if (cursorRow < 0 || submitRow <= cursorRow) {
      if (MENU_SUBMIT_DEBUG) {
        console.log(`[menu-submit-parse] ${session.sessionId} fallback=6 (cursorRow=${cursorRow} submitRow=${submitRow})`);
        for (const r of scanned) console.log(`[menu-submit-parse]   row=${r.row} tag=${r.tag || '-'} ${JSON.stringify(r.text)}`);
      }
      return 6;
    }
    // Count NAVIGABLE ITEMS between cursor (exclusive) and submit
    // (inclusive). Claude's TUI navigates option-by-option — pressing
    // ↓ skips multi-line description rows and lands on the next
    // numbered option or the submit row. A line-distance count
    // (submitRow - cursorRow) overcounts whenever an option has a
    // description row underneath it, the cursor overshoots Next, and
    // claude lands Enter on the wrong row — interpreted as decline.
    // Verified live on mycobeta demo010 (2026-05-13): the Features
    // multi-select had 9 lines from cursor to Next but only 5 nav
    // steps (options 2,3,4,5 + Next).
    let items = 0;
    for (let i = cursorRow + 1; i <= submitRow; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (!line) continue;
      const txt = line.translateToString(true);
      if (MENU_OPT_LINE_RE.test(txt) || SUBMIT_ROW_RE.test(txt)) items++;
    }
    const navCount = Math.min(20, items || 6);
    if (MENU_SUBMIT_DEBUG) {
      console.log(`[menu-submit-parse] ${session.sessionId} cursorRow=${cursorRow} submitRow=${submitRow} items=${items} navCount=${navCount}`);
      for (const r of scanned) console.log(`[menu-submit-parse]   row=${r.row} tag=${r.tag || '-'} ${JSON.stringify(r.text)}`);
    }
    return navCount;
  } catch (err) {
    if (MENU_SUBMIT_DEBUG) console.log(`[menu-submit-parse] ${session.sessionId} threw: ${err.message}`);
    return 6;
  }
}
function handleMenuSubmit(sessionId, session, hash) {
  if (!session || !session.alive) return;
  const pending = session.pendingMenu;
  if (!pending || !pending.multi) return;
  if (hash && pending.hash && pending.hash !== hash) {
    console.log(`[menu-submit] ${sessionId} dropped — stale (clicked hash=${hash.slice(0,16)} != pending=${pending.hash.slice(0,16)})`);
    return;
  }
  _markMenuChatAnswered(sessionId, 0, hash, /*submit*/ true);
  const navCount = _findSubmitNavCount(session);
  console.log(`[menu-submit] ${sessionId} navigating ${navCount} rows then CR`);
  // Send each arrow as a separate write spaced ~30ms apart, then Enter
  // after a slightly longer pause. The pause budget caps at ~30*navCount
  // + 80 ms (<800ms for navCount=20), well below any reasonable user-
  // perceived wait, while giving claude's TUI time to advance the cursor
  // between each event.
  let i = 0;
  function tick() {
    if (!session.alive) return;
    if (i < navCount) {
      session.write(ARROW_DOWN);
      i++;
      setTimeout(tick, 30);
    } else {
      setTimeout(() => {
        if (session && session.alive) session.write('\r');
        session.pendingMenu = null;
        console.log(`[menu-submit] ${sessionId} CR sent`);
      }, 80);
    }
  }
  tick();
}

// Mirror assistant text from the transcript stream into rec.chat so
// the chat pane survives a refresh / new tab / readonly attach.
//
// Without this, _postClaudeStreamToChat on the client posted claude's
// reply as `_localOnly: true` — visible in the live tab but absent
// from rec.chat on disk. On reload the chat-history WS frame returned
// only user messages + menu callouts, so claude's responses appeared
// to vanish.
//
// Idempotent via meta.transcriptUuid: each jsonl entry has a stable
// `uuid`, so even with multiple WS connections persisting the same
// stream (owner + viewer + reconnects) the row only lands once. Emits
// a 'chat' event so already-connected clients get the row pushed
// live too (the per-WS 'chat' subscription handles broadcast).
function persistAssistantTextToChat(sessionId, newMsgs) {
  if (!Array.isArray(newMsgs) || !newMsgs.length) return;
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return;
  if (!Array.isArray(rec.chat)) rec.chat = [];
  const seen = new Set();
  for (const c of rec.chat) {
    if (c && c.meta && c.meta.transcriptUuid) seen.add(c.meta.transcriptUuid);
  }
  const session = sessions.get(sessionId);
  let mirrored = 0, skipped = 0;
  for (const m of newMsgs) {
    if (!m || m.role !== 'assistant') continue;
    if (!m.text || !m.text.trim()) { skipped++; continue; }
    if (!m.uuid) { skipped++; continue; }      // no stable dedup key → skip
    if (seen.has(m.uuid)) { skipped++; continue; }
    seen.add(m.uuid);
    const reply = {
      user: 'claude',
      text: m.text.trim(),
      ts: m.ts || new Date().toISOString(),
      meta: { transcriptUuid: m.uuid, fromTranscript: true },
    };
    sessionsMod.appendChatMessage(sessionId, reply);
    let listenerCount = 0;
    if (session) {
      // EventEmitter.listenerCount tells us how many WS-attach handlers
      // are currently subscribed. If this is 0, no client receives the
      // live update — they'll only see the row after a chat-history
      // replay on next attach. Surfaces the silent-broadcast case the
      // user reported on mycobeta demo010 (2026-05-13): plan response
      // showed in the transcript view but not the chat sidebar.
      listenerCount = session.listenerCount('chat');
      session.emit('chat', reply);
    }
    console.log(`[persist-chat-emit] ${sessionId} uuid=${String(m.uuid).slice(0, 8)} listeners=${listenerCount} textLen=${reply.text.length}`);
    mirrored++;
  }
  // Diagnostic — counts how many assistant-text messages were mirrored
  // into rec.chat vs skipped (dedup hit, empty text, no uuid). The user
  // reported plan-mode output not showing in the chat sidebar even
  // though the row IS in rec.chat; this log line lets us correlate the
  // server's persist activity with client-side visibility on the next
  // repro. Quiet on no-op calls.
  if (mirrored > 0) {
    console.log(`[persist-chat] ${sessionId} mirrored=${mirrored} skipped=${skipped} (rec.chat now ${rec.chat.length})`);
  }
}

// Stamp answered + pickedN onto a menu-broadcast chat message. When
// `hash` is provided, find the row whose `meta.menu.hash` equals it
// (race-free across multiple unanswered menus). When omitted, fall
// back to "latest unanswered" for back-compat with older clients.
//
// For multi-select submit: pass submit=true with n=0. The row is
// stamped answered=true with no pickedN — the chat picker reads the
// per-option `checked` flags on the persisted menu to render the
// "✓ Submitted with [a, c]" summary line.
function _markMenuChatAnswered(sessionId, n, hash, submit) {
  if (!sessionId) return;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    if (!rec || !Array.isArray(rec.chat)) return;
    for (let i = rec.chat.length - 1; i >= 0; i--) {
      const m = rec.chat[i];
      if (!m || !m.meta || m.meta.kind !== 'menu') continue;
      if (hash) {
        const mh = m.meta.menu && m.meta.menu.hash;
        if (mh !== hash) continue;          // wrong row, keep searching
        if (m.meta.answered) return;        // already marked
      } else {
        if (m.meta.answered) return;        // latest is already answered → done
      }
      if (!submit) {
        const opts = (m.meta.menu && m.meta.menu.options) || [];
        if (!opts.some((o) => o.n === n)) return;   // n not valid for this menu
        m.meta.pickedN = n;
      } else {
        m.meta.submitted = true;
      }
      m.meta.answered = true;
      sessionsMod.saveStore();
      // Push the meta change to every attached client so concurrent
      // viewers see the picker collapse to a resolved card immediately
      // — pre-fix the answered stamp was only visible after reconnect.
      _emitMenuStateUpdate(sessionId, m);
      console.log(`[menu-pick] ${sessionId} stamped answered=true ${submit ? 'submitted' : `pickedN=${n}`}${hash ? ' (byHash)' : ''}`);
      return;
    }
  } catch (err) {
    console.error(`[menu-pick] persist failed for ${sessionId}: ${err.message}`);
  }
}

// Walk the chat history and stamp every unanswered, unsuperseded menu
// row with meta.superseded = true. Called when claude advances the TUI
// past a menu without the user picking (MenuInterceptor returns
// `newMenu` for a replacement, or `cleared` when the dialog disappears).
// Each stamped row gets a state-update emit so concurrent viewers
// collapse the picker to a one-line resolved card — pre-fix, the
// stale picker stayed live and the hash-guard silently dropped any
// click as a no-op.
function _supersedeStaleMenus(sessionId) {
  if (!sessionId) return;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    if (!rec || !Array.isArray(rec.chat)) return;
    let changed = false;
    for (let i = rec.chat.length - 1; i >= 0; i--) {
      const m = rec.chat[i];
      if (!m || !m.meta || m.meta.kind !== 'menu') continue;
      if (m.meta.answered) continue;
      if (m.meta.superseded) continue;
      m.meta.superseded = true;
      changed = true;
      _emitMenuStateUpdate(sessionId, m);
    }
    if (changed) sessionsMod.saveStore();
  } catch (err) {
    console.error(`[menu-supersede] failed for ${sessionId}: ${err.message}`);
  }
}

// Push a menu row's updated meta to every attached client. The chat
// pane locates the row by transcriptUuid (the stable per-message id
// stamped at broadcast time) and re-renders that single row in place
// using the dedup-hit pattern that appendChatMessage already uses
// (web/public/app.js:1763-1771). No-op if the session isn't tracked
// (cleared / exited).
function _emitMenuStateUpdate(sessionId, m) {
  if (!m || !m.meta) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  const hash = (m.meta.menu && m.meta.menu.hash) || null;
  const listenerCount = session.listenerCount('state-update');
  console.log(`[state-update] ${sessionId} kind=menu pickedN=${m.meta.pickedN} answered=${!!m.meta.answered} superseded=${!!m.meta.superseded} listeners=${listenerCount} hash=${hash ? hash.slice(0, 60) : 'null'}`);
  session.emit('state-update', {
    kind: 'menu',
    messageUuid: m.meta.transcriptUuid || null,
    hash,
    meta: m.meta,
  });
}

// Flip the `checked` flag on option <n> of the multi-select chat row
// matching `hash`. No "answered" stamp — the row stays interactive
// until the user hits Submit. Persisted so a reconnect/refresh sees the
// most recent UI state.
function _toggleMenuChatCheckbox(sessionId, n, hash) {
  if (!sessionId) return;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    if (!rec || !Array.isArray(rec.chat)) return;
    for (let i = rec.chat.length - 1; i >= 0; i--) {
      const m = rec.chat[i];
      if (!m || !m.meta || m.meta.kind !== 'menu') continue;
      const mh = m.meta.menu && m.meta.menu.hash;
      if (hash && mh !== hash) continue;
      if (m.meta.answered) return;
      const opts = (m.meta.menu && m.meta.menu.options) || [];
      const opt = opts.find((o) => o.n === n);
      if (!opt || !opt.checkbox) return;
      opt.checked = !opt.checked;
      sessionsMod.saveStore();
      // Same broadcast as the answered stamp — viewers need to see
      // the checkbox flip without waiting for a reconnect.
      _emitMenuStateUpdate(sessionId, m);
      return;
    }
  } catch (err) {
    console.error(`[menu-toggle] persist failed for ${sessionId}: ${err.message}`);
  }
}

// Wire transcript messages from a session's JSONL file to a websocket.
// Handles the new-session race: a freshly spawned Claude takes ~5s to
// write its first JSONL line, so resolveTranscriptPath returns null on
// the initial attach. We send transcript-waiting, then poll every 2s
// until the path resolves, then stream transcript-init followed by
// transcript-delta on every appended message.
//
// Returns a cleanup function the caller wires onto ws.on('close').
// Both attachWebSocket (owner) and attachViewerWebSocket (viewer) use
// this — previously only the viewer path polled, which left owners on
// fresh sessions without any transcript stream at all.
function streamTranscriptToWs(sessionId, ws) {
  let pollTimer = null;
  let unwatch = null;
  let closed = false;
  let watchingPath = null;     // jsonl file the current watcher is bound to
  const session = sessions.get(sessionId);

  function startWatching(filePath) {
    watchingPath = filePath;
    transcriptMod.readNewMessages(filePath, 0).then(({ messages, bytesRead }) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ t: 'transcript-init', messages, bytes: bytesRead }));
      // First-time backfill: mirror any assistant text already in the
      // jsonl into rec.chat. This catches messages claude produced
      // BEFORE any client was attached. Idempotent via uuid dedup.
      persistAssistantTextToChat(sessionId, messages);
      // Drive the session's in-flight tool-call tracker from the same
      // batch. Dedups internally by message uuid, so multiple watchers
      // (one per attached WS) firing on the same JSONL append don't
      // double-count.
      if (session) session.ingestTranscriptForToolProgress(messages);
      // Hand bytesRead to watchTranscript so its watcher starts from where
      // we left off, not from byte 0. Without this, the watcher's own
      // initial-read would replay the entire transcript a second time as
      // transcript-delta frames, doubling every message on the client.
      unwatch = transcriptMod.watchTranscript(filePath, (newMsgs) => {
        if (!closed && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ t: 'transcript-delta', messages: newMsgs }));
        }
        // Mirror claude's text into rec.chat so it survives a refresh /
        // new tab / readonly attach. Without this, _postClaudeStreamToChat
        // on the client adds `_localOnly: true` rows that never reach
        // disk, leaving the chat pane blank on reload.
        persistAssistantTextToChat(sessionId, newMsgs);
        if (session) session.ingestTranscriptForToolProgress(newMsgs);
      }, { startByte: bytesRead });
    }).catch(() => {});
  }

  const initialPath = transcriptMod.resolveTranscriptPath(sessionId);
  if (initialPath) {
    startWatching(initialPath);
  } else {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'transcript-waiting' }));
  }

  // Re-resolve the live JSONL every 3s. Claude code re-execs into a
  // new sessionId (and a new <newId>.jsonl) any time the user invokes
  // /resume in the TUI — at which point the existing watcher is
  // pinned to the stale file and misses every assistant reply going
  // forward. The watcher itself can't follow because fs.watch is
  // file-bound. This poll detects the path change, tears down the
  // stale watcher, and starts a fresh one on the new file. Until the
  // first path resolves (new-session race), the same poll picks it
  // up — replacing the older 2s `pollTimer` startup-only loop with a
  // single unified path-tracking interval. Verified on mycobeta
  // demo010 (2026-05-13): user's plan reply landed in
  // 887750c4-….jsonl after the attach watcher had been bound to an
  // earlier 49d7d4da-….jsonl; without this poll, chat sidebar and
  // transcript view stayed empty for the whole new session.
  pollTimer = setInterval(() => {
    if (closed || ws.readyState !== ws.OPEN) {
      clearInterval(pollTimer); pollTimer = null; return;
    }
    const p = transcriptMod.resolveTranscriptPath(sessionId);
    if (!p || p === watchingPath) return;
    // Path changed (or first appeared). Rebind.
    console.log(`[transcript-rebind] ${sessionId} ${watchingPath || '(none)'} -> ${p}`);
    if (unwatch) { try { unwatch(); } catch {} unwatch = null; }
    startWatching(p);
  }, 3000);

  return function cleanup() {
    closed = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (unwatch) { try { unwatch(); } catch {} unwatch = null; }
  };
}

function attachWebSocket(session, ws, opts = {}) {
  const readOnly = !!opts.readOnly;
  const user = opts.user || null;
  const sessionId = session.sessionId;

  // Replay ring buffer first so reconnects see prior context.
  const replay = Buffer.concat(session.buffer.map((d) => Buffer.from(d, 'utf8')));
  if (replay.length) {
    ws.send(JSON.stringify({ t: 'output', data: replay.toString('base64') }));
  }

  // Replay chat history so a returning client sees the discussion.
  const history = sessionsMod.getChatHistory(sessionId);
  if (history.length) {
    ws.send(JSON.stringify({ t: 'chat-history', messages: history }));
  }
  // Bootstrap PTY-derived state so a fresh / reconnecting client lands at
  // full parity without waiting for the next emit. See the chat-pane
  // sync plan: status/mode/artifacts all need an attach-time snapshot,
  // otherwise viewers can sit on stale state indefinitely on a steady-
  // state PTY (no `claude-status` / `mode-change` emit fires unless a
  // value CHANGES).
  _sendAttachSnapshot(session, ws);

  // Owners also receive the structured transcript so they can flip to a
  // "preview as viewer" mode in the UI without re-fetching. The helper
  // handles the new-session race (JSONL not yet written).
  const stopTranscript = streamTranscriptToWs(sessionId, ws);

  const onData = (data) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'output', data: Buffer.from(data, 'utf8').toString('base64') }));
  };
  const onExit = (code) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'exit', code }));
  };
  const onChat = (message) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'chat', message }));
  };
  // claude-status emits the STRUCTURED `_extractStatus()` payload
  // (object or null). Legacy `text` field is preserved on the WS
  // frame so older clients keep working; new clients read `status`
  // for the chip render (token trailer, interrupt badge, effort,
  // duration). Null status means "no spinner on screen" — both
  // fields go null and the client clears its status strip.
  const onStatus = (status) => {
    if (ws.readyState !== ws.OPEN) return;
    const text = status && status.text ? status.text : null;
    ws.send(JSON.stringify({ t: 'claude-status', text, status }));
  };
  const onModeChange = (change) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'mode-change', ...change }));
  };
  // state-update carries any state mutation that needs to push to every
  // attached client (menu meta change, artifact replace, tool-progress
  // update). The kind discriminator routes it on the client side.
  const onStateUpdate = (payload) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ t: 'state-update', ...payload }));
  };
  session.on('data', onData);
  session.on('exit', onExit);
  session.on('chat', onChat);
  session.on('claude-status', onStatus);
  session.on('mode-change', onModeChange);
  session.on('state-update', onStateUpdate);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    // Liveness probe — clients send this on visibility-visible to detect a
    // silently-dead WS (mobile background suspension, NAT timeout). Allowed
    // for read-only viewers too; pong reveals nothing they couldn't infer.
    if (msg.t === 'ping') {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'pong' }));
      return;
    }
    if (msg.t === 'chat' && typeof msg.text === 'string') {
      // Read-only / unauthenticated viewers can read chat but not post.
      if (readOnly || !user) return;
      const text = msg.text.trim();
      if (!text) return;
      handleChatMessage(sessionId, session, user, text.slice(0, CHAT_TEXT_LIMIT));
      return;
    }
    if (msg.t === 'menu-pick' && Number.isFinite(msg.n)) {
      // Inline reply to a pending TUI menu — bypasses chat entirely so the
      // user's click on a callout button doesn't pollute the discussion
      // with `/decide N` messages. See handleMenuPick for the gating.
      // The optional `hash` ties the pick to the specific menu that
      // was displayed when the user clicked (race-free across rapid
      // dialog turnover).
      if (user) handleMenuPick(sessionId, session, msg.n | 0, typeof msg.hash === 'string' ? msg.hash : null);
      return;
    }
    if (msg.t === 'menu-toggle' && Number.isFinite(msg.n)) {
      // Multi-select toggle — writes a bare digit (no CR) to flip one
      // checkbox. Hash gates the same race protection as menu-pick.
      if (user) handleMenuToggle(sessionId, session, msg.n | 0, typeof msg.hash === 'string' ? msg.hash : null);
      return;
    }
    if (msg.t === 'menu-submit') {
      // Multi-select submit — Enter only. Sends the currently-checked set
      // as the dialog answer.
      if (user) handleMenuSubmit(sessionId, session, typeof msg.hash === 'string' ? msg.hash : null);
      return;
    }
    if (readOnly) return; // share-link viewers can watch but not type / resize
    if (msg.t === 'input' && typeof msg.data === 'string') {
      session.write(Buffer.from(msg.data, 'base64').toString('utf8'));
    } else if (msg.t === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
      session.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    session.off('data', onData);
    session.off('exit', onExit);
    session.off('chat', onChat);
    session.off('claude-status', onStatus);
    session.off('mode-change', onModeChange);
    session.off('state-update', onStateUpdate);
    stopTranscript();
  });
}

// Send the PTY-derived state snapshot to a freshly-attached WS. Used
// for BOTH attachWebSocket (owner) and attachViewerWebSocket. Lets
// every chat-pane / readonly view land at parity with the live PTY
// without waiting for the next on-change emit.
//
// Frame order matches the live channels so the client's existing
// handlers can replay them transparently:
//   1. claude-status — spinner + token chips + interrupt badge. Always
//      sent; status===null means "PTY idle, clear the strip."
//   2. mode-snapshot — current plan/accept/bypass/default mode. The
//      live `mode-change` event only fires on transition, so without
//      this snapshot a viewer reconnecting in steady-state never sees
//      a pill until the next Shift+Tab.
//   3. artifacts-init — full plan/test/arch artifacts so the artifact
//      tabs are instant on switch + always in sync. Read priority is
//      <project>/_myco_/<type>.<ext> (canonical, shared via git) then
//      in-memory rec.artifacts as fallback — same priority the GET
//      /artifact route uses (artifacts.js).
function _sendAttachSnapshot(session, ws) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    const status = session._lastStatus || null;
    const text = status && status.text ? status.text : null;
    ws.send(JSON.stringify({ t: 'claude-status', text, status }));
  } catch {}
  try {
    ws.send(JSON.stringify({ t: 'mode-snapshot', mode: session._lastMode || 'default' }));
  } catch {}
  try {
    const sessionId = session.sessionId;
    const rec = sessionsMod.getSessionRecord(sessionId);
    if (!rec) return;
    const artifacts = {};
    for (const type of ['plan', 'test', 'arch']) {
      // On-disk wins (committed _myco_/<type>.<ext>); fall back to the
      // in-memory rec.artifacts[type] when no project root is resolved
      // (e.g. session.absCwd doesn't contain a .git/).
      const fromFile = getArtifactsMod().__test.readArtifactFromFile(rec, type);
      const inMem = rec.artifacts && rec.artifacts[type];
      const picked = fromFile || inMem || null;
      if (picked) artifacts[type] = picked;
    }
    ws.send(JSON.stringify({ t: 'artifacts-init', artifacts }));
  } catch (err) {
    console.error(`[attach-snapshot] artifacts-init failed: ${err.message}`);
  }
  // Tool-progress snapshot: the in-flight tool list at the moment the
  // client connects. Sent as a state-update (same kind the live stream
  // uses) so the client handler is one path. Idempotent — re-sending
  // when the list hasn't changed just produces a redundant render.
  try {
    if (session.openToolCalls && session.openToolCalls.size >= 0) {
      const now = Date.now();
      const open = [];
      for (const [id, info] of session.openToolCalls) {
        open.push({
          id,
          name: info.name,
          summary: info.summary,
          sinceMs: Math.max(0, now - new Date(info.ts).getTime()),
        });
      }
      ws.send(JSON.stringify({ t: 'state-update', kind: 'tool-progress', open }));
    }
  } catch {}
}

function attachViewerWebSocket(session, ws, opts = {}) {
  const user = opts.user || null;
  const sessionId = session.sessionId;

  // Chat relay (same as owner connection)
  const history = sessionsMod.getChatHistory(sessionId);
  if (history.length) {
    ws.send(JSON.stringify({ t: 'chat-history', messages: history }));
  }
  // Bootstrap PTY-derived state — see _sendAttachSnapshot for rationale.
  _sendAttachSnapshot(session, ws);

  const onChat = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'chat', message }));
  };
  // Mirror the owner-attach status frame shape: object payload, both
  // `text` and `status` populated. Viewer renders chips off `status`,
  // legacy fallback to `text`.
  const onStatus = (status) => {
    if (ws.readyState !== ws.OPEN) return;
    const text = status && status.text ? status.text : null;
    ws.send(JSON.stringify({ t: 'claude-status', text, status }));
  };
  const onModeChange = (change) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'mode-change', ...change }));
  };
  const onStateUpdate = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'state-update', ...payload }));
  };
  session.on('chat', onChat);
  session.on('claude-status', onStatus);
  session.on('mode-change', onModeChange);
  session.on('state-update', onStateUpdate);

  // viewer-mode includes the owner login so the client can render a
  // "Read-only — owned by @kkrazy" badge above the transcript.
  const ownerLogin = sessionsMod.getSessionRecord(sessionId)?.user || null;
  ws.send(JSON.stringify({ t: 'viewer-mode', owner: ownerLogin }));

  // Note: the live PTY snapshot panel was removed at user request — viewers
  // see only the structured transcript below. The server still runs every
  // PTY byte through a headless xterm (PtySession.headless) for auto-mode
  // detection in handleChatPostfixes, but no per-snapshot WS frames are
  // sent to viewers.

  // Stream structured transcript via the shared helper — handles the
  // new-session race where the JSONL file doesn't exist yet.
  const stopTranscript = streamTranscriptToWs(sessionId, ws);

  function handleViewerInbound(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'ping' && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'pong' }));
    }
    if (msg.t === 'chat' && typeof msg.text === 'string' && user) {
      const text = msg.text.trim();
      // Viewers (read-only) get the same chat surface as the owner, including
      // @myco to address the running Claude session — chat is the
      // collaborative steering channel and viewers can participate.
      if (text) handleChatMessage(sessionId, session, user, text.slice(0, CHAT_TEXT_LIMIT));
    }
    if (msg.t === 'menu-pick' && Number.isFinite(msg.n) && user) {
      // Inline menu pick — same as the owner path; we keep this enabled for
      // viewers because chat steering is open to them anyway. Hash
      // forwarding is identical to the owner branch.
      handleMenuPick(sessionId, session, msg.n | 0, typeof msg.hash === 'string' ? msg.hash : null);
    }
    if (msg.t === 'menu-toggle' && Number.isFinite(msg.n) && user) {
      handleMenuToggle(sessionId, session, msg.n | 0, typeof msg.hash === 'string' ? msg.hash : null);
    }
    if (msg.t === 'menu-submit' && user) {
      handleMenuSubmit(sessionId, session, typeof msg.hash === 'string' ? msg.hash : null);
    }
  }

  ws.on('message', handleViewerInbound);
  ws.on('close', () => {
    session.off('chat', onChat);
    session.off('claude-status', onStatus);
    session.off('mode-change', onModeChange);
    session.off('state-update', onStateUpdate);
    stopTranscript();
  });
}

function handleChatMessage(sessionId, session, user, text /* opts = {} */) {
  const message = {
    user,
    text,
    ts: new Date().toISOString(),
  };
  sessionsMod.appendChatMessage(sessionId, message);
  session.emit('chat', message);

  // Don't reply to claude's own messages — would loop forever if claude's
  // response happened to end in '?'.
  if (user === ASSISTANT_USER) return;

  // `/m <body>` is a short alias for `@myco <body>`. Rewrite BEFORE the
  // slash/@myco branching below so the entire @myco pipeline (special
  // keys, menu-pick shortcuts, prose handling, alive check, …) is the
  // single source of truth. The CHAT HISTORY entry above preserves what
  // the user actually typed ("/m hi") so viewers see the original intent.
  const mAlias = text.match(/^\/m\s+([\s\S]+)/i);
  if (mAlias) text = '@myco ' + mAlias[1];

  // Internal-task control: /task, /skip <id>, /cancel <id> all forward
  // the literal command into the running claude session as @myco input
  // so claude can act on its own TaskList/TaskUpdate state and reply in
  // chat. The CLAUDE.md project rule tells claude how to interpret
  // these (list pending tasks; delete by id). The forwarding pattern is
  // the same one /m uses — keep these three together so future task
  // commands land in one place.
  const taskList = text.match(/^\/tasks?\s*$/i);
  if (taskList) text = '@myco /task';
  const taskAction = text.match(/^\/(skip|cancel)\s+(\d+)\s*$/i);
  if (taskAction) text = `@myco /${taskAction[1].toLowerCase()} ${taskAction[2]}`;

  // (Note: the old proactive Shift+Tab auto-toggle that fired on every
  // human chat is removed. Claude now starts in accept-edits at spawn
  // via --permission-mode acceptEdits, so we don't need to nudge the
  // mode at runtime — and the old detection-then-toggle was fragile
  // because pattern-matching the headless terminal could misread state
  // and end up toggling INTO plan mode instead of accept-edits.)

  // Registered slash commands (/feature, /bug, /help, …) are handled by
  // the slashcmds dispatcher. /btw is intentionally NOT in the registry —
  // it's the existing claude-in-chat trigger handled below by btw.js.
  if (text.startsWith('/')) {
    const rec = sessionsMod.loadStore().sessions[sessionId];
    const absCwd = rec && rec.absCwd;
    const ctx = {
      user,
      sessionId,
      absCwd,
      session,                          // for /decide and future PTY-writing commands
      reply: (replyText, opts = {}) => {
        const replyMsg = {
          user: ASSISTANT_USER,
          text: String(replyText || ''),
          ts: new Date().toISOString(),
        };
        if (opts && opts.meta) replyMsg.meta = opts.meta;
        sessionsMod.appendChatMessage(sessionId, replyMsg);
        session.emit('chat', replyMsg);
      },
    };
    slashcmds.dispatch(ctx, text).then((handled) => {
      // If not a known slash command, fall through to the @myco / /btw paths
      // synchronously. (Async fall-through is awkward; for /btw the existing
      // shouldAskAssistant path below picks it up because parseCommand
      // returned null for /btw specifically.)
      if (handled) return;
      handleChatPostfixes(sessionId, session, user, text, message);
    });
    return;
  }

  handleChatPostfixes(sessionId, session, user, text, message);
}

// The non-slash routing — kept as a separate function so the slash path
// can fall through after dispatch().
function handleChatPostfixes(sessionId, session, user, text, message) {
  // @<word> → send the message body to the running Claude PTY session.
  // Historically only @myco matched; we now accept any @<word> prefix
  // (so @claude / @generate / @anything works) UNLESS <word> is a
  // known username from the chat allowlist (so @kkrazy stays a real
  // user mention). Open to owner + viewers — chat is the collaborative
  // steering channel.
  const prefixMatch = text.match(CHAT_TO_PTY_PREFIX_RE);
  const ptyChat = prefixMatch && !_isKnownChatUser(prefixMatch[1])
    ? { prefix: prefixMatch[1], body: prefixMatch[2] }
    : null;
  if (ptyChat) {
    if (!session.alive) {
      // Used to silently drop here — viewers' @myco messages would
      // disappear into the void with no feedback. Echo a warning so the
      // sender knows the PTY is gone and to reattach.
      session.emit('chat', {
        user: ASSISTANT_USER,
        text: '(this Claude session has exited — reopen the session to continue)',
        ts: new Date().toISOString(),
      });
      return;
    }
    const input = ptyChat.body.trim();
    if (input) {
      // Reject Claude's interactive slash-commands. They aren't meaningful
      // when delivered via chat — Claude responds "Unknown command: /<x>"
      // which then sticks in the transcript and confuses every viewer.
      if (input.startsWith('/')) {
        session.emit('chat', {
          user: ASSISTANT_USER,
          text: '(slash commands like `/' + input.split(/\s+/)[0].slice(1) + '` only work in the interactive Claude CLI, not via @myco in chat)',
          ts: new Date().toISOString(),
        });
        return;
      }
      // Special key tokens — let viewers respond to Claude's interactive
      // prompts (y/n confirmations, "press Enter to continue", etc.) without
      // a real terminal. The token is written verbatim, no trailing CR.
      const SPECIAL_KEYS = {
        enter: '\r',
        return: '\r',
        esc: '\x1b',
        escape: '\x1b',
        'ctrl-c': '\x03',
        '^c': '\x03',
        space: ' ',
        tab: '\t',
        'shift-tab': '\x1b[Z',
        'shift+tab': '\x1b[Z',
      };
      const specialBytes = SPECIAL_KEYS[input.toLowerCase()];
      if (specialBytes !== undefined) {
        console.log(`[chat→pty] ${user}: <key:${input}>`);
        session.write(specialBytes);
        return;
      }
      // If a TUI menu is open in Claude (plan-mode "what next" or a
      // permission ask that fell through to /decide), short-circuit two
      // common shapes of @myco message so the user doesn't get stuck:
      //
      //   * @myco <digit>  → treat as a direct option pick (same effect
      //     as /decide N). Most users type "1" / "2" naturally and don't
      //     discover /decide.
      //   * @myco <anything else> → cancel the menu first with Esc, then
      //     send the new instruction. The user's intent is "do this new
      //     thing"; leaving the stale menu around just wedges Claude.
      const pendingMenu = session.pendingMenu;
      if (pendingMenu) {
        const asDigit = /^[1-9]$/.test(input) ? parseInt(input, 10) : NaN;
        if (Number.isFinite(asDigit) && pendingMenu.options.find((o) => o.n === asDigit)) {
          console.log(`[chat→pty] ${user}: menu pick ${asDigit} (via @myco shorthand)`);
          session.write(String(asDigit) + '\r');
          session.pendingMenu = null;
          return;
        }
        console.log(`[chat→pty] ${user}: cancelling pending menu (Esc) before new instruction`);
        session.write('\x1b');
        session.pendingMenu = null;
        // Surface what we did so the user understands the menu went away.
        sessionsMod.appendChatMessage(sessionId, {
          user: ASSISTANT_USER,
          text: '(cancelled the pending menu so I can act on your new instruction. Use `/decide <n>` next time if you wanted to answer it.)',
          ts: new Date().toISOString(),
        });
        session.emit('chat', {
          user: ASSISTANT_USER,
          text: '(cancelled the pending menu so I can act on your new instruction. Use `/decide <n>` next time if you wanted to answer it.)',
          ts: new Date().toISOString(),
        });
        // fall through to the normal toggle + send below
      }
      // No mode-toggle preamble — Claude is in accept-edits mode from spawn
      // (--permission-mode acceptEdits) and tool-approval gaps are handled
      // by the menu interceptor + per-session allow list.
      //
      // Split the write into TWO PTY operations: the text first, then the
      // trailing \r after a short delay. When everything ships as one
      // chunk (or when wrapped in bracketed-paste markers), Claude Code's
      // TUI input editor sometimes treats the bundle as
      // multi-line-paste-with-Enter-inside-the-paste, leaving the prompt
      // typed in the input but never submitted. Mobile is hit hardest
      // because WS frames arrive bunched on slower networks; viewers
      // (read-only) hit the same path. The 100ms gap lets the input
      // buffer settle (cursor at end, no pending paste state) before the
      // submit keystroke lands. session.alive is re-checked at the
      // timeout boundary so a session that died between the two writes
      // doesn't throw.
      //
      // The "leading newline" appearance we previously chased via paste-
      // wrapping turned out to be Claude Code's OWN TUI input layout
      // (physical-keyboard typing produces the same look), not something
      // our PTY writes cause. So no leading-newline regression from this
      // split.
      console.log(`[chat→pty] ${user}: ${input.substring(0, 80)}`);
      session.write(input);
      setTimeout(() => {
        if (session && session.alive) session.write('\r');
      }, 100);
    }
    return;
  }

  if (shouldAskAssistant(text)) {
    runAssistant(sessionId, session, message).catch((err) => {
      console.error(`[chat-assistant] ${err.message}`);
    });
  }
}

async function runAssistant(sessionId, session, lastMessage) {
  // Snapshot context BEFORE invoking — chatHistory excludes lastMessage so
  // it's not duplicated (we pass it separately as the prompt target).
  const all = sessionsMod.getChatHistory(sessionId);
  const chatHistory = all.slice(-ASSISTANT_CHAT_CONTEXT - 1, -1); // exclude latest
  const buffer = session.buffer.join('');
  const scrollback = tailLines(stripAnsi(buffer), ASSISTANT_SCROLLBACK_LINES);
  const cwd = sessionsMod.loadStore().sessions[sessionId]?.absCwd || null;

  const answer = await askAssistant({ cwd, chatHistory, scrollback, lastMessage });
  const reply = {
    user: ASSISTANT_USER,
    text: answer || '(no response)',
    ts: new Date().toISOString(),
  };
  sessionsMod.appendChatMessage(sessionId, reply);
  session.emit('chat', reply);
}

// Read the bottom rows of the session's headless terminal and decide what
// mode Claude Code's TUI is in. Claude Code paints a status hint at the
// bottom of its alt-screen: something like "auto-accept edits on" when in
// accept-edits mode, "plan mode on" when in plan mode, and no mode label
// when in default. Returns a string we use to map → number of Shift+Tab
// presses needed to land in 'accept'. 'unknown' falls back to no-op.
function detectClaudeMode(session) {
  if (!session || !session.headless) return 'unknown';
  try {
    const buf = session.headless.buffer.active;
    const rows = session.headless.rows;
    // Inspect the last ~8 visible rows — the mode hint is anchored at
    // the bottom of the TUI, near the input prompt.
    const tail = [];
    for (let i = Math.max(0, rows - 8); i < rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      if (line) tail.push(line.translateToString(true));
    }
    const blob = tail.join('\n').toLowerCase();
    let mode;
    // Status-bar variants live in pty-patterns.js (MODE_ACCEPT_RE / MODE_PLAN_RE).
    if (MODE_ACCEPT_RE.test(blob)) mode = 'accept';
    else if (MODE_PLAN_RE.test(blob)) mode = 'plan';
    else mode = 'default';
    // Log the detected mode + a tiny tail snippet so we can confirm the
    // patterns are matching reality. Short enough not to flood logs.
    console.log(`[auto-mode] detected=${mode} tail=${JSON.stringify(blob.slice(-160))}`);
    return mode;
  } catch { return 'unknown'; }
}

// Bytes to send to land in accept-edits mode given the current detected
// mode. Claude Code cycles default → accept → plan → default on Shift+Tab,
// so getting from each starting mode takes 0/1/2 presses.
const SHIFT_TAB = '\x1b[Z';
function autoAcceptToggleBytes(session) {
  switch (detectClaudeMode(session)) {
    case 'accept':  return '';                        // already there
    case 'default': return SHIFT_TAB;                 // 1 cycle: default → accept
    case 'plan':    return SHIFT_TAB + SHIFT_TAB;     // 2 cycles: plan → default → accept
    default:        return '';                        // unknown → don't risk a stray toggle
  }
}

module.exports = {
  spawnClaude,
  getSession,
  killSession,
  attachWebSocket,
  attachViewerWebSocket,
  handleChatMessage,
  // Exposed for the menu-pick race-condition regression test.
  handleMenuPick,
  handleMenuToggle,
  handleMenuSubmit,
  // Re-exported for menu-broadcast.test.js — the live implementations now
  // live in menu.js; this surface stays so the test contract (and any
  // outside caller that pulls the menu helpers off ptyMod) keeps working.
  handleSessionMenu: menuMod.handleSessionMenu,
  broadcastMenuToChat: menuMod.broadcastMenuToChat,
};
