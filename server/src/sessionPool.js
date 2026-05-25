// fr-90: SessionPool with affinity-based routing.
//
// Goal: each plan item runs in its own AgentSession context (so the
// SDK can't batch unrelated dispatches into one turn — see bug-37's
// architectural limitation) BUT related items (via item.dependsOn or
// via text-mention regex against item.text + comments) reuse the
// same pool session so the agent retains accumulated context across
// the dependency chain.
//
// Pool is bounded (default 5 sessions per chat); idle reaper tears
// down stale sessions to bound RAM (each pool session = one real
// `claude` subprocess at ~200MB resident, plus a lean-ctx stdio
// subprocess at ~20MB).
//
// State:
//   - in-memory: sessions (Map of poolId → entry), affinity (Map of
//     itemId → poolId), pendingDispatches (queue of {item, text}
//     waiting for a free pool slot)
//   - persisted: <cwd>/_myco_/session-affinity.json — committable
//     per CLAUDE.md §5; survives restart so historical item ↔ pool
//     mappings can drive audit trails even after the in-memory
//     sessions reap. bootId tag distinguishes current-boot entries
//     from older epochs (per fr-91 epoch design).
//
// Routing rules (in priority order) — see pickSession():
//   1. dependsOn: any dep already mapped to a live pool session →
//      reuse that session. Agent there has the dep's context.
//   2. text-mention: regex \b(fr|bug|td)-\d+\b in item.text +
//      comments → reuse any mentioned item's session.
//   3. LRU: pick least-recently-used FREE session (warm cache).
//   4. spawn: create a new pool session if under maxSize.
//   5. queue: all sessions busy + at maxSize → push to
//      pendingDispatches, drain on next onTerminal.
//
// Phase 0 (this file): SessionPool class + persistence + routing +
// reaper. NO wiring into queue dispatch yet — that's Phase 1, gated
// on rec.sessionPoolEnabled opt-in flag.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const AFFINITY_FILENAME = 'session-affinity.json';
const DEFAULT_MAX_SIZE = 5;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;  // 10 min
const DEFAULT_REAP_INTERVAL_MS = 60 * 1000;       // 1 min

// Pull plan-item-id mentions from a free-form text. Matches the same
// id-shape the rest of myco uses: <layer>-<n> where layer ∈ {fr, bug,
// td}. Returns a deduped array of unique mention strings. Used by
// pickSession's text-mention rule.
function extractMentions(text) {
  if (!text) return [];
  const re = /\b(?:fr|bug|td)-\d+\b/g;
  const found = new Set();
  let m;
  while ((m = re.exec(String(text))) !== null) found.add(m[0]);
  return Array.from(found);
}

// Build the list of strings to scan for mentions on a single item.
// Includes the body text + every comment body. Skips run-summary
// auto-comments since they typically just echo the run outcome and
// would flood the mention set without adding routing value.
function _itemMentionCorpus(item) {
  if (!item) return [];
  const parts = [];
  if (typeof item.text === 'string') parts.push(item.text);
  if (Array.isArray(item.comments)) {
    for (const c of item.comments) {
      if (!c || typeof c.text !== 'string') continue;
      if (c.meta && c.meta.kind === 'run-summary') continue;
      parts.push(c.text);
    }
  }
  return parts;
}

