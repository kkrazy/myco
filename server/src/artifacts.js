// Plan / Arch / Test artifact routes.
//
// Server-side extraction of pending todos, architectural notes, and test
// plans from the running session's JSONL transcript via the Anthropic API
// (extractor.callClaudeCli). Stored under rec.artifacts[type] on the
// session record. Checking a Plan item or hitting the per-item quorum
// dispatches it back to the running Claude session via the canonical
// chat-message path in attach.handleChatMessage — the dispatched text
// carries a `[run:<type>#<id>]` marker which attach.js uses to bind the
// next turn_result's outcome (status + cost + summary + final text) to
// the originating item's runs[] + comments[].

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { extractArtifact } = require('./extractor');
const { saveStore, isOwnerOrAdmin } = require('./sessions');
const runQueue = require('./runQueue');

const ARTIFACT_TYPES = ['plan', 'arch', 'test'];

// Type glyph used in the chat-message title when an artifact item is
// dispatched. Mirrors the chrome buttons in index.html (📋/🧪/🏗️) so
// the chat row visually matches the artifact pane the item came from.
const ARTIFACT_TYPE_GLYPH = { plan: '📋', test: '🧪', arch: '🏗️' };

// Build the text that lands in BOTH the chat history (for viewer
// awareness) AND the running Claude session as a user message. The
// dispatched text is what claude will execute on, so we want it short
// and direct — comments come last so they augment, not bury, the
// instruction. A `[run:<type>#<id>]` marker (added by the client when
// it composes the dispatch, see web/public/app.js onArtifactItemRun)
// is what binds the eventual turn_result back to this item; the text
// the server emits is the human-readable body.
//
//   [📋 Plan item · submitted by @kkrazy]
//   {item.text}
//
//   Comments:
//   - @alice: …
//   - @bob: …
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
  // fr-48 bugfix: prepend the [run:<type>#<id>] marker. attach.js
  // handleChatMessage parses this marker to set session._activeRunItem,
  // which is what the agent-event listener uses to bind subsequent
  // terminal events (turn_result / iteration_aborted / fatal) back to
  // the queue entry. WITHOUT this marker the queue dispatch path never
  // set _activeRunItem and queue entries stayed `running` forever.
  // Conditional on item.id being truthy — guards legacy / synthetic
  // call sites that build dispatch text without a backing plan item.
  const runMarkerPrefix = item && item.id ? `[run:${type}#${item.id}] ` : '';
  const header = `${runMarkerPrefix}[${glyph} ${_artifactLabel(type)} · submitted by @${user}]`;
  return [header, item.text || '', ..._artifactCommentsBlock(item)].join('\n');
}
function buildArtifactQuorumText(type, item) {
  const glyph = ARTIFACT_TYPE_GLYPH[type] || '·';
  const voters = (item.voters || []).map((v) => `@${v}`).join(', ');
  // fr-48 bugfix: same marker prepend (conditional on id) as
  // buildArtifactRunText — the quorum auto-fire goes through the same
  // handleChatMessage path and needs _activeRunItem set.
  const runMarkerPrefix = item && item.id ? `[run:${type}#${item.id}] ` : '';
  const header = `${runMarkerPrefix}[${glyph} ${_artifactLabel(type)} · quorum reached (${(item.voters || []).length} voters: ${voters})]`;
  return [header, item.text || '', ..._artifactCommentsBlock(item)].join('\n');
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

// Directory names skipped when scanning for a nested project root.
// Keeps the scan cheap and avoids latching onto non-project dirs.
// Names starting with `.` are also skipped.
const NESTED_SCAN_SKIP = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'target',
  '__pycache__', 'coverage', '.cache', '.next', '.nuxt',
]);

// Locate the project root that owns _myco_/ for this session. The
// project is identified by a `.git/` directory — that's the unambiguous
// marker that "this directory is a checked-out repo." Two supported
// layouts:
//
//   1. Session.absCwd IS the project root:
//        /wks/kkrazy/myco/.git/
//        /wks/kkrazy/myco/_myco_/plan.json
//
//   2. Session.absCwd is a workspace ABOVE the project — the project
//      lives one level deeper, matching <wks>/<user>/<session>/<project>:
//        /wks/kkrazy/myco2/myco/.git/
//        /wks/kkrazy/myco2/myco/_myco_/plan.json
//
// When neither layout has a .git/ — i.e. the session's cwd isn't a
// repo and doesn't contain a repo — return null. The artifact code
// then skips the file mirror entirely; there's no project to share
// with, so writing _myco_/ would be meaningless.
function findProjectRoot(rec) {
  if (!rec || !rec.absCwd) return null;
  // Direct hit: session.absCwd is itself a checkout.
  try {
    if (fs.statSync(path.join(rec.absCwd, '.git')).isDirectory()) return rec.absCwd;
  } catch {}
  // Nested hit: find the immediate subdir that's a checkout.
  // Alphabetical for determinism when multiple repos share a workspace.
  try {
    const entries = fs.readdirSync(rec.absCwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NESTED_SCAN_SKIP.has(d.name))
      .map((d) => d.name)
      .sort();
    for (const name of entries) {
      try {
        if (fs.statSync(path.join(rec.absCwd, name, '.git')).isDirectory()) {
          return path.join(rec.absCwd, name);
        }
      } catch {}
    }
  } catch {}
  return null;
}

