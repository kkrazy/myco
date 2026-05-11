// Extracts Plan / Arch / Test artifacts from a Claude Code session's JSONL
// transcript via the Anthropic API. Surfaced through the discussion-pane
// tabs as on-demand "Refresh" actions.
//
// Plan and Test are JSON arrays of todo strings (turned into checkbox items
// on the client). Arch is freeform markdown. Each extractor is one API call
// to Haiku 4.5 with a transcript tail in the user message.

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { callClaudeCli } = require('./claude-cli');
const { projectsDir, encodeCwdForClaude, getChatHistory } = require('./sessions');

const MAX_TRANSCRIPT_CHARS = 16000;   // ~ recent 40-80 assistant/user turns
const MAX_CHAT_CHARS = 8000;          // discussion-panel messages (incl. non-@myco)
const MAX_INPUT_LINES = 400;
// Extraction calls `claude -p` in the session's cwd, and the prompts now ask
// the model to spot-check the codebase via Read/Glob/Grep before answering.
// That expands the per-refresh time budget — bump from the old 120s ceiling
// to 4 minutes. Most extractions still complete in well under a minute.
const EXTRACTOR_TIMEOUT_MS = 240000;

// The input we hand to the model is the union of two sources, clearly labelled:
//   (a) the Claude Code session transcript (what the model itself saw and did),
//   (b) the Mycelium discussion-panel chat (what humans typed at each other,
//       INCLUDING messages without an @myco prefix — those never reach the
//       running Claude session and are otherwise invisible to extraction).
// The prompts below tell the model to pull signal from both.

// All three prompts pull from THREE sources now:
//   (a) the Claude Code transcript (what the model saw and did)
//   (b) the Mycelium discussion-panel chat (incl. non-@myco messages)
//   (c) the current codebase — the extractor runs `claude -p` in the
//       session's cwd, so Read/Glob/Grep are available to verify whether a
//       proposed TODO is already done, whether an architectural decision
//       is actually reflected in the code, or which tests already exist.
// Each prompt explicitly tells the model to spot-check the code before
// answering, but to keep the exploration tight (this is an artifact
// refresh, not a full code review).

const PROMPTS = {
  plan: {
    system:
      'You are running in the project\'s working directory with file-system tools (Read, Glob, Grep) available. You will be given two sources from a software-engineering session: the running Claude Code transcript AND the Mycelium discussion-panel chat (which contains human-to-human messages, including ones that were NOT sent to Claude via @myco). ' +
      'Extract concrete TODO items that are still PENDING. A "pending" TODO is one the user, a chat participant, or Claude proposed but has not yet been completed. ' +
      'BEFORE you answer, spot-check the codebase: if a proposed change is already in the code, drop it from the list. Don\'t over-explore — a few targeted Read/Grep calls is enough. ' +
      'Pure-discussion intent (without @myco) still counts as a real plan item if it isn\'t reflected in the code yet. ' +
      'OUTPUT FORMAT: a JSON array of strings, each a single short actionable todo, e.g. ["wire the Plan tab to the new endpoint", "add a regression test for the multi-line regex"]. ' +
      'NO prose, NO markdown, NO code fences. If nothing remains pending, output the empty array [].',
  },
  arch: {
    system:
      'You are running in the project\'s working directory with file-system tools (Read, Glob, Grep) available. You will be given two sources from a software-engineering session: the running Claude Code transcript AND the Mycelium discussion-panel chat. ' +
      'Summarize the architectural decisions, design constraints, conventions, and guidelines a new teammate would need to work consistently on this codebase. Combine: (1) what was decided in the recent session/discussion, AND (2) what the actual code currently does — check key files (package.json/README/Dockerfile/main source dirs) so the summary reflects reality, not just chatter. ' +
      'OUTPUT FORMAT: concise GitHub-flavored markdown. Use bullets or short headings; keep it under ~250 words. If nothing notable, output exactly the single line: _(no architectural decisions in recent activity)_.',
  },
  test: {
    system:
      'You are running in the project\'s working directory with file-system tools (Read, Glob, Grep) available. You will be given two sources from a software-engineering session: the running Claude Code transcript AND the Mycelium discussion-panel chat. ' +
      'Extract verification steps — concrete checks a human could run or perform to confirm the recent work behaves correctly. Combine: (1) verification ideas raised in the discussion/transcript, AND (2) gaps you can see in the current code — e.g. obvious behaviours that lack a regression check in test.sh / spec files. ' +
      'BEFORE answering, look at the existing test setup (e.g. test.sh, package.json scripts, test/* directory) so your suggestions slot into how the project actually tests itself. ' +
      'OUTPUT FORMAT: a JSON array of strings, each one verifiable step, e.g. ["run ./test.sh and confirm the chat tests pass", "open mycobeta in a browser and confirm the new tabs render"]. ' +
      'NO prose, NO markdown, NO code fences. Empty array [] if there is nothing to verify.',
  },
};

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function getTranscriptPath(rec) {
  if (!rec || !rec.absCwd || !rec.claudeSessionId) return null;
  return path.join(projectsDir(), encodeCwdForClaude(rec.absCwd), `${rec.claudeSessionId}.jsonl`);
}

