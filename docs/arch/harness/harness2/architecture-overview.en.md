# myco Architecture Overview (English)

> A high-level map for introducing the project. For detailed design see
> `architecture.md`; for per-file responsibilities see
> `docs/arch/overrall/code-arch.md`.

## In one sentence

myco is a **single Node process (`mycod`)** web application: Express serves the
HTTP API and the static SPA, `ws` carries the live `/attach/:session` channel,
and each *session* is an `AgentSession` instance embedding the Anthropic Agent
SDK that drives one autonomous coding agent. Caddy sits in front for TLS and
reverse proxying. All state is **JSON files on disk** (a global `/data` area
plus per-session `_myco_/` project memory inside the workspace), so swapping
containers or hosts never loses data.

---

## 1. System map — request path, orchestration, state

```mermaid
flowchart TB
    subgraph Clients["① Clients (phone / laptop / tablet)"]
        direction LR
        SPA["Web SPA<br/>index.html + app.js<br/>Chat · Plan · Arch · Test · Files"]
        Editor["CodeMirror 6<br/>in-app editor"]
        Guest["Read-only share link<br/>(viewer role)"]
        SPA --- Editor
    end

    subgraph Edge["② Edge (inside the container)"]
        direction LR
        Caddy["Caddy<br/>TLS · reverse proxy<br/>HTTP/1.1 + HTTP/2"]
        Mycod["mycod<br/>Express + ws :3000"]
        Caddy -->|"reverse_proxy :3000"| Mycod
    end

    subgraph Core["③ Server core (one node process)"]
        direction TB
        Auth["auth.js<br/>OAuth / PAT / invite allowlist<br/>30-day sliding session token"]
        Attach["attach.js<br/>WS handshake · role checks<br/>presence · ?afterSeq catch-up"]
        Slash["slashcmds.js<br/>/td /fr /bug /queue /next …"]
        Artifacts["artifacts.js<br/>Plan / Arch / Test<br/>vote · comment · dispatch"]
        Queue["runQueue.js<br/>FIFO run-queue<br/>auto-pause on failure"]
        Sessions["sessions.js<br/>session registry + chat history<br/>monotonic meta.seq"]
        Auth --> Attach
        Attach --> Slash
        Slash --> Artifacts
        Artifacts --> Queue
        Attach --> Sessions
    end

    subgraph AgentRT["④ Agent runtime (one per session)"]
        direction TB
        AS["agent-session.js<br/>AgentSession adapter<br/>write() / kill() / event stream"]
        SDK["Claude Agent SDK<br/>query() loop + canUseTool<br/>+ MCP tools + hooks"]
        Btw["btw.js / claude-cli.js<br/>side-channel single-turn calls<br/>(summaries / rerank / rewrites)"]
        AS --> SDK
        AS -.-> Btw
    end

    subgraph Ext["⑤ External dependencies"]
        direction LR
        LLM["LLM gateway<br/>Anthropic-compatible /v1/messages<br/>(e.g. Huawei api.code-agent)"]
        Git["CodeHub / GitHub / Gitee<br/>git clone · PR · issues"]
        Critic["Critic model<br/>(options: Gemini / local claude)"]
    end

    subgraph State["⑥ Persistence (plain JSON, no database)"]
        direction LR
        Data["/data<br/>sessions.json · auth-sessions.json<br/>git-tokens.json · .env"]
        Wks["/wks/&lt;user&gt;/&lt;session&gt;/<br/>project workspace + CLAUDE.md"]
        MycDir["_myco_/<br/>plan.json · architecture.md<br/>bash-elapsed.json"]
        Home["/root/home<br/>SDK credentials · .claude/"]
    end

    Clients -->|"HTTPS / WSS"| Caddy
    Mycod --> Core
    AS -->|"HTTP /v1/messages"| LLM
    Slash -->|"git / gh"| Git
    Artifacts -->|"checkpoint critic"| Critic
    Sessions --> Data
    AS --> Wks
    Artifacts --> MycDir
    SDK --> Home

    style Clients fill:#1f77b4,color:#fff
    style Edge fill:#17becf,color:#000
    style Core fill:#2ca02c,color:#fff
    style AgentRT fill:#ff7f0e,color:#000
    style Ext fill:#9467bd,color:#fff
    style State fill:#7f7f7f,color:#fff
```

---

