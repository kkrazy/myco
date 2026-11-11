// fr-101 regression: plan items support a `tags: string[]` field, with
// quick add / delete affordances in the plan-item view.
//
// What's getting added (mirrored here for the red-green flip):
//
//   server/src/artifacts.js
//     - ensureVoterAndCommentFields gains: if (!Array.isArray(item.tags)) item.tags = []
//     - POST  /sessions/:id/artifact/tag  body:{ itemId, tag }
//        auth: 'authed' (same cross-user tier as vote+comment)
//        normalize: trim → lowercase; reject if !/^[a-z0-9][a-z0-9_-]{0,31}$/
//        cap: TAGS_PER_ITEM_MAX = 20 (reject if would exceed)
//        idempotent (re-adding same tag is a no-op, not a duplicate)
//        broadcasts: state-update kind:'artifact'  (via broadcastArtifact)
//     - DELETE /sessions/:id/artifact/tag?itemId=…&tag=…
//        auth: 'authed'
//        removes the (normalized) tag if present; no-op if absent
//        broadcasts: state-update kind:'artifact'
//
//   web/public/app.js  (renderItem ≈ line 10645)
//     - tag-chip strip rendered between byLine and actionsRow
//     - .artifact-item-tags  container
//     - .artifact-tag         chip
//     - .artifact-tag-remove  × button (DELETE the tag)
//     - .artifact-tag-add-btn “+ tag” button toggles inline input
//     - .artifact-tag-add-input  Enter / blur → POST the tag
//
//   web/public/styles.css
//     - .artifact-item-tags / .artifact-tag / .artifact-tag-remove /
//       .artifact-tag-add-btn / .artifact-tag-add-input rules
//
// Tests below: pure JS unit tests over a mirror of the server handler,
// plus static-grep guards on the production source surface.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// ── Pure unit-test layer ─────────────────────────────────────────────
// Inlined FIXED behavior — mirrors what artifacts.js must implement.

const TAGS_PER_ITEM_MAX = 20;
const TAG_MAX_LEN = 32;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function normalizeTag(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (t.length > TAG_MAX_LEN) return null;
  if (!TAG_PATTERN.test(t)) return null;
  return t;
}

function ensureTagsField(item) {
  if (!Array.isArray(item.tags)) item.tags = [];
}

function addTag(rec, type, itemId, tag) {
  const artifact = rec.artifacts && rec.artifacts[type];
  if (!artifact || !Array.isArray(artifact.items)) return { status: 404, error: 'no items' };
  const item = artifact.items.find((it) => it.id === itemId);
  if (!item) return { status: 404, error: 'no such item' };
  ensureTagsField(item);
  const norm = normalizeTag(tag);
  if (!norm) return { status: 400, error: 'invalid tag' };
  if (item.tags.includes(norm)) return { status: 200, item, action: 'noop' };
  if (item.tags.length >= TAGS_PER_ITEM_MAX) {
    return { status: 400, error: `too many tags (max ${TAGS_PER_ITEM_MAX})` };
  }
  item.tags.push(norm);
  return { status: 200, item, action: 'added' };
}

function removeTag(rec, type, itemId, tag) {
  const artifact = rec.artifacts && rec.artifacts[type];
  if (!artifact || !Array.isArray(artifact.items)) return { status: 404, error: 'no items' };
  const item = artifact.items.find((it) => it.id === itemId);
  if (!item) return { status: 404, error: 'no such item' };
  ensureTagsField(item);
  const norm = normalizeTag(tag);
  if (!norm) return { status: 400, error: 'invalid tag' };
  const before = item.tags.length;
  item.tags = item.tags.filter((tt) => tt !== norm);
  return { status: 200, item, action: item.tags.length < before ? 'removed' : 'noop' };
}

// ── Test fixtures ────────────────────────────────────────────────────

function mkRec({ items = [] } = {}) {
  return {
    user: 'kkrazy',
    artifacts: { plan: { items } },
  };
}

function mkItem(id, opts = {}) {
  return {
    id,
    text: opts.text || 'an item',
    layer: opts.layer || 'Feature',
    done: !!opts.done,
    voters: opts.voters || [],
    comments: opts.comments || [],
    ...(opts.tags ? { tags: opts.tags } : {}),
  };
}

