# 使用指南（详细）

本文档收纳 dsh-agent-teams 的详细使用内容：工作原理、Web UI 行为、工具一览、配置与已知限制。README 只保留简介与快速上手。

## 工作原理

`dsh-agent-teams` 复用 DSH 的能力接缝（capability seam），不依赖 workflow 引擎：

| DSH 能力 | AgentTeams 用法 |
|---|---|
| `ctx.tools` 注册表 | 注册 15 个业务工具（原 14 个 + `agent_teams_run_command`）；按会话身份限制模型可见工具 |
| `ctx.subagents.startContinuable()` | 创建成员：durable 可续聊子代理，带成员 persona |
| `ctx.subagents.followup()` | 唤醒收件成员（消息进入其下一轮次） |
| 持久化团队成员表 + `ctx.agents` | 前者保存 durable 成员身份，后者提供真实 `running / idle / ready` 活动状态（不依赖易变的子代理目录投影） |
| `agent/status` | 成员进入 idle 后触发共享任务池自动续领与下一轮唤醒 |
| `ctx.systemPrompt.section()` | 按初始队长/成员身份提供精简的固定核心策略；模板目录固定保留 |
| Web server 路由注册 | 活动面板数据路由 `/plugins/dsh-agent-teams/state` + 鲸鱼图片静态服务（`webServer`/`httpServer` 双键兼容，见下） |
| 文件系统 | 团队状态持久化在 `<workspace>/.agent-teams/<teamId>/` |

数据链路：工具执行 → 磁盘状态（真相源）→ host 快照路由 → 浮层 1s 轮询渲染；会话日志同时写入 `agent-teams/*` 事件（审计/重放/复盘）。

> **内测版本兼容**：npm `latest`（`0.0.1-rc.1`）的服务键仍是 `ctx.httpServer` / `ctx.workspace`，后续 `next`（`rc.2`）重命名为 `ctx.webServer` / `ctx.workspaceRegistry`。插件对两组键都做了探测（新键优先、旧键回退，`internal/service` 事件同时监听两组），两个版本都能注册路由。

### Web UI

- **跟随宿主语言**：插件注册独立的 `agentTeams` locale namespace，并通过 Slot 的官方 `locale` seat 获取翻译函数；对话卡片、活动面板、动态状态摘要、历史标识和无障碍文案都会随 Harness 在简体中文/英文之间实时切换。英文是缺失词条的官方回退语言，插件不读取 DOM 猜测语言，也不修改宿主源码。
- **右上角活动面板**（`shell.overlay` 非模态浮层）：团队创建后自动展开；默认停靠在会话右侧，高度随内容增长，达到视口安全上限后才在面板内部滚动，不用空白填满屏幕。面板可切换为浮动窗口后拖拽，停靠态支持左边缘调宽，浮动态还支持底边和右下角调整大小；只有用户主动纵向缩放后才固定浮动态高度。位置、手动尺寸和停靠模式会在刷新后恢复；标题栏的收起按钮会折叠为右上角小浮标（团队数 + 活动脉冲点）。每个团队展示队长、分段总进度、状态统计、可折叠成员树和紧凑任务 DAG。DAG 以真实 SVG 曲线连接依赖，悬停或键盘聚焦可预览完整上下游链，点击固定，`Esc` 取消；选中节点会显示负责人、未满足前置、下游解锁信息和该任务使用的模型。运行中的任务节点与派工标签会直接标出模型短名，成员行保留完整 `provider/model`。成员行展示职业头像、角色、实时状态和任务标签，点击可打开成员子会话。
- **小鲸鱼形象**：队长/成员头像为 DeepSeek 小鲸鱼职业插画（`assets/agent-teams/`，8 角色 + 6 动作），按角色关键词匹配；状态动作小图随成员状态切换并带动画（工作浮动 / 空闲呼吸 / 未知思考），未读消息头像外圈光晕；遵循 `prefers-reduced-motion`。
- **会话跟随**：面板只显示**当前会话**的团队（按 captainSessionId 匹配）；新建会话面板自动收起，切回团队会话恢复。
- **对话流卡片**：团队创建时对话流出现轻量卡片（成员一览、点击跳转成员会话、"活动面板"按钮可重新激活已关闭的浮层）。
- **历史复盘**：`agent_teams_delete` 将团队**归档保留**（`<stateRoot>/archive/<teamId>/`，成员、任务、依赖图和邮箱完整留存）；结束团队时成员会被标记为 removed，但仍保留在 Harness 的子代理目录中供历史会话寻址，后续唤醒则继续被拒绝。历史快照保留整支队伍，并以空闲/已交付状态展示。即使旧会话没有对话流卡片，重启后选择该队长会话也会做一次轻量冷发现，恢复成员树与 DAG；点击成员可打开其持久化会话记录。

