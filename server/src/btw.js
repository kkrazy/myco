// Chat-assistant helper. Claude is a participant in the discussion pane:
// messages starting with `/btw` are forwarded to a fresh `claude -p` run
// in the session's cwd. (Messages starting with `@myco …` go a different
// route — they're injected into the running Claude PTY by handleChatMessage
// in pty.js, not into a fresh subprocess.) The subprocess inherits
// `process.env`, plus the user's ~/.claude/ config — so whatever auth
// (API key or claude.ai subscription) is set up for the main interactive
// session works here too.

const { spawn } = require('child_process');

const TIMEOUT_MS = 60000;
const ASSISTANT_USER = 'claude';

const ASSISTANT_INSTRUCTIONS = [
  'You are participating in a group chat alongside collaborators viewing a live Claude Code session in a tool called myco.',
  'You see the recent chat messages and the last few dozen lines of the running session\'s terminal scrollback.',
  '',
  'Rules:',
  '- Reply to the most recent chat message ONLY.',
  '- Be concise: 1-3 sentences for casual replies, longer only when the question genuinely needs it.',
  '- If the message references something visible in the scrollback (an error, a file, a command), ground your answer there.',
  '- Do not ask follow-up questions; give the best short answer with what you have.',
  '- Plain text only, no markdown formatting.',
].join('\n');

// Only fire the assistant when the user *explicitly* asks for it. Plain chat
// stays as plain chat — no PTY write (that's the @myco path in pty.js) and
// no auto-reply. Previous behaviour treated any message ending in '?' as an
// assistant trigger, which made every casual question look like claude was
// answering even though the user never typed /btw.
function shouldAskAssistant(text) {
  if (typeof text !== 'string') return false;
  return /^\/btw\b/i.test(text);
}

function stripAnsi(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')      // CSI: cursor, colors, erase
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC: window titles
    .replace(/\x1b[@-_]/g, '')                       // single-char ESC
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');       // misc control chars
}

function tailLines(text, n) {
  const lines = String(text || '').split('\n');
  return lines.slice(-n).join('\n');
}

function formatChat(messages) {
  if (!messages || !messages.length) return '(empty)';
  return messages.map((m) => `${m.user}: ${m.text}`).join('\n');
}

function buildPrompt({ chatHistory, scrollback, lastMessage }) {
  return [
    ASSISTANT_INSTRUCTIONS,
    '',
    '== Recent chat ==',
    formatChat(chatHistory),
    '',
    '== Terminal scrollback (most recent at bottom) ==',
    scrollback || '(empty)',
    '',
    '== Most recent message to respond to ==',
    `${lastMessage.user}: ${lastMessage.text}`,
  ].join('\n');
}

// Spawn `claude -p` with `promptBody` on stdin, with a 60s timeout. Always
// resolves to a string (Claude's reply, or an error stand-in) — never rejects.
// Shared between askAssistant (chat-pane /btw) and askAboutFile (file-viewer
// inline review).
function runClaudeP(cwd, promptBody) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('claude', ['-p'], {
        cwd: cwd || process.cwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve(`(claude failed to start: ${err.message})`);
      return;
    }

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => resolve(`(claude error: ${err.message})`));

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
    }, TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      if (text) { resolve(text); return; }
      // 143 = SIGTERM (timeout), 137 = SIGKILL. Don't surface noise.
      if (code === 143 || code === 137) { resolve('(claude timed out)'); return; }
      const err = stderr.trim().slice(0, 300);
      resolve(`(claude exited ${code}${err ? `: ${err}` : ''})`);
    });

    try {
      proc.stdin.write(promptBody);
      proc.stdin.end();
    } catch (err) {
      resolve(`(claude stdin write failed: ${err.message})`);
    }
  });
}

function askAssistant({ cwd, chatHistory, scrollback, lastMessage }) {
  return runClaudeP(cwd, buildPrompt({ chatHistory, scrollback, lastMessage }));
}

// ─── file-viewer Claude integration ─────────────────────────────────────────
//
// askAboutFile is the code-review sibling of askAssistant: it spawns the same
// `claude -p` subprocess but builds a different prompt — file content, the
// selected line range, and prior Q&A about this file (so follow-ups have
// context). Used by the per-file thread the file viewer persists.

const FILE_PROMPT_BUDGET = 128 * 1024;        // hard cap on file content in prompt
const SELECTION_WINDOW_LINES = 60;             // context lines around an anchor when truncating

