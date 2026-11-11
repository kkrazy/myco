// In-process SDK MCP server exposing the Delm board as structured tools.
//
// Replaces Delm's /tools/context.sh shell channel. Two worker AgentSessions
// each get their own instance of this board-MCP server, so each binds a
// distinct `actor` in closure — the ITS board tracks last_read / claims per
// actor correctly while all tools share the same DelmBoard instance.
//
// Tool surface mirrors Delm's context_client.py ACTIONS (read / status /
// publish / claim / reserve / done / note / expand / apply) so prompts_n2.py
// orchestration reads naturally against `mcp__board__*` tool calls.
//
// Unlike the shell client, `apply` and `--attach` need no separate "current
// file hash" step: this server runs in the same Node process, so it reads /
// writes the worker's shared workspace directly (cwd), matching Delm's
// run_apply semantics (current copy vs peer-original cross-author checks).

'use strict';

const { createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const BOARD_MCP_TOOL_PREFIX = 'mcp__board__';

// Reject paths outside the workspace or /tmp scratch, matching board.checkPath.
function checkLocalPath(p, cwd) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('every attached file needs a path');
  if (p.startsWith('/')) {
    if (!p.startsWith('/tmp/') && p !== '/tmp') throw new Error(`${p}: absolute paths allowed only under /tmp`);
    return p;
  }
  const resolved = path.resolve(cwd, p);
  if (!resolved.startsWith(path.resolve(cwd) + path.sep)) {
    throw new Error(`${p}: path must stay inside the workspace`);
  }
  return resolved;
}

// Attach files are given as bare paths; read their content from the shared
// workspace (or /tmp for absolute paths). Returns [{path, content, mode}].
function readAttach(files, cwd) {
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const raw of files) {
    const rel = typeof raw === 'string' ? raw : (raw && raw.path);
    const abs = checkLocalPath(rel, cwd);
    const content = fs.readFileSync(abs, 'utf8');
    const mode = (() => { try { return fs.statSync(abs).mode & 1 ? 'x' : '-'; } catch { return '-'; } })();
    out.push({ path: rel, content, mode });
  }
  return out;
}

// listAttached returns the entry's attached paths so apply can hash current
// copies without leaking content into the prompt.
function localHashes(cwd, paths) {
  const local = {};
  for (const rel of paths) {
    const abs = checkLocalPath(rel, cwd);
    try {
      local[rel] = require('crypto').createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    } catch {
      local[rel] = null;
    }
  }
  return local;
}

// Apply the granted files into the shared workspace: mkdir, write tmp, rename.
function writeGranted(cwd, files) {
  const written = [];
  for (const f of files) {
    const abs = checkLocalPath(f.path, cwd);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.board-tmp';
    fs.writeFileSync(tmp, f.content, 'utf8');
    if (f.mode === 'x') fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, abs);
    written.push(f.path);
  }
  return written;
}

// Deterministic request_id for done/note so a repeated identical publication
// is idempotent even if the model retries (mirrors Delm publication_request_id).
function publicationRequestId(toolName, args, files) {
  const payload = { kind: toolName === 'done' ? 'done' : 'note', ...args, files: files || null };
  return require('crypto').createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function text(result) {
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
    isError: false,
  };
}