### 团队状态文件

```
<workspace>/.agent-teams/<teamId>/
├── team.json            # 团队记录：成员、任务（含依赖）、任务序号
└── inbox/
    ├── captain.jsonl    # 队长邮箱（成员 → 队长）
    └── <member>.jsonl   # 每个成员一个邮箱（JSONL）
```

任务状态机：`pending → claimed → in_progress → completed | failed | cancelled`。每次执行携带单调 `attempt` + 唯一 `attemptId`；转派先使旧 attempt 失效，再中断并等待旧成员安静，因此迟到更新无法覆盖新结果。领取前校验依赖，并禁止成员同时拥有两个未完成任务。

旧 `kind=work` 任务仍可用自由文本完成。质量 kind（`requirements` / `implementation` / `verification` / `review` / `repair` / `integration`）走结构化合同：创建时要有 objective 和 acceptance；实现/修复还要有 `inScope` 与 `verify`。`review` / `requirements` 只有 `verdict=pass` 才能 `completed`；`needs_revision` / `reject` 必须 `failed`，并带至少一条 finding。审查失败后系统自动创建不依赖 failed review 的 repair + 下一轮 review。第一版范围控制是完成时审计（对照调用方提交的 `changedPaths`），不是 host 写入拦截。halted 团队不能被普通 `create_task` 静默恢复，必须 `agent_teams_resume` 或 `create_task({ resume, resumeReason })`。质量模式下人只提供目标和约束；默认任务顺序是 requirements → implementation → verification → review → integration，审查合同审的是实现是否过关，不要把“请提交 needs_revision”写进任务。`halted` 表示人停止了团队，`escalated` 只表示自动循环到上限，两者不是一回事。详情见 `docs/quality-gates.md`。

## 工具一览

| 工具 | 作用 |
|---|---|
| `agent_teams_create` | 创建团队，调用者成为队长（一个队长同时只带一个团队） |
| `agent_teams_add_member` | 拉成员入队（spawn 可续聊子代理 + 成员 persona） |
| `agent_teams_remove_member` | 安全移除成员：撤销 attempt、回收其未完成任务、等待中断收敛后重新调度 |
| `agent_teams_create_task` | 创建任务，支持合同字段、`dependencies`、`assignee`；halted 时默认拒绝，除非显式 `resume` |
| `agent_teams_reassign_task` | 原子重试/转派任务；`assignee=captain` 表示队长安全接管 |
| `agent_teams_claim_task` | 领取任务（校验依赖；队长可代领，成员只能领自己的/未指派的） |
| `agent_teams_update_task` | 携带当前 `attempt_id` 推进任务；质量 kind 按 verdict / acceptanceResults / commandsRun / changedPaths 拒绝非法 completed |
| `agent_teams_amend_task` | 队长专属：改写非终态质量任务的 objective/acceptance/verify/inScope/outOfScope（合同本身写错导致无法诚实完成时）；写入 revisions ledger，审查通过后冻结。成员不可用 |
| `agent_teams_send_message` | 任意成员→任意成员/队长：消息直达对方邮箱并唤醒对方（无队长转发；拒绝冒名 `from`） |
| `agent_teams_status` | 团队全景：kind/round/verdict、coverage matrix、escalated、halt/resume 状态 |
| `agent_teams_run_command` | 队长专属：在某个成员自己的会话里列举/执行已注册命令（`action: list\|run`）；命令行必须单行、`/` 开头、≤512 字符，默认 deny 掉 agent-teams 命名空间（见「成员命令面」） |
| `agent_teams_resume` | 显式恢复 halted 团队，必须带非空 reason；不重建已取消任务 |
| `agent_teams_delete` | 结束团队：打断成员，团队目录**归档保留**（任务与依赖图、邮箱完整留存） |

