// bug-19 follow-up: in read-only mode, disable the Send button when
// the typed message would be denied — proactive client-side gate so
// the user can see whether their input is acceptable BEFORE they hit
// Send. Mirrors the server's whitelist (mentions + a small allowed
// slash command set).
//
// User report: "as a guest my message still gets sent to the chat,
// i expect to see the sent button deactivated if my message is not
// allowed to be sent."
//
// Whitelist (must mirror attach.js handleChatMessage exactly):
//   * @mention — anywhere in the text
//   * /td, /fr, /bug — plan-item adds
//   * /help, /me, /whoami
//   * /task, /tasks, /skip, /cancel — task-list controls
//   * /allowlist — read-only view of allow/deny lists

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const PROD_APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── bug-19 follow-up: disable Send when guest message would be denied ──');

t('app.js declares a guest-allowed-text predicate', () => {
  // Name flexibility: _isGuestAllowedText OR isGuestAllowedText OR
  // _guestCanSend. Look for a function that contains the allowed
  // slash command set.
  assert.match(PROD_APP,
    /(_isGuestAllowedText|isGuestAllowedText|_guestCanSend|_canGuestSend)\s*[=(]/,
    'a client-side helper must classify guest-allowed text');
});

t('app.js helper mirrors the server\'s allowed slash command set', () => {
  // Pin all commands the server allows for guests so client + server
  // can\'t drift. If the server adds /something, the client guard must
  // be updated in sync.
  for (const cmd of ['/td', '/fr', '/bug', '/help', '/me', '/whoami',
                     '/task', '/tasks', '/skip', '/cancel', '/allowlist',
                     '/qstatus']) {
    assert.ok(PROD_APP.indexOf("'" + cmd + "'") > -1 || PROD_APP.indexOf('"' + cmd + '"') > -1,
      `guest-allowed command ${cmd} must appear as a literal in app.js`);
  }
});

t('app.js disables the Send button when state.readOnly + text would be denied', () => {
  // The chat-input listener must consult state.readOnly + the guest
  // predicate to flip the Send button's disabled attr. Look for the
  // disabled-toggle reference in a context that mentions readOnly.
  // Acceptable shapes: setting `chat-send`'s disabled attr, OR a
  // CSS class like 'composer-blocked' toggled on the form.
  assert.match(PROD_APP,
    /state\.readOnly[\s\S]{0,800}?(disabled|composer-blocked|chat-send)/,
    'a read-only-aware code path must toggle the Send button disabled / a blocked class');
});

t('app.js Send-disable check runs on chat-input event (live as user types)', () => {
  // The disable state must update as the user types — otherwise it\'s
  // stale and provides no real feedback. Look for an input listener
  // on the chat-input that references either the guest predicate
  // OR a derived block flag.
  const inputEvtIdx = PROD_APP.search(/chat-input[\s\S]{0,2000}?addEventListener\s*\(\s*['"`]input['"`]/);
  assert.ok(inputEvtIdx > -1,
    'chat-input must have an "input" event listener — that\'s how the disable state stays live');
});

t('app.js sendChatMessage REFUSES to send when state.readOnly + text would be denied', () => {
  // The disabled-button gate prevents clicks, but Enter-key submit
  // (submitChat) and programmatic ws.send paths bypass the disabled
  // attr. The canonical gate must live in sendChatMessage itself
  // so EVERY entry point honors it. User-reported regression:
  // "send button is not disabled, i can still send".
  //
  // Locate the sendChatMessage function body and verify it
  // short-circuits on state.readOnly + !_isGuestAllowedText.
  const start = PROD_APP.search(/function\s+sendChatMessage\s*\(/);
  assert.ok(start > -1, 'sendChatMessage function must exist');
  const rest = PROD_APP.slice(start);
  const next = rest.slice(1).search(/\n(async\s+)?function\s+[A-Za-z_]/);
  const body = next === -1 ? rest : rest.slice(0, next + 1);
  // Must reference state.readOnly AND the guest predicate in the
  // body. Order doesn\'t matter as long as both are present and
  // the function can return false on the deny path.
  assert.ok(/state\.readOnly/.test(body),
    'sendChatMessage must check state.readOnly');
  assert.ok(/_isGuestAllowedText|isGuestAllowedText/.test(body),
    'sendChatMessage must call the guest-allowed predicate');
  assert.ok(/return\s+false/.test(body),
    'sendChatMessage must return false on the deny path so the input retains the text');
});

t('app.js leaves Send enabled for non-guests (state.readOnly false → no block)', () => {
  // Negative guard: the disable logic must be gated on state.readOnly.
  // Owners + admins must always be able to send. Search for the
  // disable site and verify it\'s inside a readOnly conditional.
  // The simplest way to check is: !state.readOnly should appear in
  // proximity to the disable toggle.
  const disableIdx = PROD_APP.search(/chat-send[\s\S]{0,400}?disabled|composer-blocked/);
  assert.ok(disableIdx > -1, 'disable logic must exist');
  // Within a small window of the disable site, state.readOnly should
  // be referenced as the gate.
  const window = PROD_APP.slice(Math.max(0, disableIdx - 600), disableIdx + 600);
  assert.ok(/state\.readOnly/.test(window),
    'disable logic must gate on state.readOnly so non-guests are never blocked');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
