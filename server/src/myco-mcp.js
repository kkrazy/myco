// In-process SDK MCP server hosting myco's own custom tools.
// Currently exposes:
//   mcp__myco__add_plan_items — append todo / feature-request /
//     bug items to this session's Plan tab. Replaces the previous
//     "ask claude to edit plan.json with the Edit tool" flow with
//     a typed, server-validated call; no more reliance on claude
//     correctly serializing JSON.
//   mcp__myco__register_task_item (fr-87) — register a SDK-task ↔
//     plan-item association in the session's task-items registry
//     (_myco_/task-items.json). Lets `/task` inside a per-item chat
//     panel filter to that item's tasks authoritatively (server reads
//     the registry; no reliance on prompt-based filtering).
//
// One MCP server is created per AgentSession so the tool handler
// can capture sessionId in closure. agent-session.js passes
// `{ myco: createMycoMcpServer(sessionId) }` into sdkOpts.mcpServers.

const fs = require('fs');
const path = require('path');
const { createSdkMcpServer, tool } = require('@anthropic-ai/claude-agent-sdk');
const { z } = require('zod');

// Tool-name prefix the SDK applies to MCP server tools:
//   mcp__<server-name>__<tool-name>
// Our PreToolUse hook auto-allows anything starting with
// `mcp__myco__` so the user isn't prompted for our own internal
// tools. See agent-session.js _preToolUseHook.
const MYCO_MCP_TOOL_PREFIX = 'mcp__myco__';

function _layerPrefix(layer) {
  if (layer === 'Todo') return 'td';
  if (layer === 'Feature') return 'fr';
  if (layer === 'Bug') return 'bug';
  return null;
}

// Append a batch of items to the session's plan.json. Generates
// fresh ids per layer (td-N / fr-N / bug-N) by scanning existing
// items. Returns { ok, message, ids }.
function _appendPlanItems(sessionId, items) {
  const sessionsMod = require('./sessions');
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return { ok: false, message: `session ${sessionId} not found` };
  if (!rec.artifacts) rec.artifacts = {};
  if (!rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) {
    rec.artifacts.plan = { items: [], updatedAt: null };
  }
  const existing = rec.artifacts.plan.items;
  const nextId = { Todo: 1, Feature: 1, Bug: 1 };
  for (const it of existing) {
    if (typeof it.id !== 'string') continue;
    const tdM = it.id.match(/^td-(\d+)$/);
    const frM = it.id.match(/^fr-(\d+)$/);
    const bugM = it.id.match(/^bug-(\d+)$/);
    if (tdM) nextId.Todo = Math.max(nextId.Todo, parseInt(tdM[1], 10) + 1);
    if (frM) nextId.Feature = Math.max(nextId.Feature, parseInt(frM[1], 10) + 1);
    if (bugM) nextId.Bug = Math.max(nextId.Bug, parseInt(bugM[1], 10) + 1);
  }
  const added = [];
  const skipped = [];
  const now = new Date().toISOString();
  for (const raw of items) {
    const layer = raw.layer;
    const prefix = _layerPrefix(layer);
    if (!prefix) { skipped.push(`(unknown layer "${layer}")`); continue; }
    const text = String(raw.text || '').trim();
    if (!text) { skipped.push(`(empty text in ${layer})`); continue; }
    const id = `${prefix}-${nextId[layer]++}`;
    const newItem = {
      id,
      text,
      layer,
      done: false,
      addedAt: now,
      addedBy: 'claude',
      source: 'user',
      voters: [],
      comments: [],
    };
    if (Array.isArray(raw.dependsOn) && raw.dependsOn.length) {
      const deps = raw.dependsOn
        .filter((d) => typeof d === 'string' && d.length)
        .slice(0, 10);
      if (deps.length) newItem.dependsOn = deps;
    }
    existing.push(newItem);
    added.push(id);
  }
  rec.artifacts.plan.updatedAt = now;
  sessionsMod.saveStore();
  // Mirror to _myco_/plan.json so the canonical project-tree
  // file stays in sync (this is also what auto-fire / dedupe /
  // /merge write to).
  try {
    const artifactsMod = require('./artifacts');
    if (artifactsMod && artifactsMod.__test
        && typeof artifactsMod.__test.writeArtifactToFile === 'function') {
      artifactsMod.__test.writeArtifactToFile(rec, 'plan', rec.artifacts.plan);
    }
  } catch (err) {
    console.error(`[myco-mcp] writeArtifactToFile failed: ${err.message}`);
  }
  // Broadcast state-update so all attached clients refresh.
  try {
    const attachMod = require('./attach');
    const session = attachMod.getSession && attachMod.getSession(sessionId);
    if (session && typeof session.emit === 'function') {
      session.emit('state-update', {
        kind: 'artifact',
        artifactType: 'plan',
        artifact: rec.artifacts.plan,
      });
    }
  } catch {}
  return {
    ok: true,
    message: `Added ${added.length} item(s) to the Plan: ${added.join(', ')}` +
             (skipped.length ? ` · skipped: ${skipped.join(', ')}` : ''),
    ids: added,
  };
}