`agent_teams_add_member` 默认不需要模型参数：成员沿用队长当前 LLM provider/model 时，会一并快照队长**显式选定**的思考强度（队长只是跟随模型默认档时不算选定）。用户明确要求某个角色使用其他模型时，可以同时传入可选的 `provider` + `model`；只覆盖 `model` 时沿用队长当前 LLM provider。provider 或 model 任一改变时，思考强度保持未指定、始终跟随目标模型自己的默认档；用户明确要求某个成员使用特定强度时，可以传入可选的 `reasoning_effort`（目标模型支持的档位 id，或 `"default"` 表示强制使用模型自身默认档）。插件不会为每个成员发起二次选择或弹窗。

### 成员命令面（`agent_teams_run_command` + 成员详情页 composer）

成员会话里的用户命令（`/compact` 等）有两个入口：队长用工具**下发**，或人在该成员自己的会话里用 composer **手打**。两者最终都走宿主的同一命令总线（在该成员 Agent 上执行 `ctx.commands.execute`），区别只在授权方是谁。

**工具 `agent_teams_run_command`（队长专属，成员看不到这个工具）**

| 参数 | 说明 |
|---|---|
| `member` | 成员显示名（队长视角）或成员子会话 id；必须是在队且未被移除的成员 |
| `action` | `list` = 列该成员**自己的**命令目录；`run` = 在成员会话里执行 `line` |
| `line` | `run` 必填：单行命令，必须以 `/` 开头，≤512 字符，**不允许 CR/LF** |

- `list` → `{ member, commands: [{ name, description?, hint?, attachments? }] }`，按该成员会话自己的 scope 列举（不同成员可见命令集可能不同，不能拿队长的列表冒充）。冷成员会先被解析/唤醒（与 `run` 同一解析路径），不确定成员支持什么命令时先 `list`。
- `run` → `{ member, line, ok, kind: 'success' | 'error', text?, command_id? }`；`text` 是命令自己的结果文案，原样返回。没有任何已注册命令认领该行（`execute` 返回 `undefined`）时返回 `ok: false, kind: 'error'` 与明确说明，不会静默成功。
- 执行等价于成员**自己手打同一行**：`attachments` 恒为空（不携带附件，也不能用工具伪造附件）。
- 守卫（全部是硬失败，不静默降级）：`line` 必须带前导斜杠、≤512 字符；**含 CR/LF 直接拒绝**（一次调用只允许一条命令行，防止用换行把第二条命令偷渡过命令名检查）。默认 **deny 掉本插件自己的命令名 `agent-teams` 及其 `<profile>` 别名前缀族**（即 `agent-teams` 与一切 `agent-teams-*`）；被拒的行**不会到达命令总线**，`list` 也不显示这一族。
- 成员正在停止（draining）或从未启动（还没有会话）时拒绝，并提示重试时机；命令本身失败（例如压缩正在进行中返回 busy）按命令返回原样给出，**不自动重试**。
- 配置 `memberCommandDeny?: string[]`（默认 `['agent-teams']`）是**字面替换**的安全开关，只约束队长经工具下发的行（成员详情页 composer 的人手路径不受它约束，见下）。**写法规约**：
  - **不带斜杠**：写宿主真实的命令名（`compact`），不要写 `/compact`。条目会先归一化——忽略首尾空白、忽略**任意个数**的前导斜杠、忽略大小写，所以 `compact`、`/Compact`、` /COMPACT ` 是同一个开关。（归一化前的版本会让这些写法静默 fail-open；N1 已修复，现在它们都会正确拒绝。）
  - **前缀族**：每条条目同时拦它整个 `<entry>-*` 族——`deny: [review]` 也会拒 `/review-tools`。它比字面匹配更保守，是有意为之。
  - **`[]` 的语义 = 什么都不拒**：显式写 `memberCommandDeny: []` 会**连同默认的 `agent-teams` 保护一起关掉**（`/agent-teams` 也能下发）。这个数组是**字面替换**而不是追加；要保留默认保护就不要写这个键。
  - **非法条目 = 插件加载失败**：条目里没有可用的命令名（空串、`/`、`/ Compact`、`!!!`、数字、全角斜杠或零宽字符等）时，挂载阶段直接抛错，错误首句点明「AgentTeams 插件加载失败 … memberCommandDeny 非法」——工具与路由**都不会注册**，这不是命令执行错误。例外：绕过挂载直接调用 `registerAgentTeamsTools` 的调用方只收到一条 warn（记录差异，同名用例 M3 覆盖）。
  - 合法的超长条目**不截断也不报错**（已核对无实际影响）。

