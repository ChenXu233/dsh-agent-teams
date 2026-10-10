# #59 成员工具策略（tool policies）修复与真实宿主验收

- 日期：2026-10-10
- 分组 key：`policies`
- 基线 commit：`1e1c624fd2e909008aa5228a004706b3e4460670`
- 工作分支：`codex/issues-20261010-policies`
- issue：[#59 Feature proposal: reusable per-member tool policies (allow/deny)](https://github.com/NanmiCoder/dsh-agent-teams/issues/59)
- 范围：#59 的配置、解析、持久化与真实子会话/冷恢复验收；不含 UI 编辑器、OS 沙箱、per-turn 变更，#208 的第三方 n8n/Gemini 错误不在本组处理。

## 1. 原失败（修改前真实证据）

未修改的 `lib/`（committed 产物）在同一 profile 下跑真实 case：captain 用 `deepseek-account / deepseek-flash / max` 创建一个两队两任务的团队，
`researcher` 与 `implementer` 都没有策略可选。

| 观察点 | baseline 结果 |
| --- | --- |
| researcher 真实请求工具数 | 30，含 `write` / `bash` / `edit` |
| implementer 真实请求工具数 | 30，含 `write` / `bash` / `edit` |
| 宿主强制派发 `write`（以 researcher 身份，真实 `ctx.tools.execute`） | 成功，落盘 `forced-p1-researcher-write.txt` |
| 宿主强制派发 `bash` | 成功，落盘 `forced-p1-researcher-bash.txt` |
| 模型自主执行 | researcher 用 `read` 读文件并用 4 个协调工具汇报；implementer 用 `write`/`bash` 写出真实文件 |
| team.json | member 无任何策略字段 |

也就是说：除固定 captain deny 列表外，两种角色看到完全相同的全局工具集，owner 无法声明“researcher 只读、implementer 可写可执行”。

证据文件：`/private/tmp/agentteams-issues-20261010/policies/runs/baseline/phase1.json`、`phase2.json`、`probe.jsonl`、`host-phase*.log`。

## 2. 修复内容

| 文件 | 变更 |
| --- | --- |
| `src/tool-policies.ts`（新增） | `MemberToolPolicy` / `MemberToolFilter`；`normalizeToolPolicy`、`parseToolPolicies`（无原型字典）、`requireToolPolicy`（`Object.hasOwn`）、`resolveMemberToolFilter`、`BUILTIN_DENY_TOOLS` |
| `src/harness-compat.ts` | `memberToolFilter` 统一走解析器；`startMemberWithLenientFilter` 只允许放宽内置 captain/depth deny 名字，**绝不**删除 owner 策略名字、**绝不**删除 allow 名字 |
| `src/members.ts` | `spawnMember` 接收一个已解析过滤器并原样传给 `startContinuable({ toolFilter })`；只对策略成员持久化宿主实际接受后的过滤器快照 |
| `src/tools.ts` | `agent_teams_add_member.tool_policy`、内联 `plan` 成员 `tool_policy`、`edit_plan.tool_policy`、`status` 暴露 `tool_policy`、spawn 调用点 |
| `src/profiles.ts` | profile 成员行 `tool_policy` |
| `src/types.ts` | `TeamMember.toolPolicy` + `TeamMember.toolFilter` |
| `src/state.ts` | 持久边界校验：`toolPolicy` 必须是非空字符串，`toolFilter.allow/deny` 必须是非空字符串数组；legacy 无字段仍合法；错类型在读取时被拒绝（`invalid AgentTeams state`） |
| `src/index.ts` | `Config.toolPolicies`（allow-only / deny-only / both 三种组合均合法且空列表被拒）、挂载期校验、Web plan 路由透传、captain 使用说明 |
| `scripts/tool-policies.test.mjs`（新增） | 纯 resolver/helper 与持久边界测试 11 项 |
| `package.json` | 新增 `verify:tool-policies` 并接入 `pnpm verify` |
| `README.md` / `README_ZH.md` / `docs/usage.md` | 配置、选择方式、不变量与边界说明 |

不变量（与 issue 一致）：captain-only deny 永远生效且无法被 allow 重新打开；四个协调工具始终可用；allow 策略自动注入协调工具；生效 deny = 策略 deny ∪ captain deny；未配置策略的团队/成员保持原有工具集与记录结构。

### 主管 review 三点的处理

1. **lenient 过滤器语义**：`startMemberWithLenientFilter(start, filter, relaxableDeny = BUILTIN_DENY_TOOLS)`。只有内置 `CAPTAIN_TOOL_NAMES` + depth 名字（#163/#164 兼容路径）可被宿主 “unknown global tool” 报告删除；owner 策略声明的名字与任何 allow 名字一律不删，直接抛错；协调工具因此不可能被删掉。
   - 说明（诚实边界）：本 composiiton 里插件可读到的 registry view（captain 作用域 14 个名字）**不覆盖** agent-preset 平面（真实请求 40 个名字），因此无法在“持久化成员之前”用一个可靠的名单判定 owner 名字是否拼错。本实现保证的是：宿主拒绝该名字时子会话**不会**以另一个过滤器静默启动——成员保持未 spawn 状态，`spawnError` 记录宿主原文，不产生孤儿子会话，也不产生“声明 A 实际 B”的漂移。若要真正的持久化前名字校验，需要宿主提供可枚举子会话继承面的公开接口（现无）。
2. **持久字段校验**：见上表 `src/state.ts`；错误类型不会被静默接受，legacy 记录仍可读。
3. **原型安全**：策略表用 `Object.create(null)`，查表用 `Object.hasOwn`；`constructor` / `toString` / `__proto__` 都按普通 id 处理，未知 id 精确报错并列出已配置 id。

## 3. 原 case 重跑（candidate）

同一 profile、同一模型、同一工作区、同一提示词，唯一差别是 `lib/`（修复后）与 owner 配置：

```yaml
toolPolicies:
  researcher: { allow: [read, glob, grep] }
  deny-web:   { deny: [web_search, web_fetch] }
```

| 观察点 | baseline | candidate |
| --- | --- | --- |
| researcher 真实请求工具 | 30，含 write/bash | **8** = 4 协调工具 + `read`/`glob`/`grep`（无 write/bash/edit） |
| researcher 强制 `write` | 成功落盘 | **`UNKNOWN_TOOL: unknown tool "write"`，不落盘** |
| researcher 强制 `bash` | 成功落盘 | **`UNKNOWN_TOOL: unknown tool "bash"`，不落盘** |
| researcher 模型自主执行 | read + 协调工具 | read + claim/update/send_message（协调工具有效） |
| implementer（无策略） | 30 工具，真实写文件 | 30 工具，真实写文件（行为不变） |
| team.json | 无策略字段 | `toolPolicy: "researcher"` + 解析后的 `toolFilter`（allow 7 项 / deny 10 项 captain 工具） |

冷恢复：另起真实宿主进程（同一 `DSH_HOME`、同一工作区），重新挂载会话并由 captain 真实发消息唤醒两名成员（descriptor 冷恢复），随后：

- researcher 请求工具仍为 8，implementer 仍为 30（与重启前完全一致，无漂移）；
- 强制 `write`/`bash` 仍 `UNKNOWN_TOOL`；implementer 强制 `write` 仍成功落盘；
- `team.json` 的策略 id 与过滤器保持不变。

profile 路径（candidate 独有，baseline 无此配置键）：第二个 captain 会话用配置 profile `policy-demo` 建队，成员行 `tool_policy=researcher` / `tool_policy=deny-web`：

- `prof-researcher`：8 工具，强制 write `UNKNOWN_TOOL`，强制 `read` **成功执行**（allow 未误伤允许项）；
- `prof-implementer`：**28** 工具（30 − `web_search` − `web_fetch`），`write`/`bash` 仍可用，模型写出真实 `profile-note.txt`；
- 两个策略 id 与解析过滤器都写入 `team.json`。

`agent_teams_add_member` 路径（candidate 独有）：先建一个含 1 名成员/1 个任务的运行中团队，再由 captain 调 `agent_teams_add_member({name:"late-researcher", tool_policy:"researcher"})` 并追加任务：

- `late-researcher`：8 工具（4 协调工具 + `read`/`glob`/`grep`），强制 `write` `UNKNOWN_TOOL`，模型用 `read` 与协调工具完成任务；`team.json` 记录策略 id 与解析过滤器；
- `base-worker`（无策略）：30 工具，模型自己用 `write` 写出 `base-worker.txt`，强制 `write` 也成功落盘。

## 4. 运行环境与命令

- 官方 CLI / Loader：`node_modules/.bin/dsh --profile policies-real --port 3083 --no-open`（隔离 `DSH_HOME=/private/tmp/agentteams-issues-20261010/policies/dsh-home`，profile 组合 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + 本仓库 bundle）
- 宿主包：`@deepseek-ai/dsh`、`dsh-subagent`、`dsh-tools`、`dsh-agent`、`dsh-llm` 全部 `0.2.0-rc.2`（与 repo devDependencies 一致；baseline/candidate 同宿主同输入）
- 模型：`deepseek-account` / `deepseek-flash` / `reasoningEffort: max`（复用已有账号登录，`credentials.path` 指向现有认证存储；未配置、未读取、未输出任何密钥）
- 工作区：`/private/tmp/agentteams-issues-20261010/policies/runs/<case>/ws`
- 会话：baseline `session-0ee121ad-04fe-4791-bb46-f30c24a2e097`；candidate `session-88ebfabf-8ec2-4ac3-a6d0-bc2bd4dd3164`；candidate profile `session-be63f4fa-86ab-4683-9d71-731585048be3`
- 观测方式：真实 `llm/stream` 出站请求（模型实际收到的工具 schema）、真实 `tools/execute`/`tools/result`、真实 `ctx.tools.execute` 强制派发（成员在线时执行）、真实磁盘文件与 `team.json`。无 fake LLM、无 fake Context、无假响应、未手改团队状态。

命令与退出码（日志在 `/private/tmp/agentteams-issues-20261010/policies/logs/`）：

| 命令 | 退出码 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm build` | 0 |
| `pnpm typecheck` | 0 |
| `node --test scripts/tool-policies.test.mjs` | 0（11/11） |
| `node scripts/harness-compat-tdd.mjs` | 0 |
| `node --test scripts/member-spawn-recovery.test.mjs` | 0（10/10） |
| `node --test scripts/corrupt-teamjson.test.mjs` | 0 |
| `node --test scripts/capabilities.test.mjs` | 0（18/18） |
| `node scripts/verify.mjs` / `fallback-tdd.mjs` / `member-failure-tdd.mjs` | 0 |
| `node scripts/quality-gates-tdd.mjs` + repair-scope/amend tests | 0 |
| `node scripts/lifecycle-verify.mjs` / `stress-verify.mjs` / `issue-159.test.mjs` | 0 |
| `pnpm verify:release` / `verify:readme` / `verify:web-routes` / `verify:http-body` / `verify:skill` | 0 |
| `node drive.mjs phase1/phase2/phase-profile/compare`（baseline + candidate） | 0 |

## 5. 产物 hash（SHA-256）

| 产物 | SHA-256 |
| --- | --- |
| `lib/index.js` | `8cee164dfc338142f15dbc55ee3d06a1ed78724c677108b65ba77ae9e16cc0c7` |
| `lib/harness-compat.js` | `2e998ab7de99cf8805669de0907f0ff0de82f57856cfe241760e22ea7c4e4576` |
| `lib/tool-policies.js` | `def417433a172b5ff68b2b810fd54a6748ec86bcaa700209b11d2d5d17543a2b` |
| `lib/tools.js` | `b2be261507f69bbebfa04935ec61c63cb1752c6483160b6e0e81191fc5fcb8c1` |
| `lib/members.js` | `717f25f56e1e9d54b5e0e60e439d915913841d1e2496b80f8ce3733d3c6cab01` |
| `lib/state.js` | `dc4cafbeefaf4689256ed6a5c5efc940e866a86762270bc3bc6d6053eb25869b` |
| `lib/profiles.js` | `84c7795f92c5719177d9db03cce01042e076eda8a2c546c809f47a52c6bc0ae4` |
| 验收 harness `drive.mjs` | `7d788216d336ba9c529a2f7fda12044fa966fad95f3ecbf2d79d6a9ec4d85fbb` |
| 观测插件 `probe.mjs` | `034afee34d8ce825447fe1d12680d0cba8aa34a9e6e1cade090c7ac152d0235e` |
| baseline patch | `d4aa9d5e952e0ea7d5ca82f1365930f3d6d7a48d14345aca167527fdc71ba1c9` |
| candidate patch | `98ec5584eae7f6f3d063090ed7b7731fbfdc83ade45908ee3288bf0a4ea863e1` |
| `runs/baseline/phase1.json` | `4c3ba58f8a8fc8593dd345ca0182e01f5362963997ff7a82e3439e3716414a04` |
| `runs/baseline/phase2.json` | `60abce53177a425b93008621be793edc09de5a761859d2a055e296b2857c50b1` |
| `runs/candidate/phase1.json` | `139abef8da13556f5a3d68309a594c72bb0ba228d855e6e1927854e59c912b2c` |
| `runs/candidate/phase2.json` | `7c07c6ac77e5381385cccd8a8c3063600e4b5322fc773ad766b0c8b1ed639426` |
| `runs/candidate/phase-profile.json` | `2b88b173f1272bb6576f63b9deb612ccd8227f62788aaa6815ce50007ef8ab54` |
| `runs/candidate/phase-addmember.json` | `d3b4f638f0035b30de451313266c8ce8a48a92a3f28f82d906874cacc65cd3f3` |

大量日志保留在 `/private/tmp/agentteams-issues-20261010/policies/`，未写入仓库。

## 6. 未覆盖范围与已知限制

- 未做 UI：Settings / Activity Panel 没有策略编辑器；staged 计划的 Web 编辑器也不展示策略（模型工具与 profile 配置可用）。
- 未做 OS 级沙箱或授权边界；本能力只是全局工具的模型可见性与调用限制。
- 不支持 `toolFilter` 能力缺失的 subagent provider（沿用现有能力校验报错）。
- 无法在持久化成员前用宿主 registry 名单判定 owner 策略名字是否拼错（原因见 §2 第 1 点）；拼错时成员保持未 spawn、`spawnError` 记录宿主原文，需要 owner 修正配置后重试。
- agent-preset 平面中“子会话自身层”注册的委派工具（如 `subagent`）不受 allow 列表过滤（宿主语义：restriction 只过滤被继承的面），深度限制仍由插件父链守卫强制；这与 #163 以来的既有行为一致，本轮未改动。
- `agent_teams_edit_plan` 的 `update_member.tool_policy`（暂存期改选策略 / 空串清除）只有源码与纯测试覆盖，未跑真实模型 leg；Web 计划编辑器不发送该字段。
- 未跑 `pnpm verify` 全链路中的 harness-contract 多宿主矩阵（`--modern-harness`/`--delivery-harness`）与 git-install/source-runner 等与本改动无关的子系统；已跑与本改动直接相关的 TDD、状态边界与生命周期回归（见上表）。
- 未推送、未发布、未关闭 issue、未在 GitHub 评论；未合并回 main，等待主管独立核验。
