// fr-46 regression: enable editing item body text + editing/deleting
// individual comments on plan items. Auth gated to owner+admin only
// (matches the fr-39 delegated-admin model). Existing endpoints stay
// unchanged in behavior except DELETE comment, which gains owner+admin
// authority alongside the existing author-self-delete.
//
// New routes (added in artifacts.js):
//   - PATCH /sessions/:id/artifact/item?type=plan&itemId=X
//     body: { text: string }
//     auth: must be owner or admin (sessionsMod.isOwnerOrAdmin)
//     effect: update item.text; stamp item.meta.editedBy + .editedAt;
//             preserve item.meta.originalText on FIRST edit only
//             (later edits don't overwrite the very first version).
//     broadcast: state-update via broadcastArtifact.
//
//   - PATCH /sessions/:id/artifact/comment?type=plan&itemId=X&commentId=Y
//     body: { text: string }
//     auth: must be owner or admin
//     effect: update comment.text; stamp comment.meta.editedBy + .editedAt.
//     broadcast: state-update via broadcastArtifact.
//
//   - DELETE /sessions/:id/artifact/comment (extended):
//     existing behavior — author can delete own — preserved.
//     NEW — owner or admin can delete ANY comment.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ──────────────────────────────────────────────────────────────────────────
// Inlined FIXED behavior — mirrors what artifacts.js must implement.

function isOwnerOrAdmin(rec, user) {
  if (!rec || !user) return false;
  if (rec.user === user) return true;
  if (Array.isArray(rec.admins) && rec.admins.includes(user)) return true;
  return false;
}

// Mirror of the PATCH item handler.
function patchItem(rec, type, itemId, body, user) {
  if (!isOwnerOrAdmin(rec, user)) return { status: 403, error: 'edit requires owner or admin' };
  const text = String((body && body.text) || '').trim();
  if (!text) return { status: 400, error: 'text required' };
  if (text.length > 64 * 1024) return { status: 400, error: 'text too long' };
  const artifact = rec.artifacts && rec.artifacts[type];
  if (!artifact || !Array.isArray(artifact.items)) return { status: 404, error: 'no items' };
  const item = artifact.items.find((it) => it.id === itemId);
  if (!item) return { status: 404, error: 'no such item' };
  // Preserve the very first version on first edit only.
  if (!item.meta) item.meta = {};
  if (item.meta.originalText === undefined) {
    item.meta.originalText = item.text;
  }
  item.text = text;
  item.meta.editedBy = user;
  item.meta.editedAt = new Date().toISOString();
  return { status: 200, item };
}

// Mirror of the PATCH comment handler.
function patchComment(rec, type, itemId, commentId, body, user) {
  if (!isOwnerOrAdmin(rec, user)) return { status: 403, error: 'edit requires owner or admin' };
  const text = String((body && body.text) || '').trim();
  if (!text) return { status: 400, error: 'text required' };
  const artifact = rec.artifacts && rec.artifacts[type];
  const item = artifact && Array.isArray(artifact.items) && artifact.items.find((it) => it.id === itemId);
  if (!item) return { status: 404, error: 'no such item' };
  const comment = Array.isArray(item.comments) && item.comments.find((c) => c.id === commentId);
  if (!comment) return { status: 404, error: 'no such comment' };
  comment.text = text;
  if (!comment.meta) comment.meta = {};
  comment.meta.editedBy = user;
  comment.meta.editedAt = new Date().toISOString();
  return { status: 200, comment };
}

// Mirror of the EXTENDED DELETE comment handler — author OR owner+admin.
function deleteComment(rec, type, itemId, commentId, user) {
  const artifact = rec.artifacts && rec.artifacts[type];
  const item = artifact && Array.isArray(artifact.items) && artifact.items.find((it) => it.id === itemId);
  if (!item || !Array.isArray(item.comments)) return { status: 404, error: 'no such item' };
  const comment = item.comments.find((c) => c.id === commentId);
  if (!comment) return { status: 404, error: 'no such comment' };
  const isAuthor = comment.user === user;
  const canDelete = isAuthor || isOwnerOrAdmin(rec, user);
  if (!canDelete) return { status: 403, error: 'not your comment and not owner/admin' };
  item.comments = item.comments.filter((c) => c.id !== commentId);
  return { status: 200 };
}

