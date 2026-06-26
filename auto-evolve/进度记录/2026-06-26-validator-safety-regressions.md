# 2026-06-26 Validator 安全回归修复

本次修复的是 4 个验证基础设施问题，目标是避免长程任务因为验证器误判继续烧轮次。

## 1. Script Validator 进程硬门

修复前：

- 脚本进程 `exitCode != 0` 或 timeout。
- 但 stdout/stderr 里只要出现 `{"passed": true}`，系统仍可能判通过。

修复后：

- 第一层先看基础设施：没有 timeout，且退出码在 `successExitCodes` 内。
- 第二层才看业务 JSON：`passed/ok/success`。
- 只要进程失败或 timeout，无论 JSON 写什么都失败，`failureKind = validator_infrastructure`。

## 2. Private Answer 多格式推断

修复前：

- prompt validator 只会自动找 `private-answers/<id>/answer.md`。
- candidate fallback 过粗，可能把 `human-guidance.md` 或 context 当成候选产物。

修复后：

- private answer 自动兼容 `answer.md`、`answer.json`、`answer.txt`。
- candidate 推断会排除 `private-answers`、`human-guidance`、`context`。
- `workspace/answer.txt`、`workspace/answer.json`、`plan.json` 等候选会按优先级选择。

## 3. Fallback Graph Validator 分阶段

修复前：

- fallback graph 把所有 required validator 都塞进 `completionValidatorIDs`。
- 普通 unit validator 可能又在 work-unit 阶段跑一遍，造成重复或错阶段验证。

修复后：

- `placement !== "completion_only"`：只进 work-unit 阶段。
- `placement === "completion_only"`：只进 completion gate。
- `disableCompletionValidators=true` 时 completion gate 为空。

## 4. readJsonFile 默认 strict

修复前：

- `readJsonFile(...)` 默认会 aggressive salvage。
- 会 strip invalid escape，甚至把 `\r/\n/\t` 转成真实控制字符，可能把 Windows 路径静默改坏。

修复后：

- 默认只做严格 `JSON.parse`。
- 只有明确是 LLM 草稿输出的位置才允许 `{ salvage: "extract-object" }`。
- path-like 字段里如果出现 `\r/\n/\t` 控制字符，直接报错，提示使用 `C:\\dir\\file.json` 或 `C:/dir/file.json`。

## 验证

已通过：

```powershell
bun --check auto-evolve/orchestrator/fs.ts auto-evolve/orchestrator/validation-engine/long-task-adapter.ts auto-evolve/orchestrator/long-task/validators.ts auto-evolve/orchestrator/long-task/runner.ts auto-evolve/orchestrator/long-task-campaign/runner.ts auto-evolve/scripts/smoke-validator-safety-regressions.ts
bun run auto-evolve/scripts/smoke-validator-safety-regressions.ts
```

新增 smoke 覆盖：

- `exit 0 + {"passed": true}` => 通过。
- `exit 1 + {"passed": true}` => 失败，infra。
- `timeout + {"passed": true}` => 失败，infra。
- `exit 0 + {"passed": false}` => 失败，product。
- `answer.txt / answer.json / answer.md` 自动推断。
- `human-guidance.md` 不会被误当 candidate。
- unit validator 不进入 completion gate。
- strict JSON 不再静默修坏 Windows 路径。

大白话：以后验证器不能再“进程炸了但 JSON 说通过就算通过”；答案文件也不能再被 `answer.md` 这个旧假设绑死；普通状态 JSON 不再被系统悄悄改路径。