**成员详情页 composer（人手动下发）**

成员自己的会话里，插件接管了宿主 composer（`conversation.composer` 座位，优先级 -20），渲染与宿主一致的输入框：`/` 开头的行按命令执行，其他内容作为消息投递给该成员。命令目录来自该成员**自己**的会话（`GET /member/commands?sessionId=`），不是队长的目录。

| 控件 | 行为 |
|---|---|
| `/` 菜单 | 方向键选择、Enter 执行、Esc 关闭；只列该成员自己的已注册命令 |
| 发送 | 成员**空闲**时排队为下一回合（`mode=queue`）；成员**运行中**时插入当前回合（`mode=steer`）。模式由 `/member/state` 的实时状态决定 |
| 模型选择 | 列出宿主模型目录；切换走 `POST /member/model`，只作用于该成员**当前存活**的选择，冷成员与 halted 团队直接拒绝（不为了换模型唤醒成员） |
| 停止 | 成员运行中时出现，`POST /member/stop` 经其队长打断当前回合 |
| 排队徽标 | `/member/state` 报的待处理条数；驻留占位不算排队 |

- **归档成员只读**：团队 halted 后座位仍在，但输入、模型选择、停止全部禁用，历史可查看。
- **不唤醒冷成员**：`/member/commands` 只读进程内已存在的 Agent，冷成员返回 409 且菜单为空；只有发消息才会投递（并按其所在团队规则唤醒）。
- **归属判定在插件侧**：客户端读不到团队状态，先向 `GET /member/membership?sessionId=` 探一次并缓存；未命中（非成员会话）永不接管，交还宿主 composer。
- **有意的不对称**：人手路径**不套** `memberCommandDeny`——动手的就是操作者本人，即授权方；只有队长通过工具下发时才受 deny 约束。
- 附件暂不支持：宿主的附件准入拒绝 subagent 会话，图片目前无法进入成员会话；需要把文件路径写进消息正文。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: agent-teams
  config:
    stateDir: .agent-teams        # 团队状态目录名（工作区下）
    memberProvider: spawn         # 子代理运行后端（spawn / fork），不是 LLM provider
    memberModel: deepseek-v4      # 可选：成员模型覆盖
    memberMaxDepth: 1             # 成员再委派深度上限（0 = 禁止）
    maxMembers: 8                 # 团队人数上限
    executionPrompt: |            # 注入成员 persona 与每次任务派工
      The document does not need to record the process; it should only record facts, unless I explicitly request the process to be recorded.
      The product interface should present the intended outcome, not reveal the reasoning process.
    fallback:                     # 主模型不可用时的第二选择
      provider: openai
      model: gpt-5.5
    memberCommandDeny:            # 可选：agent_teams_run_command 的 deny 列表（默认 ['agent-teams']）
      - agent-teams               # 写命令名，不带斜杠；每条同时拦 <entry>-*；显式写 [] 会连默认保护一起关掉
    toolPolicies:                 # #59 部署方声明的可复用成员工具策略
      researcher:
        allow: [read, glob, grep] # 只保留这些全局工具（四个协调工具自动加入）
      implementer:
        deny: [web_search]        # 只移除这些全局工具
    memberContext:                # 可选：成员上下文预算（自动压缩，见下）
      maxTokens: 150000           # 触发阈值（绝对值）；与 maxRatio 可同时给出，取更小者
      # maxRatio: 0.15            # 或按成员模型 contextWindow 的比例
      cooldownMs: 60000           # 两次压缩之间的最小间隔
      minTurnGap: 1               # 两次压缩之间至少隔 N 个回合
      onLimit: compact            # compact | notify | off
