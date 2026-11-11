// c8 (harness2-integration §2): declarative hook tree.
//
// Harness²'s c8 is `plugin/<name>.ts` — the only component that runs
// INSIDE the tool loop, and therefore the only lever a model cannot route
// around. myco registers exactly one hook today (PreToolUse, for the
// per-session allow/deny list) hard-coded in agent-session.js, so a
// project cannot add its own.
//
// Design decision — DECLARATIVE, not executable. The obvious reading of
// "load hooks from disk" is `require(userFile)`, which hands anyone who
// can write a file in a session workspace arbitrary code execution inside
// the myco server process (the process that holds every other session's
// tokens and every API key). That is an unacceptable trust expansion for
// the benefit. So the on-disk format is DATA, and this module is the only
// interpreter: three fixed actions, no eval, no require, no subprocess.
//
// Contract: `<agent cwd>/.claude/hooks.json`
//
//   {
//     "PostToolUse": [
//       { "matcher": "Bash|Edit|Write", "action": "log" },
//       { "matcher": "Edit", "action": "note", "text": "Remember: run ./test/test.sh after edits." }
//     ],
//     "UserPromptSubmit": [
//       { "action": "log" }
//     ],
//     "Stop": [
//       { "action": "note", "text": "..." }
//     ],
//     "PreToolUse": [
//       { "matcher": "Bash", "action": "deny", "when_command_matches": "rm\\s+-rf\\s+/", "reason": "..." }
//     ]
//   }
//
// Actions:
//   log   — append one JSONL line per fire to `_myco_/hook-log.jsonl`
//           (`file` overrides the path). The auditing/telemetry primitive:
//           Harness²'s improvement sessions read it to see what the agent
//           actually did, without needing a trajectory rewrite.
//   note  — return `additionalContext` (PostToolUse / UserPromptSubmit) so
//           the text reaches the model. For events whose SDK output has no
//           context channel, `note` degrades to a log line.
//   deny  — PreToolUse only: block the call when `when_command_matches`
//           (a RegExp, matched against the Bash command or the JSON of the
//           tool input) hits. Empty pattern = deny everything that matches
//           the matcher, which is the "guardrail" case.
//
// Fail-open at every layer, consistent with subagents.js / tool-guidance.js:
// a malformed config or unknown event/action is logged and skipped, never
// fatal — a config typo must not stop a session from working.

const fs = require('fs');
const path = require('path');

const HOOKS_REL = path.join('.claude', 'hooks.json');
const MAX_CONFIG_BYTES = 64 * 1024;
const LOG_REL = path.join('_myco_', 'hook-log.jsonl');
const MAX_RULES_PER_EVENT = 16;

// Events myco will interpret. Anything else in the file is reported and
// ignored — the SDK supports ~30 events, but a rule myco does not
// understand is worse than no rule (the author believes it is active).
const SUPPORTED_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart',
]);
const SUPPORTED_ACTIONS = new Set(['log', 'note', 'deny']);

function hooksPath(cwd) {
  return path.join(cwd, HOOKS_REL);
}

function normalizeRule(raw, event) {
  if (!raw || typeof raw !== 'object') return null;
  const action = typeof raw.action === 'string' ? raw.action : '';
  if (!SUPPORTED_ACTIONS.has(action)) return { error: `unknown action ${JSON.stringify(raw.action)}` };
  if (action === 'deny' && event !== 'PreToolUse') {
    return { error: `action "deny" is only meaningful on PreToolUse, not ${event}` };
  }
  if (action === 'note' && (typeof raw.text !== 'string' || !raw.text.trim())) {
    return { error: 'action "note" needs a non-empty `text`' };
  }
  const rule = { action };
  if (typeof raw.matcher === 'string' && raw.matcher.trim()) rule.matcher = raw.matcher.trim();
  if (typeof raw.text === 'string' && raw.text.trim()) rule.text = raw.text.trim();
  if (typeof raw.reason === 'string' && raw.reason.trim()) rule.reason = raw.reason.trim();
  if (typeof raw.file === 'string' && raw.file.trim()) {
    // Keep the log inside the session: an absolute path would let a config
    // write anywhere the server can.
    const rel = raw.file.trim();
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      return { error: `\`file\` must be a relative path inside the session, got ${JSON.stringify(rel)}` };
    }
    rule.file = rel;
  }
  if (action === 'deny' && typeof raw.when_command_matches === 'string' && raw.when_command_matches) {
    try {
      rule.regex = new RegExp(raw.when_command_matches);
    } catch (e) {
      return { error: `invalid when_command_matches regex: ${e.message}` };
    }
  }
  return { rule };
}

