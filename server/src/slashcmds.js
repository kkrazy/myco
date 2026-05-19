// Slash-command dispatcher for the discussion pane. Commands start with /
// at the start of a chat message. Each handler receives a context and is
// expected to emit one or more chat messages back via `reply(text)`.
//
// Handlers should never throw — always resolve with a user-visible result
// (success or human-readable error). The dispatcher posts the handler's
// reply as a chat message tagged with the assistant user.

const github = require('./github');           // kept as legacy back-compat shim
const gitHosts = require('./git-hosts');       // provider-aware dispatch (github + gitee)
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
    summary: 'Raise a feature request issue on the session\'s github/gitee repo',
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
  // Task-list intervention. The handler forwards a natural-language
  // directive to the running Claude session (see handleTaskList /
  // handleTaskSkip); the agent's CLAUDE.md task-list etiquette teaches
  // it to respond with the list / dismissal.
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
    names: ['add2plan'],
    summary: 'Ask claude to break a description into todos / FRs and add them to the Plan (incl. dependsOn for ordering)',
    usage: '/add2plan <description>',
    handler: handleAdd2Plan,
  },
  {
    names: ['setpat'],
    summary: 'Save a personal access token for this session\'s repo (github or gitee, auto-detected)',
    usage: '/setpat <token>',
    handler: handleSetPat,
  },
  {
    names: ['admin'],
    summary: 'Grant/revoke admin on this session (owner only). Admins inherit everything except delete + grant/revoke.',
    usage: '/admin @user (grant) · /admin -@user (revoke) · /admin (list)',
    handler: handleAdmin,
  },
  {
    names: ['strict'],
    summary: 'Toggle strict-mode gate: claude-bound chat must include [run:plan#<id>] (owner + admin).',
    usage: '/strict on · /strict off · /strict (status)',
    handler: handleStrict,
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
//
// fr-4 (2026-05-16): if the body is long (> PLAN_ITEM_REWRITE_WORD_THRESHOLD
// words) OR opt-in via a leading `!` ("/td! Auth flow is broken when …"),
// kick off an async claude rewrite that re-shapes the description into
// a tight software-issue format (problem → expected vs actual → context).
// The item is saved IMMEDIATELY with the original text so the user gets
// instant feedback; when the rewrite lands the item's text + meta is
// updated in place and broadcast via state-update. Original text is
// preserved on `meta.originalText`. Short items (≤ threshold, no `!`)
// skip the rewrite entirely — quick captures stay quick.
const PLAN_ITEM_REWRITE_WORD_THRESHOLD = 8;
function addPlanItem(ctx, layer) {
  let text = (ctx.args || '').trim();
  if (!text) {
    ctx.reply(`Usage: /<cmd> <description> — adds a ${layer} item to this session's Plan.`);
    return;
  }
  // Opt-in force-rewrite via leading `!`. The parser's regex stops at
  // `\b` after the slash-cmd name so `/td!` arrives here as args
  // starting with `!` (parseCommand splits "/td! …" → name='td',
  // rest='! …'). Strip the bang + adjacent whitespace.
  let forceRewrite = false;
  if (text.startsWith('!')) {
    forceRewrite = true;
    text = text.slice(1).trim();
    if (!text) {
      ctx.reply(`Usage: /<cmd>! <description> — adds a ${layer} item and asks claude to rewrite it into software-issue format.`);
      return;
    }
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const shouldRewrite = forceRewrite || wordCount > PLAN_ITEM_REWRITE_WORD_THRESHOLD;

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
    if (shouldRewrite) {
      item.meta = { rewritePending: true, rewriteRequested: forceRewrite ? 'force' : 'long' };
    }
    rec.artifacts.plan.items.push(item);
    // _persistPlanArtifact handles saveStore + the _myco_/plan.json
    // mirror + the state-update emit so /merge and (future) /dedupe
    // ride the same persistence path.
    _persistPlanArtifact(rec, sessionId);
  } catch (err) {
    ctx.reply(`(plan item failed to save: ${err.message})`);
    return;
  }
  const replyTail = shouldRewrite
    ? ' — claude is rewriting this into issue format (will update shortly)…'
    : '';
  ctx.reply(`✓ added **${layer}** \`${item.id}\` to Plan: ${text}${replyTail}`);
  if (shouldRewrite) {
    // Fire-and-forget — the persistence + broadcast on completion is
    // the user signal, not the chat reply. We don't await so the chat
    // input frees up immediately.
    _rewritePlanItemAsync(sessionId, item.id, text, layer, ctx).catch((err) => {
      console.error(`[plan-rewrite] ${sessionId} ${item.id}: ${err && err.message ? err.message : err}`);
    });
  }
}

// Issue-style rewrite prompt. Keep it short, lean, no preamble — we
// want the model to output ONLY the rewritten body, ready to land in
// rec.artifacts.plan.items[].text. The schema in the user message
// (problem / expected / actual / context) matches what a software
// engineer would look for first when triaging.
const _PLAN_REWRITE_SYSTEM = [
  'You rewrite a short plan-item description into a tight software-engineering issue body.',
  'OUTPUT FORMAT — markdown, in this order, omit sections that don\'t apply:',
  '**Problem:** one sentence calling out the actual user-facing or developer-facing pain.',
  '**Expected:** what the right behaviour or shape is.',
  '**Actual:** what currently happens instead.',
  '**Context:** any extra signal (file path, repro steps, env) — only if present in the input.',
  'KEEP IT TIGHT: total ≤ 4 short lines for trivial items, ≤ 10 lines for complex ones.',
  'Preserve the user\'s domain words verbatim — do not paraphrase technical terms. No preamble, no closing remarks, no "here is the rewrite".',
].join('\n');

async function _rewritePlanItemAsync(sessionId, itemId, originalText, layer, ctx) {
  const cwd = (ctx && ctx.absCwd) || process.cwd();
  const userPrompt = [
    `Layer: ${layer}`,
    `Original description: ${originalText}`,
    '',
    'Rewrite the description following the system prompt format.',
  ].join('\n');
  const btw = require('./btw');
  let rewritten;
  try {
    rewritten = await btw.runClaudeP(cwd, `${_PLAN_REWRITE_SYSTEM}\n\n${userPrompt}`);
  } catch (err) {
    rewritten = null;
  }
  // _clearRewritePending updates the item under both success and failure;
  // we always need to drop the rewritePending flag so the UI's "rewriting…"
  // indicator turns off.
  _applyPlanItemRewrite(sessionId, itemId, rewritten, originalText);
}

function _applyPlanItemRewrite(sessionId, itemId, rewritten, originalText) {
  let store, rec, item;
  try {
    store = sessionsMod.loadStore();
    rec = store.sessions[sessionId];
    if (!rec || !rec.artifacts || !rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) return;
    item = rec.artifacts.plan.items.find((it) => it && it.id === itemId);
    if (!item) return;
  } catch { return; }
  if (!item.meta) item.meta = {};
  delete item.meta.rewritePending;
  const cleanedRewrite = _sanitizePlanRewrite(rewritten);
  if (cleanedRewrite) {
    item.meta.originalText = originalText;
    item.meta.rewritten = true;
    item.text = cleanedRewrite;
  } else {
    item.meta.rewriteFailed = true;
  }
  _persistPlanArtifact(rec, sessionId);
}

// Tolerate the claude-cli error stand-ins (`(claude failed to start: …)`,
// `(claude responded with no content)`, etc.) and obvious garbage —
// return null so the caller leaves the original text in place + flags
// rewriteFailed instead of overwriting the item with an error stub.
function _sanitizePlanRewrite(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\(claude /.test(trimmed)) return null;
  // Strip code fences the model may wrap around the output.
  const unfenced = trimmed.replace(/^```(?:markdown)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  if (!unfenced) return null;
  return unfenced;
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
    const attachMod = require('./attach');
    const session = attachMod.getSession && attachMod.getSession(sessionId);
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

// /add2plan — claude breaks the user's description into a list of
// todos / feature requests and appends them to this session's
// plan.json via the Edit tool. Items can carry an optional
// dependsOn: [id, ...] field for ordering constraints.
//
// Why route through claude instead of doing the breakdown server-
// side: it's a reasoning task. claude has the context of the
// conversation and the existing plan items to decompose well; a
// regex parser can't.
function handleAdd2Plan(ctx) {
  const text = (ctx.args || '').trim();
  if (!text) {
    ctx.reply('Usage: `/add2plan <description>` — claude breaks it into todos + FRs and appends them to the Plan (with optional `dependsOn` for ordering).');
    return;
  }
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  // Read the existing plan to suggest the next free id ranges in
  // the prompt — saves claude a round-trip on id enumeration.
  let nextTd = 1, nextFr = 1;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    const items = (rec && rec.artifacts && rec.artifacts.plan && rec.artifacts.plan.items) || [];
    for (const it of items) {
      if (typeof it.id !== 'string') continue;
      const tdM = it.id.match(/^td-(\d+)$/);
      const frM = it.id.match(/^fr-(\d+)$/);
      if (tdM) nextTd = Math.max(nextTd, parseInt(tdM[1], 10) + 1);
      if (frM) nextFr = Math.max(nextFr, parseInt(frM[1], 10) + 1);
    }
  } catch {}
  // Build the prompt — claude calls mcp__myco__add_plan_items
  // (server-side appender) instead of editing plan.json directly.
  // The tool handles id generation + persistence + broadcast; we
  // just describe the schema claude should pass.
  const prompt = [
    `[/add2plan] Break the following request into discrete plan items, then call the \`mcp__myco__add_plan_items\` tool to append them.`,
    ``,
    `Tool input shape:`,
    `  {`,
    `    "items": [`,
    `      {`,
    `        "text": "<1-2 sentence description>",`,
    `        "layer": "Todo" | "Feature" | "Bug",`,
    `        "dependsOn": ["td-3", ...]    // OPTIONAL, only when ordering is required`,
    `      },`,
    `      ...`,
    `    ]`,
    `  }`,
    ``,
    `Guidance:`,
    `- Prefer 1-7 short items over many over-decomposed ones.`,
    `- Use \`dependsOn\` sparingly. Most items should have NO dependsOn.`,
    `- Server auto-generates ids (td-N / fr-N / bug-N); you only supply text/layer/dependsOn.`,
    `- Existing items are preserved — the tool only appends.`,
    ``,
    `Request: ${text}`,
  ].join('\n');
  // Inject into the SDK's user-message queue via session.write.
  // Claude will receive it as a normal user turn.
  try {
    const attachMod = require('./attach');
    const session = attachMod.getSession && attachMod.getSession(sessionId);
    if (!session || typeof session.write !== 'function') {
      ctx.reply('(no live agent session — try sending a message to wake it up, then re-run `/add2plan`)');
      return;
    }
    session.write(prompt);
    ctx.reply(`▶ asked claude to expand into plan items (next ids: td-${nextTd}, fr-${nextFr}). Watch the Plan tab — items will appear once claude finishes the Edit tool call.`);
  } catch (err) {
    ctx.reply(`(/add2plan failed: ${err.message})`);
  }
}

// /task /tasks — forward a "show your TaskList" prompt to the running
// Claude session. The agent's CLAUDE.md task-list etiquette teaches
// claude what to do with these phrasings (no @myco prefix any more —
// every chat message reaches claude as a normal user turn, so we just
// send the natural-language directive).
function handleTaskList(ctx) {
  if (!ctx.session || !ctx.session.alive) {
    ctx.reply('(/task: session not running)');
    return;
  }
  ctx.session.write('Please list your current pending and in-progress internal tasks (TaskList). Format as a short numbered list with id + subject.');
}

// /skip <N> / /cancel <N> — forward a "dismiss task N" prompt. If the
// arg isn't a numeric id, bounce with a usage hint instead of forwarding
// garbage.
function handleTaskSkip(ctx) {
  const name = (ctx && ctx.command) || 'skip';
  const arg = String((ctx && ctx.args) || '').trim();
  if (!/^\d+$/.test(arg)) {
    ctx.reply(
      `Usage: \`/${name} <task-id>\` — tells the running Claude to dismiss the given internal task ` +
      `(TaskUpdate → status=deleted). Use \`/task\` first to see ids.`,
    );
    return;
  }
  if (!ctx.session || !ctx.session.alive) {
    ctx.reply(`(/${name}: session not running)`);
    return;
  }
  ctx.session.write(`Please dismiss internal task #${arg} via TaskUpdate({ taskId, status: 'deleted' }) and reply with one line confirming.`);
}

async function handleIssue(ctx, { kind, labels }) {
  const title = ctx.args && ctx.args.trim();
  if (!title) {
    ctx.reply(`Usage: /${kind} <title>\nExample: /${kind} add dark mode toggle`);
    return;
  }
  // Detect provider from the session's git remote BEFORE the token check —
  // the error message is more useful when we can tell the user "set a gitee
  // token" vs. "set a github token".
  const host = await gitHosts.detectHost(ctx.absCwd);
  if (!host) {
    ctx.reply(
      `(could not detect a github.com or gitee.com remote for this session's cwd: ${ctx.absCwd}. ` +
      `\`/${kind}\` requires \`git remote get-url origin\` to point at one of those hosts.)`
    );
    return;
  }
  // Per-repo PAT first (set via /setpat), then user-level OAuth token as
  // fallback (only github has one — gitee has no OAuth flow yet).
  const token = gitHosts.getToken(ctx.user, host.provider, host.owner, host.repo);
  if (!token) {
    if (host.provider === 'github') {
      ctx.reply(
        `(no GitHub token on file for @${ctx.user} for ${host.owner}/${host.repo}. ` +
        `Sign out and back in via GitHub to refresh the OAuth token (must include \`repo\` scope), ` +
        `or run \`/setpat <token>\` to save a per-repo PAT.)`
      );
    } else {
      ctx.reply(
        `(no Gitee PAT on file for @${ctx.user} for ${host.owner}/${host.repo}. ` +
        `Generate a PAT at https://gitee.com/profile/personal_access_tokens (scope: \`issues\`) ` +
        `and run \`/setpat <token>\` from this session.)`
      );
    }
    return;
  }
  const body = [
    title,
    '',
    '---',
    `Filed by **@${ctx.user}** via [myco](https://myco.labxnow.ai/) on ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC.`,
  ].join('\n');
  const result = await gitHosts.createIssue({
    provider: host.provider,
    token, owner: host.owner, repo: host.repo, title, body, labels,
  });
  if (result.error) {
    const label = host.provider === 'gitee' ? 'Gitee' : 'GitHub';
    ctx.reply(`(${label} error: ${result.error}${result.status ? ` [HTTP ${result.status}]` : ''})`);
    return;
  }
  ctx.reply(`✓ Filed ${kind} request #${result.number} on ${host.owner}/${host.repo}: ${result.url}`);
}

// /setpat <token>
//
// Saves a personal access token for THIS SESSION's repo. The provider
// (github / gitee) and the owner/repo are auto-detected from the
// session's git remote — the user just pastes their token.
//
// Each (user, repo) pair gets exactly one PAT. Re-running /setpat
// overwrites the previous one. The user-level OAuth token (set by the
// GitHub login flow) stays in place as a fallback for any GitHub repo
// without a per-repo PAT.
//
// We validate the token by hitting the provider's /user endpoint before
// persisting — so a typo or wrong-provider paste surfaces immediately,
// not on the next /feature.
async function handleSetPat(ctx) {
  const token = String(ctx.args || '').trim();
  if (!token) {
    ctx.reply(
      `Usage: /setpat <token>\n` +
      `Saves a PAT for this session's repo. Provider is auto-detected from \`git remote get-url origin\` ` +
      `(github.com or gitee.com).\n` +
      `For Gitee, generate a PAT at https://gitee.com/profile/personal_access_tokens (scope: \`issues\`).`
    );
    return;
  }
  if (token.length < 8) {
    ctx.reply(`(token looks too short — did you paste a placeholder?)`);
    return;
  }
  // Detect provider+owner+repo from the session's cwd. "One PAT per repo"
  // means we need to know WHICH repo before we can store anything.
  const host = await gitHosts.detectHost(ctx.absCwd);
  if (!host) {
    ctx.reply(
      `(no github.com or gitee.com remote in this session's cwd: ${ctx.absCwd}. ` +
      `\`/setpat\` saves a PAT scoped to the current repo; make sure ` +
      `\`git remote get-url origin\` points at one of those hosts.)`
    );
    return;
  }
  let profile;
  try { profile = await gitHosts.fetchUser({ provider: host.provider, token }); }
  catch (err) {
    ctx.reply(`(${host.provider} rejected the token: ${err.message})`);
    return;
  }
  try { gitHosts.setRepoToken(ctx.user, host.provider, host.owner, host.repo, token); }
  catch (err) {
    ctx.reply(`(could not save token: ${err.message})`);
    return;
  }
  ctx.reply(
    `✓ Saved ${host.provider} PAT for ${host.owner}/${host.repo} ` +
    `(validated as ${host.provider}:${profile.login}). \`/feature\` and \`/bug\` will use it.`,
  );
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

  // Agent-mode session: route the pick through resolveMenuPick (which
  // resolves the pending canUseTool promise), not through PTY bytes.
  // PTY-mode keeps the legacy digit + CR write.
  const session = ctx.session;
  const pending = session && session.alive ? session.pendingMenu : null;
  if (pending && Array.isArray(pending.options) && pending.options.some((o) => o.n === n)) {
    if (session.mode === 'agent' && typeof session.resolveMenuPick === 'function' && pending.hash) {
      session.resolveMenuPick(pending.hash, n);
    } else {
      // Claude Code's menus accept digit + Enter to commit.
      session.write(String(n) + '\r');
      session.pendingMenu = null;
    }
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
  ctx.reply(`✓ added \`${pattern}\` to the allow list. Send \`try again\` in chat to retry the previously-denied tool.`);
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
    // Prefer ctx.session (passed by attach.handleChatMessage) and fall
    // back to attach.getSession(id) so the slash-todo-inject-style unit
    // tests, which only supply { sessionId, absCwd, reply }, still
    // observe a no-op instead of a crash.
    let session = ctx.session || null;
    if (!session) {
      try { session = require('./attach').getSession(sessionId); } catch {}
    }
    if (session) session.emit('state-update', { kind: 'chat-clear' });
  } catch {}
  ctx.reply(`✓ cleared ${cleared} chat message${cleared === 1 ? '' : 's'}`);
}

// fr-39: /admin @user (grant), /admin -@user (revoke), /admin (list).
// Owner-only — the gate is intentional: owner stays sovereign over
// the trust graph; admins cannot promote other admins. Args are
// parsed permissively (`@user`, `user`, `-@user`, `-user` all
// accepted) so the user doesn't have to remember the exact form.
function handleAdmin(ctx) {
  const sessionsMod = require('./sessions');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/admin: session not found)');
    return;
  }
  // Owner-only gate. ctx.user comes from the WS attach (set in
  // attach.js's WS upgrade) and matches the same login compared by
  // sessionBelongsToUser.
  if (rec.user !== ctx.user) {
    ctx.reply(`(/admin is owner-only. Session owner is @${rec.user}.)`);
    return;
  }
  const arg = String((ctx && ctx.args) || '').trim();
  // No args → list current admins (no-op informational).
  if (!arg) {
    const admins = sessionsMod.getSessionAdmins(ctx.sessionId);
    if (!admins.length) {
      ctx.reply('No admins on this session yet. `/admin @user` to grant; `/admin -@user` to revoke. Owner stays @' + rec.user + '.');
    } else {
      const list = admins.map((u) => '@' + u).join(', ');
      ctx.reply(`Admins on this session: ${list}. Owner: @${rec.user}. \`/admin -@user\` to revoke.`);
    }
    return;
  }
  // Parse: leading "-" means revoke; otherwise grant. Strip optional
  // "@" prefix from the username so `/admin @bob`, `/admin bob`,
  // `/admin -@bob`, `/admin -bob` all work.
  let revoke = false;
  let target = arg;
  if (target.startsWith('-')) {
    revoke = true;
    target = target.slice(1).trim();
  }
  if (target.startsWith('@')) target = target.slice(1).trim();
  if (!target || !/^[A-Za-z0-9_-]+$/.test(target)) {
    ctx.reply('Usage: `/admin @user` (grant), `/admin -@user` (revoke), or `/admin` (list).');
    return;
  }
  // Can't admin the owner (redundant) and can't admin yourself if
  // you're not the owner (the owner-only gate above already blocked
  // that path, but be explicit for the self-grant misclick).
  if (target === rec.user) {
    ctx.reply(`(@${target} is the owner — already has all privileges.)`);
    return;
  }
  if (revoke) {
    const removed = sessionsMod.removeAdminFromSession(ctx.sessionId, target);
    ctx.reply(removed
      ? `✓ @${target} is no longer an admin on this session.`
      : `(@${target} wasn't an admin — nothing to revoke.)`);
  } else {
    const added = sessionsMod.addAdminToSession(ctx.sessionId, target);
    ctx.reply(added
      ? `✓ @${target} is now an admin on this session. Inherits everything except delete-session + grant/revoke admin (those stay owner-only).`
      : `(@${target} is already an admin — no change.)`);
  }
}