// Read the JSONL tail and project it down to "user: …" / "assistant: …" lines
// so the model has a cleaner, smaller input than the raw JSON. We cap at
// MAX_TRANSCRIPT_CHARS so a long session doesn't blow our token budget.
async function readTranscriptTail(rec) {
  const p = getTranscriptPath(rec);
  if (!p) return null;
  let raw;
  try { raw = await fsp.readFile(p, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) return null;

  const turns = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - MAX_INPUT_LINES); i--) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg) continue;
    const c = msg.content;
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      const t = c.find((x) => x && x.type === 'text' && x.text && x.text.trim());
      if (t) text = t.text;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text || text.startsWith('<')) continue;
    const line = `${obj.type}: ${text.slice(0, 800)}`;
    if (chars + line.length > MAX_TRANSCRIPT_CHARS) break;
    chars += line.length + 1;
    turns.push(line);
  }
  if (!turns.length) return null;
  return turns.reverse().join('\n');
}

// Read the discussion-panel chat from sessions.json. This is the source the
// transcript can't see: messages without an @myco prefix never reach the
// running Claude session, so they only exist in rec.chat.
function readChatTail(rec) {
  if (!rec || !rec.id) return null;
  const msgs = getChatHistory(rec.id) || [];
  if (!msgs.length) return null;
  const lines = [];
  let chars = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const txt = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (!txt) continue;
    const line = `${m.user || '?'}: ${txt.slice(0, 800)}`;
    if (chars + line.length > MAX_CHAT_CHARS) break;
    chars += line.length + 1;
    lines.unshift(line);
  }
  return lines.length ? lines.join('\n') : null;
}

// Strip code fences the model may have added despite the prompt asking it
// not to, then parse as JSON. Returns [] on any failure — extraction is
// best-effort, we never throw.
function parseStringArray(text) {
  if (!text) return [];
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let arr;
  try { arr = JSON.parse(cleaned); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().slice(0, 500));
}

function buildItems(strings) {
  const now = new Date().toISOString();
  // voters: array of usernames who've upvoted this item (toggle-on-click in
  // the UI so re-clicks de-vote). comments: flat thread of {id, user, text, ts}
  // entries. Both empty at extraction time; they accrue as session
  // participants engage with each todo.
  return strings.map((s) => ({
    id: newId(),
    text: s,
    done: false,
    addedAt: now,
    voters: [],
    comments: [],
  }));
}

async function extractArtifact(rec, type) {
  if (!PROMPTS[type]) throw new Error(`unknown artifact type: ${type}`);
  const sid = rec && rec.id ? rec.id : '?';

  const transcriptTail = await readTranscriptTail(rec);
  const chatTail = readChatTail(rec);
  if (!transcriptTail && !chatTail) {
    console.log(`[extractor] ${sid} type=${type} → no transcript or chat to extract from (cwd=${rec.absCwd} claudeSessionId=${rec.claudeSessionId})`);
    return type === 'arch'
      ? { markdown: '', updatedAt: new Date().toISOString(), note: 'no transcript or chat available' }
      : { items: [], updatedAt: new Date().toISOString(), note: 'no transcript or chat available' };
  }

  // Build the combined input. Label each source explicitly so the model
  // knows what it's looking at (and so the prompts' "two sources" framing
  // matches reality).
  const parts = [];
  if (chatTail) {
    parts.push('=== Discussion-panel chat (human messages, including ones NOT sent to Claude via @myco) ===\n' + chatTail);
  }
  if (transcriptTail) {
    parts.push('=== Claude Code session transcript (assistant + user turns the model saw) ===\n' + transcriptTail);
  }
  const combinedInput = parts.join('\n\n');

  console.log(`[extractor] ${sid} type=${type} input=${combinedInput.length}ch (transcript=${transcriptTail ? transcriptTail.length : 0}, chat=${chatTail ? chatTail.length : 0}) → invoking claude CLI…`);
  const t0 = Date.now();
  const text = await callClaudeCli({
    system: PROMPTS[type].system,
    userMessage: combinedInput,
    cwd: rec.absCwd,
    timeoutMs: EXTRACTOR_TIMEOUT_MS,
  });
  const elapsed = Date.now() - t0;
  if (text === null) {
    console.log(`[extractor] ${sid} type=${type} → CLI returned null in ${elapsed}ms`);
    return type === 'arch'
      ? { markdown: '', updatedAt: new Date().toISOString(), note: 'extraction call failed (claude CLI errored or missing — check server logs)' }
      : { items: [], updatedAt: new Date().toISOString(), note: 'extraction call failed (claude CLI errored or missing — check server logs)' };
  }
  console.log(`[extractor] ${sid} type=${type} → CLI returned ${text.length}ch in ${elapsed}ms; head=${JSON.stringify(text.slice(0, 200))}`);
  if (type === 'arch') {
    return { markdown: text.trim(), updatedAt: new Date().toISOString() };
  }
  const parsed = parseStringArray(text);
  console.log(`[extractor] ${sid} type=${type} → parsed ${parsed.length} item(s)`);
  return { items: buildItems(parsed), updatedAt: new Date().toISOString() };
}

module.exports = { extractArtifact, PROMPTS, readTranscriptTail, parseStringArray };
