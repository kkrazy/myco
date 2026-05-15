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
    names: ['merge'],
    summary: 'Merge N plan items of the same layer into the lowest-numbered canonical (e.g. /merge td-3 td-7)',
    usage: '/merge <id1> <id2> [<id3>…]',
    handler: handleMerge,
  },
  {
    names: ['dedupe'],
    summary: 'Ask claude to propose merges for similar plan items — no auto-apply, you confirm via /merge',
    usage: '/dedupe',
    handler: handleDedupe,
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

// Map from plan-item layer to the short prefix used in human-readable
// ids ("fr-7", "td-3", "bug-12"). Per-layer counter so each kind has
// its own monotonically-rising sequence.
const PLAN_LAYER_PREFIX = { Feature: 'fr', Todo: 'td', Bug: 'bug' };

// Compute the next per-layer id by scanning existing items for the
// matching prefix and taking max(N) + 1. Items with old-style hex ids
// (pre-2026-05-15) are silently ignored — they stay valid but don't
// participate in the counter scan, so new items just keep counting up
// from the highest prefixed id (or 1 if there are none yet).
function _nextPlanItemId(items, layer) {
  const prefix = PLAN_LAYER_PREFIX[layer];
  if (!prefix) return null;
  const re = new RegExp('^' + prefix + '-(\\d+)$');
  let maxN = 0;
  for (const it of items) {
    if (!it || typeof it.id !== 'string') continue;
    const m = it.id.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  return `${prefix}-${maxN + 1}`;
}

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
      id: _nextPlanItemId(rec.artifacts.plan.items, layer)
        || crypto.randomBytes(6).toString('hex'),  // hex fallback if layer is unknown
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
    // _persistPlanArtifact handles saveStore + the _myco_/plan.json
    // mirror + the state-update emit so /merge and (future) /dedupe
    // ride the same persistence path.
    _persistPlanArtifact(rec, sessionId);
  } catch (err) {
    ctx.reply(`(plan item failed to save: ${err.message})`);
    return;
  }
  ctx.reply(`✓ added **${layer}** \`${item.id}\` to Plan: ${text}`);
}

// Persist the plan artifact + mirror to _myco_/plan.json + emit
// state-update — extracted from addPlanItem so /merge and (future)
// /dedupe write through the same path.
function _persistPlanArtifact(rec, sessionId) {
  rec.artifacts.plan.updatedAt = new Date().toISOString();
  sessionsMod.saveStore();
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
}