```

`toolPolicies` 的 id 由部署方声明，成员只能按 id 选择：`agent_teams_add_member` 的 `tool_policy`、内联 `plan` 的成员行，或 profile 成员行的 `tool_policy`。队长模型不能提交原始 allow/deny 列表，也不能在运行时新建策略。队长专属工具始终被拒绝且无法通过 allow 列表重新打开；四个协调工具（`agent_teams_claim_task`、`agent_teams_update_task`、`agent_teams_send_message`、`agent_teams_status`）始终可用，策略也不允许拒绝它们。未知 id、空策略或空列表会在挂载时或写入成员前直接失败，不会留下成员或可恢复的孤儿会话。生效的策略 id 与解析后的过滤器会写入 `team.json`（`toolPolicy` / `toolFilter`），`agent_teams_status` 显示策略 id；重启后由子会话持久 descriptor 重新应用同一过滤器。未配置策略的成员保持原有工具集与记录结构。该能力是全局工具的模型可见性与调用限制，不是 OS 沙箱或授权边界。

最终优先级为：成员显式 `provider` + `model` / `model` → `memberModel` → 队长当前路由。成员沿用队长当前 provider/model 且队长显式选过强度时继承该强度；provider 或 model 任一改变、或队长跟随模型默认档时，成员强度保持未指定并跟随目标模型默认档。显式 `reasoning_effort`（目标模型支持的档位 id，或 `"default"`）优先，并在目标 provider/model 上创建前校验；不兼容时成员创建会明确失败。写入 `team.json` 的是 provider/model 与**已钉住**的思考强度；未钉住的成员不落值，冷恢复后继续跟随模型默认档。

### 成员上下文预算（memberContext）

`memberContext` 为每个成员设置插件级的上下文预算：成员**空闲**且测得的上下文用量达到阈值时，插件调用宿主压缩服务对它做一次压缩并记账。Harness 自带的自动压缩按 provider/model 统一配置，默认接近满窗才触发；`memberContext` 让某个成员（而不是整个模型）更早压缩。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `maxTokens` | — | 触发阈值（绝对 token 数）；与 `maxRatio` 至少给一个（否则挂载时直接报错），同时给出时取更小者 |
| `maxRatio` | — | 按成员模型 `contextWindow` 的比例；取不到该窗口时这一项不参与计算（不猜窗口大小）；若它是唯一阈值，该成员的看门狗保持关闭并记一条 info 日志 |
| `cooldownMs` | `60000` | 两次压缩之间的最小间隔（毫秒） |
| `minTurnGap` | `1` | 两次压缩之间至少经过的回合数（成员每进入一次 `running` 记一回合） |
| `onLimit` | `compact` | 达到阈值时的动作：`compact` 压缩一次；`notify` 只记录（info 日志），不压缩、不写盘；`off` 不注册看门狗（连用量采样也不做） |

**不配置整个 `memberContext` 时功能完全关闭**：不注册看门狗、不向 `team.json` 写任何新字段，行为与旧版本一致。要回到旧行为：删掉整个 `memberContext`，或保留阈值并把 `onLimit` 设为 `off`（块内仍需至少一个 `maxTokens` / `maxRatio`，否则挂载时报错）。

**成员级预算**：profile 成员行、内联 `plan` 成员行、`agent_teams_add_member` 的 `context_max_tokens`，以及 `agent_teams_edit_plan`（`update_member`，传 `null` 可清除）都接受一个正整数。执行前计划审查面板的成员卡片里也有「上下文预算」输入框，可直接为 staged 成员编辑同一字段：它预填该成员的**声明值**（`context_max_tokens`，不是运行期测量值），**留空/清空并保存 = 发送 `null` = 清除成员级预算、回到插件默认**。它与插件默认进入同一次预算解析：成员级 `context_max_tokens`、插件 `maxTokens`、`floor(contextWindow × maxRatio)` 三者中**最小的那个生效**——所以成员级值只会让该成员更早压缩，不会放宽插件的上限。

**触发语义**：看门狗只在该成员 `agent/status` 进入 `idle` 时评测——压缩要求成员空闲且没有排队唤醒，成员正忙或有排队消息时本次跳过、下一轮空闲再评（不报错、不原地重试）。`cooldownMs` 与 `minTurnGap` 只约束重复压缩：从未压缩过的成员首次超限立即行动。用量采样写盘节流为至少 5 秒一次，`team.json` 里的数字最多滞后数秒。

**可观测性**：`agent_teams_status` 的成员可携带 `context: { tokens, limit?, ratio?, compactions?, measured_at }` 与 `context_live`。`limit` / `ratio` 只在能确定上限时出现（成员级 `context_max_tokens` 或插件 `maxTokens`；只用 `maxRatio` 时状态里没有这两项），面板此时只显示 tokens。`context_live: true` 表示本次是从驻留会话实时测量的，否则 `tokens` 来自最近一次落盘采样；冷成员也有值（读 `team.json`），查询状态不会唤醒任何成员。记账写入成员记录的 `contextUsage`（压缩时另有 `lastCompactAt` / `lastShadowedTokens`），老 `team.json` 仍可读。活动面板成员行显示当前用量/上限与已压缩次数（面板走轮询快照，展示的是落盘采样）。

## 使用协议

插件提示段会指导模型按两阶段协议执行：继续已有团队，按需通过 `agent_teams_status` 确认状态 → 无团队时创建 staged 团队 → 写入可编辑成员占位 → 拆任务并声明依赖 → 等待用户审查 → **Approve & Run** 后原子创建成员并启动调度 → 队长监控/引导 → 汇报后 `agent_teams_delete`。staged 阶段没有子会话、不会领取任务。只有用户明确要求跳过审查时才使用 `approval: automatic`。成员之间可以直接互发消息，无需队长中转。驻留成员在中断或正常结束一轮后若仍持有 `claimed/in_progress` 任务，该 attempt 会停驻；只有显式重试/转派/接管才会撤销它。本进程已经观察过的停驻 attempt 在 Harness 回收其 AgentHandle 后仍保持原 attempt，Captain 轮询 `agent_teams_status` 不会因此重铸。只有冷启动或从未被本进程观察过的开放任务，才会自动恢复一次；恢复投递失败会回到原来的 capability，而不会变成可无限重派的 `pending`。

## 命名多角色 profiles

在 profile 的 `cordis.patch.yml` 中配置 `profiles`。每个模板都会定义成员阵容；`taskPlanning: captain` 只提供阵容与门禁，由 Captain 根据目标动态建任务图；省略该字段或设为 `seed` 时，仍会展开固定任务种子。例如：

```yaml
profiles:
  demo-delivery:
    description: 交付一个小功能
    protocol: 先讨论需求，再实现、审查、测试和发布准备；未经确认不得部署。
    members:
      - name: analyst
        model: gpt-5.6-sol
        role: 分析需求
      - name: implementer
        model: gpt-5.6-terra
        role: 实现方案
    tasks:
      - id: requirements
        subject: 需求讨论
        assignee: analyst
      - id: implementation
        subject: 实现方案
        assignee: implementer
        dependencies: [requirements]
