// Per-user model-gateway profiles — regression for server/src/gateways.js +
// the SDK env overlay in agent-session.js + the /api/gateways routes.
//
// Behaviour under test:
//   - a user can save MULTIPLE named profiles and switch the active one
//   - listProfiles NEVER returns the raw authToken — only tokenSet + a
//     last-4 mask (write-only secret, same discipline as PATs)
//   - getActive returns the raw profile for the SDK overlay
//   - blank token on update keeps the existing token
//   - empty baseUrl is allowed (means "system default")
//   - profile names are validated; per-user bucket count is capped
//   - agent-session.js injects ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL + model
//     from the active profile into sdkOpts
//   - index.js exposes the /api/gateways routes

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

// Point the store at a THROWAWAY dir BEFORE requiring the module so its
// GATEWAYS_FILE constant resolves therea (module-load-time constant).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-gateways-'));
process.env.MYCO_STATE_DIR = tmpRoot;

const gateways = require('../server/src/gateways');
const GATEWAYS_FILE = path.join(tmpRoot, 'gateways.json');

const PROD_AGENT = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
const PROD_INDEX = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'index.js'), 'utf8');
const PROD_CMDS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');
const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── model-gateway profiles ──');

t('upsertProfile creates + getActive returns the raw profile for the SDK', () => {
  gateways._resetCache();
  const saved = gateways.upsertProfile('alice', 'lab', {
    baseUrl: 'http://7.216.246.115:14000', authToken: 'sk-yc-123478', model: 'DS-V4-0731',
  });
  assert.strictEqual(saved.tokenSet, true, 'saved profile reports tokenSet=true');
  const active = gateways.getActive('alice');
  assert.ok(active, 'first saved profile auto-promotes to active');
  assert.strictEqual(active.baseUrl, 'http://7.216.246.115:14000', 'SDK sees the raw baseUrl');
  assert.strictEqual(active.authToken, 'sk-yc-123478', 'SDK sees the raw authToken');
  assert.strictEqual(active.model, 'DS-V4-0731', 'SDK sees the model');
});

t('listProfiles masks the token — never returns plaintext, has last-4', () => {
  const list = gateways.listProfiles('alice');
  assert.strictEqual(list.active, 'lab', 'list reports the active profile name');
  const p = list.profiles.find((x) => x.name === 'lab');
  assert.ok(p, 'profile present in list');
  assert.strictEqual(p.tokenSet, true, 'tokenSet flag exposed');
  assert.strictEqual(p.mask, '•••3478', 'mask shows exactly the last-4');
  // No raw token anywhere in the serialised response.
  assert.ok(!JSON.stringify(list).includes('sk-yc-123478'),
    'listProfiles output must NEVER contain the raw authToken');
});

t('multiple profiles + setActive switches the active profile', () => {
  gateways.upsertProfile('alice', 'default-gw', { baseUrl: '', authToken: '', model: '' });
  assert.strictEqual(gateways.getActive('alice').name, 'lab', 'active is still lab after adding another');
  gateways.setActive('alice', 'default-gw');
  assert.strictEqual(gateways.getActive('alice').name, 'default-gw', 'setActive switches active');
  assert.strictEqual(gateways.getActive('alice').baseUrl, '', 'empty baseUrl = system default');
});

t('getProfile returns a named profile by name (per-session lookup), null when missing', () => {
  gateways._resetCache();
  gateways.upsertProfile('erin', 'lab', { baseUrl: 'http://lab:1', authToken: 't', model: 'm1' });
  // By-name lookup is INDEPENDENT of the legacy per-user `active` pointer —
  // agent-session resolves the SESSION's activeGw via getProfile, not the
  // global active. So getProfile must return the profile regardless of what
  // the global active is (even if it's a different profile).
  gateways.setActive('erin', 'lab');
  const p = gateways.getProfile('erin', 'lab');
  assert.ok(p, 'getProfile must return the named profile');
  assert.strictEqual(p.name, 'lab', 'profile name returned');
  assert.strictEqual(p.baseUrl, 'http://lab:1', 'raw baseUrl returned for the SDK overlay');
  assert.strictEqual(p.authToken, 't', 'raw authToken returned for the SDK overlay');
  assert.strictEqual(p.model, 'm1', 'raw model returned');
  assert.strictEqual(gateways.getProfile('erin', 'nope'), null, 'missing name → null');
  assert.strictEqual(gateways.getProfile('erin', ''), null, 'empty name → null');
  assert.strictEqual(gateways.getProfile('unknown-user', 'lab'), null, 'unknown user → null');
});

