// Transcript reading, parsing, and watching for the viewer conversation view.
// The Claude JSONL transcript is the source of truth for what Claude has said/done.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sessionsMod = require('./sessions');

function resolveTranscriptPath(sessionId) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (!rec || !rec.absCwd) return null;
  const dir = path.join(sessionsMod.projectsDir(), sessionsMod.encodeCwdForClaude(rec.absCwd));

  // Prefer the specific resumable session's jsonl; fall back to the newest in
  // the project dir when there's no cached claudeSessionId yet.
  if (rec.claudeSessionId) {
    const specific = findNewestJsonl(path.join(dir, rec.claudeSessionId));
    if (specific) return specific;
  }
  return findNewestJsonl(dir);
}

// Walk `dir` recursively and return the full path of the .jsonl with the
// largest mtime, or null if none exist / the dir is missing.
//
// Skips the `subagents/` directory and rejects any .jsonl whose basename
// isn't a canonical UUID. Task-tool subagent transcripts (`agent-*.jsonl`
// under `subagents/`) are NOT resumable claude session ids and would
// surface as junk in the transcript viewer if they leaked through.
function findNewestJsonl(dir) {
  if (!fs.existsSync(dir)) return null;
  let best = null;
  let bestMtime = 0;
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'subagents') continue;
        walk(full);
        continue;
      }
      if (!e.name.endsWith('.jsonl')) continue;
      const base = e.name.replace(/\.jsonl$/, '');
      if (!sessionsMod.isClaudeSessionId(base)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs > bestMtime) { best = full; bestMtime = st.mtimeMs; }
    }
  })(dir);
  return best;
}

function summarizeToolInput(name, input) {
  if (name === 'Bash') return (input.command || '').substring(0, 200);
  if (name === 'Read' || name === 'Edit' || name === 'Write') return input.file_path || '';
  if (name === 'Agent') return input.description || '';
  try { return JSON.stringify(input).substring(0, 150); } catch { return ''; }
}

function parseLine(line) {
  if (!line || !line.trim()) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }

  const uuid = obj.uuid || '';
  const ts = obj.timestamp || '';

  // ai-title
  if (obj.type === 'ai-title' && obj.aiTitle) {
    return { role: 'title', text: obj.aiTitle, uuid, ts };
  }

  // user message
  if (obj.type === 'user') {
    // Skip internal commands (/<command>)
    if (obj.isMeta) return null;
    const msg = obj.message;
    if (!msg) return null;
    const content = msg.content;

    // Tool results
    if (Array.isArray(content)) {
      const results = content
        .filter((b) => b && b.type === 'tool_result')
        .map((b) => {
          let text = '';
          if (typeof b.content === 'string') text = b.content;
          else if (Array.isArray(b.content)) {
            text = b.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
          }
          return { toolUseId: b.tool_use_id, content: text.substring(0, 5000), isError: !!b.is_error };
        });
      if (results.length) {
        return { role: 'tool_result', results, uuid, ts };
      }
    }

    // Plain text user message.
    //
    // Strip leading/trailing whitespace. Claude Code's input editor has a
    // multi-row layout (a `>` prompt header + the actual input area below),
    // and when a message is submitted via bracketed-paste the recorded text
    // sometimes starts with a literal "\n" (the layout's empty header row).
    // Rendering that verbatim makes the readonly viewer's transcript look
    // like a blank line follows the "❯ " CSS prefix. Trimming gives a
    // clean "❯ message text" presentation.
    if (typeof content === 'string') {
      if (content.startsWith('<')) return null; // internal scaffolding
      return { role: 'user', text: content.trim(), uuid, ts };
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((b) => b && b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (text && !text.startsWith('<')) {
        return { role: 'user', text, uuid, ts };
      }
    }
    return null;
  }

  // assistant message
  if (obj.type === 'assistant') {
    const msg = obj.message;
    if (!msg) return null;
    const content = msg.content;
    if (!Array.isArray(content)) return null;

    const textBlocks = content.filter((b) => b && b.type === 'text' && b.text);
    const toolBlocks = content.filter((b) => b && b.type === 'tool_use');

    // Same trim as the user branch — strip leading/trailing whitespace so
    // the transcript pane renders cleanly without a leading blank line.
    const text = textBlocks.map((b) => b.text).join('\n').trim();
    const toolCalls = toolBlocks.map((b) => ({
      name: b.name,
      id: b.id,
      summary: summarizeToolInput(b.name, b.input || {}),
    }));

    if (!text && !toolCalls.length) return null;
    return { role: 'assistant', text, toolCalls, uuid, ts };
  }

  return null;
}