```

通过 `/agent-teams --profile demo-delivery 实现这个功能` 显式点名模板；不要使用首 token 隐式 profile。seed 模式提供模板任务，captain 模式只提供阵容与约束，由 Captain 在 staged 阶段设计 DAG。面板允许编辑成员 provider/model/reasoning/角色提示词和任务负责人/依赖，批准前不会创建成员或派工。依赖 output 会传给下游；failed 的审查/测试不会解锁后续，自动 repair/review 不依赖 failed review。`memberProvider` 是 spawn/fork 后端，不是模型 provider。

## Captain 动态规划与停止整队

推荐的 profile 配置只提供成员阵容、模型路由和交付门禁，不预先规定用户目标的完整 DAG：

```yaml
profiles:
  software-delivery:
    taskPlanning: captain
    protocol: |
      用户只提供目标和约束。由 Captain 决定是否拆分、如何设置依赖、哪些工作可以并行。
      不要询问用户是否拆分、合并、串行或并行。
    members:
      - name: requirements-analyst
        provider: openai
        model: gpt-5.6-sol
        role: 分析需求和验收标准
```

`taskPlanning: captain` 时 profile 不再假设项目目录、包管理器或固定质量图；Captain 根据真实目标和 workspace 设计 DAG。若用户明确要求质量门禁，再创建带合同的 requirements → implementation → verification → review → integration 任务，并从真实项目推导 `inScope` 与 `verify`。`taskPlanning: seed` 保留固定 seed task 工作流。

执行前计划审查直接读取 Harness 的模型目录：成员模型和推理等级使用与主输入区一致的 Provider/模型元数据，不再要求手写路由。「返回对话修改」会把 staged 草案标记为等待反馈，取消尚未结束的规划轮次，并由插件上下文要求 Captain 只追问一次修改方向；用户回复后，Captain 必须通过一次 `agent_teams_edit_plan` 原子更新同一份草案，不能另建团队。「放弃本次计划」需要二次确认，随后归档草案、取消当前轮次，并保留禁止自动重建的模型上下文；仅「确认并启动团队」会创建成员和调度任务，且不再增加一次无意义的启动确认。

长任务运行期间，具体团队标题右侧会显示停止按钮。点击后需在确认框中再次确认，才会取消 Captain 当前回合、中断全部成员、取消未完成任务并停止后续调度；入口不再占用聊天输入区域。停止不会删除团队，之后的新用户消息可显式要求 `agent_teams_resume`。取消/失败任务在归档中保持原终态。

## 已知限制

- 调度是事件驱动而非常驻轮询；队长离线时无法冷恢复成员，任务和消息保留在磁盘，待队长恢复或调用状态工具后继续投递。
- 一个队长同时只能带一个团队（与 Claude Code AgentTeams 一致）。
- 成员 persona 替换部署默认 persona；成员仍拥有完整工具集（bash/fs/web 等）。
- 团队状态为文件级持久化，多进程同时操作同一团队不保证一致（同一 dsh 进程内已用锁串行化）。
- 活动面板读磁盘真相，与会话日志事件流相互独立：切换/重启后先对当前会话做一次冷发现；仅在发现活动团队或存在对话流卡片需求时保持 1s 轮询，普通会话不会常驻扫描。
- 主聊天窗的官方 Stop 只取消队长当前轮次；活动面板中具体团队的「停止团队」会在二次确认后同时取消 Captain 当前回合和全部 continuable 成员，并冻结后续调度。输入框仍可在停止完成后发送新的恢复指令。
- 右上角浮层挂载到 DeepSeek Harness `0.1.0-rc.8` 的 `shell.overlay`；宽屏停靠态让主对话列按面板实际宽度礼让空间，浮动态保持非模态覆盖，窄屏退回安全内边距 overlay 并关闭拖拽/缩放，左侧导航保持不动。
- `/agent-teams` 在 slash 菜单中的描述和输入 hint 来自 Host `CommandDefinition`；当前官方命令协议没有 locale namespace 字段，因此仍保留稳定的英文元数据。插件不会用 DOM 替换去伪造这一层翻译；待 Host 提供正式接口后再接入。
- 成员（模型）不总是严格走工具"仪式"（如完成时不调 `agent_teams_update_task`）——面板如实反映磁盘真相，队长以 `agent_teams_status`/文件为准汇总。

## 验证

- 离线与生命周期：`pnpm build && pnpm typecheck && pnpm verify`。除基础检查外，还包含 8 成员、31 节点多层 DAG（运行中扩展至 38 任务）的故障矩阵：并发接管/移除、50 次迟到写入、4 个开放任务冷重启、7 路认领竞争、40 次终态覆盖、42 条消息突发和最终归档；组合验证 `dsh --profile agent-teams-check --dump-config`
- 真实 e2e：`dsh plugin --profile headless add <path>` 后 `dsh --profile headless "用 AgentTeams …"`，核对 `.agent-teams/` 状态文件与会话日志事件流
- GUI：独立实例 + ego-browser（详见 `verification-guide.md`）