class SessionPool {
  // opts:
  //   cwd            (required) — absolute path; affinity file lives at
  //                  <cwd>/_myco_/session-affinity.json
  //   parentSessionId (required) — used for child session id naming
  //                  (so debug logs can correlate pool member sessions
  //                  back to the chat session that owns them)
  //   maxSize        (default 5) — pool cap. Beyond this, dispatches
  //                  queue until a pool member frees.
  //   idleTimeoutMs  (default 10min) — reaper tears down pool members
  //                  idle longer than this.
  //   reapIntervalMs (default 1min) — how often the reaper fires.
  //   spawnAgent     (default agent-session.spawnAgent) — DI seam.
  //                  Tests inject a mock so Phase 0 doesn't fork real
  //                  claude subprocesses.
  //   now            (default Date.now) — DI seam for time-based
  //                  reaper tests.
  //   bootId         (default fresh hex) — per-process epoch tag for
  //                  affinity entries (fr-91 pattern).
  //   logger         (default console) — DI seam for log capture in
  //                  tests.
  constructor(opts = {}) {
    if (!opts.cwd) throw new Error('SessionPool: cwd is required');
    if (!opts.parentSessionId) throw new Error('SessionPool: parentSessionId is required');
    this.cwd = opts.cwd;
    this.parentSessionId = opts.parentSessionId;
    this.maxSize = Number.isInteger(opts.maxSize) && opts.maxSize > 0
      ? opts.maxSize : DEFAULT_MAX_SIZE;
    this.idleTimeoutMs = Number.isInteger(opts.idleTimeoutMs) && opts.idleTimeoutMs >= 0
      ? opts.idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
    this.reapIntervalMs = Number.isInteger(opts.reapIntervalMs) && opts.reapIntervalMs > 0
      ? opts.reapIntervalMs : DEFAULT_REAP_INTERVAL_MS;
    this._spawnAgentFn = opts.spawnAgent || _defaultSpawnAgent;
    this._now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.bootId = opts.bootId || crypto.randomBytes(8).toString('hex');
    this._log = opts.logger || console;
    // Runtime state.
    this.sessions = new Map();        // poolId → SessionEntry
    this.affinity = new Map();        // itemId → poolId (current-boot live mapping)
    this.historicalAffinity = new Map(); // itemId → { poolId, bootId, updatedAt } (loaded from disk; includes prior boots)
    this.pendingDispatches = [];      // [{ item, text, queuedAt }]
    this._reapTimer = null;
    this._loadAffinity();
  }

  _affinityPath() {
    return path.join(this.cwd, '_myco_', AFFINITY_FILENAME);
  }

  // Load affinity entries from disk. Entries from the CURRENT bootId
  // get loaded into the live `affinity` map (matching live sessions
  // would be unusual on a fresh boot, but the data is preserved for
  // historicalAffinity-driven cold-restart logging in Phase 2). All
  // entries (any boot) populate `historicalAffinity` for audit.
  _loadAffinity() {
    try {
      const raw = fs.readFileSync(this._affinityPath(), 'utf8');
      const j = JSON.parse(raw);
      const entries = (j && j.entries) || {};
      for (const [itemId, info] of Object.entries(entries)) {
        if (!info || typeof info.poolId !== 'string') continue;
        this.historicalAffinity.set(itemId, {
          poolId: info.poolId,
          bootId: info.bootId || null,
          updatedAt: info.updatedAt || null,
        });
        if (info.bootId === this.bootId) {
          this.affinity.set(itemId, info.poolId);
        }
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this._log.warn('[sessionPool] affinity load failed (treating as empty):', err.message);
      }
    }
  }

