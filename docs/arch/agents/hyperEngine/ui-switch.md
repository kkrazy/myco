# hyperEngine §4 扩展设计 —— 会话级开关的完整接线（UI + slash + 帧 + 只读）

> 状态：**设计方案（未实现）。** 本文是 `myco-hyperEngine-design.md` §4「会话级开关」的
> 落地级扩展：把「像 RLM 一样」从一句话拆成逐文件、逐行号锚定的接线清单。所有锚点均已
> 对照 develop @ `ac81c4e` 的真实代码核验。

命名统一（先钉死，避免 mixed usage）：

| 概念 | 取值 | 锚点（RLM 对照物） |
|---|---|---|
| 会话字段 | `rec.hyperEngineMode`：`'off' \| 'on'`，缺省视为 `off` | `rec.rlm`（boolean） |
| 生效判定 helper | `sessions.js isHyperEngineOn(rec)` | `isRlmEffective` sessions.js:1994 |
| slash 命令 | `/he`（`/he` \| `/he on` \| `/he off`） | `/rlm` slashcmds.js:3360 |
| WS 广播帧 | `state-update kind:'hyper-engine-mode-changed'`，载荷 `{ hyperEngine: bool }` | `kind:'rlm-mode-changed'` slashcmds.js:3375 |
| UI select | `#hyper-engine-select`（off/on 两 option） | `#rlm-scope-select` index.html:207 |
| UI 徽章 | `#hyper-engine-badge`（开关开启时显示当前引擎名） | `#rlm-mode-badge` index.html:190 |
| 侧栏字段 | GET /sessions 里 `s.hyperEngine` | `s.rlm` index.js:738 |

> 注意：主文档旧稿用过 `isHybridOn` / `/hs` / `kind:'hybrid-mode-changed'` /
> `#hybrid-engine-select` 四个旧名。**一律以本文统一后的名字为准**（`isHyperEngineOn` /
> `/he` / `hyper-engine-mode-changed` / `#hyper-engine-select`）——「混合引擎」是给用户
> 看的中文 label，代码标识符统一用 `hyperEngine` 词根，与模块名
> `server/src/hyperEngine/`、字段 `rec.hyperEngineMode` 保持同一词根。

## 4.1 数据与判定（server）

```js
// sessions.js —— 镜像 isRlmEffective(:1994)/getRlmScope(:2000)，紧挨着放
function isHyperEngineOn(rec) {
  if (!rec) return false;
  return rec.hyperEngineMode === 'on';
}
// Object.assign(module.exports, {...}) 里追加导出（同一处追加，不新建 exports 对象
// —— pty.js 在循环 require 时捕获了现有 exports 引用，替换会失联）。
```

- 持久化：`rec.hyperEngineMode` 存 `/data/sessions.json`，写后 `saveStore()`。旧记录无此
  字段 → `isHyperEngineOn` 返回 false（缺省 off 语义天然成立，**无需迁移脚本**）。
- 消费时机：**只在 spawn/respawn 时读**（`ensureLiveSession` sessions.js:1336/:1356 一带，
  见 dispatch 设计）。这决定了「开关何时生效」= **下一次 respawn**，与 RLM 完全同构——
  活跃 SDK 迭代不中断，正在跑的 turn 不受影响。

## 4.2 slash 命令 `/he`（server/slashcmds.js，镜像 /rlm :3360-3411）

```
/he          → 状态读（无需鉴权）：显示本会话开关 + 当前主会话实际引擎（来自 rec 上的
               引擎戳记，见 §4.6）+ 提示 owner+admin 才能切换。
/he on|off   → 会话级切换（owner+admin 鉴权，非 owner 提示「Session owner is @<user>」）。
```

处理体逐行镜像 `/rlm session on|off`（slashcmds.js:3396-3410）：

