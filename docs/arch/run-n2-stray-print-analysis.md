# /run-n2 结束后突现 worker 工具输出 — 71a17db 修复思路分析

> 分析日期：2026-10-30。针对用户疑问：「71a17db 解决有没有问题？A/B 打印结束后工具还打印，有没有可能是 A/B 本身就没执行完，『打印已完成』才是不对的？」

## 结论（TL;DR）

**71a17db 的解决思路是对的，且与疑虑互补而不是对立。**
「✅ /run-n2 完成」打印时 A/B 两个 worker **确实都已经执行完**（判定链见 §1），
用户看到的「结束后工具还打印」是 **lane 终止信号之后的迟滞事件**，
不是「未执行完就打印已完成」。71a17db 在 bridge 处拦截这类迟滞事件，
是正确的收口位置。

## 1. 「完成」为什么不可能提前 — team-complete 的判定链

`server/src/team-session.js` `_maybeComplete`（L365）只在同时满足以下条件时
才 emit `team-complete`：

1. 看板队列**非空**且**每一项都是 done**；
2. **每一个** worker 都 `!this._busy[actor]`。

而 `_busy[actor]` 只在 `AgentSession` 的 `idle` 事件里清零（`_wireWorkers`
L355-358）。`idle` 在 `_ensureIteration` 的收尾段（`agent-session.js` L901）
发出，时机是 `this._iterating = false`（L893）之后 —— 即 SDK 流**整个
drain 完**（`turn_result` 已落地、该 turn 的全部 `tool_use`/`tool_result`
都已 `_emit`）之后。因此：

```
worker 最后一轮: tool_use → tool_result → … → turn_result → _iterating=false → idle
两个 worker 都 idle + 队列全 done → team-complete → 「✅ /run-n2 完成」
```

「完成」行出现时，两个 worker 的 SDK 迭代**都已经排空**。
不存在「A/B 还在跑就打印完成」的路径 —— 真正的「提前完成」缺陷
（worker **中途** per-turn `turn_result` 被当成 lane 终点）早在
**3012f5a**（2026-10-29）就用 `onLaneTerminal` 的 busy-probe 修掉了：
busy worker 的 `turn_result` 不再触发 lane 终止。71a17db 是在
3012f5a 之上的第二层收口，两者叠加后完成时机是准确的。

## 2. 那「结束后工具还打印」是什么？

三种来源，全部发生在 `team-complete` **之后**：

1. **迟滞 relay**：worker 的尾随事件（如最终 `git push` 的
   tool_use/tool_result）经由异步路径（权限 hook、消息队列重放、
   attach 侧 replay）晚于终止信号到达 bridge，被原样 live-emit 进
   主时间线 —— 用户看到的就是这个。
2. **终止后重启迭代**：`team-complete` 后 worker 并未销毁，
   stall 看门狗 nudge / `_kickIdleWorkersOnOpenItem` / 后续 chat
   write 都可能再次 `.write()` 某个 worker，产生**新一轮**工具事件。
3. **前端复活已退役 lane**：laneId 缺失的 worker 事件在前端被
   解析到「当前选中 lane」，绕过 `endedLanes` 退役守卫，把幽灵行
   重新插回多列视图。

对 1 和 3，事件的归宿不应是主时间线 —— run 已结束，worker 自己的
`events-worker-*.jsonl` 日志保留了完整取证记录，不丢数据。
对 2，同理：终止后的新一轮活动不是本 run 的内容。

## 3. 为什么「延后打印完成」不是更优解

另一个思路是「等所有 worker 的尾随事件都 drain 完再打印完成」
（用户直觉的方向）。不可行的原因：

- 「drain 完」在 `team-complete` 语义下**已经成立**（§1）——
  迟滞事件是 relay/前端层的时序问题，服务端无法用一个可靠的
  「全部到齐」信号去等它；
- 对**终止后重启迭代**（§2.2）根本不存在「等到没事件为止」的
  判定点 —— worker 何时再被 nudge 是开放式的，等下去会挂死完成
  通知或在错误的方向上取消本已完成 run 的收尾；
- 完成通知的可感知性要求它在队列清零的瞬间及时弹出。

因此正确的收口是「终止后的事件不再进入主时间线」（71a17db），
而不是「延迟完成」。

## 4. 残余风险（记录在案）

- bridge 的 `bridgeEnded` 闸门只拦 `ev.worker` 存在的事件；lane 级
  `state-update`（board 快照、team-lane-end）仍正常放行 —— 有意为之。
- 终止后被重新激活的 worker 的真实输出只存在于 worker 日志，主界面
  不可见。这是权衡后的取舍（run 已完成，后续活动不应混入本 run 的
  呈现），如未来需要可在 team-lane-end 后提供「查看 worker 日志」入口。
- `web/public/app.js` 的新守卫仅在「至少一个 lane 已退役」时生效，
  新页面的 legacy seeding 保持不变 —— 分栏视图 attach 重建不受影响。

## 5. 验证

`test/run-n2-stray-print.test.js`（随 71a17db 落地）锁定：

- 静态：`bridgeEnded` 闸门位于 live-emit / buffer.push / persist 之前；
  前端 laneId-less 守卫位于 `_teamLaneRec` 之前。
- 运行时：lane 终止后的 worker tool_use/tool_result 不再桥接
  （不 live-emit、不进 buffer、不落盘）；终止前事件照常桥接；
  busy worker 的中途 `turn_result` 不会点亮闸门（提前完成语义保持修复）。

全量 `./test/test.sh`：863 passed / 0 failed。
