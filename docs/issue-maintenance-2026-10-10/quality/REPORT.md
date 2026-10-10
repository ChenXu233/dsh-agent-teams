# 质量闭环修复报告 — #161 / #174 / #175 / #183

- 日期：2026-10-10（Asia/Shanghai，写盘时间以文件系统时间为准）
- Worktree：`/Users/nanmi/.codex/worktrees/issue-quality-loop/dsh-agent-teams`
- 分支：`codex/issues-20261010-quality`
- 基线 commit：`1e1c624fd2e909008aa5228a004706b3e4460670`
- 宿主：`@deepseek-ai/dsh@0.2.0-rc.2`（本仓库 devDependencies；`node_modules/.pnpm` 内 289 个 `@deepseek-ai/*` 包目录，与主管 4e55 worktree 的同一列表 `diff` 为空 → baseline/candidate 同宿主同依赖闭包）
- Node `v26.7.0`，pnpm `10.33.0`
- 模型路由：`deepseek-account` / `deepseek-flash` / `reasoningEffort=max`（复用既有账号登录；未配置、未读取、未输出任何 API key/token）

## 1. 结论速览

| Issue | 是否复现 | 是否修复 | 原 case 重跑 | 真实模型路径 |
| --- | --- | --- | --- | --- |
| #161 review pass 不绑定它审过的 revision | 是（baseline 真实盘改写后仍 `Delivery: ok`） | 是 | 12/12 通过 | 是（同一输入 baseline `Delivery: ok` vs candidate `Delivery: blocked`） |
| #174 自动生成的 repair 工单冻结在生成时刻 | 是（旧 API 无任何过期标记） | 是 | 18/18 通过 | 是（repair 轮写入真实 `contractSnapshot`） |
| #175 findings 因果链缺失 + verification 不自动修复 | 是（baseline 失败 verification 只留 `failed without a follow-up repair`） | 是 | 7/7 通过 | 是（candidate 自动生成 `repair + verification` 轮，baseline 只有 2 个任务） |
| #183 默认排除路径派生 repair 合同不可满足 | 是 | 是 | 5/5 通过 | 规则层覆盖（见 §7 未覆盖范围） |

测试与验收产物：

- 新增仓库回归（`node --test`，纯函数 + 真实临时磁盘）：`scripts/quality-gates-content-bound.test.mjs`、`scripts/quality-gates-work-order.test.mjs`、`scripts/quality-gates-repair-wiring.test.mjs`、`scripts/quality-gates-excluded-scope.test.mjs`
- baseline TAP（改 src 之前，全部 exit=1）：`/private/tmp/agentteams-issues-20261010/quality/evidence/baseline-{161,174,175,183}.tap`（分别 6/4/5/4 个 not ok）
- candidate TAP（rebuild 之后同一 case）：`.../candidate-{161,174,175,183}.tap`（0 not ok）
- 真实模型证据：`.../evidence/gate-{candidate,baseline}-requests.jsonl`、各 workspace 的 `.agent-teams/*/team.json`、`dsh-home{,-baseline}/sessions/**/session.v4.jsonl`、`panel-audit-check.mjs`
- 仓库整体回归：`pnpm verify` → 见 §6

## 2. 原始失败（baseline 实际行为，exit code 非 0）

改源码之前，用**当时已导出的 API**加**真实磁盘写入/改写/删除**构造 case，四个文件全部 exit=1：

- #161（`quality-gates-content-bound.test.mjs`，6 not ok）。原始现象：实现任务 `changedPaths: ['lib/stats.js','test/stats.test.js','package.json']`，review `verdict=pass`；随后真实改写 `lib/stats.js`、真实追加 `test/stats.test.js`、真实删除 `package.json`，`canDeclareDelivery(team)` 仍返回 `{"ok":true,"blockers":[]}`，`describeQualityLoop(team)` 仍返回 `{"state":"deliverable","deliverable":true,"summary":"All required work and quality gates passed. The captain may report delivery."}`。
- #174（`quality-gates-work-order.test.mjs`，4 not ok）。旧 API 生成的 repair 轮：acceptance 原样保留 `lib/stats.js:2` 行号锚点，任务无 `contractSnapshot`，改盘后 `describeQualityLoop` 没有任何过期提示。
- #175（`quality-gates-repair-wiring.test.mjs`，5 not ok）。失败 verification 的 `planQualityFollowUp` 返回 `created: []`；生成的 repair 没有到失败 gate 的因果记录；`canDeclareDelivery` 对已修复下游的 findings 报 `failed without a follow-up repair`。
- #183（`quality-gates-excluded-scope.test.mjs`，4 not ok）。`repairScopeFromFindings` 返回 `['src/secrets/redactor.ts','src/app/']`，而 `classifyChangedPath('src/secrets/redactor.ts', …)` 为 `out_of_scope` → 合同不可满足。