// fr-38: /strict on / /strict off / /strict (status). Owner + admin
// can flip (admins inherit per fr-39). When ON, handleChatMessage
// blocks any claude-bound chat message that lacks a [run:plan#<id>]
// marker, with a one-shot reply explaining how to unblock.
function handleStrict(ctx) {
  const sessionsMod = require('./sessions');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/strict: session not found)');
    return;
  }
  // Owner + admin gate. Admins inherit non-destructive controls
  // per fr-39; strict-mode toggle isn't grant/revoke/delete so it's
  // in-scope for admins.
  if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    ctx.reply(`(/strict is owner-or-admin only. Session owner is @${rec.user}.)`);
    return;
  }
  const arg = String((ctx && ctx.args) || '').trim().toLowerCase();
  if (!arg) {
    const on = sessionsMod.isSessionStrict(ctx.sessionId);
    ctx.reply(`Strict-mode is currently \`${on ? 'on' : 'off'}\`. ` +
      (on
        ? 'Claude-bound messages must include `[run:plan#<id>]` to drive code changes.'
        : 'All chat messages forward to claude as usual. `/strict on` to gate.'));
    return;
  }
  if (arg !== 'on' && arg !== 'off') {
    ctx.reply('Usage: `/strict on` (enable gate), `/strict off` (disable), or `/strict` (status).');
    return;
  }
  const wantOn = arg === 'on';
  const changed = sessionsMod.setSessionStrict(ctx.sessionId, wantOn);
  if (!changed) {
    ctx.reply(`(strict-mode was already \`${wantOn ? 'on' : 'off'}\` — no change.)`);
    return;
  }
  if (wantOn) {
    ctx.reply('✓ Strict-mode is now `on`. Claude-bound chat messages must include `[run:plan#<id>]` (click ▶ Run on a plan item, or type the marker manually) to drive code changes. `/strict off` to disable.');
  } else {
    ctx.reply('✓ Strict-mode is now `off`. All chat messages forward to claude as usual.');
  }
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
