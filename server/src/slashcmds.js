// at the start of a chat message. Each handler receives a context and is
// expected to emit one or more chat messages back via `reply(text)`.
//
// Handlers should never throw — always resolve with a user-visible result
// (success or human-readable error). The dispatcher posts the handler's
// reply as a chat message tagged with the assistant user.

const github = require('./github');           // kept as legacy back-compat shim
const gitHosts = require('./git-hosts');       // provider-aware dispatch (github + gitee)
const permissions = require('./permissions');
// Lazy property access on sessionsMod — pty.js → slashcmds.js → sessions.js
// is a circular chain. sessions.js exports its API via Object.assign AFTER
// the initial module.exports, so destructuring at require-time gets undefined.
const sessionsMod = require('./sessions');

// ── research mode + domain knowledge base ───────────────────────────────
// Handlers live in server/src/knowledge/commands.js so every KB-facing
// concern stays in one folder; registered here only.
const knowledgeCommands = require('./knowledge/commands');
const handleResearch = knowledgeCommands.handleResearch;
const handleKb = knowledgeCommands.handleKb;


const ASSISTANT_USER = 'claude';

// fr-80: cross-context "@<target>" routing for /fr, /bug, /td. When a
// user types `/fr @myco add dark mode` from any session, the slash-
// command instead files a GitHub issue against the mapped repo using
// the user's PAT (per-repo token preferred, user-level GitHub OAuth
// as fallback). Targets are intentionally a small fixed registry —
// each target needs deliberate review of who can file what where.
//
// Per-layer labels mirror the existing `/feature` mapping:
//   Feature → enhancement   Bug → bug   Todo → todo
const REMOTE_TARGETS = {
  myco: { provider: 'github', owner: 'kkrazy', repo: 'myco' },
  // codehub twin — the user's own Huawei intranet repo (s00791175/myco-test).
  // `/fr @codehub`, `/bug @codehub`, `/td @codehub` file to CodeHub using
  // a codehub codehost PAT (/setpat @codehub <token>) or the user-level
  // codehub token slot. Distinct from `@myco` (GitHub kkrazy/myco), which
  // is the dedicated public alias.
  codehub: { provider: 'codehub', owner: 's00791175', repo: 'myco-test' },
};
// Human-readable provider name for messages (token-missing hints, error
// labels, /setpat guidance). Single source so codehub reads "CodeHub",
// not "GitHub"/"Gitee".
const _PROVIDER_LABEL = { github: 'GitHub', gitee: 'Gitee', codehub: 'CodeHub' };
const REMOTE_LABEL_BY_LAYER = {
  Feature: ['enhancement'],
  Bug:     ['bug'],
  Todo:    ['todo'],
};

// fr-102: supported Claude models shown in the /model picker. The list
// is intentionally short (the three family aliases plus a couple of
// recent full IDs from sdk.d.ts comments) — free-form full IDs are
// still accepted by handleModel so the slash command doesn't go stale
// every time Anthropic ships a new variant. Single source of truth:
// both the picker popover (web/public/app.js) and the slash-command
// validator (handleModel) read from this list. Kept in default-first
// order so the popover marks the implicit default cleanly.
const SUPPORTED_MODELS = [
  { id: 'sonnet', label: 'Sonnet',  desc: 'Family alias — Anthropic\'s balanced model. Default for most flows.' },
  { id: 'opus',   label: 'Opus',    desc: 'Family alias — most capable; higher latency and cost.' },
  { id: 'haiku',  label: 'Haiku',   desc: 'Family alias — fastest and cheapest; good for short turns.' },
];

// Registered commands. Aliases share a handler.
const COMMANDS = [
  {
    names: ['feature', 'feat'],
    summary: 'Raise a feature request issue on the session\'s github/gitee repo',
    usage: '/feature <title>',
    handler: handleFeature,
  },
  // Short plan-item commands. Each one appends a row to this session's
  // Plan artifact (rec.artifacts.plan.items) with a classification layer
  // — Feature / Todo / Bug — that the Plan tab groups items by. The
  // items are tagged source='user' so they survive a Refresh of the
  // claude-extracted plan (the extractor would otherwise replace the
  // whole list).
  {
    names: ['fr'],
    summary: 'Add a feature-request item to this session\'s Plan (or `@<target>` for a remote repo)',
    usage: '/fr <description>  OR  /fr @<target> <description>',
    handler: (ctx) => addPlanItem(ctx, 'Feature'),
  },
  {
    names: ['td', 'todo'],
    summary: 'Add a todo item to this session\'s Plan (or `@<target>` for a remote repo)',
    usage: '/td <description>  OR  /td @<target> <description>',
    handler: (ctx) => addPlanItem(ctx, 'Todo'),
  },
  {
    names: ['bug'],
    summary: 'Add a bug-report item to this session\'s Plan (or `@<target>` for a remote repo)',
    usage: '/bug <description>  OR  /bug @<target> <description>',
    handler: (ctx) => addPlanItem(ctx, 'Bug'),
  },
  // Task-list intervention. The handler forwards a natural-language
  // directive to the running Claude session (see handleTaskList /
  // handleTaskSkip); the agent's CLAUDE.md task-list etiquette teaches
  // it to respond with the list / dismissal.
  {
    names: ['task', 'tasks'],
    summary: 'Ask the running Claude to list its pending + in-progress internal tasks',
    usage: '/task',
    handler: handleTaskList,
  },
  {
    names: ['skip'],
    summary: 'Tell the running Claude to dismiss internal task #N (it will TaskUpdate → deleted)',
    usage: '/skip <task-id>',
    handler: handleTaskSkip,
  },
  {
    names: ['cancel'],
    summary: 'Tell the running Claude to cancel internal task #N (it will TaskUpdate → deleted)',
    usage: '/cancel <task-id>',
    handler: handleTaskSkip,
  },
  {
    names: ['decide', 'pick', 'choose'],
    summary: 'Answer Claude\'s currently-pending dialog (e.g. plan-mode "what next" menu)',
    usage: '/decide <n>',
    handler: handleDecide,
  },
  {
    names: ['allow'],
    summary: 'Add a tool pattern to the session\'s permission allow list',
    usage: '/allow <pattern>   e.g. /allow Bash(curl)',
    handler: handleAllow,
  },
  {
    names: ['deny'],
    summary: 'Add a tool pattern to the session\'s permission deny list',
    usage: '/deny <pattern>    e.g. /deny Bash(rm)',
    handler: handleDeny,
  },
  {
    names: ['allowlist'],
    summary: 'Show this session\'s current allow + deny lists',
    usage: '/allowlist',
    handler: handleAllowList,
  },
  {
    names: ['clear'],
    summary: 'Wipe this session\'s chat history. `new` mode restarts the session instead (owner+admin only).',
    usage: '/clear (wipe history) · /clear new (restart session, keep history, owner+admin)',
    handler: handleClear,
  },
  {
    names: ['merge'],
    summary: 'Merge N plan items of the same layer into the lowest-numbered canonical (e.g. /merge td-3 td-7)',
    usage: '/merge <id1> <id2> [<id3>…]',
    handler: handleMerge,
  },
  {
    names: ['dedupe'],
    summary: 'Ask claude to propose merges for similar plan items — no auto-apply, you confirm via /merge',
    usage: '/dedupe',
    handler: handleDedupe,
  },
  {
    names: ['add2plan'],
    summary: 'Ask claude to break a description into todos / FRs and add them to the Plan (incl. dependsOn for ordering)',
    usage: '/add2plan <description>',
    handler: handleAdd2Plan,
  },
  {
    names: ['listpat'],
    summary: 'List stored PAT aliases for this session\'s repo or a remote @<target>',
    usage: '/listpat   OR   /listpat @<target>',
    handler: handleListPat,
  },
  {
    names: ['setpat'],
    summary: 'Save a personal access token for this session\'s repo (github or gitee, auto-detected)',
    usage: '/setpat <token>',
    handler: handleSetPat,
  },
  // bug-91: store the operator's gitee account login so the git
  // credential helper (scripts/git-credential-myco.sh) can emit the
  // correct username= line on push/fetch. Gitee validates the username
  // against the token's owning account (unlike github, which ignores
  // it), so a hard-coded 'x-access-token' produces a misleading 403.
  {
    names: ['setgiteelogin'],
    summary: 'Save your gitee account login so `git push` / `git fetch` against gitee work through the credential helper (owner+admin).',
    usage: '/setgiteelogin <login>   e.g. /setgiteelogin kkrazy   (or /setgiteelogin --clear to remove)',
    handler: handleSetGiteeLogin,
  },
  {
    names: ['admin'],
    summary: 'Grant/revoke admin on this session (owner only). Admins inherit everything except delete + grant/revoke.',
    usage: '/admin @user (grant) · /admin -@user (revoke) · /admin (list)',
    handler: handleAdmin,
  },
  {
    names: ['share'],
    summary: 'Share this session read-only with one or more users (owner only). Viewers can see chat + transcripts but cannot drive claude.',
    usage: '/share @alice @bob (grant) · /share -@alice (revoke) · /share (list)',
    handler: handleShare,
  },
  {
    names: ['strict'],
    summary: 'Toggle strict-mode gate: claude-bound chat must include [run:plan#<id>] (owner + admin).',
    usage: '/strict on · /strict off · /strict (status)',
    handler: handleStrict,
  },
  // fr-48: per-session plan-item run-queue. Sequential auto-dispatch
  // with auto-pause on failure. Owner+admin only.
  {
    names: ['queue'],
    summary: 'Add one or more plan items (fr-N / td-N / bug-N) to the run-queue. Auto-dispatches sequentially.',
    usage: '/queue fr-43 · /queue fr-43 bug-21 td-22',
    handler: handleQueue,
  },
  {
    names: ['qstatus'],
    summary: 'Print the current run-queue (pending / running / done counts + per-entry status).',
    usage: '/qstatus',
    handler: handleQStatus,
  },
  {
    names: ['harness'],
    summary: 'Run and control a Harness² sweep for this project (owner+admin; spends model budget).',
    usage: '/harness run [--n2] [--k <1-4>] [--timeout <5h|300m|1800>] <task>  |  /harness status [id]  |  /harness cancel  |  /harness diff  |  /harness adopt  |  /harness pull  |  /harness rollback  |  /harness publish',
    handler: handleHarness,
  },
  {
    names: ['harness-market'],
    summary: 'Browse and install tuned harness configs from the market. /harness-market list | install <name> | info <name>',
    usage: '/harness-market list  |  /harness-market install <name>  |  /harness-market info <name>',
    handler: handleHarnessMarket,
  },
  {
    names: ['qcancel'],
    summary: 'Remove a pending plan item from the run-queue (cannot remove a currently-running entry).',
    usage: '/qcancel fr-43',
    handler: handleQCancel,
  },
  {
    names: ['qclear'],
    summary: 'Drop all pending entries from the run-queue (running + finished history preserved).',
    usage: '/qclear',
    handler: handleQClear,
  },
  {
    names: ['qresume'],
    summary: 'Unpause the run-queue (after an auto-pause from failure) and dispatch the next pending entry.',
    usage: '/qresume',
    handler: handleQResume,
  },
  // fr-49: heuristic+LLM "what's next" priority list. Read-only;
  // anyone attached can call it (mirrors /qstatus). Cached in
  // plan.whatsNext with a 2-hour TTL; regenerates on read when stale
  // (or on `--refresh` / `force` arg). Open to guests like /qstatus.
  {
    names: ['whatsnext', 'next'],
    summary: 'Show the top-ranked open plan items (heuristic + LLM rerank, cached 2h). Append `force` to regenerate now.',
    usage: '/whatsnext · /next · /next force',
    handler: handleWhatsNext,
  },
  // bug-92: list the session's unanswered user questions (pending +
  // failed). Read-only — re-kick via the strip's ↻ rerun button or
  // POST /sessions/:id/questions/rerun.
  {
    names: ['pq'],
    summary: 'List unanswered user questions (pending + failed) so none get forgotten.',
    usage: '/pq',
    handler: handlePQ,
  },
  // fr-54: pass-through to the underlying `git` CLI. Owner+admin only.
  // Runs in the session's workspace; no allowlist, no PAT injection
  // (use /setpat or PAT-in-URL for private repos).
  {
    names: ['git'],
    summary: 'Run a git subcommand in the session workspace. Output is returned as-is. Owner+admin only.',
    usage: '/git status · /git log --oneline -10 · /git clone https://… · /git fetch origin',
    handler: handleGit,
  },
  // fr:model-gateway — switch the model gateway used for this session.
  // Bare /model opens a picker popover listing the user's per-user gateway
  // profiles + `default` (system .env); the sessions model is governed by
  // the active profile's `model` (or the system default). Typed commands:
  // /model gw:<name> activates a profile, /model gw:default resets it.
  // Power users can still set a per-session model override via
  // /model <sonnet|opus|haiku|full-id> (and clear with /model default).
  // Owner+admin can change; everyone can read (mirrors /strict).
  {
    names: ['model'],
    summary: 'Switch the model gateway / model. Bare /model opens the picker; /model gw:<name> activates a profile; /model <alias> is a per-session override. Owner+admin to change.',
    usage: '/model · /model gw:<name> · /model gw:default · /model <sonnet|opus|haiku|claude-…>',
    handler: handleModel,
  },
  // fr-103: refresh the Claude subscription credential without leaving
  // chat. Two-step gate (G2) — bare /login warns, /login confirm spawns
  // claude auth login --claudeai and surfaces the OAuth URL. The next
  // chat message from the same user is treated as the callback code.
  {
    names: ['login'],
    summary: 'Refresh the Claude subscription credential. CONTAINER-WIDE — affects all sessions. Owner+admin to run.',
    usage: '/login (warn) · /login confirm (start) · /login cancel (abort) · /login status',
    handler: handleLogin,
  },
  // bug-90: enable/disable the critic for this session — graceful
  // degradation when the critic model errors. /critic off persists
  // rec.criticModel='none' so subsequent stage-done sentinels short-
  // circuit to a synthetic skip verdict (no Gemini call). /critic on
  // restores 'gemini'. Owner+admin to mutate; anyone reads /critic
  // status (mirrors /strict + /model).
  {
    names: ['critic'],
    summary: 'Enable/disable the critic for this session. Use /critic off when the critic model keeps erroring.',
    usage: '/critic · /critic status · /critic off · /critic on',
    handler: handleCritic,
  },
  // Delm agent-n2: run the given task through a DUAL-AGENT team lane
  // (worker-A + worker-B) without switching the main session's mode. The
  // team's activity is bridged into the current chat pane tagged with
  // worker-A / worker-B (see compare-lanes.js). The main session stays a
  // plain single-agent session.
  {
    names: ['run-n2', 'run-team'],
    summary: 'Run a task through a DUAL-AGENT (worker-A + worker-B) team lane in this session',
    usage: '/run-n2 <task>',
    handler: handleRunN2,
  },
  // Multi-expert team (专家团): run the task through a team lane whose
  // roster is the session's SAVED EXPERTS (created in the Experts UI),
  // each defined by its skills (chosen from the skill market) instead of
  // the fixed STARTUP_A/B roles. Same board/queue collaboration core as
  // /run-n2. /run-experts with no args lists the saved experts.
  {
    names: ['run-experts'],
    summary: 'Run a task through the session expert team (each expert = its skills from the skill market)',
    usage: '/run-experts <task>',
    handler: handleRunExperts,
  },
  // N-path exploration (路径探索): run the task through N parallel
  // explorers (path-1..path-N), each deep-diving ONE candidate solution
  // path, coordinated decentralized via the shared board. Workers run the
  // RLM engine with a SHARED per-task Continual-Harness store, so
  // self-authored rules accumulate across workers and across runs of the
  // same task. A per-path evidence report is written to _myco_/explore/.
  // Usage: '/run-explore <task>' (default 4 paths) or '/run-explore <N> <task>' (2..512).
  {
    names: ['run-explore'],
    summary: 'Run a task through N parallel explorers, each deep-diving one candidate solution path',
    usage: '/run-explore [N] <task>',
    handler: handleRunExplore,
  },
  // Delm 双单对比: run one task through BOTH a single-agent lane and a
  // dual-agent lane simultaneously; the frontend shows them side by side
  // and a compare report is written to _myco_/compare/ when both finish.
  {
    names: ['compare'],
    summary: 'Run a task through single-agent AND dual-agent lanes simultaneously for comparison',
    usage: '/compare <task>',
    handler: handleCompare,
  },
  // delm-10 RLM mode (Recursive Language Model, modeled on Prime
  // Intellect's prime-agent: prompt-as-a-variable + programmatic
  // recursive sub-agent calling). Forms:
  //   /rlm                    — status: is this session in persistent RLM mode?
  //   /rlm on|off             — session-level toggle (alias for session on|off);
  //                            takes effect on the next respawn (rec.rlm). Owner+admin.
  //   /rlm session on|off     — explicit session-level toggle.
  //   /rlm <task>             — run ONE task through a background RLM lane now
  //                            (same shape as /run-n2 — main mode untouched).
  //   (/rlm user on|off was REMOVED — RLM is session-level only.)
  {
    names: ['rlm'],
    summary: 'RLM mode (prompt-as-a-variable + recursive sub-agents). /rlm session on|off toggles this session; /rlm <task> runs one task through an RLM lane.',
    usage: '/rlm · /rlm on · /rlm off · /rlm session on · /rlm <task>',
    handler: handleRlm,
  },
  // Research mode + domain knowledge base. Research mode is the ONLY gate
  // for KB access: a normal session never mounts the KB MCP server, never
  // injects retrieved context, and never writes knowledge back.
  //   /research                — status
  //   /research on|off         — toggle research mode for this session
  //   /kb                      — mounted KBs + service health
  //   /kb use <name>           — mount a KB (enables research mode)
  //   /kb off                  — unmount all KBs
  //   /kb search <query>       — run a retrieval and show the hits
  //   /kb notes [kind]         — list local knowledge items
  //   /kb verify|deprecate <slug>
  //   /kb rebuild              — reindex local notes from Markdown
  {
    names: ['research'],
    summary: 'Research mode: mount domain knowledge bases, auto-retrieve on each prompt, and write findings back. /research on|off.',
    usage: '/research · /research on · /research off',
    handler: handleResearch,
  },
  {
    names: ['kb'],
    summary: 'Domain knowledge base: /kb use <name> · /kb search <query> · /kb notes · /kb verify <slug> · /kb rebuild',
    usage: '/kb · /kb use <name> · /kb off · /kb search <query> · /kb notes · /kb verify <slug> · /kb rebuild',
    handler: handleKb,
  },
  {
    names: ['help'],
    summary: 'List available chat commands',
    usage: '/help',
    handler: handleHelp,
  },
];

function lookup(name) {
  const n = String(name || '').toLowerCase();
  return COMMANDS.find((c) => c.names.includes(n)) || null;
}

// Parses a chat message and returns { cmd, rest } if it's a slash command,
// else null. Also returns null for the existing /btw — that's owned by
// btw.js / shouldAskAssistant.
function parseCommand(text) {
  const m = String(text || '').match(/^\/([a-z][a-z0-9_-]{0,24})\b\s*([\s\S]*)$/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (name === 'btw') return null;        // legacy: handled elsewhere
  const cmd = lookup(name);
  if (!cmd) return null;
  return { cmd, matched: name, rest: m[2].trim() };
}

// Dispatch entry point. Returns true if the message was a known slash
// command (handled), false otherwise. ctx provides the chat reply channel.
async function dispatch(ctx, text) {
  const parsed = parseCommand(text);
  if (!parsed) return false;
  try {
    await parsed.cmd.handler({ ...ctx, args: parsed.rest, command: parsed.matched });
  } catch (err) {
    ctx.reply(`(${parsed.cmd.names[0]} failed: ${err && err.message ? err.message : 'unknown error'})`);
  }
  return true;
}

// ── individual handlers ─────────────────────────────────────────────────────

const crypto = require('crypto');

// Map from plan-item layer to the short prefix used in human-readable
// ids ("fr-7", "td-3", "bug-12"). Per-layer counter so each kind has
// its own monotonically-rising sequence.
const PLAN_LAYER_PREFIX = { Feature: 'fr', Todo: 'td', Bug: 'bug' };

// Compute the next per-layer id by scanning existing items for the
// matching prefix and taking max(N) + 1. Items with old-style hex ids
// (pre-2026-05-15) are silently ignored — they stay valid but don't
// participate in the counter scan, so new items just keep counting up
// from the highest prefixed id (or 1 if there are none yet).
function _nextPlanItemId(items, layer) {
  const prefix = PLAN_LAYER_PREFIX[layer];
  if (!prefix) return null;
  const re = new RegExp('^' + prefix + '-(\\d+)$');
  let maxN = 0;
  for (const it of items) {
    if (!it || typeof it.id !== 'string') continue;
    const m = it.id.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > maxN) maxN = n;
    }
  }
  return `${prefix}-${maxN + 1}`;
}