// ──────────────────────────────────────────────────────────────────────────

function mkRec({ admins = [], items = [] } = {}) {
  return {
    user: 'kkrazy',
    admins,
    artifacts: { plan: { items } },
  };
}

function mkItem(id, text, comments = []) {
  return { id, text, layer: 'Feature', done: false, comments };
}

console.log('── fr-46: edit plan items (body text + comments) ──');

// ── item edit ─────────────────────────────────────────────────────────────

t('item edit: owner can edit text', () => {
  const rec = mkRec({ items: [mkItem('fr-100', 'original body')] });
  const res = patchItem(rec, 'plan', 'fr-100', { text: 'updated body' }, 'kkrazy');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.item.text, 'updated body');
});

t('item edit: admin can edit text', () => {
  const rec = mkRec({ admins: ['labxnow'], items: [mkItem('fr-100', 'original')] });
  const res = patchItem(rec, 'plan', 'fr-100', { text: 'admin edit' }, 'labxnow');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.item.text, 'admin edit');
});

t('item edit: viewer (non-owner, non-admin) gets 403', () => {
  const rec = mkRec({ items: [mkItem('fr-100', 'original')] });
  const res = patchItem(rec, 'plan', 'fr-100', { text: 'bad edit' }, 'random-viewer');
  assert.strictEqual(res.status, 403);
  // Item unchanged.
  assert.strictEqual(rec.artifacts.plan.items[0].text, 'original');
});

t('item edit: stamps meta.editedBy + meta.editedAt', () => {
  const rec = mkRec({ items: [mkItem('fr-100', 'original')] });
  const before = Date.now();
  patchItem(rec, 'plan', 'fr-100', { text: 'updated' }, 'kkrazy');
  const item = rec.artifacts.plan.items[0];
  assert.strictEqual(item.meta.editedBy, 'kkrazy');
  assert.ok(item.meta.editedAt, 'editedAt must be set');
  assert.ok(Date.parse(item.meta.editedAt) >= before, 'editedAt is a fresh ISO timestamp');
});

t('item edit: preserves meta.originalText on FIRST edit only', () => {
  const rec = mkRec({ items: [mkItem('fr-100', 'v1 original')] });
  patchItem(rec, 'plan', 'fr-100', { text: 'v2' }, 'kkrazy');
  assert.strictEqual(rec.artifacts.plan.items[0].meta.originalText, 'v1 original',
    'first edit captures the truly-original text');
  patchItem(rec, 'plan', 'fr-100', { text: 'v3' }, 'kkrazy');
  assert.strictEqual(rec.artifacts.plan.items[0].meta.originalText, 'v1 original',
    'second edit does NOT overwrite originalText — v1 stays the recorded original');
  assert.strictEqual(rec.artifacts.plan.items[0].text, 'v3', 'text reflects most recent edit');
});

t('item edit: rejects empty / whitespace-only text', () => {
  const rec = mkRec({ items: [mkItem('fr-100', 'original')] });
  assert.strictEqual(patchItem(rec, 'plan', 'fr-100', { text: '' }, 'kkrazy').status, 400);
  assert.strictEqual(patchItem(rec, 'plan', 'fr-100', { text: '   ' }, 'kkrazy').status, 400);
  assert.strictEqual(rec.artifacts.plan.items[0].text, 'original');
});

t('item edit: 404 on unknown item id', () => {
  const rec = mkRec({ items: [mkItem('fr-100', 'x')] });
  const res = patchItem(rec, 'plan', 'fr-NOPE', { text: 'x' }, 'kkrazy');
  assert.strictEqual(res.status, 404);
});

// ── comment edit ──────────────────────────────────────────────────────────

