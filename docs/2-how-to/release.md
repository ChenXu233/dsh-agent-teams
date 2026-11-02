# 维护与发布

> 读者：维护者（从报告到发布）
> 状态：现行
> 事实源：[`scripts/verify-all.mjs`](../../scripts/verify-all.mjs)、[`.github/workflows/`](../../.github/workflows/)、[`scripts/release-metadata.mjs`](../../scripts/release-metadata.mjs)

这套流程将社区 skills 用于真实仓库维护：记录问题和精确版本，审查贡献，实现与验证，再发布已经验收的同一份产物。先读 [skills/README.md](../../skills/README.md)；上游 skill 的旧版本示例不覆盖本项目政策，已获用户授权的工作不重复确认。

## 兼容性

发布包声明一个安装下限，不枚举宿主、不设上限。声明本身、为什么这样写、以及抬高下限的步骤都在[兼容性参考](../3-reference/compatibility.md)；这一节只说发版时要跨过的门。

- `pnpm verify` 的 compatibility 阶段必须通过；
- CI 默认矩阵就是下限本身：Ubuntu 与 Windows 各一个目标，每个都必须通过真实 `plugin-manager-install`；
- 要实测一个更高的宿主，用 `verify.yml` 手动触发的 `host` 输入，不改声明也不改 YAML；
- Desktop 用户还要核对桌面内核版本和实际 profile：装一个全局新 CLI 不会更换桌面内核。

旧的 `0.1.x` 宿主已退出支持。恢复旧组合时两端都要固定，不要只更新一端：

```sh
dsh plugin --profile web add --save-exact @chenxu233/dsh-agent-teams@<旧版本>
```

## 从报告到实现

1. 用 `plugin-workflow` 记录所选维护阶段；通过 `plugin-runtime-debug` 确认实际加载路径、profile 和失败服务。保留未修改的报错与最小复现。
2. 版本迁移使用 `plugin-upgrade` 的扫描与 `dsh-upgrade-audit` 的精确官方源码/产物对比。检查生命周期、消息、事件与会话、模型、客户端、鉴权和发布依赖；版本卡零命中不等于没有风险。
3. 按当前 PR head 审查，不以标题、旧测试记录或 GitHub 的无冲突状态代替证据。独立贡献分别验证；重叠的生命周期修复统一到适配边界，再将采用的代码和用例回链到贡献者 PR。
4. 用 `plugin-test` 选择相应测试。核心能力缺失必须得到清楚诊断，不能把失败上报、模型选择或投递静默变成 no-op。已修复的输入校验、staged 审批和权限限制必须保留。
5. 保留每位作者的署名；改写或合成补丁时记录原 PR 和相应贡献，适用时使用 `Co-authored-by`。未采用部分应说明具体原因和下一步，而不是笼统关闭为“不兼容”。

只读安装诊断可以从源码或发布包运行：

```sh
node scripts/doctor.mjs \
  --host-root "/actual/path/to/the/running/dsh/package" \
  --profile-root "/actual/path/to/the/profile" \
  --json
```

doctor 检查给定路径解析到的包版本、混装和重复身份，不执行插件、不修改配置，也不能自动证明该路径就是正在运行的进程。它的成功结果不是模型、UI 或任务完成的证明。

## 从源码安装与测试 Alpha

在插件 checkout 中构建同一份待验收产物：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm verify
pnpm pack --out ./agent-teams-candidate.tgz
```

准备一个已配置 Web 入口的独立测试 profile（以下为 `agent-teams-preview`），检查实际宿主后安装：

```sh
node scripts/doctor.mjs --host-root "/actual/host/package/directory" --json
dsh plugin --profile agent-teams-preview add --save-exact /absolute/path/agent-teams-candidate.tgz
node scripts/doctor.mjs --host-root "/actual/host/package/directory" --profile-root "/actual/test/profile/directory" --json
dsh --profile agent-teams-preview --dump-config
dsh --profile agent-teams-preview
```

源码更改后需要重新构建、打包和重启。`doctor` 通过不替代建队、任务与 UI 验收。

Alpha 测试必须锁定整组宿主依赖；`^0.1.2-alpha.2` 不表示只接受 Alpha.2，精确 CLI 版本的间接依赖仍可能解析到 rc.1。本仓库使用精确开发依赖、整组 `pnpm.overrides` 和 frozen lockfile。以下命令创建独立临时安装、profile 和工作区，安装同一份 tgz 并核对解析结果：

```sh
node scripts/harness-runtime-verify.mjs \
  --host-version 0.1.2-alpha.2 \
  --artifact ./agent-teams-candidate.tgz \
  --report-dir /tmp/agent-teams-alpha2-check
