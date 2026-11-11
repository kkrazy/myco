// Delm n=1 (2026-10-23): composer ArrowUp/ArrowDown recall must only
// surface inputs the user actually typed into the composer — never
// rows the interface printed (run-queue auto-dispatch bodies,
// login-callback echoes, assistant replies, or a teammate's input).
//
// User report (paraphrased): "输入框，只记录从自己这里输入的内容，
// 不要把界面打印的也能通过上下箭头翻找…也就是输入的时候能分清
// 这个事情" — the input box must only recall what THIS user typed
// here; server-printed rows must not be reachable via the arrows.
//
// Fix shape (two halves):
//   server: handleChatMessage stamps meta.fromUserInput:true on every
//     row that went through the canonical user-typed path (ASSISTANT
//     rows excluded). Server-generated rows (run-queue dispatch via
//     _advanceRunQueue / _enqueueAndKickIfIdle, fr-103 login-callback
//     echo, auto-replies) never pass through that path, so they carry
//     no flag. The mention + clarify meta rewrites MERGE the flag
//     instead of clobbering it; the clarify path also banks the RAW
//     question in meta.recallText so recall never surfaces the LLM
//     wrap.
//   client: _hydrateChatInputHistory accepts a row ONLY when
//     meta.fromUserInput === true AND r.user === state.chatUser,
//     preferring meta.recallText over text.
//
// These tests use static source-shape guards (same convention as the
// rest of the suite — no jsdom) plus a behavioral check on the server
// side through the real sessions module.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ROOT = path.join(__dirname, '..');
const PROD_ATTACH = fs.readFileSync(path.join(ROOT, 'server', 'src', 'attach.js'), 'utf8');
const PROD_APP = fs.readFileSync(path.join(ROOT, 'web', 'public', 'app.js'), 'utf8');

console.log('── delm-1: input-history recall provenance ──');

// ──────────────────────────────────────────────────────────────────────
// Server: canonical user-typed path stamps fromUserInput
// ──────────────────────────────────────────────────────────────────────

