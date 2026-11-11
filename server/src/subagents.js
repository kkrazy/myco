// c5 (harness2-integration §2): sub-agent surface.
//
// Loads `<absRoot>/.claude/agents/*.md` into the SDK's `agents` option —
// the one c1..c8 component myco was missing entirely. Before this module,
// `agents` sat in SDK_OPTIONS_ALLOWLIST (`agent-session.js`) but nothing
// ever assigned it, so a project could ship sub-agent definitions and the
// SDK would never see them; the Task tool only ever had its built-in
// general-purpose agent.
//
// File shape (Claude Code convention, one directory level — flat):
//
//   ---
//   name: reviewer
//   description: Reviews diffs for correctness before a merge
//   tools: Read, Grep, Glob        # optional, comma list
//   model: inherit                 # optional
//   ---
//   <system prompt body>
//
// The body IS the AgentDefinition.prompt. `name` defaults to the filename
// stem when the front-matter omits it, matching how the SDK resolves skill
// names in this repo (skills.js parseSkillFrontMatter → dir/file name).
//
// Failure policy: this is a CONFIG file, not code. A malformed agent must
// never take down a session — every problem is logged once and that file is
// skipped, so a typo degrades to "that sub-agent is missing" instead of
// "the session cannot start". Same fail-open stance as lean-ctx in
// agent-session.js.
//
// Pure module — no Express coupling, mirrors skills.js / files.js shape.
// Every public function takes an `absRoot` (the session's cwd).

const fs = require('fs');
const path = require('path');

const AGENTS_SUBDIR = path.join('.claude', 'agents');
const MAX_AGENT_FILE_BYTES = 256 * 1024;

function agentsRoot(absRoot) {
  return path.join(absRoot, AGENTS_SUBDIR);
}

// Tolerant front-matter parse — the same approach as skills.js's
// parseSkillFrontMatter (no YAML dependency; the fields we read are all
// single-line scalars). Returns { name, description, tools, model } with
// nulls when absent. `body` is everything after the closing `---`.
function parseAgentFile(md) {
  const out = { name: null, description: null, tools: null, model: null, body: '' };
  if (typeof md !== 'string') return out;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) {
    // No front-matter: the whole file is the prompt. Valid but anonymous —
    // the caller falls back to the filename stem.
    out.body = md.trim();
    return out;
  }
  const fm = m[1];
  out.body = md.slice(m[0].length).trim();
  const field = (key) => {
    const hit = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm);
    return hit ? hit[1].trim().replace(/^["']|["']$/g, '') : null;
  };
  out.name = field('name');
  out.description = field('description');
  const tools = field('tools');
  if (tools) {
    // Accept both `Read, Grep` and `["Read", "Grep"]` / `[Read, Grep]`.
    const list = tools.replace(/^\[|\]$/g, '').split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    out.tools = list.length > 0 ? list : null;
  }
  out.model = field('model');
  return out;
}

// Load every agent definition in the project store. Returns
// { agents: { <name>: AgentDefinition }, skipped: [{ file, reason }] }.
// `agents` is plain JSON — no functions — so it can go straight into
// `sdkOpts.agents`. An empty store yields `{ agents: {}, skipped: [] }`
// and the caller leaves `sdkOpts.agents` unset (byte-identical pre-c5
// behaviour for sessions that ship no sub-agents).
function loadAgents(absRoot) {
  const out = { agents: {}, skipped: [] };
  if (!absRoot || typeof absRoot !== 'string') return out;
  const root = agentsRoot(absRoot);
  let dirents;
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    // ENOENT is the normal case (no sub-agents defined). Anything else is
    // worth a line in the log but still not fatal.
    if (e.code !== 'ENOENT') {
      console.error(`[subagents] cannot read ${root}: ${e.message}`);
    }
    return out;
  }
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.md')) continue;
    const file = path.join(root, d.name);
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_AGENT_FILE_BYTES) {
        out.skipped.push({ file: d.name, reason: `larger than ${MAX_AGENT_FILE_BYTES} bytes` });
        continue;
      }
      const parsed = parseAgentFile(fs.readFileSync(file, 'utf8'));
      const name = parsed.name || path.basename(d.name, '.md');
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        out.skipped.push({ file: d.name, reason: `invalid agent name ${JSON.stringify(name)}` });
        continue;
      }
      if (!parsed.body) {
        // The SDK requires a prompt; an empty one would create a sub-agent
        // that can do nothing but burn a turn.
        out.skipped.push({ file: d.name, reason: 'empty prompt body' });
        continue;
      }
      // The SDK requires `description` (it is how the main agent decides to
      // delegate). Default to the name rather than dropping the agent.
      const def = {
        description: parsed.description || `Sub-agent ${name}`,
        prompt: parsed.body,
      };
      if (parsed.tools) def.tools = parsed.tools;
      if (parsed.model) def.model = parsed.model;
      if (out.agents[name]) {
        out.skipped.push({ file: d.name, reason: `duplicate agent name ${JSON.stringify(name)}` });
        continue;
      }
      out.agents[name] = def;
    } catch (e) {
      out.skipped.push({ file: d.name, reason: e.message });
    }
  }
  return out;
}

// One-line summary for the [sdkOpts]/[subagents] log line.
function describeLoaded(loaded) {
  const names = Object.keys(loaded.agents);
  if (names.length === 0) return 'none';
  const skipped = loaded.skipped.length ? `, skipped ${loaded.skipped.length}` : '';
  return `${names.join(',')}${skipped}`;
}

module.exports = { loadAgents, parseAgentFile, agentsRoot, describeLoaded, AGENTS_SUBDIR };