function resolveMycoDir(rec) {
  const projectRoot = findProjectRoot(rec);
  if (!projectRoot) return null;
  return path.join(projectRoot, MYCO_DIR);
}

function mycoDirPath(rec) {
  return resolveMycoDir(rec);
}

function artifactFilePath(rec, type) {
  const dir = mycoDirPath(rec);
  if (!dir) return null;
  const fname = ARTIFACT_FILE_BY_TYPE[type];
  if (!fname) return null;
  return path.join(dir, fname);
}

function legacyArchFilePath(rec) {
  const projectRoot = findProjectRoot(rec);
  if (!projectRoot) return null;
  return path.join(projectRoot, LEGACY_ARCH_FILE);
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

// Plan items only — see autoFireIfQuorum below. Two distinct voters
// auto-dispatch the run; arch is unactionable, test items don't run.
const AUTO_EXECUTE_VOTE_THRESHOLD = 2;
const COMMENT_TEXT_MAX = 1000;
const COMMENTS_PER_ITEM_MAX = 50;

// fr-76: per-item AI chat. Each plan item carries its own
// conversation thread (it.aiChat[]) separate from human-to-human
// comments (it.comments[]). The thread persists in plan.json
// → git → travels with the project. Future teammates clone the
// repo and inherit every decision made on every item.
//
// Schema per turn: { id, user, role: 'user'|'agent', text, ts, meta? }
//   - id        — 12-hex random, for delete/edit if added later
//   - user      — myco-login string (the requesting human, even for
//                  agent turns — captures who initiated)
//   - role      — 'user' for human-initiated, 'agent' for SDK response
//   - text      — the message body (markdown-safe)
//   - ts        — ISO timestamp
//   - meta      — optional: { kind, runId, tokens, costUsd, ... }
//
// Caps: AI_CHAT_TEXT_MAX is 10× comments (chat turns can be longer
// answers / code blocks); AI_CHAT_PER_ITEM_MAX of 100 turns gives
// long but bounded conversations. Tail-trim on overflow (oldest
// dropped first), same pattern as comments.
const AI_CHAT_TEXT_MAX = 10000;
const AI_CHAT_PER_ITEM_MAX = 100;

function emptyArtifact(type) {
  if (type === 'arch') return { markdown: '', updatedAt: null };
  return { items: [], updatedAt: null };
}

// "Does this artifact carry real content worth mirroring to disk?"
// Gates the backfill-on-first-read path so we don't litter a project
// with empty _myco_/plan.json files just because a viewer flipped to
// the Plan tab on a session that's never had any items.
function _artifactHasContent(artifact) {
  if (!artifact) return false;
  if (Array.isArray(artifact.items) && artifact.items.length > 0) return true;
  if (typeof artifact.markdown === 'string' && artifact.markdown.trim()) return true;
  return false;
}

// Mutation endpoints (refresh / run / mark / vote / comment / plan-merge /
// delete-item / delete-comment) operate on rec.artifacts[type] — which
// can drift away from the on-disk _myco_/<type>.<ext> file when:
//   - the project is on a different host and the file was edited
//     externally (git pull, hand-edit),
//   - or the absCwd is a wrapper dir whose <project>/_myco_/ was never
//     loaded into memory because no GET /artifact ever ran in this
//     server lifetime.
// Resolution: at the TOP of every mutation, refresh rec.artifacts[type]
// from the file if the file has content. The file is the version-
// controlled source of truth; in-memory just shadows it. No file write,
// no saveStore — the caller's mutation will write through both via
// persistArtifact when it finishes.
function _loadArtifactIntoRecFromFile(rec, type) {
  if (!rec || !type) return;
  const fromFile = readArtifactFromFile(rec, type);
  if (!fromFile) return;
  const prev = rec.artifacts && rec.artifacts[type];
  const prevCount = prev && Array.isArray(prev.items) ? prev.items.length : 0;
  const nextCount = Array.isArray(fromFile.items) ? fromFile.items.length : 0;
  if (!rec.artifacts) rec.artifacts = {};
  rec.artifacts[type] = fromFile;
  if (prevCount !== nextCount) {
    console.log(`[artifact] sync ${type} rec.artifacts from file (${prevCount} → ${nextCount} items, sid=${rec.id || '?'})`);
  }
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

// fr-76: lazy-init item.aiChat — separate from comments because the
// thread has a distinct lifecycle (multi-turn agent conversation,
// not free-form human commentary).
function ensureAiChatField(item) {
  if (!Array.isArray(item.aiChat)) item.aiChat = [];
}

// fr-76: append a turn to the per-item chat, tail-trimming on overflow.
// Returns the inserted turn (with id stamped) so callers can echo it
// back on the wire. Caller is responsible for persist + broadcast.
function appendAiChatTurn(item, turn) {
  ensureAiChatField(item);
  const stamped = {
    id: crypto.randomBytes(6).toString('hex'),
    user: String(turn.user || ''),
    role: turn.role === 'agent' ? 'agent' : 'user',
    text: String(turn.text || ''),
    ts: turn.ts || new Date().toISOString(),
    ...(turn.meta ? { meta: turn.meta } : {}),
  };
  item.aiChat.push(stamped);
  if (item.aiChat.length > AI_CHAT_PER_ITEM_MAX) {
    item.aiChat = item.aiChat.slice(-AI_CHAT_PER_ITEM_MAX);
  }
  return stamped;
}

// fr-76: read the full or paginated chat history.
//   opts.afterTs  — return only turns with ts > afterTs (for live tail)
//   opts.limit    — max turns returned (default: all)
// No filtering by role — both user + agent turns return.
function getAiChatHistory(item, opts) {
  ensureAiChatField(item);
  const { afterTs, limit } = (opts || {});
  let out = item.aiChat;
  if (afterTs) out = out.filter((t) => t && t.ts && t.ts > afterTs);
  if (typeof limit === 'number' && limit > 0 && out.length > limit) {
    out = out.slice(-limit);
  }
  return out;
}

function reqUser(req, ctx) { return req.user || ctx.rec.user || 'unknown'; }

// fr-88 migration 3: shared vote-toggle helper used by BOTH the HTTP
// POST /artifact/vote route AND the new mcp__myco__vote_item tool.
// Toggles user presence in item.voters (idempotent — re-voting is
// removal); returns the action ('added' | 'removed') so the caller
// can decide whether to invoke auto-fire (HTTP route does;
// mcp tool does NOT — agents shouldn't trigger auto-quorum dispatch
// via tool, that's a social signal not an agent action).
function toggleVote(sessionId, type, itemId, user) {
  if (!ARTIFACT_TYPES.includes(type)) {
    return { ok: false, error: 'unknown type', status: 400 };
  }
  if (type === 'arch') {
    return { ok: false, error: 'arch items can\'t be voted on', status: 400 };
  }
  if (!itemId) {
    return { ok: false, error: 'itemId required', status: 400 };
  }
  if (!user) {
    return { ok: false, error: 'user required', status: 400 };
  }
  const sessionsMod = require('./sessions');
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return { ok: false, error: 'session not found', status: 404 };
  _loadArtifactIntoRecFromFile(rec, type);
  const item = findItem(rec, type, itemId);
  if (!item) return { ok: false, error: 'no such item', status: 404 };
  ensureVoterAndCommentFields(item);
  const idx = item.voters.indexOf(user);
  let action;
  if (idx >= 0) { item.voters.splice(idx, 1); action = 'removed'; }
  else          { item.voters.push(user);    action = 'added'; }
  persistArtifact(rec, type, rec.artifacts[type]);
  return { ok: true, item, action, artifact: rec.artifacts[type] };
}

// fr-88 migration 2: shared item-done helper used by BOTH the HTTP
// POST /artifact/mark route AND the new mcp__myco__set_item_done tool.
// Toggles item.done (true/false), persists rec + mirror file. Returns
// the updated artifact so the caller can broadcast. No claude
// dispatch — pure lifecycle toggle. Same {ok, item, artifact} /
// {ok:false, error, status} return shape as appendCommentToItem.
function setItemDone(sessionId, type, itemId, done) {
  if (!ARTIFACT_TYPES.includes(type)) {
    return { ok: false, error: 'unknown type', status: 400 };
  }
  if (type === 'arch') {
    return { ok: false, error: 'arch has no items', status: 400 };
  }
  if (!itemId) {
    return { ok: false, error: 'itemId required', status: 400 };
  }
  const sessionsMod = require('./sessions');
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return { ok: false, error: 'session not found', status: 404 };
  _loadArtifactIntoRecFromFile(rec, type);
  const item = findItem(rec, type, itemId);
  if (!item) return { ok: false, error: 'no such item', status: 404 };
  item.done = !!done;
  persistArtifact(rec, type, rec.artifacts[type]);
  return { ok: true, item, artifact: rec.artifacts[type] };
}

// fr-88 migration 1: shared comment-append helper used by BOTH the
// HTTP POST /artifact/comment route AND the new mcp__myco__add_comment
// tool. Single source of truth for "append a comment to an item":
// validates length + non-empty, loads the rec, finds the item,
// stamps id+ts, tail-trims at COMMENTS_PER_ITEM_MAX, persists rec +
// mirror file. Returns the appended comment + the updated artifact
// so the caller can do its own broadcast (HTTP route uses
// broadcastArtifact from the register-closure; MCP tool uses
// attach.getSession()+emit — same pattern as _appendPlanItems).
//
// Returns:
//   { ok: true,  comment, item, artifact }
//   { ok: false, error: '<message>', status: <http-style code> }
function appendCommentToItem(sessionId, type, itemId, user, text) {
  if (!ARTIFACT_TYPES.includes(type)) {
    return { ok: false, error: 'unknown type', status: 400 };
  }
  if (type === 'arch') {
    return { ok: false, error: 'arch items can\'t be commented', status: 400 };
  }
  if (!itemId) {
    return { ok: false, error: 'itemId required', status: 400 };
  }
  const cleaned = String(text || '').trim();
  if (!cleaned) {
    return { ok: false, error: 'comment text required', status: 400 };
  }
  if (cleaned.length > COMMENT_TEXT_MAX) {
    return { ok: false, error: `comment too long (max ${COMMENT_TEXT_MAX} chars)`, status: 400 };
  }
  const sessionsMod = require('./sessions');
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return { ok: false, error: 'session not found', status: 404 };
  _loadArtifactIntoRecFromFile(rec, type);
  const item = findItem(rec, type, itemId);
  if (!item) return { ok: false, error: 'no such item', status: 404 };
  ensureVoterAndCommentFields(item);
  const comment = {
    id: crypto.randomBytes(6).toString('hex'),
    user: String(user || 'unknown'),
    text: cleaned,
    ts: new Date().toISOString(),
  };
  item.comments.push(comment);
  if (item.comments.length > COMMENTS_PER_ITEM_MAX) {
    item.comments = item.comments.slice(-COMMENTS_PER_ITEM_MAX);
  }
  persistArtifact(rec, type, rec.artifacts[type]);
  return { ok: true, comment, item, artifact: rec.artifacts[type] };
}

// Wire the routes onto the express app. `deps` carries the shared auth
// preamble + the chat-dispatch hooks that live in index.js / pty.js — the
// artifact module stays decoupled from auth and PTY plumbing.
function register(app, deps) {
  const { fileApiPreamble, getPtySession, handleChatMessage } = deps;

  // Push an artifact replace to every attached client. Called from every
  // mutation route (refresh, run, mark, vote, comment, item delete) so
  // concurrent viewers see voter counts / comment threads / item lists
  // update without a round-trip. Silently no-ops if the PTY session
  // isn't tracked (cleared / exited).
  function broadcastArtifact(sessionId, type, artifact) {
    const session = getPtySession(sessionId);
    if (!session) return;
    session.emit('state-update', {
      kind: 'artifact',
      artifactType: type,
      artifact,
    });
  }

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
    // Backfill path: file is absent but rec.artifacts already has
    // content from a pre-_myco_ session (or a session that never
    // mutated since the _myco_ deploy). Eagerly write it to
    // <cwd>/_myco_/<type>.<ext> so the user sees the directory in
    // the file explorer immediately AND can `git add _myco_/` to
    // share with teammates. Without this, the dir only appears on
    // the next mutation (refresh/check/vote/comment).
    const stored = ctx.rec.artifacts && ctx.rec.artifacts[type];
    if (stored && _artifactHasContent(stored)) {
      persistArtifact(ctx.rec, type, stored);
    }
    res.json({ artifact: stored || emptyArtifact(type) });
  });

  // Re-extract via `claude -p` in the session's cwd.
  app.post('/sessions/:id/artifact/refresh', async (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    _loadArtifactIntoRecFromFile(ctx.rec, type);
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
    broadcastArtifact(ctx.id, type, artifact);
    // Plan refresh additionally runs an LLM dedupe scan over the merged
    // (user + extracted) item set and returns proposals so the client
    // can render an Apply/Dismiss callout. Failures here are non-fatal
    // — the refresh response still carries the artifact; mergeProposals
    // is just empty or annotated with an error string. See
    // slashcmds.dedupePlanItems for the prompt + JSON-parse logic.
    let mergeProposals = [];
    let mergeError = null;
    if (type === 'plan') {
      try {
        const slashcmds = require('./slashcmds');
        const result = await slashcmds.dedupePlanItems(artifact.items, ctx.rec.absCwd);
        if (result && result.error) {
          mergeError = result.error;
          console.error(`[artifact] dedupe scan returned error: ${result.error}`);
        }
        mergeProposals = (result && Array.isArray(result.groups)) ? result.groups : [];
      } catch (err) {
        mergeError = err.message;
        console.error(`[artifact] dedupe scan threw: ${err.message}`);
      }
    }
    res.json({ artifact, mergeProposals, mergeError });
  });

  // Dispatch a Plan or Test item to the running Claude session as a
  // chat message via the canonical chat pipeline (so it shows up in
  // the discussion history and broadcasts to read-only viewers). The
  // dispatched text carries the `[run:<type>#<id>]` marker so
  // attach.handleChatMessage can bind the next turn_result back to
  // this item.
  // fr-48 unification: every plan-item dispatch flows through the
  // queue. /artifact/run, the chat-pane ▶ Run button, the quorum
  // auto-fire, and the /queue slash command all funnel through
  // _enqueueAndKickIfIdle. The queue is the SINGLE source of truth
  // for "what claude is working on" — chip strip + status auto-
  // advance + pause-on-failure all come for free.
  //
  // Result: an idle queue + Run click = immediate dispatch (queue
  // kicks the head). A busy queue + Run click = appended to tail,
  // auto-dispatched on completion of the current head.
  function _enqueueAndKickIfIdle(ctx, type, itemId, user, opts = {}) {
    const item = findItem(ctx.rec, type, itemId);
    if (!item) return { ok: false, status: 404, error: 'no such item' };
    let entry;
    try {
      entry = runQueue.addToQueue(ctx.rec, itemId, type, user);
    } catch (err) {
      return { ok: false, status: 409, error: err.message };
    }
    saveStore();
    broadcastRunQueue(ctx.id, ctx.rec);
    // Kick if idle (no running entry + not paused). The turn_result
    // hook in attach.js handles all subsequent advances.
    const hasRunning = ctx.rec.runQueue.some((e) => e.status === 'running');
    if (!hasRunning && !ctx.rec.runQueuePaused) {
      const session = getPtySession(ctx.id);
      if (session) {
        try {
          runQueue.markRunning(ctx.rec, itemId);
          saveStore();
          broadcastRunQueue(ctx.id, ctx.rec);
          const dispatchText = opts.text || buildArtifactRunText(type, item, user);
          handleChatMessage(ctx.id, session, opts.dispatchUser || user, dispatchText);
        } catch (err) {
          console.error(`[runQueue] kick dispatch failed: ${err.message}`);
        }
      }
    }
    return { ok: true, entry, item, kicked: !hasRunning && !ctx.rec.runQueuePaused };
  }

  app.post('/sessions/:id/artifact/run', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    if (type === 'arch') return res.status(400).json({ error: 'arch is not actionable' });
    _loadArtifactIntoRecFromFile(ctx.rec, type);
    const user = reqUser(req, ctx);
    if (!isOwnerOrAdmin(ctx.id, user)) {
      return res.status(403).json({ error: 'dispatch requires owner or admin' });
    }
    const result = _enqueueAndKickIfIdle(ctx, type, itemId, user);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    // Preserve the pre-fr-48 response shape (item + artifact) so any
    // existing client / curl caller sees the same JSON. The new
    // `queued`/`kicked` fields are additive.
    res.json({
      ok: true,
      item: result.item,
      artifact: ctx.rec.artifacts[type],
      queued: true,
      kicked: result.kicked,
    });
  });

  // Manual check/uncheck — no dispatch.
  app.post('/sessions/:id/artifact/mark', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    const done = String(req.query.done || '') === '1';
    // fr-88 migration 2: delegate to the shared setItemDone helper.
    const result = setItemDone(ctx.id, type, itemId, done);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    broadcastArtifact(ctx.id, type, result.artifact);
    res.json({ ok: true, item: result.item });
  });

  // Toggle a vote on a Plan item; auto-dispatch the run if the per-item
  // voter set hits AUTO_EXECUTE_VOTE_THRESHOLD distinct users. Test items
  // only carry votes (no auto-fire); arch items can't be voted on.
  //
  // fr-48 unification: auto-fire flows through the queue too. The
  // quorum text (which names the voters) is passed as opts.text to
  // _enqueueAndKickIfIdle so the dispatched chat message still
  // surfaces the social context.
  function autoFireIfQuorum(ctx, type, item) {
    if (item.done) return null;
    if (type !== 'plan') return null;
    if (item.voters.length < AUTO_EXECUTE_VOTE_THRESHOLD) return null;
    const session = getPtySession(ctx.id);
    if (!session) return { err: 'session not running, vote stored but not dispatched' };
    const result = _enqueueAndKickIfIdle(ctx, type, item.id, 'auto-quorum', {
      text: buildArtifactQuorumText(type, item),
      dispatchUser: 'auto-quorum',
    });
    if (!result.ok) return { err: `dispatch failed: ${result.error}` };
    return { fired: true, queued: true, kicked: result.kicked };
  }

  app.post('/sessions/:id/artifact/vote', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    const user = reqUser(req, ctx);
    // fr-88 migration 3: delegate the vote-toggle to the shared helper.
    // Auto-fire stays in the route — it's a social-context dispatch
    // (the route's ctx + getPtySession + handleChatMessage closure
    // are needed; the agent-facing MCP tool intentionally skips it).
    const result = toggleVote(ctx.id, type, itemId, user);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    const autoFired = result.action === 'added' ? autoFireIfQuorum(ctx, type, result.item) : null;
    broadcastArtifact(ctx.id, type, result.artifact);
    res.json({
      ok: true,
      item: result.item,
      action: result.action,
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
    // fr-88 migration 1: delegate to the shared appendCommentToItem
    // helper so the MCP tool (mcp__myco__add_comment) and this HTTP
    // route exercise IDENTICAL backend logic. Two surfaces, one
    // source of truth.
    const result = appendCommentToItem(ctx.id, type, itemId, reqUser(req, ctx), text);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    broadcastArtifact(ctx.id, type, result.artifact);
    res.json({ ok: true, comment: result.comment, item: result.item });
  });

  // fr-76 Phase 1: per-item AI chat — read history.
  // GET /sessions/:id/artifact/plan/:itemId/aichat?afterTs=&limit=
  //   afterTs (ISO)  — only return turns with ts > afterTs (live tail)
  //   limit          — cap to last N turns
  // Plan items only (type fixed to 'plan' in the route — test + arch
  // don't have chat threads). Read-only — viewers can read history,
  // they're gated separately from writes (Phase 2 POST below).
  app.get('/sessions/:id/artifact/plan/:itemId/aichat', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const itemId = String(req.params.itemId || '');
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    _loadArtifactIntoRecFromFile(ctx.rec, 'plan');
    const item = findItem(ctx.rec, 'plan', itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    const afterTs = req.query.afterTs ? String(req.query.afterTs) : null;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : null;
    const turns = getAiChatHistory(item, { afterTs, limit });
    res.json({ ok: true, itemId, turns, total: (item.aiChat || []).length });
  });

  // fr-76 Phase 1: per-item AI chat — append a user-initiated turn.
  // Body: { text }
  // The agent's RESPONSE turn is appended by attach.js's agent-event
  // listener in Phase 2 (after the SDK iteration produces assistant_text).
  // Phase 1 only handles the human side — the round-trip wiring lands
  // in Phase 2.
  app.post('/sessions/:id/artifact/plan/:itemId/aichat', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const itemId = String(req.params.itemId || '');
    const text = String((req.body && req.body.text) || '').trim();
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    if (!text) return res.status(400).json({ error: 'turn text required' });
    if (text.length > AI_CHAT_TEXT_MAX) {
      return res.status(400).json({ error: `turn too long (max ${AI_CHAT_TEXT_MAX} chars)` });
    }
    _loadArtifactIntoRecFromFile(ctx.rec, 'plan');
    const item = findItem(ctx.rec, 'plan', itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    const turn = appendAiChatTurn(item, {
      user: reqUser(req, ctx),
      role: 'user',
      text,
    });
    persistArtifact(ctx.rec, 'plan', ctx.rec.artifacts.plan);
    broadcastArtifact(ctx.id, 'plan', ctx.rec.artifacts.plan);
    res.json({ ok: true, turn, item });
  });

  // Apply a merge proposal generated by the dedupe scan. Body: { ids: [...] }
  // — the listed plan items must all be the same layer (Feature/Todo/Bug).
  // The lowest-numbered prefixed id becomes the canonical; the others'
  // bodies are appended with a divider and their ids land in
  // canonical.mergedFrom. See slashcmds.mergePlanItems for the
  // mutation; this endpoint just wraps it with persist + broadcast.
  app.post('/sessions/:id/artifact/plan/merge', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
    if (!ids || ids.length < 2) {
      return res.status(400).json({ error: 'body.ids must be an array of ≥ 2 item ids' });
    }
    _loadArtifactIntoRecFromFile(ctx.rec, 'plan');
    let result;
    try {
      const slashcmds = require('./slashcmds');
      result = slashcmds.mergePlanItems(ctx.rec, ids);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    persistArtifact(ctx.rec, 'plan', ctx.rec.artifacts.plan);
    broadcastArtifact(ctx.id, 'plan', ctx.rec.artifacts.plan);
    res.json({
      ok: true,
      artifact: ctx.rec.artifacts.plan,
      merged: {
        canonical: result.canonical.id,
        absorbed: result.absorbed,
        layer: result.layer,
      },
    });
  });

  app.delete('/sessions/:id/artifact/item', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (type === 'arch') return res.status(400).json({ error: 'arch has no items' });
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    _loadArtifactIntoRecFromFile(ctx.rec, type);
    const artifact = ctx.rec.artifacts && ctx.rec.artifacts[type];
    if (!artifact || !Array.isArray(artifact.items)) return res.status(404).json({ error: 'no items' });
    const before = artifact.items.length;
    artifact.items = artifact.items.filter((it) => it.id !== itemId);
    if (artifact.items.length === before) return res.status(404).json({ error: 'no such item' });
    persistArtifact(ctx.rec, type, artifact);
    broadcastArtifact(ctx.id, type, artifact);
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
    _loadArtifactIntoRecFromFile(ctx.rec, type);

    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    ensureVoterAndCommentFields(item);
    const user = reqUser(req, ctx);
    // fr-46: extend auth to allow owner+admin to delete ANY comment (not just
    // session owner, not just author). Authors can still delete their own
    // (existing behavior preserved). Admin coverage mirrors fr-39's
    // delegated-admin model: granting /admin should include comment-deletion
    // authority over the same plan-item surface.
    const isAdmin = isOwnerOrAdmin(ctx.id, user);
    const before = item.comments.length;
    item.comments = item.comments.filter((c) => !(c.id === commentId && (c.user === user || isAdmin)));
    if (item.comments.length === before) return res.status(403).json({ error: 'not your comment and not owner/admin' });
    persistArtifact(ctx.rec, type, ctx.rec.artifacts[type]);
    broadcastArtifact(ctx.id, type, ctx.rec.artifacts[type]);
    res.json({ ok: true, item });
  });

  // fr-46: PATCH item text — edit the body of an existing plan item.
  // Auth: owner+admin only (matches fr-39 delegated-admin model). On first
  // edit we snapshot the original text into item.meta.originalText; later
  // edits don't overwrite that snapshot, so the very-first version stays
  // recoverable for audit / accidental-rewrite recovery.
  app.patch('/sessions/:id/artifact/item', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    const text = String((req.body && req.body.text) || '').trim();
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (type === 'arch') return res.status(400).json({ error: 'arch items can\'t be edited via this route' });
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 64 * 1024) return res.status(400).json({ error: `text too long (max ${64 * 1024} chars)` });
    const user = reqUser(req, ctx);
    if (!isOwnerOrAdmin(ctx.id, user)) {
      return res.status(403).json({ error: 'edit requires owner or admin' });
    }
    _loadArtifactIntoRecFromFile(ctx.rec, type);
    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    if (!item.meta) item.meta = {};
    if (item.meta.originalText === undefined) {
      item.meta.originalText = item.text;
    }
    item.text = text;
    item.meta.editedBy = user;
    item.meta.editedAt = new Date().toISOString();
    persistArtifact(ctx.rec, type, ctx.rec.artifacts[type]);
    broadcastArtifact(ctx.id, type, ctx.rec.artifacts[type]);
    res.json({ ok: true, item });
  });

  // fr-46: PATCH comment text — edit an existing comment.
  // Auth: owner+admin only. Stamps comment.meta.editedBy/editedAt so the
  // UI can render a small "edited by X at T" badge.
  app.patch('/sessions/:id/artifact/comment', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const type = String(req.query.type || '');
    const itemId = String(req.query.itemId || '');
    const commentId = String(req.query.commentId || '');
    const text = String((req.body && req.body.text) || '').trim();
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    if (!itemId || !commentId) return res.status(400).json({ error: 'itemId + commentId required' });
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > COMMENT_TEXT_MAX) return res.status(400).json({ error: `comment too long (max ${COMMENT_TEXT_MAX} chars)` });
    const user = reqUser(req, ctx);
    if (!isOwnerOrAdmin(ctx.id, user)) {
      return res.status(403).json({ error: 'edit requires owner or admin' });
    }
    _loadArtifactIntoRecFromFile(ctx.rec, type);
    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    ensureVoterAndCommentFields(item);
    const comment = item.comments.find((c) => c.id === commentId);
    if (!comment) return res.status(404).json({ error: 'no such comment' });
    comment.text = text;
    if (!comment.meta) comment.meta = {};
    comment.meta.editedBy = user;
    comment.meta.editedAt = new Date().toISOString();
    persistArtifact(ctx.rec, type, ctx.rec.artifacts[type]);
    broadcastArtifact(ctx.id, type, ctx.rec.artifacts[type]);
    res.json({ ok: true, comment, item });
  });

  // fr-48: run-queue routes. Per-session queue of plan items for
  // sequential auto-dispatch. Auth: owner+admin only (mirrors fr-46 /
  // fr-39). Auto-advance lives in attach.js's turn_result hook —
  // these routes just mutate state + broadcast.
  function broadcastRunQueue(sessionId, rec) {
    const session = getPtySession(sessionId);
    if (!session) return;
    session.emit('state-update', {
      kind: 'runQueue',
      state: runQueue.getQueueState(rec),
    });
  }

  // POST /queue/add — append a plan item to the queue. If the queue
  // is otherwise idle (no running entry, not paused), AND this is the
  // first pending entry, immediately dispatch it via the existing
  // [run:plan#<id>] marker path. This makes /queue fr-43 behave like
  // /run-then-watch from the user's POV.
  app.post('/sessions/:id/queue/add', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const itemId = String((req.body && req.body.itemId) || '').trim();
    const type = String((req.body && req.body.type) || 'plan');
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    if (!ARTIFACT_TYPES.includes(type)) return res.status(400).json({ error: 'unknown type' });
    const user = reqUser(req, ctx);
    if (!isOwnerOrAdmin(ctx.id, user)) {
      return res.status(403).json({ error: 'queue mutation requires owner or admin' });
    }
    _loadArtifactIntoRecFromFile(ctx.rec, type);
    const item = findItem(ctx.rec, type, itemId);
    if (!item) return res.status(404).json({ error: 'no such item' });
    let entry;
    try {
      entry = runQueue.addToQueue(ctx.rec, itemId, type, user);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
    saveStore();
    broadcastRunQueue(ctx.id, ctx.rec);
    // Kick the queue if idle. The attach.js turn_result hook handles
    // post-first auto-advance; we trigger the FIRST dispatch here.
    const hasRunning = ctx.rec.runQueue.some((e) => e.status === 'running');
    if (!hasRunning && !ctx.rec.runQueuePaused) {
      const session = getPtySession(ctx.id);
      if (session) {
        try {
          runQueue.markRunning(ctx.rec, itemId);
          saveStore();
          broadcastRunQueue(ctx.id, ctx.rec);
          handleChatMessage(ctx.id, session, user, buildArtifactRunText(type, item, user));
        } catch (err) {
          console.error(`[runQueue] initial dispatch failed: ${err.message}`);
        }
      }
    }
    res.json({ ok: true, entry, state: runQueue.getQueueState(ctx.rec) });
  });

  // DELETE /queue/:itemId — remove a pending entry (or drop a terminal
  // entry from history). Throws 409 if the entry is currently running.
  app.delete('/sessions/:id/queue/:itemId', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const itemId = String(req.params.itemId || '').trim();
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const user = reqUser(req, ctx);
    if (!isOwnerOrAdmin(ctx.id, user)) {
      return res.status(403).json({ error: 'queue mutation requires owner or admin' });
    }
    let removed;
    try {
      removed = runQueue.removeFromQueue(ctx.rec, itemId);
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
    if (!removed) return res.status(404).json({ error: 'no such queue entry' });
    saveStore();
    broadcastRunQueue(ctx.id, ctx.rec);
    res.json({ ok: true, state: runQueue.getQueueState(ctx.rec) });
  });

  // POST /queue/clear — drop every pending entry. Running + terminal
  // entries are preserved.
  app.post('/sessions/:id/queue/clear', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const user = reqUser(req, ctx);
    if (!isOwnerOrAdmin(ctx.id, user)) {
      return res.status(403).json({ error: 'queue mutation requires owner or admin' });
    }
    const removed = runQueue.clearQueue(ctx.rec);
    saveStore();
    broadcastRunQueue(ctx.id, ctx.rec);
    res.json({ ok: true, removed, state: runQueue.getQueueState(ctx.rec) });
  });

  // POST /queue/resume — unpause the queue (after a failure auto-pause
  // OR an explicit /qpause). If a pending entry exists, dispatch it
  // immediately (same kick-on-resume logic as the initial add path).
  app.post('/sessions/:id/queue/resume', (req, res) => {
    const ctx = fileApiPreamble(req, res, 'viewer');
    if (!ctx) return;
    const user = reqUser(req, ctx);
    if (!isOwnerOrAdmin(ctx.id, user)) {
      return res.status(403).json({ error: 'queue mutation requires owner or admin' });
    }
    runQueue.resumeQueue(ctx.rec);
    saveStore();
    broadcastRunQueue(ctx.id, ctx.rec);
    const next = runQueue.peekNextPending(ctx.rec);
    if (next) {
      const item = findItem(ctx.rec, next.type, next.itemId);
      const session = getPtySession(ctx.id);
      if (item && session) {
        try {
          runQueue.markRunning(ctx.rec, next.itemId);
          saveStore();
          broadcastRunQueue(ctx.id, ctx.rec);
          handleChatMessage(ctx.id, session, user, buildArtifactRunText(next.type, item, user));
        } catch (err) {
          console.error(`[runQueue] resume-dispatch failed: ${err.message}`);
        }
      }
    }
    res.json({ ok: true, state: runQueue.getQueueState(ctx.rec) });
  });
}

