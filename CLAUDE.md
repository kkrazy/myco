# Mycelium — Claude Code Instructions

## Working in this repo

1. **Always prefer existing scripts over ad-hoc commands.** Before composing a one-off shell sequence, look for a script that already does the job (`./test.sh`, `./test-browser.sh`, `./deploy.sh`, `./install-tls.sh`, etc.). If one exists, run it. If one almost exists, extend it rather than copy-pasting its logic into a new chat-only command. This keeps behaviour reproducible and the CI/dev paths in sync.

2. **Delegate long-running tasks to a subagent.** Deploys, Docker builds, multi-step SSH sequences, and large refactors that span many files belong in a subagent (via the Agent tool), not the main conversation loop. Brief the subagent fully — paths, the relevant commit SHA, constraints, what *not* to touch — and ask for a short report back. Quick one-shot edits, single greps, and small reads stay in the main loop.

3. **Task-list etiquette — `/task`, `/skip`, `/cancel`, and stale-task reminders.** The user can intervene in your internal TaskList from the chat pane via three slash commands. The server (see `server/src/slashcmds.js handleTaskList` + `handleTaskSkip`) forwards them to your running session as a natural-language directive:

   - **`/task`** → the server sends *"Please list your current pending and in-progress internal tasks (TaskList). Format as a short numbered list with id + subject."* — reply with every `pending` and `in_progress` task with id + subject, max ~15 lines. Don't dump completed/deleted tasks — they're noise.
   - **`/skip <id>`** or **`/cancel <id>`** → the server sends *"Please dismiss internal task #N via TaskUpdate({ taskId, status: 'deleted' })…"* — run that update and reply with one line confirming the dismissal (`✓ task #N dismissed — <subject>`). If the id is unknown, say so and offer to run `/task` first.
   - **Stale-task heads-up — proactively volunteer.** Every time the user message looks like a continuation of an existing thread, scan the task list reminders for entries that have been `pending` for what looks like a long time (e.g., spans more than one user-message worth of work and isn't on your immediate critical path, or is explicitly user-owned like "user will handle"). If you see one, prepend a one-line `📌 Heads up: task #N still <pending|in_progress> — <subject>. Use \`/skip N\` to dismiss or \`/cancel N\` to drop.` to your reply. Keep it to one line — don't lecture, just remind. Skip the reminder when there's nothing stale or when you've already mentioned the same id in the immediate prior reply (no double-nag).
   - **When YOU mark a task completed**, you don't need the `📌 Heads up` line — that's only for the tasks the user can act on.

## Session storage

1. **Session folder = session id.** Every new session spawned via the
   spawn modal lives at `WORKSPACE/<user>/<session-id>/` (e.g.
   `/wks/kkrazy/myco-kkrazy-6bd8b83e/`). The spawn-modal text input is
   an optional friendly *display label*, not a path. Predictable,
   collision-proof. Existing sessions with arbitrary `rec.cwd` values
   (e.g. `test006`, `myco`) keep working — only NEW spawns use the
   id-as-folder rule.

2. **All session-scoped state lives under `WORKSPACE/<user>/<session-id>/`.**
   - `_myco_/` — extracted artifacts (`plan.json`, `arch.md`, `test.md`,
     `README`). Checked into the project's git so the plan + arch +
     test sheet move with the code.
   - `.claude/memory/` — the SDK's auto-memory directory for this
     session (set via `settings.autoMemoryDirectory` on every
     `query()` call in `server/src/agent-session.js`). Replaces the
     SDK default `$HOME/.claude/projects/<sanitized-cwd>/memory/`,
     which would otherwise pool every session's memory into the
     shared container `/root/.claude/`.
   - `.claude/settings.json` + `.claude/settings.local.json` — per-
     project SDK settings (permissions, allow-list rules persisted by
     the SDK's "Allow always" picks, etc.). Loaded via
     `settingSources: ['project', 'local']`; the shared `'user'` tier
     (`$HOME/.claude/settings.json`) is deliberately excluded so
     sessions don't bleed config across each other.
   - `CLAUDE.md` — project-level instructions for the SDK conversation
     (templated from the myco best-practices block on first spawn).
   - Anything else claude writes (Bash output to relative paths,
     Edit/Write tool destinations) lands here too because
     `options.cwd` points at this folder.

3. **What still lives at the container level (NOT per-session):**
   - `/data/sessions.json` — the session registry (id, label, cwd,
     mode, allow/deny lists, chat history). Cross-session shared.
   - `/data/auth-sessions.json` + `/data/gh-tokens.json` — auth state,
     shared across all sessions for a user.
   - `/root/.claude/.credentials.json` — SDK auth, shared. (Per-user,
     not per-session.)

## Pre-Commit

1. **Always run `./test.sh` before committing.** Fix any failures before proceeding with the commit.

2. **Every new feature must come with a test.** When you add a behaviour to `server/`, `web/public/`, the Dockerfile, or any deploy/runtime path, also add a check to `./test.sh` that would have caught the bug if the feature regressed. Static-only behaviour can usually be a `grep` or a `node -e` check; runtime behaviour belongs in the persistence/server-smoke section that runs the real container. Aim for the smallest test that fails meaningfully if the feature breaks. Bug fixes also count as features — write the regression test before (or alongside) the fix so it red-green-flips.

## Deployment

1. **Always deploy via `./deploy.sh`.** It builds the Docker image locally, streams it over SSH to `myco.labxnow.ai`, and swaps the container against a single bind-mounted state directory. Do not push raw source or `systemctl restart` on the remote.

2. **Deploying to `mycobeta.labxnow.ai`: do it on the host itself.** Local Docker is often unavailable, so the working recipe (verified 2026-05-11) is: `git archive HEAD -o /tmp/myco-src.tgz`, `scp` it to `kkrazy@mycobeta.labxnow.ai:/tmp/`, extract into `~/myco-src` (overwriting), then `ssh kkrazy@mycobeta.labxnow.ai 'cd ~/myco-src && MYCO_DEPLOY_HOST=kkrazy@localhost ./deploy.sh'`. The script SSHes back to localhost on mycobeta and runs the normal build/swap there. ssh-to-self on mycobeta is already set up.

3. **Single-state-dir layout** (the deploy.sh contract):
   - One host directory holds *all* persistent state. Default: `MYCO_STATE_DIR=/home/kkrazy/myco-state` (override with the env var).
   - Container bind-mounts:
     ```
     $MYCO_STATE_DIR        → /data    (sessions.json, .env, auth-sessions.json,
                                        allowed-github-users.txt, gh-tokens.json, caddy/, …)
     $MYCO_STATE_DIR/home   → /root    (claude config: .claude/, .claude.json)
     $MYCO_STATE_DIR/wks    → /wks     (workspaces)
     $MYCO_STATE_DIR/Caddyfile → /etc/caddy/Caddyfile  (read-only)
     ```
   - No named or anonymous Docker volumes — everything is reachable from the host. Backup = tar the state dir; restore = untar and `docker run`.
   - The Caddyfile lives in the state dir too — `deploy.sh` seeds it from `/home/kkrazy/myco/Caddyfile` (remote) or the project tree (local) on first deploy.

4. **Auth: GitHub OAuth + invitation allowlist.**
   - Required env in `$STATE_DIR/.env`: `MYCO_GH_CLIENT_ID`, `MYCO_GH_CLIENT_SECRET`, `MYCO_PUBLIC_ORIGIN` (e.g. `https://myco.labxnow.ai`). Set with `./deploy.sh --set-oauth <id>:<secret>`.
   - The OAuth App's callback must be `<MYCO_PUBLIC_ORIGIN>/auth/github/callback`. Scopes requested: `read:user user:email repo`.
   - `$STATE_DIR/allowed-github-users.txt` lists invited GitHub logins, one per line (`#` comments). Only listed users can complete sign-in. Add with `./deploy.sh --allow-github-user <login>` (idempotent, no container restart).
   - Minted myco session tokens live in `$STATE_DIR/auth-sessions.json` (mode 0600, 30-day sliding TTL).
   - The OAuth access token for each user is mirrored into `$STATE_DIR/gh-tokens.json` (mode 0600) — used by `/feature`/`/bug` slash commands and any future git operations.

5. **Override knobs:** `MYCO_DEPLOY_HOST`, `MYCO_STATE_DIR`, `MYCO_IMAGE_TAG`, `MYCO_CONTAINER`. `--skip-tests` skips `./test.sh`, `--dry-run` reports the plan without shipping or swapping.

## Troubleshooting

1. **`[connecting...] / [reconnecting...]` loop in the terminal pane, no `/attach/` requests in `docker logs myco`** — the browser is failing the WSS handshake before it reaches the server. Verify the server is fine first by hitting it from a different network: `curl -sk -i --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "https://myco.labxnow.ai/attach/<session-id>"` should return `101 Switching Protocols` and stream output. If it does, the user's network/firewall is dropping or stripping WS upgrade traffic — common culprits: corporate firewalls/DPI, VPN clients, antivirus that proxies HTTPS, browser extensions, or a stale `alt-svc: h3=":443"` cached by the browser pointing at HTTP/3 (which doesn't support WebSocket — clear via `chrome://net-internals/#alt-svc` or test in incognito). Disabling HTTP/3 in `Caddyfile` (`servers { protocols h1 h2 }`) is the quick remediation.

2. **OAuth callback shows "Login failed: OAuth state expired or invalid"** — the user took too long (>5 min) on the GitHub authorize page, or the server restarted between `/auth/github/start` and the callback (state nonces are in-memory). Click "Sign in with GitHub" again. If the failure is reproducible immediately, check `MYCO_PUBLIC_ORIGIN` in `.env` matches the host the user is browsing — a mismatch means the redirect_uri sent to GitHub doesn't match the OAuth App registration, and GitHub will return an error parameter.

3. **OAuth callback shows "Not invited yet"** — the GitHub login isn't in `$STATE_DIR/allowed-github-users.txt`. Add with `./deploy.sh --allow-github-user <login>` and have the user retry. No container restart needed (the file is read on each login attempt).

4. **`/feature`/`/bug` reports "no GitHub token on file"** — the OAuth grant didn't include the `repo` scope (older sign-ins predating the scope addition), or the user revoked the token from GitHub Settings → Applications. The user signs out (status-bar `@username` → confirm) and back in to refresh.

## Code Style

1. **Break functionality into small functions with one clear responsibility.** Aim for fewer than ~80 lines per function. If a function is doing setup + work + teardown, or covers more than one concept, split it. Name each function for what it does (`build_image`, `seed_caddyfile`, `test_persist_after_restart`) — the call site should read like prose. Top-level orchestration belongs in a `main()` (or equivalent) that just sequences the named steps. This keeps diffs reviewable and makes scripts/code easy to extend without rewriting the world.

2. **All regexes that match claude's PTY/TUI output live in `server/src/pty-patterns.js`.** Whenever you need to detect anything claude renders to its terminal — menu markers, question lines, status-bar mode hints, permission-dialog labels, anything new — add the pattern there as a named `<SURFACE>_<WHAT>_RE` constant with a docstring that quotes the exact claude output the regex is meant to match. Then import it from the consumer (menu-interceptor.js, permissions.js, pty.js, future files). Do NOT inline TUI-matching regexes at the call site, and do NOT scatter them across modules — claude code's rendering shifts between releases, and we want every patch to land in one file. Excluded from this file: regexes that parse user input, our own config, or non-TUI text (those stay with their callers).

## Design Guidelines

1. **Always use Mermaid diagrams** for any architecture, flow, sequence, or state diagrams. Never use ASCII art boxes or plain-text diagrams.

## Diagnostics

1. **Polling the local mycod with `./collect-logs.sh`.** The running myco server (mycod) is a Node process inside a Docker container (PID 1 in the `myco` container). Its stdout/stderr is captured into an in-memory rolling buffer by `server/src/logCapture.js` (CAPACITY = 5000, see `logCapture.init()` wiring in `server/src/index.js`). A bearer-gated `GET /logs?n=N` endpoint exposes that buffer over HTTP. `./collect-logs.sh` is the human/cron-runnable helper that:

   - **Polls the LOCAL mycod** at `http://127.0.0.1:$MYCO_PORT/logs?n=500`. Auth bearer is picked automatically — latest unexpired session for `$MYCO_LOG_LOGIN` (default `kkrazy`) from `$MYCO_AUTH_FILE` (default `/data/auth-sessions.json`). No shared secret in the script.
   - **Also polls mycobeta** via `ssh kkrazy@mycobeta.labxnow.ai 'docker logs myco --since=<marker> --timestamps'`. Mycobeta-specific because the `[ws-attach]` / `[diag-resume]` instrumentation only ships there. Marker tracks the last fetch so consecutive runs only pull the delta. Phase-2 failures are warnings, not fatal — local phase 1 still runs.
   - **Dedups by `ts\tlevel\tmsg`** against the per-UTC-day files under `_myco_/logs/` (`.gitignore`d). Idempotent — re-running cost is just the dedup pass.
   - Flags: `--skip-mycobeta` / `--skip-local`, `--mycobeta-since <duration>`, `--n <N>`, `--login <user>`.

2. **`/loop` cron consumer.** The diagnostic /loop tick (cadence chosen by the user, currently 10 min) calls `./collect-logs.sh` each fire, then reads the fresh `+L` / `+M` lines per source and scans for resume-bug + menu-sync + general-error markers. The loop posts a one-line `📡 [diag-loop]` summary to chat every tick — even when there's nothing notable — so a quiet system is visibly alive. Auto-fix authority is limited to trivial fixes (log noise, typos, one-line bugs); anything touching WS protocol / auth / deploy / framing waits for explicit user approval. See the loop prompt in the active `CronList` for the full filter spec.

3. **Adding new log markers.** When you instrument something for the loop to catch, give it a stable bracketed prefix (e.g. `[ws-attach]`, `[diag-resume]`, `[menu-pick]`) so the filters in step 2 can pick it out cleanly without ambiguous substring matches. Mirror the addition into the loop prompt's filter buckets so the next tick actually reports it.

## Bash command timing — agent runtime hygiene

**Goal:** keep the user from feeling "stuck" behind a long-running shell command. Track elapsed times per command, learn which ones are slow, and pre-emptively delegate the slow ones to a background subagent so the main conversation loop stays responsive.

1. **Project memory at `_myco_/bash-elapsed.json`.** A simple JSON file the agent maintains across sessions:

   ```json
   {
     "samples": [
       { "cmd": "./test.sh",         "elapsedMs": 42300, "ts": "2026-05-17T01:30:00Z" },
       { "cmd": "./deploy.sh",        "elapsedMs": 95000, "ts": "2026-05-17T01:34:11Z" },
       { "cmd": "docker build .",     "elapsedMs": 30200, "ts": "2026-05-17T02:00:00Z" }
     ],
     "knownSlowPatterns": [
       { "pattern": "^(\\./test\\.sh|\\./deploy\\.sh|docker build)", "p95Ms": 45000 }
     ]
   }
   ```

   Each Bash invocation records `{cmd-normalized, elapsedMs, ts}`. Cap at the last 200 samples (oldest dropped). The agent recomputes `p95Ms` per matched pattern from the rolling sample window.

2. **Auto-delegate above the threshold.** `SLOW_BASH_THRESHOLD_MS = 30_000` (30 s). Before invoking a Bash command, the agent checks `knownSlowPatterns` and the most-recent samples for the same command shape:
   - If the command matches a known-slow pattern OR the median of recent samples exceeds the threshold → use `Agent` (subagent) instead of `Bash`, so the main loop stays free.
   - Brief the subagent fully (command, env vars, expected runtime, what success looks like, what to do on failure).
   - Use `run_in_background: true` when the user can productively wait or pivot — the harness will notify on completion.

3. **What counts as "the same command shape."** Strip transient bits (timestamps, generated tmpfile paths, session ids) before keying. Examples:
   - `git push origin main` and `git push origin feature/x` → both key on `git push`.
   - `ssh kkrazy@mycobeta.labxnow.ai '…'` → keys on `ssh kkrazy@<host>` (don't differentiate hosts unless they have different perf profiles).
   - `docker build -t myco:latest .` → keys on `docker build`.

4. **First-time commands.** No sample → run inline if it looks cheap (`grep`, `ls`, `node -e`, single-file reads). For anything that looks long-running (`./*.sh`, `docker …`, `npm install`, multi-step pipelines), pre-emptively delegate even on the first run; the user can correct later if the heuristic was wrong.

5. **Why this matters.** Long-running shells block the main agent's responsiveness — the user can't ask a follow-up question or course-correct until the Bash returns. Subagents run in parallel and report back via notification, so the main loop stays interactive. The historical sampling is what lets the agent learn project-specific norms (e.g., `./test.sh` here regularly runs ~45 s — known-slow, auto-delegate).
<!-- myco-best-practices-start -->
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

---

*Toggle this section off via the **Best practices** checkbox if your
project follows different conventions.*
<!-- myco-best-practices-end -->

