# Best Practices

These guidelines are auto-injected at the top of the Architecture pane.
Toggle them off via the **Best practices** checkbox in the Arch tab if
they don't apply to this project.

## 0. Prefer `ctx_*` (lean-ctx) over built-in Read / Bash for context-only reads

The `lean-ctx` MCP server is wired into every session and exposes
`mcp__lean-ctx__ctx_*` tools that compress file reads + shell output
dramatically before they hit the context (a 60 KB JS file becomes
~250 bytes via `ctx_read --mode map`). Use them by default for
**context-gathering** reads:

- **`ctx_read <path> --mode map`** — file outline / API surface only.
  Use when you just want to know what a file does.
- **`ctx_read <path> --mode signatures`** — class + function signatures.
  Use when you need to call into a file but don't need bodies.
- **`ctx_read <path> --mode full`** — same as built-in Read. Use ONLY
  when you're about to edit the file (full body needed for Edit).
- **`ctx_read <path> --mode lines:N-M`** — surgical line range.

For editing, the built-in `Edit` / `Write` tools are still the right
choice (no compression on the write path; lean-ctx's edit modes are
fallback only).

For shell, `ctx_shell <cmd>` filters the noisy bits of common output
(git, npm, cargo, etc.) before returning. Use it interchangeably
with Bash for read-mostly invocations (`git log`, `npm test`, `cargo
check`); use Bash when you need the raw stream verbatim.

## 1. High cohesion, low coupling — single place for related responsibility, independent + test-friendly by construction

The first principle of how code is shaped in this repo. Design to it
up-front; refactor toward it whenever a change reveals you've drifted.

1. **High cohesion — single place for all related responsibility.**
   Each module owns ONE responsibility, and ALL the code for that
   responsibility lives in that ONE module. If you have to read three
   files to understand a single concept, it's spread too thin —
   consolidate. If one file mixes two unrelated concepts, it's
   diluted — split it. The acid test: can a teammate explain the
   module's purpose in one sentence?

2. **Low coupling — narrow, named interfaces.** Modules communicate
   through explicit interfaces (function arguments, named exports,
   typed protocol messages) — never through shared mutable globals,
   filesystem side-effects, or order-dependent side imports. The
   blast radius of any change should be contained to its module +
   the documented surface it exposes. If a one-line edit ripples
   across the repo, the surface is too wide.

3. **Independent and test-friendly to ensure correctness.** Because
   coupling is low, each module can be exercised in isolation by a
   test that doesn't drag in the rest of the system. Because cohesion
   is high, that test asserts exactly one responsibility. The two
   properties together ARE what makes a codebase verifiable — every
   piece of behaviour has a test that runs on its own and fails
   precisely when that behaviour breaks. This isn't a nice-to-have;
   it's the only way to keep a growing codebase trustworthy.

**Refactoring corollary.** Every change is also a chance to simplify.
Look for ways to:

- Split functions doing more than one thing.
- Pull duplicated logic into shared helpers; remove the duplicates.
- Pass dependencies in (constructor / function args), not import them
  globally — keeps modules independently testable.
- Group related state + behaviour into one module; let unrelated
  modules talk through a narrow, named interface.
- Delete code that no longer has a caller — dead branches age into
  bugs.

If you're surprised by where a change ripples, that's a coupling
signal. Don't ignore it; capture the smell in the commit message even
if you're not refactoring this pass.

## 2. Tests come with the change — runnable by a human, framework-standard

Every feature, bug fix, or refactor lands with a test that would have
caught the original problem.

- **C / C++**: GoogleTest (`gtest`). One `TEST` per behaviour;
  arrange/act/assert per block.
- **Python**: pytest. One `test_*` function per behaviour;
  fixtures for shared setup; parametrise rather than copy-paste.
- **JavaScript / Node**: framework already chosen by the project (e.g.
  the repo's existing `node test/*.test.js` pattern). Don't introduce a
  new test runner if one is in use.
- Tests must be **runnable from the command line** by a human —
  `pytest tests/`, `ctest`, `node test/foo.test.js` — without needing
  an LLM to interpret or set up.
- A single test failure prints a clear assertion message naming WHAT
  was expected vs WHAT was observed.
- **Run the FULL test suite before every commit — not cherry-picked
  adjacent files.** Per-file `node test/foo.test.js` (or
  `pytest tests/foo_test.py`) sweeps are NOT a substitute for the
  project's whole-suite entrypoint (`./test.sh`, `make test`, `pytest`,
  `cargo test`). The whole-suite run catches static-check drift, cross-
  module contract changes, and environment-level failures that
  cherry-picked sweeps miss. If the entrypoint aborts early on a
  host-config issue (missing binary, busybox vs GNU tools), fix the
  host or the script — don't skip the suite.

## 3. Generated scripts must be runnable by a human

Anything shipped as a script (build, deploy, fix-up migration, data
backfill) MUST be reproducible by a human running it from a normal
shell — no LLM in the loop at execution time.

- Plain `bash` / `sh` / `python` / `node` invocation; no chat-driven
  steps embedded.