## 2. Lifecycle of one human → agent conversation

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser (SPA)
    participant C as Caddy
    participant S as mycod (Express/ws)
    participant A as AgentSession
    participant L as LLM gateway
    participant D as Disk state

    B->>C: GET /  (static SPA, Cache-Control: no-store)
    C->>S: reverse proxy
    B->>C: WSS /attach/:sessionId?token=…
    C->>S: upgrade
    S->>S: auth.js validates token → role (owner/admin/viewer)
    S->>B: chat-history frame + agent-replay frame (tail window)
    S->>B: presence frame (who is online)
    B->>S: chat frame: user input
    S->>D: appendChatMessage (stamp meta.seq)
    S->>A: write(user input)
    A->>L: query() → /v1/messages (tool_use loop)
    L-->>A: assistant text / tool calls
    A->>S: agent-event (tool_use / tool_result / assistant_text)
    S->>B: agent-event frame (live render)
    A->>S: canUseTool → permission menu (unless MYCO_ALLOW_ALL=1)
    S-->>B: permission menu (synced across devices)
    A->>S: turn_result
    S->>D: persist assistant text into rec.chat
    S->>D: if [run:plan#X] → post run-summary comment
```

---

## 3. Plan dispatch and the run-queue

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant P as Plan item (plan.json)
    participant Q as run-queue
    participant A as AgentSession

    U->>P: ▶ Run / /queue bug-13
    P->>Q: addToQueue(id)
    Q->>Q: peekNextPending → markRunning
    Q->>A: chat input "[run:plan#bug-13] <item body>"
    A->>A: parse marker → session._activeRunItem
    A->>A: three stages (analyze → code → verify), emit [stage: X done]
    A-->>U: checkpoint critic verdict (waits for user accept, no auto-advance)
    A->>P: turn_result → runs[] entry + run-summary comment
    alt success
        Q->>A: markFinished(success) → auto-dispatch next pending
    else failure / abort
        Q->>Q: auto-pause (runQueuePaused) + prompt /qresume
    end
```

---

## 4. Deployment shape and mount layout

```mermaid
flowchart LR
    subgraph Host["Host machine"]
        direction TB
        StateD["/data/&lt;tag&gt;/state/"]
        Sub1["home/  → container /root"]
        Sub2["wks/   → container /wks"]
        Sub3["Caddyfile → /etc/caddy/Caddyfile (ro)"]
        Sub4["state root → /data<br/>sessions.json · .env · git-tokens.json"]
        StateD --- Sub1
        StateD --- Sub2
        StateD --- Sub3
        StateD --- Sub4
    end
    subgraph Cont["Container myco:&lt;tag&gt;"]
        direction TB
        Ent["docker-entrypoint.sh<br/>loads /data/.env · registers git credential helper"]
        Cad["Caddy :80/:443"]
        Node["node server/src/index.js :3000"]
        Ent --> Cad
        Ent --> Node
    end
    Browser["Browser"] -->|"http(s)://host:port"| Cad
    Sub4 --> Ent
    Node -->|"direct via NO_PROXY"| GW["Internal LLM gateway"]
    Node -->|"HTTP(S)_PROXY"| Proxy["Corporate proxy"]
```

**Key conventions**

- **No Docker volumes, only bind mounts** — every file is visible on the host
  and backup is `tar` of one directory.
- **Containers do not inherit the host `/etc/hosts`** — internal domains must be
  injected with `--add-host`.
- **Internal addresses go direct via `no_proxy`**; only outbound internet traffic
  uses the corporate proxy.
- **`.env` is read once at boot** — edit it, then `docker restart`.

---

## 5. Roles and permissions

| Role | How acquired | Can drive agent | Can mutate plan | Can edit files |
|---|---|---|---|---|
| Owner | Created the session | ✓ | ✓ | ✓ |
| Admin | `/admin <login>` by the owner | ✓ | ✓ | ✓ |
| Read-only viewer | Share link / not on the session allowlist | — | partial (file items, vote, comment, `@mention`) | — |

`MYCO_ALLOW_ALL=1` makes the agent skip all tool permission prompts (explicit
deny rules still win). Convenient for a single-user test box; turn it off for
multi-user use.

---

## 6. Design points worth telling an audience

1. **State is files.** No database, no queue broker. `sessions.json` is the
   session truth, `_myco_/plan.json` is the project truth, and `git clone`
   is the whole onboarding step.
2. **One process, many sessions.** Each agent session is an in-process
   `AgentSession` talking to the SDK over a structured event stream. Sessions
   are isolated (own workspace, own chat history).
3. **Pluggable agent backend.** `AgentSession` is the only integration boundary;
   adding the OpenAI Agents SDK is one adapter (`fr-52`).
4. **Human in the loop.** Three stages (analyze / code / verify) with a
   checkpoint critic and explicit user acceptance — no auto-advance; permission
   prompts on by default.
5. **Cross-device consistency.** The server is the single source of truth;
   clients render by `meta.seq`, and reconnects catch up losslessly via
   `?afterSeq=N`.
