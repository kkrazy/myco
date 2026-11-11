// Slash-command handlers for research mode and the domain knowledge base.
//
// Extracted from slashcmds.js so every KB-facing concern lives in one
// folder. slashcmds.js only registers the commands and re-exports these
// handlers; the parsing, gating and rendering live here.
//
// `sessions` is required lazily inside each handler: slashcmds.js →
// sessions.js → attach.js → slashcmds.js is already a circular chain, and
// a top-level require here would join it at module-load time.

'use strict';

const client = require('./client');
const inject = require('./inject');

function sessionsMod() {
  return require('../sessions');
}

// Push the mounted KBs onto the live AgentSession. Same liveness model as
// the MCP-market install route: SDK options are frozen per iteration, so
// the change lands on the next turn.
function applyToLiveSession(rec) {
  try {
    const attach = require('../attach');
    const live = attach.getSession && attach.getSession(rec.id);
    if (live && live.alive && typeof live.setKnowledgeBases === 'function') {
      live.setKnowledgeBases(Array.isArray(rec.knowledgeBases) ? rec.knowledgeBases.slice() : []);
    }
  } catch (err) {
    console.error(`[kb] apply-to-live failed for ${rec.id}: ${err.message}`);
  }
}

function emitResearchState(ctx, rec) {
  if (ctx.session && typeof ctx.session.emit === 'function') {
    ctx.session.emit('state-update', {
      kind: 'research-mode-changed',
      researchMode: rec.researchMode === true,
      knowledgeBases: Array.isArray(rec.knowledgeBases) ? rec.knowledgeBases.slice() : [],
    });
  }
}

// /research — status + on/off. Owner+admin, mirroring /rlm.
function handleResearch(ctx) {
  const args = String((ctx && ctx.args) || '').trim().toLowerCase();
  const sessions = sessionsMod();
  const rec = sessions.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/research: session not found)'); return; }

  const mounted = Array.isArray(rec.knowledgeBases) ? rec.knowledgeBases : [];

  if (!args || args === 'status') {
    const on = rec.researchMode === true;
    const lines = [
      on ? '🔬 Research mode is **ON** for this session.' : '🔬 Research mode is **off** for this session.',
      `Knowledge bases: ${mounted.length ? mounted.join(', ') : '(none mounted)'}`,
      `KB service: ${client.isEnabled() ? client.config().url : 'not configured (set MYCO_KB_URL)'}`,
      `Auto-retrieve: ${rec.kbAutoInject === false ? 'off' : 'on'} · Auto-write-back: ${rec.kbAutoWrite === false ? 'off' : 'on'}`,
      '',
      on
        ? 'Each prompt is searched against the mounted KBs and the hits are injected as reference data. Findings are written back after each substantive turn. `/research off` to stop.'
        : 'Enable with `/research on`, then mount a KB with `/kb use math`.',
    ];
    ctx.reply(lines.join('\n'));
    return;
  }

  const m = args.match(/^(on|off)$/);
  if (!m) {
    ctx.reply('usage: /research · /research on · /research off');
    return;
  }
  if (!sessions.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    ctx.reply(`(/research ${m[1]} is owner+admin only. Session owner is @${rec.user}.)`);
    return;
  }
  const on = m[1] === 'on';
  rec.researchMode = on;
  if (on && !mounted.length) {
    // Sensible default: mount "math" if the service actually has it.
    rec.knowledgeBases = ['math'];
  }
  if (!on) rec.knowledgeBases = [];
  sessions.saveStore();
  applyToLiveSession(rec);
  emitResearchState(ctx, rec);
  ctx.reply(on
    ? `✓ Research mode **enabled**. Mounted: ${(rec.knowledgeBases || []).join(', ') || '(none)'}. `
      + 'Retrieval is injected on each prompt and findings are written back to the knowledge base after each turn. '
      + 'Use `/kb use <name>` to change the KB.'
    : '✓ Research mode **disabled**. Knowledge bases unmounted; no retrieval, no write-back.');
}