// Load and validate the project's hook config.
// Returns { config: { <event>: [rule] }, skipped: [{ where, reason }] }.
// An absent file yields `{ config: {}, skipped: [] }`.
function loadHooks(cwd) {
  const out = { config: {}, skipped: [] };
  if (!cwd || typeof cwd !== 'string') return out;
  const file = hooksPath(cwd);
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return out;
    if (st.size > MAX_CONFIG_BYTES) {
      out.skipped.push({ where: 'file', reason: `${st.size} bytes exceeds ${MAX_CONFIG_BYTES}` });
      return out;
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') out.skipped.push({ where: 'file', reason: e.message });
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    out.skipped.push({ where: 'file', reason: `invalid JSON: ${e.message}` });
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    out.skipped.push({ where: 'file', reason: 'top level must be an object keyed by hook event' });
    return out;
  }
  for (const [event, rules] of Object.entries(parsed)) {
    if (/^[$_]|^comment/.test(event)) continue;  // $schema / _comment
    if (!SUPPORTED_EVENTS.has(event)) {
      out.skipped.push({ where: event, reason: 'unsupported event (myco interprets PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, SessionStart)' });
      continue;
    }
    if (!Array.isArray(rules)) {
      out.skipped.push({ where: event, reason: 'value must be an array of rules' });
      continue;
    }
    for (let i = 0; i < Math.min(rules.length, MAX_RULES_PER_EVENT); i++) {
      const { rule, error } = normalizeRule(rules[i], event);
      if (error) { out.skipped.push({ where: `${event}[${i}]`, reason: error }); continue; }
      (out.config[event] = out.config[event] || []).push(rule);
    }
    if (rules.length > MAX_RULES_PER_EVENT) {
      out.skipped.push({ where: event, reason: `only the first ${MAX_RULES_PER_EVENT} rules are used` });
    }
  }
  return out;
}

// SDK matcher semantics: a `matcher` string on a hook entry filters by
// tool name for tool events (exact, or an alternation an author writes as
// `Bash|Edit`). We keep that vocabulary rather than inventing a new one.
function matcherHits(matcher, toolName) {
  if (!matcher) return true;              // omitted ⇒ every tool
  if (!toolName) return false;            // a tool matcher on a non-tool event never fires
  const names = matcher.split('|').map((s) => s.trim()).filter(Boolean);
  return names.includes(toolName);
}

// Append one JSONL line. Never throws: a logging failure must not break
// the tool loop it is supposed to observe.
function appendLog(cwd, rule, payload) {
  const rel = rule.file || LOG_REL;
  const file = path.join(cwd, rel);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(payload) + '\n', 'utf8');
  } catch (e) {
    console.error(`[harness-hooks] cannot append ${file}: ${e.message}`);
  }
}

// Build the callback for one (event, rule). Returns a HookCallback.
function makeCallback(event, rule, cwd, sessionId) {
  return async (input) => {
    const toolName = input && (input.tool_name || input.toolName);
    try {
      if (rule.action === 'log') {
        appendLog(cwd, rule, {
          ts: new Date().toISOString(),
          session: sessionId,
          event,
          tool: toolName || null,
          input: event === 'UserPromptSubmit' || event === 'Stop' ? undefined : (input && input.tool_input),
          output: event === 'PostToolUse' ? (input && input.tool_response) : undefined,
          prompt: event === 'UserPromptSubmit' ? (input && input.prompt) : undefined,
        });
        return {};
      }
      if (rule.action === 'note') {
        // PostToolUse / UserPromptSubmit have an additionalContext channel;
        // other events do not, so degrade to a log line rather than
        // returning a field the SDK would ignore.
        if (event === 'PostToolUse' || event === 'UserPromptSubmit') {
          return { hookSpecificOutput: { hookEventName: event, additionalContext: rule.text } };
        }
        appendLog(cwd, { ...rule, file: rule.file || LOG_REL }, {
          ts: new Date().toISOString(), session: sessionId, event, kind: 'note', text: rule.text,
        });
        return {};
      }
      if (rule.action === 'deny') {
        const haystack = (input && input.tool_input && typeof input.tool_input.command === 'string')
          ? input.tool_input.command
          : JSON.stringify((input && input.tool_input) || {});
        if (rule.regex && !rule.regex.test(haystack)) return {};
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: rule.reason || `blocked by project hook rule (${event})`,
          },
        };
      }
      return {};
    } catch (e) {
      console.error(`[harness-hooks] ${event} callback threw: ${e.message}`);
      return {};
    }
  };
}

// Turn the loaded config into the SDK `hooks` option shape
// (Partial<Record<HookEvent, HookCallbackMatcher[]>>). Returns {} when the
// project defines nothing, so the caller can spread it without changing
// existing behaviour.
function buildHooksOption(loaded, cwd, sessionId) {
  const out = {};
  if (!loaded || !loaded.config) return out;
  for (const [event, rules] of Object.entries(loaded.config)) {
    // One matcher entry per distinct matcher, so the SDK's own filtering
    // does the work and our callback only runs when relevant.
    const byMatcher = new Map();
    for (const rule of rules) {
      const key = rule.matcher || '';
      if (!byMatcher.has(key)) byMatcher.set(key, []);
      byMatcher.get(key).push(makeCallback(event, rule, cwd, sessionId));
    }
    out[event] = [...byMatcher.entries()].map(([matcher, hooks]) => (
      matcher ? { matcher, hooks } : { hooks }
    ));
  }
  return out;
}

module.exports = {
  loadHooks,
  buildHooksOption,
  matcherHits,
  hooksPath,
  HOOKS_REL,
  LOG_REL,
  SUPPORTED_EVENTS,
  SUPPORTED_ACTIONS,
  MAX_CONFIG_BYTES,
};
