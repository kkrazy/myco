// fr-85 r4 server-side static guards.
//
// The clarify-in-place flow has two server touchpoints:
//   1. attach.js handleChatMessage: accepts opts.meta, tags the
//      message + sets session._pendingClarify when meta.kind=clarify.
//   2. agent-session.js _persistAssistantTextToRecChat: when
//      session._pendingClarify is set, tags the assistant reply
//      with meta.kind=clarify-reply AND emits a 'clarify-reply'
//      WS event so the popover can render it instead of letting
//      it pollute chat.
//
// These guards prevent a future refactor from quietly breaking the
// in-place flow (which would silently send clarifies back into chat).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sliceFn } = require('./_lib/fn-body');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const SESSION = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'agent-session.js'), 'utf8');
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');

console.log('── fr-85 r4: server-side clarify routing ──');

// ── attach.js ──────────────────────────────────────────────────────

t('attach.js: WS chat-frame parser forwards meta.kind=clarify only (security whitelist)', () => {
  // We pass through clarify-tagged meta but ignore other meta keys
  // to prevent a client from spoofing menu / mention / denied meta.
  const idx = ATTACH.search(/msg\.t === ['"]chat['"][\s\S]{0,200}msg\.text/);
  assert.ok(idx > -1, 'chat-frame parser branch must be findable');
  const win = ATTACH.slice(idx, idx + 1500);
  assert.ok(/msg\.meta[\s\S]{0,200}kind === ['"]clarify['"]/.test(win),
    'parser must check msg.meta.kind === "clarify" before forwarding');
  assert.ok(/opts\.meta\s*=/.test(win) || /opts = \{/.test(win),
    'parser must construct an opts object that handleChatMessage reads');
});

t('attach.js: handleChatMessage tags message meta + sets session._pendingClarify on clarify', () => {
  const idx = ATTACH.search(/function\s+handleChatMessage\s*\(/);
  assert.ok(idx > -1, 'handleChatMessage must be defined');
  // Slice big — handleChatMessage is ~80 lines + comment-heavy.
  const win = sliceFn(ATTACH, idx);
  assert.ok(/opts\.meta\.kind === ['"]clarify['"]/.test(win),
    'handleChatMessage must branch on opts.meta.kind === "clarify"');
  assert.ok(/message\.meta\s*=\s*\{\s*kind:\s*['"]clarify['"]/.test(win),
    'clarify branch must stamp message.meta = { kind: "clarify", selected: ... }');
  assert.ok(/session\._pendingClarify\s*=\s*\{[\s\S]{0,300}questionTs:/.test(win),
    'clarify branch must set session._pendingClarify with questionTs + selected');
});

t('attach.js: WS attach loop forwards `clarify-reply` session event to the client', () => {
  // The popover-as-response-surface model needs a dedicated WS frame
  // to route claude's reply back to the user's popover instead of
  // letting it render as a normal chat-msg / agent-event card.
  assert.ok(/session\.on\(['"]clarify-reply['"]/.test(ATTACH),
    'attach loop must register session.on("clarify-reply", ...)');
  // The forwarder is `ws.send(JSON.stringify({ t: 'clarify-reply', ...payload }))`.
  assert.ok(/ws\.send\(\s*JSON\.stringify\(\{\s*t:\s*['"]clarify-reply['"]/.test(ATTACH),
    'clarify-reply listener must forward the payload to the WS client via ws.send(JSON.stringify({t:"clarify-reply", ...}))');
});

// ── agent-session.js ───────────────────────────────────────────────

t('agent-session.js: r3 — _persistAssistantTextToRecChat tags + accumulates into pending.replyText', () => {
  // r3 architecture: while a clarify is in flight, persist still
  // tags the rec.chat record (audit trail) AND appends the chunk
  // into pending.replyText. The consolidated clarify-reply WS frame
  // fires once at turn-end from the result handler (so streamed
  // chunks coalesce into one popover update).
  const idx = SESSION.search(/_persistAssistantTextToRecChat\s*\(\s*text\s*\)\s*\{/);
  assert.ok(idx > -1, '_persistAssistantTextToRecChat must be defined');
  const win = SESSION.slice(idx, idx + 3000);
  assert.ok(/this\._pendingClarify/.test(win),
    'method must read this._pendingClarify');
  assert.ok(/msg\.meta\.kind\s*=\s*['"]clarify-reply['"]/.test(win),
    'reply meta must still be stamped (audit trail)');
  assert.ok(/msg\.meta\.clarifyQuestionTs\s*=/.test(win),
    'reply meta must still include clarifyQuestionTs');
  assert.ok(/replyText\s*=/.test(win),
    'r3: method must append the chunk into this._pendingClarify.replyText (consolidated WS emit at turn_result)');
});

t('agent-session.js: r3 — central _emit() is silent while _pendingClarify is set', () => {
  // The single choke point that suppresses ALL agent-event broadcasts
  // (assistant_text, tool_use, tool_result, permission_request,
  // chrome batch, claude-status, etc) during a clarify. Buffer + disk
  // persist still happen for the forensic record; only the live
  // this.emit("agent-event") call is gated.
  const idx = SESSION.search(/\n\s*_emit\s*\(\s*event\s*\)\s*\{/);
  assert.ok(idx > -1, '_emit(event) method must be defined');
  const win = SESSION.slice(idx, idx + 2000);
  assert.ok(/this\._pendingClarify/.test(win),
    '_emit must check this._pendingClarify');
  assert.ok(/if\s*\(\s*this\._pendingClarify\s*\)\s*return/.test(win),
    '_emit must `if (this._pendingClarify) return` BEFORE the agent-event broadcast');
  assert.ok(/this\.emit\(\s*['"]agent-event['"]/.test(win),
    '_emit still emits "agent-event" for non-clarify turns');
});

t('agent-session.js: r3 — consolidated clarify-reply fires from the result handler', () => {
  // The result handler (turn end) is where we flush the accumulated
  // replyText as a single clarify-reply WS frame. Pending is cleared
  // right after so turn_result + subsequent turns broadcast normally.
  // Anchor on the turn_result emit since the flush lives right
  // before it.
  const idx = SESSION.search(/this\._emit\(\s*\{\s*\n?\s*type:\s*['"]turn_result['"]/);
  assert.ok(idx > -1, 'turn_result emit must exist as anchor');
  const before = SESSION.slice(Math.max(0, idx - 1500), idx);
  assert.ok(/this\.emit\(\s*['"]clarify-reply['"]/.test(before),
    'clarify-reply emit must live in the result handler, just before the turn_result _emit');
  assert.ok(/this\._pendingClarify\s*=\s*null/.test(before),
    'pending must be cleared after the consolidated clarify-reply fires');
  assert.ok(/replyText/.test(before),
    'the emit must use the accumulated replyText (not a single chunk)');
});

t('attach.js: r2 — questionTs is round-tripped from the client meta (not server-generated)', () => {
  // Without this, server made its own questionTs in message.ts at
  // message-creation time, which never matched the client's
  // _clarifyState.questionTs → the clarify-reply WS frame dropped
  // silently on the client side → "nothing in the popover".
  // Fix: client ships questionTs in meta; server uses opts.meta.questionTs
  // when setting session._pendingClarify (with message.ts as a fallback).
  // WS parser must whitelist questionTs alongside selected.
  const parserIdx = ATTACH.search(/msg\.t === ['"]chat['"][\s\S]{0,200}msg\.text/);
  const parserWin = ATTACH.slice(parserIdx, parserIdx + 2000);
  assert.ok(/questionTs/.test(parserWin),
    'WS chat parser must whitelist meta.questionTs so it reaches handleChatMessage');
  // handleChatMessage must consume opts.meta.questionTs (with fallback).
  const idx = ATTACH.search(/function\s+handleChatMessage\s*\(/);
  const win = sliceFn(ATTACH, idx);
  assert.ok(/opts\.meta\.questionTs/.test(win),
    'handleChatMessage must use opts.meta.questionTs (the client-generated value)');
  assert.ok(/message\.ts/.test(win),
    'handleChatMessage should still have message.ts available as a fallback');
});

t('app.js: r2 — client passes questionTs in clarify meta', () => {
  const idx = APP.search(/function\s+_sendClarify\s*\(/);
  const win = sliceFn(APP, idx);
  // The questionTs must be in the meta object that sendChatMessage
  // sees — otherwise the server picks its own and the client never
  // matches the reply.
  assert.ok(/meta:\s*\{\s*kind:\s*['"]clarify['"][\s\S]{0,200}questionTs/.test(win),
    '_sendClarify must include questionTs in meta');
});

// r3 removed the per-site emit guards in favor of the central _emit
// gate (see "_emit() is silent while _pendingClarify is set" test
// above). The two `this._emit({type:'assistant_text',...})` call
// sites stay; they're no-ops for clients during a clarify because
// _emit early-returns.

t('attach.js: r7 — clarify branch wraps message.text with a brevity preamble before persistence', () => {
  // User: "The response should be as concise as possible". The
  // clarify branch must wrap message.text with an instruction that
  // tells claude to reply in 1-3 short sentences so the popover
  // doesn't fill with a multi-paragraph essay. The wrap is invisible
  // in chat (clarify rows are filtered from render) and the popover
  // preview shows the user's selected text, not the question — so
  // the wrap is purely an LLM-facing nudge.
  const idx = ATTACH.search(/function\s+handleChatMessage\s*\(/);
  assert.ok(idx > -1, 'handleChatMessage must be defined');
  const win = sliceFn(ATTACH, idx);
  // The brevity instruction must be applied to message.text inside
  // the clarify branch. We anchor on any brevity wording (r7 r2
  // strengthened this to "2-3 sentences MAX / terse") so the test
  // doesn't pin one exact phrasing.
  assert.ok(/message\.text\s*=[\s\S]{0,400}(concise|short sentences|sentences MAX|terse|brief)/i.test(win),
    'r7: clarify branch must rewrite message.text with a brevity instruction (concise / terse / N sentences MAX)');
  // The user's original text must be embedded in the wrapped string —
  // we don't want to lose what they actually asked.
  assert.ok(/message\.text\s*=[\s\S]{0,400}(\$\{text\}|`\s*\$\{|\+\s*text\b)/.test(win),
    'r7: the wrap must include the original `text` so claude sees the actual question');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