t('comment edit: owner can edit any comment', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'someone-else', text: 'oops typo', ts: 't' }]);
  const rec = mkRec({ items: [item] });
  const res = patchComment(rec, 'plan', 'fr-100', 'c1', { text: 'fixed typo' }, 'kkrazy');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(item.comments[0].text, 'fixed typo');
});

t('comment edit: admin can edit any comment', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'someone-else', text: 'wrong', ts: 't' }]);
  const rec = mkRec({ admins: ['labxnow'], items: [item] });
  const res = patchComment(rec, 'plan', 'fr-100', 'c1', { text: 'right' }, 'labxnow');
  assert.strictEqual(res.status, 200);
});

t('comment edit: viewer (not author, not owner/admin) gets 403', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'someone-else', text: 'orig', ts: 't' }]);
  const rec = mkRec({ items: [item] });
  const res = patchComment(rec, 'plan', 'fr-100', 'c1', { text: 'tampered' }, 'random-viewer');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(item.comments[0].text, 'orig');
});

t('comment edit: stamps meta.editedBy + meta.editedAt', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'x', text: 'orig', ts: 't' }]);
  const rec = mkRec({ items: [item] });
  patchComment(rec, 'plan', 'fr-100', 'c1', { text: 'updated' }, 'kkrazy');
  assert.strictEqual(item.comments[0].meta.editedBy, 'kkrazy');
  assert.ok(item.comments[0].meta.editedAt);
});

t('comment edit: 404 on unknown comment id', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'x', text: 'a', ts: 't' }]);
  const rec = mkRec({ items: [item] });
  assert.strictEqual(patchComment(rec, 'plan', 'fr-100', 'c-NOPE', { text: 'x' }, 'kkrazy').status, 404);
});

// ── comment delete (extended auth) ────────────────────────────────────────

t('comment delete: author can still delete their own (existing behavior preserved)', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'labxnow', text: 'a', ts: 't' }]);
  const rec = mkRec({ items: [item] });
  const res = deleteComment(rec, 'plan', 'fr-100', 'c1', 'labxnow');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(item.comments.length, 0);
});

t('comment delete: NEW — owner can delete any comment (incl. others\')', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'labxnow', text: 'a', ts: 't' }]);
  const rec = mkRec({ items: [item] });
  const res = deleteComment(rec, 'plan', 'fr-100', 'c1', 'kkrazy');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(item.comments.length, 0);
});

t('comment delete: NEW — admin can delete any comment', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'someone', text: 'a', ts: 't' }]);
  const rec = mkRec({ admins: ['labxnow'], items: [item] });
  const res = deleteComment(rec, 'plan', 'fr-100', 'c1', 'labxnow');
  assert.strictEqual(res.status, 200);
});

t('comment delete: random viewer (not author, not owner/admin) gets 403', () => {
  const item = mkItem('fr-100', 'x', [{ id: 'c1', user: 'labxnow', text: 'a', ts: 't' }]);
  const rec = mkRec({ items: [item] });
  const res = deleteComment(rec, 'plan', 'fr-100', 'c1', 'random-viewer');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(item.comments.length, 1, 'comment unchanged');
});

// ──────────────────────────────────────────────────────────────────────────
// Static-grep guards: anchor prod surface.

const PROD_ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

