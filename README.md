# myco

**A shared work surface for software teams collaborating with autonomous agents.**

myco is a mobile-first web application where multiple humans and multiple agents work on the same project at the same time — each agent runs in its own session, plan items form a shared backlog visible to everyone, and the team's `@mention` chat sits next to the agent's live tool calls. The project's running state (todos, features, bugs, run-summaries, architecture notes) lives in a git-tracked `_myco_/` directory, so when a new teammate clones the repo they inherit the team's complete project memory — no onboarding doc to read, no Slack channel to join.

## What it's for

Single developers running multiple agents in parallel — and small teams who want their humans + agents on the same page about what's been done, what's running right now, and what's next.

| | Without myco | With myco |
|---|---|---|
| Where is the backlog? | Issue tracker / Notion / chat | `_myco_/plan.json` — git-tracked, votes + comments inline |
| What's the agent doing right now? | Open the terminal it's running in | Live in the chat pane of any browser |
| What did the agent ship for ticket X? | Search commits, ask in chat | Auto-posted `meta.kind:run-summary` comment on the item |
| Two teammates want to drive the agent? | Take turns, screen-share | Both attach, both type, presence chips, share-link viewers |
| Three agents tackling three different fixes? | Three terminals on three laptops | Three sessions in the sidebar; click between them |
| Onboarding a new team member? | "Read this wiki, ping me with questions" | `git clone` — Plan tab + Arch tab populate from `_myco_/` |

## Features

- **Multi-session, multi-agent** — spawn an unbounded number of agent sessions per project. Each runs independently in its own workspace under `/wks/<user>/<session-id>/`. The sidebar is the parallel-work cockpit.
- **Shared plan as work backlog** — file todos, features, and bugs with `/td`, `/fr`, `/bug`. Vote, comment, edit, run. Auto-rewrites vague reports into Problem/Expected/Actual shape on request (`/bug!`). Each `▶ Run` dispatch lands a `run-summary` comment back on the originating item when it finishes.
- **Run-queue** — drop multiple plan items into a sequential dispatch queue. The agent works through them one at a time and posts results. Auto-pauses on failure.
- **`/next` priority ranking** — heuristic (votes × layer-bias × recency × run-failure penalty) + LLM rerank, cached 2h. Tells the team what to tackle next without re-deriving it each session.
- **Team chat per session** — `@user` mentions for discussion, `@all` for broadcast pings. Agents see the conversation too and respond to direct prompts. Side-channel `/btw` for one-shot questions that don't pollute the main session.
- **Roles + presence** — owner, admin (delegated via `/admin <login>`), read-only viewer (via share link). Send-button auto-disables for inputs a guest can't send. Presence chips show who's attached.
- **In-app text file editor** — CodeMirror 6 with syntax highlighting, search, fold, multi-cursor. Concurrent-edit safe via optimistic mtime checking — conflicts surface a Reload / Force-overwrite / Cancel modal instead of silently losing bytes.
- **Cross-device chat persistence** — every message + every agent reply persisted indefinitely. Phone, laptop, tablet all see the same state seconds apart. Brief network blips trigger lossless `?afterSeq=N` catch-up.
- **GitHub OAuth + invitation allowlist** — anyone with a GitHub account whose login is in the allowlist can sign in. Per-repo PATs (`/setpat <token>`) for GitHub + Gitee.
- **Share links** — time-limited read-only URLs for showing a session to someone without giving them auth or write access.

## Architecture in one breath

A single Node process (`mycod`) hosts an Express server + WebSocket gateway. Each agent session is an `AgentSession` instance wrapping a pluggable agent SDK. State is plain JSON files on disk — `/data/sessions.json` for the per-host registry, `<workspace>/_myco_/` for the per-project artifacts that travel with the code. Caddy fronts it for TLS + HTTP/2.

See [architecture.md](./architecture.md) for the full picture, [USER_MANUAL.md](./USER_MANUAL.md) for the day-to-day reference, and [CLAUDE.md](./CLAUDE.md) for the agent-facing convention pack.

## Requirements

- Docker (for the production deploy path).
- Node.js 20+ + `npm` (for the local dev path + the build step that vendors CodeMirror).
- A GitHub OAuth app (Client ID + Secret) if you want OAuth sign-in.

## Quick start (local dev)

```bash
git clone <repo-url> myco
cd myco
npm install              # installs build-time deps (esbuild, codemirror)
npm run build:editor     # produces web/public/vendor/codemirror.bundle.js
cd server && npm install # runtime deps
cd ..
PORT=3000 MYCO_STATE_DIR=$HOME/.myco node server/src/index.js
# → open http://localhost:3000
```

## Production deploy

The reference deploy is `./deploy.sh` — builds the Docker image, streams it to a remote host over SSH, swaps the container against a bind-mounted state directory. Everything reproducible from one command:

```bash
./deploy.sh                       # default host: myco.labxnow.ai
MYCO_DEPLOY_HOST=user@host ./deploy.sh
./deploy.sh --skip-tests          # skip the test suite gate
./deploy.sh --dry-run             # report the plan without shipping
./deploy.sh --set-oauth <id>:<secret>
./deploy.sh --allow-github-user <login>
```

See the `## Deployment` section of [CLAUDE.md](./CLAUDE.md) for the single-state-dir layout, OAuth wiring, and TLS specifics.

## Configuration (env)

| Variable | Default | Purpose |
|---|---|---|
| `MYCO_STATE_DIR` | `/home/<user>/myco-state` | Bind-mounted root for all persistent state (sessions, auth, workspaces, allowlist) |
| `MYCO_PUBLIC_ORIGIN` | — | Public URL for OAuth callback (e.g. `https://myco.labxnow.ai`) |
| `MYCO_GH_CLIENT_ID` / `_SECRET` | — | GitHub OAuth app credentials (set via `./deploy.sh --set-oauth`) |
| `MYCO_DEPLOY_HOST` | `myco.labxnow.ai` | Remote host the deploy script SSHes to |
| `PORT` | `3000` | Listen port (host side of the container) |

## Documentation

- [USER_MANUAL.md](./USER_MANUAL.md) — day-to-day cheat sheet (slash commands, plan workflow, editor)
- [architecture.md](./architecture.md) — design + components + data model + diagrams
- [CLAUDE.md](./CLAUDE.md) — agent-facing conventions (working in this repo, deployment, code style)
- `web/public/best-practices-template.md` — the engineering best-practices banner auto-injected at the top of the Arch tab + each project's `CLAUDE.md` on first session spawn

## Status + roadmap

myco is in active use. The current agent backend is the Claude Agent SDK; a second backend (OpenAI Agents SDK) is filed as `fr-52` to make the platform vendor-agnostic. Filed and tracked the same way as any other work — open the Plan tab to see what's next.

## License

Internal project. Reach out to the team before reusing.