// Append a free-form plan item to rec.artifacts.plan.items. Used by
// /fr, /td, /bug — each pre-binds the `layer` (which the Plan tab
// groups items by) so the user just types the description.
//
// source='user' so the next "Refresh" of the plan (which re-extracts
// from the transcript and replaces the items array) preserves these
// instead of clobbering them — see the merge in artifacts.js refresh.
//
// fr-4 (2026-05-16): if the body is long (> PLAN_ITEM_REWRITE_WORD_THRESHOLD
// words) OR opt-in via a leading `!` ("/td! Auth flow is broken when …"),
// kick off an async claude rewrite that re-shapes the description into
// a tight software-issue format (problem → expected vs actual → context).
// The item is saved IMMEDIATELY with the original text so the user gets
// instant feedback; when the rewrite lands the item's text + meta is
// updated in place and broadcast via state-update. Original text is
// preserved on `meta.originalText`. Short items (≤ threshold, no `!`)
// skip the rewrite entirely — quick captures stay quick.
const PLAN_ITEM_REWRITE_WORD_THRESHOLD = 8;
function addPlanItem(ctx, layer) {
  let text = (ctx.args || '').trim();
  if (!text) {
    ctx.reply(`Usage: /<cmd> <description> — adds a ${layer} item to this session's Plan.`);
    return;
  }
  // Opt-in force-rewrite via leading `!`. The parser's regex stops at
  // `\b` after the slash-cmd name so `/td!` arrives here as args
  // starting with `!` (parseCommand splits "/td! …" → name='td',
  // rest='! …'). Strip the bang + adjacent whitespace.
  let forceRewrite = false;
  if (text.startsWith('!')) {
    forceRewrite = true;
    text = text.slice(1).trim();
    if (!text) {
      ctx.reply(`Usage: /<cmd>! <description> — adds a ${layer} item and asks claude to rewrite it into software-issue format.`);
      return;
    }
  }
  // fr-80: @<target> prefix routes to a remote GitHub repo via the
  // user's PAT instead of appending to this session's local plan.
  // Match `@<target>` as the very first token after the optional `!`.
  // Whitespace AFTER the target is the boundary; trailing text is the
  // issue body. Unknown targets bounce with a usage hint listing the
  // known ones so the user knows what's available.
  const targetMatch = text.match(/^@([a-z0-9_-]+)(\s+|$)/i);
  if (targetMatch) {
    const targetName = targetMatch[1].toLowerCase();
    let remainder = text.slice(targetMatch[0].length).trim();
    if (!REMOTE_TARGETS[targetName]) {
      const known = Object.keys(REMOTE_TARGETS).map((n) => '`@' + n + '`').join(', ') || '(none registered)';
      ctx.reply(`(unknown @target \`@${targetName}\`. Known targets: ${known}.)`);
      return;
    }
    // fr-82: `--as <alias>` after the @<target> picks a named PAT slot
    // (stored via `/setpat @<target> --as <alias> <token>`). Without
    // it, the default un-aliased slot is used (with user-level OAuth
    // fallback as before).
    let alias = null;
    const aliasMatch = remainder.match(/^--as\s+([a-z0-9_-]+)(\s+|$)/i);
    if (aliasMatch) {
      alias = aliasMatch[1].toLowerCase();
      remainder = remainder.slice(aliasMatch[0].length).trim();
    }
    const cmdName = layer === 'Feature' ? 'fr' : layer === 'Bug' ? 'bug' : 'td';
    if (!remainder) {
      ctx.reply(`Usage: /${cmdName} @${targetName}${alias ? ' --as ' + alias : ''} <description>`);
      return;
    }
    // fr-80 r5: same rewrite policy as local plan items applied to
    // remote issues — short captures (≤ 8 words, no `!`) submitted
    // verbatim; long descriptions OR explicit `!` force-rewrite got
    // the Problem/Expected/Actual rewrite via claude BEFORE the POST.
    //
    // fr-81 r1 (@kkrazy report: "the issue creation works now, but
    // it's not rewriting it to proper format before submitting the
    // issue"): remote issues now ALWAYS rewrite, regardless of word
    // count. The cost-vs-quality trade-off flips when the target is a
    // public bug tracker: a short `/fr @myco Add foo` deserves the
    // same Problem/Expected/Actual shape as a long one. Local plan
    // items still keep the threshold (quick captures stay quick) —
    // see the `shouldRewrite` re-computation a few lines below for
    // the non-remote path.
    const shouldRewrite = true;
    // Route to remote issue + return — does NOT append a local plan
    // item (the user wanted this to land on the OTHER repo).
    return handleRemoteIssue(ctx, layer, targetName, remainder, alias, shouldRewrite);
  }
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const shouldRewrite = forceRewrite || wordCount > PLAN_ITEM_REWRITE_WORD_THRESHOLD;

  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  let item;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    if (!rec) { ctx.reply('(no session record on disk — cannot persist plan item)'); return; }
    if (!rec.artifacts) rec.artifacts = {};
    if (!rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) {
      rec.artifacts.plan = { items: [], updatedAt: null };
    }
    item = {
      id: _nextPlanItemId(rec.artifacts.plan.items, layer)
        || crypto.randomBytes(6).toString('hex'),  // hex fallback if layer is unknown
      text,
      layer,
      done: false,
      addedAt: new Date().toISOString(),
      addedBy: ctx.user || 'unknown',
      source: 'user',
      voters: [],
      comments: [],
    };
    if (shouldRewrite) {
      item.meta = { rewritePending: true, rewriteRequested: forceRewrite ? 'force' : 'long' };
    }
    rec.artifacts.plan.items.push(item);
    // _persistPlanArtifact handles saveStore + the _myco_/plan.json
    // mirror + the state-update emit so /merge and (future) /dedupe
    // ride the same persistence path.
    _persistPlanArtifact(rec, sessionId);
  } catch (err) {
    ctx.reply(`(plan item failed to save: ${err.message})`);
    return;
  }
  const replyTail = shouldRewrite
    ? ' — claude is rewriting this into issue format (will update shortly)…'
    : '';
  ctx.reply(`✓ added **${layer}** \`${item.id}\` to Plan: ${text}${replyTail}`);
  if (shouldRewrite) {
    // Fire-and-forget — the persistence + broadcast on completion is
    // the user signal, not the chat reply. We don't await so the chat
    // input frees up immediately.
    _rewritePlanItemAsync(sessionId, item.id, text, layer, ctx).catch((err) => {
      console.error(`[plan-rewrite] ${sessionId} ${item.id}: ${err && err.message ? err.message : err}`);
    });
  }
}

// Issue-style rewrite prompt. Keep it short, lean, no preamble — we
// want the model to output ONLY the rewritten body, ready to land in
// rec.artifacts.plan.items[].text. The schema in the user message
// (problem / expected / actual / context) matches what a software
// engineer would look for first when triaging.
// fr-80 r6: unified rewrite prompt — produces TITLE + DESCRIPTION as
// separate fields. Used identically by local plan items and remote
// GitHub issues so both surfaces look the same.
const _PLAN_REWRITE_SYSTEM = [
  'You rewrite a short plan-item description into a tight software-engineering issue with a scannable title + a structured body.',
  '',
  'OUTPUT FORMAT — EXACTLY this shape, starting with "TITLE:":',
  '  TITLE: <one-line title, ≤ 80 chars, no markdown, no trailing period>',
  '',
  '  DESCRIPTION:',
  '  **Problem:** one sentence calling out the actual user-facing or developer-facing pain.',
  '  **Expected:** what the right behaviour or shape is.',
  '  **Actual:** what currently happens instead.',
  '  **Context:** any extra signal (file path, repro steps, env) — only if present in the input.',
  '',
  'KEEP IT TIGHT: description ≤ 4 short lines for trivial items, ≤ 10 lines for complex ones. Omit sections that don\'t apply.',
  'Preserve the user\'s domain words verbatim — do not paraphrase technical terms. No preamble, no closing remarks, no "here is the rewrite". Start with "TITLE:".',
].join('\n');

// fr-80 r6: split a rewrite response into { title, description }.
// Returns null when the response doesn't match the expected shape so
// the caller can fall back to "submit as-is" instead of mangling the
// item with malformed output.
function _parseIssueRewrite(raw) {
  if (typeof raw !== 'string') return null;
  // Strip optional ``` fences the model may wrap around.
  let s = raw.trim().replace(/^```(?:markdown)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  // Defensive against "(claude failed ...)" stand-ins.
  if (/^\(claude /.test(s)) return null;
  // Match: "TITLE: <line>" then "DESCRIPTION:" then the rest.
  const m = s.match(/^TITLE:\s*([^\n\r]+)[\r\n]+(?:\s*[\r\n])?DESCRIPTION:\s*([\s\S]+)$/i);
  if (!m) return null;
  const title = m[1].trim();
  const description = m[2].trim();
  if (!title || !description) return null;
  return { title, description };
}

async function _rewritePlanItemAsync(sessionId, itemId, originalText, layer, ctx) {
  const cwd = (ctx && ctx.absCwd) || process.cwd();
  const userPrompt = [
    `Layer: ${layer}`,
    `Original description: ${originalText}`,
    '',
    'Rewrite the description following the system prompt format.',
  ].join('\n');
  const btw = require('./btw');
  let rewritten;
  try {
    // Task B: pass the session's active gateway profile so the /fr /bug
    // rewrite runs on the same custom model the user selected via `/model gw:`.
    const sessionRec = sessionsMod.getSessionRecord(ctx.sessionId);
    rewritten = await btw.runClaudeP(cwd, `${_PLAN_REWRITE_SYSTEM}\n\n${userPrompt}`, {
      user: ctx.user,
      activeGw: sessionRec && sessionRec.activeGw,
    });
  } catch (err) {
    rewritten = null;
  }
  // _clearRewritePending updates the item under both success and failure;
  // we always need to drop the rewritePending flag so the UI's "rewriting…"
  // indicator turns off.
  _applyPlanItemRewrite(sessionId, itemId, rewritten, originalText);
}

function _applyPlanItemRewrite(sessionId, itemId, rewritten, originalText) {
  let store, rec, item;
  try {
    store = sessionsMod.loadStore();
    rec = store.sessions[sessionId];
    if (!rec || !rec.artifacts || !rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) return;
    item = rec.artifacts.plan.items.find((it) => it && it.id === itemId);
    if (!item) return;
  } catch { return; }
  if (!item.meta) item.meta = {};
  delete item.meta.rewritePending;
  // fr-80 r6: parse the TITLE/DESCRIPTION shape — title goes to
  // item.text (one-line, scannable), description to item.description
  // (markdown body). Both surfaces (local plan card + remote GitHub
  // issue) read these two fields directly so they look identical.
  const parsed = _parseIssueRewrite(rewritten);
  if (parsed) {
    item.meta.originalText = originalText;
    item.meta.rewritten = true;
    item.text = parsed.title;
    item.description = parsed.description;
  } else {
    // Fall back to the older sanitize path so a model that ignored the
    // new TITLE/DESCRIPTION shape still produces a usable single-blob
    // rewrite instead of dropping back to the original text.
    const cleanedRewrite = _sanitizePlanRewrite(rewritten);
    if (cleanedRewrite) {
      item.meta.originalText = originalText;
      item.meta.rewritten = true;
      item.text = cleanedRewrite;
    } else {
      item.meta.rewriteFailed = true;
    }
  }
  _persistPlanArtifact(rec, sessionId);
}

// Tolerate the claude-cli error stand-ins (`(claude failed to start: …)`,
// `(claude responded with no content)`, etc.) and obvious garbage —
// return null so the caller leaves the original text in place + flags
// rewriteFailed instead of overwriting the item with an error stub.
function _sanitizePlanRewrite(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\(claude /.test(trimmed)) return null;
  // Strip code fences the model may wrap around the output.
  const unfenced = trimmed.replace(/^```(?:markdown)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  if (!unfenced) return null;
  return unfenced;
}

// fr-81 Phase B.1: auto-promote a freshly-filed remote issue into a
// local plan item carrying meta.remoteUrl. This is the dedup anchor
// that fr-81 Phase A's remote-issues render will key against later
// — without an explicit link on the local item, the Plan view has
// no way to know that a remote issue and a local item are "the
// same thing". Used by both filing paths:
//   · handleIssue (/feature → repo-owner's remote)
//   · handleRemoteIssue (/fr @target, /bug @target, /td @target)
// Idempotent against duplicates: if a local item already has the
// same meta.remoteUrl, returns it unchanged.
//
// Tagged source='auto-promote' so a future Plan-tab filter can
// distinguish manually-typed `/fr` items from auto-promoted ones.
// The text is the issue title (what the user typed) — the body
// rewrite (Problem/Expected/Actual) lives upstream + the
// remoteUrl link gets the user back to it.
function _autoPromoteRemoteIssueToPlan(rec, sessionId, { layer, title, user, remoteUrl, remoteNumber, provider, owner, repo }) {
  if (!rec || !sessionId || !remoteUrl) return null;
  if (!rec.artifacts) rec.artifacts = {};
  if (!rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) {
    rec.artifacts.plan = { items: [], updatedAt: null };
  }
  // Idempotency guard — if a local item already points at this URL,
  // don't add a second one.
  const existing = rec.artifacts.plan.items.find((it) => it.meta && it.meta.remoteUrl === remoteUrl);
  if (existing) return existing;
  const crypto = require('crypto');
  const item = {
    id: _nextPlanItemId(rec.artifacts.plan.items, layer) || crypto.randomBytes(6).toString('hex'),
    text: String(title || '').slice(0, 250),
    layer,
    done: false,
    addedAt: new Date().toISOString(),
    addedBy: user || 'unknown',
    source: 'auto-promote',
    voters: [],
    comments: [],
    meta: {
      remoteUrl,
      remoteNumber: remoteNumber || null,
      remoteProvider: provider || null,
      remoteOwner: owner || null,
      remoteRepo: repo || null,
    },
  };
  rec.artifacts.plan.items.push(item);
  _persistPlanArtifact(rec, sessionId);
  return item;
}

// Persist the plan artifact + mirror to _myco_/plan.json + emit
// state-update — extracted from addPlanItem so /merge and (future)
// /dedupe write through the same path.
function _persistPlanArtifact(rec, sessionId) {
  rec.artifacts.plan.updatedAt = new Date().toISOString();
  sessionsMod.saveStore();
  try {
    const artifactsMod = require('./artifacts');
    if (artifactsMod && artifactsMod.__test && typeof artifactsMod.__test.writeArtifactToFile === 'function') {
      artifactsMod.__test.writeArtifactToFile(rec, 'plan', rec.artifacts.plan);
    }
  } catch (err) {
    console.error(`[plan-item] write _myco_/plan.json failed: ${err.message}`);
  }
  try {
    const attachMod = require('./attach');
    const session = attachMod.getSession && attachMod.getSession(sessionId);
    if (session) {
      session.emit('state-update', {
        kind: 'artifact',
        artifactType: 'plan',
        artifact: rec.artifacts.plan,
      });
    }
  } catch {}
}

// Pure merge logic. Mutates rec.artifacts.plan.items in place + returns
// the merge summary. Throws an Error with a human-readable message on
// validation failure (caller is expected to catch + surface). The
// caller is responsible for persisting + broadcasting after — see
// _persistPlanArtifact (slash handler) or persistArtifact+broadcast
// (HTTP endpoint) for the two call sites.
function mergePlanItems(rec, ids) {
  if (!Array.isArray(ids) || ids.length < 2) {
    throw new Error('need at least two ids');
  }
  if (!rec || !rec.artifacts || !rec.artifacts.plan || !Array.isArray(rec.artifacts.plan.items)) {
    throw new Error('no plan items yet — nothing to merge');
  }
  const items = rec.artifacts.plan.items;
  const lookup = new Map(items.map((it) => [it.id, it]));
  const missing = ids.filter((id) => !lookup.has(id));
  if (missing.length) {
    throw new Error(`unknown id${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }
  const layers = new Set(ids.map((id) => lookup.get(id).layer));
  if (layers.size > 1) {
    throw new Error(`cannot merge across layers — got ${[...layers].join(' + ')}`);
  }
  const layer = [...layers][0];

  // Sort the participating items by numeric suffix so the canonical
  // is the lowest-numbered. Items with hex ids (no numeric suffix)
  // sort to the end — pick the lowest-numbered prefixed id as
  // canonical if present; otherwise the first arg.
  const participants = ids.map((id) => lookup.get(id));
  participants.sort((a, b) => {
    const na = (a.id.match(/-(\d+)$/) || [])[1];
    const nb = (b.id.match(/-(\d+)$/) || [])[1];
    if (na && nb) return parseInt(na, 10) - parseInt(nb, 10);
    if (na) return -1;
    if (nb) return 1;
    return 0;
  });
  const canonical = participants[0];
  const others = participants.slice(1);

  // Append other bodies to canonical.text with a clear divider naming
  // each source. Existing canonical.text stays at the top.
  const divider = '\n\n— merged from ';
  for (const o of others) {
    canonical.text = `${canonical.text}${divider}\`${o.id}\` (added by @${o.addedBy || 'unknown'}): ${o.text}`;
  }
  // mergedFrom is cumulative across repeated /merge calls so the
  // chain of provenance survives.
  const prior = Array.isArray(canonical.mergedFrom) ? canonical.mergedFrom : [];
  canonical.mergedFrom = [...prior, ...others.map((o) => o.id)];

  // Drop the merged-away items from items[].
  const dropIds = new Set(others.map((o) => o.id));
  rec.artifacts.plan.items = items.filter((it) => !dropIds.has(it.id));

  return {
    canonical,
    absorbed: others.map((o) => o.id),
    layer,
  };
}

// /merge <id1> <id2> [<id3>…] — collapse the listed plan items (same
// layer) into the lowest-numbered canonical. Delegates the actual
// mutation to mergePlanItems; this handler just parses the args,
// catches validation errors, and replies in chat.
function handleMerge(ctx) {
  const raw = (ctx.args || '').trim();
  if (!raw) {
    ctx.reply('Usage: `/merge <id1> <id2> [<id3>…]` — collapse 2+ plan items of the same layer into the lowest-numbered one.');
    return;
  }
  const ids = raw.split(/\s+/).filter(Boolean);
  if (ids.length < 2) {
    ctx.reply('(/merge needs at least two ids — e.g. `/merge td-3 td-7`)');
    return;
  }
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  let result;
  try {
    result = mergePlanItems(rec, ids);
  } catch (err) {
    ctx.reply(`(${err.message})`);
    return;
  }
  _persistPlanArtifact(rec, sessionId);
  ctx.reply(`✓ merged ${result.absorbed.length + 1} **${result.layer}** items into \`${result.canonical.id}\` (absorbed: ${result.absorbed.map((id) => '`' + id + '`').join(', ')})`);
}

// Read project context that the dedupe LLM should consider alongside
// the bare item text — CLAUDE.md and the auto-memory dir. Both are
// truncated to MAX_CONTEXT_BYTES each so the overall prompt stays
// manageable. Returns the formatted block (possibly empty).
const MAX_CONTEXT_BYTES = 4096;
function _loadProjectContext(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const sections = [];
  // CLAUDE.md sits at the cwd root by convention.
  try {
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    const txt = fs.readFileSync(claudeMdPath, 'utf8');
    const slice = txt.length > MAX_CONTEXT_BYTES
      ? txt.slice(0, MAX_CONTEXT_BYTES) + '\n…(truncated)'
      : txt;
    sections.push('## Project CLAUDE.md (project-specific instructions)\n\n' + slice);
  } catch {}
  // Auto-memory lives at ~/.claude/projects/<encoded-cwd>/memory/. The
  // index file MEMORY.md is the most useful single read — it lists
  // each memory file with a one-line hook. Inline the index then a few
  // of the linked entries up to the byte budget.
  try {
    // Same encoding the SDK uses for ~/.claude/projects/<encoded-cwd>/
    // (sessions.encodeCwdForClaude). Both separators must be normalised:
    // on Windows a raw `C:\Users\me\proj` produces a path segment
    // containing ':', which mkdir cannot create.
    const encoded = sessionsMod.encodeCwdForClaude(cwd);
    const memDir = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
    const indexPath = path.join(memDir, 'MEMORY.md');
    const indexTxt = fs.readFileSync(indexPath, 'utf8');
    let memBlock = '## Project auto-memory index\n\n' + indexTxt;
    // Append the bodies of each linked .md until the budget is hit.
    let used = memBlock.length;
    const linkRe = /\(([\w_-]+\.md)\)/g;
    let m;
    const seen = new Set();
    while ((m = linkRe.exec(indexTxt))) {
      const fname = m[1];
      if (seen.has(fname)) continue;
      seen.add(fname);
      try {
        const body = fs.readFileSync(path.join(memDir, fname), 'utf8');
        const trimmed = body.length > 800 ? body.slice(0, 800) + '\n…(truncated)' : body;
        const entry = `\n\n### memory/${fname}\n\n${trimmed}`;
        if (used + entry.length > MAX_CONTEXT_BYTES) break;
        memBlock += entry;
        used += entry.length;
      } catch {}
    }
    sections.push(memBlock);
  } catch {}
  return sections.length ? sections.join('\n\n---\n\n') : '';
}

// LLM-driven dedupe scan. Pure — does NOT mutate the rec/artifact, only
// returns the proposal. Shape:
//   { groups: [{ ids: [...], reason: '<one-line>' }], skipped?, error?, raw? }
// `skipped` indicates the LLM wasn't called (e.g. <2 eligible items).
// `error` indicates the LLM call/response failed.
//
// Prompt enrichment (2026-05-15): the project's CLAUDE.md and the
// auto-memory directory are inlined before the item list so claude can
// use project-specific synonyms, conventions, and past decisions when
// deciding whether two items refer to the same underlying concern.
async function dedupePlanItems(items, cwd, gw = {}) {
  const eligible = (items || []).filter((it) => it && it.id && PLAN_LAYER_PREFIX[it.layer]);
  if (eligible.length < 2) {
    return { groups: [], skipped: 'fewer than 2 eligible items (need prefixed ids in Feature/Todo/Bug)' };
  }
  const byLayer = { Feature: [], Todo: [], Bug: [] };
  for (const it of eligible) {
    if (byLayer[it.layer]) byLayer[it.layer].push(it);
  }
  const sections = [];
  for (const layer of ['Feature', 'Todo', 'Bug']) {
    if (!byLayer[layer].length) continue;
    sections.push(`### ${layer}`);
    for (const it of byLayer[layer]) {
      sections.push(`- ${it.id}: ${it.text.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
    sections.push('');
  }
  const context = _loadProjectContext(cwd);
  const promptBody = [
    'You are looking at a plan-item list. Identify GROUPS of items that are similar or related enough that they should be merged into a single canonical item. Only group items within the same layer (Feature/Todo/Bug); never cross layers.',
    '',
    'Use the project context below to resolve project-specific synonyms, conventions, and past decisions before deciding what counts as "similar enough" — two items framed differently may refer to the same underlying concern.',
    '',
    'Return STRICT JSON only — no preamble, no markdown fences. Schema:',
    '{ "groups": [ { "ids": ["td-3","td-7"], "reason": "<one-line reason citing the project context when applicable>" } ] }',
    'If no merges are warranted, return: { "groups": [] }',
    '',
    context ? '# Project context\n\n' + context + '\n\n' : '',
    '# Plan items',
    '',
    sections.join('\n'),
  ].join('\n');

  const btw = require('./btw');
  let raw;
  try {
    // Task B: pass the session's active gateway profile so /dedupe uses the
    // same custom model selected via /model gw:.
    raw = await btw.runClaudeP(cwd || process.cwd(), promptBody, gw);
  } catch (err) {
    return { groups: [], error: 'claude call failed: ' + err.message };
  }
  if (/^\(claude /.test(raw)) {
    return { groups: [], error: raw };
  }
  let parsed;
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(stripped);
  } catch {
    return { groups: [], error: 'claude response was not valid JSON', raw: raw.slice(0, 1500) };
  }
  const groups = Array.isArray(parsed && parsed.groups) ? parsed.groups : [];
  // Validate each group: ids must all exist in eligible + share a layer.
  const eligibleIds = new Set(eligible.map((it) => it.id));
  const layerById = new Map(eligible.map((it) => [it.id, it.layer]));
  const valid = [];
  for (const g of groups) {
    const gids = Array.isArray(g && g.ids) ? g.ids.filter((id) => eligibleIds.has(id)) : [];
    if (gids.length < 2) continue;
    const layers = new Set(gids.map((id) => layerById.get(id)));
    if (layers.size !== 1) continue;
    valid.push({ ids: gids, reason: String((g && g.reason) || '').slice(0, 200) });
  }
  return { groups: valid };
}

// /dedupe — slash command wrapper. Calls dedupePlanItems and formats
// the result as a chat reply with ready-to-paste `/merge <id1> <id2>`
// commands. No auto-apply.
async function handleDedupe(ctx) {
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  const store = sessionsMod.loadStore();
  const rec = store.sessions[sessionId];
  const items = (rec && rec.artifacts && rec.artifacts.plan && Array.isArray(rec.artifacts.plan.items))
    ? rec.artifacts.plan.items : [];
  const eligible = items.filter((it) => it && it.id && PLAN_LAYER_PREFIX[it.layer]);
  if (eligible.length < 2) {
    ctx.reply('(/dedupe needs at least two plan items with prefixed ids — `/fr` `/td` `/bug` add them as `fr-N` / `td-N` / `bug-N`)');
    return;
  }
  ctx.reply('🔍 asking claude to scan for dedupe candidates… (one moment)');
  const result = await dedupePlanItems(items, ctx.absCwd, { user: ctx.user, activeGw: rec && rec.activeGw });
  if (result.error) {
    if (result.raw) {
      ctx.reply([
        `(/dedupe: ${result.error}; raw reply below)`,
        '',
        '```',
        result.raw,
        '```',
      ].join('\n'));
    } else {
      ctx.reply(`(/dedupe: ${result.error})`);
    }
    return;
  }
  if (!result.groups.length) {
    ctx.reply('✓ no merge candidates found — the plan items look distinct enough.');
    return;
  }
  const lines = [`Found **${result.groups.length}** dedupe candidate${result.groups.length === 1 ? '' : 's'}. To merge, copy + run the corresponding line:`];
  for (const g of result.groups) {
    lines.push('');
    lines.push(`- ${g.reason || '(no reason)'}`);
    lines.push(`  \`/merge ${g.ids.join(' ')}\``);
  }
  ctx.reply(lines.join('\n'));
}

function handleFeature(ctx) {
  return handleIssue(ctx, { kind: 'feature', labels: ['enhancement'] });
}

// /add2plan — claude breaks the user's description into a list of
// todos / feature requests and appends them to this session's
// plan.json via the Edit tool. Items can carry an optional
// dependsOn: [id, ...] field for ordering constraints.
//
// Why route through claude instead of doing the breakdown server-
// side: it's a reasoning task. claude has the context of the
// conversation and the existing plan items to decompose well; a
// regex parser can't.
function handleAdd2Plan(ctx) {
  const text = (ctx.args || '').trim();
  if (!text) {
    ctx.reply('Usage: `/add2plan <description>` — claude breaks it into todos + FRs and appends them to the Plan (with optional `dependsOn` for ordering).');
    return;
  }
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  // Read the existing plan to suggest the next free id ranges in
  // the prompt — saves claude a round-trip on id enumeration.
  let nextTd = 1, nextFr = 1;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[sessionId];
    const items = (rec && rec.artifacts && rec.artifacts.plan && rec.artifacts.plan.items) || [];
    for (const it of items) {
      if (typeof it.id !== 'string') continue;
      const tdM = it.id.match(/^td-(\d+)$/);
      const frM = it.id.match(/^fr-(\d+)$/);
      if (tdM) nextTd = Math.max(nextTd, parseInt(tdM[1], 10) + 1);
      if (frM) nextFr = Math.max(nextFr, parseInt(frM[1], 10) + 1);
    }
  } catch {}
  // Build the prompt — claude calls mcp__myco__add_plan_items
  // (server-side appender) instead of editing plan.json directly.
  // The tool handles id generation + persistence + broadcast; we
  // just describe the schema claude should pass.
  const prompt = [
    `[/add2plan] Break the following request into discrete plan items, then call the \`mcp__myco__add_plan_items\` tool to append them.`,
    ``,
    `Tool input shape:`,
    `  {`,
    `    "items": [`,
    `      {`,
    `        "text": "<1-2 sentence description>",`,
    `        "layer": "Todo" | "Feature" | "Bug",`,
    `        "dependsOn": ["td-3", ...]    // OPTIONAL, only when ordering is required`,
    `      },`,
    `      ...`,
    `    ]`,
    `  }`,
    ``,
    `Guidance:`,
    `- Prefer 1-7 short items over many over-decomposed ones.`,
    `- Use \`dependsOn\` sparingly. Most items should have NO dependsOn.`,
    `- Server auto-generates ids (td-N / fr-N / bug-N); you only supply text/layer/dependsOn.`,
    `- Existing items are preserved — the tool only appends.`,
    ``,
    `Request: ${text}`,
  ].join('\n');
  // Inject into the SDK's user-message queue via session.write.
  // Claude will receive it as a normal user turn.
  try {
    const attachMod = require('./attach');
    const session = attachMod.getSession && attachMod.getSession(sessionId);
    if (!session || typeof session.write !== 'function') {
      ctx.reply('(no live agent session — try sending a message to wake it up, then re-run `/add2plan`)');
      return;
    }
    session.write(prompt);
    ctx.reply(`▶ asked claude to expand into plan items (next ids: td-${nextTd}, fr-${nextFr}). Watch the Plan tab — items will appear once claude finishes the Edit tool call.`);
  } catch (err) {
    ctx.reply(`(/add2plan failed: ${err.message})`);
  }
}

