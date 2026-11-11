// bug-48: handle `system` events with task_progress / task_started /
// task_notification subtypes in agent frame handler.
//
// User-reported (verbatim, plan-item dispatch from @kkrazy):
//   Problem:  Agent frame handler logs [unknown_event] warnings for
//             valid `system` events emitted during task lifecycle,
//             polluting the console and skipping UI updates.
//   Expected: `_appendAgentEvent` recognizes `system` events with
//             subtypes task_progress / task_started (and surfaces
//             their description / task_id / tool_use_id in the UI).
//   Actual:   These subtypes fall through to the unknown-event
//             branch and are dropped with a warning.
//
//   Comment from @labxnow: same for `task_notification` subtype with
//   `status: 'completed'`.
//   Comment from @kkrazy:  "Should try to handle all event type to
//     inform user the status, but should make it as part of chrome
//     batch to ensure ui cleaness."
//
// Architecture (per @kkrazy's directive — chrome batch, not standalone):
//   · Server: in agent-session.js _handleEvent (the SDK message
//     dispatcher), add a branch BEFORE the unknown_event passthrough
//     that detects `m.type === 'system'` with the 3 known subtypes
//     (task_started, task_progress, task_notification) and emits as
//     `{type: 'system_event', subtype, taskId, toolUseId, description,
//      status, raw: m}`. Unknown SDK system subtypes still fall
//     through to the unknown_event passthrough — only the documented
//     three get promoted, so future SDK additions stay visible.
//   · Client: add `system_event` to AGENT_CHROME_TYPES so the new
//     emission folds into the existing chrome batch (same row as
//     hook_allow, tool_result, etc.) — clean UI per @kkrazy. Wire
//     `system_event` branches in _chromeEventLine (expanded body row)
//     and _chromeShortLabel (live-status strip + collapsed batch head)
//     so the description / task_id surface to the user.
//
// Test shape: static-grep guards on server/src/agent-session.js (new
// system_event branch covering all 3 subtypes) + web/public/app.js
// (AGENT_CHROME_TYPES contains 'system_event', _chromeEventLine has
// a system_event branch, _chromeShortLabel has a system_event branch).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function _read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('── bug-48: system events route into chrome batch ──');

// ── server: promote SDK `system` events with known subtypes ──

t('server/src/agent-session.js emits `system_event` for SDK `system` messages with task_* subtypes', () => {
  const src = _read('server/src/agent-session.js');
  // The dispatcher must emit at least one event whose type literal is
  // 'system_event'. Captures both quoted-string and template-literal
  // forms.
  assert.ok(/type:\s*['"`]system_event['"`]/.test(src),
    "agent-session.js must emit {type: 'system_event', ...} so the client gets a structured event instead of unknown_event for SDK system messages (bug-48).");
});

t('server/src/agent-session.js system_event branch references all 3 documented subtypes (task_started, task_progress, task_notification)', () => {
  const src = _read('server/src/agent-session.js');
  // Find the system_event emission anchor + look in a generous
  // window around it for each subtype string.
  const at = src.search(/type:\s*['"`]system_event['"`]/);
  assert.ok(at > -1, 'system_event emission must exist (anchor for the subtype scan).');
  const window = src.slice(Math.max(0, at - 1500), at + 1500);
  for (const sub of ['task_started', 'task_progress', 'task_notification']) {
    assert.ok(new RegExp(`['"\`]${sub}['"\`]`).test(window),
      `the system_event branch must reference the "${sub}" subtype so SDK system events with that subtype are promoted out of unknown_event (bug-48). Window: ${window.slice(0, 400)}…`);
  }
});

t('server/src/agent-session.js system_event branch sits BEFORE the unknown_event fallback', () => {
  const src = _read('server/src/agent-session.js');
  const sysAt = src.search(/type:\s*['"`]system_event['"`]/);
  const unkAt = src.search(/type:\s*['"`]unknown_event['"`]/);
  assert.ok(sysAt > -1 && unkAt > -1, 'both system_event and unknown_event emissions must exist.');
  assert.ok(sysAt < unkAt,
    "system_event branch must come BEFORE the unknown_event fallback in _handleEvent — otherwise the unknown_event passthrough catches the SDK system message first and the promotion never runs (bug-48).");
});

// ── client: chrome-batch wiring ──

t('web/public/app.js: AGENT_CHROME_TYPES contains `system_event`', () => {
  const app = _read('web/public/app.js');
  // Find the AGENT_CHROME_TYPES Set literal and grep its body for
  // 'system_event'. Loose check: the string lives within ±1200 chars
  // of the Set declaration (the Set body is ~30 lines / ~700 chars).
  const at = app.search(/const\s+AGENT_CHROME_TYPES\s*=\s*new\s+Set\(/);
  assert.ok(at > -1, 'AGENT_CHROME_TYPES must exist (anchor for the chrome-type scan).');
  const body = app.slice(at, at + 1500);
  assert.ok(/['"`]system_event['"`]/.test(body),
    "AGENT_CHROME_TYPES must list 'system_event' so the new server emission folds into the chrome batch (bug-48). Per @kkrazy: 'should make it as part of chrome batch to ensure ui cleaness.'");
});

t('web/public/app.js: _chromeEventLine handles ev.type === `system_event`', () => {
  const app = _read('web/public/app.js');
  // _chromeEventLine is the expanded-row renderer. There must be a
  // branch keyed on system_event so the row displays the description
  // / task_id rather than the fall-through JSON.stringify(ev).
  const at = app.search(/function\s+_chromeEventLine\s*\(/);
  assert.ok(at > -1, '_chromeEventLine must exist.');
  const body = sliceFn(app, at);
  assert.ok(/ev\.type\s*===\s*['"`]system_event['"`]/.test(body),
    "_chromeEventLine must have a `ev.type === 'system_event'` branch so the expanded row surfaces the description / subtype (bug-48).");
});

t('web/public/app.js: _chromeShortLabel handles ev.type === `system_event`', () => {
  const app = _read('web/public/app.js');
  // _chromeShortLabel is the collapsed-batch-head + live-status-strip
  // labeler. Must have a system_event branch so the head names the
  // most recent task lifecycle event ("task_progress · Deploy …").
  const at = app.search(/function\s+_chromeShortLabel\s*\(/);
  assert.ok(at > -1, '_chromeShortLabel must exist.');
  const body = sliceFn(app, at);
  assert.ok(/ev\.type\s*===\s*['"`]system_event['"`]/.test(body),
    "_chromeShortLabel must have a `ev.type === 'system_event'` branch so the live status strip + batch head label the event (bug-48).");
});

// ── marker comment ──

t('a comment naming bug-48 explains the system-event plumbing', () => {
  const server = _read('server/src/agent-session.js');
  const app = _read('web/public/app.js');
  assert.ok(/bug-48/.test(server) || /bug-48/.test(app),
    'a comment naming bug-48 must appear in at least one of server/src/agent-session.js / web/public/app.js so future restyles understand the system_event contract.');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
