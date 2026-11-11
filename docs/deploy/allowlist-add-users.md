# myco — 邀请白名单加人 / 维护（allowlist-add-users.md）

> 本文说明如何把用户加入登录**邀请白名单**（`allowed-github-users.txt`），以及
> 如何打开/关闭名单的「拦人」开关。核心结论先给：
>
> - **加人 / 删人 / 维护名单：改文件保存即生效，不用重启容器。**
> - **切换「开放 ↔ 邀请」开关（`MYCO_DISABLE_ALLOWLIST`）：必须重启容器。**

## 1. 背景：登录的两层门禁

登录认证有两层（`server/src/auth.js`）：

| 层 | 开关 | 作用 |
|---|---|---|
| **要不要登录** | `MYCO_AUTH_REQUIRED=1` | 开登录页，未认证不可用 |
| **谁能登录** | 邀请白名单 | `$STATE_DIR/allowed-github-users.txt` 里列出的人才放行 |

关键判定逻辑（`auth.js`）：

- `loadAllowlist()` 每次调用都 `fs.readFileSync` 重新读盘，**无缓存** →
  **改名单保存即生效，任何时刻都可改，不需要重启**。
- `MYCO_DISABLE_ALLOWLIST` 是容器**启动时**由 `docker-entrypoint.sh` 从 `.env`
  source 进 `process.env` 的，运行中没代码改它 →
  **切开关必须重启**，运行中编辑 `.env` 不会热加载。

## 2. 关键文件与路径

| 项 | 值（当前部署） |
|---|---|
| 名单文件 | `/data/s00791175/Delm/mycoFile/state/allowed-github-users.txt` |
| 容器名 | `myco-local`（镜像 `myco:latest`） |
| 容器内等价路径 | `/data/allowed-github-users.txt`（`<state>/` 是它的 bind 挂载） |
| 启用开关 | 见 `<state>/.env` 的 `MYCO_DISABLE_ALLOWLIST` |
| 服务器状态目录 | `MYCO_STATE_DIR=/data`（`auth.js:24` → `ALLOWLIST_FILE=/data/allowed-github-users.txt`） |

> 名单文件格式：每个 GitHub/CodeHub 登录名**一行**；`#` 开头为注释；忽略空行；
> 用户名匹配 `[A-Za-z0-9_-]{1,24}`。`server/src/auth.js` 的 `sanitize()` 会过滤
> 掉名单外的字符，所以残留空格 / 换行符不影响匹配。

## 3. 加人 —— 编辑文件，保存即生效（不重启）

**方式 A：直接编辑（推荐，当前 state 目录在本机）**

1. 打开名单文件：
   ```bash
   vi /data/s00791175/Delm/mycoFile/state/allowed-github-users.txt
   ```
2. 每人一行追加登录名，例如：
   ```
   alice_wang
   bob-2026
   charlie
   ```
3. 保存即生效。**无需重启容器**（每次登录重新读盘）。

**方式 B：`deploy.sh --allow-github-user <login>`（标准远程流程 / 幂等去重）**

```bash
cd <仓库根目录>            # myco-1014
./scripts/deploy.sh --allow-github-user alice_wang
```
脚本会 `ensure_state_dir` → `ensure_allowlist_seed` → 追加并在已存在时返回
`unchanged`（幂等）。适合生产走 SSH 的部署；本机 state 目录直改时用方式 A 即可。

**格式与去重校验（可选但推荐）**：

```bash
cd /data/s00791175/Delm/mycoFile/state
grep -vE '^\s*#|^\s*$' allowed-github-users.txt \
  | awk 'NF{$1=$1};1' \
  | sort -u -o /tmp/al.txt
cp /tmp/al.txt allowed-github-users.txt
echo "当前名单人数：$(wc -l < /tmp/al.txt)"
```

## 4. 让名单真正拦人 —— 切换启用开关（必须重启）

当前 `<state>/.env` 是 `MYCO_DISABLE_ALLOWLIST=1`（**开放模式**：名单保留但不拦人，
任何持有效 token 的用户都能登录）。要切回**邀请模式**：

```bash
# 1) 备份并改开关（1 → 0）
cp /data/s00791175/Delm/mycoFile/state/.env /data/s00791175/Delm/mycoFile/state/.env.bak.$(date +%Y%m%d_%H%M%S)
sed -i 's/^MYCO_DISABLE_ALLOWLIST=1/MYCO_DISABLE_ALLOWLIST=0/' /data/s00791175/Delm/mycoFile/state/.env
grep -n MYCO_DISABLE_ALLOWLIST /data/s00791175/Delm/mycoFile/state/.env   # 预期 =0

# 2) 重启容器让新值进入进程环境（必须，约几秒中断）
docker restart myco-local
```

> ⚠️ 倾向直接编辑 `.env`、`sed` 只命中 `MYCO_DISABLE_ALLOWLIST=1` 这一行，
> 不动其它密钥（token / 代理密码是 live 凭证，勿打印 / 勿进 git）。
> 想回到开放模式就把它改回 `1` 再重启。

## 5. 验证

**名单挂进容器（bind 挂载即时可见）**：

```bash
docker exec myco-local sh -c 'grep -cE "[^# ].*" /data/allowed-github-users.txt'
# 预期输出：名单人数（如 31）
```

**启用开关已生效（重启后）**：

```bash
docker exec myco-local sh -c 'tr "\0" "\n" < /proc/1/environ | grep MYCO_DISABLE_ALLOWLIST'
# 邀请模式预期：MYCO_DISABLE_ALLOWLIST=0
```

> `docker exec <shell>` 里 `env` 看不到该变量是正常的——它继承的是镜像级 ENV，
> 而 `MYCO_DISABLE_ALLOWLIST` 是 entrypoint 在启动时 source 进 PID 1（node）的；
> 要看真实值必须查 `/proc/1/environ`。

**登录行为**：名单内的用户正常进入；名单外账号在 OAuth 回调后被拒，显示
`Not invited yet`。

## 6. FAQ

- **加人要不要重启？** 不用。名单保存即生效。
- **切换开放 ↔ 邀请要不要重启？** 要。`MYCO_DISABLE_ALLOWLIST` 是启动时注入的
  进程环境变量，运行中改 `.env` 不热加载。
- **`.env` 改了但没重启，为什么没效果？** 因上一条——进程启动那一刻环境就定格了。
- **名单里有 `default` 之类用户？** 它是单用户 / PAT 模式的登录名，也可照常列入；
  用 `sanitize()` 能通过即可。