// /task /tasks — forward a "show your TaskList" prompt to the running
// Claude session. The agent's CLAUDE.md task-list etiquette teaches
// claude what to do with these phrasings (no @myco prefix any more —
// every chat message reaches claude as a normal user turn, so we just
// send the natural-language directive).
function handleTaskList(ctx) {
  if (!ctx.session || !ctx.session.alive) {
    ctx.reply('(/task: session not running)');
    return;
  }
  ctx.session.write('Please list your current pending and in-progress internal tasks (TaskList). Format as a short numbered list with id + subject.');
}

// /skip <N> / /cancel <N> — forward a "dismiss task N" prompt. If the
// arg isn't a numeric id, bounce with a usage hint instead of forwarding
// garbage.
function handleTaskSkip(ctx) {
  const name = (ctx && ctx.command) || 'skip';
  const arg = String((ctx && ctx.args) || '').trim();
  if (!/^\d+$/.test(arg)) {
    ctx.reply(
      `Usage: \`/${name} <task-id>\` — tells the running Claude to dismiss the given internal task ` +
      `(TaskUpdate → status=deleted). Use \`/task\` first to see ids.`,
    );
    return;
  }
  if (!ctx.session || !ctx.session.alive) {
    ctx.reply(`(/${name}: session not running)`);
    return;
  }
  ctx.session.write(`Please dismiss internal task #${arg} via TaskUpdate({ taskId, status: 'deleted' }) and reply with one line confirming.`);
}

// fr-80: file an issue on a registered REMOTE_TARGETS repo using the
// user's stored token (per-repo PAT preferred, GitHub OAuth fallback).
// Distinct from handleIssue (which uses the session's git remote) —
// here the target is a fixed repo unrelated to the session's cwd, so
// no `git remote get-url` is run.
async function handleRemoteIssue(ctx, layer, targetName, description, alias, shouldRewrite) {
  let target = REMOTE_TARGETS[targetName];
  if (!target) {                 // defensive — caller already validated
    ctx.reply(`(unknown @target \`@${targetName}\`)`);
    return;
  }
  // `@myco` follows the CURRENT session project. The user works on their
  // own codehub/gitee/github repo and expects `/fr @myco` (and /bug, /td)
  // to file AGAINST THAT project, not the hardcoded GitHub kkrazy/myco.
  // Detect the session remote first; fall back to the fixed GitHub target
  // only when no remote resolves (e.g. a session with no git origin).
  if (targetName === 'myco') {
    const host = await gitHosts.detectHost(ctx.absCwd);
    if (host && host.provider && host.owner && host.repo) {
      target = { ...target, provider: host.provider, owner: host.owner, repo: host.repo };
    }
  }
  const labels = REMOTE_LABEL_BY_LAYER[layer] || [];
  const cmdName = layer === 'Feature' ? 'fr' : layer === 'Bug' ? 'bug' : 'td';
  const aliasSuffix = alias ? ' --as ' + alias : '';
  // fr-80 r5: rewrite into Problem/Expected/Actual format via claude
  // (same _PLAN_REWRITE_SYSTEM prompt that local plan items use).
  // Sync await — the user submits the slash command, gets feedback
  // when the issue lands. Failure leaves the original description in
  // place + flags `(rewrite failed — submitted as-is)` so the issue
  // still gets filed.
  let issueBody = String(description);
  let issueTitle = null;          // fr-80 r6: set when rewrite parsed cleanly
  let rewriteNote = '';
  if (shouldRewrite) {
    try {
      const btw = require('./btw');
      const cwd = ctx.absCwd || process.cwd();
      const userPrompt = [
        `Layer: ${layer}`,
        `Original description: ${description}`,
        '',
        'Rewrite the description following the system prompt format.',
      ].join('\n');
      // Task B: run the remote-issue rewrite on the session's active gateway
      // profile (same custom model as the main agent).
      const sessionRec = sessionsMod.getSessionRecord(ctx.sessionId);
      const rewritten = await btw.runClaudeP(cwd, `${_PLAN_REWRITE_SYSTEM}\n\n${userPrompt}`, {
        user: ctx.user,
        activeGw: sessionRec && sessionRec.activeGw,
      });
      // fr-80 r6: parse the TITLE/DESCRIPTION shape directly — keeps
      // the GitHub issue title and body in lockstep with the local plan
      // item's text/description (same source, same parse).
      const parsed = _parseIssueRewrite(rewritten);
      if (parsed) {
        issueTitle = parsed.title;
        issueBody = parsed.description;
        rewriteNote = ' _(body rewritten by claude)_';
      } else {
        const cleaned = _sanitizePlanRewrite(rewritten);
        if (cleaned) {
          issueBody = cleaned;
          rewriteNote = ' _(rewrite returned non-standard shape — used as-is)_';
        } else {
          rewriteNote = ' _(rewrite failed — submitted as-is)_';
        }
      }
    } catch (err) {
      rewriteNote = ` _(rewrite errored: ${err.message} — submitted as-is)_`;
    }
  }
  // Title: prefer the parsed TITLE field from the rewrite (fr-80 r6).
  // Fall back to first-line-of-body extraction when the rewrite was
  // skipped or didn't parse — same scannable-title behavior as before.
  let title;
  if (issueTitle) {
    title = issueTitle.length > 80 ? issueTitle.slice(0, 77) + '…' : issueTitle;
  } else {
    const firstLine = String(issueBody).split(/[\r\n]/, 1)[0]
      .replace(/^\*+|\*+$/g, '')
      .replace(/^\s*\*\*(.+?):\*\*\s*/, '$1: ')
      .trim();
    title = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
  }
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const body = [
    issueBody,
    '',
    '---',
    `Filed by **@${ctx.user}** via [myco](https://myco.labxnow.ai/) (\`/${cmdName} @${targetName}${aliasSuffix}\`) on ${ts} UTC.${rewriteNote}`,
  ].join('\n');
  const token = gitHosts.getToken(ctx.user, target.provider, target.owner, target.repo, alias);
  if (!token) {
    // fr-82: when the user explicitly asked for an alias and it isn't
    // stored, list the aliases that ARE so they can correct the
    // typo (e.g. asked for --as labxnow but stored under --as labxnow1).
    if (alias) {
      const known = gitHosts.listAliases(ctx.user, target.provider, target.owner, target.repo);
      const knownStr = known.length ? known.map((a) => '`' + a + '`').join(', ') : '(none)';
      ctx.reply(
        `(no PAT stored under alias \`${alias}\` for @${targetName} (${target.owner}/${target.repo}). ` +
        `Aliases on file: ${knownStr}. Save one with \`/setpat @${targetName} --as ${alias} <token>\`.)`
      );
      return;
    }
    const providerLabel = _PROVIDER_LABEL[target.provider] || target.provider;
    // Per-provider "where do I get a token" guidance — codehub is an
    // intranet GitLab-family host, so it has no OAuth flow here and
    // users create a PAT in their CodeHub profile.
    let guidance;
    if (target.provider === 'codehub') {
      guidance = 'Generate a PAT in your CodeHub profile settings (scope: `api`) and';
    } else if (target.provider === 'gitee') {
      guidance = 'Generate a PAT at https://gitee.com/profile/personal_access_tokens (scope: `issues`) and';
    } else {
      guidance = 'Sign in via GitHub OAuth to get a user-level token, or';
    }
    ctx.reply(
      `(no ${providerLabel} token on file for @${ctx.user} for ${target.owner}/${target.repo}. ` +
      `${guidance} ` +
      `run \`/setpat @${targetName} <token>\` from any session.)`
    );
    return;
  }
  const result = await gitHosts.createIssue({
    provider: target.provider, token, owner: target.owner, repo: target.repo, title, body, labels,
  });
  if (result.error) {
    const label = _PROVIDER_LABEL[target.provider] || target.provider;
    // fr-80 r2: GitHub 403 "Resource not accessible by personal access
    // token" almost always means the token's scope is insufficient for
    // issues:write on this repo (common with OAuth tokens missing the
    // `repo` scope, fine-grained PATs without per-repo Issues access,
    // or org-level restrictions on third-party OAuth apps). Make the
    // fix path obvious in the error reply.
    if (target.provider === 'github' && result.status === 403) {
      // fr-80 r3: include the actual OAuth scopes GitHub reports in
      // X-OAuth-Scopes + the required scopes from X-Accepted-OAuth-
      // Scopes. Lets the user see literally what's missing rather
      // than guess between "old grant", "org restriction", and "wrong
      // PAT type" by trial.
      const have = result.scopes || '(none reported)';
      const need = result.acceptedScopes || '(POST /issues needs `repo` for private repos, `public_repo` for public)';
      const hasRepo = /\brepo\b/.test(result.scopes || '');
      const hasPub  = /\bpublic_repo\b/.test(result.scopes || '');
      // fr-80 r4: when scopes come back empty, probe the token by
      // hitting GET /user. Three possible signals:
      //   (a) probe succeeds + login present → token is ALIVE but
      //       has no OAuth scopes attached (the grant at the user-
      //       app level was revoked, or the token was issued for a
      //       different OAuth app). Fix = re-authorize the OAuth
      //       grant (NOT a fresh sign-in flow).
      //   (b) probe fails → token is DEAD (revoked/expired). Fix =
      //       full sign-out + re-sign-in.
      // We only run the probe in the empty-scopes case to avoid an
      // extra round-trip on the common "missing repo scope" path.
      let probeLine = '';
      if (!have || have === '(none reported)') {
        try {
          const u = await gitHosts.fetchUser({ provider: 'github', token });
          probeLine = `Token IS alive (resolves to github user **${u.login}**) but reports zero OAuth ` +
            `scopes. That usually means the OAuth grant for myco was REVOKED at the user-app level ` +
            `(github.com/settings/applications → myco) — the access token survives revoke but loses ` +
            `its scope grants. Re-authorizing via re-sign-in restores them.`;
        } catch (probeErr) {
          probeLine = `Token is DEAD (GET /user also failed: ${probeErr.message}). The OAuth token was ` +
            `revoked or expired. Sign out (status-bar user chip) and sign back in.`;
        }
      }
      const scopeLine = hasRepo || hasPub
        ? `Your token DOES carry \`repo\`-family scopes (have: ${have}), so this 403 likely means an ` +
          `org-level OAuth restriction or repo Issues being disabled.`
        : `Your token is missing the \`repo\` scope (have: ${have}; endpoint needs: ${need}). ` +
          `Re-sign-in to refresh the OAuth grant.`;
      ctx.reply(
        `(GitHub 403 — your stored token can't write issues on ${target.owner}/${target.repo}.\n\n` +
        `${scopeLine}\n` +
        (probeLine ? probeLine + '\n\n' : '\n') +
        `Fix paths:\n` +
        `  1. **Re-sign-in via GitHub** at the top-right user chip — refreshes the OAuth ` +
        `grant with the current \`repo\` scope. Most common fix.\n` +
        `  2. **Check the OAuth grant** at https://github.com/settings/applications — ` +
        `confirm myco has access to ${target.owner}/${target.repo} (org-level restrictions ` +
        `can block third-party OAuth apps per-repo). If you see myco listed there but it ` +
        `says "0 organizations · 0 repositories", click it and grant access.\n` +
        `  3. **Classic PAT override** — generate one at ` +
        `https://github.com/settings/tokens/new?scopes=repo and run ` +
        `\`/setpat @${targetName} <token>\` from any session.\n` +
        `  4. **Verify Issues are enabled** on ${target.owner}/${target.repo} (Settings → ` +
        `General → Features). 403 also fires when Issues are turned off.)`
      );
      return;
    }
    ctx.reply(`(${label} error: ${result.error}${result.status ? ` [HTTP ${result.status}]` : ''})`);
    return;
  }
  // fr-81 Phase B.1: auto-promote the remote issue into a local plan
  // item carrying meta.remoteUrl. Creates the dedup anchor that the
  // Plan-view's remote-issues render will key against (Phase B.2:
  // a remote issue with htmlUrl matching this local item's
  // meta.remoteUrl gets folded into the local row rather than shown
  // separately). Best-effort: a failure here logs but doesn't
  // change the user-facing "filed" reply.
  try {
    const sessionId = ctx.sessionId;
    const rec = sessionId ? sessionsMod.loadStore().sessions[sessionId] : null;
    if (rec) {
      _autoPromoteRemoteIssueToPlan(rec, sessionId, {
        layer, title: description, user: ctx.user,
        remoteUrl: result.url, remoteNumber: result.number,
        provider: target.provider, owner: target.owner, repo: target.repo,
      });
    }
  } catch (err) {
    console.error(`[fr-81 Phase B.1] auto-promote failed for ${result.url}: ${err.message}`);
  }
  ctx.reply(`✓ Filed ${layer.toLowerCase()} **#${result.number}** on ${target.owner}/${target.repo}${alias ? ' (alias `' + alias + '`)' : ''}: ${result.url}`);
}

async function handleIssue(ctx, { kind, labels }) {
  const title = ctx.args && ctx.args.trim();
  if (!title) {
    ctx.reply(`Usage: /${kind} <title>\nExample: /${kind} add dark mode toggle`);
    return;
  }
  // Detect provider from the session's git remote BEFORE the token check —
  // the error message is more useful when we can tell the user "set a gitee
  // token" vs. "set a github token".
  const host = await gitHosts.detectHost(ctx.absCwd);
  if (!host) {
    ctx.reply(
      `(could not detect a github.com / gitee.com / codehub-dg-g.huawei.com remote for this session's cwd: ${ctx.absCwd}. ` +
      `\`/${kind}\` requires \`git remote get-url origin\` to point at one of those hosts.)`
    );
    return;
  }
  // Per-repo PAT first (set via /setpat), then user-level OAuth token as
  // fallback (only github has one — gitee has no OAuth flow yet).
  const token = gitHosts.getToken(ctx.user, host.provider, host.owner, host.repo);
  if (!token) {
    const providerLabel = _PROVIDER_LABEL[host.provider] || host.provider;
    let guidance;
    if (host.provider === 'codehub') {
      guidance = 'Generate a PAT in your CodeHub profile settings (scope: `api`)';
    } else if (host.provider === 'gitee') {
      guidance = 'Generate a PAT at https://gitee.com/profile/personal_access_tokens (scope: `issues`)';
    } else {
      guidance = 'Sign out and back in via GitHub to refresh the OAuth token (must include `repo` scope)';
    }
    ctx.reply(
      `(no ${providerLabel} token on file for @${ctx.user} for ${host.owner}/${host.repo}. ` +
      `${guidance}, ` +
      `or run \`/setpat <token>\` to save a per-repo PAT.)`
    );
    return;
  }
  const body = [
    title,
    '',
    '---',
    `Filed by **@${ctx.user}** via [myco](https://myco.labxnow.ai/) on ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC.`,
  ].join('\n');
  const result = await gitHosts.createIssue({
    provider: host.provider,
    token, owner: host.owner, repo: host.repo, title, body, labels,
  });
  if (result.error) {
    const label = _PROVIDER_LABEL[host.provider] || host.provider;
    ctx.reply(`(${label} error: ${result.error}${result.status ? ` [HTTP ${result.status}]` : ''})`);
    return;
  }
  // fr-81 Phase B.1: auto-promote into a local plan item carrying
  // meta.remoteUrl (see _autoPromoteRemoteIssueToPlan). Layer is
  // derived from kind: /feature → Feature, /bug → Bug, /td → Todo.
  // Best-effort: failure logs but doesn't break the user-facing
  // "filed" reply.
  try {
    const sessionId = ctx.sessionId;
    const rec = sessionId ? sessionsMod.loadStore().sessions[sessionId] : null;
    if (rec) {
      const layer = kind === 'bug' ? 'Bug' : kind === 'td' ? 'Todo' : 'Feature';
      _autoPromoteRemoteIssueToPlan(rec, sessionId, {
        layer, title, user: ctx.user,
        remoteUrl: result.url, remoteNumber: result.number,
        provider: host.provider, owner: host.owner, repo: host.repo,
      });
    }
  } catch (err) {
    console.error(`[fr-81 Phase B.1] auto-promote failed for ${result.url}: ${err.message}`);
  }
  ctx.reply(`✓ Filed ${kind} request #${result.number} on ${host.owner}/${host.repo}: ${result.url}`);
}

// /setpat <token>
//
// Saves a personal access token for THIS SESSION's repo. The provider
// (github / gitee) and the owner/repo are auto-detected from the
// session's git remote — the user just pastes their token.
//
// Each (user, repo) pair gets exactly one PAT. Re-running /setpat
// overwrites the previous one. The user-level OAuth token (set by the
// GitHub login flow) stays in place as a fallback for any GitHub repo
// without a per-repo PAT.
//
// We validate the token by hitting the provider's /user endpoint before
// persisting — so a typo or wrong-provider paste surfaces immediately,
// not on the next /feature.
// fr-82: /listpat [@<target>] — show what PAT slots exist for the
// caller for a given repo. Helps the user remember which aliases
// they've stashed + which one is the un-aliased default. Doesn't
// reveal the tokens themselves (just the slot names).
async function handleListPat(ctx) {
  const args = String(ctx.args || '').trim();
  // Parse optional @<target>; otherwise auto-detect from session repo.
  let host = null;
  let scopeLabel;
  const targetMatch = args.match(/^@([a-z0-9_-]+)\s*$/i);
  if (targetMatch) {
    const targetName = targetMatch[1].toLowerCase();
    if (!REMOTE_TARGETS[targetName]) {
      const known = Object.keys(REMOTE_TARGETS).map((n) => '`@' + n + '`').join(', ') || '(none registered)';
      ctx.reply(`(unknown @target \`@${targetName}\`. Known targets: ${known}.)`);
      return;
    }
    const t = REMOTE_TARGETS[targetName];
    host = { provider: t.provider, owner: t.owner, repo: t.repo };
    scopeLabel = `@${targetName} (${t.owner}/${t.repo})`;
  } else if (!args) {
    host = await gitHosts.detectHost(ctx.absCwd);
    if (!host) {
      ctx.reply(
        `(no github.com / gitee.com / codehub-dg-g.huawei.com remote in this session's cwd. ` +
        `Use \`/listpat @<target>\` to inspect aliases for a registered remote target.)`
      );
      return;
    }
    scopeLabel = `${host.owner}/${host.repo}`;
  } else {
    ctx.reply(`Usage: /listpat   OR   /listpat @<target>`);
    return;
  }
  const aliases = gitHosts.listAliases(ctx.user, host.provider, host.owner, host.repo);
  // Default-slot existence check (un-aliased PAT, set via plain /setpat).
  // We don't expose getToken's return value (the token itself); just
  // check whether the default slot has anything stored. Easiest way:
  // call getToken with no alias, and see if it returned non-null AND
  // we know we have a per-repo PAT (vs falling back to user-level).
  // For UX simplicity we just report "default slot: set/unset" by
  // looking at the in-memory store directly via listAliases's sibling
  // pattern — but to keep the API surface small, we just report the
  // aliased slots. User-level OAuth fallback is documented separately.
  const lines = [`**Stored PATs for ${scopeLabel}** (user: @${ctx.user}):`];
  if (aliases.length === 0) {
    lines.push(`  (no aliased PATs)`);
  } else {
    for (const a of aliases) lines.push(`  • \`${a}\`  → use with \`--as ${a}\``);
  }
  // Hint: user-level OAuth fallback (github / codehub).
  if (host.provider === 'github') {
    const userLevelToken = gitHosts.getToken(ctx.user, 'github');
    if (userLevelToken) {
      lines.push(`  • _user-level GitHub OAuth token also present (default fallback when no per-target or aliased PAT)._`);
    }
  } else if (host.provider === 'codehub') {
    const userLevelToken = gitHosts.getToken(ctx.user, 'codehub');
    if (userLevelToken) {
      lines.push(`  • _user-level CodeHub token also present (default fallback when no per-target or aliased PAT)._`);
    }
  }
  ctx.reply(lines.join('\n'));
}