module.exports = {
  register,
  ARTIFACT_TYPES,
  AUTO_EXECUTE_VOTE_THRESHOLD,
  buildArtifactRunText,
  buildArtifactQuorumText,
  // fr-76: per-item AI chat helpers — exported so attach.js can
  // call them from the agent-event listener (Phase 2 will append
  // role='agent' turns when the SDK iteration produces assistant_text).
  AI_CHAT_TEXT_MAX,
  AI_CHAT_PER_ITEM_MAX,
  ensureAiChatField,
  appendAiChatTurn,
  getAiChatHistory,
  // fr-88 migration 1: shared append-comment helper used by both the
  // HTTP POST /artifact/comment route + the mcp__myco__add_comment tool.
  appendCommentToItem,
  COMMENT_TEXT_MAX,
  COMMENTS_PER_ITEM_MAX,
  // fr-88 migration 2: shared item-done helper used by both
  // HTTP POST /artifact/mark + mcp__myco__set_item_done.
  setItemDone,
  // fr-88 migration 3: shared vote-toggle helper used by both
  // HTTP POST /artifact/vote + mcp__myco__vote_item.
  toggleVote,
  // _myco_/ persistence helpers — exported for unit tests that exercise
  // the file-mirror path without spinning up the full express + sessions
  // plumbing. Not part of the public route surface.
  __test: {
    MYCO_DIR,
    mycoDirPath,
    resolveMycoDir,
    findProjectRoot,
    artifactFilePath,
    readArtifactFromFile,
    writeArtifactToFile,
    writeMycoReadmeIfMissing,
    readLegacyArchFromFile,
    _loadArtifactIntoRecFromFile,
  },
};