async function readNewMessages(jsonlPath, fromByte) {
  try {
    const stat = await fsp.stat(jsonlPath);
    if (stat.size <= fromByte) return { messages: [], bytesRead: fromByte };

    const stream = fs.createReadStream(jsonlPath, { start: fromByte });
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    const raw = Buffer.concat(chunks).toString('utf8');
    const lines = raw.split('\n');
    // Last element may be a partial line — don't parse it
    const completeLines = lines.slice(0, -1);
    const partialLen = lines[lines.length - 1].length;

    const messages = [];
    for (const line of completeLines) {
      const m = parseLine(line);
      if (m) messages.push(m);
    }

    const bytesRead = fromByte + Buffer.byteLength(raw, 'utf8') - partialLen;
    return { messages, bytesRead };
  } catch {
    return { messages: [], bytesRead: fromByte };
  }
}

// Lightweight projection of a JSONL file into ordered { role, text } items
// where role is 'user' or 'assistant' and text is whitespace-collapsed plain
// text. Returned oldest-first. Skips tool-result / scaffolding entries and
// caps the lookback at `maxLines` (counted from the tail, not from the head).
// Used by extractor.js + summarizer.js to feed model prompts; the heavier
// parseLine above is for the read-only viewer's full message structure.
async function readSimpleTurnsTail(jsonlPath, { maxLines = 300 } = {}) {
  let raw;
  try { raw = await fsp.readFile(jsonlPath, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - maxLines); i--) {
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
    out.push({ role: obj.type, text });
  }
  return out.reverse();
}

// watchTranscript(jsonlPath, onNewMessages, opts?)
// opts.startByte — byte offset to start watching from. Pass the bytesRead
// value from a prior readNewMessages call so the watcher doesn't re-replay
// content the caller has already consumed. Defaults to 0 (read whole file
// on attach), but EVERY current caller does its own initial read first, so
// they MUST pass startByte to avoid double-firing messages on attach.
// Bug history: omitting startByte caused every message to render twice in
// the readonly view after the streamTranscriptToWs refactor — owner-attach
// did its own readNewMessages then called watchTranscript, and the
// watcher's internal "initial read from 0" fired onNewMessages with the
// full history a second time.
function watchTranscript(jsonlPath, onNewMessages, opts = {}) {
  let byteOffset = Number.isFinite(opts.startByte) ? opts.startByte : 0;
  let debounceTimer = null;
  let pollTimer = null;
  let watcher = null;
  let stopped = false;

  const dir = path.dirname(jsonlPath);
  const basename = path.basename(jsonlPath);

  function tick() {
    if (stopped) return;
    debounceTimer = null;
    // Re-resolve in case the file rotated
    const currentPath = resolveTranscriptPath(
      // Extract sessionId from the path... but we don't have it here.
      // Instead, just check if the watched file still exists and read from it.
      null
    );
    readNewMessages(jsonlPath, byteOffset).then(({ messages, bytesRead }) => {
      byteOffset = bytesRead;
      if (messages.length) onNewMessages(messages);
    }).catch(() => {});
  }

  function scheduleTick() {
    if (debounceTimer || stopped) return;
    debounceTimer = setTimeout(tick, 300);
  }

  function startWatching() {
    if (stopped) return;
    try {
      watcher = fs.watch(dir, (eventType, filename) => {
        if (filename && filename.endsWith('.jsonl')) scheduleTick();
      });
      watcher.on('error', () => {});
    } catch {
      // Directory doesn't exist yet — fall back to polling
      pollTimer = setInterval(() => {
        if (stopped) return;
        try {
          fs.statSync(jsonlPath);
          clearInterval(pollTimer);
          pollTimer = null;
          startWatching();
          tick();
        } catch {}
      }, 2000);
    }
  }

  // Initial read — only when caller didn't pass a startByte (legacy
  // behaviour preserved for backwards compat).
  if (!Number.isFinite(opts.startByte)) {
    (async () => {
      const { messages, bytesRead } = await readNewMessages(jsonlPath, 0);
      byteOffset = bytesRead;
      if (messages.length) onNewMessages(messages);
    })();
  }

  startWatching();

  return function unsubscribe() {
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (watcher) watcher.close();
  };
}

module.exports = { resolveTranscriptPath, readNewMessages, watchTranscript, readSimpleTurnsTail };
