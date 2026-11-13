# AgentTeams 质量门禁与多轮审查实现文档

> 读者：改质量门禁或审查流程的人
> 状态：现行（契约判定点在代码与测试，本文解释设计与边界）
> 事实源：[`src/quality-gates.ts`](../../src/quality-gates.ts)、[`scripts/quality-gates-tdd.mjs`](../../scripts/quality-gates-tdd.mjs)

## 0. 一句话目标

把 AgentTeams 从“可靠的多 Agent 任务调度底座”升级为“带结构化任务合同、审查结论、自动修复链、强制 TDD 和范围门禁的交付系统”。

“直到共识”在本仓库的官方定义不是“几个 Agent 都说没问题”，而是：

```text
所有必需门禁都通过
+ 所有 acceptance 通过
+ 没有 blocker / high finding
+ 最新实现版本已被独立 Reviewer 审查
+ 声明的验证命令通过
+ 修改范围合法
```

## 1. 能力基线

### 1.1 已实现能力与不变量

| 能力 | 位置 | 必须保持 |
|---|---|---|
| 任务状态机 `pending → claimed → in_progress → completed\|failed\|cancelled` | `src/types.ts`、`src/state.ts` | 终态只读；`claimed` 不能直接 `completed` |
| 依赖只认上游 `completed` | `unsatisfiedDependencies()` | `failed` / `cancelled` 永远不解锁下游 |
| `attempt` + `attemptId` | `beginTaskAttempt()` / `update_task` | 迟到写入必须继续被拒绝 |
| Captain 动态规划 | `taskPlanning: captain` | 不要改回固定 seed DAG 才能审查 |
| 并行 ready tasks | `src/scheduler.ts` | 无真实依赖仍可并行 |
| 停止整队 | `haltTeamWork()`、`POST /plugins/dsh-agent-teams/halt` | 停止仍不删除团队 |
| 现有验证入口 | `pnpm typecheck`、`pnpm build`、`pnpm verify` | 新检查必须挂进 `pnpm verify` |

## 2. 设计边界

这些约束不可协商；改门禁前先对照：

- 不新建第二套 workflow 引擎：复用现有 DAG、attempt、halt 和 scheduler。
- 终止条件不是“几个 Agent 互相说 OK”，而是门禁全部通过 + acceptance 证据 + 无 blocker/high finding + 独立审查 + verify 通过 + 范围合法。
- 实现者不能批准自己的实现或修复；review / requirements 只有 `verdict=pass` 才算通过。
- review / verification 任务不默认拥有写代码权限语义。范围控制是**完成时审计**（对照 `changedPaths` 与实际字节），不是 host 写入拦截——不要把它宣传成硬安全边界。
- repair 任务不能依赖 failed 的 review 任务；failed / cancelled 是终态，不复活，下一轮新建任务。
- 不用 `reassign_task` 重跑旧 review 来代替新建 `review-N+1`（`beginTaskAttempt()` 会清掉旧 output）。
- `send_message` 不是正式审查：邮件没有门禁。
- 一个 Captain 同时只带一个团队。

## 3. 边界和职责

### 3.1 系统职责

系统必须机器强制：

- 没有合同的实现/修复任务不能创建。
- 没有验收证据的任务不能 `completed`。
- review / requirements 没有 `verdict=pass` 不能 `completed`。
- `needs_revision` / `reject` 不能解锁下游。
- 越界 `changed_paths` 不能 `completed`。
- 验证命令失败只能 `failed`。
- 审查失败自动开 repair + 下一轮 review，直到通过或达到上限。
- 达到 `maxReviewRounds` 后停止自动循环，升级给 Captain / 用户。
- halted 团队默认不能被普通 `create_task` 恢复。

系统不保证：

- 成员在执行中完全无法用 bash 改范围外文件。
- 模型一定写出高质量代码。
- 用户已经在 GUI 里预审过 DAG。

### 3.2 Captain 职责

- 根据用户目标画最小任务图。
- 先建需求/验收任务，再创建实现任务。
- 输出 coverage matrix：用户每个约束至少映射到一个任务。
- 不自己批准实现，除非用户明确要求 Captain 接管。
- 超轮次或出现契约不清时，向用户升级，而不是无限互审。
- 用户只要汇报、不要继续执行时，不得 `create_task`，必须用 status / 已有结果回答。

