# `@myco/cli`

Combined CLI + chat client for the [myco](https://github.com/kkrazy/myco) session manager. Bash-installable; VSCode integration lights up automatically when a VSCode window is running.

> **fr-109 skeleton.** This is the installable package scaffolding — real classifier + chat + server integration ship in fr-110 through fr-115. See [`_myco_/plan.json`](https://github.com/kkrazy/myco/blob/main/_myco_/plan.json) for the roadmap.

## Install

```bash
npm install -g @myco/cli
```

Verify:

```bash
myco --version
myco --help
```

## Bash / zsh integration

Add ONE line to your `~/.bashrc` (or `~/.zshrc`):

```bash
# ~/.bashrc
eval "$(myco integrate --bash)"
```

```zsh
# ~/.zshrc
eval "$(myco integrate --zsh)"
```

Then open a fresh shell. On fr-109 this is a silent no-op (proves the sourcing mechanism works). On fr-110 it activates the Lacy Shell 5-rule classifier — you type `git status` and it runs as a shell command; you type `let's refactor auth.js` and it routes to chat, all with real-time green/magenta feedback on your prompt line.

## Existing subcommand — `myco attach`

Pre-dating fr-109, `myco attach <session-id>` connects an interactive terminal to a live mycod session over WebSocket. This still works unchanged.

```bash
myco attach myco-kkrazy-abc12345
```

Configuration is discovered from `$MYCO_HOME/.env` (`PORT`, `MYCO_TOKENS`, `TLS_CERT_PATH`) and `$MYCO_TOKEN` env vars. Detach with `Ctrl-]` then `q`.

## Roadmap

| Item | Status | What it adds |
|---|---|---|
| fr-109 | ✅ this release | Bash-installable skeleton: `--version`, `--help`, `integrate --bash|--zsh` |
| fr-110 | planned | Lacy Shell 5-rule classifier + prompt hook |
| fr-111 | planned | Server `/v1/tools/*` endpoints (get_rules, get_skills, ...) |
| fr-112 | planned | Streaming chat client (WS + terminal markdown rendering) |
| fr-113 | planned | VSCode extension bridge (workspace-aware features) |
| fr-114 | planned | Full TUI support (node-pty REPL), rich rendering panes |
| fr-115 | planned | Polish, marketplace publish, curl installer |

## Design context

See `_myco_/plan.json` fr-108 for the full design discussion — bash-alike CLI as the primary surface, VSCode as an optional enhancer, REST + WebSocket transport with MCP-shaped seams for future adoption, security invariants (user sovereignty on shell commands, explicit approval on network-egress tool calls).

## License

MIT
