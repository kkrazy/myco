// RLM hard implementation — §5.1 functional gap: `/rlm on` must reach
// agent-n2 (team) sessions. Design myco-rlm-design.md §5.1: before this
// fix ensureLiveSession returned at the n2 branch BEFORE the rlm branch,
// so /rlm on was silently ignored for n2 lanes. The fix threads rec.rlm
// into TeamSession, which appends rlmN2Addendum() (board-precedence
// overlay) to BOTH workers' prompts. Lanes read rec.rlm per run — a
// respawned n2 lane picks the mode up without a container restart.
//
// Static-shape tests (same style as rlm-mode.test.js Group D): they lock
// the wiring sites so a refactor can't silently re-open the gap.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fnBody } = require('./_lib/fn-body');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

console.log('── RLM hard impl: §5.1 n2 overlay wiring ──');

t('sessions.js: getOrCreateTeamSession passes rlm from the record', () => {
  const src = read('server/src/sessions.js');
  const body = fnBody(src, /function\s+getOrCreateTeamSession\s*\(/);
  assert.ok(/rlm:\s*isRlmEffective\(rec\)/.test(body),
    'getOrCreateTeamSession must pass the effective RLM state (session OR user scope) to TeamSession — otherwise /rlm on is ignored for n2 lanes (design §5.1)');
});

t('team-session.js: constructor stores rlm, _spawnWorker appends the overlay (RLM branch only)', () => {
  const src = read('server/src/team-session.js');
  const ctor = fnBody(src, /constructor\s*\(/);
  assert.ok(/this\.rlm\s*=\s*rlm\s*===\s*true/.test(ctor),
    'TeamSession constructor must store this.rlm = rlm === true (strict boolean)');
  const spawner = fnBody(src, /_spawnWorker\s*\(/);
  assert.ok(/rlmN2Addendum/.test(spawner),
    '_spawnWorker must append rlmN2Addendum() when this.rlm — the n2 overlay is the §5.1 fix');
  // P1+P2 deepening: RLM workers are built via spawnRlmAgent. The overlay
  // must live INSIDE that branch so /rlm off reverts to the pure STARTUP
  // prompt (plain AgentSession branch must not mention rlmN2Addendum).
  const rlmBranch = spawner.slice(spawner.indexOf('spawnRlmAgent'), spawner.indexOf('} else {'));
  const plainBranch = spawner.slice(spawner.indexOf('} else {'));
  assert.ok(/rlmN2Addendum\(\)/.test(rlmBranch),
    'rlmN2Addendum() must be composed into the spawnRlmAgent systemPrompt (board prompt first, overlay appended)');
  assert.ok(!/rlmN2Addendum/.test(plainBranch),
    'the plain (non-RLM) branch must stay overlay-free — off reverts to the pure STARTUP prompt');
  assert.ok(/spawnRlmAgent\(this\.sessionId\s*\+\s*['"]-['"]\s*\+\s*actor/.test(spawner),
    'RLM workers must be constructed via spawnRlmAgent(sessionId + "-" + actor) — the P1+P2 entrypoint switch');
  assert.ok(/rlmSpawn:\s*\{\s*parentSessionId:\s*this\.sessionId,\s*depth:\s*1,\s*maxDepth:\s*3\s*\}/.test(spawner),
    'RLM workers must spawn at depth 1 with maxDepth 3 (sub-agent depth runtime enforcement)');
  assert.ok(/require\(['"]\.\/agents\/rlm\/prompt['"]\)/.test(src),
    'team-session.js must import rlmN2Addendum from ./agents/rlm/prompt');
});

t('prompt.js: rlmN2Addendum states board precedence WINS on conflicts', () => {
  const src = read('server/src/agents/rlm/prompt.js');
  const body = fnBody(src, /function\s+rlmN2Addendum\s*\(/);
  assert.ok(/WINS on conflicts/i.test(body),
    'the n2 overlay must declare PRECEDENCE: board coordination contract WINS on conflicts (design §5.1)');
  assert.ok(/board/i.test(body), 'overlay references the board coordination contract');
});

t('compare-lanes.js: startN2Lane threads rlm through to TeamSession', () => {
  const src = read('server/src/compare-lanes.js');
  const body = fnBody(src, /function\s+startN2Lane\s*\(/);
  assert.ok(/\brlm\b\s*\}/.test(body.slice(0, 200)) || /,\s*rlm\b/.test(body.slice(0, 200)),
    'startN2Lane accepts an rlm opt in its destructured signature (rec.rlm read per run — respawned lanes pick up the mode)');
  assert.ok(/rlm:\s*rlm\s*===\s*true/.test(body),
    'startN2Lane passes rlm: rlm === true to TeamSession');
});

t('slashcmds.js: /compare reads rec.rlm before launching lanes', () => {
  const src = read('server/src/slashcmds.js');
  const body = fnBody(src, /function\s+runN2CompareLanes\s*\(/);
  assert.ok(/getSessionRecord\s*\(\s*mainSessionId\s*\)/.test(body),
    'runN2CompareLanes must read the session record (rec.rlm is per-session state)');
  assert.ok(/rec\.rlm\s*===\s*true|rlmOn/.test(body),
    'runN2CompareLanes derives rlmOn from rec.rlm === true');
  assert.ok(/rlm:\s*rlmOn|rlm:\s*rlmOn\s*===\s*true/.test(body),
    'runN2CompareLanes passes rlm: rlmOn to startN2Lane');
});

t('slashcmds.js: /rlm on|off reply mentions the n2 overlay pickup', () => {
  const src = read('server/src/slashcmds.js');
  const body = fnBody(src, /function\s+handleRlm\s*\(/);
  assert.ok(/n2/.test(body),
    'the /rlm reply text should tell the user agent-n2 lanes pick up the mode (no silent gap)');
});

t('index.js /sessions payload carries s.rlm (sidebar badge source)', () => {
  const src = read('server/src/index.js');
  assert.ok(/s\.rlm\s*=\s*!!\(rec\s*&&\s*sessionsMod\.isRlmEffective\(rec\)\)/.test(src),
    'the /sessions payload must expose the EFFECTIVE s.rlm (session OR user scope) so the sidebar can badge RLM sessions (design §5.2)');
});

t('attach.js: initial snapshot ships rlm-mode-changed (refresh-safe badge)', () => {
  const src = read('server/src/attach.js');
  assert.ok(/kind:\s*['"]rlm-mode-changed['"],/.test(src) && /isRlmEffective\(recRlm\)/.test(src),
    '_sendAttachSnapshot must emit a rlm-mode-changed state-update from the EFFECTIVE mode so a browser refresh restores the badge');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
