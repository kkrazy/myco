#!/usr/bin/env node
/*
 * Claude Agent SDK proof-of-concept for myco.
 *
 * Goal: drive ONE end-to-end query against this real project's cwd,
 * using the user's existing subscription credentials (no API key set),
 * exercise multiple built-in tools, force at least one canUseTool
 * callback, and dump every event shape so we can decide whether to
 * commit to the full PTY-→-SDK rewrite.
 *
 * Reads:
 *   - ~/.claude/.credentials.json   (OAuth tokens — auth)
 *   - ~/.claude/settings.json       (per-user config — settingSources)
 *   - $cwd/CLAUDE.md                (project instructions — auto-loaded)
 *
 * Writes:
 *   - _myco_/logs/agent-sdk-poc.log (full event stream, one event per line)
 *   - stdout                         (concise summary)
 *
 * Run:
 *   node agent-sdk-poc.mjs                       # default prompt
 *   POC_PROMPT='your prompt' node agent-sdk-poc.mjs
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const LOG_PATH = path.join(REPO_ROOT, '_myco_', 'logs', 'agent-sdk-poc.log');
await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
await fs.writeFile(LOG_PATH, ''); // truncate

const PROMPT = process.env.POC_PROMPT || (
  'I need a 2-line summary of what server/src/menu-interceptor.js does. ' +
  'Use Read or Glob to find the file, then summarise. ' +
  'Before finalising, use AskUserQuestion to confirm whether I want ' +
  'the summary as one sentence or as bullet points.'
);

console.log('═══ Claude Agent SDK POC ═══');
console.log('cwd:                 ', REPO_ROOT);
console.log('ANTHROPIC_API_KEY:   ', process.env.ANTHROPIC_API_KEY ? 'SET (length ' + process.env.ANTHROPIC_API_KEY.length + ')' : 'UNSET — using subscription OAuth');
console.log('credentials file:    ', '~/.claude/.credentials.json (mode 0600, populated by `claude login`)');
console.log('settings.json:       ', '~/.claude/settings.json (allow/deny + hooks + model defaults)');
console.log('event log:           ', LOG_PATH);
console.log('prompt:              ', PROMPT);
console.log('');

// Counter helpers so the summary at the end is concise.
const eventCounts = {};
const toolUseSummary = [];
let canUseToolCalls = 0;
const canUseToolLog = [];
let sessionId = null;
let resultBody = null;
let usage = null;
let costUsd = null;

function bump(type) { eventCounts[type] = (eventCounts[type] || 0) + 1; }

async function appendLog(obj) {
  await fs.appendFile(LOG_PATH, JSON.stringify(obj) + '\n');
}

// canUseTool — fires for tools that aren't pre-approved. We auto-allow
// Read / Glob / Grep / Bash to keep the POC moving; for AskUserQuestion
// we synthesise a "bullet points" answer so we can see the full
// round-trip shape.
const canUseTool = async (toolName, input, ctx) => {
  canUseToolCalls++;
  const entry = {
    at: new Date().toISOString(),
    toolName,
    inputKeys: Object.keys(input || {}),
    inputSample: JSON.stringify(input).slice(0, 400),
    suggestionsCount: Array.isArray(ctx?.suggestions) ? ctx.suggestions.length : 0,
  };
  canUseToolLog.push(entry);
  await appendLog({ event: 'canUseTool', ...entry });

  if (toolName === 'AskUserQuestion') {
    // Build the answers object the SDK expects.
    const answers = {};
    for (const q of (input.questions || [])) {
      const opt = (q.options || [])[1] || (q.options || [])[0];   // pick option #2 if available
      if (opt) answers[q.question] = opt.label;
    }
    await appendLog({ event: 'canUseTool.AskUserQuestion.answer', answers });
    return { behavior: 'allow', updatedInput: { questions: input.questions, answers } };
  }
  // Auto-approve safe read-only tools, deny anything else.
  if (['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'].includes(toolName)) {
    return { behavior: 'allow', updatedInput: input };
  }
  return { behavior: 'deny', message: 'POC denies anything outside the safe read-only set' };
};

const t0 = Date.now();
try {
  const stream = query({
    prompt: PROMPT,
    options: {
      cwd: REPO_ROOT,
      permissionMode: 'default',           // unmatched tools → canUseTool
      allowedTools: [],                    // force canUseTool for everything (incl. AskUserQuestion)
      canUseTool,
      // Don't load skills/agents from .claude/ for the POC — we want a
      // clean baseline so the event log is interpretable.
      settingSources: [],
    },
  });

  for await (const m of stream) {
    bump(m.type || 'unknown');
    const summary = { event: 'stream', type: m.type, subtype: m.subtype || null };

    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id || m.data?.session_id || null;
      summary.session_id = sessionId;
      summary.model = m.model || m.data?.model || null;
      summary.tools = (m.tools || m.data?.tools || []).slice(0, 12);
      console.log('[system/init]   session=' + sessionId + '  model=' + (summary.model || '?'));
      console.log('                tools=' + (summary.tools || []).join(', '));
    }

    if (m.type === 'assistant' && m.message?.content) {
      for (const block of m.message.content) {
        if (block.type === 'text') {
          summary.text = (block.text || '').slice(0, 200);
          process.stdout.write('[assistant.text] ' + summary.text + '\n');
        } else if (block.type === 'tool_use') {
          const t = { id: block.id, name: block.name, input: JSON.stringify(block.input).slice(0, 200) };
          toolUseSummary.push(t);
          summary.tool_use = t;
          console.log('[assistant.tool_use] ' + t.name + ' id=' + t.id + ' input=' + t.input);
        }
      }
    }

    if (m.type === 'user' && m.message?.content) {
      for (const block of m.message.content) {
        if (block.type === 'tool_result') {
          const txt = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content) ? block.content.map(c => c.text || '').join('').slice(0, 200) : '';
          summary.tool_result = { tool_use_id: block.tool_use_id, contentSample: txt.slice(0, 200), isError: !!block.is_error };
          console.log('[user.tool_result] for=' + block.tool_use_id + ' ' + (block.is_error ? 'ERROR' : 'ok') + ' bytes=' + txt.length);
        }
      }
    }

    if (m.type === 'result') {
      resultBody = (m.result || '').slice(0, 400);
      usage = m.usage || null;
      costUsd = m.total_cost_usd ?? null;
      summary.result = resultBody;
      console.log('[result]        subtype=' + m.subtype + '  cost=$' + costUsd);
    }

    await appendLog(summary);
  }
} catch (err) {
  console.error('FAILED:', err && err.message ? err.message : err);
  await appendLog({ event: 'fatal', error: String(err) });
  process.exit(1);
}

const dt = Date.now() - t0;
console.log('');
console.log('═══ Summary ═══');
console.log('elapsed:           ' + dt + 'ms');
console.log('events by type:    ' + JSON.stringify(eventCounts));
console.log('tool_use blocks:   ' + toolUseSummary.length);
for (const t of toolUseSummary) console.log('  - ' + t.name + ' ' + t.input.slice(0, 100));
console.log('canUseTool calls:  ' + canUseToolCalls);
for (const c of canUseToolLog) console.log('  - ' + c.toolName + ' keys=[' + c.inputKeys.join(',') + ']');
console.log('session_id:        ' + sessionId);
console.log('usage:             ' + (usage ? JSON.stringify({ input: usage.input_tokens, output: usage.output_tokens, cache_read: usage.cache_read_input_tokens, cache_creation: usage.cache_creation_input_tokens }) : 'null'));
console.log('total cost:        $' + costUsd);
console.log('');
console.log('Full event stream written to ' + LOG_PATH);
console.log('Inspect with:      jq . ' + LOG_PATH);