t('blank token on update keeps the existing token (write-only)', () => {
  gateways.setActive('alice', 'lab');
  gateways.upsertProfile('alice', 'lab', { baseUrl: 'http://x:1', authToken: '', model: 'm2' });
  const active = gateways.getActive('alice');
  assert.strictEqual(active.authToken, 'sk-yc-123478', 'blank token on update keeps the prior token');
  assert.strictEqual(active.baseUrl, 'http://x:1', 'other fields still update');
  assert.strictEqual(active.model, 'm2', 'model updates');
});

t('deleteProfile removes + clears active when it was the active profile', () => {
  gateways._resetCache();
  gateways.upsertProfile('bob', 'a', { baseUrl: 'http://a', authToken: 't', model: '' });
  assert.strictEqual(gateways.getActive('bob').name, 'a', 'first profile is active');
  assert.strictEqual(gateways.deleteProfile('bob', 'a'), true, 'delete returns true when removed');
  assert.strictEqual(gateways.getActive('bob'), null, 'active cleared when its profile is deleted');
  assert.strictEqual(gateways.deleteProfile('bob', 'nope'), false, 'delete of a missing profile → false');
});

t('deactivate resets active to null WITHOUT deleting any profile', () => {
  gateways._resetCache();
  gateways.upsertProfile('dave', 'lab', { baseUrl: 'http://lab', authToken: 't', model: '' });
  assert.strictEqual(gateways.getActive('dave').name, 'lab', 'profile auto-promoted to active');
  gateways.deactivate('dave');
  assert.strictEqual(gateways.getActive('dave'), null, 'deactivate clears active → system default');
  assert.ok(gateways.listProfiles('dave').profiles.some((p) => p.name === 'lab'),
    'deactivate must NOT delete the saved profile');
  // Idempotent when already inactive.
  gateways.deactivate('dave');
  assert.strictEqual(gateways.getActive('dave'), null, 'deactivate on already-inactive is a no-op');
});

t('invalid profile names + per-user cap are enforced', () => {
  assert.throws(() => gateways.upsertProfile('carol', 'bad name!', {}), /profile name/i,
    'spaces/symbols rejected in profile name');
  for (let i = 0; i < 19; i++) gateways.upsertProfile('carol', 'p' + i, { baseUrl: '' });
  gateways.upsertProfile('carol', 'p-last', { baseUrl: '' });
  assert.throws(() => gateways.upsertProfile('carol', 'p-over', { baseUrl: '' }), /max 20 profiles/,
    'per-user cap (20) enforced');
});

t('persists to disk as JSON with 0600 perms', () => {
  gateways._resetCache();
  assert.ok(fs.existsSync(GATEWAYS_FILE), 'gateways.json written to STATE_DIR');
  const st = fs.statSync(GATEWAYS_FILE);
  assert.strictEqual(st.mode & 0o777, 0o600, 'file mode is 0600');
  const parsed = JSON.parse(fs.readFileSync(GATEWAYS_FILE, 'utf8'));
  assert.ok(parsed.alice && parsed.alice.profiles.lab, 'on-disk shape {user:{profiles:{}}}');
});

// ──────────────────────────────────────────────────────────────────────────
// Static guards — pin the SDK overlay + routes so a future refactor can't
// silently drop the feature.