### 3.3 成员职责

| 角色 | 可以做 | 不可以做 |
|---|---|---|
| requirements-analyst | 产出目标、范围、验收、open questions | 写实现代码；自己宣布需求已收敛 |
| requirements-challenger | 找遗漏、歧义、冲突 | 直接改需求合同为最终版；写实现 |
| implementer | 只改 `inScope` 内文件；跑 `verify` | 改 `outOfScope`；批准自己的实现 |
| test-engineer | 补测试、跑验证、报告失败 | 用测试失败当通过；扩大产品范围 |
| correctness-reviewer | 只读审查逻辑正确性 | 直接改代码；审查自己刚写的实现 |
| security-reviewer | 只读审查权限/注入/泄露 | 直接改代码 |
| scope-reviewer | 对照合同和 `changed_paths` 查越界 | 放过未入账改动 |
| integrator | 最终验证、汇总证据 | 在审查未通过时宣布交付 |
| fixer / repair | 只修指定 findings | 顺手做 `outOfScope`；自己把 review 标 pass |

### 3.4 用户职责

- 提供目标和约束。
- 确认有歧义的 open questions。
- 明确要求停止或恢复团队。
- 真实部署必须由用户确认。

## 4. 产品流程

```text
用户目标
  ↓
requirements-round-1
  ↓
requirements-challenge
  ↓
requirements 收敛？
  ├─ open questions 未关 → 不能创建实现任务
  └─ verdict=pass
       ↓
coverage matrix 完整
       ↓
implementation
       ↓
verification
       ↓
correctness / security / scope 并行 review
       ↓
全部 pass？
  ├─ 否 → repair-round-N（不依赖 failed review）
  │         ↓
  │       verification
  │         ↓
  │       review-round-N+1（必须针对最新 attempt）
  │         ↓
  │       超过 maxReviewRounds？
  │         ├─ 是 → 升级 Captain / 用户，停止自动循环
  │         └─ 否 → 继续
  └─ 是
       ↓
integration / 最终验证
       ↓
范围审计 + coverage matrix
       ↓
交付
```

需求讨论轮数由 profile 配置，不写死“所有任务必须 3 轮”。小任务可以 1 轮通过；高风险任务可以要求最少 2 轮。

## 5. 数据模型

数据都存在 `TeamTask` / `TeamState` / `TeamProfileSnapshot` 上；修订账本在任务的 `revisions`，不另起状态文件。

### 5.1 枚举

```ts
type TaskKind =
  | 'requirements'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'
  | 'work' // 兼容旧任务；没有质量门禁的普通工作

type ReviewVerdict =
  | 'pass'
  | 'needs_revision'
  | 'reject'

type FindingSeverity =
  | 'low'
  | 'medium'
  | 'high'
  | 'blocker'
```

### 5.2 任务字段

```ts
interface ReviewFinding {
  id: string                 // 稳定 id，例如 SEC-001
  severity: FindingSeverity
  file?: string
  line?: number
  problem: string
  requiredFix: string
  resolved?: boolean
}

interface AcceptanceResult {
  criterion: string
  status: 'passed' | 'failed'
  evidence?: string
}

interface CommandResult {
  command: string
  status: 'passed' | 'failed'
  exitCode?: number
  evidence?: string
}

interface TeamTask {
  // 现有字段保持不变
  kind?: TaskKind
  round?: number
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  acceptance?: string[]
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
  reviewedTaskId?: string
  reviewedAttempt?: number
  sourceTaskId?: string        // repair 对应的实现/上一轮产物
  sourceFindingIds?: string[]
  coverageOf?: string[]        // 覆盖的用户约束/目标条目
}
```

旧任务没有这些字段时：

- `kind` 缺省视为 `'work'`。
- `'work'` 保持旧行为，避免破坏已有团队和测试。
- 新创建的 `requirements` / `implementation` / `verification` / `review` / `repair` / `integration` 必须走新门禁。

### 5.3 团队 / profile 字段

