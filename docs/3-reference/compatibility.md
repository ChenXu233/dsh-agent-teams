# 兼容性：一个下限，没有清单

> 读者：维护者（改声明、发版、回答"能不能装"）
> 状态：现行
> 事实源：[`compatibility.json`](../../compatibility.json)、[`scripts/compatibility.mjs`](../../scripts/compatibility.mjs)、[`scripts/doctor.mjs`](../../scripts/doctor.mjs)

`compatibility.json` 只声明一件事：`minimumHost`。

```json
{ "schemaVersion": 2, "previewTag": "next", "minimumHost": "0.2.1-rc.2" }
```

发布包里它被写成 `engines.dsh: ">=0.2.1-rc.2"`，所有 DSH peer 写 `*`（只用于列出由宿主提供的包名）。

## 为什么只声明下限

- **不枚举宿主，也不设上限。** 官方安装器从 0.2.1-alpha.4 起优先读 `engines.dsh`，0.1.7-rc.1 到 0.2.1-alpha.3 读 peer；两者都用 `semver.satisfies(..., { includePrerelease: true })`，因此下限之后发布的 RC、Alpha 和正式版都能安装，不需要插件跟着发版。
- **peer 必须写 `*`。** npm 校验 peer 时不带 `includePrerelease`：peer 写成 `>=0.2.1-rc.2` 会让 npm 在同一依赖树里拒绝 0.2.1-rc.3 这类已测宿主（`ERESOLVE`），而 `*` 直接放行；pnpm 与官方安装器不受影响。
- **枚举清单会坏。** 0.1.27 及以前把矩阵逐个写进 peer，宿主每发一个新 RC（rc.4、rc.5 成为 npm `latest` 时）插件就整体拒装，只能再发插件补救。

所以不要恢复这些写法：peer 范围、`engines.dsh` 列表、上限、`supportedHosts`、`recommendedHost`。它们只要出现在文件里，`pnpm verify` 的 compatibility 阶段就直接报错，而不是躺在文件里当"看起来还在维护清单"。

宿主真的破坏了插件依赖的接口时，应在运行时给出明确诊断（`harness-compat` 能力检测），而不是在安装时预先拒绝所有未测版本。

## 判定与观察

| 工具 | 输出 | 含义 |
| --- | --- | --- |
| `pnpm verify` → compatibility 阶段 | 开发基线必须不低于下限；`engines.dsh` 必须恰好等于 `>=${minimumHost}`；peer 全为 `*` | 声明自洽 |
| `scripts/doctor.mjs` | `declared-floor` / `newer-than-floor` / `unsupported` | 给定路径解析到的宿主能否安装；后两者都不是失败 |
| `pnpm check:upstream` | `blockedChannels` / `belowFloorChannels` / `declarationGap`，有差距时退出 1 | 已发布插件的声明是否拒装当前渠道；只读，不改声明、不安装、不发布 |
| `pnpm verify` → harness 阶段 | 下限宿主在 Ubuntu 与 Windows 上都通过 `plugin-manager-install` | 下限这一版被实测过 |

"下限已验证"与"这一版宿主被实测过"是两件事：高于下限的宿主默认可以安装，但只有 CI 真跑过的那一版有证据。

## 抬高下限

抬高下限是一次显式决定，不会因为 semver 落在宽范围内自动发生。一次改完：

1. 改 `compatibility.json` 的 `minimumHost`；
2. 同时改开发依赖与 `pnpm.overrides`；
3. 跑 `pnpm sync:compatibility` 重写 `engines.dsh`（它不会改开发基线，也不会修复混装）；
4. 更新受影响文档；
5. 跑完整 `pnpm verify`，再走一遍 [发布流程](../2-how-to/release.md)。

## 实测一个更高的宿主

不需要改任何文件：`verify.yml` 的手动触发输入 `host` 接受一个精确版本，工作流以 `DSH_TEST_HOSTS` 传给测试矩阵。这只产生一次性的实测证据，不改变声明的下限。

`sourceCandidates`（预计版本、官方源码完整 SHA、证据路径）只服务于 `harness-source-verify` 的源码验收，**不参与下限推导**：下限是声明的，不是从候选算出来的。
