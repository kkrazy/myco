// agents/rlm/harness.js — Continual Harness (task req: the framework is
// "runtime CRUD", the agent self-improves by dynamically adding prompt to
// itself based on evidence). This module is the durable store behind the
// kernel's `rlm.addPrompt(text)` / `rlm.listPrompts()` shims:
//
//   _myco_/rlm/<sessionId>/prompt-additions.jsonl
//     {"id":1,"text":"...","ts":"...","reason":"..."}
//
// spawnRlmAgent composes every row into the session's systemPrompt as a
// trailing "## Self-authored harness rules" section, so the additions are
// live on the next (re)spawn. The same file is shared by n2 workers
// (keyed "<sessionId>:<actor>" — ':' is filesystem-safe).
//
// Non-RLM sessions never touch this file — the plain prompt path is
// unchanged (old logic preserved when RLM is off).
'use strict';

const fs = require('fs');
const path = require('path');

// Cap the additions so a runaway self-modifier can't grow the prompt
// unboundedly: keep the newest MAX_ADDITIONS rows, and MAX_TEXT_CHARS
// per row.
const MAX_ADDITIONS = 50;
const MAX_TEXT_CHARS = 4000;

function harnessDir(cwd, sessionId) {
  return path.join(cwd, '_myco_', 'rlm', _safe(sessionId), 'harness');
}

function harnessFile(cwd, sessionId) {
  return path.join(harnessDir(cwd, sessionId), 'prompt-additions.jsonl');
}

// Filesystem-safe session key (kernel ids use ':' for n2 workers).
function _safe(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_');
}

// Read all additions, oldest → newest. Malformed lines are skipped (the
// file is append-only JSONL; a torn final line after a crash is normal).
function listPromptAdditions(cwd, sessionId) {
  const file = harnessFile(cwd, sessionId);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.text === 'string' && o.text.trim()) rows.push(o);
    } catch { /* torn line — skip */ }
  }
  return rows;
}

// Append one self-authored prompt addition. Returns the stored row.
function addPromptAddition(cwd, sessionId, text, reason) {
  const clean = String(text || '').trim().slice(0, MAX_TEXT_CHARS);
  if (!clean) throw new Error('rlm.addPrompt: text must be non-empty');
  const file = harnessFile(cwd, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = listPromptAdditions(cwd, sessionId);
  const row = {
    id: rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1,
    text: clean,
    reason: String(reason || '').slice(0, 500),
    ts: new Date().toISOString(),
  };
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  // Trim to the newest MAX_ADDITIONS rows so the composed prompt stays
  // bounded — rewrite the file from the in-memory tail (idempotent).
  if (rows.length + 1 > MAX_ADDITIONS) {
    const keep = [...rows, row].slice(-MAX_ADDITIONS);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.renameSync(tmp, file);
  }
  return row;
}

// Compose the additions into a systemPrompt section. Returns '' when the
// store is empty — a fresh RLM session's prompt is byte-identical to the
// pre-harness contract prompt.
function composeHarnessSection(cwd, sessionId) {
  const rows = listPromptAdditions(cwd, sessionId);
  if (!rows.length) return '';
  const body = rows.map((r) => `- [${r.id}] ${r.text}`).join('\n');
  return `\n\n## Self-authored harness rules (Continual Harness)\n` +
    `These rules were added by the agent itself via rlm.addPrompt after\n` +
    `observing evidence they help (oldest → newest, cap ${MAX_ADDITIONS}).\n` +
    `Treat them as binding operating additions to this prompt; add or\n` +
    `refine them as new evidence accumulates.\n${body}`;
}

module.exports = {
  addPromptAddition,
  listPromptAdditions,
  composeHarnessSection,
  harnessFile,
  MAX_ADDITIONS,
  MAX_TEXT_CHARS,
};
