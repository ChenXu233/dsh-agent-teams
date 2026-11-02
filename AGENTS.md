# AgentTeams 仓库作业规则

> 读者：在本仓库动手的 agent
> 状态：现行
> 事实源：代码、`scripts/`、`.github/workflows/`。人类入口是 [README.md](./README.md)，文档索引是 [docs/README.md](./docs/README.md)

## 这份文件本身怎么改

| # | 元规则 | 怎么算遵守 |
| --- | --- | --- |
| M1 | 加规则要维护者同意 | 在对话里说明不加会出什么错，批准后才写 |
| M2 | 只写"不看就不知道"的稳定事实 | 能从代码、`package.json`、git 推出的不写；版本号、行数、当前进度不写 |
| M3 | 每条规则可判 | 写得出"怎么算遵守"。可判不等于要写脚本，更不等于要加门禁 |
| M4 | 同一条规则只写一处 | 别处只留指针 |
| M5 | 规则失效就删 | 不写"以前要求过""曾一度" |

要做成检查器之前先问两句：**能被绕过吗？抓到过真问题吗？** 靠自觉执行的检查只约束愿意遵守的人，绕过一次代价为零；大量运行里零检出也抓不到绕过的检查，只是给守规矩的人加税。两条都不成立就删掉，或者写成人读的判据。

## 每个事实只有一个家

完整表在 [docs/README.md](./docs/README.md#每个事实只有一个家)。最常踩的四条：

| 事实 | 家 |
| --- | --- |
| 兼容下限、安装门槛 | [`compatibility.json`](./compatibility.json)；解释在 [compatibility.md](./docs/3-reference/compatibility.md) |
| 工具名、参数、配置默认值 | [usage.md](./docs/3-reference/usage.md)，从 `src/` 抄录 |
| 验证阶段与覆盖范围 | [`scripts/verify-all.mjs`](./scripts/verify-all.mjs)；说明在 [verify.md](./docs/2-how-to/verify.md) |
| 已发布版本与逐版变化 | [`release-notes/`](./release-notes/) |

其他文档提到这些只留一句话加链接，不复制内容。

## 代码、文档、issue 各回答什么

- **代码**回答现在实际是什么。
- **文档**回答我们约定的契约是什么、为什么这样选。
- **issue / PR**回答要变成什么。

三者不一致时不要默认哪一方正确：先判断是文档过期、代码违约，还是意图本来就没落地，再决定改哪一边。发现文档写错就直接覆盖成对的，不写"勘误""以前是 X，现在是 Y"。

## 改完代码同步哪里

| 改了什么 | 同步到 |
| --- | --- |
| 工具、参数、配置字段 | [usage.md](./docs/3-reference/usage.md)；[README.md](./README.md) 的工具与配置摘要 |
| `compatibility.json` 或 `engines.dsh` | [compatibility.md](./docs/3-reference/compatibility.md)，其余文档只留链接 |
| `scripts/verify-all.mjs` 的阶段 | [verify.md](./docs/2-how-to/verify.md) |
| `.github/workflows/` | [release.md](./docs/2-how-to/release.md) |
| 用户可见的行为变化 | 下一个 `release-notes/v<版本>.md`，发版时写，不提前建 |

## 外部事实必须回读

宿主版本、npm 产物、dist-tag、依赖闭包、上游 skill 的版本示例：每次回读 registry、精确 tag 或安装结果。文档和 skill 里的历史版本号是线索，不是结论；`skills/` 下的上游资料尤其如此。

## 文档规则

- **只描述 HEAD。** 过期就删，git 里有历史：不建 `docs/archive/`，不留"已废弃"标记。
- **新结论折进已有文档的某一节。** 默认答案不是新建文件；一次性取证（审计输出、JSON、截图）留在 CI artifact、PR 讨论或 GitHub Release 里。
- **相对链接必须能解析。** 移动或删除文档时，同一次提交里改掉所有入链。
- **语言**：面向用户与维护者的文档用中文，命令、标识符、字段名保留英文。

## 项目既有约定

- 用 DSH 生命周期 skill 之前先读 [`skills/README.md`](./skills/README.md)：项目副本优先于同名全局 skill，上游示例的版本结论不适用。
- 交互式浏览器自动化用 Ego Lite 的 `ego-browser` skill，不用 `agent-browser`。
- 用户已经授权的动作不重复确认。
