// In-process SDK MCP server hosting myco's own custom tools.
// Currently exposes:
//   mcp__myco__add_plan_items — append todo / feature-request /
//     bug items to this session's Plan tab. Replaces the previous
//     "ask claude to edit plan.json with the Edit tool" flow with
//     a typed, server-validated call; no more reliance on claude
//     correctly serializing JSON.
//
// One MCP server is created per AgentSession so the tool handler
// can capture sessionId in closure. agent-session.js passes
// `{ myco: createMycoMcpServer(sessionId) }` into sdkOpts.mcpServers.

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
    ],
  });
}

module.exports = { createMycoMcpServer, MYCO_MCP_TOOL_PREFIX };
