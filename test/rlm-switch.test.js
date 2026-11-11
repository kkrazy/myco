// RLM switch (task 2026-10-22 revision): RLM is switchable at ONE scope —
// session-level only (rec.rlm, `/rlm session on|off`, legacy `/rlm on|off`).
// The user-level scope (store.rlmUsers, `/rlm user on|off`, GET/POST
// /api/rlm) was REMOVED on user request (the 用户级 switch was unreadable
// in the UI and is gone; the dropdown is session-only and restyled for
// readability).
//
// Contract locked here:
//   - sessions.js exports isRlmEffective / getRlmScope and NOTHING
//     user-level (no RLM_USER_MODES / getRlmUserSetting /
//     setRlmUserSetting / rlmUsers seeding).
//   - isRlmEffective(rec) === (rec.rlm === true); getRlmScope returns
//     'session' | null.
//   - ensureLive + getOrCreateTeamSession + runN2CompareLanes read
//     isRlmEffective (not bare rec.rlm).
//   - handleRlm supports /rlm session on|off + /rlm on|off; /rlm user
//     on|off replies with a removal notice instead of toggling anything.
//   - index.js has NO /api/rlm routes.
//   - web UI: #rlm-scope-select dropdown is session-only (off / session),
//     styled for readability, and never POSTs /api/rlm.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── RLM switch: session-level only (user-level scope removed) ──');

// ── Group A: sessions.js effective-mode helpers (real module, tmp state dir) ──

const TMP_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-switch-'));
process.env.MYCO_STATE_DIR = TMP_STATE;
process.env.MYCO_WORKSPACE = path.join(TMP_STATE, 'wks');
// Fresh require so the store cache starts empty against the tmp dir.
delete require.cache[require.resolve('../server/src/sessions')];
const sessionsMod = require('../server/src/sessions');

t('sessions.js exports ONLY the session-level RLM switch surface', () => {
  for (const fn of ['isRlmEffective', 'getRlmScope']) {
    assert.strictEqual(typeof sessionsMod[fn], 'function', `${fn} must be a function`);
  }
  // The user-level surface must be GONE (removal regression guard).
  for (const gone of ['RLM_USER_MODES', 'getRlmUserSetting', 'setRlmUserSetting']) {
    assert.strictEqual(sessionsMod[gone], undefined,
      `${gone} must be removed (user-level RLM scope is gone)`);
  }
});

t('isRlmEffective: rec.rlm decides (session-level only)', () => {
  assert.strictEqual(sessionsMod.isRlmEffective({ rlm: true }), true,
    'rec.rlm=true is effective');
  assert.strictEqual(sessionsMod.isRlmEffective({ rlm: false }), false,
    'rec.rlm=false is off');
  assert.strictEqual(sessionsMod.isRlmEffective({}), false,
    'no rec.rlm means RLM off');
  assert.strictEqual(sessionsMod.isRlmEffective(null), false,
    'null rec must be off (defensive)');
});

t('getRlmScope: session | null (user scope is gone)', () => {
  assert.strictEqual(sessionsMod.getRlmScope({ rlm: true }), 'session',
    'scope must read session when rec.rlm drives it');
  assert.strictEqual(sessionsMod.getRlmScope({ rlm: false }), null,
    'scope must read null when RLM is off');
  assert.strictEqual(sessionsMod.getRlmScope(null), null,
    'null rec → null scope (defensive)');
});

t('loadStore no longer seeds store.rlmUsers', () => {
  const src = _read('server/src/sessions.js');
  assert.ok(!/rlmUsers/.test(src.replace(/\/\/[^\n]*was removed[^\n]*/g, '')),
    'sessions.js must not seed rlmUsers anymore (user-level scope removed)');
});

