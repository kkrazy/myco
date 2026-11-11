# myco 使用说明（中文）

> 本文档面向第一批使用者：怎么登录、怎么开会话、怎么把代码拉进来、怎么让 agent 干活。
> 部署与运维（打镜像、挂载、排障）见 `docs/deploy/dev-docker.md` 和 `docs/deploy/docker.md`。
> 架构图见 `docs/architecture-overview.zh.md`。

---

## 0. 当前测试环境

| 项 | 值 |
|---|---|
| 访问地址 | `http://7.242.109.33:8080` |
| 容器名 | `myco-tz` |
| 镜像 | `myco:tz-dev`（从仓库 `dev-miras-tz` 当前提交构建） |
| 宿主 state 目录 | `/data/tz_miras/myco-dev/state` |
| 源码目录 | `/data/tz_miras/myco-dev/myco-1014-dev` |
| 登录方式 | 未配置 OAuth，直接进入（单用户 `default`） |
| Agent 后端 | 华为网关 `http://api.code-agent.rnd.huawei.com`，模型 `glmmoedsa` |

---

## 1. 打开界面

浏览器访问 `http://7.242.109.33:8080/`。

- 左侧是**会话列表**（sidebar），右上角是控件区，主体是**聊天面板**。
- 手机访问同一地址同样可用，界面是移动优先设计。

> 如果先看到登录页：当前测试环境没有配置 GitHub OAuth，正常情况下会直接以
> `default` 用户进入。若看到登录按钮，检查 state `.env` 里是否误设了
> `MYCO_GH_CLIENT_ID`。

---

## 2. 新建会话

点击左侧 **+ New session**：

1. 填一个可选的名字（只是显示标签，例如 `myco-dev`）。
2. 确认后，服务器会在 `/wks/<user>/<session-id>/` 下建好工作区。

一个会话 = 一个独立工作区 + 独立聊天记录 + 独立 Plan。
可以同时开多个会话并行干活，互不干扰（每个会话背后是一个独立的 agent）。

---

## 3. 把代码拉进来

新会话是空目录。用 `/git` 前缀的命令拉代码：

```
/git clone ssh://git@codehub-dg-g.huawei.com:2222/t59900502/myco-1014-dev.git
```

其他常用：

```
/git status
/git log --oneline -10
/git diff HEAD~3
/git commit -am "fix: xxx"
/git push
```

私有仓库需要凭据时，先存一次 PAT：

```
/setpat <你的 token>
```

> 容器内已注册 git credential helper，`/setpat` 保存的 token 会被 `git push`
> 自动使用，不需要在命令里写用户名密码。

---

## 4. 和 agent 对话

直接在输入框打字，回车发送。

| 你输入 | 会发生什么 |
|---|---|
| 普通文本 | agent 接收并开始干活（读文件、改代码、跑命令） |
| `@用户名` / `@all` | 给同事发消息，agent 不处理 |
| `/命令` | 执行斜杠命令（见第 7 节） |
| 点红色 ■ | 打断 agent 当前回合 |
| 权限弹窗 | 允许一次 / 总是允许 / 拒绝 |
| 行首 ↑ / ↓ | 翻历史输入 |

**关于权限确认**：当前测试环境设了 `MYCO_ALLOW_ALL=1`，agent 不会弹权限确认，
所有工具调用直接执行。多人共用或操作重要代码时建议关掉（见 `dev-docker.md`）。

---

## 5. 用 Plan 管理待办

所有工作项（bug / 需求 / 待办）都记在 Plan 里，存放在项目中的 `_myco_/plan.json`，
**跟着 git 走**：

```
/td   dockerfile 里 node 版本升级
/fr   加一个深色模式开关
/bug  点加载更多按钮会循环翻过第 5 页
/bug! <一句话>        ← agent 会把描述改写成 问题/期望/实际 三段式
```

每条 Plan 项可以：投票 · 评论 · 编辑 · **▶ Run**（派给 agent 去做）· 关闭/重开 · 删除。