（此前一版 case 依赖“新模块不存在”，主管指出不能算原故障复现；上表已全部改为旧 API + 真实盘行为证据，同一输入两侧可跑。）

## 3. 修复内容

### #161 内容绑定 verdict（src/artifacts.ts、src/workspace-audit.ts、src/quality-gates.ts、src/tools.ts、src/scheduler.ts、src/snapshot.ts）

1. **记录被判定的 revision**：review/requirements/verification 在 claim 时由 scheduler 写入 `verdictStartSnapshot`（真实 sha256/size/mtime）；close 时 `bindClosingVerdict` 读当前 scope，比较 claim 快照得到 `reviewedDuringDrift`，并写入 `reviewedTaskId`/`reviewedAttempt`/`reviewedArtifacts`/`reviewedScope`/`reviewedGaps`。评审期间被别人改文件 → verdict 不能声称绑定稳定 revision（blocker，除非被更晚的 sound verdict 覆盖）。
2. **交付按当前字节判定**：`canDeclareDelivery(team, audit)` / `describeQualityLoop(team, audit)` 新增可选 `audit`（纯函数不读盘，由调用方传入当前字节）。`src/workspace-audit.ts` 的 `auditTeamWorkspace` 是**唯一**读盘入口。
3. **多表面一致**：`agent_teams_status`（含 `Gate warnings` 段）与 Web 活动面板路由 `/plugins/dsh-agent-teams/state`（`TeamActivitySnapshot.delivery`/`loopState`/`deliverable` + 每任务 `verdictStale`，客户端面板以 `data-verdict-stale` 虚线告警渲染，不再显示裸 pass）都走同一个 audit。
4. **收敛而非永久阻塞**：被后续合法 repair + 新 pass 覆盖的历史 pass 只报 warning（`superseded by <id>`）；只是 intermediate 的 verification 漂移同样是 warning。
5. **边界显式化**：broad scope 下新出现的文件若从未被审 → blocker（`appeared under the reviewed scope … never reviewed`）；review 时不可读 → `reviewedGaps` → blocker；pre-fix 历史记录没有绑定 → 明确 warning「无法确认当前字节」，不冒充已审核；当前 audit 自身不完整（超 cap / 不可读 / 非法 scope）→ blocker。

### #174 工单快照 + 过期标记（src/quality-gates.ts、src/tools.ts、src/scheduler.ts）

- 生成的 repair 记录 `contractSnapshot`（对 `contractPaths` 真实读盘），`contractStaleness`/`workOrderWarnings` 在文件被改/删/新建后报出「工单生成时是另一个工作区」；`agent_teams_status` 与派发 prompt（`assignmentPrompt(..., workOrderWarnings)`）都会带出该警告，成员被要求按内容锚点定位、目标不存在就报 blocker。
- 生成的 acceptance 用 `stripLineAnchors` 去掉 `file:12` / `file:503-505` 这类必然漂移的行号；描述里明确写「插件没有核实 finding 的断言（目标数量、符号是否仍存在、产品是否支持该操作）」。

### #175 因果链与 verification 自动修复（src/quality-gates.ts、src/tools.ts、src/types.ts）

- 失败 `verification` 与失败 `review` 走同一套 findings → repair → re-check 循环：生成 `repair` + **同类 re-check**（verification 失败生成 `verification-round-N`），acceptance 由该任务真实失败证据（failed acceptanceResults / commandsRun）派生。
- 因果关系记录在**专用字段** `findingSourceTaskIds`，而不是 `dependencies`：`unsatisfiedDependencies` 只接受 `completed` 依赖，失败任务永远不满足 → 把失败 gate 写进 dependencies 会让 repair 永久无法被 claim（已用 `unsatisfiedDependencies` 直接证明，见 `quality-gates-repair-wiring.test.mjs`）。这偏离 issue 建议的字面做法，理由与证据见 §7。
- `canDeclareDelivery` 识别四种「已闭环」联系方式（source、dependency 边、`findingSourceTaskIds`、`sourceFindingIds` 交集），不再对已修复/已复验的 findings 报假 `failed without a follow-up repair`；escalated 摘要额外列出「真正未解决的 gate」。

### #183 合同生成与完成门禁一致（src/quality-gates.ts）

