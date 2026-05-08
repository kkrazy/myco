// Transcript reading, parsing, and watching for the viewer conversation view.
// The Claude JSONL transcript is the source of truth for what Claude has said/done.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const sessionsMod = require('./sessions');

function resolveTranscriptPath(sessionId) {
  const rec = sessionsMod.getSessionRecord(sessionId);
  if (!rec || !rec.absCwd) return null;
  const absCwd = rec.absCwd;
  const dir = path.join(sessionsMod.projectsDir(), sessionsMod.encodeCwdForClaude(absCwd));

  // If we have a cached claudeSessionId, find that specific transcript
  if (rec.claudeSessionId) {
    const specific = findTranscriptForSession(dir, rec.claudeSessionId);
    if (specific) return specific;
  }

  // Fall back to newest
  return findNewestTranscript(dir);
}

function findTranscriptForSession(dir, claudeSessionId) {
  const sessionDir = path.join(dir, claudeSessionId);
  if (!fs.existsSync(sessionDir)) return null;
  let best = null;
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = full;
    }
  }
  walk(sessionDir);
  return best;
}

function findNewestTranscript(dir) {
  let best = null;
  let bestMtime = 0;
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs > bestMtime) { best = full; bestMtime = st.mtimeMs; }
    }
  }
  walk(dir);
  return best;
}

function summarizeToolInput(name, input) {
  if (name === 'Bash') return (input.command || '').substring(0, 200);
  if (name === 'Read' || name === 'Edit' || name === 'Write') return input.file_path || '';
  if (name === 'Agent') return input.description || '';
  try { return JSON.stringify(input).substring(0, 150); } catch { return ''; }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = content
    .filter((b) => b && b.type === 'text' && b.text)
    .map((b) => b.text);
  return texts.join('\n');
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

    // Plain text user message
    if (typeof content === 'string') {
      if (content.startsWith('<')) return null; // internal scaffolding
      return { role: 'user', text: content, uuid, ts };
    }
    if (Array.isArray(content)) {
      const text = content
        .filter((b) => b && b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n');
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

    const text = textBlocks.map((b) => b.text).join('\n');
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

function watchTranscript(jsonlPath, onNewMessages) {
  let byteOffset = 0;
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

  // Initial read
  (async () => {
    const { messages, bytesRead } = await readNewMessages(jsonlPath, 0);
    byteOffset = bytesRead;
    if (messages.length) onNewMessages(messages);
  })();

  startWatching();

  return function unsubscribe() {
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (watcher) watcher.close();
  };
}

module.exports = {
  resolveTranscriptPath,
  parseLine,
  readNewMessages,
  watchTranscript,
};