console.log('── fr-101: plan-item tags (add + remove + render) ──');

// ── normalizeTag ─────────────────────────────────────────────────────

t('normalize: trims + lowercases', () => {
  assert.strictEqual(normalizeTag('  Frontend  '), 'frontend');
  assert.strictEqual(normalizeTag('AUTH'), 'auth');
});

t('normalize: collapses common casings to single value (idempotency)', () => {
  assert.strictEqual(normalizeTag('Frontend'), normalizeTag('frontend'));
  assert.strictEqual(normalizeTag('Frontend'), normalizeTag('FRONTEND'));
});

t('normalize: allows lowercase ascii + digits + - + _', () => {
  assert.strictEqual(normalizeTag('mobile-only'), 'mobile-only');
  assert.strictEqual(normalizeTag('v2_release'), 'v2_release');
  assert.strictEqual(normalizeTag('a1b2c3'), 'a1b2c3');
});

t('normalize: rejects whitespace-only / empty / null', () => {
  assert.strictEqual(normalizeTag(''), null);
  assert.strictEqual(normalizeTag('   '), null);
  assert.strictEqual(normalizeTag(null), null);
  assert.strictEqual(normalizeTag(undefined), null);
});

t('normalize: rejects punctuation/whitespace inside the tag', () => {
  assert.strictEqual(normalizeTag('hello world'), null);
  assert.strictEqual(normalizeTag('foo.bar'), null);
  assert.strictEqual(normalizeTag('foo/bar'), null);
  assert.strictEqual(normalizeTag('#frontend'), null);
});

t('normalize: rejects leading - or _ (tag must start with [a-z0-9])', () => {
  assert.strictEqual(normalizeTag('-foo'), null);
  assert.strictEqual(normalizeTag('_foo'), null);
});

t('normalize: rejects tags > 32 chars', () => {
  assert.strictEqual(normalizeTag('a'.repeat(32)), 'a'.repeat(32));
  assert.strictEqual(normalizeTag('a'.repeat(33)), null);
});

// ── addTag ───────────────────────────────────────────────────────────

t('add: adds a normalized tag', () => {
  const rec = mkRec({ items: [mkItem('fr-101')] });
  const res = addTag(rec, 'plan', 'fr-101', 'Frontend');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.action, 'added');
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, ['frontend']);
});

t('add: is idempotent — same tag twice = single entry', () => {
  const rec = mkRec({ items: [mkItem('fr-101', { tags: ['frontend'] })] });
  const res = addTag(rec, 'plan', 'fr-101', 'frontend');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.action, 'noop');
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, ['frontend']);
});

t('add: idempotent across case (Frontend + frontend = one)', () => {
  const rec = mkRec({ items: [mkItem('fr-101', { tags: ['frontend'] })] });
  const res = addTag(rec, 'plan', 'fr-101', 'FRONTEND');
  assert.strictEqual(res.action, 'noop');
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, ['frontend']);
});

t('add: rejects invalid tag with 400', () => {
  const rec = mkRec({ items: [mkItem('fr-101')] });
  assert.strictEqual(addTag(rec, 'plan', 'fr-101', '').status, 400);
  assert.strictEqual(addTag(rec, 'plan', 'fr-101', 'has spaces').status, 400);
  assert.strictEqual(addTag(rec, 'plan', 'fr-101', '#nope').status, 400);
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, []);
});

t('add: rejects tag > 32 chars with 400', () => {
  const rec = mkRec({ items: [mkItem('fr-101')] });
  const res = addTag(rec, 'plan', 'fr-101', 'a'.repeat(40));
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, []);
});

t('add: 404 on unknown item id', () => {
  const rec = mkRec({ items: [mkItem('fr-101')] });
  assert.strictEqual(addTag(rec, 'plan', 'fr-NOPE', 'foo').status, 404);
});

t('add: caps at TAGS_PER_ITEM_MAX', () => {
  const initial = Array.from({ length: TAGS_PER_ITEM_MAX }, (_, i) => `t${i}`);
  const rec = mkRec({ items: [mkItem('fr-101', { tags: initial })] });
  const res = addTag(rec, 'plan', 'fr-101', 'overflow');
  assert.strictEqual(res.status, 400, 'must reject the (N+1)th tag');
  assert.strictEqual(rec.artifacts.plan.items[0].tags.length, TAGS_PER_ITEM_MAX);
});