t('ensureLiveSession + getOrCreateTeamSession read isRlmEffective, not bare rec.rlm', () => {
  const src = _read('server/src/sessions.js');
  const ensureBody = fnBody(src, /async function ensureLiveSession\s*\(/);
  assert.ok(/isRlmEffective\(rec\)/.test(ensureBody),
    'ensureLiveSession must branch on isRlmEffective(rec)');
  assert.ok(!/if \(rec\.rlm === true\)/.test(ensureBody),
    'the bare rec.rlm check must be gone from ensureLiveSession');
  const teamBody = fnBody(src, /async function getOrCreateTeamSession\s*\(/);
  assert.ok(/isRlmEffective\(rec\)/.test(teamBody),
    'getOrCreateTeamSession must pass isRlmEffective(rec) into TeamSession');
});

t('runN2CompareLanes lane flag reads isRlmEffective', () => {
  const src = _read('server/src/slashcmds.js');
  const body = fnBody(src, /function runN2CompareLanes\s*\(/);
  assert.ok(/isRlmEffective\(rec\)/.test(body),
    '/run-n2 + /compare lanes must read the effective RLM state');
});

// ── Group B: /rlm slash subcommands (stubbed sessions module) ──

function freshSlash(sessionsStub) {
  for (const m of ['../server/src/sessions', '../server/src/slashcmds', '../server/src/permissions']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  const sid = require.resolve('../server/src/sessions');
  require.cache[sid] = { exports: sessionsStub, id: sid, filename: sid, loaded: true };
  const pid = require.resolve('../server/src/permissions');
  require.cache[pid] = { exports: { matchesPattern() { return false; } }, id: pid, filename: pid, loaded: true };
  return require('../server/src/slashcmds');
}

function makeStub(overrides = {}) {
  return Object.assign({
    _rec: { user: 'alice' },
    _owners: new Set(['alice']),
    getSessionRecord() { return this._rec; },
    isOwnerOrAdmin(_id, user) { return this._owners.has(user); },
    saveStore() {},
    appendChatMessage() {},
    allocSeq() { return 1; },
    isRlmEffective(rec) { return !!(rec && rec.rlm === true); },
    getRlmScope(rec) {
      return (rec && rec.rlm === true) ? 'session' : null;
    },
  }, overrides);
}

t('/rlm session on persists rec.rlm + broadcasts effective rlm with scope', () => {
  const stub = makeStub();
  const slash = freshSlash(stub);
  const events = [];
  slash.handleRlm({
    sessionId: 's1', user: 'alice', args: 'session on',
    reply() {},
    session: { emit: (kind, payload) => events.push({ kind, payload }) },
  });
  assert.strictEqual(stub._rec.rlm, true, '/rlm session on must set rec.rlm=true');
  const evt = events.find((e) => e.payload && e.payload.kind === 'rlm-mode-changed');
  assert.ok(evt, 'must broadcast rlm-mode-changed');
  assert.strictEqual(evt.payload.rlm, true, 'broadcast carries effective rlm:true');
  assert.strictEqual(evt.payload.scope, 'session', 'broadcast carries scope:session');
});

t('/rlm on (legacy) behaves as session-level alias', () => {
  const stub = makeStub();
  const slash = freshSlash(stub);
  slash.handleRlm({
    sessionId: 's2', user: 'alice', args: 'on',
    reply() {}, session: { emit() {} },
  });
  assert.strictEqual(stub._rec.rlm, true, 'legacy /rlm on must still set rec.rlm');
});

t('/rlm user on|off replies with a removal notice (no state changes)', () => {
  const stub = makeStub();
  const slash = freshSlash(stub);
  const replies = [];
  const events = [];
  slash.handleRlm({
    sessionId: 's3', user: 'alice', args: 'user on',
    reply: (m) => replies.push(String(m)),
    session: { emit: (kind, payload) => events.push({ kind, payload }) },
  });
  assert.strictEqual(replies.length, 1, '/rlm user on must reply once');
  assert.ok(/移除|removed/i.test(replies[0]),
    'the reply must state the user-scope switch was removed');
  assert.strictEqual(stub._rec.rlm, undefined,
    '/rlm user on must NOT touch rec.rlm');
  assert.strictEqual(events.length, 0,
    '/rlm user on must NOT broadcast any state change');
});

t('/rlm status reports session-level state only', () => {
  const stub = makeStub({ _rec: { user: 'alice', rlm: true } });
  const slash = freshSlash(stub);
  const replies = [];
  slash.handleRlm({
    sessionId: 's5', user: 'alice', args: 'status',
    reply: (m) => replies.push(String(m)),
    session: { emit() {} },
  });
  assert.strictEqual(replies.length, 1, 'status replies once');
  assert.ok(/session-level/i.test(replies[0]),
    'status must name the session-level scope');
  assert.ok(!/user-level/i.test(replies[0]),
    'status must not reference the removed user-level scope');
});

t('/rlm session on from non-owner is REFUSED', () => {
  const stub = makeStub();
  const slash = freshSlash(stub);
  const replies = [];
  slash.handleRlm({
    sessionId: 's6', user: 'eve', args: 'session on',
    reply: (m) => replies.push(String(m)),
    session: { emit() {} },
  });
  assert.ok(stub._rec.rlm === undefined, 'rec.rlm must stay unset for a denied user');
  assert.ok(/owner\+admin/.test(replies[0]), 'denial must name the owner+admin gate');
});

// ── Group C: HTTP surface + UI wiring (static shape checks) ──

t('index.js has NO /api/rlm routes (user-level HTTP surface removed)', () => {
  const src = _read('server/src/index.js');
  assert.ok(!/app\.(get|post)\(['"]\/api\/rlm['"]/.test(src),
    '/api/rlm routes must be gone');
  assert.ok(!/getRlmUserSetting|setRlmUserSetting|RLM_USER_MODES/.test(src),
    'index.js must not reference the removed user-setting helpers');
});

t('attach frame ships effective rlm + scope (attach.js)', () => {
  const src = _read('server/src/attach.js');
  const at = src.search(/kind: 'rlm-mode-changed'/);
  assert.ok(at > -1, 'attach.js must ship the rlm-mode-changed frame');
  const win = src.slice(at - 600, at + 400);
  assert.ok(/isRlmEffective/.test(win),
    'the attach frame must use isRlmEffective');
  assert.ok(/getRlmScope/.test(win),
    'the attach frame must carry the driving scope');
});

t('sidebar ships effective rlm + rlmScope (GET /sessions)', () => {
  const src = _read('server/src/index.js');
  assert.ok(/s\.rlm = !!\(rec && sessionsMod\.isRlmEffective\(rec\)\)/.test(src),
    'GET /sessions s.rlm must be the EFFECTIVE mode');
  assert.ok(/s\.rlmScope = /.test(src), 'GET /sessions must ship s.rlmScope');
});

t('web UI: session-only dropdown, readable styling, no /api/rlm', () => {
  const html = _read('web/public/index.html');
  assert.ok(/id="rlm-scope-select"/.test(html),
    'index.html must carry the #rlm-scope-select dropdown');
  assert.ok(/value="session"/.test(html) && /value="off"/.test(html),
    'dropdown must offer off / session (user-level scope removed)');
  // Slice only the rlm select's own option list (the next </select>), so
  // an UNRELATED `value="user"` (e.g. skills-scope-select at line ~502)
  // doesn't false-positive.
  const rlmAt = html.indexOf('id="rlm-scope-select"');
  const rlmBlock = rlmAt >= 0 ? html.slice(rlmAt, html.indexOf('</select>', rlmAt)) : '';
  assert.ok(!/value="user"/.test(rlmBlock),
    'the dropdown must NOT offer the removed user-level scope');
  const css = _read('web/public/styles.css');
  assert.ok(/\.rlm-scope-select\s*\{[\s\S]*?font-size: \.8rem/.test(css),
    'the switch must keep the readable .8rem font (the old .65rem was illegible)');
  const js = _read('web/public/app.js');
  assert.ok(/function _onRlmScopeChange/.test(js),
    'app.js must define _onRlmScopeChange');
  assert.ok(/rlmSelect\.addEventListener\('change', _onRlmScopeChange\)/.test(js),
    'the dropdown change event must be wired at boot');
  assert.ok(!/\/api\/rlm/.test(js), 'the UI must not POST /api/rlm (user-level scope removed)');
  assert.ok(/'\/rlm session on' : '\/rlm session off'/.test(js) && /sendChatMessage\(cmd\)/.test(js),
    'the session-scope path must go through the slash command (same switch)');
});

// ── Summary ──

console.log(`\nrlm-switch: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
