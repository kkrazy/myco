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
const { projectsDir, encodeCwdForClaude } = require('./sessions');

const MAX_INPUT_CHARS = 16000;     // ~ recent 40-80 turns
const MAX_INPUT_LINES = 400;
const EXTRACTOR_TIMEOUT_MS = 120000;

const PROMPTS = {
  plan: {
    system:
      'You are reading the tail of a Claude Code session transcript. Extract concrete TODO items that are still pending — actions that the user or Claude proposed but have not yet been completed. ' +
      'OUTPUT FORMAT: a JSON array of strings, each a single short actionable todo, e.g. ["wire the Plan tab to the new endpoint", "add a regression test for the multi-line regex"]. ' +
      'NO prose, NO markdown, NO code fences. If there is nothing meaningful, output the empty array [].',
  },
  arch: {
    system:
      'You are reading the tail of a Claude Code session transcript. Summarize any architectural decisions, design constraints, conventions, or guidelines that emerged during the session — things a teammate would want to know to keep working on this codebase consistently. ' +
      'OUTPUT FORMAT: concise GitHub-flavored markdown. Use bullets or short headings; keep it under ~200 words. If nothing notable came up, output exactly the single line: _(no architectural decisions in recent activity)_.',
  },
  test: {
    system:
      'You are reading the tail of a Claude Code session transcript. Extract verification steps — concrete checks a human could run or perform to confirm the recent work behaves correctly. ' +
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
// MAX_INPUT_CHARS so a long session doesn't blow our token budget.
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
    if (chars + line.length > MAX_INPUT_CHARS) break;
    chars += line.length + 1;
    turns.push(line);
  }
  if (!turns.length) return null;
  return turns.reverse().join('\n');
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
  return strings.map((s) => ({ id: newId(), text: s, done: false, addedAt: now }));
}

async function extractArtifact(rec, type) {
  if (!PROMPTS[type]) throw new Error(`unknown artifact type: ${type}`);
  const sid = rec && rec.id ? rec.id : '?';
  const tail = await readTranscriptTail(rec);
  if (!tail) {
    console.log(`[extractor] ${sid} type=${type} → no transcript (cwd=${rec.absCwd} claudeSessionId=${rec.claudeSessionId})`);
    return type === 'arch'
      ? { markdown: '', updatedAt: new Date().toISOString(), note: 'no transcript available' }
      : { items: [], updatedAt: new Date().toISOString(), note: 'no transcript available' };
  }
  console.log(`[extractor] ${sid} type=${type} tail=${tail.length}ch → invoking claude CLI…`);
  const t0 = Date.now();
  const text = await callClaudeCli({
    system: PROMPTS[type].system,
    userMessage: tail,
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
