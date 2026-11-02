# 文档索引

这里按"读者读完要产出什么"分目录。人类入口是仓库根的 `README.md`；给 agent 的作业规则是 `AGENTS.md`。

| 目录 | 读者的问题 | 读完产出 |
| --- | --- | --- |
| [`1-tutorial/`](./1-tutorial/) | 我想从零写一个 DSH 插件 | 一个能加载、能验证的插件 |
| [`2-how-to/`](./2-how-to/) | 我要完成一件具体的事（发布、验证、同步、写文档） | 做完的任务 |
| [`3-reference/`](./3-reference/) | 我要查一个事实（工具、配置、兼容下限、质量门禁合同） | 查到的答案 |

`4-explanation/` 目前不存在：只在出现"为什么这样设计"的独立长文时才建。现在这类理由写在对应文档的第一节，不单独成文。

## 索引

| 我要… | 文档 | 类型 |
| --- | --- | --- |
| 从零开发一个 DSH 插件 | [build-a-plugin.md](./1-tutorial/build-a-plugin.md) | 教程 |
| 发布一个版本（含渠道、门禁、回滚） | [release.md](./2-how-to/release.md) | 操作 |
| 验证插件真的可用 | [verify.md](./2-how-to/verify.md) | 操作 |
| 把上游改动同步进这个 fork | [sync-upstream.md](./2-how-to/sync-upstream.md) | 操作 |
| 写 README 或文档 | [write-docs.md](./2-how-to/write-docs.md) | 操作 |
| 查兼容下限、为什么只有一个下限 | [compatibility.md](./3-reference/compatibility.md) | 参考 |
| 查工具、配置字段、已知限制 | [usage.md](./3-reference/usage.md) | 参考 |
| 查工具面与工具可见性规则 | [tool-surface.md](./3-reference/tool-surface.md) | 参考 |
| 查质量门禁的任务合同与状态机 | [quality-gates.md](./3-reference/quality-gates.md) | 参考 |

## 每个事实只有一个家

| 事实 | 唯一的家 |
| --- | --- |
| 兼容下限（安装门槛） | [`compatibility.json`](../compatibility.json)；解释在 [compatibility.md](./3-reference/compatibility.md) |
| 已发布版本与逐版变化 | [`release-notes/`](../release-notes/)，以及 npm / GitHub Release |
| 工具名、配置字段、默认值 | [usage.md](./3-reference/usage.md)，从 `src/` 抄录 |
| 验证命令与覆盖范围 | `pnpm verify` → [`scripts/verify-all.mjs`](../scripts/verify-all.mjs)；说明在 [verify.md](./2-how-to/verify.md) |
| 发布门禁、渠道与回滚 | [release.md](./2-how-to/release.md) 与 [`.github/workflows/`](../.github/workflows/) |
| 协作规则（怎么用这个插件） | 仓库根 [`README.md`](../README.md) 与 [usage.md](./3-reference/usage.md) |

其余文档提到这些事实时只留一句话加链接，不复制内容。

## 新知识放哪

- **结论**折进上表已有文档的某一节。默认答案是折进去，不是新建文件。
- **一次性取证**（审计输出、JSON 报告、截图、逐版本日志）留在 CI artifact、PR 讨论和 GitHub Release 里，不提交进仓库。
- **过期就删。** git 里有历史，不需要 `archive/` 目录，也不写"勘误""变更记录""以前是 X，现在是 Y"。文档只描述当前 HEAD。

## 文件约定

每份文档开头是一个引用块，写明读者、状态和事实来源：

```markdown
> 读者：维护者（发布）
> 状态：现行
> 事实源：`scripts/verify-all.mjs`、`.github/workflows/verify.yml`
```

不写日期和版本号：它们会随每次提交过期，git 已经记录了时间。