async function handleSetPat(ctx) {
  let args = String(ctx.args || '').trim();
  if (!args) {
    ctx.reply(
      `Usage: /setpat <token>  OR  /setpat @<target> [--as <alias>] <token>\n` +
      `Saves a PAT for this session's repo (no @target) or for a registered remote target (\`@myco\`, \`@codehub\`, ...).\n` +
      `\`--as <alias>\` stores under a named alias so multiple PATs (e.g. work / personal accounts) can ` +
      `coexist for the same target. Pick which one to use per command via \`/fr @<target> --as <alias>\`.\n` +
      `Provider for session form is auto-detected from \`git remote get-url origin\` (github.com, gitee.com, or codehub-dg-g.huawei.com).\n` +
      `For Gitee, generate a PAT at https://gitee.com/profile/personal_access_tokens (scope: \`issues\`).\n` +
      `For CodeHub, generate a PAT in your CodeHub profile settings (scope: \`api\`).`
    );
    return;
  }
  // fr-80 r2: `/setpat @<target> <token>` saves a PAT scoped to a
  // REMOTE_TARGETS entry without needing a session pointed at that
  // repo. Solves the bootstrap problem: a user who wants to file
  // /fr @myco issues but works mostly in OTHER repos couldn't
  // previously set a per-repo PAT for kkrazy/myco because /setpat
  // demanded a session pointing at the target.
  let target = null;
  const targetMatch = args.match(/^@([a-z0-9_-]+)(\s+|$)/i);
  if (targetMatch) {
    const targetName = targetMatch[1].toLowerCase();
    if (!REMOTE_TARGETS[targetName]) {
      const known = Object.keys(REMOTE_TARGETS).map((n) => '`@' + n + '`').join(', ') || '(none registered)';
      ctx.reply(`(unknown @target \`@${targetName}\`. Known targets: ${known}.)`);
      return;
    }
    target = { name: targetName, ...REMOTE_TARGETS[targetName] };
    args = args.slice(targetMatch[0].length).trim();
  }
  // fr-82: `--as <alias>` after the @<target> (or session form) names
  // the storage slot so multiple PATs can coexist for the same repo.
  // Alias must match [a-z0-9_-]{1,32} (defensive — the slot key is
  // built from it).
  let alias = null;
  const aliasMatch = args.match(/^--as\s+([a-z0-9_-]+)(\s+|$)/i);
  if (aliasMatch) {
    alias = aliasMatch[1].toLowerCase();
    args = args.slice(aliasMatch[0].length).trim();
  }
  const token = args;
  if (!token) {
    ctx.reply(`(missing token after @${target ? target.name : '<target>'} — paste the PAT after the @target.)`);
    return;
  }
  if (token.length < 8) {
    ctx.reply(`(token looks too short — did you paste a placeholder?)`);
    return;
  }
  // Resolve provider+owner+repo: either from REMOTE_TARGETS (remote
  // form) or from the session's git remote (session form).
  let host;
  if (target) {
    host = { provider: target.provider, owner: target.owner, repo: target.repo };
  } else {
    host = await gitHosts.detectHost(ctx.absCwd);
    if (!host) {
      ctx.reply(
        `(no github.com / gitee.com / codehub-dg-g.huawei.com remote in this session's cwd: ${ctx.absCwd}. ` +
        `\`/setpat\` saves a PAT scoped to the current repo; make sure ` +
        `\`git remote get-url origin\` points at one of those hosts, ` +
        `OR use \`/setpat @<target> <token>\` to scope by remote target.)`
      );
      return;
    }
  }
  let profile;
  try { profile = await gitHosts.fetchUser({ provider: host.provider, token }); }
  catch (err) {
    ctx.reply(`(${host.provider} rejected the token: ${err.message})`);
    return;
  }
  try { gitHosts.setRepoToken(ctx.user, host.provider, host.owner, host.repo, token, alias); }
  catch (err) {
    ctx.reply(`(could not save token: ${err.message})`);
    return;
  }
  // fr-105: auto-derive + store the gitee login from the token we just
  // validated. Gitee's HTTPS auth requires the credential username to
  // match the token's owning account (unlike github which ignores it).
  // Bug-91 introduced the storage slot (rec.giteeLogin) + the
  // /setgiteelogin slash command — but that's an EXTRA step the user
  // has to know to take. Since fetchUser already returned profile.login,
  // we can just persist it here so the credential helper picks it up
  // automatically on the next push. Guarded on getGiteeLogin returning
  // null (nothing stored yet) so an operator-set value from an earlier
  // explicit /setgiteelogin is NEVER clobbered.
  //
  // Gitee-only: github's helper output is unconditionally
  // `username=x-access-token` (github's convention), so there's no
  // reason to touch giteeLogin for a github /setpat.
  let autoStoredGiteeLogin = null;
  if (host.provider === 'gitee' && profile && profile.login) {
    try {
      const existing = gitHosts.getGiteeLogin(ctx.user);
      if (!existing) {
        gitHosts.setGiteeLogin(ctx.user, profile.login);
        autoStoredGiteeLogin = profile.login;
      }
    } catch (err) {
      // Non-fatal — the PAT is already saved. Log and move on so the
      // user still sees the ✓ Saved confirmation.
      console.error(`[fr-105] auto-store gitee login failed for ${ctx.user}: ${err.message}`);
    }
  }
  const scopeLabel = target ? `@${target.name} (${host.owner}/${host.repo})` : `${host.owner}/${host.repo}`;
  // fr-82: when an alias is set, the user picks it explicitly per
  // command via `--as <alias>`. Spell that out so the user knows
  // the next-step syntax.
  const aliasReplyTail = alias
    ? ` under alias **\`${alias}\`**. Use it with \`/fr ${target ? '@' + target.name : ''} --as ${alias} <text>\`.`
    : `. \`/fr\`, \`/bug\`, \`/td\`, \`/feature\` will use it.`;
  // fr-105: mention the auto-store in the reply ONLY when it fired.
  // The bare confirmation stays byte-identical to bug-91-era for the
  // github path + the "operator already set a login" path (so those
  // callers see no reply-shape change).
  const giteeLoginTail = autoStoredGiteeLogin
    ? ` Also saved gitee login **\`${autoStoredGiteeLogin}\`** so \`git push\` / \`git fetch\` work via the credential helper without a separate \`/setgiteelogin\` step.`
    : '';
  ctx.reply(
    `✓ Saved ${host.provider} PAT for ${scopeLabel} ` +
    `(validated as ${host.provider}:${profile.login})` + aliasReplyTail +
    giteeLoginTail,
  );
}

// bug-91: /setgiteelogin — save the operator's gitee account login so
// the git credential helper (scripts/git-credential-myco.sh) emits the
// correct username= line. Pre-bug-91 the helper hard-coded
// "username=x-access-token" for every provider — fine for github (which
// ignores the username), but gitee validates it against the token's
// owning account and rejects mismatches with a misleading 403.
//
//  /setgiteelogin <login>       → owner+admin; persist user-level login
//  /setgiteelogin --clear       → owner+admin; delete the stored login,
//                                 fall back to the myco-user default
//
// Per-repo overrides aren't exposed via slash command (yet) — hand-edit
// /data/git-tokens.json for the exotic case where different repos need
// different logins. §8 rule 3: no speculative multi-arg surface.
async function handleSetGiteeLogin(ctx) {
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/setgiteelogin: session not found)');
    return;
  }
  if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    ctx.reply(`(/setgiteelogin is owner-or-admin only. Session owner is @${rec.user}.)`);
    return;
  }
  const args = String((ctx && ctx.args) || '').trim();
  if (!args) {
    const current = gitHosts.getGiteeLogin(ctx.user) || `(unset — helper falls back to \`${ctx.user}\`)`;
    ctx.reply(
      `Current gitee login for @${ctx.user}: **\`${current}\`**\n\n` +
      `Usage: \`/setgiteelogin <login>\` — sets your gitee account login (e.g. \`kkrazy\`).\n` +
      `\`/setgiteelogin --clear\` — remove the stored login, fall back to your myco-user (\`${ctx.user}\`).\n\n` +
      `The credential helper (\`scripts/git-credential-myco.sh\`) uses this as the \`username=\` line ` +
      `when git pushes/fetches gitee.com over HTTPS. Without it, pushes fail with the misleading 403 ` +
      `\`The token username invalid\` even though the token itself is valid.`
    );
    return;
  }
  if (args === '--clear' || args === '-c' || args === 'clear') {
    try { gitHosts.setGiteeLogin(ctx.user, ''); }
    catch (err) { ctx.reply(`(could not clear gitee login: ${err.message})`); return; }
    ctx.reply(`✓ Cleared stored gitee login for @${ctx.user}. The credential helper will fall back to your myco-user (\`${ctx.user}\`).`);
    return;
  }
  // Basic sanity — gitee login is `[a-zA-Z0-9_-]{2,32}` in practice.
  // Reject inputs that obviously aren't a login (spaces, URL fragments,
  // paste-a-token-by-mistake attempts).
  if (!/^[a-zA-Z0-9._-]{2,50}$/.test(args)) {
    ctx.reply(
      `(that doesn't look like a gitee login — expected letters/digits/dot/hyphen/underscore, 2–50 chars. ` +
      `If you meant to store a PAT, use \`/setpat <token>\` instead.)`
    );
    return;
  }
  try { gitHosts.setGiteeLogin(ctx.user, args); }
  catch (err) { ctx.reply(`(could not save gitee login: ${err.message})`); return; }
  ctx.reply(
    `✓ Saved gitee login **\`${args}\`** for @${ctx.user}. ` +
    `Subsequent \`git push\` / \`git fetch\` against gitee.com will use this as the credential helper's \`username=\` line.`
  );
}

// /decide <n> — answer the currently-pending dialog by sending its option
// number to the running Claude PTY. The dialog was previously detected by
// the MenuInterceptor in pty.js, which posted its options into the chat as
// an assistant message and stashed the menu on session.pendingMenu.
async function handleDecide(ctx) {
  const raw = (ctx.args || '').trim();
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    ctx.reply('Usage: `/decide <n>` — pick the option number from the most recent dialog. e.g. `/decide 1`.');
    return;
  }
  // PERSIST answered state on the latest menu chat message regardless
  // of whether session.pendingMenu is still live — see handleMenuPick
  // in pty.js for the rationale (post-restart clicks were no-op'ing
  // because pendingMenu was in-memory only).
  let stampedLabel = null;
  try {
    const store = sessionsMod.loadStore();
    const rec = store.sessions[ctx.sessionId];
    if (rec && Array.isArray(rec.chat)) {
      for (let i = rec.chat.length - 1; i >= 0; i--) {
        const m = rec.chat[i];
        if (!m || !m.meta || m.meta.kind !== 'menu') continue;
        if (m.meta.answered) break;
        const opts = (m.meta.menu && m.meta.menu.options) || [];
        const match = opts.find((o) => o.n === n);
        if (!match) break;
        m.meta.answered = true;
        m.meta.pickedN = n;
        sessionsMod.saveStore();
        stampedLabel = match.label || '';
        break;
      }
    }
  } catch {}

  // Agent-mode session: route the pick through resolveMenuPick (which
  // resolves the pending canUseTool promise), not through PTY bytes.
  // PTY-mode keeps the legacy digit + CR write.
  const session = ctx.session;
  const pending = session && session.alive ? session.pendingMenu : null;
  if (pending && Array.isArray(pending.options) && pending.options.some((o) => o.n === n)) {
    if (session.mode === 'agent' && typeof session.resolveMenuPick === 'function' && pending.hash) {
      session.resolveMenuPick(pending.hash, n);
    } else {
      // Claude Code's menus accept digit + Enter to commit.
      session.write(String(n) + '\r');
      session.pendingMenu = null;
    }
  } else if (!stampedLabel) {
    // Nothing to do — no live menu AND no persisted menu carried option n.
    ctx.reply(`(option ${n} isn't a valid choice on any recent dialog.)`);
    return;
  }
  const label = stampedLabel || (pending && pending.options.find((o) => o.n === n) || {}).label || '';
  ctx.reply(`✓ picked option ${n}${label ? ': ' + label : ''}`);
}

function validatePattern(pattern) {
  if (!pattern) return 'pattern is empty';
  const m = pattern.match(/^([A-Za-z_]\w*)(?:\(([^)]*)\))?$/);
  if (!m) return 'pattern must look like `Tool` or `Tool(arg)` or `Tool(arg:*)`';
  return null;
}

async function handleAllow(ctx) {
  const pattern = (ctx.args || '').trim();
  const err = validatePattern(pattern);
  if (err) { ctx.reply(`Usage: \`/allow <pattern>\` — ${err}.`); return; }
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(no session record found)'); return; }
  permissions.addAllow(rec, pattern);
  ctx.reply(`✓ added \`${pattern}\` to the allow list. Send \`try again\` in chat to retry the previously-denied tool.`);
}

async function handleDeny(ctx) {
  const pattern = (ctx.args || '').trim();
  const err = validatePattern(pattern);
  if (err) { ctx.reply(`Usage: \`/deny <pattern>\` — ${err}.`); return; }
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(no session record found)'); return; }
  permissions.addDeny(rec, pattern);
  ctx.reply(`🚫 added \`${pattern}\` to the deny list.`);
}

async function handleAllowList(ctx) {
  const lists = permissions.getSessionLists(ctx.sessionId);
  const out = ['**Permission lists for this session:**'];
  out.push('');
  out.push('Allow:');
  if (lists.allowList.length) out.push(...lists.allowList.map((p) => `  • \`${p}\``));
  else out.push('  (empty)');
  out.push('');
  out.push('Deny:');
  if (lists.denyList.length) out.push(...lists.denyList.map((p) => `  • \`${p}\``));
  else out.push('  (empty)');
  out.push('');
  out.push('Anything not matching allow (and not matching deny) is auto-rejected.');
  out.push('Use `/allow <pattern>` or `/deny <pattern>` to mutate.');
  ctx.reply(out.join('\n'));
}

// /clear — wipe rec.chat for this session and broadcast a chat-clear
// state-update so every attached client wipes its local chat list. The
// confirmation reply lands AFTER the clear, so the chat ends up holding
// just that one row. The user's own "/clear" line was appended by
// pty.handleChatMessage immediately before dispatch fired, but it's
// part of rec.chat which we're about to empty — so it disappears too.
function handleClear(ctx) {
  const sessionId = ctx.sessionId;
  if (!sessionId) { ctx.reply('(no session context — slash command dropped)'); return; }
  // fr-86: arg parser — `/clear` (legacy, wipes rec.chat, anyone) vs
  // `/clear new` (preserves rec.chat, restarts SDK conversation, owner
  // + admin only). Case-insensitive trim so `/clear NEW`, `/clear new `
  // all hit the new path.
  const arg = String((ctx && ctx.args) || '').trim().toLowerCase();
  if (arg === 'new') {
    // Owner+admin gate (mirror /strict's fr-39 model). The restart
    // resets Claude's working memory across the whole session — viewers
    // shouldn't be able to do that to the owner's work.
    if (!sessionsMod.isOwnerOrAdmin(sessionId, ctx.user)) {
      const rec = sessionsMod.getSessionRecord(sessionId);
      const ownerLabel = rec ? `@${rec.user}` : '(unknown)';
      ctx.reply(`(/clear new is owner-or-admin only. Session owner is ${ownerLabel}.)`);
      return;
    }
    // Resolve the live AgentSession (preferred via ctx.session, fall
    // back to attach.getSession for unit-test contexts that only pass
    // a minimal ctx). If there's no live session, the user's effectively
    // already on a fresh slate — just mark the record + reply.
    let session = ctx.session || null;
    if (!session) {
      try { session = require('./attach').getSession(sessionId); } catch {}
    }
    if (!session || typeof session.requestRestart !== 'function') {
      try { sessionsMod.markSessionForRestart(sessionId); } catch {}
      ctx.reply('✓ session marked for restart. The next message will spawn a fresh Claude conversation.');
      return;
    }
    const result = session.requestRestart();
    // 2026-11-11 RLM fix: requestRestart nulls sdkSessionId (fresh Claude
    // conversation) but keeps the SAME AgentSession object — pre-fix the
    // fresh conversation still ran whatever engine the session was BORN
    // with, so `/rlm on` + `/clear new` silently stayed plain. Re-sync the
    // live engine to rec.rlm after the restart so the fresh conversation
    // runs the engine the record says (ensureLiveSession's branch logic,
    // applied in-place — attached clients keep their session object).
    // Note: setRlmMode(true) also fires the first-turn nudge, so an RLM
    // /clear new opens with the kernel state read.
    try {
      const rec = sessionsMod.getSessionRecord(sessionId);
      if (rec) sessionsMod.applyRlmModeToLiveSession(sessionId, rec);
    } catch {}
    // Customize the success reply with the actual @user instead of
    // the @USER placeholder the AgentSession uses (it doesn't know
    // which slashcmd invocation triggered it).
    const replyMsg = (result.kind === 'executed')
      ? `✓ session restarted by @${ctx.user}. Earlier history preserved — scroll up to load it. Claude starts fresh.`
      : result.message;
    ctx.reply(replyMsg);
    return;
  }
  if (arg) {
    // Anything other than 'new' is unknown — emit a usage hint instead
    // of silently falling through to the legacy clear (which would be
    // surprising — the user typed something with intent).
    ctx.reply(`(/clear: unknown mode \`${arg}\`. Usage: \`/clear\` (wipe chat history) · \`/clear new\` (restart session, keep history — owner+admin only))`);
    return;
  }
  // Legacy path: wipe rec.chat. Anyone can use.
  let cleared = 0;
  try {
    cleared = sessionsMod.clearChatHistory(sessionId);
  } catch (err) {
    ctx.reply(`(failed to clear chat: ${err.message})`);
    return;
  }
  // bug-92: /clear must ALSO drop the other sources that re-render the
  // wiped text on attach, or an F5 brings it all back. rec.chat alone was
  // not enough — there are three more:
  //   1. session.buffer — the SDK event tail `_shipAgentReplay` replays
  //      on every attach/reconnect.
  //   2. `<cwd>/_myco_/events.jsonl` — re-hydrated back into session.buffer
  //      by _hydrateBufferFromDisk on a (reaper) restart. (Myco's own
  //      append log; documented safe to delete — NOT claude's `--resume`
  //      transcript, which we deliberately leave untouched.)
  //   3. The transcript watcher's backfill (persistAssistantTextToChat)
  //      re-copies old assistant prose into rec.chat on a fresh attach —
  //      gated by the rec.chatClearAt marker below (filtered in attach.js).
  // Clearing only rec.chat left paths 2-3 resurrecting the text.
  const fs = require('fs');
  const path = require('path');
  try {
    const rec = sessionsMod.getSessionRecord(sessionId);
    if (rec) rec.chatClearAt = new Date().toISOString();
    // Prefer ctx.session (passed by attach.handleChatMessage) and fall
    // back to attach.getSession(id) so the slash-todo-inject-style unit
    // tests, which only supply { sessionId, absCwd, reply }, still
    // observe a no-op instead of a crash.
    let session = ctx.session || null;
    if (!session) {
      try { session = require('./attach').getSession(sessionId); } catch {}
    }
    const evFile = session && session._eventsFile
      ? session._eventsFile
      : (rec && rec.absCwd ? path.join(rec.absCwd, '_myco_', 'events.jsonl') : null);
    if (evFile && fs.existsSync(evFile)) {
      try { fs.truncateSync(evFile, 0); } catch {}
    }
    if (session) {
      session.buffer = [];                       // nothing to replay on attach
      session.emit('state-update', { kind: 'chat-clear' });
    }
    if (rec) sessionsMod.saveStore();
  } catch {}
  ctx.reply(`✓ cleared ${cleared} chat message${cleared === 1 ? '' : 's'}`);
}

// fr-39: /admin @user (grant), /admin -@user (revoke), /admin (list).
// Owner-only — the gate is intentional: owner stays sovereign over
// the trust graph; admins cannot promote other admins. Args are
// parsed permissively (`@user`, `user`, `-@user`, `-user` all
// accepted) so the user doesn't have to remember the exact form.
function handleAdmin(ctx) {
  const sessionsMod = require('./sessions');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/admin: session not found)');
    return;
  }
  // Owner-only gate. ctx.user comes from the WS attach (set in
  // attach.js's WS upgrade) and matches the same login compared by
  // sessionBelongsToUser.
  if (rec.user !== ctx.user) {
    ctx.reply(`(/admin is owner-only. Session owner is @${rec.user}.)`);
    return;
  }
  const arg = String((ctx && ctx.args) || '').trim();
  // No args → list current admins (no-op informational).
  if (!arg) {
    const admins = sessionsMod.getSessionAdmins(ctx.sessionId);
    if (!admins.length) {
      ctx.reply('No admins on this session yet. `/admin @user` to grant; `/admin -@user` to revoke. Owner stays @' + rec.user + '.');
    } else {
      const list = admins.map((u) => '@' + u).join(', ');
      ctx.reply(`Admins on this session: ${list}. Owner: @${rec.user}. \`/admin -@user\` to revoke.`);
    }
    return;
  }
  // Parse: leading "-" means revoke; otherwise grant. Strip optional
  // "@" prefix from the username so `/admin @bob`, `/admin bob`,
  // `/admin -@bob`, `/admin -bob` all work.
  let revoke = false;
  let target = arg;
  if (target.startsWith('-')) {
    revoke = true;
    target = target.slice(1).trim();
  }
  if (target.startsWith('@')) target = target.slice(1).trim();
  if (!target || !/^[A-Za-z0-9_-]+$/.test(target)) {
    ctx.reply('Usage: `/admin @user` (grant), `/admin -@user` (revoke), or `/admin` (list).');
    return;
  }
  // Can't admin the owner (redundant) and can't admin yourself if
  // you're not the owner (the owner-only gate above already blocked
  // that path, but be explicit for the self-grant misclick).
  if (target === rec.user) {
    ctx.reply(`(@${target} is the owner — already has all privileges.)`);
    return;
  }
  // bug-17 fix: reject the assistant user. ASSISTANT_USER ('claude')
  // is myco's internal speaker; granting it admin is meaningless
  // (it's not a real github login, can't authenticate) and confusing
  // (the bot's confirmation reply could be misread). Apply on BOTH
  // grant and revoke paths so the symmetric typo is caught.
  if (target === ASSISTANT_USER) {
    ctx.reply(`(/admin: cannot ${revoke ? 'revoke' : 'grant'} the assistant user (@${target}). Pick a real github login.)`);
    return;
  }
  // bug-17 fix: reject targets not in the invitation allowlist. Only
  // enforce when auth is required (isAuthRequired() === true) — in
  // single-user dev mode there's no allowlist concept. This prevents
  // rec.admins from accumulating logins that can never log in. Skip
  // for the revoke path so the owner can always clean up a previously-
  // granted but now-removed-from-allowlist user.
  const auth = require('./auth');
  if (!revoke && auth.isAuthRequired() && !auth.isAllowed(target)) {
    ctx.reply(`(/admin: @${target} is not in the invitation allowlist (allowed-github-users.txt). Run \`./deploy.sh --allow-github-user ${target}\` first, then retry.)`);
    return;
  }
  if (revoke) {
    const removed = sessionsMod.removeAdminFromSession(ctx.sessionId, target);
    ctx.reply(removed
      ? `✓ @${target} is no longer an admin on this session.`
      : `(@${target} wasn't an admin — nothing to revoke.)`);
  } else {
    const added = sessionsMod.addAdminToSession(ctx.sessionId, target);
    ctx.reply(added
      ? `✓ @${target} is now an admin on this session. Inherits everything except delete-session + grant/revoke admin (those stay owner-only).`
      : `(@${target} is already an admin — no change.)`);
  }
}

