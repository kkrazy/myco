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
  {
    names: ['bug'],
    summary: 'Raise a bug-report issue on the session\'s GitHub repo',
    usage: '/bug <title>',
    handler: (ctx) => handleIssue(ctx, { kind: 'bug', labels: ['bug'] }),
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
  return { cmd, rest: m[2].trim() };
}

// Dispatch entry point. Returns true if the message was a known slash
// command (handled), false otherwise. ctx provides the chat reply channel.
async function dispatch(ctx, text) {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  try {
    await parsed.cmd.handler({ ...ctx, args: parsed.rest });
  } catch (err) {
    ctx.reply(`(${parsed.cmd.names[0]} failed: ${err && err.message ? err.message : 'unknown error'})`);
  }
  return true;
}

// ── individual handlers ─────────────────────────────────────────────────────

function handleFeature(ctx) {
  return handleIssue(ctx, { kind: 'feature', labels: ['enhancement'] });
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
  const session = ctx.session;
  if (!session || !session.alive) {
    ctx.reply('(no live Claude session attached to this discussion — can\'t /decide.)');
    return;
  }
  const pending = session.pendingMenu;
  if (!pending) {
    ctx.reply('(no Claude dialog is currently pending. /decide only works when Claude is showing a numbered menu.)');
    return;
  }
  const matched = pending.options.find((o) => o.n === n);
  if (!matched) {
    const valid = pending.options.map((o) => o.n).join(', ');
    ctx.reply(`(option ${n} isn't in the current dialog — valid options: ${valid})`);
    return;
  }
  // Claude Code's menus accept digit + Enter to commit. We send the
  // option number followed by \r; the menu disappears on the next render
  // tick, which clears session.pendingMenu via MenuInterceptor's
  // "cleared" transition.
  session.write(String(n) + '\r');
  session.pendingMenu = null;
  // Mark the most recent menu chat broadcast as answered so the
  // chat-inline picker stays disabled across page refreshes /
  // reconnects (same as the menu-pick WS frame path in pty.js).
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[ctx.sessionId];
    if (rec && Array.isArray(rec.chat)) {
      for (let i = rec.chat.length - 1; i >= 0; i--) {
        const m = rec.chat[i];
        if (m && m.meta && m.meta.kind === 'menu') {
          if (!m.meta.answered) {
            m.meta.answered = true;
            m.meta.pickedN = n;
            sessionsMod.saveStore();
          }
          break;
        }
      }
    }
  } catch {}
  ctx.reply(`✓ picked option ${n}: ${matched.label}`);
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