```ts
interface ReviewPolicy {
  requirementsMinRounds?: number // 默认 1
  requirementsMaxRounds?: number // 默认 4
  codeMaxRounds?: number         // 默认 3
  maxRepairAttempts?: number     // 默认 2
  requiredReviewers?: string[]   // 例如 ['correctness', 'security', 'scope']
}

interface TeamState {
  // 现有字段
  reviewPolicy?: ReviewPolicy
}

interface TeamProfileConfig {
  // 现有字段
  reviewPolicy?: ReviewPolicy
}
```

配置校验：

- 所有轮数必须是正整数。
- `min <= max`。
- `requiredReviewers` 只能是已知角色别名或成员名。
- 未知字段继续按现有 profile allowlist 拒绝。

### 5.4 持久化校验

`isTeamTask()` / `isTeamState()` 必须接受并校验新可选字段：

- 枚举值非法则拒绝整份 `team.json`。
- 空字符串 `objective` / 空 `inScope` 项非法。
- `round` 若存在必须是 `>= 1` 的安全整数。
- `findings[].id` 非空且同一任务内不重复。

旧文件缺字段必须仍能 cold-resume。

## 6. 机器规则

这些规则必须由工具/状态机执行，不能只写进 persona。

### 6.1 创建任务

`agent_teams_create_task` 增加可选参数：

```ts
{
  subject: string
  description?: string
  dependencies?: string[]
  assignee?: string
  kind?: TaskKind
  round?: number
  objective?: string
  inScope?: string[]
  outOfScope?: string[]
  acceptance?: string[]
  verify?: string[]
  deliverables?: string[]
  nonGoals?: string[]
  reviewedTaskId?: string
  sourceTaskId?: string
  sourceFindingIds?: string[]
  coverageOf?: string[]
  resume?: boolean
  resumeReason?: string
}
```

创建规则：

1. `kind` 缺省为 `'work'`，兼容旧调用。
2. `kind` 为 `implementation` / `repair` / `verification` / `review` / `requirements` / `integration` 时：
   - 必须有非空 `objective`。
   - 必须有非空 `acceptance`（至少 1 条）。
3. `implementation` / `repair` 还必须有非空 `inScope` 和非空 `verify`。
4. `review` 必须有 `reviewedTaskId`，且目标任务存在。
5. `repair` 必须有 `sourceTaskId` 和至少 1 个 `sourceFindingIds`。
6. `repair` / 下一轮 `review` 的 `dependencies` 不得包含 `failed` / `cancelled` 任务。
7. 同一团队内，两个同时 `pending|claimed|in_progress` 的 `implementation|repair` 任务，若 `inScope` 路径集合相交，拒绝创建或要求加依赖。相交则拒绝并行创建，错误信息必须指出冲突路径和另一个 task id。
8. 团队 `halted=true` 时：
   - 默认拒绝 `create_task`。
   - 只有 `resume=true` 且 `resumeReason` 非空时才清除 `halted/haltedAt` 并创建任务。
   - 不得因为普通创建而静默恢复。
9. 需求未收敛时，Captain 协议和工具层都要挡实现：
   - 若团队已有 `kind=requirements` 任务，且没有一条 `completed + verdict=pass`，拒绝创建 `implementation`。
   - 若完全没有 requirements 任务，允许创建；这是兼容无质量配置的旧用法。质量 profile 必须先建 requirements。

### 6.2 更新 / 完成任务

`agent_teams_update_task` 增加可选结构化参数，或允许 `output` 旁路解析一份 JSON。优先显式参数，不要只靠自由文本：

```ts
{
  verdict?: ReviewVerdict
  findings?: ReviewFinding[]
  changedPaths?: string[]
  acceptanceResults?: AcceptanceResult[]
  commandsRun?: CommandResult[]
}
```

完成规则：

1. 现有状态机不变：`claimed` 不能直接 `completed`。
2. `kind=requirements|review`：
   - `completed` 仅当 `verdict=pass`。
   - `verdict=needs_revision|reject` 必须 `failed`，且 `findings` 至少 1 条。
   - 缺少 `verdict` 时拒绝 `completed` 和“口头通过”。
   - `pass` 时不得残留未解决的 `blocker|high` finding。
3. `kind=implementation|repair|verification|integration`：
   - `completed` 必须带齐 `acceptanceResults`，且每条 acceptance 都有对应 `passed`。
   - 必须带 `commandsRun`，覆盖任务 `verify` 中的每一条，且全部 `passed`。
   - `implementation|repair` 必须带 `changedPaths`。
   - 任一 `changedPaths` 落在 `outOfScope`，或不能证明属于 `inScope`，只能 `failed`。
   - 验证失败只能 `failed`。