// fr-87: task-items registry persistence. Lives at
// <absCwd>/_myco_/task-items.json so it travels with the project tree
// (committable per CLAUDE.md §5 — shared team memory; future
// collaborators see the same task ↔ item map).
// Shape:
//   {
//     tasks: {
//       "<taskId>": {
//         itemId: "fr-1", itemType: "plan",
//         subject: "Implement…", status: "pending"|"in_progress"|"completed"|"deleted",
//         createdAt: "<iso>", updatedAt: "<iso>",
//       },
//       ...
//     },
//     updatedAt: "<iso>",
//   }
function _taskItemsFilePath(sessionId) {
  const sessionsMod = require('./sessions');
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec || !rec.absCwd) return null;
  return path.join(rec.absCwd, '_myco_', 'task-items.json');
}

function loadTaskItems(sessionId) {
  const filePath = _taskItemsFilePath(sessionId);
  if (!filePath) return { tasks: {}, updatedAt: null };
  try {
    if (!fs.existsSync(filePath)) return { tasks: {}, updatedAt: null };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.tasks) {
      return { tasks: {}, updatedAt: null };
    }
    return parsed;
  } catch (err) {
    console.error(`[myco-mcp] loadTaskItems failed: ${err.message}`);
    return { tasks: {}, updatedAt: null };
  }
}

function saveTaskItems(sessionId, registry) {
  const filePath = _taskItemsFilePath(sessionId);
  if (!filePath) return false;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
    return true;
  } catch (err) {
    console.error(`[myco-mcp] saveTaskItems failed: ${err.message}`);
    return false;
  }
}

// Look up the task ids associated with a given plan item.
// Returns array of { taskId, ...meta } sorted by createdAt ascending,
// optionally filtered to in-flight statuses (pending + in_progress).
function getTasksForItem(sessionId, itemId, opts) {
  const onlyInFlight = !!(opts && opts.onlyInFlight);
  const reg = loadTaskItems(sessionId);
  const out = [];
  for (const [taskId, info] of Object.entries(reg.tasks || {})) {
    if (!info || info.itemId !== itemId) continue;
    if (onlyInFlight) {
      const s = info.status || 'pending';
      if (s !== 'pending' && s !== 'in_progress') continue;
    }
    out.push({ taskId, ...info });
  }
  out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return out;
}