function _grabHandleChatBody(src) {
  const start = src.search(/function\s+handleChatMessage\s*\(/);
  if (start === -1) return '';
  // Slice to the end of the function via the next column-0 `}` —
  // hand-picked byte windows are forbidden (CLAUDE.md §10b).
  const rest = src.slice(start);
  const end = rest.indexOf('\n}');
  return rest.slice(0, end === -1 ? undefined : end);
}

t('attach.js: handleChatMessage stamps meta.fromUserInput on non-assistant rows', () => {
  const body = _grabHandleChatBody(PROD_ATTACH);
  assert.ok(body.length > 0, 'handleChatMessage must exist');
  assert.match(body, /if\s*\(\s*user\s*!==\s*ASSISTANT_USER\s*\)\s*message\.meta\.fromUserInput\s*=\s*true/,
    'the canonical user-typed path must stamp meta.fromUserInput:true — this flag is the ONLY provenance signal the client hydrate trusts');
});

t('attach.js: mention meta rewrite MERGES fromUserInput instead of clobbering', () => {
  const body = _grabHandleChatBody(PROD_ATTACH);
  const at = body.search(/if\s*\(\s*mentionTarget\s*&&\s*user\s*!==\s*ASSISTANT_USER\s*\)/);
  assert.ok(at > -1, 'mention branch must exist');
  const win = body.slice(at, at + 900);
  assert.match(win, /Object\.assign\(\s*\{\s*fromUserInput:\s*true\s*\}/,
    'the mention branch replaces message.meta — it must merge the fromUserInput flag back in, else mentions vanish from recall');
});

t('attach.js: clarify meta rewrite MERGES fromUserInput', () => {
  const body = _grabHandleChatBody(PROD_ATTACH);
  const at = body.search(/opts\.meta\.kind\s*===\s*['"]clarify['"]/);
  assert.ok(at > -1, 'clarify branch must exist');
  const win = body.slice(at, at + 900);
  assert.match(win, /Object\.assign\(\s*\{\s*fromUserInput:\s*true\s*\}/,
    'the clarify branch replaces message.meta — it must merge the fromUserInput flag back in');
});

t('attach.js: clarify path banks the RAW question in meta.recallText', () => {
  const body = _grabHandleChatBody(PROD_ATTACH);
  const at = body.search(/opts\.meta\.kind\s*===\s*['"]clarify['"]/);
  const win = body.slice(at, at + 2200);
  assert.match(win, /message\.meta\.recallText\s*=\s*text/,
    'the clarify LLM wrap must not become the recall text — the raw user question must be banked in meta.recallText before message.text is rewritten');
  const recallAt = win.indexOf('message.meta.recallText');
  const wrapAt = win.indexOf('message.text = `[Clarification request');
  assert.ok(recallAt > -1 && wrapAt > -1 && recallAt < wrapAt,
    'recallText must be assigned BEFORE message.text is rewritten (otherwise the wrapped text could be banked by mistake)');
});

t('attach.js: server-generated chat rows are NOT stamped fromUserInput', () => {
  // The run-queue auto-dispatch (attach.js _advanceRunQueue + artifacts.js
  // _enqueueAndKickIfIdle) and the fr-103 login-callback echo construct
  // their own messages — none of them may grow fromUserInput.
  const loginAt = PROD_ATTACH.search(/kind:\s*['"]login-callback['"]/);
  assert.ok(loginAt > -1, 'login-callback echo must exist');
  const win = PROD_ATTACH.slice(loginAt - 400, loginAt + 400);
  assert.ok(!/fromUserInput/.test(win),
    'the login-callback echo (an OAuth code piped to a subprocess, printed by the interface) must NOT carry fromUserInput');
  const artifacts = fs.readFileSync(path.join(ROOT, 'server', 'src', 'artifacts.js'), 'utf8');
  const runAt = artifacts.search(/function\s+buildArtifactRunText\s*\(/);
  const runWin = artifacts.slice(runAt, artifacts.indexOf('\n}', runAt));
  assert.ok(!/fromUserInput/.test(runWin),
    'buildArtifactRunText (auto-dispatch body) must not stamp fromUserInput — it flows through handleChatMessage as a server-generated row');
});

// ──────────────────────────────────────────────────────────────────────
// Server behavioral: getChatHistory round-trips the flag + seq
// ──────────────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-delm1-'));
process.env.MYCO_STATE_DIR = tmpRoot;
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

const sessionsMod = require(path.join(ROOT, 'server', 'src', 'sessions'));

t('sessions: appendChatMessage preserves a caller-supplied meta.fromUserInput flag through getChatHistory', () => {
  const sid = 'delm1-provenance';
  const store = sessionsMod.loadStore();
  store.sessions[sid] = {
    id: sid, user: 'alice', cwd: '.', absCwd: process.env.MYCO_WORKSPACE,
    claudeSessionId: null, createdAt: new Date().toISOString(), chat: [],
  };
  sessionsMod.appendChatMessage(sid, {
    user: 'alice', text: 'fix the login bug', ts: new Date().toISOString(),
    meta: { fromUserInput: true },
  });
  // Server-generated row (the shape _advanceRunQueue dispatches): no flag.
  sessionsMod.appendChatMessage(sid, {
    user: 'alice', ts: new Date().toISOString(),
    text: '[◆ Todo · submitted by @alice]\nfix the login bug',
  });
  const rows = sessionsMod.getChatHistory(sid, {});
  assert.strictEqual(rows.length, 2, 'both rows must round-trip');
  const typed = rows.find((r) => r.text === 'fix the login bug');
  const auto = rows.find((r) => r.text.includes('[◆ Todo'));
  assert.ok(typed && typed.meta && typed.meta.fromUserInput === true,
    'user-typed row must keep meta.fromUserInput:true through getChatHistory');
  assert.ok(auto && !(auto.meta && auto.meta.fromUserInput),
    'server-generated row must NOT carry fromUserInput (recall must skip it)');
  assert.ok(typed.meta.seq && auto.meta.seq && typed.meta.seq < auto.meta.seq,
    'seq order must be preserved');
});

// ──────────────────────────────────────────────────────────────────────
// Client: hydrate gates on fromUserInput + own user + recallText
// ──────────────────────────────────────────────────────────────────────

function _grabHydrate(src) {
  const start = src.search(/async\s+function\s+_hydrateChatInputHistory\s*\(/);
  if (start === -1) return '';
  const rest = src.slice(start);
  const end = rest.indexOf('\n}');
  return rest.slice(0, end === -1 ? undefined : end);
}

t('app.js: _hydrateChatInputHistory exists', () => {
  assert.ok(_grabHydrate(PROD_APP).length > 0,
    'the hydrate helper must exist (fr-78 r2 cross-device recall)');
});

t('app.js: hydrate requires meta.fromUserInput === true (interface-printed rows are excluded)', () => {
  const body = _grabHydrate(PROD_APP);
  assert.match(body, /fromUserInput\s*!==\s*true/,
    'the hydrate collect gate must skip rows without meta.fromUserInput:true — this is the core of the fix: server-printed rows (run-queue dispatch bodies, auto-replies) never surface via ArrowUp/ArrowDown');
});

t('app.js: hydrate only recalls rows from the logged-in user (state.chatUser)', () => {
  const body = _grabHydrate(PROD_APP);
  assert.match(body, /state\.chatUser\s*&&\s*r\.user\s*!==\s*state\.chatUser/,
    'multi-user sessions must not put a teammate\'s typed inputs into MY arrow-key recall');
});

t('app.js: hydrate prefers meta.recallText over the wrapped text', () => {
  const body = _grabHydrate(PROD_APP);
  assert.match(body, /r\.meta\.recallText/,
    'the collect gate must prefer the raw recallText banked by the server so the clarify LLM wrap never surfaces');
});

t('app.js: live submitChat push stays bounded to composer-sourced sends', () => {
  // The live path (this page-load) only ever pushes `submitted` (the
  // composer's value at send time), which by construction is the
  // user's own typed text — but pin the shape so a future refactor
  // can't route interface text through it.
  const at = PROD_APP.search(/function\s+submitChat\s*\(/);
  const body = PROD_APP.slice(at, PROD_APP.indexOf('\n  }', at) > -1 ? PROD_APP.indexOf('\n  }\n', at) : at + 4000);
  assert.match(body, /\.push\(submitted\)|hist\.push\(submitted\)|\.push\s*\(\s*submitted\s*\)/,
    'submitChat may only push the composer-submitted value onto chatInputHistory');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
