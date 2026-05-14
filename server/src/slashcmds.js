// Slash-command dispatcher for the discussion pane. Commands start with /
// at the start of a chat message. Each handler receives a context and is
// expected to emit one or more chat messages back via `reply(text)`.
//
// Handlers should never throw — always resolve with a user-visible result
// (success or human-readable error). The dispatcher posts the handler's
// reply as a chat message tagged with the assistant user.

const github = require('./github');
const permissions = require('./permissions');
// Lazy property access on sessionsMod — pty.js → slashcmds.js → sessions.js
// is a circular chain. sessions.js exports its API via Object.assign AFTER
// the initial module.exports, so destructuring at require-time gets undefined.
const sessionsMod = require('./sessions');

const ASSISTANT_USER = 'claude';

// Registered commands. Aliases share a handler.
const COMMANDS = [
  {
    names: ['feature', 'feat'],
    summary: 'Raise a feature request issue on the session\'s GitHub repo',
    usage: '/feature <title>',
    handler: handleFeature,
  },
  // Short plan-item commands. Each one appends a row to this session's
  // Plan artifact (rec.artifacts.plan.items) with a classification layer
  // — Feature / Todo / Bug — that the Plan tab groups items by. The
  // items are tagged source='user' so they survive a Refresh of the
  // claude-extracted plan (the extractor would otherwise replace the
  // whole list).
  {
    names: ['fr'],
    summary: 'Add a feature-request item to this session\'s Plan',
    usage: '/fr <description>',
    handler: (ctx) => addPlanItem(ctx, 'Feature'),
  },
  {
    names: ['td', 'todo'],
    summary: 'Add a todo item to this session\'s Plan',
    usage: '/td <description>',
    handler: (ctx) => addPlanItem(ctx, 'Todo'),
  },
  {
    names: ['bug'],
    summary: 'Add a bug-report item to this session\'s Plan',
    usage: '/bug <description>',
    handler: (ctx) => addPlanItem(ctx, 'Bug'),
  },
  {
    names: ['m'],
    summary: 'Short alias for @myco — send the rest of the line straight to the running Claude session',
    usage: '/m <message>',
    handler: handleMAlias,
  },
  // Task-list intervention. The actual rewrites happen in
  // pty.handleChatMessage (right next to /m); these registrations are
  // here so /help lists them and the alias works as a regular command
  // when no rewrite path applies (unknown args, etc.).
  {
    names: ['task', 'tasks'],
    summary: 'Ask the running Claude to list its pending + in-progress internal tasks',
    usage: '/task',
    handler: handleTaskList,
  },
  {
    names: ['skip'],
    summary: 'Tell the running Claude to dismiss internal task #N (it will TaskUpdate → deleted)',
    usage: '/skip <task-id>',
    handler: handleTaskSkip,
  },
  {
    names: ['cancel'],
    summary: 'Tell the running Claude to cancel internal task #N (it will TaskUpdate → deleted)',
    usage: '/cancel <task-id>',
    handler: handleTaskSkip,
  },
  {
    names: ['decide', 'pick', 'choose'],
    summary: 'Answer Claude\'s currently-pending dialog (e.g. plan-mode "what next" menu)',
    usage: '/decide <n>',
    handler: handleDecide,
  },
  {
    names: ['allow'],
    summary: 'Add a tool pattern to the session\'s permission allow list',
    usage: '/allow <pattern>   e.g. /allow Bash(curl)',
    handler: handleAllow,
  },
  {
    names: ['deny'],
    summary: 'Add a tool pattern to the session\'s permission deny list',
    usage: '/deny <pattern>    e.g. /deny Bash(rm)',
    handler: handleDeny,
  },
  {
    names: ['allowlist'],
    summary: 'Show this session\'s current allow + deny lists',
    usage: '/allowlist',
    handler: handleAllowList,
  },
  {
    names: ['clear'],
    summary: 'Wipe this session\'s discussion-pane chat (server-side + every attached client)',
    usage: '/clear',
    handler: handleClear,
  },
  {
    names: ['help'],
    summary: 'List available chat commands',
    usage: '/help',
    handler: handleHelp,
  },
];

function lookup(name) {
  const n = String(name || '').toLowerCase();
  return COMMANDS.find((c) => c.names.includes(n)) || null;
}