// Pure merge logic. Mutates rec.artifacts.plan.items in place + returns
// the merge summary. Throws an Error with a human-readable message on
// validation failure (caller is expected to catch + surface). The
// caller is responsible for persisting + broadcasting after — see
// _persistPlanArtifact (slash handler) or persistArtifact+broadcast
// (HTTP endpoint) for the two call sites.
function mergePlanItems(rec, ids) {
  if (!Array.isArray(ids) || ids.length < 2) {
    throw new Error('need at least two ids');
  }
  if (!rec || !rec.artifacts || !rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) {
    throw new Error('no plan items yet — nothing to merge');
  }
  const items = rec.artifacts.plan.items;
  const lookup = new Map(items.map((it) => [it.id, it]));
  const missing = ids.filter((id) => !lookup.has(id));
  if (missing.length) {
    throw new Error(`unknown id${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }
  const layers = new Set(ids.map((id) => lookup.get(id).layer));
  if (layers.size > 1) {
    throw new Error(`cannot merge across layers — got ${[...layers].join(' + ')}`);
  }
  const layer = [...layers][0];

  // Sort the participating items by numeric suffix so the canonical
  // is the lowest-numbered. Items with hex ids (no numeric suffix)
  // sort to the end — pick the lowest-numbered prefixed id as
  // canonical if present; otherwise the first arg.
  const participants = ids.map((id) => lookup.get(id));
  participants.sort((a, b) => {
    const na = (a.id.match(/-(\d+)$/) || [])[1];
    const nb = (b.id.match(/-(\d+)$/) || [])[1];
    if (na && nb) return parseInt(na, 10) - parseInt(nb, 10);
    if (na) return -1;
    if (nb) return 1;
    return 0;
  });
  const canonical = participants[0];
  const others = participants.slice(1);

  // Append other bodies to canonical.text with a clear divider naming
  // each source. Existing canonical.text stays at the top.
  const divider = '\n\n— merged from ';
  for (const o of others) {
    canonical.text = `${canonical.text}${divider}\`${o.id}\` (added by @${o.addedBy || 'unknown'}): ${o.text}`;
  }
  // mergedFrom is cumulative across repeated /merge calls so the
  // chain of provenance survives.
  const prior = Array.isArray(canonical.mergedFrom) ? canonical.mergedFrom : [];
  canonical.mergedFrom = [...prior, ...others.map((o) => o.id)];

  // Drop the merged-away items from items[].
  const dropIds = new Set(others.map((o) => o.id));
  rec.artifacts.plan.items = items.filter((it) => !dropIds.has(it.id));

  return {
    canonical,
    absorbed: others.map((o) => o.id),
    layer,
  };
}

// /merge <id1> <id2> [<id3>…] — collapse the listed plan items (same
// layer) into the lowest-numbered canonical. Delegates the actual
// mutation to mergePlanItems; this handler just parses the args,
// catches validation errors, and replies in chat.
function handleMerge(ctx) {
  const raw = (ctx.args || '').trim();
  if (!raw) {
    ctx.reply('Usage: `/merge <id1> <id2> [<id3>…]` — collapse 2+ plan items of the same layer into the lowest-numbered one.');
    return;
  }
  const ids = raw.split(/\s+/).filter(Boolean);
  if (ids.length < 2) {
    ctx.reply('(/merge needs at least two ids — e.g. `/merge td-3 td-7`)');
    return;
  }
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  let result;
  try {
    result = mergePlanItems(rec, ids);
  } catch (err) {
    ctx.reply(`(${err.message})`);
    return;
  }
  _persistPlanArtifact(rec, sessionId);
  ctx.reply(`✓ merged ${result.absorbed.length + 1} **${result.layer}** items into \`${result.canonical.id}\` (absorbed: ${result.absorbed.map((id) => '`' + id + '`').join(', ')})`);
}

// Read project context that the dedupe LLM should consider alongside
// the bare item text — CLAUDE.md and the auto-memory dir. Both are
// truncated to MAX_CONTEXT_BYTES each so the overall prompt stays
// manageable. Returns the formatted block (possibly empty).
const MAX_CONTEXT_BYTES = 4096;
function _loadProjectContext(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const sections = [];
  // CLAUDE.md sits at the cwd root by convention.
  try {
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    const txt = fs.readFileSync(claudeMdPath, 'utf8');
    const slice = txt.length > MAX_CONTEXT_BYTES
      ? txt.slice(0, MAX_CONTEXT_BYTES) + '\n…(truncated)'
      : txt;
    sections.push('## Project CLAUDE.md (project-specific instructions)\n\n' + slice);
  } catch {}
  // Auto-memory lives at ~/.claude/projects/<encoded-cwd>/memory/. The
  // index file MEMORY.md is the most useful single read — it lists
  // each memory file with a one-line hook. Inline the index then a few
  // of the linked entries up to the byte budget.
  try {
    const encoded = cwd.replace(/\//g, '-');
    const memDir = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
    const indexPath = path.join(memDir, 'MEMORY.md');
    const indexTxt = fs.readFileSync(indexPath, 'utf8');
    let memBlock = '## Project auto-memory index\n\n' + indexTxt;
    // Append the bodies of each linked .md until the budget is hit.
    let used = memBlock.length;
    const linkRe = /\(([\w_-]+\.md)\)/g;
    let m;
    const seen = new Set();
    while ((m = linkRe.exec(indexTxt))) {
      const fname = m[1];
      if (seen.has(fname)) continue;
      seen.add(fname);
      try {
        const body = fs.readFileSync(path.join(memDir, fname), 'utf8');
        const trimmed = body.length > 800 ? body.slice(0, 800) + '\n…(truncated)' : body;
        const entry = `\n\n### memory/${fname}\n\n${trimmed}`;
        if (used + entry.length > MAX_CONTEXT_BYTES) break;
        memBlock += entry;
        used += entry.length;
      } catch {}
    }
    sections.push(memBlock);
  } catch {}
  return sections.length ? sections.join('\n\n---\n\n') : '';
}

// LLM-driven dedupe scan. Pure — does NOT mutate the rec/artifact, only
// returns the proposal. Shape:
//   { groups: [{ ids: [...], reason: '<one-line>' }], skipped?, error?, raw? }
// `skipped` indicates the LLM wasn't called (e.g. <2 eligible items).
// `error` indicates the LLM call/response failed.
//
// Prompt enrichment (2026-05-15): the project's CLAUDE.md and the
// auto-memory directory are inlined before the item list so claude can
// use project-specific synonyms, conventions, and past decisions when
// deciding whether two items refer to the same underlying concern.
async function dedupePlanItems(items, cwd) {
  const eligible = (items || []).filter((it) => it && it.id && PLAN_LAYER_PREFIX[it.layer]);
  if (eligible.length < 2) {
    return { groups: [], skipped: 'fewer than 2 eligible items (need prefixed ids in Feature/Todo/Bug)' };
  }
  const byLayer = { Feature: [], Todo: [], Bug: [] };
  for (const it of eligible) {
    if (byLayer[it.layer]) byLayer[it.layer].push(it);
  }
  const sections = [];
  for (const layer of ['Feature', 'Todo', 'Bug']) {
    if (!byLayer[layer].length) continue;
    sections.push(`### ${layer}`);
    for (const it of byLayer[layer]) {
      sections.push(`- ${it.id}: ${it.text.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
    sections.push('');
  }
  const context = _loadProjectContext(cwd);
  const promptBody = [
    'You are looking at a plan-item list. Identify GROUPS of items that are similar or related enough that they should be merged into a single canonical item. Only group items within the same layer (Feature/Todo/Bug); never cross layers.',
    '',
    'Use the project context below to resolve project-specific synonyms, conventions, and past decisions before deciding what counts as "similar enough" — two items framed differently may refer to the same underlying concern.',
    '',
    'Return STRICT JSON only — no preamble, no markdown fences. Schema:',
    '{ "groups": [ { "ids": ["td-3","td-7"], "reason": "<one-line reason citing the project context when applicable>" } ] }',
    'If no merges are warranted, return: { "groups": [] }',
    '',
    context ? '# Project context\n\n' + context + '\n\n' : '',
    '# Plan items',
    '',
    sections.join('\n'),
  ].join('\n');

  const btw = require('./btw');
  let raw;
  try {
    raw = await btw.runClaudeP(cwd || process.cwd(), promptBody);
  } catch (err) {
    return { groups: [], error: 'claude call failed: ' + err.message };
  }
  if (/^\(claude /.test(raw)) {
    return { groups: [], error: raw };
  }
  let parsed;
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(stripped);
  } catch {
    return { groups: [], error: 'claude response was not valid JSON', raw: raw.slice(0, 1500) };
  }
  const groups = Array.isArray(parsed && parsed.groups) ? parsed.groups : [];
  // Validate each group: ids must all exist in eligible + share a layer.
  const eligibleIds = new Set(eligible.map((it) => it.id));
  const layerById = new Map(eligible.map((it) => [it.id, it.layer]));
  const valid = [];
  for (const g of groups) {
    const gids = Array.isArray(g && g.ids) ? g.ids.filter((id) => eligibleIds.has(id)) : [];
    if (gids.length < 2) continue;
    const layers = new Set(gids.map((id) => layerById.get(id)));
    if (layers.size !== 1) continue;
    valid.push({ ids: gids, reason: String((g && g.reason) || '').slice(0, 200) });
  }
  return { groups: valid };
}

// /dedupe — slash command wrapper. Calls dedupePlanItems and formats
// the result as a chat reply with ready-to-paste `/merge <id1> <id2>`
// commands. No auto-apply.
async function handleDedupe(ctx) {
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  const items = (rec && rec.artifacts && rec.artifacts.plan && Array.isArray(rec.artifacts.plan.items))
    ? rec.artifacts.plan.items : [];
  const eligible = items.filter((it) => it && it.id && PLAN_LAYER_PREFIX[it.layer]);
  if (eligible.length < 2) {
    ctx.reply('(/dedupe needs at least two plan items with prefixed ids — `/fr` `/td` `/bug` add them as `fr-N` / `td-N` / `bug-N`)');
    return;
  }
  ctx.reply('🔍 asking claude to scan for dedupe candidates… (one moment)');
  const result = await dedupePlanItems(items, ctx.absCwd);
  if (result.error) {
    if (result.raw) {
      ctx.reply([
        `(/dedupe: ${result.error}; raw reply below)`,
        '',
        '```',
        result.raw,
        '```',
      ].join('\n'));
    } else {
      ctx.reply(`(/dedupe: ${result.error})`);
    }
    return;
  }
  if (!result.groups.length) {
    ctx.reply('✓ no merge candidates found — the plan items look distinct enough.');
    return;
  }
  const lines = [`Found **${result.groups.length}** dedupe candidate${result.groups.length === 1 ? '' : 's'}. To merge, copy + run the corresponding line:`];
  for (const g of result.groups) {
    lines.push('');
    lines.push(`- ${g.reason || '(no reason)'}`);
    lines.push(`  \`/merge ${g.ids.join(' ')}\``);
  }
  ctx.reply(lines.join('\n'));
}

function handleFeature(ctx) {
  return handleIssue(ctx, { kind: 'feature', labels: ['enhancement'] });
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
  lines.push('Routing:');
  lines.push('  • plain text → sent to the running Claude session');
  lines.push('  • `@<username> <text>` → chat-only mention (highlighted for the recipient)');
  lines.push('  • `/btw <text>` → ask Claude in the chat (no PTY write)');
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
  // Exposed for artifacts.js refresh hook + future callers.
  mergePlanItems,
  dedupePlanItems,
  // Exposed for testing the project-context loader.
  _loadProjectContext,
};
