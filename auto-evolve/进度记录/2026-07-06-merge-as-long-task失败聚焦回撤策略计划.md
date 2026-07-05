# 2026-07-06 merge-as-long-task 失败聚焦回撤策略计划

## 目标

给 `merge-as-long-task` 的多 case 空白验收补一层“策略脑子”。注意：`single / sequence / parallel` 只是执行能力，决定怎么跑一批 case；本计划要补的是策略层，决定这一轮应该测哪些 case。

## 目标策略

每个 merge group 都维护自己的 replay 状态，规则如下：

1. **初始全量测试**
   - 第一次验收时，对当前 group 覆盖的全部 replay cases 做一次全量空白验收。
   - 如果全过，group 通过。
   - 如果有失败，记录：
     - `failedCaseIDs`：失败项。
     - `protectedCaseIDs`：本次已经通过的项。

2. **失败项聚焦测试**
   - 下一轮 skill 被 lead 修过以后，先只测 `failedCaseIDs`。
   - 如果仍有失败，继续记录剩余失败项，并把已经修好的项加入保护集。
   - 这一步不浪费成本重复测所有项。

3. **成功项防退化测试**
   - 如果失败项全部修好，立即回测 `protectedCaseIDs`。
   - 如果保护集也全过，说明“失败项修好了，之前成功项也没被修坏”，group 才通过。
   - 如果保护集出现失败，说明发生退化，把这些退化项变成新的 `failedCaseIDs`，下一轮继续聚焦修。

4. **分层合并适配**
   - 第一层 group 只覆盖自己的小组 cases，例如 25 个按 5 分组时，每组只管自己的 5 个。
   - 第二层及以后，group 的 replay plan 已经展开为它覆盖的全部原始 cases，因此同一策略自动适配 5 合 1、10 合 2、2 合 1 等情况。

## 实现位置

最小侵入方案：

- 不改 `runBlankEvalPlan` 执行器本身。它继续只负责 `single / sequence / parallel` 执行一批 case。
- 在 `validation-engine/long-task-adapter.ts` 的 `blank_eval_plan` validator 外层增加 replay policy。
- `create-merge-long-task-pack.ts` 生成的 `merged-skill-blank-eval-plan` validator 默认挂载该策略。

路径安全补强：

- `replayPolicy.statePath` 只能写在 `replay-plan.json` 所在目录内部。
- 如果配置成 `../outside.json` 或逃逸到任意绝对外部路径，系统必须在读写状态前直接失败。
- 这样可以防止手写 spec 把回撤策略状态写到任务包外面，避免污染宿主目录或其他实验。

## 状态保存

状态文件放在 replay plan 同目录下的稳定位置：

```text
materials/.blank-eval-replay-policy/<validator-id>.json
```

这样同一个 merge group 的下一轮 campaign final acceptance 能读到上一轮失败项，不会因为每轮 validatorDir 不同而丢状态。

## 本次不做

- 不改旧 `legacy_script` 合并链路。
- 不改单题 `runBlankEval`。
- 不改变 `parallel` 执行器语义。
- 不做数据库或 task lease。

## 验收

至少新增/扩展 smoke，覆盖：

- 初始全量失败后记录 failed/protected。
- 下一轮只测失败项，失败项全过后自动测 protected。
- protected 退化时转成新的 failed。
- 最终 failed 和 protected 都通过时整体通过。
