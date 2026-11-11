# 合成点击确认诊断

使用现有的 `!调试 合成日志 开` 开启，`!调试 合成日志 关` 关闭。日志仍使用 `[craft-debug]`，跟随接单机器人的开关；不增加常驻日志或额外网络请求。

现代协议的每次合成点击会记录 `executor.window_confirmation_start`，成功时补充 `executor.window_click_confirmed`，超时记录 `executor.window_confirmation_timeout`，失败记录 `executor.window_confirmation_failure`。这些事件沿用执行器的 `operationId`、`stepId`，并包含窗口、槽位、鼠标按钮和点击模式。

| 字段 | 含义 |
| --- | --- |
| `elapsedMs` | 本次确认调用已用时间，包含回包解码、验证和本地状态同步 |
| `firstResponseMs` | 收到同一窗口第一份完整内容类型回包的时间；回包可能缺字段或不匹配，没有回包时为 `null` |
| `confirmationMs` | 第一份匹配服务端快照到达并通过验证的时间；未确认时为 `null` |
| `timeoutMs` | 沿用现有配置的确认时限 |
| `responseCount` | 同一窗口收到的内容回包数量，包含不完整或不匹配的回包 |
| `incompleteResponseCount` | 槽位数组不完整或缺少光标字段的回包数量 |
| `rejectedResponseCount` | 已解码、但不符合本次点击预期的回包数量 |
| `lastMismatch` | 最近一次不匹配的原因：光标、首个冲突槽位，或 shift-click 后的整体物品状态 |

耗时使用单调时钟，单位为毫秒，允许小数。这些是同一次调用的不同时间点，不能相加，也不等同于纯网络延迟。回包数不等于点击数；一次点击可能收到重复或过期回包。shift-click 的 `shift_state` 只表明整体状态未通过原有校验，不推断具体物品变化。

光标和槽位摘要只记录物品 ID、数量及短指纹，不输出完整 NBT、组件或原始数据包。关窗确认事件 `executor.window_close_confirmed` 也补充 `elapsedMs` 和 `responseCount`；`confirmed: false` 仍表示需要按原恢复流程处理。日志写入失败不会改变确认结论、增加重试点击或延长确认时限。
