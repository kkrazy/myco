// In-process Delm board — shared context + shared sub-queue, ported to JS.
//
// Semantic blueprint: Delm/board/shared_context.py + protected_board.py.
// Two worker AgentSessions coordinate the ONLY way Delm allows — through
// this board: an append-only event log from which the queue (item -> claim
// -> done) and notes (FACT/FAIL) are derived. A done/note may register files
// behind it (a body); views expose only names/sizes/change, and a peer pulls
// content by id with expand or apply.
//
// myco runs this entirely in-process (single Node process), so unlike Delm
// there is no HTTP layer and no shell wrapper: the board is a plain object
// the worker's board-MCP tools call directly. A waiting read uses an
// EventEmitter wake instead of Delm's 0.25s poll loop — the process has no
// shell-tool wall-clock cutoff, so a waiter resumes the instant a peer
// publishes anything (faster, and still bounded by WAIT_CAP_SECONDS).
//
// Persistence: an optional JSONL file. When `persistPath` is set every event
// / body / publication is appended to disk (best-effort) and the log is
// replayed on construction, so a TeamSession can survive a server restart.

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// Matches Delm FILE_LIMITS byte-for-byte so crafted bundles behave the same.
const FILE_LIMITS = { files: 40, totalBytes: 400_000, fileBytes: 200_000 };
const SCRATCH_ROOT = '/tmp';                 // absolute paths only under here
const NOTE_TYPES = ['FACT', 'FAIL'];
const SYSTEM = 'system';
// A waiting read returns on a peer publication; a status never wakes it.
const WAKE_KINDS = ['item', 'note', 'body', 'done'];
// Delm caps a waiting read at 25s; we keep the cap for fidelity (the event
// wake makes it return far earlier in practice).
const WAIT_CAP_SECONDS = 25;

class BoardError extends Error {
  constructor(message) { super(message); this.name = 'BoardError'; }
}

class OriginalReadError extends Error {
  constructor(message) { super(message); this.name = 'OriginalReadError'; }
}

function limited(field, value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BoardError(`${field} must be non-empty text`);
  }
  return value;
}

