// agents/rlm/host.js — host_request router (design §4.2 + appendix B).
// The kernel's in-namespace `rlm` shim sends
//   {"event":"host_request","id","data":{"type":...}}
// and the manager forwards it here; we route by data.type to the
// server-side implementation (children.js etc.) and the reply travels
// back as a host_reply with the same id.
//
// Route table (appendix B):
//   rlm.run            → children.spawnChild      → {rlmChildId, name, sessionDir}
//   rlm.collect        → children.collectChildren → [{rlmChildId, status, answerPreview, durationMs}]
//   rlm.list_subagents → children.listChildren    → RLMSubagent[]
//   rlm.delete_subagent→ children.deleteChild     → pre-delete roster row
//   rlm.progress_note  → chat pane (UI only)      → {ok:true}
//   rlm.find_models    → gateways model catalog   → matches
//   rlm.add_prompt     → harness.js (Continual)   → {ok:true, id}
//   rlm.list_prompts   → harness.js (Continual)   → {ok:true, prompts}
//   rlm.run_factory    → factory.js (P3 编排)     → {ok:true, status, nodes, …}

'use strict';

// Handle one host_request data payload. Returns a promise of the reply
// payload (or { ok:false, error } on failure — the kernel shim turns
// that into a rejected promise for the model's code).
async function handleHostRequest(data, ctx = {}) {
  try {
    const type = data && data.type;
    const children = require('./children');
    switch (type) {
      case 'rlm.run': {
        const r = children.spawnChild({
          parentSessionId: ctx.parentSessionId,
          cwd: ctx.cwd,
          prompt: data.prompt,
          name: data.kwargs && data.kwargs.name,
          model: data.kwargs && data.kwargs.model,
          depth: ctx.depth || 0,
          user: ctx.user || null,
          ui: ctx.ui || null,
        });
        return { ok: true, rlmChildId: r.rlmChildId, name: r.name, sessionDir: r.sessionDir, depth: r.depth };
      }
      case 'rlm.collect': {
        const ids = Array.isArray(data.ids) ? data.ids : [];
        // FIX (2026-10-23 audit): the kernel rlm.collect shim sends
        // { ids, kwargs } (child.js hostShim), so the timeout lives in
        // kwargs.timeoutMs — the old read of data.timeoutMs was always 0.
        const kw = (data.kwargs && typeof data.kwargs === 'object') ? data.kwargs : {};
        const timeoutMs = Number(data.timeoutMs != null ? data.timeoutMs : kw.timeoutMs) || 0;
        const results = await children.collectChildren(ids, { timeoutMs });
        return { ok: true, results };
      }
      case 'rlm.list_subagents': {
        return { ok: true, subagents: children.listChildren() };
      }
      case 'rlm.delete_subagent': {
        // The kernel child's rlm shim sends the id as `id` (child.js
        // hostShim); MCP-side callers send `rlmChildId`. Accept both.
        const id = String(data.rlmChildId || data.id || '');
        const pre = children.listChildren().find((c) => c.rlmChildId === id) || null;
        children.deleteChild(id, ctx.cwd, 'user');
        return { ok: true, deleted: pre };
      }
      case 'rlm.progress_note': {
        _postProgressNote(ctx, String(data.text || ''));
        return { ok: true };
      }
      case 'rlm.find_models': {
        return { ok: true, matches: _findModels(String(data.query || '')) };
      }
      case 'rlm.add_prompt': {
        // Continual Harness: append a durable self-authored rule to the
        // session's prompt additions (harness.js store). Composed into
        // the systemPrompt on the next (re)spawn. ctx.harnessKey (set by
        // the /run-explore lane) redirects the store to a SHARED per-task
        // key so the whole team — and future runs of the same task —
        // evolve one rule set. Absent = per-session store (default).
        const harness = require('./harness');
        const key = ctx.harnessKey || ctx.parentSessionId;
        const row = harness.addPromptAddition(ctx.cwd, key, data.text, data.reason);
        // Stats: one Continual Harness evolution (evolved counter, live UI).
        try { require('./stats').recordEvolution(ctx.parentSessionId, String(data.text || '').length); } catch {}
        return { ok: true, id: row.id, note: 'added — live on the next prompt compose (respawn/iteration)' };
      }
      case 'rlm.list_prompts': {
        const harness = require('./harness');
        const key = ctx.harnessKey || ctx.parentSessionId;
        return { ok: true, prompts: harness.listPromptAdditions(ctx.cwd, key) };
      }
      case 'rlm.run_factory': {
        // Factory 状态机编排 (P3): declarative DAG → compiled machine,
        // executed via children.spawnChild/collectChildren. Depth stays
        // the runtime constraint — factory nodes run at the CALLER's
        // depth so the child's own rlm.spawn still enforces the cap.
        const factory = require('./factory');
        const out = await factory.runFactory({
          spec: data.spec,
          cwd: ctx.cwd,
          parentSessionId: ctx.parentSessionId,
          depth: ctx.depth || 0,
          user: ctx.user || null,
          ui: ctx.ui || null,
        });
        return { ok: out.status !== 'failed', factory: out };
      }
      default:
        return { ok: false, error: `unknown host_request type: ${type}` };
    }
  } catch (err) {
    return { ok: false, error: `${err.name || 'Error'}: ${err.message}`, errorName: err.name || 'Error' };
  }
}

// Post a progress note into the main session's chat pane (UI only —
// mirrors prime's rlm.progress_note). Goes through the main session's
// 'chat' event so every attached device sees it.
// chat-print-persistence fix (2026-11-04): also appendChatMessage into
// the MAIN session's rec.chat so the note survives refresh/reconnect —
// the emit alone vanished on the next attach.
function _postProgressNote(ctx, text) {
  if (!text) return;
  const s = ctx.mainSession;
  if (s && typeof s.emit === 'function') {
    const msg = {
      user: 'claude',
      text: `🧠 ${text}`,
      ts: new Date().toISOString(),
      meta: { kind: 'rlm-progress-note' },
    };
    try {
      const sessionsMod = require('../../sessions');
      if (sessionsMod.appendChatMessage && ctx.parentSessionId) {
        sessionsMod.appendChatMessage(ctx.parentSessionId, msg);
      }
    } catch {}
    s.emit('chat', msg);
  }
}

// Model search over the gateways catalog (mirrors prime
// find_rlm_model_matches — a prefix/substring match over known models).
function _findModels(query) {
  const q = query.trim().toLowerCase();
  const candidates = [];
  try {
    const gw = require('../../gateways');
    const list = typeof gw.listModels === 'function' ? gw.listModels() : [];
    for (const m of list || []) candidates.push(m.id || String(m));
  } catch {
    // gateways module shape varies; fall through to env default.
  }
  if (process.env.ANTHROPIC_MODEL) candidates.push(process.env.ANTHROPIC_MODEL);
  if (!q) return candidates.slice(0, 20);
  return candidates.filter((c) => String(c).toLowerCase().includes(q)).slice(0, 20);
}

// Roster for the rlm_list_subagents MCP tool: live children merged over
// the durable ledger roster (children not in memory surface with the
// ledger's last-known status — design §4.3).
function listSubagents(parentSessionId) {
  const children = require('./children');
  const live = children.listChildren().filter((c) => c.parentSessionId === parentSessionId);
  return live;
}

module.exports = { handleHostRequest, listSubagents, _findModels, _postProgressNote };