const FILE_REVIEW_INSTRUCTIONS = [
  'You are helping a developer review the file below in a web-based code-review tool.',
  'Be concise (2–6 sentences for short questions; longer only when necessary).',
  'Use markdown — code fences for snippets — and reference line numbers when useful.',
  'Ground every claim in the file content shown. If you can\'t see something the user is asking about, say so.',
].join('\n');

function langForExt(ext) {
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', sh: 'bash', bash: 'bash',
    md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
    css: 'css', html: 'html', sql: 'sql',
  };
  return map[(ext || '').toLowerCase()] || '';
}

function numberLines(lines, startAt) {
  // Right-align line numbers in a 5-char field for readability.
  return lines.map((ln, i) => `${String(startAt + i).padStart(5, ' ')}  ${ln}`).join('\n');
}

// Build the file portion of the prompt. If under budget, send the whole file
// with line numbers. Over budget, send a head + tail window plus a window
// around the anchor if any. Always returns: { body, totalLines, truncated }.
function buildFileBody(filePath, fileContent, anchor) {
  const lines = String(fileContent || '').split('\n');
  const totalLines = lines.length;
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const lang = langForExt(ext) || 'text';
  const header = `== File: ${filePath} (${totalLines} lines, ${lang}) ==`;
  const fullSize = Buffer.byteLength(fileContent, 'utf8');
  if (fullSize <= FILE_PROMPT_BUDGET) {
    return {
      body: `${header}\n${numberLines(lines, 1)}`,
      totalLines,
      truncated: false,
    };
  }
  // Truncate. Take head (first ~200 lines), tail (last ~200), and a window
  // around the anchor if present.
  const HEAD = 200;
  const TAIL = 200;
  const segments = [];
  segments.push({ start: 1, end: Math.min(HEAD, totalLines) });
  if (anchor && anchor.startLine && anchor.endLine) {
    const w = SELECTION_WINDOW_LINES;
    const ws = Math.max(1, anchor.startLine - w);
    const we = Math.min(totalLines, anchor.endLine + w);
    segments.push({ start: ws, end: we });
  }
  segments.push({ start: Math.max(1, totalLines - TAIL + 1), end: totalLines });
  // Merge overlapping/adjacent segments.
  segments.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of segments) {
    if (merged.length && s.start <= merged[merged.length - 1].end + 1) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  const parts = [`${header}  [TRUNCATED — file is ${Math.round(fullSize / 1024)} KiB; only key segments shown]`];
  let prevEnd = 0;
  for (const s of merged) {
    if (s.start > prevEnd + 1) parts.push(`   …  (${s.start - prevEnd - 1} lines elided)`);
    parts.push(numberLines(lines.slice(s.start - 1, s.end), s.start));
    prevEnd = s.end;
  }
  if (prevEnd < totalLines) parts.push(`   …  (${totalLines - prevEnd} lines elided)`);
  return { body: parts.join('\n'), totalLines, truncated: true };
}

function buildAnchorBody(anchor, fileContent) {
  if (!anchor || !anchor.startLine || !anchor.endLine) return '';
  const lines = String(fileContent || '').split('\n');
  const slice = lines.slice(anchor.startLine - 1, anchor.endLine);
  return [
    '',
    `== Selected lines ${anchor.startLine}–${anchor.endLine} ==`,
    numberLines(slice, anchor.startLine),
  ].join('\n');
}

function buildHistoryBody(history) {
  if (!history || !history.length) return '';
  const lines = ['', '== Prior conversation about this file =='];
  for (const m of history) {
    const who = m.user === ASSISTANT_USER ? 'Claude' : 'You';
    const anchor = m.anchor ? ` (re lines ${m.anchor.startLine}–${m.anchor.endLine})` : '';
    lines.push(`${who}${anchor}: ${m.text}`);
  }
  return lines.join('\n');
}

function buildFilePrompt({ filePath, fileContent, anchor, history, question }) {
  const file = buildFileBody(filePath, fileContent, anchor);
  return [
    FILE_REVIEW_INSTRUCTIONS,
    '',
    file.body,
    buildAnchorBody(anchor, fileContent),
    buildHistoryBody(history),
    '',
    '== Question ==',
    question,
  ].filter(Boolean).join('\n');
}

function askAboutFile({ cwd, filePath, fileContent, anchor, history, question }) {
  return runClaudeP(cwd, buildFilePrompt({ filePath, fileContent, anchor, history, question }));
}

module.exports = {
  askAssistant,
  askAboutFile,
  shouldAskAssistant,
  stripAnsi,
  tailLines,
  ASSISTANT_USER,
};