- `repairScopeFromFindings` 剔除 `isDefaultExcludedPath` 命中的路径（谓词导出一份，门禁与派生共用）；全部路径都被排除的 finding 不再生成不可满足的 repair 轮，而是 escalation 并给出原因与 finding id（`planQualityFollowUp().reason`/`excludedFindings`，同时写入 captain 邮箱）。部分排除时只保留合法目标，acceptance/sourceFindingIds 同步收窄。
- 门禁侧语义零改动：`classifyChangedPath` 仍先判默认排除（`secrets/` 段、`.env*`、`.git`、`.dsh`、**`.agent-teams`**、`id_rsa*`）。

## 4. 原 case 重跑（candidate）

```
node --test --test-reporter=tap scripts/quality-gates-content-bound.test.mjs   -> EXIT=0  pass 12 fail 0
node --test --test-reporter=tap scripts/quality-gates-work-order.test.mjs      -> EXIT=0  pass 18 fail 0
node --test --test-reporter=tap scripts/quality-gates-repair-wiring.test.mjs   -> EXIT=0  pass  7 fail 0
node --test --test-reporter=tap scripts/quality-gates-excluded-scope.test.mjs  -> EXIT=0  pass  5 fail 0
pnpm typecheck                                                                -> EXIT=0
```

补充的真实文件/目录/symlink/cap case（均在上述文件内，非 mock）：

- 48 MiB 真实文件：sha256 与独立分块参考值一致，堆增长 < 16 MiB（`inspectPath` 改为 64 KiB 定长块流式 `openSync`/`readSync`/`hash.update`，常量内存，不再整文件读入）。
- 目录 symlink 逃逸 + symlink 成环：遍历不跟随（`readdirSync` dirent 判定）、显式路径用 `realpath` containment 校验，越界/不可解析记 `unreadable` 并说明原因。
- 非法 scope（`../`、`/etc/`、`~/…`、`C:\…`）：报 gap，绝不退化成整个 workspace。
- cap：`MAX_EXPANDED_ARTIFACTS=200` 被触发时产生 gap；**当前** audit 的 gap 会 block delivery（199 → 225 文件的真实增长 case，走 production 的 `auditTeamWorkspace`）。
- 权限：`chmod 000` 的文件记为 `unreadable`（≠ absent），当前 audit 因此不完整 → block。
- 缺失路径：生成时 `present:false`，之后真实创建 → drift。
- broad scope：`./` 展开不含 `secrets/`、`.env*`、`.agent-teams/`、`.git/`。

## 5. 真实 DeepSeek Flash 验收（官方 CLI + 真实磁盘工作区 + 真实团队）

隔离 profile：`/private/tmp/agentteams-issues-20261010/quality/dsh-home{,-baseline}/profiles/gate/`（`package.json` 带 name+version；`credentials.path` 指向既有认证存储，无任何 key/apiKeyEnv；`llm-pi-ai`/`llm-deepseek` disabled；`agent-default-model=deepseek-account/deepseek-flash/max`）。候选侧 plugin 软链到本 worktree，基线侧软链到 `git archive 1e1c624` 解出的产物（无 `lib/artifacts.js`）。观测插件 `observer.mjs` 只记录/校验请求路由并在非 `deepseek-account/deepseek-flash` 时抛错，不产生任何模型响应或团队状态。

| 场景 | 同输入 | baseline（1e1c624） | candidate |
| --- | --- | --- | --- |
| S-A：implementation → review(pass)，随后**外部真实改写** `lib/sum.js`（`53f09f70…` → `af01ed6d…`） | 相同 prompt、相同 `test/sum.test.js`（sha `a66af1e0…`）、相同 profile/宿主 | `Delivery: ok`；`Loop: deliverable — All required work and quality gates passed. The captain may report delivery.`；全程未提任何 hash（sha 提及 0 次） | 改写前 `Delivery: ok`；改写后 `Delivery: blocked (t2 (review) verdict covers a revision that no longer exists: lib/sum.js changed (sha256 53f09f70 -> af01ed6d) — re-review the current bytes…)`；`Loop: blocked` |
| S-B2：verification 真实失败（声明的 `node --test test/contract.test.js` 不存在，exit 1） | 相同 prompt/工作区 | 2 个任务；`Delivery: blocked (t2 failed without a follow-up repair; completed implementation has no passing review)`；**无**自动 repair | 4 个任务；自动生成 `t3 repair r2 fixes t2` + `t4 verification r2`（`t3` 带真实 `contractSnapshot`），status 逐字含 `t3 [failed] repair r2 fixes t2 … (deps: t1)`、`t4 [pending] verification r2 … (deps: t3)` |