// Parses a chat message and returns { cmd, rest } if it's a slash command,
// else null. Also returns null for the existing /btw — that's owned by
// btw.js / shouldAskAssistant.
function parseCommand(text) {
  const m = String(text || '').match(/^\/([a-z][a-z0-9_-]{0,24})\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (name === 'btw') return null;        // legacy: handled elsewhere
  const cmd = lookup(name);
  if (!cmd) return null;
  return { cmd, matched: name, rest: m[2].trim() };
}

// Dispatch entry point. Returns true if the message was a known slash
// command (handled), false otherwise. ctx provides the chat reply channel.
async function dispatch(ctx, text) {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  try {
    await parsed.cmd.handler({ ...ctx, args: parsed.rest, command: parsed.matched });
  } catch (err) {
    ctx.reply(`(${parsed.cmd.names[0]} failed: ${err && err.message ? err.message : 'unknown error'})`);
  }
  return true;
}

// ── individual handlers ─────────────────────────────────────────────────────

const crypto = require('crypto');

// Append a free-form plan item to rec.artifacts.plan.items. Used by
// /fr, /td, /bug — each pre-binds the `layer` (which the Plan tab
// groups items by) so the user just types the description.
//
// source='user' so the next "Refresh" of the plan (which re-extracts
// from the transcript and replaces the items array) preserves these
// instead of clobbering them — see the merge in artifacts.js refresh.
function addPlanItem(ctx, layer) {
  const text = (ctx.args || '').trim();
  if (!text) {
    ctx.reply(`Usage: /<cmd> <description> — adds a ${layer} item to this session's Plan.`);
    return;
  }
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  let item;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    if (!rec) { ctx.reply('(no session record on disk — cannot persist plan item)'); return; }
    if (!rec.artifacts) rec.artifacts = {};
    if (!rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) {
      rec.artifacts.plan = { items: [], updatedAt: null };
    }
    item = {
      id: crypto.randomBytes(6).toString('hex'),
      text,
      layer,
      done: false,
      addedAt: new Date().toISOString(),
      addedBy: ctx.user || 'unknown',
      source: 'user',
      voters: [],
      comments: [],
    };
    rec.artifacts.plan.items.push(item);
    rec.artifacts.plan.updatedAt = item.addedAt;
    sessionsMod.saveStore();
    // Two more things sessionsMod.saveStore alone misses:
    //   1. Mirror to <project>/_myco_/plan.json — the GET /artifact
    //      handler reads from this file FIRST and falls back to
    //      rec.artifacts only when the file is absent. Without this
    //      mirror, the next plan-tab open re-reads the file, ignores
    //      the in-memory new item, and "the /todo silently does
    //      nothing" from the user's perspective.
    //   2. Emit state-update so any open Plan tab on any attached
    //      client re-renders with the new item live — same pattern
    //      the artifact mutation routes already use.
    try {
      const artifactsMod = require('./artifacts');
      if (artifactsMod && artifactsMod.__test && typeof artifactsMod.__test.writeArtifactToFile === 'function') {
        artifactsMod.__test.writeArtifactToFile(rec, 'plan', rec.artifacts.plan);
      }
    } catch (err) {
      console.error(`[plan-item] write _myco_/plan.json failed: ${err.message}`);
    }
    try {
      const ptyMod = require('./pty');
      const session = ptyMod.getSession && ptyMod.getSession(sessionId);
      if (session) {
        session.emit('state-update', {
          kind: 'artifact',
          artifactType: 'plan',
          artifact: rec.artifacts.plan,
        });
      }
    } catch {}
  } catch (err) {
    ctx.reply(`(plan item failed to save: ${err.message})`);
    return;
  }
  ctx.reply(`✓ added **${layer}** item to Plan: ${text}`);
}

function handleFeature(ctx) {
  return handleIssue(ctx, { kind: 'feature', labels: ['enhancement'] });
}

// /m is a short alias for @myco. The actual rewrite happens earlier in
// pty.handleChatMessage (BEFORE the slash dispatch), so by the time
// THIS handler fires we know the user typed bare "/m" with no body.
// We just send a usage reply so they know how to use it.
function handleMAlias(ctx) {
  ctx.reply('Usage: `/m <message>` — short alias for `@myco <message>`. Whatever follows is sent straight to the running Claude session.');
}

