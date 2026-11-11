// agents/rlm/bridge.js — lane/child event bridging (design §3).
// Migrated from the old rlm-session.js startRlmLane inline bridge +
// extended for children.
//
// CONTRACT: bridged events feed the chat-pane UI ONLY. They are
// re-stamped with the MAIN session's seq so the pane's cross-device
// resort stays correct, but they are never fed into the parent agent's
// LLM context — the parent only ever sees rlm.collect's folded answer
// (children.js foldAnswer).

'use strict';

function bridgeRlmLane(lane, mainSession, mainSessionId, laneTag = 'rlm') {
  const sessionsMod = require('../../sessions');
  lane.on('agent-event', (ev) => {
    if (!ev) return;
    const out = Object.assign({}, ev);
    delete out.seq;
    out.seq = sessionsMod.allocSeq(mainSessionId);
    out.rlmLane = laneTag;
    mainSession.emit('agent-event', out);
  });
  lane.on('menu', (m) => mainSession.emit('menu', m));
  return lane;
}

module.exports = { bridgeRlmLane };