// fr-87: /share @a @b @c (grant read-only viewer access),
// /share -@user (revoke), /share (list). Owner-only — mirrors /admin's
// trust-graph sovereignty model. Viewers can see the session in their
// sidebar + read transcripts/chat, but cannot drive claude, cannot
// /admin or /share, cannot delete. Promoting to /admin supersedes
// viewer (handled by addViewerToSession in sessions.js).
//
// Multi-user: a single `/share @alice @bob @carol` invocation grants
// all three at once, each with its own reply line, so the user can
// share a session with a whole group in one chat message (matches the
// fr-87 title).
function handleShare(ctx) {
  const sessionsMod = require('./sessions');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/share: session not found)');
    return;
  }
  // Owner-only gate (same as /admin). Admins inherit non-trust-graph
  // controls per fr-39, but grant/revoke of viewers is a trust-graph
  // mutation — owner stays sovereign.
  if (rec.user !== ctx.user) {
    ctx.reply(`(/share is owner-only. Session owner is @${rec.user}.)`);
    return;
  }
  const arg = String((ctx && ctx.args) || '').trim();
  // No args → list current viewers + visibility status.
  if (!arg) {
    const viewers = sessionsMod.getSessionViewers(ctx.sessionId);
    const admins = sessionsMod.getSessionAdmins(ctx.sessionId);
    if (!viewers.length && !admins.length) {
      ctx.reply('This session is **private** — only @' + rec.user + ' (owner) can see it. `/share @user` to grant read-only; `/admin @user` for read+write.');
    } else {
      const lines = ['Session visibility: **shared**. Owner: @' + rec.user + '.'];
      if (admins.length) lines.push('Admins (read+write): ' + admins.map((u) => '@' + u).join(', '));
      if (viewers.length) lines.push('Viewers (read-only): ' + viewers.map((u) => '@' + u).join(', '));
      lines.push('`/share -@user` to revoke a viewer; `/admin -@user` to revoke an admin.');
      ctx.reply(lines.join('\n'));
    }
    return;
  }
  // Parse: split on whitespace into tokens. Each token may be a grant
  // (`@user` / `user`) or a revoke (`-@user` / `-user`). Mixed batches
  // are fine — `/share @alice -@bob @carol` is interpreted left-to-
  // right with per-token reply lines.
  const tokens = arg.split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    ctx.reply('Usage: `/share @user [@user ...]` (grant), `/share -@user` (revoke), or `/share` (list).');
    return;
  }
  const auth = require('./auth');
  const replies = [];
  for (const tokRaw of tokens) {
    let revoke = false;
    let target = tokRaw;
    if (target.startsWith('-')) {
      revoke = true;
      target = target.slice(1).trim();
    }
    if (target.startsWith('@')) target = target.slice(1).trim();
    if (!target || !/^[A-Za-z0-9_-]+$/.test(target)) {
      replies.push(`(skipped \`${tokRaw}\` — not a valid github login)`);
      continue;
    }
    if (target === rec.user) {
      replies.push(`(@${target} is the owner — already has all privileges.)`);
      continue;
    }
    // Reject the assistant pseudo-user on BOTH paths (mirrors /admin's
    // bug-17 fix — granting `claude` is meaningless and confusing).
    if (target === ASSISTANT_USER) {
      replies.push(`(cannot ${revoke ? 'revoke' : 'grant'} the assistant user (@${target}). Pick a real github login.)`);
      continue;
    }
    // Allowlist gate on grants only (revoke must always work so the
    // owner can clean up a previously-granted but now-removed-from-
    // allowlist user).
    if (!revoke && auth.isAuthRequired() && !auth.isAllowed(target)) {
      replies.push(`(@${target} is not in the invitation allowlist (allowed-github-users.txt). Run \`./deploy.sh --allow-github-user ${target}\` first, then retry.)`);
      continue;
    }
    if (revoke) {
      const removed = sessionsMod.removeViewerFromSession(ctx.sessionId, target);
      replies.push(removed
        ? `✓ @${target} no longer has read-only access to this session.`
        : `(@${target} wasn't a viewer — nothing to revoke.)`);
    } else {
      // Disambiguation: if target is already an admin, addViewer
      // returns false (admin supersedes). Surface that clearly so the
      // owner doesn't think the grant silently failed.
      const admins = sessionsMod.getSessionAdmins(ctx.sessionId);
      if (admins.includes(target)) {
        replies.push(`(@${target} is already an admin on this session — admin supersedes viewer, no change.)`);
        continue;
      }
      const added = sessionsMod.addViewerToSession(ctx.sessionId, target);
      replies.push(added
        ? `✓ @${target} now has read-only access to this session. They can see chat + transcripts but cannot drive claude.`
        : `(@${target} is already a viewer — no change.)`);
    }
  }
  ctx.reply(replies.join('\n'));
}

// fr-38: /strict on / /strict off / /strict (status). Owner + admin
// can flip (admins inherit per fr-39). When ON, handleChatMessage
// blocks any claude-bound chat message that lacks a [run:plan#<id>]
// marker, with a one-shot reply explaining how to unblock.
// fr:model-gateway — /model is the POPUP-ONLY command for switching the
// model gateway used by this session. Bare `/model` (or any stray typed
// suffix, which is IGNORED — no model override, no 400) opens the picker
// popover. The popup is the single control surface: rows switch via the
// internal `/model gw:<name>` signal, and the ACTIVE gateway profile's
// `model` (or the system .env default) governs the effective model. The
// old per-session `/model <id>` override is RETIRED.
function handleModel(ctx) {
  const gatewaysMod = require('./gateways');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/model: session not found)');
    return;
  }
  const arg = String((ctx && ctx.args) || '').trim();

  // The per-session model override is RETIRED — the active gateway governs
  // the effect model. Purge any lingering rec.modelOverride (from the old
  // feature or a stray `/model <anything>` input) so it can't override the
  // gateway model on the next query.
  if (rec.modelOverride) {
    rec.modelOverride = null;
    sessionsMod.saveStore();
  }
  // The running AgentSession carries its OWN copy of modelOverride,
  // snapshotted from rec at spawn — clearing rec alone does NOT clear it.
  // A stale instance value (e.g. "ds" from the old feature) would still
  // force sdkOpts.model on the next query. Nuke the live copy too.
  if (ctx.session && ctx.session.modelOverride) {
    ctx.session.modelOverride = null;
  }

  // Popup-internal switch signal: `/model gw:default` resets THIS SESSION to
  // the system default, `/model gw:<name>` opts THIS SESSION into a saved
  // per-user profile. The choice is per-session (rec.activeGw), NOT the
  // legacy per-user `active` pointer — a brand-new session always starts on
  // the system .env gateway until the user manually switches here, and a
  // switch in one session never leaks into another.
  const gwMatch = arg.match(/^gw:(.+)$/i);
  if (gwMatch) {
    const gwName = gwMatch[1].trim();
    if (/^default$/i.test(gwName)) {
      rec.activeGw = null;
      if (ctx.session) ctx.session.activeGw = null;   // live instance mirror
      sessionsMod.saveStore();
      _emitGatewayChanged(ctx.session, rec);
      ctx.reply('✓ Gateway reset to system default. Next reply uses the default gateway.');
    } else {
      const prof = gatewaysMod.getProfile(rec.user, gwName);
      if (!prof) {
        ctx.reply(`(no such saved gateway profile: \`${gwName}\`)`);
        return;
      }
      rec.activeGw = gwName;
      if (ctx.session) ctx.session.activeGw = gwName; // live instance mirror
      sessionsMod.saveStore();
      _emitGatewayChanged(ctx.session, rec);
      ctx.reply(`✓ Active gateway set to \`${gwName}\`. Next reply uses it.`);
    }
    // A `gw:` selection is a CHOICE — do NOT re-open the picker here. The
    // client closed it on click/Enter; re-emitting a model-picker update
    // would pop it right back open ("Enter 确定后弹窗没有完全关闭").
    // Only the bare `/model` open-command emits the picker (further down).
    return;
  }

  // Bare /model (or any other typed suffix, ignored) → open the picker and
  // report THIS SESSION's active gateway + its configured model
  // ("按设置显示"). The active is rec.activeGw (per-session), NOT the legacy
  // per-user `active`.
  const gwList = gatewaysMod.listProfiles(rec.user);
  const activeGw = rec.activeGw || null;
  const activeProf = (gwList && (gwList.profiles || [])).find((p) => p.name === activeGw);
  // Show model AND request address (请求地址) so the user sees both what
  // model and which base URL the next query will hit ("按设置显示 + 请求地址也加一下").
  const gwLabel = activeProf
    ? `\`${activeProf.name}\`${activeProf.model ? ` (model \`${activeProf.model}\`)` : ' (system model)'}`
      + (activeProf.baseUrl ? ` · base \`${activeProf.baseUrl}\`` : '')
    : `\`default\` (system .env → \`${process.env.ANTHROPIC_BASE_URL || 'system gateway'}\`)`;
  ctx.reply(`**Active gateway:** ${gwLabel}\n\nUse the picker popup (now open) to switch profiles, or **＋ Manage** to add / edit locally.`);
  // Mark the SESSION's active choice in the picker payload (not listProfiles'
  // legacy per-user active) so the popup's ✓ reflects this session.
  if (gwList) gwList.active = activeGw;
  _emitModelPicker(ctx.session, gwList);
}

// Fire the model-picker state-update with the user's gateway list so the
// client opens (or refreshes) the picker popover. `current` is always null
// now — the effective model is governed purely by the active gateway.
function _emitModelPicker(session, gwList) {
  if (session && typeof session.emit === 'function') {
    session.emit('state-update', {
      kind: 'model-picker',
      current: null,
      supported: SUPPORTED_MODELS,
      gateway: gwList,
      // The system default base URL (state/.env), so the client can show it
      // for the `default` choice ("请求地址也加一下").
      systemBase: process.env.ANTHROPIC_BASE_URL || '',
    });
  }
}

// fr:model-gateway — broadcast the ACTIVE gateway's model + base URL after
// a `/model gw:` switch so the client can refresh its cached
// _activeGatewayModel / _activeGatewayBase ("按设置显示"). The typed switch
// does NOT reopen the picker (a gw: selection is a choice, not a request to
// reopen), so without this the session card kept showing the OLD gateway's
// model/base ("切换模型没有及时生效" display half). `default` carries the
// system .env base + null model.
function _emitGatewayChanged(session, rec) {
  if (!session || typeof session.emit !== 'function') return;
  const gatewaysMod = require('./gateways');
  let model = null, baseUrl = '';
  if (rec.activeGw) {
    const prof = gatewaysMod.getProfile(rec.user, rec.activeGw);
    if (prof) { model = prof.model || null; baseUrl = prof.baseUrl || ''; }
  } else {
    baseUrl = process.env.ANTHROPIC_BASE_URL || '';
  }
  session.emit('state-update', { kind: 'gateway-changed', model, baseUrl });
}

// fr-103: refresh the Claude subscription credential.
//
//  /login                 → warn + show status; require explicit confirm.
//  /login confirm         → owner+admin only; spawn claude auth login,
//                           post URL to chat. Next chat message from the
//                           same user gets piped as the callback code
//                           (routed in attach.js handleChatMessage BEFORE
//                           the slash dispatcher fires).
//  /login cancel          → kill any pending subprocess.
//  /login status          → quick status (pending / no pending).
//
// G2 gate (analyze-stage A4): the confirm step itself is the gate. We
// don't ALSO require a confirm-within-window mark — the explicit
// `confirm` argument IS the confirmation. Simpler, no per-session
// timer to manage, no race window.
//
// Container-wide side-effect: refreshing rewrites
// `~/.claude/.credentials.json`, which the SDK reads per-invocation
// across EVERY session in this container. The user-facing reply
// makes that visible.
function handleLogin(ctx) {
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/login: session not found)');
    return;
  }
  const claudeAuth = require('./claude-auth');
  const arg = String((ctx && ctx.args) || '').trim().toLowerCase();
  const session = ctx.session;

  // Always-available read-only branches first.
  if (arg === 'status') {
    if (claudeAuth.hasPendingLogin(ctx.sessionId)) {
      const entry = claudeAuth.getPendingLogin(ctx.sessionId);
      const ageSec = Math.floor((Date.now() - entry.startTs) / 1000);
      ctx.reply(`A login flow is in progress (${ageSec}s ago, started by @${entry.owner || 'unknown'}). Reply with the OAuth callback code, or \`/login cancel\` to abort.`);
    } else {
      ctx.reply('No login flow in progress. `/login confirm` to start one.');
    }
    return;
  }

  if (arg === 'cancel') {
    if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
      ctx.reply(`(/login cancel is owner-or-admin only. Session owner is @${rec.user}.)`);
      return;
    }
    const killed = claudeAuth.cancelLogin(ctx.sessionId);
    ctx.reply(killed
      ? '✓ Pending login flow cancelled.'
      : '(no login flow was pending — nothing to cancel.)'
    );
    return;
  }

  // Mutating branches: owner+admin only.
  if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    ctx.reply(`(/login confirm is owner-or-admin only. Session owner is @${rec.user}. Bare \`/login status\` is open to everyone.)`);
    return;
  }

  if (arg !== 'confirm') {
    // Bare /login (or anything that isn't an alias) — warn.
    ctx.reply(
      '⚠ `/login` refreshes the Claude subscription credential for the WHOLE container — every session attached to this myco container will pick up the new credential on its next iteration.\n\n' +
      'Run `/login confirm` to proceed. You will get back an OAuth URL; paste the callback code as your next chat message. `/login cancel` aborts at any time.'
    );
    return;
  }

  // /login confirm — go.
  if (claudeAuth.hasPendingLogin(ctx.sessionId)) {
    ctx.reply('(a login flow is already pending — reply with the callback code, or `/login cancel` first.)');
    return;
  }

  let entry;
  try {
    entry = claudeAuth.startLogin(ctx.sessionId, {
      owner: ctx.user,
      onUrl: (url) => {
        if (url) {
          // meta.kind:'login-prompt' lets the chat-pane render the URL
          // as a clickable link + show an inline "paste code" hint.
          ctx.reply(
            `🔑 Open this URL to sign in, then paste the callback code as your next chat message:\n\n${url}\n\n(You have ${Math.floor(claudeAuth.DEFAULT_TIMEOUT_MS / 60000)} minutes. \`/login cancel\` to abort.)`,
            { meta: { kind: 'login-prompt', url } }
          );
        } else {
          ctx.reply(
            `(claude auth login printed no URL within ${Math.floor(claudeAuth.URL_WAIT_MS / 1000)}s. ` +
            'Either the CLI is broken on this host, or it changed its output format. ' +
            '`/login cancel` to abort.)'
          );
        }
      },
      onResult: ({ ok, exitCode, stdout, stderr, durationMs }) => {
        const reply = ok
          ? `✓ Credential refreshed (took ${(durationMs / 1000).toFixed(1)}s). All sessions in this container will pick up the new auth on their next iteration.`
          : `✗ Login failed (exit ${exitCode}, ${(durationMs / 1000).toFixed(1)}s).` +
            (stderr ? `\n\nstderr (tail):\n\`\`\`\n${stderr}\n\`\`\`` : '') +
            (stdout && !stderr ? `\n\nstdout (tail):\n\`\`\`\n${stdout}\n\`\`\`` : '');
        if (session && typeof session.emit === 'function') {
          // emit a state-update so the client clears the login-prompt
          // input row immediately, even if the chat reply is delayed.
          session.emit('state-update', { kind: 'login-result', ok, exitCode });
        }
        // Use a fresh reply rather than ctx.reply (the slash-dispatch
        // closure may have been garbage-collected by the time the
        // subprocess exits). Append via sessionsMod directly.
        const replyMsg = {
          user: ASSISTANT_USER,
          text: reply,
          ts: new Date().toISOString(),
        };
        sessionsMod.appendChatMessage(ctx.sessionId, replyMsg);
        if (session && typeof session.emit === 'function') {
          session.emit('chat', replyMsg);
        }
      },
    });
  } catch (err) {
    ctx.reply(`(/login confirm: failed to spawn — ${err && err.message ? err.message : err})`);
    return;
  }
  ctx.reply('Starting `claude auth login --claudeai`… the OAuth URL will arrive in a moment.');
}

// bug-90: enable/disable the critic for this session.
//
//  /critic               → same as /critic status — read current state.
//  /critic status        → reply with the current critic model + how
//                          to flip it. Open to everyone.
//  /critic off           → owner+admin only; persist rec.criticModel='none',
//                          emit state-update 'critic-model-changed' so any
//                          open config admin panel re-renders.
//  /critic on            → owner+admin only; persist rec.criticModel='gemini'
//                          (the system default; if you prefer codex/custom,
//                          set it via the config admin panel which writes
//                          the same field).
//
// The 'none' value is recognised by getCritic() (server/src/critics/index.js)
// and triggerGeminiCritique short-circuits when critic.disabled === true.
// State machine transitions to awaiting_accept directly via the synthetic
// skip-verdict path, so the verdict pane gets an ✓ Accept Stage button
// and the user can advance.
function handleCritic(ctx) {
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/critic: session not found)');
    return;
  }
  const arg = String((ctx && ctx.args) || '').trim().toLowerCase();
  const current = rec.criticModel || 'gemini';
  const isDisabled = current === 'none';
  const session = ctx.session;

  // Status branch — open to all users.
  if (!arg || arg === 'status') {
    ctx.reply(
      isDisabled
        ? `🔕 Critic is **disabled** for this session. Stage-done sentinels short-circuit to a synthetic skip verdict (no Gemini call). \`/critic on\` to re-enable (owner+admin).`
        : `🎯 Critic is **enabled** for this session (model: \`${current}\`). \`/critic off\` to disable when the critic keeps erroring (owner+admin).`
    );
    return;
  }

  if (arg !== 'on' && arg !== 'off') {
    ctx.reply('Usage: `/critic status` (read) · `/critic off` (disable, owner+admin) · `/critic on` (re-enable, owner+admin).');
    return;
  }

  // Mutating branches — owner+admin gate.
  if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    ctx.reply(`(/critic on/off is owner-or-admin only. Session owner is @${rec.user}. Bare \`/critic status\` is open to everyone.)`);
    return;
  }

  const next = arg === 'off' ? 'none' : 'gemini';
  if (next === current) {
    ctx.reply(`(critic is already \`${current}\` — no change.)`);
    return;
  }
  rec.criticModel = next;
  sessionsMod.saveStore();
  // Broadcast the new state so any open config admin panel re-renders
  // the dropdown without needing a refresh.
  if (session && typeof session.emit === 'function') {
    session.emit('state-update', { kind: 'critic-model-changed', modelId: next });
  }
  ctx.reply(
    next === 'none'
      ? '✓ Critic **disabled** for this session. Subsequent stage-done sentinels will skip the critic and show an ✓ Accept Stage button on the synthetic verdict pane. `/critic on` to re-enable.'
      : '✓ Critic **enabled** for this session (model: `gemini`). Next stage-done sentinel will fire the real critic again.'
  );
}

function handleStrict(ctx) {
  const sessionsMod = require('./sessions');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) {
    ctx.reply('(/strict: session not found)');
    return;
  }
  // Owner + admin gate. Admins inherit non-destructive controls
  // per fr-39; strict-mode toggle isn't grant/revoke/delete so it's
  // in-scope for admins.
  if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    ctx.reply(`(/strict is owner-or-admin only. Session owner is @${rec.user}.)`);
    return;
  }
  const arg = String((ctx && ctx.args) || '').trim().toLowerCase();
  if (!arg) {
    const on = sessionsMod.isSessionStrict(ctx.sessionId);
    ctx.reply(`Strict-mode is currently \`${on ? 'on' : 'off'}\`. ` +
      (on
        ? 'Claude-bound messages must include `[run:plan#<id>]` to drive code changes.'
        : 'All chat messages forward to claude as usual. `/strict on` to gate.'));
    return;
  }
  if (arg !== 'on' && arg !== 'off') {
    ctx.reply('Usage: `/strict on` (enable gate), `/strict off` (disable), or `/strict` (status).');
    return;
  }
  const wantOn = arg === 'on';
  const changed = sessionsMod.setSessionStrict(ctx.sessionId, wantOn);
  if (!changed) {
    ctx.reply(`(strict-mode was already \`${wantOn ? 'on' : 'off'}\` — no change.)`);
    return;
  }
  if (wantOn) {
    ctx.reply('✓ Strict-mode is now `on`. Claude-bound chat messages must include `[run:plan#<id>]` (click ▶ Run on a plan item, or type the marker manually) to drive code changes. `/strict off` to disable.');
  } else {
    ctx.reply('✓ Strict-mode is now `off`. All chat messages forward to claude as usual.');
  }
}

// fr-48: run-queue slash commands. All owner+admin gated (mirror
// fr-46 / fr-39 model). The HTTP routes in artifacts.js do the actual
// state mutation; the slash commands just shape the chat-driven API
// so /qstatus / /queue work from any attached client.
function _requireQueueAuth(ctx) {
  if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    const rec = sessionsMod.getSessionRecord(ctx.sessionId);
    const ownerLabel = rec ? `@${rec.user}` : '(unknown)';
    ctx.reply(`(/queue, /qstatus, /qcancel, /qclear, /qresume are owner+admin only. Session owner is ${ownerLabel}.)`);
    return false;
  }
  return true;
}