```js
const on = /* 解析 on|off */;
if (!sessionsMod.isOwnerOrAdmin(ctx.sessionId, ctx.user)) { ctx.reply(...); return; }
rec.hyperEngineMode = on ? 'on' : 'off';
sessionsMod.saveStore();
emitHyperEngineState(sessionsMod.isHyperEngineOn(rec));   // 见下
ctx.reply(on ? '✓ 混合引擎已开启（本会话）。下一个 respawn 起，主会话与团队的每个 '
              'worker 都会在 spawn 时从可用引擎后端里随机选一个；正在进行的对话不受影响。'
              '/he off 可关闭。'
            : '✓ 混合引擎已关闭。下一个 respawn 起回到固定 claude 引擎。');
```

```js
// 镜像 emitRlmState(slashcmds.js:3373-3376)
const emitHyperEngineState = (hyperEngine) => {
  if (ctx.session && typeof ctx.session.emit === 'function') {
    ctx.session.emit('state-update', { kind: 'hyper-engine-mode-changed', hyperEngine });
  }
};
```

为什么走 chat 通道而不是新增 HTTP 路由：`/rlm` 已验证这条链路把**鉴权（owner+admin）、
落库（rec.* + saveStore）、广播（state-update 帧三件事）**都收口在服务端一处；UI select
只是把点选翻译成 `/he on` 文本发进 chat（见 §4.4），从而两类入口共享同一套服务端语义，
不可能出现「按钮改了状态、命令没改」的分叉。

## 4.3 attach 回放（server/attach.js，镜像 :2104-2114）

```js
// 初次 attach 时按 rec 回放一次 kind:'hyper-engine-mode-changed'——
// toggle 时的广播只到达当时在线的客户端；刷新/换设备必须靠这帧恢复选中态。
try {
  const recHe = sessionsMod.getSessionRecord(session.sessionId);
  if (recHe) {
    ws.send(JSON.stringify({
      t: 'state-update',
      kind: 'hyper-engine-mode-changed',
      hyperEngine: typeof sessionsMod.isHyperEngineOn === 'function'
        ? sessionsMod.isHyperEngineOn(recHe)
        : recHe.hyperEngineMode === 'on',
    }));
  }
} catch {}
```

放在 attach.js 现有 rlm 回放块（:2104-2114）紧后面，同一个 try 粒度。

## 4.4 界面（web/public）

**index.html**（`#chatpane-topctl-row` 区域，紧挨 `#rlm-scope-select` :207 加一个 select +
一个 badge）：

```html
<!-- hyperEngine switch: session-level (off/on). Drives the SAME switch as
     `/he on|off` — toggles rec.hyperEngineMode for THIS session only.
     Wired by _onHyperEngineChange; hidden for read-only viewers.
     Lives inside #chatpane-topctl-row next to the RLM switch. -->
<select id="hyper-engine-select" class="hyper-engine-select" hidden
        title="混合引擎模式开关 — 仅本会话生效。开启后，从下一个 respawn 起，主会话与团队的每个 worker 在启动时从可用引擎后端（claude / opencode / codex / dsh）中随机选一个；关闭则固定 claude 引擎（现状）。等价命令：/he on|off。">
  <option value="off">🔀 混合引擎: 关</option>
  <option value="on">🔀 混合引擎: 开</option>
</select>
<div id="hyper-engine-badge" class="hyper-engine-badge" hidden
     title="本会话开启了混合引擎模式。主会话/各 worker 当前使用的引擎见各 spawn 日志；/he 查看主会话引擎。"><span>🔀 混合引擎</span></div>
```

**app.js**（五个函数，逐个镜像 RLM 五件套；括号内为 RLM 锚点）：

