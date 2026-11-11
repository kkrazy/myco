// fr-4 regression: /td /fr /bug with a long description (>8 words) OR the
// opt-in bang variants (/td!, /fr!, /bug!) kick off a claude rewrite that
// re-shapes the description into a tight issue-style body
// (problem / expected / actual / context). The item is saved IMMEDIATELY
// with the original text + meta.rewritePending=true, and the rewrite
// lands in-place once claude returns.
//
// Stubs btw.runClaudeP via Node's module cache so we don't hit the API.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-prw-'));
process.env.MYCO_STATE_DIR = path.join(tmpRoot, 'state');
process.env.MYCO_WORKSPACE = path.join(tmpRoot, 'wks');
fs.mkdirSync(process.env.MYCO_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.MYCO_WORKSPACE, { recursive: true });

// Allow-list a user so attach.js's _isKnownChatUser doesn't trip on
// require chains. (Not directly used by addPlanItem but slashcmds.js
// pulls in attach.js transitively in _persistPlanArtifact.)
fs.writeFileSync(
  path.join(process.env.MYCO_STATE_DIR, 'allowed-github-users.txt'),
  '# test fixture\nkkrazy\n',
);

// Stub btw.runClaudeP BEFORE slashcmds.js requires btw — we control the
// rewrite output deterministically and avoid a real claude invocation.
const btwPath = require.resolve('../server/src/btw');
const realBtw = require(btwPath);
let stubResponse = '**Problem:** the stub fired.';
let stubCalls = 0;
realBtw.runClaudeP = async function (_cwd, _prompt) {
  stubCalls++;
  return stubResponse;
};

const sessionsMod = require('../server/src/sessions');
const slashcmds = require('../server/src/slashcmds');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log('  ✓ ' + name); passed++; })
    .catch((err) => { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; });
}

function seedSession(sid) {
  const store = sessionsMod.loadStore();
  store.sessions = store.sessions || {};
  store.sessions[sid] = {
    id: sid,
    user: 'kkrazy',
    cwd: '.',
    absCwd: process.env.MYCO_WORKSPACE,
    createdAt: new Date().toISOString(),
    chat: [],
  };
  sessionsMod.saveStore();
}

function makeCtx(sid, args) {
  return {
    user: 'kkrazy',
    sessionId: sid,
    absCwd: process.env.MYCO_WORKSPACE,
    args,
    replies: [],
    reply(text) { this.replies.push(text); },
  };
}

function planItems(sid) {
  return sessionsMod.loadStore().sessions[sid].artifacts.plan.items;
}