// /task /tasks — the rewrite in pty.handleChatMessage only fires when the
// command appears with no extra args ("^/tasks?\s*$"). If anything else
// followed, fall through here with a usage hint so the user discovers
// the right shape.
function handleTaskList(ctx) {
  ctx.reply(
    'Usage: `/task` — asks the running Claude to list its current pending and in-progress internal tasks, ' +
    'so you can see what work is queued and intervene with `/skip <id>` or `/cancel <id>`.',
  );
}

// /skip /cancel — same fallthrough. Real action happens via the @myco
// forwarding rewrite in pty.handleChatMessage; this handler only fires
// when the args don't parse as a numeric id.
function handleTaskSkip(ctx) {
  const name = (ctx && ctx.command) || 'skip';
  ctx.reply(
    `Usage: \`/${name} <task-id>\` — tells the running Claude to dismiss the given internal task ` +
    `(it will run TaskUpdate → status=deleted). Use \`/task\` first to see ids.`,
  );
}

async function handleIssue(ctx, { kind, labels }) {
  const title = ctx.args && ctx.args.trim();
  if (!title) {
    ctx.reply(`Usage: /${kind} <title>\nExample: /${kind} add dark mode toggle`);
    return;
  }
  const token = github.getToken(ctx.user);
  if (!token) {
    // Tokens are populated automatically by the OAuth callback. If we're here
    // the OAuth round-trip didn't include the `repo` scope, or the token has
    // been revoked on github.com. A fresh sign-in fixes both.
    ctx.reply(
      `(no GitHub token on file for @${ctx.user}. Sign out and back in via GitHub ` +
      `to refresh — the OAuth grant must include the \`repo\` scope.)`
    );
    return;
  }
  const repo = await github.detectRepo(ctx.absCwd);
  if (!repo) {
    ctx.reply(
      `(could not detect a github.com remote for this session's cwd: ${ctx.absCwd}. ` +
      `\`/${kind}\` requires \`git remote get-url origin\` to point at github.com.)`
    );
    return;
  }
  const body = [
    title,
    '',
    '---',
    `Filed by **@${ctx.user}** via [myco](https://myco.labxnow.ai/) on ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC.`,
  ].join('\n');
  const result = await github.createIssue({
    token, owner: repo.owner, repo: repo.repo, title, body, labels,
  });
  if (result.error) {
    ctx.reply(`(GitHub error: ${result.error}${result.status ? ` [HTTP ${result.status}]` : ''})`);
    return;
  }
  ctx.reply(`✓ Filed ${kind} request #${result.number} on ${repo.owner}/${repo.repo}: ${result.url}`);
}

// /decide <n> — answer the currently-pending dialog by sending its option
// number to the running Claude PTY. The dialog was previously detected by
// the MenuInterceptor in pty.js, which posted its options into the chat as
// an assistant message and stashed the menu on session.pendingMenu.
async function handleDecide(ctx) {
  const raw = (ctx.args || '').trim();
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    ctx.reply('Usage: `/decide <n>` — pick the option number from the most recent dialog. e.g. `/decide 1`.');
    return;
  }
  // PERSIST answered state on the latest menu chat message regardless
  // of whether session.pendingMenu is still live — see handleMenuPick
  // in pty.js for the rationale (post-restart clicks were no-op'ing
  // because pendingMenu was in-memory only).
  let stampedLabel = null;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[ctx.sessionId];
    if (rec && Array.isArray(rec.chat)) {
      for (let i = rec.chat.length - 1; i >= 0; i--) {
        const m = rec.chat[i];
        if (!m || !m.meta || m.meta.kind !== 'menu') continue;
        if (m.meta.answered) break;
        const opts = (m.meta.menu && m.meta.menu.options) || [];
        const match = opts.find((o) => o.n === n);
        if (!match) break;
        m.meta.answered = true;
        m.meta.pickedN = n;
        sessionsMod.saveStore();
        stampedLabel = match.label || '';
        break;
      }
    }
  } catch {}

  // PTY write only when the live session is actually waiting on this menu.
  const session = ctx.session;
  const pending = session && session.alive ? session.pendingMenu : null;
  if (pending && Array.isArray(pending.options) && pending.options.some((o) => o.n === n)) {
    // Claude Code's menus accept digit + Enter to commit.
    session.write(String(n) + '\r');
    session.pendingMenu = null;
  } else if (!stampedLabel) {
    // Nothing to do — no live menu AND no persisted menu carried option n.
    ctx.reply(`(option ${n} isn't a valid choice on any recent dialog.)`);
    return;
  }
  const label = stampedLabel || (pending && pending.options.find((o) => o.n === n) || {}).label || '';
  ctx.reply(`✓ picked option ${n}${label ? ': ' + label : ''}`);
}