// /kb — inspect and operate the knowledge base.
async function handleKb(ctx) {
  const raw = String((ctx && ctx.args) || '').trim();
  const [sub, ...rest] = raw.split(/\s+/).filter(Boolean);
  const tail = rest.join(' ');
  const sessions = sessionsMod();
  const rec = sessions.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/kb: session not found)'); return; }

  if (!client.isEnabled()) {
    ctx.reply('(/kb: knowledge base service is not configured. Set MYCO_KB_URL in the state dir .env, e.g. `MYCO_KB_URL=http://127.0.0.1:7317`, then restart.)');
    return;
  }

  const mounted = Array.isArray(rec.knowledgeBases) ? rec.knowledgeBases : [];
  const activeKb = mounted[0] || 'math';

  if (!sub || sub === 'status' || sub === 'list') {
    const health = await client.health();
    const list = await client.listKbs();
    const lines = ['📚 **Knowledge bases**'];
    if (!health.ok) {
      lines.push(`Service: ⚠️ unreachable — ${health.error}`);
    } else {
      lines.push(`Service: ✅ ${client.config().url} (v${health.data.version}${health.data.vector ? ', vector on' : ', lexical only'})`);
    }
    if (list.ok && Array.isArray(list.data.kbs)) {
      if (!list.data.kbs.length) lines.push('(no knowledge bases built yet)');
      for (const k of list.data.kbs) {
        const mark = mounted.includes(k.name) ? '●' : '○';
        lines.push(`${mark} **${k.name}** — ${k.papers || '?'} papers, ${k.notes || 0} notes`
          + (k.builtAt ? `, built ${k.builtAt.slice(0, 19)}` : ''));
      }
    }
    lines.push('', `Mounted on this session: ${mounted.join(', ') || '(none)'}`);
    lines.push('`/kb use <name>` · `/kb off` · `/kb search <query>` · `/kb notes` · `/kb rebuild`');
    ctx.reply(lines.join('\n'));
    return;
  }

  if (sub === 'use') {
    if (!tail) { ctx.reply('usage: /kb use <name>'); return; }
    if (!sessions.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
      ctx.reply('(/kb use is owner+admin only.)');
      return;
    }
    const list = await client.listKbs();
    const names = list.ok ? (list.data.kbs || []).map((k) => k.name) : [];
    if (!names.includes(tail)) {
      ctx.reply(`(/kb: unknown knowledge base "${tail}". Available: ${names.join(', ') || '(none)'})`);
      return;
    }
    rec.knowledgeBases = [tail];
    rec.researchMode = true;
    sessions.saveStore();
    applyToLiveSession(rec);
    emitResearchState(ctx, rec);
    ctx.reply(`✓ Mounted **${tail}** and enabled research mode. Retrieval applies from the next turn.`);
    return;
  }

  if (sub === 'off') {
    if (!sessions.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
      ctx.reply('(/kb off is owner+admin only.)');
      return;
    }
    rec.knowledgeBases = [];
    sessions.saveStore();
    applyToLiveSession(rec);
    emitResearchState(ctx, rec);
    ctx.reply('✓ Knowledge bases unmounted. Research mode stays on but has nothing to search.');
    return;
  }

  if (sub === 'search') {
    if (!tail) { ctx.reply('usage: /kb search <query>'); return; }
    const res = await client.search(activeKb, tail, { k: 5 });
    if (!res.ok) { ctx.reply(`(/kb search failed: ${res.error})`); return; }
    const block = inject.renderBlock(tail, res.data.results || []);
    ctx.reply(block || `No matches for "${tail}".`);
    return;
  }

  if (sub === 'notes') {
    const res = await client.listNotes(activeKb, { kind: tail || undefined, limit: 50 });
    if (!res.ok) { ctx.reply(`(/kb notes failed: ${res.error})`); return; }
    const rows = res.data.notes || [];
    if (!rows.length) { ctx.reply('(no local notes yet — findings are written back automatically in research mode)'); return; }
    const lines = [`📝 **Local knowledge** (${rows.length})`];
    for (const r of rows) {
      lines.push(`- \`${r.slug}\` [${r.kind}/${r.status}] ${r.title} (hits=${r.hits})`);
    }
    ctx.reply(lines.join('\n'));
    return;
  }

  if (sub === 'verify' || sub === 'deprecate') {
    if (!tail) { ctx.reply(`usage: /kb ${sub} <slug>`); return; }
    if (!sessions.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
      ctx.reply(`(/kb ${sub} is owner+admin only.)`);
      return;
    }
    const res = await client.patchNote(activeKb, tail, {
      status: sub === 'verify' ? 'verified' : 'deprecated',
    });
    if (!res.ok) { ctx.reply(`(/kb ${sub} failed: ${res.error})`); return; }
    ctx.reply(`✓ \`${res.data.slug}\` → ${res.data.status}`);
    return;
  }

  if (sub === 'rebuild') {
    if (!sessions.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
      ctx.reply('(/kb rebuild is owner+admin only.)');
      return;
    }
    const res = await client.reindexNotes(activeKb);
    if (!res.ok) { ctx.reply(`(/kb rebuild failed: ${res.error})`); return; }
    ctx.reply(`✓ Reindexed ${res.data.indexed}/${res.data.total} local note(s).`);
    return;
  }

  ctx.reply('usage: /kb · /kb use <name> · /kb off · /kb search <query> · /kb notes [kind] · /kb verify <slug> · /kb deprecate <slug> · /kb rebuild');
}

module.exports = {
  handleResearch,
  handleKb,
  applyToLiveSession,
  emitResearchState,
};