`▶ Run` 之后 agent 会按 **analyze → code → verify** 三阶段推进，每个阶段结束会
触发一次 critic 评审并**停下来等你确认**（✓ Accept Stage / ⚡ Ask Claude to Fix Stage）。
不会自动往前跑——这是有意设计的。

---

## 6. 运行队列

想连续处理多条时：

```
/queue fr-43 bug-21     ← 加入队列，空闲时自动开始
/qstatus                ← 查看当前状态
/qcancel <id>           ← 取消某条
/qresume                ← 失败自动暂停后恢复
/next                   ← 让 agent 按优先级排出接下来最该做的 10 条
```

队列某条失败会自动暂停，不会继续往下跑。

---

## 7. 常用斜杠命令

**所有人可用**

| 命令 | 作用 |
|---|---|
| `/help` | 命令帮助 |
| `/td <文本>` | 加一条待办 |
| `/fr <文本>` | 加一条需求 |
| `/bug <文本>` | 加一条 bug |
| `/task` | 列出 agent 当前内部任务 |
| `/qstatus` `/next` | 队列状态 / 优先级建议 |
| `/btw <问题>` | 旁路问一句，不污染主会话 |
| `/me` `/whoami` | 我是谁 |

**Owner / Admin**

| 命令 | 作用 |
|---|---|
| `/git <参数>` | 在会话工作区执行 git |
| `/setpat <token>` | 保存代码平台 PAT |
| `/admin <登录名>` | 授权管理员 |
| `/queue` `/qcancel` `/qclear` `/qresume` | 队列管理 |

---

## 8. 文件浏览与编辑

- 点 **Files** 图标列目录，点文件查看内容。
- **✎ Edit** 打开内置编辑器（CodeMirror 6）：语法高亮、行号、搜索、折叠。
  `Ctrl/Cmd-S` 保存，`Esc` 取消。
- 并发编辑有 mtime 校验，冲突时弹出 Reload / 强制覆盖 / 取消，不会静默覆盖别人的改动。

Plan 视图下方还有 **Changed files**：本会话 agent 改动的文件列表，
逐行 `+N −M`，点开看 diff，鼠标悬停某行可以给 agent 留行级评论，
`✓ Accept` 接受 / `✕ Reject` 回滚。

---

## 9. 分享与多设备

- 会话菜单里可以生成**分享链接**：拿到链接的人只有只读权限
  （能看聊天、工具调用、Plan、文件；能 @ 和提 Plan 项，但不能驱动 agent）。
- 同一链接在手机和电脑上都能用，聊天记录完全一致（服务器是唯一真相）。
- 换设备、断网重连后会自动增量补发错过的消息，不会重下整段历史。

---

## 10. 常见问题

**Q: 聊天一直显示 `[connecting...]` / `[reconnecting...]`**
浏览器到服务器的 WebSocket 握手被拦。先确认服务端正常：
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://7.242.109.33:8080/
```
服务端正常则多为网络设备（VPN / 防火墙 / 杀毒软件代理）干扰。

**Q: agent 回复 `Failed to authenticate. API Error: 401`**
state `.env` 里缺 `ANTHROPIC_AUTH_TOKEN`，或 token 失效。
在 `/data/tz_miras/myco-dev/state/.env` 补上后 `docker restart myco-tz`。

**Q: agent 说连不上网关 / fetch failed**
容器内解析不到内网域名。检查容器启动参数里的 `--add-host`，以及 `no_proxy` 是否包含该域名。

**Q: 改了 `.env` 没生效**
`.env` 只在容器启动时读取一次，改完必须重启：
```bash
docker restart myco-tz
```

**Q: 代码改了但页面没变化**
前端 `Cache-Control: no-store`，正常刷新即可。如果是源码改动，需要重新打镜像并重建容器。

**Q: 数据会不会丢**
不会。所有状态都在宿主 `/data/tz_miras/myco-dev/state` 下，重建容器不动数据。
备份 = `tar -czf state-backup.tgz /data/tz_miras/myco-dev/state/`。