t('agent-session.js injects the active gateway into sdkOpts (env + model)', () => {
  assert.match(PROD_AGENT, /require\('\.\/gateways'\)/, 'gateways store is loaded by agent-session');
  // The gateway is resolved PER-SESSION from this.activeGw (the profile the
  // user opted into via /model gw:<name>), NOT the legacy per-user global
  // `active` — so a new session defaults to the system gateway.
  assert.match(PROD_AGENT, /getProfile\s*\(\s*this\.user\s*,\s*this\.activeGw/,
    'resolves the gateway from the SESSION activeGw (per-session), not the global active');
  assert.match(PROD_AGENT, /ANTHROPIC_BASE_URL:\s*gw\.baseUrl/, 'overlays ANTHROPIC_BASE_URL');
  assert.match(PROD_AGENT, /ANTHROPIC_AUTH_TOKEN:\s*gw\.authToken/, 'overlays ANTHROPIC_AUTH_TOKEN');
  assert.match(PROD_AGENT, /ANTHROPIC_MODEL:\s*gw\.model/, 'overlays ANTHROPIC_MODEL');
  // The gateway profile's model governs the request; when no active profile
  // (`default`), the system default from state/.env (ANTHROPIC_MODEL) is
  // used instead of the SDK's hardcoded default — NOT a stale /model
  // override (retired). The gateway model branch must come FIRST so a
  // per-user profile beats the .env default.
  assert.match(PROD_AGENT, /if\s*\(\s*gw\s*&&\s*gw\.model\s*\)\s*sdkOpts\.model\s*=\s*gw\.model\s*;\s*else\s+if\s*\(\s*process\.env\.ANTHROPIC_MODEL\s*\)/,
    'gateway model wins; else the system .env ANTHROPIC_MODEL becomes sdkOpts.model (user wants `default` to use the configured glm model)');
});

t('index.js exposes the /api/gateways routes (requireAuth-gated)', () => {
  assert.match(PROD_INDEX, /app\.get\('\/api\/gateways',\s*requireAuth/, 'GET /api/gateways');
  assert.match(PROD_INDEX, /app\.post\('\/api\/gateways'/, 'POST /api/gateways (upsert)');
  assert.match(PROD_INDEX, /app\.post\('\/api\/gateways\/activate'/, 'POST /api/gateways/activate');
  assert.match(PROD_INDEX, /app\.post\('\/api\/gateways\/test'/, 'POST /api/gateways/test');
  assert.match(PROD_INDEX, /app\.delete\('\/api\/gateways\/:name'/, 'DELETE /api/gateways/:name');
});

// ─ ─ ─ /model picker gateway integration (fr: /model reuse) ─ ─ ─
const { fnBody } = require('./_lib/fn-body');

t('handleModel carries the user gateway list in the picker state-update', () => {
  const body = fnBody(PROD_CMDS, /function\s+handleModel\s*\(/);
  assert.ok(body, 'handleModel body must be locatable');
  // Bare /model builds the reply from the ACTIVE user profile…
  assert.match(body, /gatewaysMod\.listProfiles\s*\(\s*rec\.user\s*\)/,
    'handleModel must read the session owner\'s gateway list');
  // …then hands it to the _emitModelPicker helper, which ships it in the
  // model-picker state-update as {active, profiles}.
  const emitBody = fnBody(PROD_CMDS, /function\s+_emitModelPicker\s*\(/);
  assert.ok(emitBody, '_emitModelPicker helper must exist');
  assert.match(body, /_emitModelPicker\s*\(\s*ctx\.session\s*,\s*gwList\s*\)/,
    'bare /model must call _emitModelPicker with the gateway list');
  assert.match(emitBody, /kind:\s*'model-picker'/,
    '_emitModelPicker must emit kind:"model-picker"');
  assert.match(emitBody, /gateway:\s*gwList/,
    '_emitModelPicker must carry gateway:{active,profiles} in the payload');
});

t('handleModel /model gw:<name> switches/resets the PER-SESSION active gateway', () => {
  const body = fnBody(PROD_CMDS, /function\s+handleModel\s*\(/);
  // Wire the store in.
  assert.match(body, /require\('\.\/gateways'\)/, 'handleModel loads the gateways store');
  assert.match(body, /gw:\(\.\+\)\$/i, 'must parse an explicit `/model gw:<name>` form');
  // The choice is PER-SESSION (rec.activeGw), NOT the legacy per-user
  // `active`. The profile is validated by name via getProfile; the choice is
  // persisted on the session record and mirrored onto the live instance so
  // a brand-new session stays on the system default until manually switched.
  assert.match(body, /gatewaysMod\.getProfile\s*\(\s*rec\.user\s*,\s*gwName\s*\)/,
    '`/model gw:<name>` must validate the saved profile by name via getProfile');
  assert.match(body, /rec\.activeGw\s*=\s*gwName/, 'a switch must set rec.activeGw (per-session)');
  assert.match(body, /ctx\.session\.activeGw\s*=\s*gwName/,
    'a switch must mirror activeGw onto the live AgentSession instance');
  assert.match(body, /rec\.activeGw\s*=\s*null/, '`gw:default` must clear rec.activeGw → system default');
  assert.match(body, /sessionsMod\.saveStore\(\)/, 'the per-session choice must persist via saveStore');
  assert.ok(!/gatewaysMod\.setActive\s*\(/.test(body) && !/gatewaysMod\.deactivate\s*\(/.test(body),
    'must NOT mutate the legacy per-user global active (setActive/deactivate)');
});

// ── Regression guards for the three picker/gateway fixes ──
// bug: "切换后还是使用部署时给的模型" — sdkOpts.model alone only reaches a NEW
// query; resume ignores it)Skip. The gateway model must also be pushed live
// via Query.setModel (mirroring /model), tracking _appliedModel to dedupe.

t('agent-session live-switches the gateway model via Query.setModel', () => {
  assert.match(PROD_AGENT, /this\._appliedModel\s*=\s*null/,
    'constructor must initialise the _appliedModel dedupe marker');
  // Effective model (for the live setModel) = gateway model, else the
  // system default ANTHROPIC_MODEL from state/.env. The retired /model
  // override is NOT in the resolution anymore (it was the "ds" pollution
  // bug) — gateway or .env default must be the source, not a stale value.
  assert.match(PROD_AGENT, /const effModel\s*=\s*\(gw\s*&&\s*gw\.model\s*\?\s*gw\.model\s*:\s*undefined\)\s*\|\|\s*process\.env\.ANTHROPIC_MODEL/,
    'effective model = gateway model, else system .env ANTHROPIC_MODEL (never a stale modelOverride)');
  // The live setModel MUST run AFTER query() returns (when the stream is
  // live) — placing it earlier makes it dead code because _currentQuery is
  // still null before query(). Positional check (no hand-picked window):
  // stream.setModel must textually come after `this._currentQuery = stream;`.
  const qAt = PROD_AGENT.indexOf('this._currentQuery = stream;');
  const smAt = PROD_AGENT.indexOf('stream.setModel(effModel || undefined)');
  assert.ok(qAt > 0, 'must find where _currentQuery = stream is assigned');
  assert.ok(smAt > qAt,
    'live setModel must come AFTER _currentQuery = stream (the query is live), not before it');
  assert.match(PROD_AGENT, /this\._appliedModel\s*!==\s*effModel/,
    'live setModel must be gated on a model change (dedupe)');
});

// bug: "切回默认后，我新增的就不能点击了" — the profile row was a <div> WITHOUT
// data-gw, so the [data-gw] click selector never matched it. Must carry data-gw.

t('app.js picker: every gateway row carries data-gw (clickable to switch)', () => {
  const body = fnBody(PROD_APP, /function\s+_openModelPicker\s*\(/);
  assert.ok(body, '_openModelPicker body must be locatable');
  // default button AND each profile row.
  assert.match(body, /data-gw="default"/, 'default row must be clickable (data-gw="default")');
  assert.match(body, /data-gw="\$\{escHtml\(p\.name\)\}"/,
    'each saved profile row must carry data-gw="<name>" so clicking switches to it');
  assert.match(body, /querySelectorAll\('\.model-picker-row\[data-gw\]'\)/,
    'click wiring must bind via the [data-gw] selector (covers default + profiles)');
});

// user asked to hide the redundant per-session Model group — the gateway
// profile's model governs, `default` uses .env. No "Model (session)" group.

t('app.js picker: the redundant Model (session) group is gone', () => {
  const body = fnBody(PROD_APP, /function\s+_openModelPicker\s*\(/);
  assert.ok(body, '_openModelPicker body must be locatable');
  assert.ok(!/Model \(session\)/.test(body),
    'the Model (session) group must NOT be rendered — hidden per user request');
  assert.ok(!/data-id=/.test(body),
    'no per-model-alias rows (data-id) should remain in the picker');
});

// user asked: "支持上下箭头选择，enter回车确认" — the picker must move a
// highlight with ↑/↓ and confirm with Enter.

t('app.js picker: ↑/↓ select + Enter confirms (keyboard nav)', () => {
  const body = fnBody(PROD_APP, /function\s+_openModelPicker\s*\(/);
  assert.ok(body, '_openModelPicker body must be locatable');
  assert.match(body, /e\.key\s*===\s*'ArrowDown'|ArrowDown/, 'must handle ArrowDown');
  assert.match(body, /e\.key\s*===\s*'ArrowUp'|ArrowUp/, 'must handle ArrowUp');
  assert.match(body, /\.model-picker-row\[data-gw\]/, 'nav targets the clickable gateway rows');
  assert.match(body, /\.classList\.add\('highlighted'\)/, 'must mark the selected row highlighted');
  assert.match(body, /e\.key\s*===\s*'Enter'/, 'must handle Enter to confirm a selection');
  assert.match(body, /\.click\(\)/, 'Enter must dispatch the highlighted row\'s click');
});

// user asked: "模型名按照设置显示" — the session label must prefer the ACTIVE
// gateway profile's configured model over the (stale, upstream) SDK ev.model.

t('app.js shows the model as configured (active gateway profile)', () => {
  assert.match(PROD_APP, /let\s+_activeGatewayModel\s*=\s*null/, 'must cache the active gateway model');
  assert.match(PROD_APP, /_activeGatewayModel\s*=\s*activeProf\s*\?\s*\(\s*activeProf\.model\s*\|\|\s*null\s*\)\s*:\s*null/,
    'must fetch the active profile\'s configured model into _activeGatewayModel');
  assert.match(PROD_APP, /model=\$\{_activeGatewayModel\s*\|\|\s*ev\.model\s*\|\|\s*'\?'\}/,
    'the session label must show the configured model (fall back to ev.model)');
});

// ──────────────────────────────────────────────────────────────────────────
// Cleanup.
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