function handleQueue(ctx) {
  if (!_requireQueueAuth(ctx)) return;
  const runQueue = require('./runQueue');
  const artifactsMod = require('./artifacts');
  const attachMod = require('./attach');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/queue: session not found)'); return; }
  const ids = String((ctx && ctx.args) || '').trim().split(/\s+/).filter(Boolean);
  if (!ids.length) {
    ctx.reply('Usage: `/queue <itemId> [itemId ...]` — e.g. `/queue fr-43 bug-21 td-22`. Use `/qstatus` to see the current queue.');
    return;
  }
  const planArtifact = rec.artifacts && rec.artifacts.plan;
  const items = (planArtifact && Array.isArray(planArtifact.items)) ? planArtifact.items : [];
  const added = [];
  const failed = [];
  for (const id of ids) {
    const item = items.find((it) => it && it.id === id);
    if (!item) { failed.push(`${id} (not found)`); continue; }
    try {
      runQueue.addToQueue(rec, id, 'plan', ctx.user);
      added.push(id);
    } catch (err) {
      failed.push(`${id} (${err.message})`);
    }
  }
  sessionsMod.saveStore();
  // Broadcast via ctx.session (passed in by the dispatcher in
  // attach.js handleChatMessage). Pre-fix used the attach module's
  // session-lookup helper which silently no-op'd under certain
  // require-cycle conditions — the user-reported "chip strip
  // doesn't update after /qcancel" bug.
  const session = ctx.session;
  if (session && typeof session.emit === 'function') {
    session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
    // Kick the queue if this added a first pending entry and nothing
    // is running. Mirrors the /queue/add HTTP path's kick logic.
    const hasRunning = rec.runQueue.some((e) => e.status === 'running');
    if (!hasRunning && !rec.runQueuePaused) {
      const next = runQueue.peekNextPending(rec);
      if (next) {
        const item = items.find((it) => it && it.id === next.itemId);
        if (item) {
          try {
            runQueue.markRunning(rec, next.itemId);
            sessionsMod.saveStore();
            session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
            attachMod.handleChatMessage(ctx.sessionId, session, ctx.user,
              artifactsMod.buildArtifactRunText(next.type, item, ctx.user));
          } catch (err) {
            console.error(`[runQueue] /queue kick failed: ${err.message}`);
          }
        }
      }
    }
  }
  const okLine = added.length ? `✓ Queued: \`${added.join('`, `')}\`.` : '';
  const failLine = failed.length ? `⚠ Skipped: ${failed.join(', ')}.` : '';
  ctx.reply([okLine, failLine].filter(Boolean).join(' '));
}

function handleQStatus(ctx) {
  // /qstatus is purely read-only — anyone attached to the session
  // (including read-only guests) can inspect the queue. The mutating
  // queue commands (/queue, /qcancel, /qclear, /qresume) still gate
  // via _requireQueueAuth on their own handlers.
  const runQueue = require('./runQueue');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/qstatus: session not found)'); return; }
  const state = runQueue.getQueueState(rec);
  if (!state.entries.length) {
    ctx.reply('Run-queue is empty. Use `/queue <itemId>` to enqueue.');
    return;
  }
  const c = state.counts;
  const header = state.paused
    ? `⏸ **Run-queue paused** — ${c.pending} pending · ${c.running} running · ${c.success} ✓ · ${c.failed} ⚠ · ${c.cancelled} ✗`
    : `**Run-queue** — ${c.pending} pending · ${c.running} running · ${c.success} ✓ · ${c.failed} ⚠ · ${c.cancelled} ✗`;
  const rows = state.entries.map((e) => {
    const glyph = ({ pending: '⏸', running: '⚙', success: '✓', failed: '⚠', cancelled: '✗' })[e.status] || '?';
    return `  ${glyph} \`${e.itemId}\` (${e.status}) — by @${e.addedBy}`;
  });
  ctx.reply([header, ...rows, state.paused ? '\n_Use `/qresume` to dispatch the next pending entry._' : ''].filter(Boolean).join('\n'));
}

// bug-92: /pq — list the session's unanswered user questions so none are
// forgotten. Read-only (anyone attached). pending = still to be answered;
// failed = auto-rerun couldn't (or an abort marked it) — re-kick via the
// unanswered strip's ↻ rerun button (POST /sessions/:id/questions/rerun).
// ── /harness — Harness² sweep control (P3) ─────────────────────────────────
//
// Owner+admin only: starting a sweep spends real money on the model gateway and
// writes into the project's .claude/, which is the same authority /queue grants.
//
// The sweep itself runs as a detached child process (server/src/harness-runner.js);
// these handlers only start it, read its status, and stop it.

// 1.2 MB beats 1258291 B when a report lists a dozen files.
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function _requireHarnessAuth(ctx) {
  if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    const rec = sessionsMod.getSessionRecord(ctx.sessionId);
    const ownerLabel = rec ? `@${rec.user}` : '(unknown)';
    ctx.reply(`(/harness is owner+admin only — it spends model budget and rewrites the project's .claude/. Session owner is ${ownerLabel}.)`);
    return false;
  }
  return true;
}

function handleHarness(ctx) {
  if (!_requireHarnessAuth(ctx)) return;
  const runner = require('./harness-runner');
  const cwd = ctx.absCwd || process.cwd();
  const args = String(ctx.args || '').trim();
  const [sub, ...rest] = args.split(/\s+/);
  const verb = (sub || 'status').toLowerCase();
  const tail = rest.join(' ').trim();

  if (verb === 'status') {
    ctx.reply(runner.formatStatus(runner.getStatus(cwd, tail || null)));
    return;
  }

  if (verb === 'cancel') {
    const r = runner.cancelSweep(cwd);
    if (!r.cancelled) {
      ctx.reply(`/harness cancel: ${r.reason}${r.id ? ` (sweep ${r.id})` : ''}`);
      return;
    }
    ctx.reply(`✗ cancelled sweep \`${r.id}\`.`);
    return;
  }

  if (verb === 'run') {
    if (!tail) {
      ctx.reply('Usage: `/harness run [--n2] [--k <1-4>] [--timeout <5h|300m|1800>] <task>`');
      return;
    }
    // Parse optional flags: --n2, --k <n>, --timeout <dur> from the front.
    let rolloutMode = 'myco';
    let k = 1;
    let rolloutTimeoutS = null;
    let taskText = tail;

    // Strip flags one at a time from the front.
    let parsing = true;
    while (parsing) {
      if (taskText.startsWith('--n2 ') || taskText === '--n2') {
        rolloutMode = 'n2';
        taskText = taskText.slice('--n2'.length).trimStart();
      } else if (/^--k\s+\d+\s?/.test(taskText) || /^--k\s+\d+$/.test(taskText)) {
        const m = taskText.match(/^--k\s+(\d+)(.*)/s);
        const kVal = parseInt(m[1], 10);
        if (kVal < 1 || kVal > 4) {
          ctx.reply('`--k` must be between 1 and 4. k=2 runs 8 rollouts and 6 improvement sessions.');
          return;
        }
        k = kVal;
        taskText = (m[2] || '').trimStart();
      } else if (/^--timeout\s+/.test(taskText)) {
        // Accepts 1800 / 1800s / 300m / 5h. Bare numbers are seconds.
        const m = taskText.match(/^--timeout\s+(\d+)\s*([smh]?)(.*)/s);
        if (!m) {
          ctx.reply('`--timeout` needs a value like `1800`, `300m` or `5h`.');
          return;
        }
        const unit = m[2] || 's';
        const mult = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
        const secs = parseInt(m[1], 10) * mult;
        if (!Number.isFinite(secs) || secs < 60) {
          ctx.reply('`--timeout` must be at least 60 seconds.');
          return;
        }
        if (secs > 24 * 3600) {
          ctx.reply('`--timeout` above 24h is refused — that is almost certainly a stuck sweep, not a slow one.');
          return;
        }
        rolloutTimeoutS = secs;
        taskText = (m[3] || '').trimStart();
      } else {
        parsing = false;
      }
    }

    if (!taskText) {
      ctx.reply('Usage: `/harness run [--n2] [--k <1-4>] [--timeout <5h|300m|1800>] <task>` — task text is required.');
      return;
    }

    let started;
    try {
      started = runner.startSweep({
        cwd,
        task: taskText,
        k,
        mode: 'parallel',
        rolloutMode,
        rolloutTimeoutS,
        onProgress: (p) => {
          if (p.stage === 'done') return;
          // D5: in n2 sweeps the worker is half the story — "which half of
          // the team is acting" — and dropping it made the pane show two
          // interleaved agents as one anonymous stream.
          const bits = [p.stage, p.run, p.worker].filter(Boolean).join(' ');
          if (!bits) return;
          try {
            // D1 fix: bare `session` was not in scope here, causing a
            // ReferenceError swallowed by the outer try/catch; use ctx.session.
            // chat-print-persistence fix (2026-11-04): also appendChatMessage
            // so the progress row survives refresh / reconnect.
            const progressMsg = { user: 'claude', text: `⚙ harness: ${bits}`,
              ts: new Date().toISOString(), meta: { kind: 'harness-progress' } };
            sessionsMod.appendChatMessage(ctx.sessionId, progressMsg);
            ctx.session.emit('chat', progressMsg);
          } catch {}
        },
      });
    } catch (e) {
      ctx.reply(`(/harness run failed: ${e.message})`);
      return;
    }
    if (started.reused) {
      ctx.reply(`⚙ Sweep \`${started.id}\` is already running here. \`/harness status\` to watch, \`/harness cancel\` to stop.`);
      return;
    }
    ctx.reply([
      `⚙ Started sweep \`${started.id}\` (k=${k}, parallel${rolloutMode === 'n2' ? ', n2' : ''})${started.pid ? `, pid ${started.pid}` : ''}.`,
      '',
      rolloutMode === 'n2'
        ? '_Team mode: each rollout runs TWO workers sharing a board — expect ≈2× model cost per rollout and ≈2× trajectory tokens. A k=1 sweep runs about 4 rollouts and 3 improvement sessions._'
        : '_A k=1 sweep runs about 4 rollouts and 3 improvement sessions._',
      '`/harness status` · `/harness cancel` · results land in `_harness_/sweeps/`',
    ].join('\n'));
    return;
  }

  // ── P4: adopt|diff|rollback ─────────────────────────────────────────────
  if (verb === 'diff') {
    const hResult = require('./harness-result');
    const id = tail || null;
    const sel = hResult.findSelection(cwd, id);
    if (!sel) {
      ctx.reply('No successful selection found. Run `/harness status` to check.');
      return;
    }
    const dir = hResult.harnessDir(sel);
    if (!dir || !require('fs').existsSync(dir)) {
      ctx.reply('Chosen workspace directory not found. The sweep result may be incomplete.');
      return;
    }
    const changes = hResult.diffHarness(dir, cwd);
    ctx.reply(hResult.formatDiff(changes));
    return;
  }

  if (verb === 'adopt') {
    if (!_requireHarnessAuth(ctx)) return;
    const hResult = require('./harness-result');
    const id = tail || null;
    const sel = hResult.findSelection(cwd, id);
    if (!sel) {
      ctx.reply('No successful selection found. Run `/harness status` to check.');
      return;
    }
    const dir = hResult.harnessDir(sel);
    if (!dir || !require('fs').existsSync(dir)) {
      ctx.reply('Chosen workspace directory not found.');
      return;
    }
    hResult.adoptHarness(dir, cwd).then(async ({ adopted, snapshot }) => {
      const snapshotFile = await hResult.saveSnapshot(snapshot, cwd, sel.chosen_run_id || id || 'sweep');
      const n2Files = adopted.filter(f => f.startsWith('.myco_harness/n2/'));
      ctx.reply([
        `✓ Adopted harness from sweep — ${adopted.length} file(s) written.`,
        '',
        adopted.map(f => `  • \`${f}\``).join('\n'),
        n2Files.length
          ? `\n_n2 components installed — the next \`/run-n2\` in this session runs with them._`
          : '',
        '',
        `_Snapshot saved as \`${require('path').basename(snapshotFile)}\`. Use \`/harness rollback\` to undo._`,
      ].filter(Boolean).join('\n'));
    }).catch(e => {
      ctx.reply(`(/harness adopt failed: ${e.message})`);
    });
    return;
  }

  if (verb === 'pull') {
    if (!_requireHarnessAuth(ctx)) return;
    const hResult = require('./harness-result');
    const path    = require('path');
    const fsp     = require('fs/promises');

    // /harness pull [--all] [--bulk] [--to <dir>] [sweepId] [runLabel]
    //
    // adopt installs the HARNESS; this hands back what the AGENT produced.
    // Default: the selected run. --all: every sibling run with a workspace,
    // one directory each, so the four candidates can be compared directly
    // instead of trusting the blind selection sight-unseen.
    let pullAll = false;
    let pullBulk = false;
    let destArg = null;
    let idArg   = null;
    let runArg  = null;
    let text = tail;
    for (;;) {
      const m = text.match(/^(--all|--bulk|--to)\s*(\S*)\s*(.*)$/s);
      if (!m) break;
      if (m[1] === '--all') { pullAll = true; text = (m[2] + ' ' + m[3]).trim(); continue; }
      if (m[1] === '--bulk') { pullBulk = true; text = (m[2] + ' ' + m[3]).trim(); continue; }
      if (!m[2]) { ctx.reply('Usage: `/harness pull [--all] [--bulk] [--to <dir>] [sweepId] [runLabel]` — `--to` needs a value.'); return; }
      destArg = m[2];
      text = (m[3] || '').trim();
    }
    [idArg, runArg] = text ? text.split(/\s+/) : [];

    const sel = hResult.findSelection(cwd, idArg || null);
    if (!sel) {
      ctx.reply('No successful selection found. Run `/harness status` to check.');
      return;
    }
    const chosen = sel.chosen_run_dir;
    if (!chosen || !require('fs').existsSync(path.join(chosen, 'workspace'))) {
      ctx.reply('Chosen run workspace not found. The sweep result may be incomplete.');
      return;
    }

    const sweepStem = String(idArg || sel.sweep || sel.chosen_run_id || 'sweep')
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'sweep';
    const baseDir = destArg ? path.resolve(cwd, destArg)
                            : path.join(cwd, '_harness_', 'deliverables', sweepStem);

    let targets;
    if (pullAll) {
      targets = hResult.siblingRuns(chosen);
    } else if (runArg) {
      const all = hResult.siblingRuns(chosen);
      const hit = all.find(r => path.basename(r) === runArg || path.basename(r).includes(runArg));
      if (!hit) {
        ctx.reply('No run matching `' + runArg + '`.\n\n' + all.map(r => '  • `' + path.basename(r) + '`').join('\n'));
        return;
      }
      targets = [hit];
    } else {
      targets = [chosen];
    }

    Promise.all(targets.map(runDir => {
      // One run → straight into baseDir. Several → one subdirectory per run,
      // named by the run id, so a side-by-side diff is a plain `diff -r`.
      const dest = targets.length === 1
        ? baseDir
        : path.join(baseDir, hResult.runLabel(runDir));
      return hResult.pullDeliverables(runDir, dest, { all: pullBulk });
    })).then(results => {
      if (!results.length) { ctx.reply('No run workspaces found to pull from.'); return; }
      const lines = [];
      let total = 0;
      for (const r of results) {
        const rel = path.relative(cwd, r.dest) || '.';
        if (!r.files.length) {
          lines.push(`▫ \`${r.label}\` — no agent-produced files (only task inputs and harness).`);
          continue;
        }
        total += r.files.length;
        lines.push(`📦 \`${r.label}\` → \`${rel}\` — ${r.files.length} file(s)`);
        for (const f of r.files.slice(0, 40)) {
          const tag = f.status === 'modified' ? '✏️' : '➕';
          lines.push(`   ${tag} \`${f.rel}\` (${fmtBytes(f.bytes)})`);
        }
        if (r.files.length > 40) lines.push(`   … and ${r.files.length - 40} more`);
        // Say what was left behind. Silently dropping 20 MB of data would
        // read as "the agent produced nothing but source", which is a lie.
        if (r.skipped && r.skipped.length) {
          const skippedBytes = r.skipped.reduce((a, f) => a + f.bytes, 0);
          const shown = r.skipped.slice(0, 3).map(f => '`' + f.rel + '`').join(', ');
          lines.push(`   ⤵ skipped ${r.skipped.length} bulk file(s), ${fmtBytes(skippedBytes)} ` +
            `(${shown}${r.skipped.length > 3 ? ', …' : ''}) — \`--bulk\` to include`);
        }
      }
      const header = results.length === 1
        ? `✓ Pulled ${total} agent-produced file(s) from \`${results[0].label}\`.`
        : `✓ Pulled agent output from ${results.length} run(s) — ${total} file(s).`;
      const footer = [
        "_Task inputs and harness files are excluded — these are the agent's own output._",
      ];
      if (!pullAll)  footer.push('_`--all` pulls every candidate run for comparison._');
      if (!pullBulk) footer.push('_`--bulk` also copies datasets and build output._');
      ctx.reply([header, '', ...lines, '', ...footer].join('\n'));
    }).catch(e => {
      ctx.reply(`(/harness pull failed: ${e.message})`);
    });
    return;
  }

  if (verb === 'rollback') {
    if (!_requireHarnessAuth(ctx)) return;
    const hResult = require('./harness-result');
    // tail may be "<sweepId> [snapshotId]" or empty (use latest)
    const [sweepId, snapshotId] = (tail || '').split(/\s+/);
    // Try to resolve a sweepId from the latest sweep if not given.
    const resolvedSweepId = sweepId || (() => {
      const runner = require('./harness-runner');
      const st = runner.getStatus(cwd, null);
      return st && st.id;
    })();
    if (!resolvedSweepId) {
      ctx.reply('Usage: `/harness rollback [sweepId] [snapshotId]`\nNo sweep id given and no recent sweep found.');
      return;
    }
    const snapshot = hResult.loadSnapshot(cwd, resolvedSweepId, snapshotId || null);
    if (!snapshot) {
      ctx.reply('No snapshot found for sweep `' + resolvedSweepId + '`. Was `/harness adopt` run?');
      return;
    }
    hResult.rollbackHarness(snapshot, cwd).then(({ restored, removed }) => {
      const total = restored.length + removed.length;
      ctx.reply([
        `↩ Rolled back snapshot \`${snapshot.id}\` — ${total} file(s) restored.`,
        restored.map(f => `  • \`${f}\` restored`).join('\n'),
        removed.map(f => `  • \`${f}\` removed`).join('\n'),
      ].filter(Boolean).join('\n'));
    }).catch(e => {
      ctx.reply(`(/harness rollback failed: ${e.message})`);
    });
    return;
  }

  // ── P6: publish to market ─────────────────────────────────────────────
  if (verb === 'publish') {
    if (!_requireHarnessAuth(ctx)) return;
    const hResult  = require('./harness-result');
    const hMarket  = require('./harness-market');
    const runner   = require('./harness-runner');
    const id = tail || null;
    const sel = hResult.findSelection(cwd, id);
    if (!sel) {
      ctx.reply('No successful selection found. Run `/harness status` to check.');
      return;
    }
    const st = runner.getStatus(cwd, id || null);
    const sweepMeta = {
      sweepTag: (st && st.namespace) || (id || 'unknown'),
      task:     sel.task_id || 'unknown',
      mode:     sel.mode    || 'agg',
      k:        sel.k       || 1,
      domain:   sel.domain  || '',
    };
    hMarket.publishFromSweep(sel, sweepMeta, ctx.user).then(result => {
      ctx.reply(`✓ Published harness \`${result.name}\` to market.`);
    }).catch(e => {
      ctx.reply(`(/harness publish failed: ${e.message})`);
    });
    return;
  }

  // ── init — generate harness component templates ────────────────────────
  if (verb === 'init') {
    const fsp  = require('fs/promises');
    const path = require('path');
    const cwd  = ctx.absCwd || process.cwd();
    const n2   = (tail || '').toLowerCase() === 'n2';
    const dir  = path.join(cwd, '_harness_', 'template');

    const files = {
      'systemprompt.md': '# Role\n\n<!-- Agent role and workflow for this project. -->\nYou are an expert software engineer.\n',
      'tool_guidance.md': '# Tool Guidance\n\n<!-- Project-specific tool usage rules. -->\nRead before editing. Write minimal targeted changes.\n',
      'guardrails.md': '# Guardrails\n\n<!-- Project-specific prohibitions. -->\nNever push to main directly.\n',
    };
    if (n2) {
      files['worker_a_startup.md'] = '# Worker-A Startup\n\n<!-- Overrides STARTUP_A in prompts-n2-shared.js -->\nInspect the task and choose the simplest split. Reserve your scope and\npublish actionable non-overlapping work for worker-B before implementing.\n';
      files['worker_b_startup.md'] = '# Worker-B Startup\n\n<!-- Overrides STARTUP_B in prompts-n2-shared.js -->\nExplore the entry point and environment. Share concrete findings, then\nclaim the first available board item and implement it immediately.\n';
      files['board_guidance.md'] = '# Board Guidance\n\n<!-- Overrides BOARD_COMMANDS + WAITING in prompts-n2-shared.js -->\n<!-- Leave blank to use the canonical Delm board protocol. -->\n';
    }

    fsp.mkdir(dir, { recursive: true }).then(async () => {
      const created = [];
      for (const [name, content] of Object.entries(files)) {
        const target = path.join(dir, name);
        try { await fsp.access(target); continue; } catch {}
        await fsp.writeFile(target, content, 'utf8');
        created.push(name);
      }
      ctx.reply([
        `✓ Harness template in \`_harness_/template/\`${n2 ? ' (n2 mode)' : ''}.`,
        created.length
          ? '\n**Created:**\n' + created.map(f => `  • \`${f}\``).join('\n')
          : '\n_All files already exist — nothing overwritten._',
        '\n**Next:** edit the files, then `/harness install _harness_/template`',
        n2 ? '\n_n2 files tune dual-agent startup strategy and board guidance._' : '',
      ].filter(Boolean).join('\n'));
    }).catch(e => ctx.reply(`(/harness init failed: ${e.message})`));
    return;
  }

  // ── install — install harness from a local directory ─────────────────
  if (verb === 'install') {
    if (!_requireHarnessAuth(ctx)) return;
    if (!tail) {
      ctx.reply([
        'Usage: `/harness install <dir>`',
        '',
        'Installs the harness tree at `<dir>` into this session.',
        'Files: `systemprompt.md`, `guardrails.md`, `tool_guidance.md`, `hooks.json`,',
        '`sub_agents/`, `skills/`, `scripts/`',
        'n2 files: `worker_a_startup.md`, `worker_b_startup.md`, `board_guidance.md`',
        '',
        'Run `/harness init [n2]` to generate a template first.',
      ].join('\n'));
      return;
    }
    const path    = require('path');
    const fs      = require('fs');
    const hResult = require('./harness-result');
    const cwd     = ctx.absCwd || process.cwd();
    const hDir    = path.isAbsolute(tail) ? tail : path.resolve(cwd, tail);
    if (!fs.existsSync(hDir)) {
      ctx.reply(`(/harness install: directory not found: \`${tail}\`)`);
      return;
    }
    hResult.adoptHarness(hDir, cwd).then(async ({ adopted, snapshot }) => {
      const snapshotFile = await hResult.saveSnapshot(snapshot, cwd, `manual-${Date.now()}`);
      ctx.reply([
        `✓ Installed harness from \`${tail}\` — ${adopted.length} file(s) written.`,
        adopted.map(f => `  • \`${f}\``).join('\n'),
        `_Snapshot saved. Use \`/harness rollback\` to undo._`,
      ].join('\n\n'));
    }).catch(e => ctx.reply(`(/harness install failed: ${e.message})`));
    return;
  }

  ctx.reply('Usage: `/harness run [--n2] [--k <1-4>] [--timeout <5h|300m|1800>] <task>` · `/harness status [id]` · `/harness cancel` · `/harness diff [id]` · `/harness adopt [id]` · `/harness pull [--all] [--bulk] [--to <dir>]` · `/harness rollback [sweepId]` · `/harness publish [id]` · `/harness init [n2]` · `/harness install <dir>`');
}

