// fr-109: pure argv handler for the myco CLI, extracted from index.js so
// tests can exercise it without spawning subprocesses.
//
// Contract: given an array of args (typically `process.argv.slice(2)`),
// return a plain object describing what command should run and with what
// options. The caller (index.js) does the actual dispatch. Any parse
// error surfaces as { command: 'usage', error: '<why>' } — never throws.
//
// Design decisions (fr-109 analyze, assumption A):
//   - Pure function, no side effects, no reads of process.env/process.stdout.
//   - Return shape is tiny + stable: { command, ...options }.
//   - Unknown / malformed args land on 'usage' with a human-readable
//     `error` field so index.js can print it before exiting non-zero.
//   - Later phases (fr-113 classifier, fr-114 prompt hook, fr-115 tool
//     calls) add new commands here; existing shapes stay backward-
//     compatible.

'use strict';

const COMMANDS = {
  VERSION: 'version',
  HELP:    'help',
  ATTACH:  'attach',
  INTEGRATE: 'integrate',
  USAGE:   'usage',
};

// fr-114+: as we add more shell targets (fish, pwsh, nushell), just
// extend this set. Everything else in the CLI reads through the set so
// error messages stay consistent.
const INTEGRATE_TARGETS = new Set(['bash', 'zsh']);

function parseArgv(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];

  if (args.length === 0) {
    return { command: COMMANDS.HELP };
  }

  const head = args[0];

  // Top-level flags. --version and --help take precedence over any
  // subcommand so `myco --version` prints the version even if a bogus
  // subcommand follows.
  if (head === '--version' || head === '-v') {
    return { command: COMMANDS.VERSION };
  }
  if (head === '--help' || head === '-h') {
    return { command: COMMANDS.HELP };
  }

  // Subcommands.
  if (head === 'attach') {
    const sessionId = args[1];
    if (!sessionId) {
      return { command: COMMANDS.USAGE, error: '`attach` requires a session id (usage: myco attach <session-id>)' };
    }
    if (args.length > 2) {
      return { command: COMMANDS.USAGE, error: `unexpected extra args after \`attach ${sessionId}\`: ${args.slice(2).join(' ')}` };
    }
    return { command: COMMANDS.ATTACH, sessionId };
  }

  if (head === 'integrate') {
    // Accept `--bash`, `--zsh` for a specific target; bare `integrate` prints
    // the list of supported targets.
    if (args.length === 1) {
      return {
        command: COMMANDS.USAGE,
        error: `\`integrate\` requires a shell target flag: --bash or --zsh (got no target)`,
      };
    }
    if (args.length > 2) {
      return {
        command: COMMANDS.USAGE,
        error: `\`integrate\` accepts exactly one target flag; got: ${args.slice(1).join(' ')}`,
      };
    }
    const flag = args[1];
    if (!flag.startsWith('--')) {
      return {
        command: COMMANDS.USAGE,
        error: `\`integrate\` target must be a flag like --bash or --zsh (got \`${flag}\`)`,
      };
    }
    const target = flag.slice(2);
    if (!INTEGRATE_TARGETS.has(target)) {
      return {
        command: COMMANDS.USAGE,
        error: `unknown integrate target \`${target}\`; supported: ${[...INTEGRATE_TARGETS].map((t) => '--' + t).join(', ')}`,
      };
    }
    return { command: COMMANDS.INTEGRATE, target };
  }

  return {
    command: COMMANDS.USAGE,
    error: `unknown command \`${head}\`; try \`myco --help\``,
  };
}

// Human-readable help text. Emitted by both `myco --help` and `myco`
// (no args). Kept short — this is the CLI's front door, not a manpage.
// fr-114+: extend as we add commands.
function helpText(binName /* 'myco' */) {
  const bin = binName || 'myco';
  return [
    'myco — combined CLI + chat with rules-enforcing model proxy',
    '',
    'Usage:',
    `  ${bin} [--version|-v]           Print the CLI version and exit`,
    `  ${bin} [--help|-h]              Print this help and exit`,
    `  ${bin} attach <session-id>      Attach to a live myco session over WebSocket`,
    `  ${bin} integrate --bash         Print the .bashrc line to source for bash integration`,
    `  ${bin} integrate --zsh          Print the .zshrc line to source for zsh integration`,
    '',
    'Recent + upcoming (planned):',
    `  fr-113  Lacy-style 5-rule classifier (shell vs chat routing)`,
    `  fr-114  Bash prompt hook (color-tinted green/magenta on Enter) — this release`,
    `  fr-115  Server /v1/tools/* endpoints (get_rules, get_skills, ...)`,
    `  fr-116  Streaming chat client (WebSocket + markdown rendering)`,
    '',
    'Home: https://github.com/kkrazy/myco',
  ].join('\n');
}

module.exports = {
  parseArgv,
  helpText,
  COMMANDS,
  INTEGRATE_TARGETS,
};
