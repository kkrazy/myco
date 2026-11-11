// c7 (harness2-integration §2): per-session helper scripts.
//
// Harness²'s c7 is `scripts/<name>.py` — deterministic, reproducible
// helpers the agent runs instead of re-deriving the same transformation
// every turn. myco's `tools/` directory is repo-level static tooling
// (build-time), not session-level, so a project had no place to ship its
// own helpers.
//
// Contract: `<agent cwd>/.myco_harness/scripts/*.py`, flat, discovered on
// every iteration. Two things happen with them:
//
//   1. they are LISTED in the agent's tool guidance (see
//      tool-guidance.buildScriptsSection), so the agent knows they exist
//      without having to `ls` for them; and
//   2. running them is auto-allowed by permissions.js, so an unattended
//      rollout does not stall on a permission menu for a script the
//      project itself shipped.
//
// The allow rule is deliberately narrow: `python3 <abs>/scripts/<name>.py`
// where <name> is one this module actually discovered. A blanket
// `Bash(python3)` would auto-approve arbitrary code — that is a much
// larger grant than c7 needs, and Harness²'s own validator only ever
// points at files inside the tree.
//
// Execution itself is NOT special-cased: the agent runs the script through
// the ordinary Bash tool, so it inherits cwd, env, timeouts and output
// capture. This module is discovery + permission, nothing else.

const fs = require('fs');
const path = require('path');

const SCRIPTS_REL = path.join('.myco_harness', 'scripts');
const MAX_SCRIPTS = 64;

function scriptsDir(cwd) {
  return path.join(cwd, SCRIPTS_REL);
}

// Discover the project's helper scripts. Returns
// { scripts: [{ name, file, bytes }], dir }.
// Sorted by name for a stable prompt section (an unsorted listing would
// churn the system prompt between turns and defeat prompt caching).
function listHarnessScripts(cwd) {
  const out = { scripts: [], dir: null };
  if (!cwd || typeof cwd !== 'string') return out;
  const dir = scriptsDir(cwd);
  out.dir = dir;
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[harness-scripts] cannot read ${dir}: ${e.message}`);
    return out;
  }
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith('.py')) continue;
    if (out.scripts.length >= MAX_SCRIPTS) {
      console.error(`[harness-scripts] ${dir} has more than ${MAX_SCRIPTS} scripts — rest ignored`);
      break;
    }
    const file = path.join(dir, d.name);
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { continue; }
    out.scripts.push({ name: d.name, file, bytes });
  }
  out.scripts.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// True when `command` is exactly an invocation of one of the discovered
// scripts. Used by permissions.js as an extra allow source.
//
// Deliberately strict — this is an auto-approval path, so anything that
// could smuggle a second command through counts as "not a match":
//   ✓ python3 /abs/path/.myco_harness/scripts/summarize.py
//   ✓ python3 /abs/path/.myco_harness/scripts/summarize.py --in x.csv
//   ✗ python3 /abs/.../summarize.py && rm -rf ~   (&& — reject)
//   ✗ /usr/bin/python3 -c "..."                   (-c — reject)
//   ✗ python3 /abs/.../other.py                   (not discovered — reject)
const SHELL_METACHARS = /[;&|`$()<>\n\r]/;
const PYTHON_BINS = new Set(['python', 'python3', 'python3.11', 'python3.12', 'python3.13']);

function isHarnessScriptInvocation(command, cwd) {
  if (typeof command !== 'string' || !cwd) return false;
  const cmd = command.trim();
  if (!cmd || SHELL_METACHARS.test(cmd)) return false;
  const tokens = cmd.split(/\s+/);
  if (tokens.length < 2) return false;
  if (!PYTHON_BINS.has(path.basename(tokens[0]))) return false;
  const scriptArg = tokens[1];
  // Reject python's inline-code / module flags outright: `-c` and `-m`
  // execute arbitrary input, which is not what "run this project script"
  // means.
  if (/^-/.test(scriptArg)) return false;
  const { scripts } = listHarnessScripts(cwd);
  for (const s of scripts) {
    if (path.resolve(scriptArg) === path.resolve(s.file)) return true;
  }
  return false;
}

// Render the discovery listing as a markdown section for the c4 guidance
// block. Empty string when there are no scripts (never emit an empty
// heading — it would add prompt bytes for nothing).
function renderScriptsSection(scripts, cwd) {
  if (!Array.isArray(scripts) || scripts.length === 0) return '';
  const rel = (f) => path.relative(cwd, f).split(path.sep).join('/');
  const lines = [
    '## Deterministic helper scripts',
    '',
    'Prefer these over re-deriving the same work each turn. They are plain',
    'Python 3 and run with the Bash tool (`python3 <path> [args]`); running',
    'them is pre-approved.',
    '',
  ];
  for (const s of scripts) {
    lines.push(`- \`${rel(s.file)}\` (${s.bytes} B)`);
  }
  return lines.join('\n');
}

module.exports = {
  listHarnessScripts,
  isHarnessScriptInvocation,
  renderScriptsSection,
  scriptsDir,
  SCRIPTS_REL,
  MAX_SCRIPTS,
};
