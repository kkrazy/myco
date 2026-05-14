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

// All three artifacts (plan / test / arch) are mirrored into
// `<session-cwd>/_myco_/` so the project can be committed and shared
// across sessions. The mirror is the source of truth on read: a
// teammate cloning the repo and starting a fresh myco session sees the
// same plan items, test plan, and architecture notes that the original
// author left behind. Hand-editing the files works too — myco reads on
// the next GET and reconciles the in-memory copy.
//
// Files in _myco_/:
//   plan.json          — items + comments + voters + done state
//   test.json          — items + comments + done state (no votes)
//   architecture.md    — long-form arch markdown
//   README.md          — explainer for humans browsing the repo
//
// Backward compat: an existing root-level `<cwd>/architecture.md` (from
// the pre-_myco_ layout) is still readable as a fallback.
const MYCO_DIR = '_myco_';
const LEGACY_ARCH_FILE = 'architecture.md';   // root-of-project, pre-_myco_
const ARTIFACT_FILE_BY_TYPE = {
  plan: 'plan.json',
  test: 'test.json',
  arch: 'architecture.md',
};

function mycoDirPath(rec) {
  if (!rec || !rec.absCwd) return null;
  return path.join(rec.absCwd, MYCO_DIR);
}

function artifactFilePath(rec, type) {
  const dir = mycoDirPath(rec);
  if (!dir) return null;
  const fname = ARTIFACT_FILE_BY_TYPE[type];
  if (!fname) return null;
  return path.join(dir, fname);
}

function legacyArchFilePath(rec) {
  if (!rec || !rec.absCwd) return null;
  return path.join(rec.absCwd, LEGACY_ARCH_FILE);
}

function ensureMycoDir(rec) {
  const dir = mycoDirPath(rec);
  if (!dir) return false;
  try { fs.mkdirSync(dir, { recursive: true }); return true; }
  catch (err) {
    console.error(`[artifact] failed to mkdir ${dir}: ${err.message}`);
    return false;
  }
}

// Parse a single _myco_/<type> file off disk into the in-memory shape.
// Returns null if the file is absent OR malformed (JSON parse failure on
// plan/test). Arch gets a synthetic updatedAt from the file mtime since
// markdown doesn't carry it. Plan/test JSON should already have one,
// but we backfill from mtime if missing for sanity.
function readArtifactFromFile(rec, type) {
  const p = artifactFilePath(rec, type);
  if (!p) return null;
  let stat, body;
  try { stat = fs.statSync(p); body = fs.readFileSync(p, 'utf8'); }
  catch { return null; }
  if (type === 'arch') {
    return { markdown: body, updatedAt: new Date(stat.mtimeMs).toISOString() };
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.items)) return null;
    if (!parsed.updatedAt) parsed.updatedAt = new Date(stat.mtimeMs).toISOString();
    return parsed;
  } catch (err) {
    console.error(`[artifact] failed to parse ${p}: ${err.message}`);
    return null;
  }
}

function writeArtifactToFile(rec, type, artifact) {
  if (!artifact) return false;
  if (!ensureMycoDir(rec)) return false;
  const p = artifactFilePath(rec, type);
  if (!p) return false;
  try {
    const body = type === 'arch'
      ? String(artifact.markdown || '')
      : JSON.stringify(artifact, null, 2) + '\n';
    fs.writeFileSync(p, body);
    return true;
  } catch (err) {
    console.error(`[artifact] failed to write ${p}: ${err.message}`);
    return false;
  }
}

// One-shot README explaining what _myco_/ is. Written lazily the first
// time the dir is created so a teammate browsing the repo via GitHub
// (or `ls`) understands what they're looking at. We DO NOT overwrite
// an existing README — the user may have customised it.
const MYCO_README_BODY = `# _myco_

This directory holds the **plan / test / architecture artifacts** for this
project, surfaced by [myco](https://github.com/kkrazy/myco) (the Claude
Code dashboard).

Files here are safe to **commit and push** — they migrate to other
sessions (or other developers) cloning this repo.

## Files

- \`plan.json\` — open and completed plan items, including comments + voters.
- \`test.json\` — verification plan items + comments.
- \`architecture.md\` — long-form architecture notes (editable directly).

Generated and rewritten on each artifact mutation (refresh, mark, vote,
comment, item delete). Hand-editing the files is fine — myco reads them
on the next load and reconciles with the in-memory copy.
`;
function writeMycoReadmeIfMissing(rec) {
  const dir = mycoDirPath(rec);
  if (!dir) return;
  const p = path.join(dir, 'README.md');
  try { if (fs.existsSync(p)) return; } catch { return; }
  try { fs.writeFileSync(p, MYCO_README_BODY); }
  catch (err) { console.error(`[artifact] failed to write README at ${p}: ${err.message}`); }
}

// Backward-compat reader for the pre-_myco_ root-level architecture.md.
// Used only when _myco_/architecture.md is absent.
function readLegacyArchFromFile(rec) {
  const p = legacyArchFilePath(rec);
  if (!p) return null;
  let stat, body;
  try { stat = fs.statSync(p); body = fs.readFileSync(p, 'utf8'); }
  catch { return null; }
  return { markdown: body, updatedAt: new Date(stat.mtimeMs).toISOString() };
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
  // Mirror to <cwd>/_myco_/<type>.<ext> so the project can be committed
  // and shared. Write happens on every mutation — files are small, and
  // a teammate cloning the repo gets the latest plan/test/arch state
  // without any session-state migration step. The README is written
  // lazily so newcomers browsing the dir understand what it is.
  writeArtifactToFile(rec, type, artifact);
  writeMycoReadmeIfMissing(rec);
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
    // Read priority for all three types:
    //   1. <cwd>/_myco_/<type>.<ext>    — canonical, version-controlled
    //   2. <cwd>/architecture.md         — pre-_myco_ legacy (arch only)
    //   3. rec.artifacts[type]           — in-memory state-dir fallback
    // When the file is present we mirror into rec.artifacts so other
    // code paths (UI cache, refresh, legacy clients) stay consistent.
    const fromFile = readArtifactFromFile(ctx.rec, type);
    if (fromFile) {
      persistArtifact(ctx.rec, type, fromFile);
      return res.json({ artifact: fromFile });
    }
    if (type === 'arch') {
      const fromLegacy = readLegacyArchFromFile(ctx.rec);
      if (fromLegacy) {
        persistArtifact(ctx.rec, type, fromLegacy);
        return res.json({ artifact: fromLegacy });
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
    // persistArtifact also mirrors to <cwd>/_myco_/<type>.<ext> on disk,
    // so a teammate cloning the repo sees the fresh extraction without
    // needing a session-state migration step.
    persistArtifact(ctx.rec, type, artifact);
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

module.exports = {
  register,
  ARTIFACT_TYPES,
  AUTO_EXECUTE_VOTE_THRESHOLD,
  buildArtifactRunText,
  buildArtifactQuorumText,
  // _myco_/ persistence helpers — exported for unit tests that exercise
  // the file-mirror path without spinning up the full express + sessions
  // plumbing. Not part of the public route surface.
  __test: {
    MYCO_DIR,
    mycoDirPath,
    artifactFilePath,
    readArtifactFromFile,
    writeArtifactToFile,
    writeMycoReadmeIfMissing,
    readLegacyArchFromFile,
  },
};