// Pump the async rewrite to completion. addPlanItem's
// _rewritePlanItemAsync is fire-and-forget; Promise.resolve().then().then()
// is enough to let the awaited stub + the synchronous _applyPlanItemRewrite
// settle.
async function flushAsyncRewrite() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function main() {
  console.log('── plan-item LLM rewrite (fr-4) ──');

  await t('short item (≤8 words) is saved as-is, NO rewrite fires', async () => {
    const sid = 'sess-prw-short';
    seedSession(sid);
    const callsBefore = stubCalls;
    await slashcmds.dispatch(makeCtx(sid, 'fix the scrollbar color'), '/td fix the scrollbar color');
    await flushAsyncRewrite();
    const items = planItems(sid);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].text, 'fix the scrollbar color');
    assert.strictEqual(items[0].meta && items[0].meta.rewritten, undefined,
      'short item must not be marked rewritten');
    assert.strictEqual(items[0].meta && items[0].meta.rewritePending, undefined,
      'short item must not be marked rewritePending');
    assert.strictEqual(stubCalls, callsBefore,
      'claude rewrite must NOT fire for short items');
  });

  await t('long item (>8 words) triggers an async rewrite that replaces the text in place', async () => {
    const sid = 'sess-prw-long';
    seedSession(sid);
    stubResponse = '**Problem:** the chat pane shows the same chrome batch multiple times after a reconnect.\n\n**Expected:** one batch per turn.\n\n**Actual:** the batch repeats 2-4 times depending on the number of reconnects.';
    const callsBefore = stubCalls;
    const longText = 'when the websocket reconnects the chat pane shows the same chrome batch like × 10 multiple times in a row which is confusing';
    await slashcmds.dispatch(makeCtx(sid, longText), '/bug ' + longText);
    await flushAsyncRewrite();
    const items = planItems(sid);
    assert.strictEqual(items.length, 1, 'item must be persisted');
    assert.ok(items[0].text.startsWith('**Problem:**'),
      'after rewrite, item.text must be the stubbed issue-style body — got: ' + items[0].text.slice(0, 80));
    assert.strictEqual(items[0].meta.rewritten, true, 'meta.rewritten must be true');
    assert.strictEqual(items[0].meta.originalText, longText,
      'meta.originalText must preserve the user-typed body');
    assert.strictEqual(items[0].meta.rewriteRequested, 'long',
      'meta.rewriteRequested must record WHY the rewrite fired (long body)');
    assert.strictEqual(items[0].meta.rewritePending, undefined,
      'rewritePending must be cleared once rewrite lands');
    assert.strictEqual(stubCalls, callsBefore + 1,
      'claude rewrite must fire exactly once for the long item');
  });

  await t('short item with bang opt-in (/td!) forces the rewrite', async () => {
    const sid = 'sess-prw-bang';
    seedSession(sid);
    stubResponse = '**Problem:** dark mode toggle missing.\n\n**Expected:** persisted toggle in localStorage.';
    const callsBefore = stubCalls;
    // Parser splits /td! short into name='td', args='! short item desc'
    // because the regex stops at \b after the slash-name (the `!` is
    // non-word). addPlanItem detects the leading `!` and force-rewrites.
    await slashcmds.dispatch(makeCtx(sid, '! dark mode toggle'), '/td! dark mode toggle');
    await flushAsyncRewrite();
    const items = planItems(sid);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].meta.rewritten, true,
      'bang variant must end up with meta.rewritten=true');
    assert.strictEqual(items[0].meta.originalText, 'dark mode toggle',
      'meta.originalText must preserve the user-typed body (sans bang)');
    assert.strictEqual(items[0].meta.rewriteRequested, 'force',
      'bang variant must tag meta.rewriteRequested="force"');
    assert.strictEqual(stubCalls, callsBefore + 1,
      'bang variant must force the rewrite even on a 3-word body');
  });

  await t('rewrite failure (claude error stub) keeps the original text + sets rewriteFailed', async () => {
    const sid = 'sess-prw-fail';
    seedSession(sid);
    stubResponse = '(claude failed to start: simulated error)';
    const longText = 'this is a long enough description to trigger the auto rewrite path for the bug';
    await slashcmds.dispatch(makeCtx(sid, longText), '/bug ' + longText);
    await flushAsyncRewrite();
    const items = planItems(sid);
    assert.strictEqual(items[0].text, longText,
      'on rewrite failure the original text must be preserved untouched');
    assert.strictEqual(items[0].meta.rewritten, undefined);
    assert.strictEqual(items[0].meta.rewriteFailed, true);
    assert.strictEqual(items[0].meta.rewritePending, undefined,
      'rewritePending must be cleared even on failure');
  });

  await t('bang with NO body still rejects with usage hint', async () => {
    const sid = 'sess-prw-bang-empty';
    seedSession(sid);
    const ctx = makeCtx(sid, '!');
    await slashcmds.dispatch(ctx, '/td! ');
    const items = sessionsMod.loadStore().sessions[sid].artifacts &&
                  sessionsMod.loadStore().sessions[sid].artifacts.plan;
    assert.ok(!items || !items.items || items.items.length === 0,
      'empty bang must not create an item');
    assert.ok(ctx.replies.some((r) => /Usage:/.test(r)),
      'must reply with usage hint when the bang variant has no body');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  if (failed) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
