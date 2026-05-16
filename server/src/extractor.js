// Extracts Plan / Arch / Test artifacts from a Claude Code session's JSONL
// transcript via the Anthropic API. Surfaced through the discussion-pane
// tabs as on-demand "Refresh" actions.
//
// Plan and Test are JSON arrays of todo strings (turned into checkbox items
// on the client). Arch is freeform markdown. Each extractor is one API call
// to Haiku 4.5 with a transcript tail in the user message.

const path = require('path');
const crypto = require('crypto');

const { callClaudeCli } = require('./claude-cli');
const { projectsDir, encodeCwdForClaude, getChatHistory } = require('./sessions');
const { readSimpleTurnsTail } = require('./transcript');

const MAX_TRANSCRIPT_CHARS = 16000;   // ~ recent 40-80 assistant/user turns
const MAX_CHAT_CHARS = 8000;          // discussion-panel messages
const MAX_INPUT_LINES = 400;
// Extraction calls `claude -p` in the session's cwd, and the prompts now ask
// the model to spot-check the codebase via Read/Glob/Grep before answering.
// That expands the per-refresh time budget — bump from the old 120s ceiling
// to 4 minutes. Most extractions still complete in well under a minute.
const EXTRACTOR_TIMEOUT_MS = 240000;

// All three prompts pull from three sources:
//   (a) the Claude Code transcript (what the model saw and did)
//   (b) the Mycelium discussion-panel chat (user-to-user notes that may
//       or may not have been forwarded to Claude as a user turn — chat
//       messages reach Claude automatically now, but pure human-to-
//       human discussion still lives only in rec.chat)
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
      'You are running in the project\'s working directory with file-system tools (Read, Glob, Grep) available. You will be given two sources from a software-engineering session: the running Claude Code transcript AND the Mycelium discussion-panel chat (which carries human-to-human messages alongside chat turns Claude already saw). ' +
      'Extract concrete TODO items that are still PENDING and group them into named buckets. ' +
      'CHOOSE THE GROUPING THAT FITS THIS CODEBASE: ' +
      '(a) If the project has a clear tiered architecture (web app, API service, etc.), group by ARCHITECTURAL LAYER — e.g. "Frontend / Backend / Database", "API / Service / Persistence", "Client / Server / PTY". Order layers top-down (presentation first, infra last). ' +
      '(b) If a layered model doesn\'t fit (CLI tool, library, monorepo of components, mostly-flat codebase), group by COMPONENT / MODULE / FEATURE instead — e.g. "Auth / Sessions / Chat / Transcript" or "Parser / Renderer / CLI". Pick names that match real directories or feature areas in the code. ' +
      'Either way: spot-check the codebase to pick names that mirror what\'s actually there, and keep names short (≤2 words) and consistent across items. ' +
      'A "pending" TODO is one the user, a chat participant, or Claude proposed but has not yet been completed. ' +
      'BEFORE answering, spot-check that proposed changes aren\'t already in the code. Drop ones that are. Don\'t over-explore — a few targeted Read/Grep calls is enough. ' +
      'Pure-discussion intent still counts as a real plan item if it isn\'t reflected in the code yet. ' +
      'OUTPUT FORMAT: a JSON array of objects, each `{ "layer": "<group name>", "text": "<short actionable todo>" }`. The field is called "layer" for historical reasons — its value is the group name you chose (layer OR component). Example for a web app: ' +
      '[{"layer":"Frontend","text":"wire the Plan tab to the new endpoint"},{"layer":"Backend","text":"add /artifact/vote route"}]. Example for a CLI app: ' +
      '[{"layer":"Parser","text":"accept bracketed [N] markers"},{"layer":"Renderer","text":"trim mermaid error divs"}]. ' +
      'NO prose, NO markdown, NO code fences around the JSON. If nothing remains pending, output the empty array [].',
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

// Read the JSONL tail as "user: …" / "assistant: …" lines for the prompt
// (transcript.readSimpleTurnsTail handles the JSON projection). Per-line
// text is capped at 800 chars and the total at MAX_TRANSCRIPT_CHARS so a
// long session doesn't blow our token budget.
async function readTranscriptTail(rec) {
  const p = getTranscriptPath(rec);
  if (!p) return null;
  const turns = await readSimpleTurnsTail(p, { maxLines: MAX_INPUT_LINES });
  if (!turns.length) return null;
  const out = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = `${turns[i].role}: ${turns[i].text.slice(0, 800)}`;
    if (chars + line.length > MAX_TRANSCRIPT_CHARS) break;
    chars += line.length + 1;
    out.push(line);
  }
  return out.length ? out.reverse().join('\n') : null;
}

// Read the discussion-panel chat from sessions.json. Complements the
// transcript: discussion notes that didn't reach the running Claude
// session as a user turn (e.g. @user mentions, plan-vote chatter,
// quick coordination between collaborators) live only in rec.chat.
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
// not to, then parse as JSON. Shared by parseStringArray + parsePlanItems.
function _parseFencedJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

// Legacy + Test-tab parser. Returns [string, …]. Best-effort, never throws.
function parseStringArray(text) {
  const arr = _parseFencedJson(text);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.trim().slice(0, 500));
}

// Plan-tab parser. Accepts a layered shape and falls back gracefully for
// model variations:
//   ["string", "string"]                          → layer = "Other"
//   [{ "layer": "Frontend", "text": "string" }]   → current preferred shape
//   [{ "text": "string" }]                        → layer = "Other"
// Anything else in the array is dropped silently.
function parsePlanItems(text) {
  const arr = _parseFencedJson(text);
  if (!Array.isArray(arr)) return [];
  return arr.map((entry) => {
    if (typeof entry === 'string' && entry.trim()) {
      return { text: entry.trim().slice(0, 500), layer: 'Other' };
    }
    if (entry && typeof entry === 'object' && typeof entry.text === 'string' && entry.text.trim()) {
      const layer = typeof entry.layer === 'string' && entry.layer.trim()
        ? entry.layer.trim().slice(0, 40)
        : 'Other';
      return { text: entry.text.trim().slice(0, 500), layer };
    }
    return null;
  }).filter(Boolean);
}

function buildItems(entries) {
  const now = new Date().toISOString();
  // entries: string[] OR [{text, layer}, …]. We normalize either form here
  // so callers (plan vs test) can stay simple.
  // voters/comments empty at extraction time; they accrue as participants
  // engage with the item.
  return entries.map((e) => {
    const text = typeof e === 'string' ? e : (e && e.text) || '';
    const layer = (e && typeof e === 'object' && typeof e.layer === 'string' && e.layer.trim())
      ? e.layer.trim()
      : 'Other';
    return {
      id: newId(),
      text,
      layer,
      done: false,
      addedAt: now,
      voters: [],
      comments: [],
    };
  });
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
    parts.push('=== Discussion-panel chat (human-to-human messages alongside chat turns Claude saw) ===\n' + chatTail);
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
  const parsed = type === 'plan' ? parsePlanItems(text) : parseStringArray(text);
  console.log(`[extractor] ${sid} type=${type} → parsed ${parsed.length} item(s)`);
  return { items: buildItems(parsed), updatedAt: new Date().toISOString() };
}

// PROMPTS + readTranscriptTail are internal; parseStringArray + parsePlanItems
// are exported only for the regression tests in test.sh.
module.exports = { extractArtifact, parseStringArray, parsePlanItems };
