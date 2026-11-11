// bug-92: /clear must truly persist — after wiping rec.chat it must also
// drop the replay sources that re-render the wiped text on attach, or an
// F5 brings it all back. This locks:
//   1. session.buffer is emptied (so _shipAgentReplay ships nothing old).
//   2. <cwd>/_myco_/events.jsonl is truncated (so a reaper-restart's
//      _hydrateBufferFromDisk re-hydrates an empty buffer).
//   3. rec.chatClearAt is stamped, and the transcript mirror
//      (persistAssistantTextToChat) refuses to re-copy prose older than
//      that marker back into rec.chat on a fresh attach.

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-clearpersist-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');
const slashcmds = require('../server/src/slashcmds');
const ATTACH_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seedSession(sid, chatMessages) {
  const cwd = path.join(tmpRoot, 'proj-' + sid);
  fs.mkdirSync(path.join(cwd, '_myco_'), { recursive: true });
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: cwd,
    chat: chatMessages.slice(),
    artifacts: {},
  };
  sessionsMod.saveStore();
  return cwd;
}

async function run(text, ctx) {
  const replies = [];
  await slashcmds.dispatch({
    user: 'kkrazy',
    sessionId: ctx.sessionId,
    absCwd: ctx.absCwd,
    session: ctx.session || null,
    reply: (m) => {
      const rec = sessionsMod.loadStore().sessions[ctx.sessionId];
      if (rec) {
        if (!Array.isArray(rec.chat)) rec.chat = [];
        rec.chat.push({ user: 'claude', text: m, ts: new Date().toISOString() });
        sessionsMod.saveStore();
      }
      replies.push(m);
    },
  }, text);
  return replies;
}

(async () => {
  console.log('── /clear persists: wipes rec.chat AND the replay sources (bug-92) ──');

  await t('/clear truncates <cwd>/_myco_/events.jsonl', async () => {
    const sid = 'clr-e';
    const cwd = seedSession(sid, [{ user: 'kkrazy', text: 'hi', ts: '2026-05-14T00:00:00Z' }]);
    const evFile = path.join(cwd, '_myco_', 'events.jsonl');
    fs.writeFileSync(evFile, '{"type":"assistant_text","text":"old reply"}\n');
    const session = new EventEmitter();
    session._eventsFile = evFile;
    session.buffer = [{ type: 'assistant_text', text: 'old reply', seq: 5 }];
    await run('/clear', { sessionId: sid, absCwd: cwd, session });
    assert.strictEqual(fs.readFileSync(evFile, 'utf8'), '',
      'events.jsonl must be truncated to empty after /clear');
  });

  await t('/clear empties session.buffer', async () => {
    const sid = 'clr-b';
    const cwd = seedSession(sid, [{ user: 'kkrazy', text: 'one', ts: '2026-05-14T00:00:00Z' }]);
    const session = new EventEmitter();
    session._eventsFile = path.join(cwd, '_myco_', 'events.jsonl');
    session.buffer = [{ type: 'assistant_text', text: 'old', seq: 1 }, { type: 'tool_use', seq: 2 }];
    await run('/clear', { sessionId: sid, absCwd: cwd, session });
    assert.ok(Array.isArray(session.buffer) && session.buffer.length === 0,
      'session.buffer must be [] after /clear so _shipAgentReplay ships nothing: ' + JSON.stringify(session.buffer));
  });

  await t('/clear stamps rec.chatClearAt (drives the transcript-mirror filter)', async () => {
    const sid = 'clr-c';
    const cwd = seedSession(sid, [{ user: 'kkrazy', text: 'x', ts: '2026-05-14T00:00:00Z' }]);
    await run('/clear', { sessionId: sid, absCwd: cwd });
    const rec = sessionsMod.loadStore().sessions[sid];
    assert.ok(rec.chatClearAt && !Number.isNaN(new Date(rec.chatClearAt).getTime()),
      'rec.chatClearAt must be stamped (ISO ts), got: ' + rec.chatClearAt);
  });

  t('attach.js persistAssistantTextToChat refuses prose older than rec.chatClearAt', () => {
    // bug-92: the transcript mirror re-reads from byte 0 on a fresh
    // attach; without this filter it would re-copy pre-/clear prose into
    // the emptied rec.chat, bringing the cleared chat back.
    const idx = ATTACH_SRC.search(/function\s+persistAssistantTextToChat\s*\(/);
    assert.ok(idx > -1, 'persistAssistantTextToChat must be defined');
    const win = ATTACH_SRC.slice(idx, idx + 2200);
    assert.ok(/chatClearAt/.test(win),
      'persistAssistantTextToChat must consult rec.chatClearAt to skip pre-clear prose');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (failed) process.exit(1);
})();
