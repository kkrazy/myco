const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { loadStore, saveStore, projectsDir, encodeCwdForClaude } = require('./sessions');
const { callAnthropic } = require('./anthropic');

const DEBOUNCE_MS = 30000;
const MAX_INPUT_TURNS = 20;

const SYSTEM_PROMPT =
  'Summarize this Claude Code session in 1-2 sentences, max 80 characters. ' +
  'Be specific about files, features, or bugs. Present tense. ' +
  'Do not start with "The user" or "Claude".';

// ─── Transcript reader ───────────────────────────────────────────────────────

async function extractRecentTurns(jsonlPath) {
  let raw;
  try { raw = await fsp.readFile(jsonlPath, 'utf8'); } catch { return null; }
  const lines = raw.split('\n').filter(Boolean);
  if (lines.length < 4) return null;

  const turns = [];
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 300); i--) {
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
    turns.push(`${obj.type}: ${text}`);
    if (turns.length >= MAX_INPUT_TURNS) break;
  }
  if (!turns.length) return null;
  return turns.reverse().join('\n');
}

// ─── Summary watcher ─────────────────────────────────────────────────────────

const timers = new Map();
const watchers = [];

function getTranscriptPath(absCwd, claudeSessionId) {
  if (!claudeSessionId) return null;
  return path.join(projectsDir(), encodeCwdForClaude(absCwd), `${claudeSessionId}.jsonl`);
}

function getDirPath(absCwd) {
  return path.join(projectsDir(), encodeCwdForClaude(absCwd));
}

async function generateAndStore(sessionId, rec) {
  const transcriptPath = getTranscriptPath(rec.absCwd, rec.claudeSessionId);
  if (!transcriptPath) return;

  let stat;
  try { stat = await fsp.stat(transcriptPath); } catch { return; }

  if (rec.summaryGeneratedAt) {
    const generatedAt = new Date(rec.summaryGeneratedAt).getTime();
    if (stat.mtimeMs <= generatedAt) return;
  }

  const excerpt = await extractRecentTurns(transcriptPath);
  if (!excerpt) return;

  const summary = await callAnthropic({
    system: SYSTEM_PROMPT,
    userMessage: excerpt,
    maxTokens: 60,
    timeoutMs: 10000,
  });
  if (!summary) return;

  const store = loadStore();
  if (store.sessions[sessionId]) {
    store.sessions[sessionId].aiSummary = summary;
    store.sessions[sessionId].summaryGeneratedAt = new Date().toISOString();
    saveStore();
    console.log(`[summarizer] updated summary for ${sessionId}: ${summary}`);
  }
}

function scheduleRefresh(sessionId) {
  if (timers.has(sessionId)) return;
  timers.set(sessionId, setTimeout(async () => {
    timers.delete(sessionId);
    const store = loadStore();
    const rec = store.sessions[sessionId];
    if (!rec) return;
    try { await generateAndStore(sessionId, rec); } catch (err) {
      console.error(`[summarizer] failed for ${sessionId}:`, err.message);
    }
  }, DEBOUNCE_MS));
}

function startSummaryWatcher() {
  if (!process.env.ANTHROPIC_API_KEY) return;

  const store = loadStore();
  for (const [sid, rec] of Object.entries(store.sessions)) {
    if (!rec.claudeSessionId) continue;

    const dirPath = getDirPath(rec.absCwd);
    try {
      if (!fs.existsSync(dirPath)) continue;
      const watcher = fs.watch(dirPath, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        scheduleRefresh(sid);
      });
      watchers.push(watcher);
    } catch {}

    // Initial summary for sessions that lack one
    if (!rec.aiSummary) scheduleRefresh(sid);
  }

  console.log(`[summarizer] watching ${watchers.length} transcript dirs`);
}

module.exports = { startSummaryWatcher };