4. `output` 仍然保存，供人和下游阅读；但结构化字段才是门禁真相。
5. 成员仍必须提交当前 `attempt_id`。
6. 实现者不能把自己的实现任务标成 review pass。review 任务必须由 review 角色 / 被指派的 reviewer 完成。

路径匹配规则（纯函数，已单测）：

```text
inScope / outOfScope 使用工作区相对 POSIX 路径。
支持精确文件和目录前缀：
  src/foo.ts     只匹配该文件
  src/foo/       匹配该目录及其子路径
禁止匹配到仓库外、绝对路径、.. 逃逸。
outOfScope 优先于 inScope。
未声明路径对 implementation/repair 视为越界。
```

默认硬排除，即使没写进 `outOfScope`：

```text
~/.dsh/
.git/
**/.env
**/.env.*
**/secrets/**
**/id_rsa*
其他 git 仓库根
```

完成审计以调用方提交的 `changedPaths` 为输入；生命周期测试可再加一个纯函数 `collectChangedPaths(gitStatusText)` 解析 `git status --short` / `git diff --name-only`。不要在单元测试里依赖真实 git 仓库，除非放在临时目录。

### 6.3 自动修复 / 复审

当 `kind=review|requirements` 以 `failed` 且 `verdict=needs_revision` 结束：

系统自动创建：

```text
repair-round-(N+1)
  kind=repair
  assignee=原实现者或 source task 的 assignee
  sourceTaskId=被审任务
  sourceFindingIds=未解决 findings
  dependencies=[sourceTaskId]   // 成功产物，不是 failed review
  round=N+1
  inScope=从 findings.file 收窄；若没有 file 则继承 source.inScope
  verify=继承 source.verify
  acceptance=每个 finding 的 requiredFix

review-round-(N+1)
  kind=review
  assignee=原 reviewer，不得改成实现者
  reviewedTaskId=新 repair 任务
  reviewedAttempt=repair 完成后的 attempt
  dependencies=[repair-round-(N+1)]
  round=N+1
```

若原任务是 `requirements`，自动创建的是下一轮 requirements / challenge，而不是代码 repair。命名保持 `requirements-round-N`。

自动创建前检查：

- `round + 1 <= maxRounds`。
- 同一 `sourceTaskId + finding set + reviewer` 未超过 `maxRepairAttempts`。
- 超限后：
  - 不再自动建任务。
  - 给 Captain 发一条 mailbox / steer 消息。
  - status 中出现 `escalated: true` 或等价字段。
  - 团队不自动 halt，除非用户停止。

`verdict=reject`：

- 不自动修复。
- 升级 Captain / 用户。
- 下游保持锁定。

### 6.4 调度

保持现有 scheduler：

- 只派 `pending` 且依赖全部 `completed` 的任务。
- mailbox 仍优先于新任务。
- halted 仍不派工。
- 自动创建的 repair / review 只是普通任务，不要为它们发明新调度器。

assignment prompt / persona 必须补上：

- 当前 `kind` / `round` / `objective` / `inScope` / `acceptance` / `verify`。
- review 只能 `pass` / `needs_revision` / `reject`。
- 完成必须走结构化字段。
- 只改本任务范围。
- 不要把邮件当成正式下一轮审查。

这些 prompt 是辅助，不是门禁本身。

### 6.5 恢复语义

恢复工具：

```text
agent_teams_resume
```

参数：

```ts
{
  reason: string   // required, 非空
}
```

行为：

- 仅 Captain 可调用。
- 团队未 halt 时返回 `already_running`，不报致命错误。
- 团队已 halt 时清除 `halted/haltedAt`，然后 `kickTeam`。
- 不自动重建被取消的旧任务。
- 恢复后只调度仍然 `pending` 的任务；halt 时已被标 `cancelled` 的任务保持 cancelled。

`create_task` 不再隐式 unhalt。若 Captain 需要“恢复并创建下一阶段任务”，应先 `resume` 再 `create_task`，或使用 `create_task({ resume: true, resumeReason })` 作为同一锁内的便捷入口。两种入口语义必须一致，并有测试。