- All inputs are CLI flags or env vars, not interactive prompts
  (unless the prompt has a non-interactive fallback).
- Errors print enough context to debug without re-running with
  extra logging.
- Idempotent where possible — re-running shouldn't break previous
  state.

## 4. Reuse existing scripts for test / build / deploy

Before writing a one-off command sequence in chat, check whether the
project already has a script for it. If it almost-exists, **extend it
in place** rather than copy-paste a chat-only variant.

Common scripts to check for:

- `./test.sh`, `./run-tests.sh`, `make test`, `pytest`, `cargo test`
- `./build.sh`, `make`, `npm run build`, `cargo build`
- `./deploy.sh`, `./release.sh`, `make deploy`

If you find yourself composing a multi-step shell sequence, that's a
strong signal it should become a script (or be added to an existing
one).

## 5. Project memory under `_myco_/` belongs in git — commit + push every change

The `_myco_/` directory is the **shared, team-visible memory of the
project**. Everything under it is a first-class artifact that other
collaborators (and future agent runs) depend on. Commit + push any
change you make to it the same way you'd commit code.

What lives there:

- `plan.json` — todos / feature requests / bugs (`/td`, `/fr`, `/bug`)
  with votes, comments, run-status, and per-item run-summary findings
  posted back by the agent after each `▶ Run` dispatch.
- `architecture.md` — long-form architecture notes the Arch-tab
  extractor refreshes; the canonical "why is this thing shaped this
  way" doc for the project.
- `bash-elapsed.json` — rolling history of shell-command elapsed
  times + known-slow patterns. Agents read this on session start to
  decide whether to delegate long commands to a subagent. Shared
  memory means every collaborator benefits from the runtime norms
  one of them learned.
- `README.md` — humans-only explainer of what lives in `_myco_/`
  for someone browsing the repo on GitHub.
- Future memory files the agent adds (e.g. failure-pattern catalogs,
  per-feature design notes).

**Why it matters.** Without committing `_myco_/`, every fresh clone /
new teammate starts with no project memory — they re-discover the
slow commands, re-vote on done plan items, and re-ask the same
architectural questions. With it, the team operates on shared ground
truth and onboarding is "git clone + open the Plan tab."

**Commit cadence:** commit `_myco_/` whenever you commit code that
relates to it (a plan-item closeout alongside the feature commit, an
architecture-doc update alongside the structural change). For pure
memory drift (the running session reformatted plan.json, or new
bash-elapsed samples landed), commit it as a standalone
`memory: sync` commit so the trail stays auditable. Don't let it
sit uncommitted across sessions — the next teammate's `git pull`
should be enough to give them the latest state.

**`.gitignore`:** never add `_myco_/` to `.gitignore`. The only
sub-paths that may go ignored are transient working files (e.g.
`_myco_/logs/` daily log captures, `_myco_/cache/`) — those should
have their own `.gitignore` entry inside `_myco_/`, not at the
project root.

## 6. Every user-reported problem ships with a regression test — automatically

When the user reports a bug, surprise, or "this looks wrong" — no
matter how small — add a test that would have caught the original
problem BEFORE shipping the fix. This is not optional, and it is
not a separate task the user has to ask for.

**The flow is:**

1. User reports a problem (anywhere — chat, voice memo, /bug, a
   screenshot, "hmm that's weird"). Repeat it back in your own words
   so you've understood the symptom precisely.
2. Write a test that fails the way the user's report fails. Run it
   to confirm it red-flips against the current code. If the project's
   test framework can't easily express the failure, write the
   smallest meaningful surrogate (static-grep guard, DOM-shape
   assertion, server-route smoke) — better a partial guard than no
   guard at all.
3. Implement the fix until the test goes green.
4. Wire the test into the project's runner (`./test.sh`,
   `pytest`, `cargo test`, …) so it runs on every future change.
5. Note the regression in the commit message: "fix: <bug>. test:
   `test/<name>` would have caught it."

**Why "automatic" instead of "when asked":**

- The user reporting a problem twice means they should never see
  it a third time. A test is the only way to make that promise.
- Reports are the single highest-signal source of "what really
  breaks in this code" — the issues users actually hit are worth
  catching, the imagined ones are not.
- Tests written from a user's words capture the user-visible
  contract, not just the implementer's mental model. They're
  durable through refactors that touch the internal shape.
- Without the rule, every user report becomes a one-shot fix; the
  same class of bug re-lands in 2 weeks under a different name.

**Scope of "problem":**

- Functional bug: "the X never shows up after Y"
- Visual / UX surprise: "this looks like it belongs in the chrome
  strip instead of the chat bubble"
- Performance regression: "saving takes 8 s now, used to be 0.5 s"
- Cross-device / cross-browser drift: "works on laptop, missing on
  phone"
- Data-loss / persistence gap: "I switched tabs and the reply
  disappeared"

All of these count. The test doesn't have to be elaborate — even a
single `grep` that asserts the fix's marker stays present is a
sufficient floor. The point is: the user's complaint must be encoded
in code so the next iteration can't quietly re-break it.

## 7. Anchor every Bash command to the session workspace directory