// Ignore case + extra whitespace, preserving punctuation and Unicode.
function normalized(subject) {
  return String(subject).toLowerCase().trim().split(/\s+/).join(' ');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function checkPath(p) {
  if (typeof p !== 'string' || !p || p !== p.trim()) throw new BoardError('every attached file needs a path');
  const parts = p.split('/');
  const name = parts[parts.length - 1];
  if (parts.includes('..') || !name || ['', '.', '..'].includes(name)) {
    throw new BoardError(`${p}: path must not contain '..'`);
  }
  if (p.startsWith('/') && !p.startsWith(SCRATCH_ROOT + '/')) {
    throw new BoardError(`${p}: absolute paths are accepted only under ${SCRATCH_ROOT}; use a path relative to your workspace`);
  }
  return p;
}

function checkFiles(files) {
  if (!Array.isArray(files) || !files.length) throw new BoardError('files must be a non-empty list');
  if (files.length > FILE_LIMITS.files) {
    throw new BoardError(`${files.length} files attached; at most ${FILE_LIMITS.files} allowed`);
  }
  const checked = [];
  const seen = new Set();
  let total = 0;
  for (const entry of files) {
    const p = checkPath(entry && entry.path);
    if (seen.has(p)) throw new BoardError(`${p}: attached twice`);
    seen.add(p);
    const content = entry && entry.content;
    if (typeof content !== 'string') throw new BoardError(`${p}: content must be text`);
    const raw = Buffer.from(content, 'utf8');
    if (raw.length > FILE_LIMITS.fileBytes) {
      throw new BoardError(`${p} is ${raw.length} bytes; at most ${FILE_LIMITS.fileBytes} per file`);
    }
    total += raw.length;
    checked.push({
      path: p, content, bytes: raw.length, sha256: sha256(raw),
      mode: entry.mode === 'x' ? 'x' : '-',
    });
  }
  if (total > FILE_LIMITS.totalBytes) {
    throw new BoardError(`attached files total ${total} bytes; at most ${FILE_LIMITS.totalBytes} allowed`);
  }
  return checked;
}

function metadata(files) {
  return files.map((f) => {
    const m = { path: f.path, bytes: f.bytes, change: f.change };
    if (f.original_error) m.original_error = f.original_error;
    return m;
  });
}

function fingerprint(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

/**
 * In-process Delm board.
 *
 * @param {object} opts
 * @param {string[]} opts.actors  roster, e.g. ['worker-A','worker-B']
 * @param {(filePath: string) => Buffer|null} [opts.original]
 *        returns the task's original bytes for a path, or null if the file
 *        did not exist originally. Default: () => null (myco has no task
 *        image snapshot; apply then treats any non-peer, non-original local
 *        version as a conflict, the safe cross-author default).
 * @param {string} [opts.persistPath]  optional JSONL file for durability.
 */
class DelmBoard extends EventEmitter {
  constructor({ actors, original, persistPath } = {}) {
    super();
    this.actors = Array.isArray(actors) ? actors.slice() : [];
    this.original = original || (() => null);
    this.persistPath = persistPath ? path.resolve(persistPath) : null;
    this.stopping = false;
    this._log = [];                   // { sequence, timeNs, actor, kind, payload }
    this._sequence = 0;
    this._bodies = new Map();         // id -> { actor, registeredAt(seq), files }
    this._bodySeq = 0;
    this._publications = new Map();   // id -> publication row
    this._pubSeq = 0;
    this._requests = new Map();       // `${actor}\u0000${request_id}` -> publication id

    if (this.persistPath) {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      this._load();
    }
  }

  // ---- persistence -------------------------------------------------------

  _load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      for (const line of fs.readFileSync(this.persistPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (row.kind === '_body') {
          this._bodySeq = Math.max(this._bodySeq, row.seq || 0);
          this._bodies.set(row.id, { actor: row.actor, registeredAt: row.seq, files: row.files });
        } else if (row.kind === '_publication') {
          const pub = {
            id: row.id, actor: row.actor, kind: row.kind2, item_id: row.item_id,
            payload: row.payload, fingerprint: row.fingerprint, request_id: row.request_id,
          };
          this._publications.set(row.id, pub);
          if (row.request_id) this._requests.set(`${row.actor}\u0000${row.request_id}`, row.id);
        } else if (row.sequence) {
          this._log.push({
            sequence: row.sequence, timeNs: row.timeNs,
            actor: row.actor, kind: row.kind, payload: row.payload,
          });
          this._sequence = Math.max(this._sequence, row.sequence);
        }
      }
    } catch (err) {
      // A corrupt/partial journal must never break a live board.
      console.error(`[board] journal replay failed: ${err.message}`);
    }
  }

  _persistLine(row) {
    if (!this.persistPath) return;
    try { fs.appendFileSync(this.persistPath, JSON.stringify(row) + '\n'); } catch (err) { /* best-effort */ }
  }

  // ---- event log ---------------------------------------------------------

  append(actor, kind, payload) {
    this._sequence += 1;
    const row = { sequence: this._sequence, timeNs: Date.now(), actor, kind, payload };
    this._log.push(row);
    this._persistLine(row);
    if (WAKE_KINDS.includes(kind) || kind === 'session') this.emit('wake', { actor, kind });
    // team-split-view: notify UI-side listeners (TeamSession) of every
    // append so they can ship a board snapshot to attached clients.
    // Filtered upstream — read/wait/session are coordination noise, not
    // user-visible board state.
    this.emit('change', { sequence: row.sequence, timeNs: row.timeNs, actor, kind, payload });
  }

  eventsByKind(...kinds) {
    const set = new Set(kinds);
    return this._log.filter((e) => set.has(e.kind)).map((e) => [e.actor, e.kind, e.payload]);
  }

  // team-split-view reattach: the full UI-relevant event history, in
  // log order. Same filter _relayBoardChange applies per-append
  // (read/wait/session are worker-coordination noise, not user-visible
  // board state) so a client that reattaches mid-run — or after the run
  // ended — can rebuild the middle-column event feed exactly as it
  // looked live. The in-memory _log is the source: it is hydrated from
  // persistPath on construction (board.js _load), so this works even
  // for a board whose process died and was reconstructed.
  uiEventLog() {
    return this._log
      .filter((e) => !['read', 'wait', 'session'].includes(e.kind))
      .map((e) => ({ sequence: e.sequence, timeNs: e.timeNs, actor: e.actor, kind: e.kind, payload: e.payload }));
  }

  get lastSequence() { return this._sequence; }

  lastRead(actor) {
    let m = null;
    for (const e of this._log) {
      if (e.actor === actor && e.kind === 'read') m = e.sequence;
    }
    return m;
  }

  currentStatus(actor) {
    let text = null;
    for (const e of this._log) {
      if (e.actor === actor && e.kind === 'status') text = e.payload.text;
    }
    return text;
  }

  sessionState(actor, state) {
    if (!this.actors.includes(actor) || !['running', 'ended'].includes(state)) {
      throw new BoardError('unknown agent or session state');
    }
    let previous = 'starting';
    for (const [, , p] of this.eventsByKind('session')) {
      if (p.actor === actor) previous = p.state;
    }
    if (previous === state) return;
    if (previous === 'ended') throw new BoardError('an ended session cannot restart');
    this.append(SYSTEM, 'session', { actor, state, recordedAtNs: Date.now() });
  }

  // ---- derived state -----------------------------------------------------

  queueState() {
    const items = new Map();
    for (const [actor, kind, payload] of this.eventsByKind('item', 'claim', 'done')) {
      if (kind === 'item') {
        items.set(payload.id, Object.assign({}, payload, { state: 'open' }));
      } else if (kind === 'claim') {
        const it = items.get(payload.item);
        if (it) Object.assign(it, { state: 'claimed', owner: actor });
      } else if (kind === 'done') {
        const it = items.get(payload.item);
        if (it) Object.assign(it, {
          state: 'done', summary: payload.summary, owner: actor,
          publication_id: payload.publication_id || payload.item,
        });
      }
    }
    return Array.from(items.values());
  }

  // An active item a reader has already seen in full: identity + state only.
  compact(item) {
    const out = {};
    for (const k of ['id', 'subject', 'state', 'owner', 'files', 'publication_id']) {
      if (item[k] !== undefined) out[k] = item[k];
    }
    return out;
  }

  view(reader) {
    const current = {};
    for (const [actor, , payload] of this.eventsByKind('status')) current[actor] = payload.text;
    const sessions = {};
    for (const a of this.actors) sessions[a] = 'starting';
    for (const [, , payload] of this.eventsByKind('session')) sessions[payload.actor] = payload.state;
    const queue = this.queueState();
    for (const item of queue) {
      const pid = item.publication_id || item.id;
      if (this._bodies.has(pid)) item.files = metadata(this._bodies.get(pid).files);
    }
    const notes = this.eventsByKind('note').map(([actor, , payload]) => Object.assign({}, payload, { actor }));
    for (const note of notes) {
      if (this._bodies.has(note.id)) note.files = metadata(this._bodies.get(note.id).files);
    }
    return {
      reader,
      agents: this.actors.slice(),
      sessions: this.actors.map((a) => ({ actor: a, state: sessions[a] })),
      status: Object.keys(current).map((a) => ({ actor: a, text: current[a] })),
      queue,
      notes,
      sequence: this.lastSequence,
    };
  }

  // Incremental view: the first view (or `full`) is complete; later views
  // show only what changed since the actor's last served read. A read/wait
  // also lists every non-done item (unchanged ones compacted).
  served(actor, via, full = false) {
    const result = this.view(actor);
    const previous = this.lastRead(actor);
    result.full = Boolean(full) || previous === null;
    if (!result.full) {
      const changed = new Set();
      const statuses = new Set();
      for (const e of this._log) {
        if (e.sequence <= previous) continue;
        const p = e.payload;
        if (['item', 'note', 'body'].includes(e.kind)) changed.add(p.id);
        else if (['claim', 'done'].includes(e.kind)) changed.add(p.item);
        else if (e.kind === 'status') statuses.add(e.actor);
      }
      const listed = via === 'read' || via === 'wait';
      result.queue = result.queue
        .filter((i) => changed.has(i.id) || (listed && i.state !== 'done'))
        .map((i) => (changed.has(i.id) ? i : this.compact(i)));
      result.notes = result.notes.filter((n) => changed.has(n.id));
      result.status = result.status.filter((s) => statuses.has(s.actor));
    }
    this.append(actor, 'read', { view: result, via });
    return result;
  }

  viewAfter(actor, via) {
    return this.served(actor, via);
  }

  // ---- waiting read ------------------------------------------------------

  // Scan events after `previous` for something that should end a wait.
  // Returns a reason object, or null (keep waiting).
  wakeReason(actor, previous, target) {
    const after = this._log.filter((e) => e.sequence > previous);
    const woken = [];
    for (const e of after) {
      const p = e.payload;
      if (e.kind === 'session') {
        if (p.actor !== actor && p.state === 'ended') woken.push({ actor: e.actor, kind: 'ended' });
      } else if (e.actor !== actor && WAKE_KINDS.includes(e.kind)) {
        woken.push({ actor: e.actor, kind: e.kind });
      }
    }
    const sessions = {};
    for (const [, , p] of this.eventsByKind('session')) sessions[p.actor] = p.state;
    const peers = this.actors.filter((a) => a !== actor);
    if (peers.length && peers.every((a) => sessions[a] === 'ended') && !woken.some((w) => w.kind !== 'ended')) {
      return { by: 'peer-ended', events: woken };
    }
    if (woken.length) {
      return { by: woken.some((w) => w.kind !== 'ended') ? 'update' : 'peer-ended', events: woken };
    }
    if (target) {
      for (const e of after) {
        if (!['done', 'body', 'note'].includes(e.kind)) continue;
        const p = e.payload;
        if (p.item === target || p.id === target || p.publication_id === target) {
          return { by: 'already', events: [] };
        }
      }
    }
    return null;
  }

  /**
   * Read the board. If waitSeconds > 0, blocks (async) until a peer
   * publication or peer end, else until WAIT_CAP_SECONDS. Returns an
   * incremental view; on timeout returns an empty shell that does NOT
   * advance the actor's read cursor (semantics identical to Delm).
   */
  async read(actor, { all = false, waitSeconds = 0, target = null } = {}) {
    if (!waitSeconds) return this.served(actor, 'read', all);
    const cap = Math.min(Number(waitSeconds) || 0, WAIT_CAP_SECONDS);
    const previous = this.lastRead(actor);
    if (target) {
      const text = `waiting for ${target}`;
      if (this.currentStatus(actor) !== text) this.append(actor, 'status', { text, auto: true });
    }
    const started = Date.now();
    let woke = null;
    while (!woke && !this.stopping && Date.now() - started < cap * 1000) {
      woke = this.wakeReason(actor, previous, target);
      if (woke) break;
      const remain = started + cap * 1000 - Date.now();
      if (remain <= 0) break;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; this.removeListener('wake', onWake); resolve(); };
        const onWake = () => finish();
        // Not unref'd on purpose: the wait must hold the process until it
        // resolves, otherwise a reader with nothing else pending would let
        // Node exit early (the caller — the agent SDK iteration — keeps the
        // process alive in production; the timer guarantees a bound here).
        const t = setTimeout(finish, remain);
        this.on('wake', onWake);
      });
    }
    const waited = Math.round((Date.now() - started) / 100) / 10;
    const by = woke ? woke.by : 'timeout';
    const events = woke ? woke.events : [];
    this.append(actor, 'wait', { target, requested: cap, waited, woke_by: by, woken: events });
    if (!woke) {
      const c = this.view(actor);
      return {
        reader: actor, updates: false, full: false, waited, woke_by: 'timeout', woken: [],
        sessions: c.sessions, sequence: c.sequence, queue: [], notes: [], status: [],
      };
    }
    const result = this.served(actor, 'wait', all);
    result.updates = true;
    result.waited = waited;
    result.woke_by = by;
    result.woken = events;
    return result;
  }

  // ---- status ------------------------------------------------------------

  status(actor, text) {
    this.append(actor, 'status', { text: limited('status', text) });
    return { saved: true, view: this.served(actor, 'status') };
  }

  // ---- item lifecycle ----------------------------------------------------

  publish(actor, items) {
    if (!Array.isArray(items) || !items.length) throw new BoardError('publish needs a non-empty list of items');
    const known = new Map();
    for (const it of this.queueState()) known.set(normalized(it.subject), it);
    const result = [];
    for (const raw of items) {
      const subject = limited('subject', raw && raw.subject);
      const detail = limited('detail', raw && raw.detail);
      const key = normalized(subject);
      let target = known.get(key);
      let created = false;
      if (!target) {
        const id = crypto.randomUUID();
        this.append(actor, 'item', { id, subject, detail });
        target = { id, subject, detail, state: 'open' };
        known.set(key, target);
        created = true;
      }
      result.push(Object.assign({ id: target.id, state: target.state, created },
        target.owner ? { owner: target.owner } : {}));
    }
    return { items: result, view: this.served(actor, 'publish') };
  }

  claim(actor, itemId) {
    const queue = this.queueState();
    const target = queue.find((i) => i.id === itemId);
    if (!target) throw new BoardError('unknown item');
    if (target.state !== 'open') {
      return { item: itemId, owner: target.owner, state: target.state, won: false, view: this.served(actor, 'claim') };
    }
    const held = queue.filter((i) => i.state === 'claimed' && i.owner === actor);
    if (held.length) throw new BoardError(`you already hold an unfinished item: ${held[0].id}`);
    this.append(actor, 'claim', { item: itemId });
    this.append(actor, 'status', { text: target.subject, auto: true });
    return { item: itemId, owner: actor, state: 'claimed', won: true, view: this.served(actor, 'claim') };
  }

  reserve(actor, subject, detail) {
    const safeSubject = limited('subject', subject);
    const safeDetail = limited('detail', detail);
    const queue = this.queueState();
    let target = queue.find((i) => normalized(i.subject) === normalized(safeSubject));
    if (target && target.state !== 'open') {
      const answer = {
        item: target.id, owner: target.owner, state: target.state,
        won: target.state === 'claimed' && target.owner === actor,
        created: false, view: this.served(actor, 'reserve'),
      };
      if (target.state === 'done') {
        answer.publication_id = target.publication_id || target.id;
        answer.summary = target.summary;
      }
      return answer;
    }
    const held = queue.filter((i) => i.state === 'claimed' && i.owner === actor);
    if (held.length) throw new BoardError(`you already hold an unfinished item: ${held[0].id}`);
    const created = !target;
    if (created) {
      const id = crypto.randomUUID();
      this.append(actor, 'item', { id, subject: safeSubject, detail: safeDetail });
      target = { id, subject: safeSubject };
    }
    this.append(actor, 'claim', { item: target.id });
    this.append(actor, 'status', { text: target.subject, auto: true });
    return { item: target.id, owner: actor, state: 'claimed', won: true, created, view: this.served(actor, 'reserve') };
  }

  // ---- files / bodies ----------------------------------------------------

  withOriginals(files) {
    const stored = [];
    for (const f of files) {
      let original = null;
      let original_error;
      try {
        original = this.original(f.path);
      } catch (err) {
        if (err instanceof OriginalReadError) {
          stored.push(Object.assign({}, f, { change: 'unknown', original_sha256: null, original: null, original_error: err.message }));
          continue;
        }
        throw err;
      }
      const change = original === null ? 'new'
        : sha256(original) === f.sha256 ? 'unchanged'
        : 'modified';
      stored.push(Object.assign({}, f, {
        change,
        original_sha256: original === null ? null : sha256(original),
        original: original === null ? null : original.toString('utf8'),
      }));
    }
    return stored;
  }

  register(actor, entryId, stored) {
    this._bodySeq += 1;
    const filesMeta = stored.map((f) => ({
      path: f.path, bytes: f.bytes, sha256: f.sha256, change: f.change, mode: f.mode,
    }));
    this._bodies.set(entryId, { actor, registeredAt: this._bodySeq, files: stored });
    this._persistLine({ kind: '_body', id: entryId, actor, seq: this._bodySeq, files: filesMeta });
    this.append(actor, 'body', { id: entryId, files: metadata(stored) });
  }

  body(entryId) {
    if (!this._bodies.has(entryId)) throw new BoardError('entry attaches no files');
    const b = this._bodies.get(entryId);
    return { author: b.actor, registeredAt: b.registeredAt, files: b.files };
  }

  select(files, paths) {
    if (!paths || !paths.length) return files;
    const missing = files.map((f) => f.path).filter((p) => !(paths.includes(p)));
    if (missing.length) throw new BoardError(`no attached file named ${missing.join(', ')}`);
    return files.filter((f) => paths.includes(f.path));
  }

  // Map of every version of `path` registered by agents other than `actor`:
  // sha256 -> max registration sequence.
  peerVersions(pathName, actor) {
    const versions = new Map();
    for (const [, body] of this._bodies) {
      if (body.actor === actor) continue;
      for (const f of body.files) {
        if (f.path !== pathName) continue;
        versions.set(f.sha256, Math.max(versions.get(f.sha256) || 0, body.registeredAt));
      }
    }
    return versions;
  }

  // ---- publication idempotency -------------------------------------------

  resolvePublicationId(entryId) {
    if (this._publications.has(entryId)) return entryId;
    let best = null;
    let bestSeq = -1;
    for (const pub of this._publications.values()) {
      if (pub.item_id === entryId && (pub.sequence || 0) > bestSeq) { best = pub; bestSeq = pub.sequence; }
    }
    return best ? best.id : entryId;
  }

  replayed(actor, requestId, fp) {
    if (!requestId) return null;
    limited('request_id', requestId);
    const id = this._requests.get(`${actor}\u0000${requestId}`);
    if (!id) return null;
    const row = this._publications.get(id);
    if (row.fingerprint !== fp) {
      throw new BoardError('request_id was already used for different publication content');
    }
    return row;
  }

  recordPublication(actor, kind, publicationId, payload, requestId, fp, itemId) {
    this._pubSeq += 1;
    const row = {
      id: publicationId, actor, kind, item_id: itemId, payload,
      fingerprint: fp, request_id: requestId, sequence: this._pubSeq,
    };
    this._publications.set(publicationId, row);
    if (requestId) this._requests.set(`${actor}\u0000${requestId}`, publicationId);
    this._persistLine({
      kind: '_publication', id: publicationId, actor, kind2: kind, item_id: itemId,
      payload, fingerprint: fp, request_id: requestId,
    });
    return row;
  }

  publicationResponse(actor, row, via) {
    const response = { publication_id: row.id, view: this.served(actor, via) };
    if (row.kind === 'done') {
      response.item = row.item_id;
      response.queue_empty = this.queueState().every((i) => i.state === 'done');
    } else {
      response.id = row.id;
    }
    return response;
  }

  // ---- done / note -------------------------------------------------------

  done(actor, itemId, summary, files, requestId) {
    const safeSummary = limited('done', summary);
    const checked = files ? this.withOriginals(checkFiles(files)) : [];
    const fp = fingerprint({ kind: 'done', item: itemId, summary: safeSummary, files: files || null });
    const previous = this.replayed(actor, requestId, fp);
    if (previous) return this.publicationResponse(actor, previous, 'done');
    const queue = this.queueState();
    const target = queue.find((i) => i.id === itemId);
    if (!target) throw new BoardError('unknown item');
    if (target.state !== 'claimed' || target.owner !== actor) {
      throw new BoardError('only the agent holding this item may complete it');
    }
    const publicationId = crypto.randomUUID();
    const payload = { item: itemId, summary: safeSummary, publication_id: publicationId };
    this.recordPublication(actor, 'done', publicationId, payload, requestId, fp, itemId);
    this.append(actor, 'done', payload);
    if (checked.length) this.register(actor, publicationId, checked);
    this.append(actor, 'status', { text: 'done: ' + target.subject, auto: true });
    return this.publicationResponse(actor, this._publications.get(publicationId), 'done');
  }

  note(actor, noteType, text, scope, basis, files, requestId) {
    if (!NOTE_TYPES.includes(noteType)) throw new BoardError('note type must be FACT or FAIL');
    const payload = {
      type: noteType,
      text: limited('note_text', text),
      scope: limited('note_scope', scope),
      basis: limited('note_basis', basis),
    };
    const checked = files ? this.withOriginals(checkFiles(files)) : [];
    const fp = fingerprint({ kind: 'note', payload, files: files || null });
    const previous = this.replayed(actor, requestId, fp);
    if (previous) return this.publicationResponse(actor, previous, 'note');
    const publicationId = crypto.randomUUID();
    payload.id = publicationId;
    this.recordPublication(actor, 'note', publicationId, payload, requestId, fp, null);
    this.append(actor, 'note', payload);
    if (checked.length) this.register(actor, publicationId, checked);
    return this.publicationResponse(actor, this._publications.get(publicationId), 'note');
  }

  // ---- attached / expand / apply -----------------------------------------

  attached(actor, entryId) {
    const b = this.body(entryId);
    this.append(actor, 'attached', { id: entryId, files: b.files.map((f) => f.path) });
    return { id: entryId, author: b.author, files: metadata(b.files) };
  }

  expand(actor, entryId, paths) {
    const b = this.body(entryId);
    const chosen = this.select(b.files, paths);
    const rendered = [];
    for (const f of chosen) {
      const isFull = (paths && paths.length) || f.original === null;
      let text;
      if (isFull) {
        text = f.content;
      } else {
        const a = String(f.original).split('\n');
        const btxt = f.content.split('\n');
        const out = [];
        for (let i = 0; i < Math.max(a.length, btxt.length); i++) {
          const x = a[i], y = btxt[i];
          if (x === y) out.push(' ' + x);
          else if (x === undefined) out.push('+' + y);
          else if (y === undefined) out.push('-' + x);
          else { out.push('-' + x); out.push('+' + y); }
        }
        text = '--- original/' + f.path + '\n+++ ' + b.author + '/' + f.path + '\n' + out.join('\n');
      }
      rendered.push({
        path: f.path, bytes: f.bytes, change: f.change,
        shown: isFull ? 'full' : 'diff', text,
        ...(f.original_error ? { original_error: f.original_error } : {}),
      });
    }
    this.append(actor, 'expand', { id: entryId, files: rendered.map((r) => r.path), shown: (paths && paths.length) ? 'full' : 'diff' });
    return { id: entryId, author: b.author, files: rendered };
  }

  // Cross-author edit protection. `local` maps path -> current sha256 (or
  // null for absent). Decisions: unchanged / kept / write / conflict.
  apply(actor, entryId, local, paths) {
    const b = this.body(entryId);
    const author = b.author;
    const registeredAt = b.registeredAt;
    const chosen = this.select(b.files, paths);
    const decisions = {};
    const granted = [];
    const conflicts = {};
    for (const f of chosen) {
      const current = (local && Object.prototype.hasOwnProperty.call(local, f.path)) ? local[f.path] : null;
      const peer = this.peerVersions(f.path, actor);
      let decision;
      if (current === f.sha256) {
        decision = 'unchanged';
      } else if (peer.has(current) && peer.get(current) > registeredAt) {
        decision = 'kept';
      } else if (current === null || (!f.original_error && current === f.original_sha256) || peer.has(current)) {
        decision = 'write';
        granted.push({ path: f.path, content: f.content, mode: f.mode });
      } else {
        decision = 'conflict';
        conflicts[f.path] = {
          reason: 'Local edits or another author\'s version require local reconciliation',
          incoming_publication: entryId, incoming_author: author,
          current_publications: Array.from(peer.entries()).map(([s, seq]) => ({ sha256: s, seq })),
        };
      }
      decisions[f.path] = decision;
    }
    const applied = Object.keys(conflicts).length === 0;
    this.append(actor, 'apply', { id: entryId, decisions, applied, confirmed: false, conflicts });
    return { id: entryId, author, applied, decisions, conflicts, files: applied ? granted : [] };
  }

  applyError(actor, entryId, error) {
    this.append(actor, 'apply_error', { id: entryId, error: String(error).slice(0, 500) });
  }

  applyResult(actor, entryId, written, success) {
    this.append(actor, 'apply_result', { id: entryId, written, success });
    return { saved: true, view: this.served(actor, 'apply_result') };
  }

  // ---- lifecycle ---------------------------------------------------------

  stop() {
    this.stopping = true;
    this.emit('wake', { actor: SYSTEM, kind: 'system' });
  }

  exportEvents() { return this._log.slice(); }
}

module.exports = {
  DelmBoard, BoardError, OriginalReadError,
  FILE_LIMITS, SCRATCH_ROOT, NOTE_TYPES, WAKE_KINDS, WAIT_CAP_SECONDS,
  limited, normalized, sha256, checkPath, checkFiles, metadata, fingerprint,
};