```js
// (1) el 取用 (_rlmSwitchEl :10517)
function _hyperEngineSwitchEl() {
  return document.getElementById('hyper-engine-select');
}
// (2) 选中态刷新 (_refreshRlmSwitch :10519-10526)
//     state.hyperEngineMode 由 hyper-engine-mode-changed 帧维护（广播 + attach 回放双来源）。
function _refreshHyperEngineSwitch() {
  const el = _hyperEngineSwitchEl();
  if (!el) return;
  el.hidden = !!state.readOnly;                    // 只读 viewer 隐藏（镜像 RLM :10523）
  el.value = state.hyperEngineMode ? 'on' : 'off';
  _updateHyperEngineBadge();
  _refreshTopctlRow();                             // 行可见性 = 任一子控件可见 (:10552)
}
// (3) 徽章 (_updateRlmBadge)
function _updateHyperEngineBadge() {
  const b = document.getElementById('hyper-engine-badge');
  if (b) b.hidden = !state.hyperEngineMode;
}
// (4) 行内收编 (_adoptRlmSwitchIntoTopRow :10541)——boot 时把 select 从模板位挪进
//     #chatpane-topctl-row（与 RLM 同一行；保持「新控件插在 RLM 左侧」，RLM 保持最右）。
function _adoptHyperEngineSwitchIntoTopRow() {
  const row = _topctlRow();
  const el = _hyperEngineSwitchEl();
  if (!row || !el || el.parentElement === row) return;
  row.insertBefore(el, document.getElementById('rlm-scope-select'));
  _refreshTopctlRow();
}
// (5) change → 翻译成 slash 命令发进 chat (_onRlmScopeChange :10575-10581)
function _onHyperEngineChange(ev) {
  const mode = ev.target.value;
  const cmd = mode === 'on' ? '/he on' : '/he off';
  try { sendChatMessage(cmd); } catch { _refreshHyperEngineSwitch(); }   // 失败回滚选中态
}
```

**帧处理**（镜像 `rlm-mode-changed` handler app.js:10421-10433）：

```js
if (msg.kind === 'hyper-engine-mode-changed') {
  state.hyperEngineMode = !!msg.hyperEngine;
  try { _refreshHyperEngineSwitch(); } catch {}    // badge + select + 行可见性一次刷齐
  return;
}
```

**boot 接线**（`_adoptRlmSwitchIntoTopRow()` 调用点 app.js:1575 旁）：

```js
_adoptHyperEngineSwitchIntoTopRow();
// select change 监听：在 RLM select 绑定处（DOM ready / boot）同点追加
_hyperEngineSwitchEl().addEventListener('change', _onHyperEngineChange);
```

**attach 重放路径**：attach 处理器末尾已有 `try { _refreshRlmSwitch(); } catch {}`
（app.js:2812）——同点追加 `try { _refreshHyperEngineSwitch(); } catch {}`，覆盖「帧先于
attach 回放到达」之外的兜底路径。

**只读 viewer**：`el.hidden = !!state.readOnly`（同 RLM :10523）。guest 的 chat 输入仍开放
（讨论区语义），但服务端 `/he on|off` 的 owner+admin 鉴权是**第二道闸**——即使绕过前端
隐藏直接发命令，也会被拒并回提示，不会落库。两层防护与 RLM 完全同构。

**双 surface 一致性教训（照搬 RLM 2026-10-29 修复）**：RLM 曾出现「下拉显示 关 但 RLM
实际开着」的 select/state 失同步（app.js:10428 注释）——根因是帧到达时只刷了 pill 没刷
select。hyperEngine 的帧 handler 必须**一次刷齐 badge + select + topctl 行可见性**三处，
不允许出现「只刷一处」的调用点。

**styles.css**：`.hyper-engine-select` / `.hyper-engine-badge` 复用
`.rlm-scope-select` / `.rlm-mode-badge` 的既有规则（选择器并列即可，不新造视觉语言）：
```css
.hyper-engine-select, .rlm-scope-select { /* 共用 */ }
.hyper-engine-badge, .rlm-mode-badge { /* 共用 */ }
```

**侧栏**（server/src/index.js，镜像 `s.rlm` :738）：GET /sessions 轮询里追加
`s.hyperEngine = !!(rec && sessionsMod.isHyperEngineOn(rec));`——让用户不开会话就能在
侧栏看到哪些会话开着混合引擎（3s 轮询自然带上，无新帧）。

