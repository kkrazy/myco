// agents/rlm/mcp.js — MCP server exposing the RLM kernel to the SDK
// session (design §4.4). The claude agent executes code cells in the
// persistent kernel via `mcp__rlm__rlm_eval(code)`; the tool's zod input
// schema is the typed parameter-validation layer.
//
// Pattern mirrors server/src/myco-mcp.js (in-process SDK MCP server,
// one per session, tools auto-allowed via agent-session _preToolUseHook).
//
// Tools:
//   rlm_eval(code)          — execute a code cell in the persistent
//                             namespace; returns stdout/stderr/result text.
//   rlm_list_names()        — list kernel namespace variables.
//   rlm_snapshot(path)      — serialize the namespace to a file.
//   rlm_restore(path)       — restore the namespace from a file.
//   rlm_list_subagents()    — list this session's spawned sub-agents
//                             (from the ledger — survives restarts).

'use strict';

const path = require('path');
const { createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');

const RLM_MCP_TOOL_PREFIX = 'mcp__rlm__';

// Cap for the text blob returned per rlm_eval call (design §8 risk 4:
// result 1 MiB aligns with prime's caps; the kernel also caps its own
// result repr, this is the transport-side belt).
const RESULT_TEXT_CAP = 1024 * 1024;

function _cap(text, cap = RESULT_TEXT_CAP) {
  const s = String(text == null ? '' : text);
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n…[truncated ${s.length - cap} chars]`;
}

// Build the tool response for one execute round-trip: stdout, stderr and
// the result repr are folded into a single text blob (labels when
// present) so the model sees everything in order.
function _formatExecuteResult(ev) {
  const parts = [];
  if (ev.stdout) parts.push('[stdout]\n' + ev.stdout);
  if (ev.stderr) parts.push('[stderr]\n' + ev.stderr);
  if (ev.error) {
    parts.push(`[error] ${ev.error.ename}: ${ev.error.evalue}` +
      (Array.isArray(ev.error.traceback) && ev.error.traceback.length
        ? '\n' + ev.error.traceback.join('\n') : ''));
  }
  if (ev.resultText != null) parts.push('[result]\n' + ev.resultText);
  if (!parts.length) parts.push('(no output)');
  return _cap(parts.join('\n'));
}

// Create the RLM MCP server for one session. `manager` is the session's
// ReplKernelManager (kernel/manager.js); `sessionId` is used by the
// sub-agent roster tool (ledger rebuild via children.js).
function createServer({ manager, sessionId }) {
  return createSdkMcpServer({
    name: 'rlm',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'rlm_eval',
        'Execute a JavaScript code cell in the session\'s PERSISTENT RLM kernel. ' +
        'The namespace (variables, `state`, `rlm`) survives across calls and turns — ' +
        'use it to maintain state.task / state.done / state.next / state.blockers and ' +
        'to call rlm.spawn / rlm.collect for sub-agent work. Supports top-level await. ' +
        'Not a sandbox: destructive commands still go through the permission flow.',
        { code: z.string().min(1).max(1024 * 1024).describe('JavaScript source to evaluate in the persistent namespace.') },
        async (args) => {
          try {
            const ev = await manager.execute(String(args.code));
            const text = _formatExecuteResult(ev);
            // stats (task req c): count the kernel round-trip + the
            // context traffic it produced, so /rlm status can report how
            // many times the UI/agent triggered RLM and what it returned.
            try {
              const stats = require('./stats');
              stats.recordEval(sessionId, String(args.code).length, text.length);
            } catch {}
            return { content: [{ type: 'text', text }] };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `[kernel-error] ${err.message}` }],
              isError: true,
            };
          }
        },
        { alwaysLoad: true }
      ),
      tool(
        'rlm_list_names',
        'List the variable names currently defined in the persistent RLM kernel namespace.',
        {},
        async () => {
          try {
            const names = await manager.listNames();
            return { content: [{ type: 'text', text: JSON.stringify(names) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `[kernel-error] ${err.message}` }], isError: true };
          }
        },
        { alwaysLoad: true }
      ),
      tool(
        'rlm_snapshot',
        'Serialize the RLM kernel namespace (working variables incl. `state`) to a JSON file so it survives process restarts. Paths are resolved inside the session workspace.',
        { path: z.string().min(1).max(1024).describe('Workspace-relative or absolute file path for the snapshot.') },
        async (args) => {
          try {
            const abs = path.resolve(manager.cwd || process.cwd(), String(args.path));
            const r = await manager.snapshot(abs);
            return { content: [{ type: 'text', text: `snapshot ok: ${abs} (${r.variables} vars${r.pruned ? `, ${r.pruned} pruned oversized` : ''})` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `[kernel-error] ${err.message}` }], isError: true };
          }
        },
        { alwaysLoad: true }
      ),
      tool(
        'rlm_restore',
        'Restore the RLM kernel namespace from a snapshot file written by rlm_snapshot.',
        { path: z.string().min(1).max(1024).describe('Snapshot file path (same form given to rlm_snapshot).') },
        async (args) => {
          try {
            const abs = path.resolve(manager.cwd || process.cwd(), String(args.path));
            const r = await manager.restore(abs);
            return { content: [{ type: 'text', text: `restore ok: ${abs} (${r.variables} vars)` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `[kernel-error] ${err.message}` }], isError: true };
          }
        },
        { alwaysLoad: true }
      ),
      tool(
        'rlm_list_subagents',
        'List this session\'s RLM sub-agents (spawned via the kernel\'s rlm.spawn) with name, status and depth. Rebuilt from the spawn ledger, so it survives server restarts.',
        {},
        async () => {
          try {
            const host = require('./host');
            const roster = host.listSubagents(sessionId);
            return { content: [{ type: 'text', text: JSON.stringify(roster, null, 2) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `[rlm-error] ${err.message}` }], isError: true };
          }
        },
        { alwaysLoad: true }
      ),
    ],
  });
}

module.exports = { createServer, RLM_MCP_TOOL_PREFIX, RESULT_TEXT_CAP };
