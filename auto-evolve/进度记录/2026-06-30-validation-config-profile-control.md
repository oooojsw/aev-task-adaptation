# 2026-06-30 Validation Config Profile Control

## 目标

把硬验证模块从“只能在每个任务 spec 里手动挂载”提升为“总控文件可选”。后续如果有很多 layout / surface / rollback / product / regression 验证模块，它们统一放在 `auto-evolve/task-packs/validator-profiles` 下，总控 `auto-evolve/config.json` 只负责选择启用哪些 profile set。

## 实现

- 新增 `config.json.validationConfig`：
  - `profilesRoot`: 验证模块集中目录。
  - `enabledProfileSets`: 本次全局启用的模块组。
  - `defaultValidatorProfiles`: 直接追加到所有 long-task spec 的 profile。
  - `defaultBlankEvalValidatorProfiles`: 直接追加到 blank-eval/deployment 路径的 profile。
  - `profileSets`: 可复用命名模块组。
- 默认定义 `skill-structure-standard`：
  - 追加 `skill-surface/standard-hard-v1`。
  - 默认不启用，避免旧实验突然被新硬门卡住。
- `loadLongTaskSpec(...)` 会在加载任务 spec 时合并：
  - 任务本地 `validatorProfiles`
  - 总控选中的 `validationConfig` profiles
- 这个合并发生在 spec load 阶段，不改原始 task-pack 文件，也不改 campaign 的 `baseSpecPath`，避免破坏断点续传和历史血统匹配。

## 临时覆盖

正式使用推荐改 `config.json`：

```json
"enabledProfileSets": ["skill-structure-standard"]
```

smoke 或临时运行可用环境变量覆盖：

```powershell
$env:AUTO_EVOLVE_VALIDATION_PROFILE_SETS = "skill-structure-standard"
$env:AUTO_EVOLVE_VALIDATOR_PROFILES = "skill-surface/standard-hard-v1"
```

## Smoke

```powershell
bun --check auto-evolve/orchestrator/schema.ts auto-evolve/orchestrator/long-task/spec.ts auto-evolve/scripts/smoke-validation-config-profiles.ts auto-evolve/scripts/smoke-skill-structure-profile.ts
bun run auto-evolve/scripts/smoke-validation-config-profiles.ts
bun run auto-evolve/scripts/smoke-skill-structure-profile.ts
```

结果：全部通过。