function validatePattern(pattern) {
  if (!pattern) return 'pattern is empty';
  const m = pattern.match(/^([A-Za-z_]\w*)(?:\(([^)]*)\))?$/);
  if (!m) return 'pattern must look like `Tool` or `Tool(arg)` or `Tool(arg:*)`';
  return null;
}

async function handleAllow(ctx) {
  const pattern = (ctx.args || '').trim();
  const err = validatePattern(pattern);
  if (err) { ctx.reply(`Usage: \`/allow <pattern>\` — ${err}.`); return; }
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(no session record found)'); return; }
  permissions.addAllow(rec, pattern);
  ctx.reply(`✓ added \`${pattern}\` to the allow list. Run \`@myco try again\` to retry the previously-denied tool.`);
}

async function handleDeny(ctx) {
  const pattern = (ctx.args || '').trim();
  const err = validatePattern(pattern);
  if (err) { ctx.reply(`Usage: \`/deny <pattern>\` — ${err}.`); return; }
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(no session record found)'); return; }
  permissions.addDeny(rec, pattern);
  ctx.reply(`🚫 added \`${pattern}\` to the deny list.`);
}

async function handleAllowList(ctx) {
  const lists = permissions.getSessionLists(ctx.sessionId);
  const out = ['**Permission lists for this session:**'];
  out.push('');
  out.push('Allow:');
  if (lists.allowList.length) out.push(...lists.allowList.map((p) => `  • \`${p}\``));
  else out.push('  (empty)');
  out.push('');
  out.push('Deny:');
  if (lists.denyList.length) out.push(...lists.denyList.map((p) => `  • \`${p}\``));
  else out.push('  (empty)');
  out.push('');
  out.push('Anything not matching allow (and not matching deny) is auto-rejected.');
  out.push('Use `/allow <pattern>` or `/deny <pattern>` to mutate.');
  ctx.reply(out.join('\n'));
}

// /clear — wipe rec.chat for this session and broadcast a chat-clear
// state-update so every attached client wipes its local chat list. The
// confirmation reply lands AFTER the clear, so the chat ends up holding
// just that one row. The user's own "/clear" line was appended by
// pty.handleChatMessage immediately before dispatch fired, but it's
// part of rec.chat which we're about to empty — so it disappears too.
function handleClear(ctx) {
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  let cleared = 0;
  try {
    cleared = sessionsMod.clearChatHistory(sessionId);
  } catch (err) {
    ctx.reply(`(failed to clear chat: ${err.message})`);
    return;
  }
  try {
    // Prefer ctx.session (passed by pty.handleChatMessage) and fall back to
    // pty.getSession(id) so the slash-todo-inject-style unit tests, which
    // only supply { sessionId, absCwd, reply }, still observe a no-op
    // instead of a crash.
    let session = ctx.session || null;
    if (!session) {
      try { session = require('./pty').getSession(sessionId); } catch {}
    }
    if (session) session.emit('state-update', { kind: 'chat-clear' });
  } catch {}
  ctx.reply(`✓ cleared ${cleared} chat message${cleared === 1 ? '' : 's'}`);
}

function handleHelp(ctx) {
  const lines = ['Available chat commands:'];
  for (const c of COMMANDS) {
    const aliases = c.names.length > 1 ? ` (aliases: ${c.names.slice(1).map((n) => '/' + n).join(', ')})` : '';
    lines.push(`  • \`${c.usage}\`${aliases} — ${c.summary}`);
  }
  lines.push('');
  lines.push('Other prefixes:');
  lines.push('  • `@myco <text>` — inject text into the running Claude session');
  lines.push('  • `/btw <text>` — ask Claude in the chat (no PTY write)');
  ctx.reply(lines.join('\n'));
}

// Returns the public command list (used by the client's autocomplete
// dropdown). Hides aliases from the primary list but mentions them.
function listCommands() {
  return COMMANDS.map((c) => ({
    name: c.names[0],
    aliases: c.names.slice(1),
    summary: c.summary,
    usage: c.usage,
  }));
}

module.exports = {
  dispatch,
  parseCommand,
  listCommands,
  ASSISTANT_USER,
};