## 4.5 开/关语义边界（不变式）

1. `rec.hyperEngineMode` 缺省/`'off'` → `isHyperEngineOn` 恒 false → dispatch 恒选
   `claude` → overlay 恒等 → sdkOpts 与现状逐字节一致（零影响承诺落在 UI 层的表述）。
2. 切换**不 kill 不重建**在跑会话：开关只影响下一次 `ensureLiveSession` respawn
   （sessions.js:1336/:1356 消费点），与 `/rlm` 的「下一次 respawn 生效」语义一致。
   slash 回复文案必须如实说明这一点（见 §4.2 文案）。
3. 开关与 RLM **正交可组合**：`/rlm on` + `/he on` = RLM kernel 会话本身也随机引擎。
   互不读取对方字段；组合行为的正确性由各自 spawn 路径的叠加顺序保证（RLM 系
   systemPrompt/MCP 叠加在前，hyperEngine 系 env/model/引擎适配叠加在后，两者改的
   sdkOpts 字段集不相交——RLM 不碰 `env`，hyperEngine 不碰 `systemPrompt`/`mcpServers`
   除各 driver 声明的外）。
4. **唯一开关是 `rec.hyperEngineMode`**：无 `HYPER_*` 环境变量、无 user 级作用域（RLM
   的 user 级已被移除的前例就是本设计的边界——只做会话级）。
5. 权限/工具/对话流不受开关影响：canUseTool、PreToolUse allow-list、chat 路由全部不动；
   引擎差异被 Driver 契约的事件归一化层吸收（见主文档 §6），UI 不感知引擎种类。

## 4.6 可观测性（最小集）

- **spawn 日志**：`ensureLiveSession` respawn 时打印
  `[hyperEngine] <sessionId> engine=<name> (mode=on, worker=<role|main>)`——镜像现有
  `[ensureLive] respawned agent ...` 日志行的位置（sessions.js:1353/:1376）。
- **`/he` 状态读**：显示 mode + 主会话引擎戳记。引擎戳记建议存
  `rec.hyperEngine = { main: '<engine>', workers: { 'worker-A': '…', 'worker-B': '…' } }`
  （每次 spawn 落一次，fr-102 式「重启后选择不漂移」的载体；详细论证在 dispatch 设计，
  此处仅声明 UI 需要读它）。
- **审计（本次仅设计锚点）**：`_myco_/events.jsonl` 已有事件管道，后续如需逐 turn 审计
  引擎可挂 `system_init` 帧（agent-session.js:1116 已带 model/tools 字段，追加 engine
  字段属加法）——**本次不做**，记入主文档开放问题。

## 4.7 测试（镜像 rlm 帧测试的断言面）

| 测试 | 断言 |
|---|---|
| `hyper-ui-frame-broadcast` | `/he on` 后收到 `kind:'hyper-engine-mode-changed'` 且 `hyperEngine===true`；`/he off` 后为 false |
| `hyper-ui-attach-replay` | 开启状态下新 attach 客户端收到的初始帧含 `hyperEngine:true`（镜像 attach.js:2104 块） |
| `hyper-ui-readonly-hidden` | 只读会话 UI 帧/快照不含可切换 surface（select 服务端无独立 surface，靠 owner+admin 鉴权测试：非 owner 发 `/he on` → rec 不变 + 回拒绝文案） |
| `hyper-ui-slash-authz` | 非 owner+admin 的 `/he on` 不改 `rec.hyperEngineMode` |
| `hyper-ui-state-sync` | 帧到达后 badge + select 两 surface 同步（防 RLM 2026-10-29 式失同步回归） |
| `hyper-ui-zero-impact` | `rec.hyperEngineMode` 缺省/`off` 时，spawn 的 sdkOpts 与未接 hyperEngine 逐字段相等 |

> 全部可离线跑（无模型网关依赖）：帧断言用 WS 假客户端，鉴权断言直调 slashcmd handler。
