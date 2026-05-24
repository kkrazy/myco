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
//   mcp__myco__add_comment (fr-88 migration 1) — append a comment to
//     a plan/test item. Shares the appendCommentToItem helper in
//     artifacts.js with POST /artifact/comment (the HTTP route the
//     /comment slash + plan-card form hit). Lets the agent leave
//     closeout summaries on items without asking the user to type
//     `/comment …` — first migration under the fr-88 slash-cmds-as-
//     tools design rule.
//   mcp__myco__set_item_done, vote_item, queue_add (fr-88 migrations
//     2/3/4) — same pattern (shared helper, HTTP + tool both
//     delegate).
//   mcp__myco__worktree_create / worktree_remove / worktree_list
//     (fr-90 Phase 0) — manage isolated git worktrees per plan item.
//     Foundation for parallel item runs (Phase 2+): each item can
//     get its own checkout at _myco_/worktrees/<itemId> with branch
//     wt-<itemId>, so concurrent subagents don't collide on shared
//     files. Registry at _myco_/worktrees.json tracks active
//     worktrees so future operations (merge, cleanup) can find them.
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
//
// fr-91: by default, filter to entries whose bootId matches the
// current AgentSession's bootId — pre-restart entries reference
// ghost task IDs (SDK's TaskList doesn't survive process death even
// though sdkSessionId does). Pass {includeStale: true} to bypass
// the bootId filter for audit / history view.
function getTasksForItem(sessionId, itemId, opts) {
  const onlyInFlight = !!(opts && opts.onlyInFlight);
  const includeStale = !!(opts && opts.includeStale);
  const reg = loadTaskItems(sessionId);
  // Resolve current bootId from the live AgentSession. If the agent
  // isn't running (rare — /task can only be invoked through the live
  // session anyway), treat as "no current epoch" and show everything.
  let currentBootId = null;
  if (!includeStale) {
    try {
      const attachMod = require('./attach');
      const session = attachMod.getSession && attachMod.getSession(sessionId);
      if (session && session.bootId) currentBootId = session.bootId;
    } catch {}
  }
  const out = [];
  for (const [taskId, info] of Object.entries(reg.tasks || {})) {
    if (!info || info.itemId !== itemId) continue;
    if (onlyInFlight) {
      const s = info.status || 'pending';
      if (s !== 'pending' && s !== 'in_progress') continue;
    }
    // fr-91 epoch filter: when currentBootId is set + entry has a
    // bootId, only show matches. Entries WITHOUT bootId (legacy /
    // pre-fr-91) are also filtered — they predate the epoch model
    // and should be considered stale until re-registered.
    if (!includeStale && currentBootId) {
      if (info.bootId !== currentBootId) continue;
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
  // fr-91: capture current AgentSession bootId so /task can filter
  // out pre-restart entries by default. Falls back to existing.bootId
  // on re-register (preserves the original epoch); falls back to null
  // if no live session (rare — defensive).
  let currentBootId = existing.bootId || null;
  try {
    const attachMod = require('./attach');
    const session = attachMod.getSession && attachMod.getSession(sessionId);
    if (session && session.bootId) currentBootId = session.bootId;
  } catch {}
  const entry = {
    itemId: String(args.itemId || ''),
    itemType: String(args.itemType || 'plan'),
    subject: args.subject != null ? String(args.subject) : (existing.subject || ''),
    status: args.status != null ? String(args.status) : (existing.status || 'pending'),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    bootId: currentBootId,
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

// fr-90 Phase 0: worktree registry persistence. Lives at
// <absCwd>/_myco_/worktrees.json. Tracks active git worktrees this
// session has created per plan item, so future operations
// (status check, merge, cleanup) can find them. NOT committed to
// the project tree — _myco_/.gitignore excludes worktrees/ since
// each worktree IS a checkout of the same repo (its files belong
// to git already, but the worktree dir itself is transient).
//
// Shape:
//   {
//     worktrees: {
//       "<itemId>": {
//         path: "_myco_/worktrees/<itemId>",   // RELATIVE to absCwd
//         branch: "wt-<itemId>",
//         createdAt: "<iso>",
//         status: "active" | "merged" | "removed",
//         baseRef: "<sha of HEAD when created>",  // for diff base
//       },
//       ...
//     },
//     updatedAt: "<iso>",
//   }
function _worktreesFilePath(sessionId) {
  const sessionsMod = require('./sessions');
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec || !rec.absCwd) return null;
  return path.join(rec.absCwd, '_myco_', 'worktrees.json');
}

function loadWorktrees(sessionId) {
  const filePath = _worktreesFilePath(sessionId);
  if (!filePath) return { worktrees: {}, updatedAt: null };
  try {
    if (!fs.existsSync(filePath)) return { worktrees: {}, updatedAt: null };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.worktrees) {
      return { worktrees: {}, updatedAt: null };
    }
    return parsed;
  } catch (err) {
    console.error(`[myco-mcp] loadWorktrees failed: ${err.message}`);
    return { worktrees: {}, updatedAt: null };
  }
}

function saveWorktrees(sessionId, registry) {
  const filePath = _worktreesFilePath(sessionId);
  if (!filePath) return false;
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
    return true;
  } catch (err) {
    console.error(`[myco-mcp] saveWorktrees failed: ${err.message}`);
    return false;
  }
}

function listWorktrees(sessionId) {
  const reg = loadWorktrees(sessionId);
  return Object.entries(reg.worktrees || {})
    .map(([itemId, info]) => ({ itemId, ...info }))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

// _myco_/.gitignore must exclude worktrees/ since each worktree IS a
// git checkout (the path would show as untracked in the main repo).
// Idempotent: appends only if missing.
function _ensureWorktreeGitignore(rec) {
  if (!rec || !rec.absCwd) return;
  const gi = path.join(rec.absCwd, '_myco_', '.gitignore');
  let body = '';
  try { body = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : ''; } catch {}
  if (/^worktrees\/?$/m.test(body)) return;  // already ignored
  try {
    if (!fs.existsSync(path.dirname(gi))) fs.mkdirSync(path.dirname(gi), { recursive: true });
    fs.writeFileSync(gi, (body ? body.replace(/\n*$/, '\n') : '') + 'worktrees/\n');
  } catch (err) {
    console.error(`[myco-mcp] _ensureWorktreeGitignore failed: ${err.message}`);
  }
}

// Create a git worktree at _myco_/worktrees/<itemId> on a fresh branch
// wt-<itemId>. If the worktree already exists in the registry as
// 'active', returns idempotently. Throws via the registry on git errors.
function createWorktree(sessionId, itemId, opts) {
  const sessionsMod = require('./sessions');
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return { ok: false, error: 'session not found', status: 404 };
  if (!rec.absCwd) return { ok: false, error: 'session has no absCwd', status: 500 };
  if (!itemId || typeof itemId !== 'string') {
    return { ok: false, error: 'itemId required', status: 400 };
  }

  // findProjectRoot logic (mirrors artifacts.js — repo lives at absCwd
  // OR an immediate subdir of absCwd that has .git/).
  const findProjectRoot = () => {
    try { if (fs.statSync(path.join(rec.absCwd, '.git')).isDirectory() ||
                fs.statSync(path.join(rec.absCwd, '.git')).isFile()) {
      return rec.absCwd;
    } } catch {}
    try {
      const entries = fs.readdirSync(rec.absCwd, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name).sort();
      for (const name of entries) {
        try {
          const dotgit = path.join(rec.absCwd, name, '.git');
          if (fs.statSync(dotgit).isDirectory() || fs.statSync(dotgit).isFile()) {
            return path.join(rec.absCwd, name);
          }
        } catch {}
      }
    } catch {}
    return null;
  };
  const repoRoot = findProjectRoot();
  if (!repoRoot) return { ok: false, error: 'no git repo found under session cwd', status: 400 };

  const reg = loadWorktrees(sessionId);
  if (!reg.worktrees) reg.worktrees = {};
  const existing = reg.worktrees[itemId];
  if (existing && existing.status === 'active') {
    // Idempotent: already created, return existing entry. Verify the
    // path still exists on disk; if not, fall through to recreate.
    if (existing.path && fs.existsSync(path.join(rec.absCwd, existing.path))) {
      return { ok: true, ...existing, idempotent: true };
    }
  }

  const branch = (opts && opts.branch) || `wt-${itemId}`;
  const relPath = path.posix.join('_myco_', 'worktrees', itemId);
  const absPath = path.join(rec.absCwd, relPath);

  _ensureWorktreeGitignore(rec);

  // Run `git worktree add -b <branch> <path>`. If the branch already
  // exists (from a previous run that was cleaned up), use it without
  // -b (so we resume rather than fail).
  const { execFileSync } = require('child_process');
  const now = new Date().toISOString();
  let baseRef = null;
  try {
    baseRef = String(execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).trim();
  } catch {}
  // Check if branch already exists.
  let branchExists = false;
  try {
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`], { stdio: 'ignore' });
    branchExists = true;
  } catch {}
  try {
    if (branchExists) {
      execFileSync('git', ['-C', repoRoot, 'worktree', 'add', absPath, branch], { stdio: 'pipe' });
    } else {
      execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, absPath], { stdio: 'pipe' });
    }
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : err.message;
    return { ok: false, error: `git worktree add failed: ${stderr.trim()}`, status: 500 };
  }

  const entry = {
    path: relPath,
    branch,
    createdAt: now,
    status: 'active',
    baseRef,
  };
  reg.worktrees[itemId] = entry;
  reg.updatedAt = now;
  saveWorktrees(sessionId, reg);
  return { ok: true, ...entry };
}

// Remove a git worktree + its branch tracking entry. By default,
// refuses to remove if the worktree has uncommitted changes (force
// override available). Updates registry status to 'removed'.
function removeWorktree(sessionId, itemId, opts) {
  const sessionsMod = require('./sessions');
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  if (!rec) return { ok: false, error: 'session not found', status: 404 };
  if (!itemId) return { ok: false, error: 'itemId required', status: 400 };
  const reg = loadWorktrees(sessionId);
  const entry = reg.worktrees && reg.worktrees[itemId];
  if (!entry) return { ok: false, error: `no worktree registered for ${itemId}`, status: 404 };

  const findProjectRoot = () => {
    try { if (fs.statSync(path.join(rec.absCwd, '.git')).isDirectory() ||
                fs.statSync(path.join(rec.absCwd, '.git')).isFile()) {
      return rec.absCwd;
    } } catch {}
    try {
      const entries = fs.readdirSync(rec.absCwd, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name).sort();
      for (const name of entries) {
        try {
          const dotgit = path.join(rec.absCwd, name, '.git');
          if (fs.statSync(dotgit).isDirectory() || fs.statSync(dotgit).isFile()) {
            return path.join(rec.absCwd, name);
          }
        } catch {}
      }
    } catch {}
    return null;
  };
  const repoRoot = findProjectRoot();
  if (!repoRoot) return { ok: false, error: 'no git repo found', status: 400 };

  const { execFileSync } = require('child_process');
  const force = !!(opts && opts.force);
  const args = ['-C', repoRoot, 'worktree', 'remove'];
  if (force) args.push('--force');
  args.push(entry.path);
  try {
    execFileSync('git', args, { stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : err.message;
    return { ok: false, error: `git worktree remove failed: ${stderr.trim()}`, status: 500 };
  }
  entry.status = 'removed';
  entry.removedAt = new Date().toISOString();
  reg.worktrees[itemId] = entry;
  reg.updatedAt = entry.removedAt;
  saveWorktrees(sessionId, reg);
  return { ok: true, ...entry };
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
      // fr-88 migration 4: enqueue a plan/test item for run-queue
      // dispatch. Shares the queueItemForRun helper in artifacts.js
      // with the POST /queue/add HTTP route. INTENTIONALLY skips the
      // "kick if idle" step the HTTP route does — agent self-queueing
      // inside a turn shouldn't trigger reentrant dispatch (would
      // create a recursive handleChatMessage from inside an active
      // turn). The queue auto-advances at the next turn boundary
      // (attach.js _advanceRunQueue on turn_result) or on explicit
      // user action.
      tool(
        'queue_add',
        'Enqueue a plan or test item for run-queue dispatch. Use this ' +
        'to self-queue follow-up items spotted mid-work (e.g. "while ' +
        'shipping fr-X I noticed bug-Y also needs fixing — queue it"). ' +
        'The agent does NOT kick the queue immediately (would create ' +
        'reentrant dispatch); the next turn boundary or user action ' +
        'will pick it up. Throws on duplicate (an itemId already ' +
        'pending or running can\'t be re-queued).',
        {
          itemId: z.string().min(1).max(200).describe('Plan-item id (e.g. "fr-1", "bug-17", "td-22") or test item id.'),
          type: z.enum(['plan', 'test']).optional().describe('Artifact type. Defaults to "plan".'),
        },
        async (args) => {
          const artifactsMod = require('./artifacts');
          const type = args.type || 'plan';
          const r = artifactsMod.queueItemForRun(sessionId, type, args.itemId, 'claude');
          if (!r.ok) {
            return {
              content: [{ type: 'text', text: `queue_add failed: ${r.error}` }],
              isError: true,
            };
          }
          // Broadcast runQueue change so the queue-chip strip updates
          // live on every attached client. Reuse the attach.getSession
          // pattern since broadcastRunQueue is in artifacts.js's
          // register-closure (not module-scope reachable from here).
          try {
            const attachMod = require('./attach');
            const session = attachMod.getSession && attachMod.getSession(sessionId);
            if (session && typeof session.emit === 'function') {
              session.emit('state-update', {
                kind: 'runQueue',
                runQueue: { entries: r.rec.runQueue || [], paused: !!r.rec.runQueuePaused },
              });
            }
          } catch {}
          return {
            content: [{ type: 'text', text: `${args.itemId} queued (status: ${r.entry.status}). Will dispatch on next turn boundary.` }],
            isError: false,
          };
        },
        { alwaysLoad: true }
      ),
      // fr-88 migration 3: toggle the agent's vote on a plan/test item.
      // Shares the toggleVote helper in artifacts.js with the POST
      // /artifact/vote HTTP route. NO auto-fire — the human-vote
      // auto-quorum dispatch (HTTP route) is a social signal, not
      // an agent action. If the agent wants to dispatch an item to
      // claude, it should use mcp__myco__queue_add directly.
      tool(
        'vote_item',
        'Toggle the agent\'s vote (👍) on a plan or test item. ' +
        'Idempotent: re-voting REMOVES the vote (action="removed"); ' +
        'voting fresh ADDS it (action="added"). Author is fixed to ' +
        '"claude". Does NOT trigger auto-quorum dispatch (that\'s a ' +
        'social-signal path reserved for human voters via the HTTP ' +
        'route) — use mcp__myco__queue_add if you want to enqueue.',
        {
          itemId: z.string().min(1).max(200).describe('Plan-item id (e.g. "fr-1", "bug-17", "td-22") or test item id.'),
          type: z.enum(['plan', 'test']).optional().describe('Artifact type. Defaults to "plan". "arch" is rejected.'),
        },
        async (args) => {
          const artifactsMod = require('./artifacts');
          const type = args.type || 'plan';
          const r = artifactsMod.toggleVote(sessionId, type, args.itemId, 'claude');
          if (!r.ok) {
            return {
              content: [{ type: 'text', text: `vote_item failed: ${r.error}` }],
              isError: true,
            };
          }
          try {
            const attachMod = require('./attach');
            const session = attachMod.getSession && attachMod.getSession(sessionId);
            if (session && typeof session.emit === 'function') {
              session.emit('state-update', { kind: 'artifact', artifactType: type, artifact: r.artifact });
            }
          } catch {}
          return {
            content: [{ type: 'text', text: `Vote ${r.action} on ${args.itemId} (now ${r.item.voters.length} total).` }],
            isError: false,
          };
        },
        { alwaysLoad: true }
      ),
      // fr-88 migration 2: mark a plan/test item done (or reopen it).
      // Shares the setItemDone helper in artifacts.js with the POST
      // /artifact/mark HTTP route. Pure lifecycle toggle — no claude
      // dispatch. Use after shipping fr-X to mark it done. To dispatch
      // an item to the queue, use mcp__myco__queue_add (separate tool).
      tool(
        'set_item_done',
        'Mark a plan or test item as done (done=true) or reopen it ' +
        '(done=false). Pure lifecycle toggle — does NOT dispatch the ' +
        'item to claude (use queue_add for that). Use after shipping ' +
        'fr-X / fixing bug-X to close the item, or when reopening ' +
        'something that turned out to need more work. Broadcast live ' +
        'to every attached client.',
        {
          itemId: z.string().min(1).max(200).describe('Plan-item id (e.g. "fr-1", "bug-17", "td-22") or test item id.'),
          done: z.boolean().describe('true → mark done (close). false → reopen.'),
          type: z.enum(['plan', 'test']).optional().describe('Artifact type. Defaults to "plan". "arch" is rejected.'),
        },
        async (args) => {
          const artifactsMod = require('./artifacts');
          const type = args.type || 'plan';
          const r = artifactsMod.setItemDone(sessionId, type, args.itemId, args.done);
          if (!r.ok) {
            return {
              content: [{ type: 'text', text: `set_item_done failed: ${r.error}` }],
              isError: true,
            };
          }
          try {
            const attachMod = require('./attach');
            const session = attachMod.getSession && attachMod.getSession(sessionId);
            if (session && typeof session.emit === 'function') {
              session.emit('state-update', { kind: 'artifact', artifactType: type, artifact: r.artifact });
            }
          } catch {}
          return {
            content: [{ type: 'text', text: `${args.itemId} → ${args.done ? '✓ done' : '↻ reopened'}.` }],
            isError: false,
          };
        },
        { alwaysLoad: true }
      ),
      // fr-88 migration 1: append a comment to a plan/test item.
      // Shares the appendCommentToItem helper in artifacts.js with the
      // POST /artifact/comment HTTP route — two surfaces, one source
      // of truth (per fr-88 design rule in CLAUDE.md §Code Style #3).
      // Use this after closing fr-X to leave a closeout summary, or
      // any time the agent wants to leave a trail on an item without
      // asking the user to type /comment ….
      tool(
        'add_comment',
        'Append a comment to a plan or test item. Use this after closing ' +
        'fr-X to leave a closeout summary (replaces the manual node-script ' +
        'pattern), or any time you want to leave a trail on an item ' +
        'without asking the user to type /comment …. The comment is ' +
        'recorded with you as the author (user: "claude") and broadcast ' +
        'live to every attached client. Comment text capped at 1000 ' +
        'chars; per-item ring buffer of 50 (oldest dropped on overflow). ' +
        'Returns ok + the appended comment id.',
        {
          itemId: z.string().min(1).max(200).describe('Plan-item id (e.g. "fr-1", "bug-17", "td-22") or test item id.'),
          text: z.string().min(1).max(1000).describe('Comment body. Markdown OK — gets rendered when viewed in the plan card.'),
          type: z.enum(['plan', 'test']).optional().describe('Artifact type. Defaults to "plan". "arch" is rejected (arch items have no comment thread).'),
        },
        async (args) => {
          const artifactsMod = require('./artifacts');
          const type = args.type || 'plan';
          const r = artifactsMod.appendCommentToItem(sessionId, type, args.itemId, 'claude', args.text);
          if (!r.ok) {
            return {
              content: [{ type: 'text', text: `add_comment failed: ${r.error}` }],
              isError: true,
            };
          }
          // Broadcast state-update so all attached clients refresh.
          // Same pattern _appendPlanItems uses elsewhere in this file.
          try {
            const attachMod = require('./attach');
            const session = attachMod.getSession && attachMod.getSession(sessionId);
            if (session && typeof session.emit === 'function') {
              session.emit('state-update', {
                kind: 'artifact',
                artifactType: type,
                artifact: r.artifact,
              });
            }
          } catch {}
          return {
            content: [{ type: 'text', text: `Comment ${r.comment.id} added to ${args.itemId}.` }],
            isError: false,
          };
        },
        { alwaysLoad: true }
      ),
      // fr-90 Phase 0: worktree tools — manage isolated git worktrees
      // per plan item. Foundation for parallel item runs (Phase 2+).
      tool(
        'worktree_create',
        'Create an isolated git worktree at _myco_/worktrees/<itemId> ' +
        'on branch wt-<itemId>. Idempotent — if the worktree already ' +
        'exists for this item (and the path is intact on disk), returns ' +
        'the existing entry without re-running git. If the branch ' +
        'wt-<itemId> already exists from a prior run, the new worktree ' +
        'checks out the existing branch (resume semantics). Records the ' +
        'entry in _myco_/worktrees.json with the base SHA so a future ' +
        'diff/merge knows the comparison point.',
        {
          itemId: z.string().min(1).max(200).describe('Plan-item id (e.g. "fr-1", "bug-17"). Becomes both the dir name and the branch suffix.'),
          branch: z.string().max(200).optional().describe('Override the default branch name (wt-<itemId>). Rarely needed.'),
        },
        async (args) => {
          const r = createWorktree(sessionId, args.itemId, { branch: args.branch });
          if (!r.ok) {
            return {
              content: [{ type: 'text', text: `worktree_create failed: ${r.error}` }],
              isError: true,
            };
          }
          const verb = r.idempotent ? 'already active' : 'created';
          return {
            content: [{ type: 'text', text: `Worktree ${verb}: ${r.path} (branch ${r.branch}, base ${r.baseRef ? r.baseRef.slice(0, 7) : '?'}).` }],
            isError: false,
          };
        },
        { alwaysLoad: true }
      ),
      tool(
        'worktree_remove',
        'Remove the git worktree for an item (cleanup after merge or ' +
        'abandonment). By default refuses to remove if the worktree has ' +
        'uncommitted changes; pass force=true to override. The wt-<itemId> ' +
        'BRANCH is preserved (not deleted) so the work isn\'t lost — only ' +
        'the worktree directory + git\'s internal tracking is removed. ' +
        'Marks the registry entry as status:"removed" (kept for audit).',
        {
          itemId: z.string().min(1).max(200).describe('Plan-item id whose worktree should be removed.'),
          force: z.boolean().optional().describe('Force removal even if uncommitted changes (LOSES uncommitted work).'),
        },
        async (args) => {
          const r = removeWorktree(sessionId, args.itemId, { force: args.force });
          if (!r.ok) {
            return {
              content: [{ type: 'text', text: `worktree_remove failed: ${r.error}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `Worktree removed: ${r.path} (branch ${r.branch} preserved).` }],
            isError: false,
          };
        },
        { alwaysLoad: true }
      ),
      tool(
        'worktree_list',
        'List all worktrees this session has registered (active + removed ' +
        'history). Returns each entry\'s itemId, branch, path, baseRef, ' +
        'status, createdAt (+ removedAt if removed). Use to audit what ' +
        'parallel work has been spun up + decide what to merge or clean up.',
        {},
        async () => {
          const entries = listWorktrees(sessionId);
          if (!entries.length) {
            return {
              content: [{ type: 'text', text: 'No worktrees registered for this session.' }],
              isError: false,
            };
          }
          const lines = entries.map((e) => {
            const status = e.status === 'active' ? '🔀' : e.status === 'removed' ? '🗑️' : '·';
            return `${status} ${e.itemId} → ${e.branch} (${e.path}, base ${e.baseRef ? e.baseRef.slice(0, 7) : '?'}, status: ${e.status})`;
          });
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            isError: false,
          };
        },
        { alwaysLoad: true }
      ),
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
  // fr-90 Phase 0: worktree helpers exported so the Phase 1 dispatch
  // path (attach.js / artifacts.js queue helper) can create + manage
  // worktrees server-side without going through the MCP tool surface.
  loadWorktrees,
  saveWorktrees,
  listWorktrees,
  createWorktree,
  removeWorktree,
};