t('artifacts.js declares PATCH /sessions/:id/artifact/item route', () => {
  assert.match(PROD_ARTIFACTS, /app\.patch\(\s*['"`]\/sessions\/:id\/artifact\/item['"`]/,
    'PATCH /sessions/:id/artifact/item route must exist (item-text editing)');
});

t('artifacts.js declares PATCH /sessions/:id/artifact/comment route', () => {
  assert.match(PROD_ARTIFACTS, /app\.patch\(\s*['"`]\/sessions\/:id\/artifact\/comment['"`]/,
    'PATCH /sessions/:id/artifact/comment route must exist (comment-text editing)');
});

// Slice the artifacts.js source into per-route bodies bounded by the
// NEXT `app.<verb>(` declaration (or end-of-file). The previous lazy
// `\}\);` anchor stopped at the first `res.status(400).json({...})`
// inside the route — far before the actual auth check downstream.
function _sliceArtifactsRoute(src, verbAndPath) {
  const startRe = new RegExp(
    'app\\.' + verbAndPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'));
  const start = src.search(startRe);
  if (start === -1) return null;
  const rest = src.slice(start);
  // Next app.<verb>( declaration OR module.exports (end of register fn).
  const nextRoute = rest.slice(1).search(/\napp\.(get|post|patch|put|delete)\(|\nmodule\.exports/);
  return nextRoute === -1 ? rest : rest.slice(0, nextRoute + 1);
}

t('artifacts.js item-edit handler enforces isOwnerOrAdmin', () => {
  const body = _sliceArtifactsRoute(PROD_ARTIFACTS, "patch\\(\\s*['\"`]/sessions/:id/artifact/item['\"`]");
  assert.ok(body, 'PATCH item route body must be locatable');
  assert.ok(/isOwnerOrAdmin/.test(body),
    'PATCH item handler must gate on isOwnerOrAdmin so viewers can\'t edit');
});

t('artifacts.js comment-edit handler enforces isOwnerOrAdmin', () => {
  const body = _sliceArtifactsRoute(PROD_ARTIFACTS, "patch\\(\\s*['\"`]/sessions/:id/artifact/comment['\"`]");
  assert.ok(body, 'PATCH comment route body must be locatable');
  assert.ok(/isOwnerOrAdmin/.test(body),
    'PATCH comment handler must gate on isOwnerOrAdmin');
});

t('artifacts.js DELETE comment now allows owner+admin (in addition to author)', () => {
  const body = _sliceArtifactsRoute(PROD_ARTIFACTS, "delete\\(\\s*['\"`]/sessions/:id/artifact/comment['\"`]");
  assert.ok(body, 'DELETE comment route body must be locatable');
  assert.ok(/isOwnerOrAdmin/.test(body),
    'DELETE comment must call isOwnerOrAdmin so admins can delete others\' comments — not just author-self');
});

t('artifacts.js item-edit handler stamps meta.editedBy + originalText preservation', () => {
  const body = _sliceArtifactsRoute(PROD_ARTIFACTS, "patch\\(\\s*['\"`]/sessions/:id/artifact/item['\"`]");
  assert.ok(body);
  assert.ok(/editedBy/.test(body), 'must stamp item.meta.editedBy');
  assert.ok(/originalText/.test(body),
    'must preserve meta.originalText on first edit (so reverts / audit are possible)');
});

t('app.js calls PATCH endpoints from new edit affordances', () => {
  // The client must fire PATCH to /artifact/item AND /artifact/comment.
  // Multiline `[\s\S]*?` because the fetch URL and method: live on
  // separate lines after the authedFetch( call.
  assert.match(PROD_APP, /artifact\/item[\s\S]{0,800}?method:\s*['"`]PATCH['"`]/,
    'app.js must PATCH /sessions/.../artifact/item from the item-edit save handler');
  assert.match(PROD_APP, /artifact\/comment[\s\S]{0,800}?method:\s*['"`]PATCH['"`]/,
    'app.js must PATCH /sessions/.../artifact/comment from the comment-edit save handler');
});

t('app.js gates edit affordances on !state.readOnly (owner+admin only)', () => {
  // The pencil/trash buttons must NOT render for viewers. Easiest signal:
  // a guard on state.readOnly somewhere in the artifact-item / comment
  // render path. We look for a !state.readOnly OR state.readOnly === false
  // check that the new edit-button rendering depends on.
  assert.match(PROD_APP,
    /(!state\.readOnly|state\.readOnly\s*===\s*false|state\.readOnly\s*\?)/,
    'edit affordances must be gated on state.readOnly so viewers don\'t see pencil/trash buttons');
});

// ──────────────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
