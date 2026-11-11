# RLM Kernel Protocol v1

> Modeled on prime-agent's REPL protocol v3 (`repl.md`). One Node child
> process per RLM session (`node kernel/child.js`); the parent (mycod)
> drives it over two channels with strict separation so user code can
> never corrupt protocol frames.

## Channels

| Direction | Channel | Notes |
|---|---|---|
| parent → child requests | fd 0 (stdin) | NDJSON, one request object per line. After the reader takes over, fd 0 is rebound to `/dev/null` so user code reading stdin can't consume protocol frames. |
| child → parent events | **private protocol fd** (dup'd from fd 1 at boot) | Created BEFORE any user code runs. The real fd 1/2 are then redirected into pipes whose bytes are pumped back as `stdout`/`stderr` events. `console.log` from user code can never pollute the protocol stream. |

No banner. The child's first output is a single `ready` event.

## Requests (parent → child)

| type | fields | semantics |
|---|---|---|
| `execute` | `{type, id, code}` | Evaluate `code` in the persistent namespace (top-level `await` supported). Emits `stdout`/`stderr`/`host_request` as they occur, then `result` (tail-expression repr, capped, value bound to `_`), then `done`. |
| `interrupt` | `{type}` | SIGINT semantics for the in-flight execute. No reply events. |
| `snapshot` | `{type, id, path, maxVarBytes}` | Serialize the namespace to `path` (structured JSON). Reply: `result` then `done`. |
| `restore` | `{type, id, path}` | Load a snapshot into the namespace. Reply: `result` then `done`. |
| `list_names` | `{type, id}` | List namespace variable names. Reply: `result` (JSON array) then `done`. |
| `host_reply` | `{type, id, data}` | Parent's reply to a `host_request` with the same id. No `done` event. |
| `shutdown` | `{type}` | Flush nothing (snapshots are explicit); process exits. |

## Events (child → parent)

| event | fields | semantics |
|---|---|---|
| `ready` | `{event, protocol:1, node}` | Sent once at boot. |
| `stdout` | `{event, id, text}` | User-code bytes from fd 1. `id` = owning request or `null`. |
| `stderr` | `{event, id, text}` | User-code bytes from fd 2. |
| `result` | `{event, id, text}` | Final value repr of an execute (cap 1 MiB); value also bound to `_`. |
| `error` | `{event, id, ename, evalue, traceback}` | User code threw. |
| `host_request` | `{event, id, data}` | User code called an `rlm.*` shim; parent must answer with `host_reply` on the same id. |
| `done` | `{event, id, status}` | Exactly one per id'd request, always LAST among that request's events. |

`status` ∈ `ok` | `error`.

## Namespace

`vm.createContext` with a restricted subset: `console`, `require`,
`Buffer`, a limited `process` (cwd/env/argv, no `exit`), the `rlm`
host shim (`spawn`, `collect`, `listSubagents`, `deleteSubagent`,
`progressNote`), and `state` — the prompt-as-a-variable contract:
agents write `state.task / state.done / state.next / state.blockers`
as real variables that survive across turns (and SDK compaction).

## Caps

result text 1 MiB · host_request payload 16 MiB · single snapshot
variable 4 MiB · snapshot total 64 MiB. Over-cap → truncate + marker.

## Version pin

`PROTOCOL_VERSION = 1` in `child.js` and in this doc. A static guard
in `test/test.sh` keeps the two in sync.