function handleHarnessMarket(ctx) {
  const hMarket = require('./harness-market');
  const args    = String(ctx.args || '').trim();
  const [sub, ...rest] = args.split(/\s+/);
  const verb = (sub || 'list').toLowerCase();
  const name = rest.join(' ').trim();

  if (verb === 'list' || !args) {
    hMarket.listHarnesses(ctx.user).then(items => {
      if (!items || items.length === 0) {
        ctx.reply([
          '_No harness items in the market yet._',
          '',
          'After a sweep finishes, run `/harness publish` to share the selected harness.',
        ].join('\n'));
        return;
      }
      const lines = [
        `**Harness market — ${items.length} item(s):**\n`,
      ];
      for (const item of items) {
        const domain = item.domain ? ` · ${item.domain}` : '';
        const task   = item.task   ? ` · task: \`${item.task}\`` : '';
        lines.push(`• **\`${item.name}\`**${domain}${task}`);
        if (item.description) lines.push(`  _${item.description}_`);
      }
      lines.push('');
      lines.push('`/harness-market install <name>` to adopt one into this session.');
      ctx.reply(lines.join('\n'));
    }).catch(e => ctx.reply(`(/harness-market list failed: ${e.message})`));
    return;
  }

  if (verb === 'info') {
    if (!name) {
      ctx.reply('Usage: `/harness-market info <name>`');
      return;
    }
    const marketApi = require('./market');
    marketApi.readMarketItem({ type: 'harness', name }).then(item => {
      if (!item) {
        ctx.reply(`No harness named \`${name}\` in the market.`);
        return;
      }
      const { _fileContent, ...safe } = item;
      const fileList = Object.keys(item.files || {});
      const lines = [
        `**${safe.name}**`,
        safe.description ? `_${safe.description}_` : '',
        '',
        `Surface: \`${safe.surface || 'myco'}\``,
        safe.sweepTag ? `Sweep: \`${safe.sweepTag}\`` : '',
        safe.task      ? `Task: \`${safe.task}\` (${safe.domain || 'unknown domain'})` : '',
        safe.mode      ? `Mode: ${safe.mode}, k=${safe.k || 1}` : '',
        '',
        `**${fileList.length} file(s):**`,
        fileList.map(f => `  • \`${f}\``).join('\n'),
        safe.selectionWhy ? `\n**Why selected:** ${safe.selectionWhy}` : '',
      ].filter(l => l !== '');
      ctx.reply(lines.join('\n'));
    }).catch(e => ctx.reply(`(/harness-market info failed: ${e.message})`));
    return;
  }

  if (verb === 'install') {
    if (!name) {
      ctx.reply('Usage: `/harness-market install <name>`');
      return;
    }
    if (!require('./sessions').isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
      const rec = require('./sessions').getSessionRecord(ctx.sessionId);
      ctx.reply(`(/harness-market install is owner+admin only — owner is @${rec ? rec.user : '?'})`);
      return;
    }
    const cwd = ctx.absCwd || process.cwd();
    hMarket.installIntoSession(name, cwd, ctx.user).then(({ installed, snapshot }) => {
      ctx.reply([
        `✓ Installed harness \`${name}\` — ${installed.length} file(s) written.`,
        '',
        installed.map(f => `  • \`${f}\``).join('\n'),
        '',
        '_Use `/harness diff` to review, `/harness rollback` to undo._',
      ].join('\n'));
    }).catch(e => ctx.reply(`(/harness-market install failed: ${e.message})`));
    return;
  }

  ctx.reply('Usage: `/harness-market list` · `/harness-market info <name>` · `/harness-market install <name>`');
}

function handlePQ(ctx) {
  const pendingQuestions = require('./pendingQuestions');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/pq: session not found)'); return; }
  const state = pendingQuestions.getState(rec);
  const open = state.list.filter((e) => e.status === 'pending' || e.status === 'failed');
  if (!open.length) {
    ctx.reply('No unanswered questions. Every user question has an in-flight or answered turn.');
    return;
  }
  const rows = open.map((e) => {
    const glyph = e.status === 'pending' ? '⏳' : '⚠';
    const label = String(e.text).replace(/\s+/g, ' ').slice(0, 70);
    return `  ${glyph} \`${e.qid}\` (${e.status}, try ${e.dispatchCount || 1}) @${e.user}: ${label}`;
  });
  ctx.reply([`**Unanswered questions** — ${state.counts.pending} pending · ${state.counts.failed} failed`, ...rows,
    '\n_Automatic rerun covers backend failures (bounded). Use the ↻ rerun button to re-kick aborted/failed ones._'].join('\n'));
}

function handleQCancel(ctx) {
  if (!_requireQueueAuth(ctx)) return;
  const runQueue = require('./runQueue');
  const artifactsMod = require('./artifacts');
  const attachMod = require('./attach');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/qcancel: session not found)'); return; }
  const id = String((ctx && ctx.args) || '').trim();
  if (!id) { ctx.reply('Usage: `/qcancel <itemId>`'); return; }
  // fr-48 stuck-running recovery: /qcancel passes {force:true} so a
  // stuck running entry (queue thinks it's running but the SDK is
  // idle — happens when the iteration aborted/fatal'd before the
  // listener fix landed) can be cleared from chat. The user explicitly
  // typed /qcancel, so consenting-adults — if the SDK actually IS
  // working on the item, removing it from the queue just means we
  // won't auto-advance to the next pending entry (the in-flight tool
  // calls still complete naturally).
  let removed;
  try {
    removed = runQueue.removeFromQueue(rec, id, { force: true });
  } catch (err) {
    ctx.reply(`⚠ ${err.message}`);
    return;
  }
  if (!removed) { ctx.reply(`(no queued entry for \`${id}\`)`); return; }
  sessionsMod.saveStore();
  // Broadcast via ctx.session — the live session the dispatcher
  // passed in. Pre-fix this re-discovered via the attach module's
  // session-lookup helper which silently no-op'd in some
  // require-cycle conditions, causing the user-reported "chip strip
  // doesn't update after /qcancel" bug.
  if (ctx.session && typeof ctx.session.emit === 'function') {
    ctx.session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
  }
  ctx.reply(`✓ Cancelled \`${id}\` in the run-queue.`);
  // fr-51: dispatch the next pending entry so the queue actually
  // ADVANCES after the cancel. Pre-fix /qcancel removed the (stuck)
  // running head and stopped — leaving every pending entry behind it
  // idle indefinitely. User had to follow up with /qresume just to
  // get the queue moving again, which surprised everyone. Now the
  // cancel auto-advances: same dispatcher block handleQResume already
  // uses (peekNextPending → markRunning → handleChatMessage with
  // buildArtifactRunText). Respects rec.runQueuePaused — peekNextPending
  // returns null when paused, so this branch is a no-op there.
  const next = runQueue.peekNextPending(rec);
  if (next && ctx.session) {
    const planArtifact = rec.artifacts && rec.artifacts.plan;
    const nextItem = planArtifact && Array.isArray(planArtifact.items)
      && planArtifact.items.find((it) => it && it.id === next.itemId);
    if (nextItem) {
      try {
        runQueue.markRunning(rec, next.itemId);
        sessionsMod.saveStore();
        ctx.session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
        attachMod.handleChatMessage(ctx.sessionId, ctx.session, ctx.user,
          artifactsMod.buildArtifactRunText(next.type, nextItem, ctx.user));
      } catch (err) {
        console.error(`[runQueue] /qcancel auto-advance failed: ${err.message}`);
      }
    }
  }
}

function handleQClear(ctx) {
  if (!_requireQueueAuth(ctx)) return;
  const runQueue = require('./runQueue');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/qclear: session not found)'); return; }
  const removed = runQueue.clearQueue(rec);
  sessionsMod.saveStore();
  if (ctx.session && typeof ctx.session.emit === 'function') {
    ctx.session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
  }
  ctx.reply(`✓ Cleared ${removed} pending entr${removed === 1 ? 'y' : 'ies'} from the run-queue. Running + finished history preserved.`);
}

function handleQResume(ctx) {
  if (!_requireQueueAuth(ctx)) return;
  const runQueue = require('./runQueue');
  const artifactsMod = require('./artifacts');
  const attachMod = require('./attach');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/qresume: session not found)'); return; }
  runQueue.resumeQueue(rec);
  sessionsMod.saveStore();
  const session = ctx.session;
  if (session && typeof session.emit === 'function') {
    session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
  }
  const next = runQueue.peekNextPending(rec);
  if (!next) { ctx.reply('✓ Queue unpaused — no pending entries to dispatch.'); return; }
  const planArtifact = rec.artifacts && rec.artifacts.plan;
  const item = planArtifact && Array.isArray(planArtifact.items)
    && planArtifact.items.find((it) => it && it.id === next.itemId);
  if (!item || !session) {
    ctx.reply(`✓ Queue unpaused — next entry \`${next.itemId}\` will dispatch when session is ready.`);
    return;
  }
  try {
    runQueue.markRunning(rec, next.itemId);
    sessionsMod.saveStore();
    session.emit('state-update', { kind: 'runQueue', state: runQueue.getQueueState(rec) });
    attachMod.handleChatMessage(ctx.sessionId, session, ctx.user,
      artifactsMod.buildArtifactRunText(next.type, item, ctx.user));
  } catch (err) {
    console.error(`[runQueue] /qresume dispatch failed: ${err.message}`);
    ctx.reply(`⚠ Queue unpaused but dispatch failed: ${err.message}`);
    return;
  }
  ctx.reply(`✓ Queue unpaused — dispatching \`${next.itemId}\` now.`);
}

// fr-49: /whatsnext + /next. Owner-or-guest read; mutates plan.whatsNext
// on cache miss/refresh (saveStore inside). Output format is a numbered
// list of the top RETURN_N items with score, layer, and a one-line
// snippet. Each line also surfaces the heuristic "reasons" so the user
// can tell why a fr ranked above a bug (or vice versa).
async function handleWhatsNext(ctx) {
  const whatsnext = require('./whatsnext');
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/whatsnext: session not found)'); return; }
  const plan = rec.artifacts && rec.artifacts.plan;
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) {
    ctx.reply('Plan is empty — nothing to rank. Add items with /td /fr /bug.');
    return;
  }
  const force = /^(force|--?refresh|refresh)\b/i.test(String(ctx.args || '').trim());
  const cwd = (ctx && ctx.absCwd) || (rec && rec.cwd) || process.cwd();

  let cache;
  try {
    cache = await whatsnext.getCachedOrGenerate(rec, cwd, { force });
  } catch (err) {
    ctx.reply(`⚠ /whatsnext failed: ${err.message || err}`);
    return;
  }
  sessionsMod.saveStore();
  // Broadcast so other attached clients pick up the cached list
  // (the plan artifact updated; UIs reading plan.whatsNext can refresh).
  if (ctx.session && typeof ctx.session.emit === 'function') {
    ctx.session.emit('state-update', { kind: 'artifact', artifactType: 'plan', artifact: plan });
  }

  if (!cache || !Array.isArray(cache.items) || cache.items.length === 0) {
    ctx.reply('No open items to rank — everything is either done or already in the run-queue.');
    return;
  }

  const generatedAt = cache.generatedAt;
  const ageMin = Math.max(0, Math.round((Date.now() - Date.parse(generatedAt)) / 60000));
  const ageNote = ageMin < 1 ? 'just now' : `${ageMin}m ago`;
  const llmTag = cache.llmReranked ? '(LLM reranked)' : '(heuristic only — LLM rerank unavailable)';
  const header = `**What's next** — ${cache.items.length} ranked · generated ${ageNote} ${llmTag}`;
  const rows = cache.items.map((s, i) => {
    const reasons = Array.isArray(s.reasons) && s.reasons.length ? ` · _${s.reasons.join(', ')}_` : '';
    const snippet = s.snippet ? s.snippet : '';
    return `  **${i + 1}.** \`${s.id}\` [${s.layer || '?'}] · score ${s.score}${reasons}\n     ${snippet}`;
  });
  const footer = force
    ? '\n_Regenerated on demand. Cache TTL is 2h; next read after that will re-rank._'
    : '\n_Cached 2h. Append `force` to /whatsnext or /next to regenerate now._';
  ctx.reply([header, ...rows].join('\n') + footer);
}