// Apply one register / upsert into the registry. Creates the entry
// if new; updates subject/status/updatedAt if existing. createdAt
// is preserved across updates.
function _registerTaskItem(sessionId, args) {
  const reg = loadTaskItems(sessionId);
  if (!reg.tasks) reg.tasks = {};
  const now = new Date().toISOString();
  const existing = reg.tasks[args.taskId] || {};
  const entry = {
    itemId: String(args.itemId || ''),
    itemType: String(args.itemType || 'plan'),
    subject: args.subject != null ? String(args.subject) : (existing.subject || ''),
    status: args.status != null ? String(args.status) : (existing.status || 'pending'),
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  if (!entry.itemId) {
    return { ok: false, message: 'itemId is required' };
  }
  reg.tasks[args.taskId] = entry;
  reg.updatedAt = now;
  if (!saveTaskItems(sessionId, reg)) {
    return { ok: false, message: 'failed to persist task-items.json' };
  }
  return {
    ok: true,
    message: `Registered task ${args.taskId} → ${entry.itemId} (status: ${entry.status})`,
    entry,
  };
}

function createMycoMcpServer(sessionId) {
  return createSdkMcpServer({
    name: 'myco',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'add_plan_items',
        'Append todo / feature-request / bug items to this session\'s Plan tab. ' +
        'Server generates ids (td-N / fr-N / bug-N) and persists to ' +
        '_myco_/plan.json. Use this when the user runs /add2plan, asks ' +
        'to "break X into todos", or otherwise wants discrete plan items ' +
        'created. Prefer 1-7 short items over many over-decomposed ones. ' +
        'Use dependsOn only when item B can\'t start until item A finishes ' +
        '— most items should have no dependsOn.',
        {
          items: z.array(z.object({
            text: z.string().min(1).max(2000).describe('Short description (1-2 sentences) of the work.'),
            layer: z.enum(['Todo', 'Feature', 'Bug']).describe('Todo = concrete action item; Feature = feature request; Bug = bug report.'),
            dependsOn: z.array(z.string()).max(10).optional().describe('OPTIONAL ids of OTHER items this can\'t start until. Use sparingly.'),
          })).min(1).max(20).describe('1-20 items to append.'),
        },
        async (args) => {
          const r = _appendPlanItems(sessionId, args.items);
          return {
            content: [{ type: 'text', text: r.message }],
            isError: !r.ok,
          };
        },
        { alwaysLoad: true }
      ),
      // fr-87: register a SDK task ↔ plan item association so the
      // scoped /task slash command can read the registry directly
      // (authoritative, not prompt-based). The agent is expected to
      // call this AFTER every TaskCreate fired during a
      // [chat|run:plan#<id>] turn, and again after each TaskUpdate
      // that changes status. The registry persists at
      // _myco_/task-items.json — committable + cross-session.
      tool(
        'register_task_item',
        'Register a SDK-task ↔ plan-item association in the session\'s ' +
        'task-items registry. Call this AFTER every TaskCreate fired ' +
        'during a [chat:plan#<id>] or [run:plan#<id>] turn, and again ' +
        'after each TaskUpdate that changes status — the registry is ' +
        'what `/task` in the per-item chat panel reads to filter the ' +
        'task list (server-authoritative, no prompt round-trip). ' +
        'Idempotent: re-registering the same taskId updates subject/' +
        'status while preserving createdAt.',
        {
          taskId: z.string().min(1).max(200).describe('The SDK task id (e.g. the id returned by TaskCreate).'),
          itemId: z.string().min(1).max(200).describe('The plan item id this task belongs to (e.g. "fr-1", "bug-17", "td-22").'),
          itemType: z.enum(['plan']).optional().describe('Reserved for forward-compat. Default "plan".'),
          subject: z.string().max(500).optional().describe('Task subject (for display in /task output). Optional but helpful.'),
          status: z.enum(['pending', 'in_progress', 'completed', 'deleted']).optional().describe('Task status. Defaults to "pending" on first register; preserved otherwise unless this call overrides it.'),
        },
        async (args) => {
          const r = _registerTaskItem(sessionId, args);
          return {
            content: [{ type: 'text', text: r.message }],
            isError: !r.ok,
          };
        },
        { alwaysLoad: true }
      ),
    ],
  });
}

module.exports = {
  createMycoMcpServer,
  MYCO_MCP_TOOL_PREFIX,
  // fr-87: registry accessors exported so handleTaskList (slashcmds.js)
  // can read the registry directly to filter /task output per-item.
  loadTaskItems,
  saveTaskItems,
  getTasksForItem,
};
