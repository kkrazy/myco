// AgentSession hook bodies for research mode.
//
// agent-session.js owns the SDK wiring (which hooks exist, when they are
// registered); the actual behaviour lives here so every KB-facing concern
// sits in server/src/knowledge/. Both functions take the live session as
// their first argument and never throw — a knowledge-base failure must not
// affect the turn.
//
//   userPromptSubmitHook(session, input) — retrieve + inject
//   maybeWriteKnowledge(session, m)      — extract + write back
//   isKbToolName(toolName)               — PreToolUse auto-allow predicate

'use strict';

const TOOL_PREFIX = 'mcp__myco_kb__';

function isKbToolName(toolName) {
  return typeof toolName === 'string' && toolName.startsWith(TOOL_PREFIX);
}

// UserPromptSubmit hook — research mode only. Searches the mounted
// knowledge bases with the user's prompt and returns the hits as
// additionalContext. Always fails open: a KB outage (or a slow service)
// must not delay or block the user's turn.
async function userPromptSubmitHook(session, input) {
  try {
    const prompt = input && (input.prompt || input.user_prompt);
    const sessionsMod = require('../sessions');
    const rec = sessionsMod.getSessionRecord(session.sessionId);
    if (!rec) return {};
    const inject = require('./inject');
    const effective = Object.assign({}, rec, { knowledgeBases: session.knowledgeBases });
    if (!inject.shouldInject(prompt, effective)) return {};
    const out = await inject.buildInjection(prompt, effective);
    for (const e of out.errors) {
      console.error(`[kb-inject] ${session.sessionId} ${e.kb}: ${e.error}`);
    }
    if (!out.block) return {};
    console.log(`[kb-inject] ${session.sessionId} injected ${out.results.length} hit(s) for "${String(prompt).slice(0, 60)}"`);
    session._emit({ type: 'knowledge_injected', count: out.results.length });
    return {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: out.block,
      },
    };
  } catch (err) {
    console.error(`[kb-inject] ${session && session.sessionId} failed: ${err.message}`);
    return {};
  }
}

// Turn-end knowledge write-back (research mode only). Reads the session
// record fresh so a mid-session /research toggle is honoured without a
// respawn. All failure modes are swallowed by the caller.
async function maybeWriteKnowledge(session, m) {
  if (!session.knowledgeBases || !session.knowledgeBases.length) return;
  const sessionsMod = require('../sessions');
  const rec = sessionsMod.getSessionRecord(session.sessionId);
  if (!rec || rec.researchMode !== true) return;
  const writer = require('./writer');
  const out = await writer.extractAndWrite({
    sessionId: session.sessionId,
    rec: Object.assign({}, rec, { knowledgeBases: session.knowledgeBases }),
    result: m && m.result,
    subtype: m && m.subtype,
    cwd: session.cwd,
    gw: { user: rec.user, activeGw: rec.activeGw },
  });
  if (out.written.length) {
    console.log(`[kb-writer] ${session.sessionId} recorded ${out.written.map((w) => w.slug).join(', ')}`);
    session._emit({
      type: 'knowledge_written',
      items: out.written,
      skipped: out.skipped,
    });
  }
  for (const e of out.errors) {
    console.error(`[kb-writer] ${session.sessionId} ${JSON.stringify(e)}`);
  }
}

module.exports = {
  TOOL_PREFIX,
  isKbToolName,
  userPromptSubmitHook,
  maybeWriteKnowledge,
};