- 请求路由证据：candidate 124 次、baseline 71 次 `llm/stream`，**全部**为 `('deepseek-account','deepseek-flash')`（观测插件对其它路由直接抛错）。
- 活动面板/Web API 证据：`panel-audit-check.mjs` 用**真实 workspace + 真实 team.json**调用插件自己的 `collectTeamsActivity`，返回 `deliverable:false`、`loopState:"blocked"`、`delivery.blockers` 与 status 完全同一句，并对 `t2` 标出 `verdictStale`。
- 运行时长以真实时间计：S-A candidate 约 2 分钟 / 32 次请求；S-A baseline 约 2 分钟；S-B2 candidate 约 4 分钟；S-B2 baseline 约 3 分钟。

## 6. 仓库回归

- `pnpm verify`（完整 gate）→ EXIT=0（含 `verify:quality-gates`、`lifecycle-verify`、`stability-tdd`、`harness-compat-tdd`、`verify:corrupt-state`、`verify:web-routes`、`verify:release`、`verify:readme`、`verify:harness-contract`、`verify:compatibility` 等）
- 单独复核（日志在 `.../evidence/`）：`quality-gates-tdd.mjs` EXIT=0、`quality-gates-repair-scope.test.mjs`+`quality-gates-amend.test.mjs` 17/17、`issue-159.test.mjs` 9/9、`workspace-activity`/`corrupt-teamjson`/`capabilities`/`http-body` 全通过、`fallback-tdd`/`member-failure-tdd`/`stress-verify` EXIT=0。
- 既有断言 `tdd.loop.repair-depends-on-source-not-failed-review`（repair 依赖 source、**不**依赖失败 review）保持通过 —— 这正是 §175 采用专用因果字段而不是 dependencies 的原因。

## 7. 未覆盖范围与已知限制

1. **#183 没有真实模型路径**。规则层（派生 scope 与门禁一致性、全排除 finding 的 escalation）由纯函数 + 真实临时磁盘 case 覆盖；未构造“真实 reviewer 在 `src/secrets/…` 上开 finding”的模型运行。门禁谓词唯一化（`isDefaultExcludedPath` 同源）是这部分的关键保证，但真实模型下的 finding 生成路径未跑。
2. **#175 字面建议未照做**：把失败 gate 写进 `dependencies` 会让 repair 因 `unsatisfiedDependencies`（只认 `completed`）永久不可 claim。改为 `findingSourceTaskIds` 专用因果边 + 四种闭环识别；`planQualityFollowUp` 的 verification 分支依赖“失败任务自身证据”派生 acceptance。
3. **pre-fix 历史记录**（没有 `reviewedArtifacts`）：只能靠 `changedPaths` 的 mtime 判定“晚于 verdict 的写入”，以及“changedPath 已消失且无 digest 可确认”这类保守判定；无法区分“review 通过时文件就已缺失”。两处都会走 blocker，随后被后续 sound verdict 覆盖为 warning。
4. **mtime 规则有 1 ms 容差**（mtime 亚毫秒精度 vs 任务戳整毫秒）。同一毫秒内的写入不判漂移；内容 digest 判定无此问题。
5. **hard link 无法识别**：workspace 内指向外部 inode 的硬链接与普通文件不可区分（symlink 已处理）。
6. **大 scope 会被 block 而不是静默通过**：`inScope` 写成目录（如 `src/`）且文件数超过 200 时，verdict 只绑定前 200 个并带 `reviewedGaps`，当前 audit 也会带 gap → delivery 被 block，需 captain 收窄 inScope 或重审。这是按主管要求「cap 不能静默」的取舍。
7. **失败的 repair 会让其后 re-check 永久 pending**（S-B2 真实运行观察到：`t3 repair failed` → `t4 verification r2` 依赖永不满足）。交付面如实报 `t3 failed without a follow-up repair` + `t4 (verification) is not completed`，captain 可用 `agent_teams_amend_task`/重派介入；这是既有循环语义，本组未改（不属四个 issue 范围），已在报告中记录为后续观察项。
8. 客户端面板改动仅验证到「构建产物包含 `data-verdict-stale`」+「服务端 payload 带 `verdictStale`」；未在浏览器中截图确认视觉样式（运行中的 3081 GUI 加载的是主管 worktree 的插件产物，非本分支）。

## 8. 产物与提交

- 源码/构建产物本地提交见 `result.json` 的 `commit` 字段；未推送、未发布、未关闭 issue、未在 GitHub 评论、未合并回 main（由主管独立核验后合并）。
- 大量日志保留在 `/private/tmp/agentteams-issues-20261010/quality/`（`evidence/`、`ws/`、`dsh-home*/`、`plugin-baseline/`），未写入仓库。
