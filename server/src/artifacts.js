// Plan / Arch / Test artifact routes.
//
// Server-side extraction of pending todos, architectural notes, and test
// plans from the running session's JSONL transcript via the Anthropic API
// (extractor.callClaudeCli). Stored under rec.artifacts[type] on the
// session record. Checking a Plan item or hitting the per-item quorum
// dispatches it back to the running Claude session as `@myco <text>` via
// the canonical chat-message path in pty.js.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { extractArtifact } = require('./extractor');
const { saveStore } = require('./sessions');

const ARTIFACT_TYPES = ['plan', 'arch', 'test'];

// Type glyph used in the chat-message title when an artifact item is
// dispatched. Mirrors the chrome buttons in index.html (📋/🧪/🏗️) so
// the chat row visually matches the artifact pane the item came from.
const ARTIFACT_TYPE_GLYPH = { plan: '📋', test: '🧪', arch: '🏗️' };

// Build the text that lands in BOTH the chat-history (for viewer
// awareness) and the running Claude PTY (`@myco <body>` prefix is
// stripped server-side, the rest becomes Claude's input). Format:
//
//   @myco [📋 Plan item · submitted by @kkrazy]
//   {item.text}
//
//   Comments:
//   - @alice: …
//   - @bob: …
//
// The title line keeps the type + submitter visible at a glance in
// chat; the body is what Claude executes on; comments come last so
// they augment but don't bury the primary instruction.
function _artifactLabel(type) {
  return type === 'plan' ? 'Plan item' : type === 'test' ? 'Test item' : 'Item';
}
function _artifactCommentsBlock(item) {
  const comments = Array.isArray(item.comments) ? item.comments : [];
  if (!comments.length) return [];
  const lines = ['', 'Comments:'];
  for (const c of comments) {
    if (!c || !c.text) continue;
    const author = c.user ? `@${c.user}` : 'anon';
    const body = String(c.text).replace(/\s+/g, ' ').trim();
    lines.push(`- ${author}: ${body}`);
  }
  return lines;
}
function buildArtifactRunText(type, item, user) {
  const glyph = ARTIFACT_TYPE_GLYPH[type] || '·';
  const header = `[${glyph} ${_artifactLabel(type)} · submitted by @${user}]`;
  return [`@myco ${header}`, item.text || '', ..._artifactCommentsBlock(item)].join('\n');
}
function buildArtifactQuorumText(type, item) {
  const glyph = ARTIFACT_TYPE_GLYPH[type] || '·';
  const voters = (item.voters || []).map((v) => `@${v}`).join(', ');
  const header = `[${glyph} ${_artifactLabel(type)} · quorum reached (${(item.voters || []).length} voters: ${voters})]`;
  return [`@myco ${header}`, item.text || '', ..._artifactCommentsBlock(item)].join('\n');
}

// The Arch artifact (markdown body) is mirrored to <session-cwd>/architecture.md
// so it lives with the project (version-controllable, editable from claude
// or directly), instead of only inside myco's sessions.json. GET prefers
// the file when present; refresh writes the freshly-extracted markdown to it.
const ARCH_FILE = 'architecture.md';

function archFilePath(rec) {
  if (!rec || !rec.absCwd) return null;
  return path.join(rec.absCwd, ARCH_FILE);
}

function readArchFromFile(rec) {
  const p = archFilePath(rec);
  if (!p) return null;
  let stat, body;
  try {
    stat = fs.statSync(p);
    body = fs.readFileSync(p, 'utf8');
  } catch { return null; }
  return { markdown: body, updatedAt: new Date(stat.mtimeMs).toISOString() };
}

function writeArchToFile(rec, markdown) {
  const p = archFilePath(rec);
  if (!p) return false;
  try {
    fs.writeFileSync(p, String(markdown || ''));
    return true;
  } catch (err) {
    console.error(`[artifact] failed to write ${p}: ${err.message}`);
    return false;
  }
}

// Plan items only — see autoFireIfQuorum below. Two distinct voters dispatch
// the @myco run automatically; arch is unactionable, test items don't run.
const AUTO_EXECUTE_VOTE_THRESHOLD = 2;
const COMMENT_TEXT_MAX = 1000;
const COMMENTS_PER_ITEM_MAX = 50;

function emptyArtifact(type) {
  if (type === 'arch') return { markdown: '', updatedAt: null };
  return { items: [], updatedAt: null };
}

function persistArtifact(rec, type, artifact) {
  if (!rec.artifacts) rec.artifacts = {};
  rec.artifacts[type] = artifact;
  saveStore();
}

