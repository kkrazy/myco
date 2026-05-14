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

  // Source-of-truth: claude code's own per-process tracker
  // (~/.claude/sessions/<pid>.json) for an actively-running claude in
  // this cwd. This catches the case where claude was spawned with
  // --resume <A>, then the user hit /resume in claude's TUI and
  // re-execed into session <B> — captureClaudeSessionId only runs at
  // mycod-spawn time, so rec.claudeSessionId stays stuck at <A> even
  // though claude is now writing to <B>.jsonl. The active tracker
  // gives us <B> directly. See sessions.readActiveClaudeSessionForCwd.
  const liveId = sessionsMod.readActiveClaudeSessionForCwd(rec.absCwd);
  if (liveId) {
    const liveFile = path.join(dir, liveId + '.jsonl');
    if (fs.existsSync(liveFile)) return liveFile;
    // Some claude variants nest the jsonl under <id>/. Try that too.
    const nested = findNewestJsonl(path.join(dir, liveId));
    if (nested) return nested;
  }

  // No live process — fall through to the polled value, then to the
  // "newest jsonl in the project dir" heuristic.
  if (rec.claudeSessionId) {
    const specific = findNewestJsonl(path.join(dir, rec.claudeSessionId));
    if (specific) return specific;
    const direct = path.join(dir, rec.claudeSessionId + '.jsonl');
    if (fs.existsSync(direct)) return direct;
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
  // AskUserQuestion's input shape:
  //   { questions: [{ question, header, multiSelect, options: [{label, description}, …] }, …] }
  // Without a custom summarizer this collapses to ~150 chars of escaped
  // JSON braces in the readonly viewer's tool callout — unreadable for
  // multi-question turns. Render each question + options as plain text
  // (newlines preserved by .conv-tool-body { white-space: pre-wrap }).
  // We DON'T lift this into the assistant.text field the way ExitPlanMode
  // does — claude code's TUI surfaces AskUserQuestion as an interactive
  // wizard whose menu broadcasts already land in chat via the menu
  // interceptor; mirroring the question into chat too would double-post.
  if (name === 'AskUserQuestion') {
    const qs = Array.isArray(input.questions) ? input.questions : [];
    if (!qs.length) return '(no questions)';
    return qs.map((q, i) => {
      const opts = Array.isArray(q.options) ? q.options : [];
      const optsTxt = opts.map((o) => `  • ${o.label || ''}${o.description ? ' — ' + o.description : ''}`).join('\n');
      const header = q.question || q.header || `Q${i + 1}`;
      return `Q${i + 1}: ${header}${optsTxt ? '\n' + optsTxt : ''}`;
    }).join('\n\n').substring(0, 4000);
  }
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
    // ExitPlanMode is special: claude's plan markdown rides inside the
    // tool_use's `input.plan` instead of a text block. If we route it
    // through the regular toolCall path, the readonly viewer shows a
    // truncated JSON summary and the chat-pane mirror skips the turn
    // entirely (its persist gate ignores assistant messages whose text
    // is empty). Pull plan-mode tool_uses out and treat their plan body
    // as if it were a text block — both surfaces then render the plan
    // as markdown, and the chat pane gets the row via the standard
    // assistant-text persistence path.
    const planBlocks = content.filter(
      (b) => b && b.type === 'tool_use' && b.name === 'ExitPlanMode' && b.input && typeof b.input.plan === 'string' && b.input.plan.trim()
    );
    const toolBlocks = content.filter(
      (b) => b && b.type === 'tool_use' && !(b.name === 'ExitPlanMode' && b.input && typeof b.input.plan === 'string')
    );
    // Thinking blocks are claude's chain-of-thought reasoning. The
    // `.thinking` field carries the visible text on newer models;
    // older models redact it (encrypted blob in `.signature`, empty
    // `.thinking`), in which case we skip silently — there's nothing
    // to render. 2,176 occurrences across local sessions today;
    // until this branch they fell through the content filter and the
    // readonly viewer never saw them. Surfaced as a separate field
    // on the assistant frame so client renderers can fold them into
    // a `<details>` callout.
    const thinkingTexts = content
      .filter((b) => b && b.type === 'thinking' && b.thinking && b.thinking.trim())
      .map((b) => b.thinking);

    // Same trim as the user branch — strip leading/trailing whitespace so
    // the transcript pane renders cleanly without a leading blank line.
    // Plan markdown comes FIRST (it's the headline content of the turn);
    // any narration text follows. Most ExitPlanMode turns have no text
    // alongside the plan, but we keep the join robust for the edge.
    const planText = planBlocks.map((b) => b.input.plan.trim()).filter(Boolean).join('\n\n');
    const narrationText = textBlocks.map((b) => b.text).join('\n').trim();
    const text = [planText, narrationText].filter(Boolean).join('\n\n');
    const toolCalls = toolBlocks.map((b) => ({
      name: b.name,
      id: b.id,
      summary: summarizeToolInput(b.name, b.input || {}),
    }));

    if (!text && !toolCalls.length && !thinkingTexts.length) return null;
    const frame = { role: 'assistant', text, toolCalls, uuid, ts };
    if (thinkingTexts.length) frame.thinking = thinkingTexts;
    return frame;
  }

  // Attachment-typed records — claude code stores mode transitions,
  // command-permission changes, and queued slash-command state under
  // `obj.type === 'attachment'` with `obj.attachment.type` carrying the
  // actual kind. These are silently dropped by older parser versions;
  // surfacing them lets the viewer render boundary pills (entered plan
  // mode / entered auto mode), permission-change notes, and queued
  // prompts. Skip subAgent reminders — those are recursive context
  // claude posts to itself, not user-relevant.
  if (obj.type === 'attachment' && obj.attachment && typeof obj.attachment === 'object') {
    const att = obj.attachment;
    const kind = att.type || '';
    if (att.isSubAgent) return null;
    switch (kind) {
      case 'plan_mode':
        return { role: 'plan_mode', state: 'entered', text: att.planFilePath || '', uuid, ts };
      case 'plan_mode_exit':
        return { role: 'plan_mode', state: 'exited', text: att.planFilePath || '', uuid, ts };
      case 'plan_mode_reentry':
        return { role: 'plan_mode', state: 'reentered', text: att.planFilePath || '', uuid, ts };
      case 'auto_mode':
        return { role: 'auto_mode', state: 'entered', uuid, ts };
      case 'auto_mode_exit':
        return { role: 'auto_mode', state: 'exited', uuid, ts };
      case 'command_permissions':
        // allowedTools is an array of tool-spec strings ("Bash(npm test)",
        // "Read", etc.). Empty array means "reset to defaults" — claude
        // emits this on /permission reset. Render the count + a short
        // summary; full list is in the JSONL for anyone who wants it.
        return {
          role: 'permission_change',
          tools: Array.isArray(att.allowedTools) ? att.allowedTools : [],
          uuid, ts,
        };
      case 'queued_command':
        return { role: 'queued', text: att.prompt || '', mode: att.commandMode || '', uuid, ts };
      default:
        return null; // unknown attachment kind — passive metadata, skip
    }
  }

  // System-typed records — claude code writes API errors, auth failures,
  // and other framework-level diagnostics here. Shape: `{type:'system',
  // subtype:'api_error'|..., level:'error'|'warn', error:{status, message,
  // ...}}`. Surface anything tagged level=error so failed turns don't
  // disappear from the readonly viewer's transcript.
  if (obj.type === 'system' && obj.level === 'error') {
    const e = obj.error || {};
    let text = '';
    if (typeof e === 'string') text = e;
    else if (e && typeof e === 'object') {
      // Prefer human message; fall back to status + a short stringify
      // (capped so a stack-trace blob doesn't dump into the transcript).
      text = e.message || (e.status ? `HTTP ${e.status}` : '');
      if (!text) { try { text = JSON.stringify(e).slice(0, 200); } catch {} }
    }
    return { role: 'error', kind: obj.subtype || 'system', text, uuid, ts };
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
  let dirWaitPollTimer = null;    // fallback when the project dir doesn't exist yet
  let safetyPollTimer = null;     // belt-and-braces poll alongside fs.watch
  let watcher = null;
  let stopped = false;

  const dir = path.dirname(jsonlPath);

  function tick() {
    if (stopped) return;
    debounceTimer = null;
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
      // Directory doesn't exist yet — wait for it to appear, then retry.
      dirWaitPollTimer = setInterval(() => {
        if (stopped) return;
        try {
          fs.statSync(jsonlPath);
          clearInterval(dirWaitPollTimer);
          dirWaitPollTimer = null;
          startWatching();
          tick();
        } catch {}
      }, 2000);
      return;
    }
    // Belt-and-braces safety poll. fs.watch is notoriously unreliable
    // on overlay / bind-mount / network filesystems — events can be
    // coalesced, the watcher can silently go deaf, and on some Docker
    // configurations inotify never fires for files written by another
    // process holding an open fd. Symptom: the readonly viewer freezes
    // mid-stream and only a page refresh recovers (re-runs the init
    // read from byte 0). A periodic stat+tail-read guarantees forward
    // progress regardless of fs.watch's mood. Cheap: ~1ms per tick.
    safetyPollTimer = setInterval(() => {
      if (!stopped) scheduleTick();
    }, 4000);
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
    if (dirWaitPollTimer) clearInterval(dirWaitPollTimer);
    if (safetyPollTimer) clearInterval(safetyPollTimer);
    if (watcher) watcher.close();
  };
}

module.exports = { resolveTranscriptPath, readNewMessages, watchTranscript, readSimpleTurnsTail, parseLine };