function err(errObj) {
  const message = errObj && errObj.message ? errObj.message : String(errObj);
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Create the board MCP server for one worker.
 *
 * @param {import('./board').DelmBoard} board
 * @param {string} actor  this worker's board identity ('worker-A' / 'worker-B')
 * @param {object} [opts]
 * @param {string} [opts.cwd]  shared workspace root (for apply writes + attach reads)
 */
function createBoardMcpServer(board, actor, { cwd } = {}) {
  const workdir = cwd || process.cwd();
  return createSdkMcpServer({
    name: 'board',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'read',
        'Read the shared board. First view is complete; later views show only active ' +
        'work, new publications and changed statuses since your last served view. ' +
        'Pass wait>0 to block until a peer publishes or ends (at most 25s); ' +
        'pass for=<id> to wait for a specific item/publication. Unchanged active ' +
        'items show identity and owner.',
        {
          all: z.boolean().optional().describe('Full view of all entries, not just since last read.'),
          wait: z.number().min(1).max(25).optional().describe('Wait up to N seconds for a peer update.'),
          for: z.string().optional().describe('Wait until this item/publication is available.'),
        },
        async (args) => {
          try {
            return text(board.read(actor, { all: args.all, waitSeconds: args.wait, target: args.for }));
          } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
      tool(
        'status',
        'State a changed question, configuration, dependency or scope on the board.',
        { text: z.string().min(1).max(200).describe('Short status text (target 200 chars).') },
        async (args) => {
          try { return text(board.status(actor, args.text)); } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
      tool(
        'publish',
        'Publish open items (does not claim). Matching subjects reuse existing items. ' +
        'Each item needs a subject and a detail naming its output, inputs, interface ' +
        'and first usable dependency. Publish complementary, non-overlapping work.',
        {
          items: z.array(z.object({
            subject: z.string().min(1).max(120),
            detail: z.string().min(1).max(2000),
          })).min(1).max(20),
        },
        async (args) => {
          try { return text(board.publish(actor, args.items)); } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
      tool(
        'claim',
        'Claim an open item. First claim wins; a loss names the owner. One unfinished ' +
        'claim per worker.',
        { item: z.string().describe('Item id to claim.') },
        async (args) => {
          try { return text(board.claim(actor, args.item)); } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
      tool(
        'reserve',
        'Atomically create and claim one scope if your claim slot is free. Matching ' +
        'subjects reuse open items, report claimed owners, or remain done.',
        {
          subject: z.string().min(1).max(120).describe('Scope title (matches ignoring case/whitespace).'),
          detail: z.string().min(1).max(2000).describe('What you will produce, inputs and interface.'),
        },
        async (args) => {
          try { return text(board.reserve(actor, args.subject, args.detail)); } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
      tool(
        'done',
        'Finish your claim with results, affected files, limitations and check outcomes. ' +
        'Optionally attach files (paths relative to the workspace, or absolute under /tmp). ' +
        'Repeated identical calls are idempotent.',
        {
          item: z.string().describe('Claimed item id to complete.'),
          summary: z.string().min(1).max(800).describe('Result summary (target 800 chars).'),
          attach: z.array(z.string()).optional().describe('File paths to attach.'),
        },
        async (args) => {
          try {
            let files;
            try { files = readAttach(args.attach, workdir); }
            catch (e) { return err(e); }
            const requestId = publicationRequestId('done', args, files);
            return text(board.done(actor, args.item, args.summary, files, requestId));
          } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
      tool(
        'note',
        'Publish a finding: FACT (supported by observations) or FAIL (contradicted ' +
        'approach/hypothesis). State scope and reproducible evidence. Optionally attach ' +
        'the runnable command or script.',
        {
          type: z.enum(['FACT', 'FAIL']),
          text: z.string().min(1).max(400).describe('The finding (target 400 chars).'),
          scope: z.string().min(1).max(120).describe('Scope (target 120 chars).'),
          basis: z.string().min(1).max(200).describe('Evidence / measured results (target 200 chars).'),
          attach: z.array(z.string()).optional().describe('File paths to attach.'),
        },
        async (args) => {
          try {
            let files;
            try { files = readAttach(args.attach, workdir); }
            catch (e) { return err(e); }
            const requestId = publicationRequestId('note', args, files);
            return text(board.note(actor, args.type, args.text, args.scope, args.basis, files, requestId));
          } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
      tool(
        'expand',
        'Show an attachment\'s diff against its original (or full content for new files / --only).',
        {
          id: z.string().describe('Publication id of the done/note.'),
          only: z.array(z.string()).optional().describe('Only these paths.'),
        },
        async (args) => {
          try { return text(board.expand(actor, args.id, args.only)); } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
      tool(
        'apply',
        'Copy a publication\'s attached files over your local copies, subject to ' +
        'cross-author conflict protection (identical = unchanged; identical to the ' +
        'original or to an older peer copy = write; divergent local edit or a newer ' +
        'peer version = conflict/kept, nothing written). Unknown local edits refuse ' +
        'the selected batch. Use --only to restrict paths.',
        {
          id: z.string().describe('Publication id to apply.'),
          only: z.array(z.string()).optional().describe('Only these paths.'),
        },
        async (args) => {
          try {
            const info = board.attached(actor, args.id);
            const paths = info.files.map((f) => f.path);
            const local = localHashes(workdir, args.only && args.only.length ? args.only : paths);
            const res = board.apply(actor, args.id, local, args.only);
            if (!res.applied) {
              return text({ id: res.id, author: res.author, applied: false, decisions: res.decisions, conflicts: res.conflicts });
            }
            const written = writeGranted(workdir, res.files);
            const result = board.applyResult(actor, args.id, written, true);
            return text({ id: res.id, author: res.author, applied: true, decisions: res.decisions, written, view: result.view });
          } catch (e) { return err(e); }
        },
        { alwaysLoad: true }
      ),
    ],
  });
}

module.exports = { createBoardMcpServer, BOARD_MCP_TOOL_PREFIX };