t('add: lazy-initializes tags=[] on a legacy item with no tags field', () => {
  // Legacy item — no tags field at all.
  const item = { id: 'fr-101', text: 'x', layer: 'Feature', done: false };
  const rec = mkRec({ items: [item] });
  const res = addTag(rec, 'plan', 'fr-101', 'foo');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(item.tags, ['foo'], 'tags array must be created on first write');
});

// ── removeTag ────────────────────────────────────────────────────────

t('remove: drops the tag', () => {
  const rec = mkRec({ items: [mkItem('fr-101', { tags: ['frontend', 'auth'] })] });
  const res = removeTag(rec, 'plan', 'fr-101', 'auth');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.action, 'removed');
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, ['frontend']);
});

t('remove: normalizes before matching (FRONTEND removes frontend)', () => {
  const rec = mkRec({ items: [mkItem('fr-101', { tags: ['frontend'] })] });
  removeTag(rec, 'plan', 'fr-101', 'FRONTEND');
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, []);
});

t('remove: missing tag is a no-op (not an error)', () => {
  const rec = mkRec({ items: [mkItem('fr-101', { tags: ['frontend'] })] });
  const res = removeTag(rec, 'plan', 'fr-101', 'auth');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.action, 'noop');
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, ['frontend']);
});

t('remove: 400 on invalid tag string', () => {
  const rec = mkRec({ items: [mkItem('fr-101', { tags: ['frontend'] })] });
  assert.strictEqual(removeTag(rec, 'plan', 'fr-101', '').status, 400);
  assert.deepStrictEqual(rec.artifacts.plan.items[0].tags, ['frontend']);
});

t('remove: 404 on unknown item id', () => {
  const rec = mkRec({ items: [mkItem('fr-101', { tags: ['frontend'] })] });
  assert.strictEqual(removeTag(rec, 'plan', 'fr-NOPE', 'frontend').status, 404);
});

// ── Static-grep guards: anchor production surface ────────────────────

const PROD_ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');
const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const PROD_CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

