// Regression: claude code keeps the authoritative current-session-id
// for an active process at ~/.claude/sessions/<pid>.json. When the user
// hits /resume inside claude's TUI, claude re-execs itself and starts
// writing to a different jsonl — but our captureClaudeSessionId only
// runs at mycod-spawn time, so rec.claudeSessionId stays stuck on the
// pre-/resume jsonl.
//
// readActiveClaudeSessionForCwd(absCwd) walks the tracker dir, picks
// the entry whose cwd matches AND whose updatedAt is freshest (active
// processes heartbeat; dead ones froze at exit). The freshest entry's
// sessionId is the actual jsonl claude is writing to right now.

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

// Sandbox claude's home dir so we don't read real /home/<user>/.claude
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-acs-'));
process.env.HOME = tmpHome;
const sessionsDir = path.join(tmpHome, '.claude', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

const { readActiveClaudeSessionForCwd } = require('../server/src/sessions');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.message ? err.message : err)); failed++; }
}

function writeTracker(pid, info) {
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify(info));
}
function clearTrackers() {
  for (const f of fs.readdirSync(sessionsDir)) fs.unlinkSync(path.join(sessionsDir, f));
}

t('empty tracker dir → null', () => {
  clearTrackers();
  assert.strictEqual(readActiveClaudeSessionForCwd('/wks/kkrazy/myco'), null);
});

t('single entry matching cwd → its sessionId', () => {
  clearTrackers();
  writeTracker(27, {
    pid: 27, sessionId: '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
    cwd: '/wks/kkrazy/myco', updatedAt: 1778658560926, status: 'busy',
  });
  assert.strictEqual(
    readActiveClaudeSessionForCwd('/wks/kkrazy/myco'),
    '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
  );
});

t('mismatched cwd → null', () => {
  clearTrackers();
  writeTracker(27, {
    pid: 27, sessionId: '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
    cwd: '/wks/kkrazy/myco', updatedAt: 1778658560926,
  });
  assert.strictEqual(readActiveClaudeSessionForCwd('/wks/kkrazy/other'), null);
});

t('multiple entries → freshest updatedAt wins', () => {
  clearTrackers();
  // Stale entry from a dead process
  writeTracker(28, {
    pid: 28, sessionId: '1ff60e57-bece-4432-adb4-feabfcbba591',
    cwd: '/wks/kkrazy/myco', updatedAt: 1778656920460, status: 'idle',
  });
  // Live process — newer updatedAt
  writeTracker(27, {
    pid: 27, sessionId: '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
    cwd: '/wks/kkrazy/myco', updatedAt: 1778658560926, status: 'busy',
  });
  assert.strictEqual(
    readActiveClaudeSessionForCwd('/wks/kkrazy/myco'),
    '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
  );
});

t('non-UUID sessionId → rejected', () => {
  clearTrackers();
  writeTracker(27, {
    pid: 27, sessionId: 'agent-deadbeef',     // subagent shape, never a real session
    cwd: '/wks/kkrazy/myco', updatedAt: 1778658560926,
  });
  assert.strictEqual(readActiveClaudeSessionForCwd('/wks/kkrazy/myco'), null);
});

t('malformed JSON → ignored, falls through to next', () => {
  clearTrackers();
  fs.writeFileSync(path.join(sessionsDir, '99.json'), '{not json');
  writeTracker(27, {
    pid: 27, sessionId: '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
    cwd: '/wks/kkrazy/myco', updatedAt: 1778658560926,
  });
  assert.strictEqual(
    readActiveClaudeSessionForCwd('/wks/kkrazy/myco'),
    '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
  );
});

t('missing updatedAt → treated as 0, freshest still wins', () => {
  clearTrackers();
  writeTracker(28, {
    pid: 28, sessionId: '1ff60e57-bece-4432-adb4-feabfcbba591',
    cwd: '/wks/kkrazy/myco', // no updatedAt
  });
  writeTracker(27, {
    pid: 27, sessionId: '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
    cwd: '/wks/kkrazy/myco', updatedAt: 1778658560926,
  });
  assert.strictEqual(
    readActiveClaudeSessionForCwd('/wks/kkrazy/myco'),
    '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
  );
});

t('empty absCwd argument → null', () => {
  clearTrackers();
  writeTracker(27, {
    pid: 27, sessionId: '355313f5-dca0-4804-ae2e-a4fc9ed4eb62',
    cwd: '/wks/kkrazy/myco', updatedAt: 1778658560926,
  });
  assert.strictEqual(readActiveClaudeSessionForCwd(null), null);
  assert.strictEqual(readActiveClaudeSessionForCwd(''), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
