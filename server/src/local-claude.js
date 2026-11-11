// Shared one-shot LOCAL Claude invocation (Task B).
//
// Every myco subsystem that calls a model directly should be able to "走本机
// claude" (use the local claude + the machine's own ~/.claude/ auth) instead
// of (or alongside) an external API such as Google Gemini / api.anthropic.com.
//
// This helper is the single implementation of that path:
//   - runs @anthropic-ai/claude-agent-sdk's query() in-process (same auth as
//     the main AgentSession — claude.ai subscription, or ANTHROPIC_API_KEY,
//     or whatever ~/.claude/ has configured), and
//   - OPTIONALLY overlays the session's active gateway profile
//     (rec.activeGw → gateways.getProfile) so "自定义模型" (a custom
//     base_url / auth_token / model) applies to these one-shot calls too —
//     mirroring exactly how agent-session.js resolves gwEnv + sdkOpts.model
//     (see agent-session.js:415-534).
//
// Backward compatible: when no { user, activeGw } is passed, the overlay is
// a no-op and the call uses whatever process.env / ~/.claude/ already has —
// identical to the pre-Task-B behaviour of btw.js / claude-cli.js.
//
// Contract: always resolves. Returns the trimmed assistant text, or null on
// any failure (missing prompt, SDK init error, network/timeout abort). Callers
// decide how to degrade on null.
//
// Optional knobs (both default OFF, backward compatible):
//   detail        — an object the callee fills with `detail.error` describing
//                   WHY the call returned null (timeout / stall / sdk error /
//                   no text). Callers that need the reason pass one in.
//   stallTimeoutMs — stall watchdog: abort early when the stream opens but
//                   produces NO model output (no assistant message at all)
//                   within this window. Observed gateway failure mode: the
//                   stream stays alive streaming only thinking_tokens system
//                   estimates for 10+ minutes with zero assistant content.
//                   Aborting early lets the caller retry instead of burning
//                   the whole timeout. 0 disables the watchdog.

const DEFAULT_TIMEOUT_MS = 120000;

// Resolve the session's active gateway profile (rec.activeGw) into an env
// overlay + optional model. Mirrors agent-session.js:416-429 + 533-534.
function _resolveGateway(user, activeGw) {
  const gwEnv = {};
  let model;
  if (!user || !activeGw) return { gwEnv, model };
  try {
    const gw = require('./gateways').getProfile(user, activeGw);
    if (!gw) return { gwEnv, model };
    if (gw.baseUrl) gwEnv.ANTHROPIC_BASE_URL = gw.baseUrl;
    if (gw.authToken) gwEnv.ANTHROPIC_AUTH_TOKEN = gw.authToken;
    if (gw.model) gwEnv.ANTHROPIC_MODEL = gw.model;
    // The gateway's model is preferred; otherwise fall back to the system
    // default model from process.env (state/.env), else leave unset and let
    // the SDK pick. Same priority as agent-session.js:533-534.
    model = gw.model || process.env.ANTHROPIC_MODEL || undefined;
  } catch (err) {
    console.error(`[local-claude] gateway resolve failed for user=${user} name=${activeGw}: ${err.message}`);
  }
  return { gwEnv, model };
}

async function callLocalClaude({ system, userMessage, cwd, user, activeGw, timeoutMs = DEFAULT_TIMEOUT_MS, stallTimeoutMs = 0, detail } = {}) {
  if (!userMessage) return null;
  const { query } = require('@anthropic-ai/claude-agent-sdk');

  const fail = (reason) => {
    if (detail) detail.error = reason;
    return null;
  };

  const { gwEnv, model } = _resolveGateway(user, activeGw);

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { ac.abort(); } catch {}
    console.error(`[local-claude] timed out after ${timeoutMs}ms`);
  }, timeoutMs);
  // Stall watchdog (opt-in via stallTimeoutMs > 0): the stream can open and
  // stay "alive" streaming only thinking_tokens system noise while the model
  // never emits a single assistant message — a stuck upstream generation that
  // would otherwise burn the entire timeoutMs. Abort as soon as it's clear no
  // output is coming so the caller can retry cheaply.
  let stalled = false;
  // `let`, not `const`: the first assistant message nulls this out (line below)
  // to disarm the watchdog. A `const` here makes that reassignment throw
  // "Assignment to constant variable", turning every producing call into a
  // spurious `sdk error` failure (see bench/hle run 2026-10-31 — 14/56 single
  // answers with real model output were thrown away by it).
  let stallTimer = stallTimeoutMs > 0 ? setTimeout(() => {
    if (sawAssistant) return;   // model produced something → not a stall
    stalled = true;
    try { ac.abort(); } catch {}
    console.error(`[local-claude] stalled: no assistant output in ${stallTimeoutMs}ms (stream alive)`);
  }, stallTimeoutMs) : null;

  // Cleared the moment any assistant message arrives on the stream.
  let sawAssistant = false;

  // NOTE: the SDK option is `abortController` (an AbortController instance),
  // NOT `abortSignal` — agent-session.js bug-14 was exactly this mix-up.
  const options = {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ...gwEnv },
    allowedTools: [],          // pure text generation — no tool use
    permissionMode: 'dontAsk',
    settingSources: [],        // clean baseline: no project skills/slash-commands
    abortController: ac,
  };
  if (system) options.appendSystemPrompt = system;
  if (model) options.model = model;

  let stream;
  try {
    stream = query({ prompt: userMessage, options });
  } catch (err) {
    clearTimeout(timer);
    if (stallTimer) clearTimeout(stallTimer);
    console.error(`[local-claude] sdk init failed: ${err.message}`);
    return fail(`sdk init failed: ${err.message}`);
  }

  let finalText = '';
  let assistantText = '';
  try {
    for await (const m of stream) {
      if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
        sawAssistant = true;               // disarm the stall watchdog
        if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        for (const b of m.message.content) {
          if (b.type === 'text') assistantText += b.text;
        }
      }
      if (m.type === 'result') {
        finalText = typeof m.result === 'string' ? m.result : '';
      }
    }
  } catch (err) {
    clearTimeout(timer);
    if (stallTimer) clearTimeout(stallTimer);
    if (timedOut) return fail(`model timeout after ${timeoutMs}ms`);
    if (stalled) return fail(`model stalled: no assistant output in ${stallTimeoutMs}ms`);
    if (ac.signal.aborted) return fail('aborted before completion');
    console.error(`[local-claude] sdk error: ${err.message || String(err)}`);
    return fail(`sdk error: ${err.message || String(err)}`);
  }
  clearTimeout(timer);
  if (stallTimer) clearTimeout(stallTimer);
  const text = (finalText || assistantText).trim();
  return text || fail('model returned no text');
}

module.exports = { callLocalClaude, _resolveGateway };
