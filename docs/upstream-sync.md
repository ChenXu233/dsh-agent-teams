# 上游同步（upstream sync）

本文说明如何把 `upstream/main`（NanmiCoder/dsh-agent-teams）同步进本 fork：哪些冲突会**自动解决**、哪些必须**人工判定**、怎么运行、怎么回滚。

## 先说结论：不能全自动

「以后都自动解决冲突」做不到。诚实的边界是：

| 层 | 对象 | 行为 | 人工参与 |
|---|---|---|---|
| 1 生成物 | `lib/**` | merge driver `built-artifacts` 自动取上游版本，之后 `pnpm build` 从源码重建 | 零（跑脚本即可） |
| 2 锁文件 | `pnpm-lock.yaml` | merge driver `lockfile-upstream` 自动取上游版本，之后 `pnpm install` 重新解析 | 零（跑脚本即可） |
| 3 重复冲突 | 任何文件 | `rerere.enabled + rerere.autoupdate`：同一处冲突第一次人工解过后，下次自动复用 | 第一次仍需人工 |
| 4 语义冲突 | `src/**` 等源码 | **绝不自动**。脚本停下，输出 hunk 级报告（文件 + 行号），由人逐块判定 | 必须人工 |

经验参考（2026-10 的 0.1.25 同步）：8 个冲突文件里 5 个是 `lib/**` 生成物（第 1 层），剩下的源码冲突里真正需要动脑的是 `src/members.ts` 与 `src/tools.ts`（上游重构 × 本地功能），`src/state.ts` 是机械相邻（两边 && 全留即可）。

## 运行方式

```sh
# 预演：隔离 worktree 里合并一遍，只输出冲突清单，不动主工作树
node scripts/sync-upstream.mjs --dry-run

# 正式同步：在接收上游的功能分支上执行（脚本拒绝在 main 上运行）
git checkout feat/<your-branch>
node scripts/sync-upstream.mjs
```

脚本内部顺序：

1. 幂等安装三层机械配置（`.gitattributes` 两条声明 + 两个 merge driver 的 `git config` + `rerere.enabled/autoupdate`）——重复运行只确认不重复写。**rerere 只对「下一次」合并起效**：在 rerere 开启之前解过的冲突不会被记住，脚本每次都会打印这条提示。
2. `git fetch upstream` 后合并 `upstream/main`。
3. `lib/**` 与 `pnpm-lock.yaml` 的冲突由 driver 自动取上游侧（驱动命令 `cp %B %A`，`%B` 即上游版本）；万一仍有残留，脚本按同侧显式 stage。
4. 源码语义冲突：脚本**停止**（退出码 1），打印每个冲突文件的 hunk 行号清单，合并保持**未提交**状态。人工逐块判定后：

```sh
git add <已解决的文件>
git commit            # 提交合并——脚本绝不代替你做这一步
pnpm install          # 锁文件取了上游后重新解析
pnpm build            # lib/** 重建（生成物以源码为准）
pnpm typecheck
node --test scripts/member-context-budget.test.mjs   # 计划回归
```

无冲突时脚本打印下一步提示后直接结束，同样**不会替你 commit**。

## 安全边界（脚本绝不做的事）

- 不 `git push`
- 不 `git reset --hard`
- 不删除任何分支（包括 `backup/*`）
- 不 commit 仍含冲突标记的树；不自动 commit 未完成的合并
- 拒绝在 `main` 上执行同步（只允许功能分支接收上游）

脚本只允许幂等写 git config 与工作树文件（`.gitattributes`）。源码见 [scripts/sync-upstream.mjs](../scripts/sync-upstream.mjs)。

## 回滚方式

- **预演（--dry-run）**：本来就不碰主工作树，无需回滚。
- **合并未提交**：`git merge --abort`，工作树回到合并前。
- **合并已提交**：`git reset --keep <合并前的提交>`（`--keep` 保留未跟踪文件；比 `--hard` 温和，且这是**人**的决定，脚本不会代做）。同步前先打安全分支：`git branch backup/pre-<label>`。
- **机制回滚**：删掉 `.gitattributes` 里两行并 `git config --unset merge.built-artifacts.driver && git config --unset merge.lockfile-upstream.driver` 即恢复原生合并行为；`rerere` 可用 `git config rerere.enabled false` 关闭。

## 首次克隆 / 新机器

clone 后跑一次 `node scripts/sync-upstream.mjs --dry-run` 即可：脚本会幂等写入两个 merge driver 的 git config（`.gitattributes` 随仓库走，driver 命令存于 git config 不随 clone 传播，必须由脚本或人写入）。rerere 同理。

## 分支纪律（2026-10-18 事故后新增）

**事故**：07d 在**共享分支**上做 merge driver 实验，临时提交时把 07c 尚未提交的测试文件（+31 行保真度用例）一起卷了进去，`reset --keep` 回退后该文件被抹掉。终验收时靠「实测 19 个用例 ≠ 报告里的 20 个」才发现，已从 `1893c7c` 恢复。**这类丢失不会报错，只会让保护悄悄消失。**

**规则**：
1. **成员不得对共享分支做 `reset` / `rebase` / `checkout` 级的历史重写**；分支指针只有队长能动。
2. 任何临时/实验性提交必须在**临时分支或临时 worktree** 上做——`scripts/sync-upstream.mjs --dry-run` 就是这么设计的，照它做。
3. **不得用 `git add -A` / `git commit -a`** 提交共享工作树：会把别人未提交的工作一起卷走。
4. 提交前逐项确认 `git status` 的清单，只 add 自己范围内的文件。
5. **报告里的数字要与实测一致**（用例数、文件数）；对不上先查再报——本次就是靠这条抓到的。