// fr-54: shell-style arg splitter for /git. Splits on whitespace,
// honors double + single-quoted phrases, supports backslash-escapes
// inside double quotes (\", \\). Returns an array of argv tokens.
// Intentionally minimal — `git` arguments rarely need shell features
// beyond quoting a path or commit message; if a power user needs full
// shell semantics they can wrap with `sh -c` themselves.
function _parseShellArgs(str) {
  const out = [];
  const s = String(str || '');
  let cur = '';
  let inDouble = false;
  let inSingle = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (inDouble) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inDouble = false; continue; }
      cur += ch;
      continue;
    }
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (/\s/.test(ch)) {
      if (cur.length > 0) { out.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

// fr-54: /git <args> — pass-through to the git CLI in the session's
// workspace. Owner+admin only. Full passthrough — no allowlist of
// subcommands. bug-88: `clone <url>` reuses a stored PAT (per-repo
// → user-level) when the URL has no embedded credentials, so a
// private clone works right after /setpat without pasting the token
// into chat. Everything else stays a plain passthrough.
//
// Caps: 60s timeout, 1 MB stdout, 16 KB stderr. Output rendered as a
// markdown code-fenced block with stdout, then stderr (if any), then
// an exit-code footer.
//
// Note: `git config --global` mutates the container's shared $HOME,
// affecting all sessions. We don't block it (consenting adults) but
// the help text flags this.

// bug-88: parse a git HTTPS/SSH URL into {provider, owner, repo} for
// one of the known hosts, or null. Mirrors git-hosts.js's HOST_REGEX
// classification but works on a bare URL string (detectHost shells out
// to `git remote get-url origin`, which only works post-clone).
function _hostFromCloneUrl(url) {
  const m = String(url || '').match(/(github\.com|gitee\.com|codehub-dg-g\.huawei\.com)[:/]([^/"'\s]+)\/([^/"'\s]+?)(?:\.git)?(?:[\/?#].*)?$/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const provider = host === 'gitee.com' ? 'gitee' : (host === 'codehub-dg-g.huawei.com' ? 'codehub' : 'github');
  const owner = m[2], repo = m[3];
  if (!owner || !repo) return null;
  return { provider, owner, repo };
}

// bug-88: for `clone <url>`, if a PAT is on file for the URL's
// (provider, owner, repo) — per-repo first, then the user-level slot —
// rewrite the URL with the token embedded. Returns null (clone runs
// verbatim) when: the subcommand isn't a bare clone, the URL already
// carries credentials (user explicitly embedded one), the host isn't
// recognized, or no token is stored. The token NEVER appears in the
// echoed `$ git …` line or any output (bug-88 redaction contract).
function _cloneUrlWithStoredPat(argv, user) {
  if (!argv || argv[0] !== 'clone' || argv.length < 2) return null;
  // Find the URL argument: the FIRST https:// arg after `clone` —
  // flags AND their values (e.g. `--depth 1`) sit between them.
  // `git clone` accepts flags before or after the URL; taking the
  // first https:// arg handles both without needing a flag-value
  // table. If there is none, there's nothing to rewrite.
  let i = 1;
  while (i < argv.length && !/^https:\/\//i.test(String(argv[i]))) i++;
  if (i >= argv.length) return null;
  const url = String(argv[i]);
  const restArgs = argv.slice(i + 1);
  // User already embedded credentials (https://user:pat@host/…) —
  // respect the explicit identity, don't double-inject.
  if (/^https:\/\/[^/]*@/i.test(url)) return null;
  const host = _hostFromCloneUrl(url);
  if (!host) return null;
  const token = gitHosts.getToken(user, host.provider, host.owner, host.repo);
  if (!token) return null;
  const userLabel = host.provider === 'gitee'
    ? (gitHosts.getGiteeLogin(user) || user)
    : 'x-access-token';
  const withPat = url.replace(/^https:\/\//i, `https://${encodeURIComponent(userLabel)}:${encodeURIComponent(token)}@`);
  // Rebuild argv with the rewritten URL in place — everything else
  // (flags, values, trailing target dir) keeps its position.
  return argv.map((a, idx) => (idx === i ? withPat : a));
}

function handleGit(ctx) {
  if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
    const rec = sessionsMod.getSessionRecord(ctx.sessionId);
    const ownerLabel = rec ? `@${rec.user}` : '(unknown)';
    ctx.reply(`(/git is owner+admin only. Session owner is ${ownerLabel}.)`);
    return;
  }
  const argsRaw = String((ctx && ctx.args) || '').trim();
  if (!argsRaw) {
    ctx.reply('Usage: `/git <subcommand> [args...]` — runs `git <args>` in the session workspace. Example: `/git status`, `/git log --oneline -10`, `/git clone https://github.com/owner/repo`. `clone` reuses a stored PAT automatically (`/setpat`) — no need to embed the token in the URL (bug-88). NOTE: `git config --global` affects all sessions sharing this container.');
    return;
  }
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec || !rec.absCwd) {
    ctx.reply('(/git: session has no workspace)');
    return;
  }
  let argv;
  try {
    argv = _parseShellArgs(argsRaw);
  } catch (err) {
    ctx.reply(`⚠ /git: arg parse failed: ${err.message}`);
    return;
  }
  if (!argv.length) {
    ctx.reply('Usage: `/git <subcommand> [args...]`');
    return;
  }
  const { execFile } = require('child_process');
  // bug-88: `clone <url>` reuses a stored PAT instead of failing with
  // "could not read Username" on a private repo. Rewrites argv to embed
  // the token; returns null (argv unchanged) for every other case.
  const patArgs = _cloneUrlWithStoredPat(argv, ctx.user);
  const runArgv = patArgs || argv;
  execFile('git', runArgv, {
    // bug-88 (also fr-106 alignment): run from ctx.absCwd when the
    // dispatcher supplied it — that's the main-project dir when one is
    // designated (resolveAgentCwd in attach.js). Fall back to rec.absCwd
    // for direct/legacy callers that don't set ctx.absCwd.
    cwd: (ctx && ctx.absCwd) || rec.absCwd,
    timeout: 60000,
    maxBuffer: 1024 * 1024,      // 1 MB stdout cap
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },  // never block on creds prompt
  }, (err, stdout, stderr) => {
    const out = String(stdout || '').slice(0, 64 * 1024);
    const erro = String(stderr || '').slice(0, 16 * 1024);
    // bug-88 redaction: the token lives in runArgv's URL but the echo
    // line always shows the ORIGINAL user-typed args ($ git clone
    // https://github.com/o/r), and stdout/stderr are scrubbed of any
    // accidental token leak as belt-and-braces.
    const scrub = (s) => String(s || '').replace(/https:\/\/[^/\s]*@/gi, 'https://');
    const lines = [`$ git ${argsRaw}`];
    if (patArgs) lines.push('(using stored PAT for auth — token not shown)');
    if (out.trim()) lines.push('```\n' + scrub(out).replace(/\n+$/, '') + '\n```');
    if (erro.trim()) lines.push('**stderr:**\n```\n' + scrub(erro).replace(/\n+$/, '') + '\n```');
    if (err) {
      if (err.killed) lines.push('⚠ git timed out after 60s');
      else if (err.code === 'ENOENT') lines.push('⚠ git not found on PATH');
      else if (typeof err.code === 'number') lines.push(`(exit code ${err.code})`);
      else lines.push(`⚠ ${scrub(err.message)}`);
    } else {
      lines.push('(exit 0)');
    }
    ctx.reply(lines.join('\n'));
  });
}

function handleHelp(ctx) {
  const lines = ['Available chat commands:'];
  for (const c of COMMANDS) {
    const aliases = c.names.length > 1 ? ` (aliases: ${c.names.slice(1).map((n) => '/' + n).join(', ')})` : '';
    lines.push(`  • \`${c.usage}\`${aliases} — ${c.summary}`);
  }
  lines.push('');
  lines.push('Routing:');
  lines.push('  • plain text → sent to the running Claude session');
  lines.push('  • `@<username> <text>` → chat-only mention (highlighted for the recipient)');
  lines.push('  • `/btw <text>` → ask Claude in the chat (no PTY write)');
  ctx.reply(lines.join('\n'));
}

// Returns the public command list (used by the client's autocomplete
// dropdown). Hides aliases from the primary list but mentions them.
function listCommands() {
  return COMMANDS.map((c) => ({
    name: c.names[0],
    aliases: c.names.slice(1),
    summary: c.summary,
    usage: c.usage,
  }));
}

// ---- Delm agent-n2: /run-n2 and /compare handlers ----
//
// Both spawn isolated shadow lanes (see compare-lanes.js) and bridge their
// agent-events back into THIS session's WS pipeline, so the running single
// agent session's mode is never mutated. /run-n2 = one dual-agent lane;
// /compare = one single-agent + one dual-agent lane, with a compare report
// written on completion.

// delm-10 RLM mode handler. Forms (see the /rlm COMMANDS entry):
//   /rlm                      — status
//   /rlm on | /rlm off        — session-level toggle (owner+admin), legacy alias
//                               for `/rlm session on|off`
//   /rlm session on|off       — session-level toggle (this session only)
//   /rlm <task>               — one-shot background RLM lane for a task
// The only switch is the session flag rec.rlm (the user-level scope,
// store.rlmUsers + `/rlm user on|off`, was removed).
function handleRlm(ctx) {
  const args = String((ctx && ctx.args) || '').trim();
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  if (!rec) { ctx.reply('(/rlm: session not found)'); return; }

  const emitRlmState = (rlm, scope) => {
    if (ctx.session && typeof ctx.session.emit === 'function') {
      ctx.session.emit('state-update', { kind: 'rlm-mode-changed', rlm, scope });
    }
  };

  // Bare /rlm — status read, no auth needed (mirrors /critic status).
  if (!args || args === 'status') {
    const scope = sessionsMod.getRlmScope(rec);
    // task req c: usage stats — how many times RLM was triggered and the
    // estimated context it saved this server lifetime.
    let statsLine = '';
    try {
      statsLine = '\n\n' + require('./agents/rlm/stats').statsLine(ctx.sessionId);
    } catch {}
    if (scope === 'session') {
      ctx.reply('🧠 RLM mode is **ON** for this session (session-level) — the next respawn runs with the RLM orchestration prompt (prompt-as-a-variable + recursive sub-agents). `/rlm session off` to revert.' + statsLine);
    } else {
      ctx.reply('🧠 RLM mode is **off** for this session. Enable with `/rlm session on` (this session only). Or `/rlm <task>` to run one task through a background RLM lane now.' + statsLine);
    }
    return;
  }

  // /rlm session on|off — session-level toggle (and legacy /rlm on|off).
  const sessMatch = args.match(/^(?:session\s+)?(on|off)$/);
  if (sessMatch) {
    const on = sessMatch[1] === 'on';
    if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) {
      ctx.reply(`(/rlm session ${on ? 'on' : 'off'} is owner+admin only. Session owner is @${rec.user}.)`);
      return;
    }
    rec.rlm = on;
    sessionsMod.saveStore();
    // 2026-11-11 hot toggle: apply to the LIVE session right away — pre-fix
    // the flag only landed on the next reaper respawn, so an alive session
    // kept running the plain engine while the badge said RLM ON (the
    // "RLM 很少被触发" root cause). applyRlmModeToLiveSession arms/disarms
    // IN PLACE (no kill): attached clients, lane bridges and the run queue
    // all hold the same session object. Lanes (/run-n2 /compare /rlm <task>)
    // still read rec.rlm per run — untouched.
    let appliedNote = '';
    try {
      const applied = sessionsMod.applyRlmModeToLiveSession(sessionId, rec);
      appliedNote = applied && applied.kind === 'deferred-to-respawn'
        ? ' (no live session — applies on next respawn)'
        : (applied && applied.kind === 'team-respawned')
          ? ' (team workers respawned — both now run the new engine)'
          : (applied && applied.kind === 'applied')
            ? ' (已热切换 — 本会话下一 turn 立即生效)'
            : '';
    } catch (err) {
      appliedNote = ` (hot-apply failed: ${err.message} — applies on next respawn)`;
    }
    emitRlmState(sessionsMod.isRlmEffective(rec), sessionsMod.getRlmScope(rec));
    ctx.reply(on
      ? '✓ RLM mode **enabled** for this session (session-level). Effects: single-agent conversations get the RLM kernel engine (persistent variables + rlm_eval + rlm.spawn sub-agents)' + appliedNote + '; agent-n2 sessions get the RLM overlay on both workers; `/run-n2` / `/compare` / `/rlm <task>` lanes pick it up immediately (each lane reads the flag when it starts). Board/team protocol keeps precedence in n2 mode; `/rlm session off` reverts.'
      : '✓ RLM mode **disabled** for this session' + appliedNote + '. The session returns to the plain prompts; lanes started afterwards run plain too. `/rlm session on` to re-enable.');
    return;
  }

  // /rlm user on|off was REMOVED (RLM is session-level only). Point the
  // user at the session-level command instead of silently no-op'ing.
  if (/^user\s+(on|off)$/.test(args)) {
    ctx.reply('(/rlm user on|off 已移除 — RLM 开关仅会话级。用 `/rlm session on|off` 或 `/rlm on|off` 控制本会话。)');
    return;
  }

  // /rlm <task> — one-shot background RLM lane (same shape as /run-n2).
  const task = args;
  if (!ctx.session || !ctx.session.alive) { ctx.reply('(/rlm: session not running)'); return; }
  const fs = require('fs');
  const rlm = require('./agents/rlm');
  const cwd = (ctx.absCwd || (ctx.session && ctx.session.cwd)) || process.cwd();
  const dir = rlm.ensureDir(rlm.timestampedDir(cwd, 'run'));
  const run = rlm.startRlmLane({
    cwd, user: ctx.user || null, task, dir,
    mainSession: ctx.session, mainSessionId: ctx.sessionId,
  });
  ctx.reply(`▶ /rlm 已启动：RLM lane（prompt-as-a-variable + 递归 sub-agent）跑「${task}」，进度会以 rlm 徽标实时滚动。`);
  rlm.onRlmLaneTerminal(run.lane, () => {
    ctx.reply(`✅ /rlm 完成：RLM lane 跑完「${task}」（日志在 \`_myco_/rlm/\`）。`);
  });
}

function handleRunN2(ctx) {
  const task = String((ctx && ctx.args) || '').trim();
  if (!task) { ctx.reply('Usage: `/run-n2 <task>` — runs <task> through a dual-agent (worker-A + worker-B) team lane.'); return; }
  if (!ctx.session || !ctx.session.alive) { ctx.reply('(/run-n2: session not running)'); return; }
  runN2CompareLanes(ctx, task, /* withSingle */ false);
}

function handleCompare(ctx) {
  const task = String((ctx && ctx.args) || '').trim();
  if (!task) { ctx.reply('Usage: `/compare <task>` — runs <task> through a single-agent AND a dual-agent lane side by side.'); return; }
  if (!ctx.session || !ctx.session.alive) { ctx.reply('(/compare: session not running)'); return; }
  runN2CompareLanes(ctx, task, /* withSingle */ true);
}

// Multi-expert team (专家团): /run-experts <task> — run the task through a
// team lane whose roster is the session's saved experts (rec.experts,
// created via the Experts UI / POST /sessions/:id/experts). Each expert's
// role prompt is built from its skills (prompts-team.js expertPrompt) —
// the board/queue collaboration core is the SAME as /run-n2's. The /run-n2
// handler + lanes are untouched.
function handleRunExperts(ctx) {
  const task = String((ctx && ctx.args) || '').trim();
  const rec = sessionsMod.getSessionRecord(ctx.sessionId);
  const experts = (rec && Array.isArray(rec.experts)) ? rec.experts : [];
  const fmtExpert = (e, i) => `**worker-${String.fromCharCode(65 + i)}** (${e.name})：${(e.skills || []).join(', ') || '(no skills)'}`;
  if (!task) {
    if (!experts.length) {
      ctx.reply('No experts saved for this session yet — create them in the **Experts** panel (each expert = a name + skills picked from the skill market), then `/run-experts <task>`.');
      return;
    }
    ctx.reply(`Saved expert team (${experts.length}):\n${experts.map(fmtExpert).join('\n')}\n\nUsage: \`/run-experts <task>\` runs the task through this team.`);
    return;
  }
  if (!ctx.session || !ctx.session.alive) { ctx.reply('(/run-experts: session not running)'); return; }
  if (!experts.length) { ctx.reply('(/run-experts: no experts saved — create them in the Experts panel first.)'); return; }
  if (experts.length > 8) { ctx.reply(`(/run-experts: ${experts.length} experts saved — capped at 8 per run.)`); return; }

  const fs = require('fs');
  const cl = require('./compare-lanes');
  const cwd = (ctx.absCwd || (ctx.session && ctx.session.cwd)) || process.cwd();
  const mainSession = ctx.session;
  const mainSessionId = ctx.sessionId;
  const rlmOn = !!(rec && sessionsMod.isRlmEffective(rec));

  // roster: worker-A..worker-N. expertSkills: actor -> [{name, description}]
  // — each expert's skill dir names resolved against the session's skill
  // store for name/description (skills.readSkill follows the session-root
  // symlinks that user/global-scope installs create).
  const roster = experts.map((_, i) => `worker-${String.fromCharCode(65 + i)}`);
  const describeAsync = (async () => {
    const skillsMod = require('./skills');
    const seen = new Map();
    for (const skillDir of experts.flatMap((e) => e.skills || [])) {
      if (seen.has(skillDir)) continue;
      try {
        const out = await skillsMod.readSkill(cwd, skillDir);
        seen.set(skillDir, { name: out.name || skillDir, description: out.description || '' });
      } catch { seen.set(skillDir, { name: skillDir, description: '' }); }
    }
    const es = {};
    experts.forEach((e, i) => {
      const actor = roster[i];
      es[actor] = (e.skills || []).map((d) => seen.get(d) || { name: d, description: '' });
    });
    return es;
  })();

  describeAsync.then((es) => {
    try {
      const dir2 = cl.timestampedDir(cwd, 'team');
      fs.mkdirSync(dir2, { recursive: true });
      const run = cl.startTeamLane({
        cwd, user: ctx.user || null, task, dir: dir2,
        mainSession, mainSessionId, roster, expertSkills: es, rlm: rlmOn,
      });
      const getQueue = () => (run.lane && run.lane.board ? run.lane.board.queueState() : []);
      const stopHeartbeat = cl.startProgressHeartbeat({
        lane: run.lane,
        label: `专家团（${experts.length}）`,
        startedAt: run.startedAt,
        reply: ctx.reply,
        getQueue,
      });
      let done = false;
      cl.onLaneTerminal(run.lane, true, () => {
        if (done) return;
        done = true;
        if (stopHeartbeat) stopHeartbeat();
        run.endedAt = Date.now();
        ctx.reply(`✅ /run-experts 完成：专家团（${experts.map((e) => e.name).join('、')}）跑「${task}」`);
      });
    } catch (err) {
      ctx.reply(`(/run-experts error: ${err.message})`);
    }
  }).catch((err) => ctx.reply(`(/run-experts error: ${err.message})`));
}

// N-path exploration (路径探索): /run-explore [N] <task> — N parallel
// explorers (path-1..path-N), each deep-diving ONE candidate solution
// path, coordinated ONLY through the shared board (decentralized — no
// central controller). Reuses TeamSession (explore mode) + the standard
// shadow-lane bridge + progress heartbeat. Workers are forced onto the
// RLM engine with a SHARED per-task harness key (self-evolution that
// accumulates across runs). A per-path evidence report is written to
// _myco_/explore/ on completion.
const EXPLORE_DEFAULT_PATHS = 4;
const EXPLORE_MAX_PATHS = 512;

function handleRunExplore(ctx) {
  const raw = String((ctx && ctx.args) || '').trim();
  if (!raw) {
    ctx.reply('Usage: `/run-explore [N] <task>` — N parallel explorers each deep-dive one candidate solution path (default N=4, 2..512). Example: `/run-explore 6 implement a lossless compressor beating X on ratio`.');
    return;
  }
  if (!ctx.session || !ctx.session.alive) { ctx.reply('(/run-explore: session not running)'); return; }

  // Optional leading N: '/run-explore 6 <task>'. A leading token that
  // parses as a small integer is taken as N; anything else is task text.
  let nPaths = EXPLORE_DEFAULT_PATHS;
  let task = raw;
  const head = raw.split(/\s+/)[0];
  if (/^\d{1,3}$/.test(head)) {
    nPaths = Number(head);
    task = raw.slice(head.length).trim();
    if (!task) { ctx.reply('Usage: `/run-explore [N] <task>` — N must be followed by the task text.'); return; }
    if (nPaths < 2 || nPaths > EXPLORE_MAX_PATHS) {
      ctx.reply(`(/run-explore: N must be 2..${EXPLORE_MAX_PATHS}, got ${nPaths}.)`);
      return;
    }
  }

  const fs = require('fs');
  const cl = require('./compare-lanes');
  const cwd = (ctx.absCwd || (ctx.session && ctx.session.cwd)) || process.cwd();
  const mainSession = ctx.session;
  const mainSessionId = ctx.sessionId;
  const run = { task, startedAt: new Date().toISOString() };

  try {
    const dir = cl.timestampedDir(cwd, 'explore');
    fs.mkdirSync(dir, { recursive: true });
    const explore = cl.startExploreLane({
      cwd, user: ctx.user || null, task, dir,
      mainSession, mainSessionId, nPaths,
    });
    const getQueue = () => (explore.lane && explore.lane.board ? explore.lane.board.queueState() : []);
    const taskLabel = `路径探索（${nPaths} 路）「${cl.shortTask(task)}」`;
    const buildFullText = ({ queue }) => {
      let full = `任务：${String(task || '').replace(/\s+/g, ' ').trim()}`;
      if (queue && Array.isArray(queue) && queue.length) {
        const items = queue
          .map((i) => `  · ${i.subject} [${i.state}${i.owner ? ':' + String(i.owner).replace(/^path-/, 'P') : ''}]`)
          .join('\n');
        full += `\n路径/子任务（${queue.length}）：\n${items}`;
      }
      return full;
    };
    const stopHeartbeat = cl.startProgressHeartbeat({
      lane: explore.lane,
      label: taskLabel,
      startedAt: explore.startedAt,
      reply: ctx.reply,
      getQueue,
      fullText: buildFullText,
    });
    ctx.reply(`▶ /run-explore 已启动：${nPaths} 个 explorer（path-1..path-${nPaths}）各深挖一条候选解法路径（去中心化 board 协调 · 共享自演进 harness · 进度会实时滚动）`);
    let done = false;
    cl.onLaneTerminal(explore.lane, true, () => {
      if (done) return;
      done = true;
      if (stopHeartbeat) stopHeartbeat();
      explore.endedAt = Date.now();
      let reportLine = `✅ /run-explore 完成：${nPaths} 路径探索跑「${cl.shortTask(task)}」`;
      try {
        const report = cl.buildExploreReport(run, explore);
        const file = cl.persistExploreReport(cwd, report);
        const donePaths = (report.summary.queue || []).filter((i) => i.state === 'done').length;
        const switches = (report.summary.strategySwitches || []).length;
        reportLine += `\n📊 **路径探索报告** 已写入 \`_myco_/explore/${String(file).split('/').pop()}\`` +
          `（路径 item 完成 ${donePaths}/${(report.summary.queue || []).length} · FAIL 证据 ${report.summary.failNotes.length} 条 · 工具 ${report.summary.metrics.toolUse} 次 · 策略切换 ${switches} 次）`;
      } catch (err) {
        reportLine += `\n(报告生成失败: ${err.message})`;
      }
      ctx.reply(reportLine, {
        meta: { kind: 'full-text', fullText: buildFullText({ queue: getQueue() }) },
      });
    });
  } catch (err) {
    ctx.reply(`(/run-explore error: ${err.message})`);
  }
}

function runN2CompareLanes(ctx, task, withSingle) {
  // Lazy require to dodge any require-cycle with the lane modules.
  const fs = require('fs');
  const path = require('path');
  const cl = require('./compare-lanes');
  const cwd = (ctx.absCwd || (ctx.session && ctx.session.cwd)) || process.cwd();
  const mainSession = ctx.session;
  const mainSessionId = ctx.sessionId;
  const user = ctx.user || null;
  const run = { task, startedAt: new Date().toISOString() };
  // §5.1: /run-n2 and /compare lanes read the effective RLM state — a lane
  // fired while the session (or the user-level switch) is in RLM mode runs
  // with the RLM overlay (single lane via spawnRlmAgent, n2 lane via
  // TeamSession's rlm addendum). Lanes are per-run so the flag applies
  // immediately, no respawn needed.
  const rec = sessionsMod.getSessionRecord(mainSessionId);
  const rlmOn = !!(rec && sessionsMod.isRlmEffective(rec));

  // No dual-column overlay: every lane (single AND dual) bridges with
  // laneTag=null so their events land in the MAIN timeline with worker
  // badges. /compare runs the lanes SEQUENTIALLY — single first, then the
  // dual lane — so each gets a clean wall-clock duration for the report.
  let single = null;
  let n2 = null;

  const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + 's');

  // Only /compare reaches finalize (and thus this reply), so the report is
  // ALWAYS the single-vs-dual comparison. /run-n2 is dual-agent ONLY and
  // never emits a report (see launchN2).
  const buildReportReply = (report, file) => {
    const s = report.summary.single;
    const t = report.summary.n2;
    const tm = report.timing || {};
    const lines = [
      `📊 **对比分析报告** 已写入 \`_myco_/compare/${String(file).split(path.sep).pop()}\``,
      `- 单 agent：工具 ${s.toolUse} · 输出 ${s.outputChars} 字符 · 运行 ${secs(tm.single)}`,
      `- 双 agent：工具 ${t.toolUse} · 输出 ${t.outputChars} 字符 · board ${t.boardEvents} · 运行 ${secs(tm.n2)}`,
    ];
    const speed = tm.single != null && tm.n2 != null
      ? `（双 agent ${secs(tm.n2)} vs 单 ${secs(tm.single)}，${tm.n2 <= tm.single ? '双 agent 更快' : '单 agent 更快'}）`
      : '';
    lines.push(`- 结论：${report.summary.verdict === 'n2' ? '双 agent 覆盖更充分' : '单 agent 已足够'} ${speed}`);
    ctx.reply(lines.join('\n'));
  };

  // Fire ONCE when the LAST lane has reached a terminal state; build +
  // persist the compare report and notify in-chat.
  let reported = false;
  const finalize = () => {
    if (reported) return;
    reported = true;
    try {
      // Captured as each lane ends so the duration excludes the other lane.
      const report = cl.buildCompareReport(run, single, n2);
      const file = cl.persistCompareReport(cwd, report);
      buildReportReply(report, file);
    } catch (err) {
      ctx.reply(`(对比报告生成失败: ${err.message})`);
    }
  };

  let stopHeartbeat = null;

  // onLaneTerminal fires the callback on the lane's TERMINAL signal. For
  // the single lane that's the one turn_result / iteration_aborted / fatal
  // event; for a team lane it's the team-level team-complete / team-failed
  // (post-fix: a worker's MID-RUN per-turn turn_result no longer completes
  // the lane — see compare-lanes.onLaneTerminal; pre-fix it did, and the
  // "✅ /run-n2 完成" line popped while both agents were still working).
  // The done-guards stay because the terminal signal can still arrive from
  // TWO registrations (startN2Lane's own lane-end bookkeeping vs this
  // handler) — exactly-once per lane either way.
  let singleDone = false;
  let n2Done = false;

  const launchN2 = () => {
    const dir2 = cl.timestampedDir(cwd, withSingle ? 'cmp' : 'n2');
    fs.mkdirSync(dir2, { recursive: true });
    n2 = cl.startN2Lane({ cwd, user, task, dir: dir2, mainSession, mainSessionId, laneTag: null, rlm: rlmOn });
    // A-1/A-2: surface live board sub-queue + per-worker activity so the user
    // sees the team making progress instead of a silent gap. The label names
    // the TASK (用户反馈: /run-n2 单流也要表明是什么任务) so concurrent runs
    // are distinguishable in the chat stream — `双 agent「task」` keeps the
    // leading `双 agent` prefix the progress-line tests + the /compare
    // two-phase banner both match on. Only the first few words of the task
    // are used (用户反馈: ⏳ 双 agent 打印后面不要把 prompt 全加上) so a
    // long prompt doesn't flood the chat line.
    const taskLabel = `双 agent（worker-A/B）「${cl.shortTask(task)}」`;
    const getQueue = () => (n2.lane && n2.lane.board ? n2.lane.board.queueState() : []);
    // Full-content builder for the hover tooltip (用户需求: 截断行鼠标放上去
    // 可以看到全部内容). Returns the ENTIRE task prompt + the complete board
    // queue (not just the 3-item sample the line shows).
    const buildFullText = ({ queue }) => {
      let full = `任务：${String(task || '').replace(/\s+/g, ' ').trim()}`;
      if (queue && Array.isArray(queue) && queue.length) {
        const items = queue
          .map((i) => `  · ${i.subject} [${i.state}${i.owner ? ':' + String(i.owner).replace(/^worker-/, '') : ''}]`)
          .join('\n');
        full += `\n子任务（${queue.length}）：\n${items}`;
      }
      return full;
    };
    stopHeartbeat = cl.startProgressHeartbeat({
      lane: n2.lane,
      label: taskLabel,
      startedAt: n2.startedAt,
      reply: ctx.reply,
      getQueue,
      fullText: buildFullText,
    });
    // /compare produces the comparison report; /run-n2 is dual-agent ONLY —
    // it just runs and finishes with a light completion notice, no report.
    cl.onLaneTerminal(n2.lane, true, () => {
      if (n2Done) return;
      n2Done = true;
      if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
      n2.endedAt = Date.now();
      if (withSingle) finalize();
      else ctx.reply(`✅ /run-n2 完成：双 agent 跑「${cl.shortTask(task)}」`, {
        meta: { kind: 'full-text', fullText: buildFullText({ queue: getQueue() }) },
      });
    });
  };

  try {
    if (withSingle) {
      const dir = cl.timestampedDir(cwd, 'cmp');
      fs.mkdirSync(dir, { recursive: true });
      if (rlmOn) {
        // §5.1: /compare's single lane runs the RLM engine when the
        // session opted in, so the comparison is RLM-vs-RLM-team rather
        // than plain-vs-team (fair comparison dimension).
        const rlmMod = require('./agents/rlm');
        single = rlmMod.startRlmLane({
          cwd, user, task, dir, mainSession, mainSessionId, laneTag: null,
        });
      } else {
        single = cl.startSingleLane({ cwd, user, task, dir, mainSession, mainSessionId, laneTag: null });
      }
      ctx.reply(`▶ /compare 已启动（2 阶段，进度会实时滚动）：①单 agent 跑「${task}」→ ②双 agent（worker-A/B）`);
      stopHeartbeat = cl.startProgressHeartbeat({
        lane: single.lane,
        label: '单 agent',
        startedAt: single.startedAt,
        reply: ctx.reply,
        getQueue: null,
      });
      cl.onLaneTerminal(single.lane, false, () => {
        if (singleDone) return;
        singleDone = true;
        if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
        single.endedAt = Date.now();
        ctx.reply('✅ 单 agent 阶段完成，双 agent 阶段进行中…');
        launchN2();
      });
    } else {
      ctx.reply(`▶ /run-n2 已启动：双 agent（worker-A + worker-B）跑「${task}」（进度会实时滚动）`);
      launchN2();
    }
  } catch (err) {
    if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
    ctx.reply(`(/run error: ${err.message})`);
  }
}

module.exports = {
  dispatch,
  parseCommand,
  listCommands,
  ASSISTANT_USER,
  // fr-102: exported so the picker UI + test/fr-102 can share one
  // source of truth for the supported-models list.
  SUPPORTED_MODELS,
  // fr-102: exposed for unit testing in isolation.
  handleModel,
  // fr-103: exposed for unit testing /login parse + gate logic.
  handleLogin,
  // bug-90: exposed for unit testing /critic parse + gate logic.
  handleCritic,
  // bug-91: exposed for unit testing /setgiteelogin parse + gate logic.
  handleSetGiteeLogin,
  // fr-105: exposed for unit testing the auto-derive-gitee-login
  // behavior added to /setpat.
  handleSetPat,
  // Delm agent-n2: exposed for unit testing the /run-n2 + /compare
  // command wiring (test/slash-n2-compare.test.js).
  handleRunN2,
  handleCompare,
  runN2CompareLanes,
  // Multi-expert team (专家团): exposed for unit testing the /run-experts
  // parse + gate logic (test/team-multi-experts.test.js).
  handleRunExperts,
  // /run-explore (路径探索): exposed for unit testing N parsing + wiring.
  handleRunExplore,
  // delm-10 RLM mode: exposed for unit testing the /rlm parse + gate
  // logic (test/rlm-mode.test.js).
  handleRlm,
  // Research mode + domain knowledge base: exposed for unit testing the
  // /research and /kb parse + gate logic.
  handleResearch,
  handleKb,
  // Exposed for artifacts.js refresh hook + future callers.
  mergePlanItems,
  dedupePlanItems,
  // Exposed for testing the project-context loader.
  _loadProjectContext,
  // fr-54: exposed for unit-testing the shell-style arg splitter
  // /git uses (quoted phrases, escapes, etc.).
  _parseShellArgs,
  // bug-88: exposed for unit-testing the /git clone PAT-reuse
  // rewrite (per-repo → user-level lookup, embedded-credential
  // respect, redaction contract).
  handleGit,
  _hostFromCloneUrl,
  _cloneUrlWithStoredPat,
};