```

该命令会下载宿主，使用固定模型响应和真实 CLI、插件、会话、工具与子代理，不修改已有用户 profile。升级时保留已验证的锁文件；不要通过删除凭据或 `.agent-teams` 处理版本错配。

历史 `0.1.0-rc.8` + 插件 `0.1.14` 组合需固定两端。

## CI 的可检查证据

[verify.yml](../../.github/workflows/verify.yml) 同时用于 PR、main 和发布前的可复用工作流：

| 阶段 | 实际检查 | 留下的证据 |
| --- | --- | --- |
| Ubuntu / Windows 静态检查 | Node 24、pnpm 10.33.0、frozen lockfile、typecheck、build、verify | 两个平台各自的任务日志 |
| Ubuntu 打包 | `pnpm pack --out` 生成真实 tgz，只生成一份候选 | `agent-teams-candidate` artifact 与文件 SHA-256 |
| 真实宿主（默认下限，可加一个指定版本） | 由 `DSH_TEST_HOSTS` 生成 matrix，每个宿主安装同一 tgz、检查闭包并运行产品入口 | 各宿主 `result.json`、闭包清单、fixture traces 与 stdout/stderr |
| 汇总门禁 | 所有任务成功；每份报告的宿主、插件版本、摘要与候选一致 | `Complete compatibility gate` |

runner 为 `scripts/harness-runtime-verify.mjs --host-version <exact> --artifact <tgz> --report-dir <directory>`。模型适配器使用可重复 fixture，宿主 CLI、profile、插件、工具、子代理和会话是真实实现。当前运行十个场景：正常生命周期及冷恢复、fallback 及冷恢复、最终失败、队长 idle 唤醒、渐进入口、Web 审批、协议兼容和稳定性。测试同时检查队员执行、忙/闲消息、顺序和推理力度；改变这些能力时需增加会准确变红的场景。

CI 仅上传报告、日志和 fixture 状态，不上传 runtime 的 node_modules、缓存、隔离 HOME 或整份 profile 存储。报告保留 14 天；发布维护者应将关键版本、摘要、结果和限制归档到发布记录，不能只留下会过期的临时目录。

当前自动矩阵只有下限宿主 `0.2.1-rc.2` 的 Ubuntu 与 Windows 两个目标；需要覆盖新宿主时用 `workflow_dispatch` 的 `host` 输入显式指定。真实模型 API、原生 Desktop 交互和用户数据迁移仍需要额外证据。UI 改动按 Ego Lite 规则验证真实宿主挂载和交互；有凭据的 provider 验证记录结果，不在仓库保存凭据。跳过、不适用和失败应分别记录，不能统一写“全部通过”。

## 发布同一份验收产物

[publish.yml](../../.github/workflows/publish.yml) 必须等待整个 `verify` 可复用工作流成功。发布 job 下载该 run 的候选 tgz，重新核验 SHA-256、版本和完整宿主清单，再通过现有 npm OIDC trusted publishing 发布该文件；发布 job 不重新构建，也不以 `pack --dry-run` 作为门禁。

- 新的预发布插件版本（alpha / beta / rc）首次发布进入项目的 `next` 渠道；已验收的 RC 产物可经维护者明确决定，用 `npm dist-tag add` 将同一不可变版本提升为 `latest`，不重新打包。
- 无后缀插件首次发布及 RC 产物提升到 `latest` 时，开发基线必须不低于下限且不能是 alpha/beta 宿主（`publish.yml` 检查），下限宿主必须出现在本次验证里。不得把只在 Alpha 宿主上通过的包提升为普通用户默认版本。
- 发版 tag 必须等于 `v<package.version>`，GitHub prerelease 标志与插件版本后缀一致；将 RC 提升到 npm `latest` 不会改变其 GitHub 预发布身份。稳定发布前查询 npm 当前 latest，拒绝倒退。
- 准备 PR、版本或产物不表示已经发布。发布后读取 registry 的版本、integrity 与 dist-tag，并从 registry 再安装精确版本做消费者复验，记录与候选是否一致。
- **已发布不等于桌面端 npm 入口已就绪。** 桌面端实际观察到 pnpm 11.28.5；默认 `minimumReleaseAge=1440` 分钟可能把 `@latest` 解析为旧版。精确版本、tgz 和 pnpm 10 的成功不能代替这个入口。CI 在 Ubuntu/Windows 用真实 pnpm 11 和临时 registry 验证“新发布回退旧版 / 满等待期选择新版 / registry 错误不能报成功”。
- 正式发布后用 `node scripts/check-install-channel.mjs --pnpm-cli <pnpm-11.28.5/bin/pnpm.mjs> --registry https://registry.npmjs.org --expected-version <本次版本>` 检查默认等待期下实际选择；大陆镜像再跑一次。返回 1 表示选择的版本不是本次发布，不能宣称 npm 桌面安装已就绪；网络或工具异常同样不能算通过。该探针只验证包管理器解析，实际宿主加载仍由 runtime/桌面验证承担。
- 首日 npm 渠道未就绪时，在 Release 中明确状态，提供已验收的 `github:NanmiCoder/dsh-agent-teams` 入口（需要 GitHub 网络），或等待 npm 版本满 24 小时。不要让用户逐次改版本例外，也不要关闭全局等待期或兼容检查。插件还没安装时无法替宿主改变这些策略。
- 回退分别处理 npm dist-tag、用户 profile/锁文件和数据；保留不可变版本及 Git 历史。不通过删除或重指向 Git tag 来冒充 npm 回滚。

当前 GitHub workflow 的 OIDC 写权限只授予 publish job；PR 和验收任务仅有仓库读取权限，无须真实模型密钥。新增的 GitHub artifact actions 固定到已审阅的 commit：upload `ea165f8d65b6e75b540449e92b4886f43607fa02`、download `d3f86a106a0bac45b974a628896c90dbdf5c8093`。下载 action 对摘要不符只发 warning，因此本工作流另外对候选文件做强制 SHA-256 校验。

## Issue 与 PR 的结束条件

每次跟进分别写清：

| 状态 | 必须能够链接的事实 |
| --- | --- |
| 已合并 | 当前 main 的 commit/PR；不暗示 npm 已更新 |
| 已发布 | 精确插件版本、npm 渠道与发布产物 |
| 已验证 | 精确宿主/插件/平台/profile、运行结果和未覆盖范围 |

已复现故障在对应修复与验收完成后关闭；若要等发布，明确说明仍在等待发布。重复报告可以关闭并指向主跟踪，但保留其独有平台或触发步骤。功能提议、证据不足和外部邀请分别处理，不能将所有“版本相关”问题批量标成 resolved。#125 的 claim/dispatch、#106 的请求上限和资源/并发问题各有独立行为边界，不会因为宿主能启动就自动消失。
