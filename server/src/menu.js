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
    const target = permissions.extractPermissionTarget(menu.rawText);
    if (target) {
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
    : `🚫 auto-denied \`${tgt}\` (not in allow list — option ${optionN}). Run \`/allow <pattern>\` then \`@myco try again\` to retry.`;
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
  // Minimal body — the client renders the inline buttons (see
  // renderChatMessage), so the message text just needs to set the
  // scene. Enumerating options here, or telling the user to type
  // `/decide <n>`, only duplicates what the buttons already show.
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
  console.log(`[menu] ${sessionId} broadcast ${menu.kind} with ${menu.options.length} options: ${JSON.stringify(menu.question).slice(0, 80)}`);
}

module.exports = { handleSessionMenu, broadcastMenuToChat };
