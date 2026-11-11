# myco 架构图（中文版）

> 面向介绍用途的总体架构概览。详细设计见 `architecture.md`，
> 单文件职责见 `docs/arch/overrall/code-arch.md`。

## 一句话概括

myco 是一个 **单 Node 进程（mycod）** 的 Web 应用：Express 承载 HTTP 与静态前端，
`ws` 承载 `/attach/:session` 实时通道；每个「会话」是一个 `AgentSession` 实例，
内嵌 Anthropic Agent SDK 驱动一个自主编码 agent；Caddy 在前端做 TLS/反向代理。
所有状态都是**磁盘上的 JSON 文件**（`/data` 全局态 + 每个会话工作区的 `_myco_/` 项目记忆），
因此换容器、换机器都不丢数据。

---

## 1. 总体架构（请求流 + 调度 + 状态）

```mermaid
flowchart TB
    subgraph Clients["① 客户端（任意设备：手机 / 笔记本 / 平板）"]
        direction LR
        SPA["Web SPA<br/>index.html + app.js<br/>聊天 · Plan · Arch · Test · Files"]
        Editor["CodeMirror 6<br/>In-app 编辑器"]
        Guest["只读分享链接<br/>viewer 角色"]
        SPA --- Editor
    end

    subgraph Edge["② 接入层（容器内）"]
        direction LR
        Caddy["Caddy<br/>TLS · 反向代理<br/>HTTP/1.1 + HTTP/2"]
        Mycod["mycod<br/>Express + ws :3000"]
        Caddy -->|"reverse_proxy :3000"| Mycod
    end

    subgraph Core["③ 服务核心（单 node 进程）"]
        direction TB
        Auth["auth.js<br/>OAuth / PAT / 邀请白名单<br/>30 天滑动会话 token"]
        Attach["attach.js<br/>WS 握手 · 角色鉴权<br/>presence · 断线 ?afterSeq 补发"]
        Slash["slashcmds.js<br/>/td /fr /bug /queue /next …"]
        Artifacts["artifacts.js<br/>Plan / Arch / Test<br/>投票 · 评论 · 派发"]
        Queue["runQueue.js<br/>FIFO 运行队列<br/>失败自动暂停"]
        Sessions["sessions.js<br/>会话注册表 + 聊天持久化<br/>单调 meta.seq"]
        Auth --> Attach
        Attach --> Slash
        Slash --> Artifacts
        Artifacts --> Queue
        Attach --> Sessions
    end

    subgraph AgentRT["④ Agent 运行时（每个会话一个）"]
        direction TB
        AS["agent-session.js<br/>AgentSession 适配层<br/>write() / kill() / 事件流"]
        SDK["Claude Agent SDK<br/>query() 循环 + canUseTool<br/>+ MCP 工具 + hooks"]
        Btw["btw.js / claude-cli.js<br/>旁路单轮调用<br/>（摘要 / 重排 / 改写）"]
        AS --> SDK
        AS -.-> Btw
    end

    subgraph Ext["⑤ 外部依赖"]
        direction LR
        LLM["LLM 网关<br/>Anthropic 兼容 /v1/messages<br/>（如华为 api.code-agent）"]
        Git["CodeHub / GitHub / Gitee<br/>git clone · PR · issue"]
        Critic["Critic 模型<br/>（选项：Gemini / 本机 claude）"]
    end

    subgraph State["⑥ 持久化（纯 JSON 文件，无数据库）"]
        direction LR
        Data["/data<br/>sessions.json · auth-sessions.json<br/>git-tokens.json · .env"]
        Wks["/wks/&lt;user&gt;/&lt;session&gt;/<br/>项目工作区 + CLAUDE.md"]
        MycDir["_myco_/<br/>plan.json · architecture.md<br/>bash-elapsed.json"]
        Home["/root/home<br/>SDK 凭据 · .claude/"]
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

## 2. 一次「人会话说 agent」的生命周期

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器 (SPA)
    participant C as Caddy
    participant S as mycod (Express/ws)
    participant A as AgentSession
    participant L as LLM 网关
    participant D as 磁盘状态

    B->>C: GET /  (静态前端, Cache-Control: no-store)
    C->>S: 反向代理
    B->>C: WSS /attach/:sessionId?token=…
    C->>S: WS 升级
    S->>S: auth.js 校验 token → 角色 (owner/admin/viewer)
    S->>B: chat-history 帧 + agent-replay 帧 (尾部分页)
    S->>B: presence 帧 (谁在线)
    B->>S: chat 帧: 用户输入
    S->>D: appendChatMessage (stamp meta.seq)
    S->>A: write(用户输入)
    A->>L: query() → /v1/messages (tool_use 循环)
    L-->>A: assistant text / tool calls
    A->>S: agent-event (tool_use / tool_result / assistant_text)
    S->>B: agent-event 帧 (实时渲染)
    A->>S: canUseTool 回调 → 权限菜单 (除非 MYCO_ALLOW_ALL=1)
    S-->>B: permission 菜单 (跨设备同步)
    A->>S: turn_result
    S->>D: 持久化 assistant 文本到 rec.chat
    S->>D: 若为 [run:plan#X] → 写 run-summary 评论
```

