# Best Practices

These guidelines are auto-injected at the top of the Architecture pane.
Toggle them off via the **Best practices** checkbox in the Arch tab if
they don't apply to this project.

## 1. Refactor opportunistically — high cohesion, low coupling

Every change is also a chance to simplify. Look for ways to:

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

---

*Toggle this section off via the **Best practices** checkbox if your
project follows different conventions.*