function findItem(rec, type, itemId) {
  const artifact = rec.artifacts && rec.artifacts[type];
  if (!artifact || !Array.isArray(artifact.items)) return null;
  return artifact.items.find((it) => it.id === itemId) || null;
}

function ensureVoterAndCommentFields(item) {
  if (!Array.isArray(item.voters)) item.voters = [];
  if (!Array.isArray(item.comments)) item.comments = [];
}

function reqUser(req, ctx) { return req.user || ctx.rec.user || 'unknown'; }

// Wire the routes onto the express app. `deps` carries the shared auth
// preamble + the chat-dispatch hooks that live in index.js / pty.js — the
// artifact module stays decoupled from auth and PTY plumbing.
function register(app, deps) {
  const { fileApiPreamble, getPtySession, handleChatMessage } = deps;

  // GET — return the persisted artifact (or an empty stub of the right shape).
  // For type=arch we prefer the on-disk <cwd>/architecture.md when present
  // so a user (or claude) editing the file is the source of truth, not the
  // sessions.json copy. The Arch tab auto-loads from this path so the user
  // doesn't have to click Refresh to see content that already exists in
  // the project.
  app.get('/sessions/:id/artifact', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (type === 'arch') {
      const fromFile = readArchFromFile(ctx.rec);
      if (fromFile) {
        // Mirror back into rec.artifacts so other code paths (UI cache,
        // legacy clients) see a consistent shape.
        persistArtifact(ctx.rec, type, fromFile);
        return res.json({ artifact: fromFile });
      }
    }
    const stored = ctx.rec.artifacts && ctx.rec.artifacts[type];
    res.json({ artifact: stored || emptyArtifact(type) });
  });

  // Re-extract via `claude -p` in the session's cwd.
  app.post('/sessions/:id/artifact/refresh', async (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    let artifact;
    try {
      artifact = await extractArtifact(ctx.rec, type);
    } catch (err) {
      console.error(`[artifact] extract failed for ${type}: ${err.message}`);
      return res.status(500).json({ error: 'extraction failed', detail: err.message });
    }
    // Preserve user-typed plan items (added via /fr, /td, /bug slash
    // commands and tagged source='user') across a refresh — without
    // this they'd be wiped every time the user clicks the Refresh
    // button on the Plan tab, defeating the whole purpose of letting
    // users hand-add classified items.
    const previous = ctx.rec.artifacts && ctx.rec.artifacts[type];
    if (previous && Array.isArray(previous.items) && Array.isArray(artifact.items)) {
      const userItems = previous.items.filter((it) => it && it.source === 'user');
      if (userItems.length) {
        // User items first so they stay near the top of their layer
        // group after the client groups by `layer`.
        artifact.items = [...userItems, ...artifact.items];
      }
    }
    persistArtifact(ctx.rec, type, artifact);
    // Mirror the Arch markdown to <cwd>/architecture.md so it lives with
    // the project (next GET will read from there, and the file can be
    // committed / edited externally).
    if (type === 'arch' && artifact && typeof artifact.markdown === 'string') {
      writeArchToFile(ctx.rec, artifact.markdown);
    }
    res.json({ artifact });
  });

  // Dispatch a Plan or Test item to the running Claude session as
  // `@myco <text>` via the canonical chat pipeline (so it shows up in the
  // discussion history and broadcasts to read-only viewers).
  app.post('/sessions/:id/artifact/run', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    if (type === 'arch') return res.status(400).json({ error: 'arch is not actionable' });

    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    const session = getPtySession(ctx.id);
    if (!session) return res.status(409).json({ error: 'session not running' });

    try {
      const user = reqUser(req, ctx);
      handleChatMessage(ctx.id, session, user, buildArtifactRunText(type, item, user));
    } catch (err) {
      console.error(`[artifact] run failed: ${err.message}`);
      return res.status(500).json({ error: 'dispatch failed', detail: err.message });
    }
    item.done = true;
    item.ranAt = new Date().toISOString();
    persistArtifact(ctx.rec, type, ctx.rec.artifacts[type]);
    res.json({ ok: true, item, artifact: ctx.rec.artifacts[type] });
  });

  // Manual check/uncheck — no dispatch.
  app.post('/sessions/:id/artifact/mark', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    const done = String(req.query.done || '') === '1';
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    if (type === 'arch') return res.status(400).json({ error: 'arch has no items' });

    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    item.done = done;
    persistArtifact(ctx.rec, type, ctx.rec.artifacts[type]);
    res.json({ ok: true, item });
  });

  // Toggle a vote on a Plan item; auto-fire @myco if the per-item voter set
  // hits AUTO_EXECUTE_VOTE_THRESHOLD distinct users. Test items only carry
  // votes (no auto-fire); arch items can't be voted on.
  function autoFireIfQuorum(ctx, type, item) {
    if (item.done) return null;
    if (type !== 'plan') return null;
    if (item.voters.length < AUTO_EXECUTE_VOTE_THRESHOLD) return null;
    const session = getPtySession(ctx.id);
    if (!session) return { err: 'session not running, vote stored but not dispatched' };
    try {
      // Quorum dispatch — title names the voters so both chat viewers
      // and Claude see who drove the auto-fire. Same body+comments
      // shape as manual run for visual consistency.
      handleChatMessage(ctx.id, session, 'auto-quorum', buildArtifactQuorumText(type, item));
    } catch (err) {
      return { err: `dispatch failed: ${err.message}` };
    }
    item.done = true;
    item.ranAt = new Date().toISOString();
    return { fired: true };
  }

  app.post('/sessions/:id/artifact/vote', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (type === 'arch') return res.status(400).json({ error: 'arch items can\'t be voted on' });
    if (!itemId) return res.status(400).json({ error: 'itemId required' });

    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    ensureVoterAndCommentFields(item);

    const user = reqUser(req, ctx);
    const idx = item.voters.indexOf(user);
    let action;
    if (idx >= 0) { item.voters.splice(idx, 1); action = 'removed'; }
    else          { item.voters.push(user);    action = 'added'; }

    const autoFired = action === 'added' ? autoFireIfQuorum(ctx, type, item) : null;
    persistArtifact(ctx.rec, type, ctx.rec.artifacts[type]);
    res.json({
      ok: true,
      item,
      action,
      threshold: AUTO_EXECUTE_VOTE_THRESHOLD,
      autoFired: !!(autoFired && autoFired.fired),
      note: autoFired && autoFired.err ? autoFired.err : null,
    });
  });

  app.post('/sessions/:id/artifact/comment', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    const text = String((req.body && req.body.text) || '').trim();
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (type === 'arch') return res.status(400).json({ error: 'arch items can\'t be commented' });
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    if (!text) return res.status(400).json({ error: 'comment text required' });
    if (text.length > COMMENT_TEXT_MAX) return res.status(400).json({ error: `comment too long (max ${COMMENT_TEXT_MAX} chars)` });

    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    ensureVoterAndCommentFields(item);

    const comment = {
      id: crypto.randomBytes(6).toString('hex'),
      user: reqUser(req, ctx),
      text,
      ts: new Date().toISOString(),
    };
    item.comments.push(comment);
    if (item.comments.length > COMMENTS_PER_ITEM_MAX) {
      item.comments = item.comments.slice(-COMMENTS_PER_ITEM_MAX);
    }
    persistArtifact(ctx.rec, type, ctx.rec.artifacts[type]);
    res.json({ ok: true, comment, item });
  });

  app.delete('/sessions/:id/artifact/item', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (type === 'arch') return res.status(400).json({ error: 'arch has no items' });
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const artifact = ctx.rec.artifacts && ctx.rec.artifacts[type];
    if (!artifact || !Array.isArray(artifact.items)) return res.status(404).json({ error: 'no items' });
    const before = artifact.items.length;
    artifact.items = artifact.items.filter((it) => it.id !== itemId);
    if (artifact.items.length === before) return res.status(404).json({ error: 'no such item' });
    persistArtifact(ctx.rec, type, artifact);
    res.json({ ok: true, artifact });
  });

  app.delete('/sessions/:id/artifact/comment', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    const commentId = String(req.query.commentId || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (!itemId || !commentId) return res.status(400).json({ error: 'itemId + commentId required' });

    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    ensureVoterAndCommentFields(item);
    const user = reqUser(req, ctx);
    const isOwner = ctx.rec.user === user;
    const before = item.comments.length;
    // Authors can delete their own; session owner can delete any.
    item.comments = item.comments.filter((c) => !(c.id === commentId && (c.user === user || isOwner)));
    if (item.comments.length === before) return res.status(403).json({ error: 'not your comment' });
    persistArtifact(ctx.rec, type, ctx.rec.artifacts[type]);
    res.json({ ok: true, item });
  });
}

module.exports = { register, ARTIFACT_TYPES, AUTO_EXECUTE_VOTE_THRESHOLD, buildArtifactRunText, buildArtifactQuorumText };