---

## 3. Plan 派发与运行队列

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant P as Plan 条目 (plan.json)
    participant Q as run-queue
    participant A as AgentSession

    U->>P: ▶ Run / /queue bug-13
    P->>Q: addToQueue(id)
    Q->>Q: peekNextPending → markRunning
    Q->>A: chat 输入 "[run:plan#bug-13] <条目正文>"
    A->>A: 解析标记 → session._activeRunItem
    A->>A: 三阶段执行 (analyze → code → verify)，每阶段发 [stage: X done]
    A-->>U: checkpoint critic 裁决 (等待用户接受，不自动推进)
    A->>P: turn_result → runs[] 记录 + run-summary 评论
    alt 成功
        Q->>A: markFinished(success) → 自动派发下一个 pending
    else 失败 / 中断
        Q->>Q: 自动暂停 (runQueuePaused) + 提示 /qresume
    end
```

---

## 4. 部署形态与挂载布局

```mermaid
flowchart LR
    subgraph Host["宿主机"]
        direction TB
        StateD["/data/&lt;标识&gt;/state/"]
        Sub1["home/  → 容器 /root"]
        Sub2["wks/   → 容器 /wks"]
        Sub3["Caddyfile → /etc/caddy/Caddyfile (ro)"]
        Sub4["state 根 → /data<br/>sessions.json · .env · git-tokens.json"]
        StateD --- Sub1
        StateD --- Sub2
        StateD --- Sub3
        StateD --- Sub4
    end
    subgraph Cont["容器 myco:&lt;tag&gt;"]
        direction TB
        Ent["docker-entrypoint.sh<br/>加载 /data/.env · 注册 git 凭据 helper"]
        Cad["Caddy :80/:443"]
        Node["node server/src/index.js :3000"]
        Ent --> Cad
        Ent --> Node
    end
    Browser["浏览器"] -->|"http(s)://宿主:端口"| Cad
    Sub4 --> Ent
    Node -->|"NO_PROXY 直连"| GW["内网 LLM 网关"]
    Node -->|"HTTP(S)_PROXY"| Proxy["企业代理"]
```

**关键约定**

- **无 Docker volume，全部 bind mount**：宿主机上每个文件都能看到、能 tar 备份。
- **容器内不继承宿主 `/etc/hosts`**，内网域名必须用 `--add-host` 注入。
- **内网地址走 `no_proxy` 直连**，外部流量走企业代理。
- `.env` 只在启动时读一次，改完要 `docker restart`。

---

## 5. 权限与角色

| 角色 | 获取方式 | 驱动 agent | 改 Plan | 改文件 |
|---|---|---|---|---|
| Owner | 创建会话的人 | ✓ | ✓ | ✓ |
| Admin | Owner 用 `/admin <login>` 授权 | ✓ | ✓ | ✓ |
| Read-only viewer | 分享链接 / 不在会话白名单 | — | 部分（提案、投票、评论、`@mention`） | — |

`MYCO_ALLOW_ALL=1` 会让 agent 跳过所有工具权限确认（deny 规则仍生效），
适合容器化测试环境；面向多人时建议关闭。

---

## 6. 设计要点（介绍时可以直接讲的几条）

1. **状态即文件** —— 没有数据库、没有队列中间件。`sessions.json` 是会话真相，
   项目文件即项目真相，`git clone` 就等于完成团队交接。
2. **单进程、多会话** —— 每个 agent 会话是进程内一个 `AgentSession`，
   通过 SDK 的事件流与服务器通信；session 之间互不干扰（各自工作区、各自聊天记录）。
3. **agent 后端可插拔** —— `AgentSession` 是唯一集成边界，
   换 OpenAI Agents SDK 只需加一个适配器（`fr-52`）。
4. **人在环上** —— 三阶段（analyze / code / verify）+ checkpoint critic + 显式接受，
   不自动推进；权限确认默认开启。
5. **跨设备一致** —— 服务器是唯一真相，客户端只按 `meta.seq` 渲染，
   断线用 `?afterSeq=N` 无损补发。