// Re-use the same route-slicer idiom fr-46 uses (next-route OR
// module.exports). Pattern note: per CLAUDE.md §10.b, don't slice with
// a hand-picked N — anchor to the NEXT route boundary instead.
function _sliceArtifactsRoute(src, verbAndPath) {
  const startRe = new RegExp(
    'app\\.' + verbAndPath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&'));
  const start = src.search(startRe);
  if (start === -1) return null;
  const rest = src.slice(start);
  const nextRoute = rest.slice(1).search(/\napp\.(get|post|patch|put|delete)\(|\nmodule\.exports/);
  return nextRoute === -1 ? rest : rest.slice(0, nextRoute + 1);
}

t('artifacts.js declares POST /sessions/:id/artifact/tag route', () => {
  assert.match(PROD_ARTIFACTS, /app\.post\(\s*['"`]\/sessions\/:id\/artifact\/tag['"`]/,
    'POST /sessions/:id/artifact/tag route must exist (add-tag endpoint)');
});

t('artifacts.js declares DELETE /sessions/:id/artifact/tag route', () => {
  assert.match(PROD_ARTIFACTS, /app\.delete\(\s*['"`]\/sessions\/:id\/artifact\/tag['"`]/,
    'DELETE /sessions/:id/artifact/tag route must exist (remove-tag endpoint)');
});

t('artifacts.js add-tag route uses \'authed\' tier (cross-user, same as vote+comment)', () => {
  const body = _sliceArtifactsRoute(PROD_ARTIFACTS, "post\\(\\s*['\"`]/sessions/:id/artifact/tag['\"`]");
  assert.ok(body, 'POST tag route body must be locatable');
  assert.ok(/fileApiPreamble\(req,\s*res,\s*['"`]authed['"`]\)/.test(body),
    'add-tag must use the \'authed\' tier so any signed-in user can tag (matches vote+comment)');
});

t('artifacts.js add-tag route broadcasts artifact via broadcastArtifact', () => {
  const body = _sliceArtifactsRoute(PROD_ARTIFACTS, "post\\(\\s*['\"`]/sessions/:id/artifact/tag['\"`]");
  assert.ok(body);
  assert.ok(/broadcastArtifact\(/.test(body),
    'add-tag must broadcastArtifact so cross-device clients re-render');
  assert.ok(/persistArtifact\(/.test(body),
    'add-tag must persistArtifact so the change survives restarts');
});

t('artifacts.js remove-tag route broadcasts artifact via broadcastArtifact', () => {
  const body = _sliceArtifactsRoute(PROD_ARTIFACTS, "delete\\(\\s*['\"`]/sessions/:id/artifact/tag['\"`]");
  assert.ok(body, 'DELETE tag route body must be locatable');
  assert.ok(/broadcastArtifact\(/.test(body),
    'remove-tag must broadcastArtifact so cross-device clients re-render');
  assert.ok(/persistArtifact\(/.test(body),
    'remove-tag must persistArtifact so the change survives restarts');
});

t('artifacts.js ensures item.tags is initialized lazily (no schema migration needed)', () => {
  // The fix can either extend ensureVoterAndCommentFields or add a
  // sibling ensureTagsField — both names are acceptable. What MUST be
  // true: the file contains an `item.tags = []` initializer guarded by
  // !Array.isArray(item.tags).
  assert.ok(
    /!Array\.isArray\(item\.tags\)\s*\)\s*item\.tags\s*=\s*\[\]/.test(PROD_ARTIFACTS),
    'artifacts.js must lazy-init item.tags = [] for legacy items (guarded by !Array.isArray)');
});

t('app.js renders the tag-chip strip on plan items', () => {
  assert.ok(/artifact-item-tags/.test(PROD_APP),
    'app.js must render an .artifact-item-tags container in the plan-item card');
  assert.ok(/artifact-tag-remove/.test(PROD_APP),
    'app.js must render .artifact-tag-remove × buttons (delete affordance)');
  assert.ok(/artifact-tag-add-btn/.test(PROD_APP),
    'app.js must render an .artifact-tag-add-btn “+ tag” affordance');
  assert.ok(/artifact-tag-add-input/.test(PROD_APP),
    'app.js must render an .artifact-tag-add-input field for typing new tags');
});

t('app.js sets maxlength=32 on the tag-add input (matches server cap)', () => {
  // Tag-add input must not let users type past the server cap. We
  // anchor to artifact-tag-add-input then look for a maxlength attr in
  // the same tag declaration. Using a tight here-string of the input
  // tag avoids the §10.b slice-with-N anti-pattern.
  const m = PROD_APP.match(/<input[^>]*artifact-tag-add-input[^>]*>/);
  assert.ok(m, '.artifact-tag-add-input <input> must be located');
  assert.ok(/maxlength=["']?32["']?/.test(m[0]),
    '.artifact-tag-add-input must carry maxlength="32" to match the server cap');
});

t('app.js POSTs new tag to /artifact/tag endpoint', () => {
  // The add-handler must fire POST to /artifact/tag. Multiline check
  // because the URL + method live on separate lines after the
  // authedFetch( call (same pattern as fr-46).
  assert.match(PROD_APP, /artifact\/tag[\s\S]{0,800}?method:\s*['"`]POST['"`]/,
    'app.js must POST /sessions/.../artifact/tag from the tag-add handler');
});

t('app.js DELETEs tag from /artifact/tag endpoint', () => {
  assert.match(PROD_APP, /artifact\/tag[\s\S]{0,800}?method:\s*['"`]DELETE['"`]/,
    'app.js must DELETE /sessions/.../artifact/tag from the tag-remove handler');
});

t('styles.css carries tag-chip styling', () => {
  assert.ok(/\.artifact-item-tags\b/.test(PROD_CSS),
    'styles.css must declare a .artifact-item-tags rule');
  assert.ok(/\.artifact-tag\b/.test(PROD_CSS),
    'styles.css must declare an .artifact-tag chip rule');
  assert.ok(/\.artifact-tag-remove\b/.test(PROD_CSS),
    'styles.css must declare an .artifact-tag-remove × button rule');
  assert.ok(/\.artifact-tag-add(-btn|-input)\b/.test(PROD_CSS),
    'styles.css must declare an .artifact-tag-add-btn or .artifact-tag-add-input rule');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
