// TUI menu dispatch.
//
// The PTY emits `menu` events when MenuInterceptor detects a numbered dialog
// in the headless terminal (Claude Code's permission prompts, plan-mode
// confirmation, etc.). This module decides what to do with each:
//
//   * permission dialog + matching allow rule  → auto-pick "Yes",  chat note
//   * permission dialog + matching deny  rule  → auto-pick "No",   chat note
//   * permission dialog with no matching rule  → broadcast to chat (/decide)
//   * plan / generic dialog                    → broadcast to chat (/decide)
//
// All chat broadcasts go through sessionsMod.appendChatMessage so they
// persist on the session record and replay on reconnect, and session.emit
// ('chat') so they reach live WebSocket subscribers.

const permissions = require('./permissions');
const sessionsMod = require('./sessions');

const ASSISTANT_USER = 'claude';

function handleSessionMenu(sessionId, session, menu) {
  if (menu.kind === 'permission') {
    // Agent-mode menus carry { tool, input } pre-stamped (see
    // agent-session._handlePermissionRequest). Pre-Phase-9 menus
    // would have needed regex parsing of menu.rawText to recover
    // (tool, input); that path was retired with the PTY driver.
    const target = menu.target || null;
    if (target && target.tool) {
      const rec = sessionsMod.loadStore().sessions[sessionId];
      const decision = permissions.decide(rec, target.tool, target.input);
      const allowOpt = pickOptionByLabel(menu.options, /^yes|allow|approve/i, 1);
      const denyOpt  = pickOptionByLabel(menu.options, /^no|don'?t|deny|reject/i, 2);
      if (decision === 'allow') {
        autoRespondToMenu(sessionId, session, menu, allowOpt, 'allow', target);
        return;
      }
      if (decision === 'deny') {
        autoRespondToMenu(sessionId, session, menu, denyOpt, 'deny', target);
        return;
      }
      // 'ask' → broadcast with permission-tailored wording so the user can
      // /decide AND optionally /allow.
      broadcastMenuToChat(sessionId, session, menu, target);
      return;
    }
  }
  broadcastMenuToChat(sessionId, session, menu);
}

function pickOptionByLabel(options, regex, fallback) {
  const hit = options.find((o) => regex.test(o.label));
  return hit ? hit.n : fallback;
}

function autoRespondToMenu(sessionId, session, menu, optionN, verb, target) {
  if (!session || !session.alive) return;
  session.write(String(optionN) + '\r');
  session.pendingMenu = null;
  const tgt = target ? `${target.tool}(${target.input || ''})`.slice(0, 120) : 'permission';
  const text = verb === 'allow'
    ? `✓ auto-allowed \`${tgt}\` (matched allow list — option ${optionN}).`
    : `🚫 auto-denied \`${tgt}\` (not in allow list — option ${optionN}). Run \`/allow <pattern>\`, then send \`try again\` in chat.`;
  const msg = {
    user: ASSISTANT_USER,
    text,
    ts: new Date().toISOString(),
    meta: { kind: 'menu-auto', menu, verb, target },
  };
  sessionsMod.appendChatMessage(sessionId, msg);
  session.emit('chat', msg);
  console.log(`[menu] ${sessionId} auto-${verb} ${tgt}`);
}

function broadcastMenuToChat(sessionId, session, menu, target) {
  // bug-21: the Phase 2.5 supersede-on-broadcast sweep used to live
  // here. Its premise was "the SDK only fires a fresh canUseTool when
  // the prior one has already been resolved" — TRUE in serial tool-
  // call mode, FALSE under parallel tool calls (Claude can issue N
  // tool_use blocks in one assistant message, and the SDK fires
  // canUseTool for each in parallel before any is resolved). Marking
  // older menus as superseded in that scenario orphaned their resolver
  // promises and deadlocked the SDK iteration. The supersede sweep
  // still runs from sessions.ensureLiveSession on AgentSession respawn
  // (those menus genuinely refer to dead resolver promises from a
  // killed-and-restarted process); it just no longer fires whenever a
  // new sibling menu lands in chat.
  const lines = [];
  if (target) {
    const summary = `${target.tool}(${target.input || ''})`.slice(0, 200);
    lines.push(`🤔 Claude wants permission to run \`${summary}\``);
  } else {
    lines.push('🤔 Claude is waiting on a decision');
  }
  if (menu.question) lines.push('> ' + menu.question);
  const msg = {
    user: ASSISTANT_USER,
    text: lines.join('\n'),
    ts: new Date().toISOString(),
    meta: { kind: 'menu', menu, target: target || null },
  };
  sessionsMod.appendChatMessage(sessionId, msg);
  session.emit('chat', msg);
  console.log(`[menu] ${sessionId} broadcast ${menu.kind}${menu.multi ? ' (MULTI)' : ''} with ${menu.options.length} options: ${JSON.stringify(menu.question).slice(0, 80)}`);
  // Multi-select diagnostic: dump per-option {n, label, checkbox, checked}
  // so we can see which lines matched MENU_CHECKBOX_RE. Options that
  // SHOULD be toggles but render without `checkbox: true` are the most
  // common cause of "click locks the picker" — they fall out of the
  // toggle branch and get the plain-pick treatment, which disables the
  // whole row.
  if (menu.multi) {
    for (const o of menu.options) {
      console.log(`[menu-multi]   n=${o.n} checkbox=${!!o.checkbox} checked=${!!o.checked} label=${JSON.stringify(String(o.label).slice(0, 80))}`);
    }
  }
}

module.exports = { handleSessionMenu, broadcastMenuToChat };
