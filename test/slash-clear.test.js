// Regression: /clear must wipe rec.chat AND fire a state-update so all
// attached chat panes drop their local list. If the state-update is
// missing, only the persisted store gets cleared — live clients keep
// showing the stale messages until they reload.

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-slashclear-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require('../server/src/sessions');
const slashcmds = require('../server/src/slashcmds');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

function seedSession(sid, chatMessages) {
  const cwd = path.join(tmpRoot, 'proj-' + sid);
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
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
      // Mirror the production path: ctx.reply both pushes to rec.chat
      // AND emits a 'chat' event. The clear-then-reply sequence depends
      // on this ordering, so the test imitates it.
      const rec = sessionsMod.loadStore().sessions[ctx.sessionId];
      if (rec) {
        if (!Array.isArray(rec.chat)) rec.chat = [];
        const msg = { user: 'claude', text: m, ts: new Date().toISOString() };
        rec.chat.push(msg);
        sessionsMod.saveStore();
      }
      replies.push(m);
    },
  }, text);
  return replies;
}

(async () => {
  console.log('── /clear wipes rec.chat + emits state-update ──');

  await t('/clear empties rec.chat and leaves only the confirmation row', async () => {
    const sid = 'sess-clr-a';
    const cwd = seedSession(sid, [
      { user: 'kkrazy', text: 'hi', ts: '2026-05-14T00:00:00Z' },
      { user: 'claude', text: 'hello!', ts: '2026-05-14T00:00:01Z' },
      { user: 'kkrazy', text: '/clear', ts: '2026-05-14T00:00:02Z' },
    ]);
    const replies = await run('/clear', { sessionId: sid, absCwd: cwd });
    assert.ok(replies.some((r) => /cleared/i.test(r) && /3/.test(r)),
      'expected confirmation with count=3, got: ' + JSON.stringify(replies));
    const rec = sessionsMod.loadStore().sessions[sid];
    // Confirmation is the only surviving row.
    assert.strictEqual(rec.chat.length, 1, 'chat should hold only the confirmation: ' + JSON.stringify(rec.chat));
    assert.ok(/cleared/i.test(rec.chat[0].text), 'surviving row should be the confirmation: ' + rec.chat[0].text);
  });

  await t('/clear emits a state-update { kind: chat-clear } via ctx.session', async () => {
    const sid = 'sess-clr-b';
    const cwd = seedSession(sid, [
      { user: 'kkrazy', text: 'one', ts: '2026-05-14T00:00:00Z' },
    ]);
    const session = new EventEmitter();
    const seen = [];
    session.on('state-update', (payload) => seen.push(payload));
    await run('/clear', { sessionId: sid, absCwd: cwd, session });
    assert.ok(seen.some((p) => p && p.kind === 'chat-clear'),
      'expected at least one state-update with kind=chat-clear, got: ' + JSON.stringify(seen));
  });

  await t('/clear on a session with no prior chat reports 0 cleared without crashing', async () => {
    const sid = 'sess-clr-c';
    const cwd = seedSession(sid, []);
    const replies = await run('/clear', { sessionId: sid, absCwd: cwd });
    assert.ok(replies.some((r) => /cleared 0/i.test(r)),
      'expected "cleared 0" reply on empty chat: ' + JSON.stringify(replies));
  });

  await t('/clear is exposed via slashcmds.listCommands() so autocomplete picks it up', async () => {
    const found = slashcmds.listCommands().some((c) => c.name === 'clear');
    assert.ok(found, '/clear missing from listCommands() — chat-input dropdown will not surface it');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (failed) process.exit(1);
})();
