// Small pure-text helpers shared between modules (btw.js's prompt builders,
// pty.js's scrollback capture for the assistant). Kept dependency-free so
// it doesn't get pulled into the sessions ↔ pty ↔ permissions require cycle.

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

module.exports = { stripAnsi, tailLines, formatChat };