  // Persist affinity to disk. Atomic write via .tmp + rename so a
  // crash mid-write can't corrupt the file. Merges current-boot
  // entries (from this.affinity) with historicalAffinity (older
  // boots) so we never lose audit data.
  _persistAffinity() {
    try {
      const entries = {};
      // Historical entries first (older boots — preserved as-is).
      for (const [itemId, info] of this.historicalAffinity) {
        // Skip entries that are also in current-boot affinity; those
        // get the fresher record below.
        if (this.affinity.has(itemId)) continue;
        entries[itemId] = {
          poolId: info.poolId,
          bootId: info.bootId,
          updatedAt: info.updatedAt,
        };
      }
      // Current-boot entries (live mappings).
      const nowIso = new Date(this._now()).toISOString();
      for (const [itemId, poolId] of this.affinity) {
        entries[itemId] = {
          poolId,
          bootId: this.bootId,
          updatedAt: nowIso,
        };
      }
      const payload = {
        bootId: this.bootId,
        lastUpdated: nowIso,
        entries,
      };
      const dir = path.dirname(this._affinityPath());
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this._affinityPath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this._affinityPath());
    } catch (err) {
      this._log.error('[sessionPool] persist affinity failed:', err.message);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Routing — the heart of fr-90's design.
  // ──────────────────────────────────────────────────────────────────
  //
  // Returns { poolId, reason } where reason is one of:
  //   'dependsOn:<depId>'  — rule 1 hit, reused dep's pool session
  //   'mention:<mentionId>' — rule 2 hit, reused text-mentioned session
  //   'lru'                — rule 3 hit, picked LRU free session
  //   'spawn'              — rule 4 hit, created a new pool session
  // Returns null when rule 5 fires (all busy + at cap → caller must
  // queue the dispatch via _queuePending).
  pickSession(item) {
    if (!item || !item.id) return null;
    // Rule 1: dependsOn affinity.
    if (Array.isArray(item.dependsOn)) {
      for (const depId of item.dependsOn) {
        const poolId = this.affinity.get(depId);
        if (poolId && this.sessions.has(poolId)) {
          return { poolId, reason: 'dependsOn:' + depId };
        }
      }
    }
    // Rule 2: text-mention affinity. Scan item.text + comments for
    // \b(fr|bug|td)-\d+\b matches; skip self-id.
    const corpus = _itemMentionCorpus(item);
    for (const text of corpus) {
      const mentions = extractMentions(text);
      for (const mId of mentions) {
        if (mId === item.id) continue;
        const poolId = this.affinity.get(mId);
        if (poolId && this.sessions.has(poolId)) {
          return { poolId, reason: 'mention:' + mId };
        }
      }
    }
    // Rule 3: LRU free session (warm system-prompt cache).
    let lruPoolId = null;
    let lruTime = Infinity;
    for (const [poolId, sess] of this.sessions) {
      if (!sess.busy && sess.lastUsed < lruTime) {
        lruTime = sess.lastUsed;
        lruPoolId = poolId;
      }
    }
    if (lruPoolId) return { poolId: lruPoolId, reason: 'lru' };
    // Rule 4: spawn new under cap.
    if (this.sessions.size < this.maxSize) {
      const poolId = this._spawnSession();
      return { poolId, reason: 'spawn' };
    }
    // Rule 5: all busy + capped → caller queues.
    return null;
  }

  // ──────────────────────────────────────────────────────────────────
  // Session lifecycle
  // ──────────────────────────────────────────────────────────────────

  _spawnSession() {
    const poolId = 'pool-' + crypto.randomBytes(4).toString('hex');
    const childSessionId = this.parentSessionId + ':' + poolId;
    const agent = this._spawnAgentFn(childSessionId, { cwd: this.cwd });
    const now = this._now();
    const entry = {
      poolId,
      agent,
      busy: false,
      lastUsed: now,
      createdAt: now,
      items: new Set(),      // itemIds dispatched to this pool member
      deps: new Set(),       // dep itemIds carried by those items
    };
    this.sessions.set(poolId, entry);
    this._log.log('[sessionPool] spawned ' + poolId + ' (' + this.sessions.size + '/' + this.maxSize + ')');
    return poolId;
  }

  _reapIdle() {
    const now = this._now();
    const reaped = [];
    for (const [poolId, sess] of this.sessions) {
      if (sess.busy) continue;
      if ((now - sess.lastUsed) <= this.idleTimeoutMs) continue;
      // Tear down. Affinity entries stay in this.affinity AND
      // historicalAffinity — Phase 2's cold-restart path will detect
      // the missing pool member + log + spawn fresh.
      try { if (typeof sess.agent.kill === 'function') sess.agent.kill(); } catch {}
      this.sessions.delete(poolId);
      reaped.push(poolId);
    }
    if (reaped.length) {
      this._log.log('[sessionPool] reaped ' + reaped.length + ' idle session(s): ' + reaped.join(','));
      this._persistAffinity();
    }
    return reaped;
  }

  startReaper() {
    if (this._reapTimer) return;
    this._reapTimer = setInterval(() => {
      try { this._reapIdle(); }
      catch (err) { this._log.error('[sessionPool] reaper threw:', err.message); }
    }, this.reapIntervalMs);
    if (this._reapTimer.unref) this._reapTimer.unref();
  }

  stopReaper() {
    if (this._reapTimer) {
      clearInterval(this._reapTimer);
      this._reapTimer = null;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Dispatch surface — Phase 1 will call this from attach.js queue
  // dispatch when rec.sessionPoolEnabled === true.
  // ──────────────────────────────────────────────────────────────────

  // dispatch(item, text) — route + write. Returns { ok, poolId,
  // reason } on success, { ok:false, reason:'queued', queuePos }
  // when all sessions busy + at cap.
  dispatch(item, text) {
    if (!item || !item.id) {
      return { ok: false, reason: 'invalid-item' };
    }
    const pick = this.pickSession(item);
    if (!pick) {
      this.pendingDispatches.push({ item, text, queuedAt: this._now() });
      return {
        ok: false,
        reason: 'queued',
        queuePos: this.pendingDispatches.length,
      };
    }
    const sess = this.sessions.get(pick.poolId);
    sess.busy = true;
    sess.lastUsed = this._now();
    sess.items.add(item.id);
    if (Array.isArray(item.dependsOn)) {
      for (const d of item.dependsOn) sess.deps.add(d);
    }
    this.affinity.set(item.id, pick.poolId);
    this._persistAffinity();
    try {
      sess.agent.write(text);
    } catch (err) {
      // Write failed — undo the busy flag so the pool isn't stuck.
      sess.busy = false;
      this._log.error('[sessionPool] write to ' + pick.poolId + ' failed:', err.message);
      return { ok: false, reason: 'write-failed', error: err.message };
    }
    this._log.log('[sessionPool] dispatched ' + item.id + ' → ' + pick.poolId + ' (' + pick.reason + ')');
    return { ok: true, poolId: pick.poolId, reason: pick.reason };
  }

  // onTerminal(poolId) — called by the per-pool-session agent-event
  // listener (Phase 1 wiring) when a turn finishes. Frees the
  // session + drains pending dispatches.
  onTerminal(poolId) {
    const sess = this.sessions.get(poolId);
    if (!sess) return { drained: 0 };
    sess.busy = false;
    sess.lastUsed = this._now();
    // Drain at most ONE pending dispatch per terminal — the SDK only
    // freed one slot, so we shouldn't try to dispatch many at once.
    // Subsequent terminals will drain subsequent pending entries.
    let drained = 0;
    while (this.pendingDispatches.length > 0) {
      const next = this.pendingDispatches[0];
      const pick = this.pickSession(next.item);
      if (!pick) break;  // still no slot for this one
      this.pendingDispatches.shift();
      const r = this.dispatch(next.item, next.text);
      // dispatch may re-queue (race) — only count true sends.
      if (r.ok) drained += 1;
      // Loop to try draining next pending if more slots are free.
      // Bounded by while-pendingDispatches.length condition.
    }
    return { drained };
  }

  // For Phase 2: detect cold-restart — when an item's dependsOn or
  // text-mention points at an itemId in historicalAffinity but NOT
  // in current-boot affinity, that's a cold restart.
  isColdRestartFor(item) {
    if (!item) return null;
    const check = (id) => {
      if (this.affinity.has(id)) return false;            // live mapping
      if (this.historicalAffinity.has(id)) return true;   // stale mapping
      return false;
    };
    if (Array.isArray(item.dependsOn)) {
      for (const d of item.dependsOn) {
        if (check(d)) return { kind: 'dependsOn', stale: d };
      }
    }
    for (const text of _itemMentionCorpus(item)) {
      for (const m of extractMentions(text)) {
        if (m !== item.id && check(m)) return { kind: 'mention', stale: m };
      }
    }
    return null;
  }

  // Tear down the entire pool. Called from session shutdown.
  shutdown() {
    this.stopReaper();
    for (const [_, sess] of this.sessions) {
      try { if (typeof sess.agent.kill === 'function') sess.agent.kill(); } catch {}
    }
    this.sessions.clear();
    this._persistAffinity();
  }

  // Pool snapshot — used by tests + future observability surfaces
  // (a per-pool chip on the plan tab, say). Read-only view of the
  // current pool state.
  snapshot() {
    const sessions = [];
    for (const [poolId, sess] of this.sessions) {
      sessions.push({
        poolId,
        busy: sess.busy,
        lastUsed: sess.lastUsed,
        createdAt: sess.createdAt,
        items: Array.from(sess.items),
        deps: Array.from(sess.deps),
      });
    }
    return {
      bootId: this.bootId,
      maxSize: this.maxSize,
      idleTimeoutMs: this.idleTimeoutMs,
      sessions,
      affinity: Object.fromEntries(this.affinity),
      pendingDispatches: this.pendingDispatches.length,
    };
  }
}

// Default spawn — wires the real AgentSession. Lazy require so
// loading this module doesn't transitively pull the SDK (matches
// myco-mcp.js's lazy-require pattern for the same reason).
function _defaultSpawnAgent(sessionId, opts) {
  const { spawnAgent } = require('./agent-session');
  return spawnAgent(sessionId, opts);
}

module.exports = {
  SessionPool,
  extractMentions,
  AFFINITY_FILENAME,
  DEFAULT_MAX_SIZE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_REAP_INTERVAL_MS,
};