Every Bash invocation must run with the **session workspace directory**
as its working directory — the folder that contains this `CLAUDE.md`,
the `_myco_/` artifact mirror, and the project's checked-out source.
Concretely, that's `WORKSPACE/<user>/<session-id>/` (e.g.
`/wks/kkrazy/myco-kkrazy-6bd8b83e/`), the path the SDK sets as
`options.cwd` when launching the agent.

**Why this is a rule, not a default.** Some harnesses (and some
parallel-tool execution patterns) reset the working directory between
Bash invocations. A command that worked in turn N — `cd foo && ./test.sh`
— may resolve `foo` against a completely different parent dir in turn N+1,
silently failing or running the wrong binary. Anchoring every command
removes the foot-gun.

**Patterns that work:**

- **Absolute paths under the session wks**, the cleanest option:
  ```bash
  wc -l /wks/kkrazy/myco-kkrazy-abc/src/index.js
  cat /wks/kkrazy/myco-kkrazy-abc/_myco_/plan.json
  ```
- **`-C <dir>` flags** on tools that accept them — no cwd dependency:
  ```bash
  git   -C /wks/kkrazy/myco-kkrazy-abc status
  make  -C /wks/kkrazy/myco-kkrazy-abc test
  ```
- **`cd <session-wks> && <command>`** chained in a single Bash
  invocation. The `cd` is local to that one call, so it's safe — just
  don't expect it to persist to the next call.
- **`working_directory` parameter** if your Bash tool exposes one —
  takes precedence over inherited cwd. Use it when available.

**Patterns that break:**

- `cd foo` in one Bash call, then `ls` in the next — the second call
  may run from `/`, `/root`, or wherever the harness reset cwd to.
- Relying on shell exports / aliases across invocations.
- Relative paths without anchoring: `./test.sh` in a "set-and-forget"
  context can run any test.sh that happens to live in the current dir.
- Assuming `~` expands to the human user's home — in containerized
  agent runs, `~` is typically `/root` or `/home/agent`, not the
  session wks.

**How to find "the session workspace" at runtime:**

- It's the directory containing this `CLAUDE.md`.
- It's `process.cwd()` on the agent's first Bash invocation in a
  fresh session (before any `cd`).
- For parallel tool calls, capture it explicitly:
  ```bash
  pwd > /tmp/session-wks.txt   # once at start
  SESSION_WKS=$(cat /tmp/session-wks.txt) <command>   # everywhere else
  ```

**When in doubt:** run `pwd && ls` once at the start of a task, store
the absolute path, and use it as an explicit prefix on every
subsequent Bash command. The cost of an extra 60 characters per
command is trivial; the cost of running the wrong file is not.

## 8. Anti-bloat, anti-assumption discipline for AI-assisted edits

*(Adapted from the [karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)
`CLAUDE.md` — Andrej Karpathy's January 2026 critique of how LLMs
misbehave when writing code, distilled into agent rules.)*

These rules apply BEFORE you start typing code, not after.

1. **State assumptions explicitly when the request is ambiguous.** If
   "add validation to the login form" admits more than one
   interpretation — what kinds of validation? client- or server-side?
   what error UX? — list the interpretations in your reply BEFORE you
   write a line of code, and pick the one the user confirms. Silently
   picking an interpretation is the #1 source of work the user has to
   throw away.

2. **Surface confusion; ask rather than guess.** When something is
   unclear — an API contract you can't find, two files with the same
   name, a config that contradicts the docs — say so explicitly and
   ask. Plausible-looking-but-wrong code is more expensive than a
   clarifying question.

3. **No speculative features, abstractions, or configurability.**
   Build exactly what was asked, nothing more. No flags "for later
   use", no interfaces with one implementation, no error handling for
   branches that can't fire today, no factory functions in front of a
   single concrete class. If the user needs the abstraction tomorrow,
   they'll ask tomorrow.

4. **Surgical edits — every changed line must trace to the request.**
   When you open a file to fix bug X, fix bug X. Do not also tidy
   adjacent code, normalize unrelated comments, or "improve"
   formatting that you happen to see. If you notice a smell, mention
   it in the commit message or as a follow-up note — don't ship it as
   part of the bug-fix diff. (This is the boundary on §1's "refactor
   opportunistically": refactor when the *change rationale* demands
   it, not when the file happens to be open.)

5. **Multi-step work ships with a numbered plan + per-step
   verification.** When a task has 3+ distinct steps, write them out
   as `1. … 2. … 3. …` BEFORE starting, and end each step with an
   explicit `verify:` clause naming the check that proves the step
   landed (an assertion, a test run, a curl, a `git diff --stat`).
   Strong checks let the agent iterate autonomously; vague checks
   ("make it work") force the user to babysit.

**Why these matter for myco specifically.** Sessions are long,
parallel, and partly autonomous (the `/run` mechanism dispatches work
without per-step approval). Multi-user sharing means a silently-wrong
assumption shows up not just to the requester but to every collaborator
attached to the session. These rules front-load the clarifying step so
the autonomous portion runs on a confirmed, witnessed premise.

---

*Toggle this section off via the **Best practices** checkbox if your
project follows different conventions.*
