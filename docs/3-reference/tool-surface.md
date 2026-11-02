# 工具面与会话身份

> 读者：改工具、身份判定或系统提示的人
> 状态：现行
> 事实源：[`src/tool-names.ts`](../../src/tool-names.ts)、[`src/tools.ts`](../../src/tools.ts)、[`src/capabilities.ts`](../../src/capabilities.ts)

AgentTeams 注册 15 个业务工具，从会话的第一条请求起就固定：创建、批准、继续、暂停、归档团队都不切换工具定义，也不改写这段系统提示。没有渐进加载，没有激活调用，也没有 `agent_teams_open`。

| 会话身份 | 可用团队工具 | 固定的系统提示内容 |
| --- | --- | --- |
| 普通会话、队长、冷恢复的队长 | 11 个队长工具 | 触发边界、审批、协作、attempt、质量门禁、暂停/恢复、收尾规则和已配置模板目录 |
| 成员 | `claim_task`、`update_task`、`send_message`、`status` | 成员规则和成员 persona |

普通编程与研究工具照常保留。

## 身份判定

成员身份来自三处可信来源，不看可自由填写的 label：

1. 持久化成员表里的成员 ID；
2. 退休成员索引；
3. 插件正在执行的可信成员创建登记。

工具限制同时作用于原生 schema 和 PTC SDK，不能解除用户或 preset 已有的 restriction。

## 请求边界

Slash command、明确的自然语言请求、已有团队的续聊都直接适用核心协议；解释、否定或引用 AgentTeams 本身不构成开工请求。没有团队时创建 staged 计划并等待审批，已有团队则继续工作。

模板目录固定包含名称、人数、规划模式和最多 240 字符的协议摘要，最多 16 个模板。目录只是摘要：完整配置在建队时读取并冻结进团队状态，摘要不能替代它。

核心规则来自系统提示而不是工具返回值，所以 13 工具白名单、代码丢弃返回值、结果被裁剪、会话历史被压缩之后仍然读得到。HMR 会清理插件资源并恢复会话身份；部署新版本或改配置本身可能改变前缀，稳定性约束只针对同一版本、同一配置下的业务生命周期。

## Web 批准通知

面板的 **Approve & Run** 在提交批准并启动调度后，用 `captain.steer` 追加一条插件来源的控制消息：说明已经批准、不要重复批准或派工；队长空闲时立即开始一轮，运行中则在下一个步骤收到。通知失败只记日志，已提交的批准不会被误报成失败；当前没有跨进程持久化的重试保证。

## 验证

`pnpm verify` 的 capabilities 用例用真实 scoped registry、prompt assembly 和 WorkerThreadCodeRuntime 覆盖：固定规则、直接业务调用、重复创建保留原团队、用户 restriction、取消与失败、可信身份、暂停、冷恢复、HMR、PTC/both SDK 和实际结果裁剪。

打包产物的真实宿主验证里，相关场景是 `progressive-entry`（六条入口路径：中英文自然语言、原始 slash、宿主 command registry、profile alias、`--profile`）、`protocol-compatibility`（13 工具白名单与真实代码运行时下的丢弃/裁剪/压缩）和 `web-approval`（真实 HTTP 路由与宿主鉴权）。跑法见 [验证](../2-how-to/verify.md)。