### 6.6 Coverage matrix

Captain 或系统在 status 中投影：

```ts
{
  goal_item: string
  task_ids: string[]
  status: 'missing' | 'in_progress' | 'passed' | 'blocked'
  evidence?: string
}
```

规则：

- 质量模式下，用户目标拆出的每条约束都应出现。
- 存在 `missing` 时，status / finalize 不得声称项目完成。
- 允许 Captain 通过任务 `coverageOf` 声明覆盖关系；系统检查“是否有任务声明覆盖”，不解析自然语言目标。
- 必须提供一个纯函数：输入目标条目 + 任务列表，输出 matrix。

### 6.7 最终交付

不要新增独立“发布”工具。交付条件是 Captain 向用户汇报前必须能从 status 看出：

- 所有必需 `requirements` / `implementation` / `verification` / `review` / `integration` 都是 `completed`。
- 所有 review `verdict=pass`。
- 没有未处理 `failed` 且没有对应 repair。
- 没有 `missing` coverage。
- 没有未入账越界路径。

可提供纯函数 `canDeclareDelivery(team): { ok: boolean; blockers: string[] }`。Captain 协议要求：`ok=false` 时不得向用户宣布完成。

## 7. 工具与事件

### 7.1 工具面

| 工具 | 行为 |
|---|---|
| `agent_teams_create_task` | 支持合同字段；halt 默认拒绝；质量 kind 强制合同；范围冲突拒绝 |
| `agent_teams_update_task` | 支持 verdict / findings / changedPaths / acceptanceResults / commandsRun；按 kind 拒绝非法 completed |
| `agent_teams_status` | 显示 kind、round、verdict、findings 摘要、coverage matrix、escalated、halt/resume；传 `task_id` 返回单个任务的合同、findings、修订账本与证据（只读，不消费收件箱） |
| `agent_teams_create` | profile 可带 `reviewPolicy`；快照到 `team.profile` / `team.reviewPolicy` |

### 7.2 补充工具

| 工具 | 作用 |
|---|---|
| `agent_teams_resume` | 显式恢复 halted 团队，必须带 reason |

不新增 `submit_review`：审查结论收进 `update_task`，避免工具膨胀。

### 7.3 事件

扩展现有事件，不要另起 event map 文件：

- `agent-teams/task-created` 增加 `kind?`、`round?`。
- `agent-teams/task-updated` 增加 `verdict?`、`round?`。
- 新增 `agent-teams/team-resumed`：`{ teamId, reason }`。
- 自动创建 repair/review 仍走 `task-created`。

`event-types.ts` 继续保持零运行时 import。

## 8. Prompt / 文档同步

改动门禁时必须同步：

- `src/index.ts` 的 usage protocol：补上合同、verdict、禁止依赖 failed、显式 resume、禁止自我批准。
- `src/members.ts` persona。
- `src/scheduler.ts` assignmentPrompt。
- `usage.md`。
- `README.md` / `README_ZH.md` 各加一小节，说明质量门禁存在，细节指向本文。

不要把本文全文贴进 usage prompt。prompt 只保留机器规则摘要。

## 9. 测试映射

每条机器规则至少有一条当前测试；全部通过 `pnpm verify` 运行：

| 规则 | 测试 |
|---|---|
| 合同创建、完成门禁、自动 repair / 复审 | `scripts/quality-gates-*.test.mjs`、`scripts/quality-gates-tdd.mjs` |
| 合同修订（amend）与修订后中继 | `scripts/quality-gates-amend.test.mjs`、`scripts/task-contract-visibility.test.mjs` |
| 状态投影的合同详情 | `scripts/task-contract-visibility.test.mjs` |
| 端到端生命周期 | `scripts/lifecycle-verify.mjs` |
| 稳定性与边界 | `scripts/stability-tdd.mjs`、`scripts/stress-verify.mjs` |

## 10. 明确不在本范围内

- Host 级 bash/fs 写入拦截：范围控制是完成时审计，不在写入时拦截。
- 独立 git worktree 隔离。
- 人类会签 / 投票组件。
- 自动部署。
- 一个 Captain 并行带多个团队。
- 修改官方 DeepSeek Harness 源码。
