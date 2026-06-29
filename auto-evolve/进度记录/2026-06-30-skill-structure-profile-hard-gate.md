# 2026-06-30 Skill Structure Profile Hard Gate

本次新增 AEV 可拔插硬结构验证底座，先不实现软验证。

核心文件：

- `auto-evolve/scripts/validate-skill-structure-profile.ts`
- `auto-evolve/task-packs/validator-profiles/skill-surface/standard-hard-v1.json`
- `auto-evolve/task-packs/validator-profiles/skill-surface/profiles/standard-structure-v1.json`
- `auto-evolve/scripts/smoke-skill-structure-profile.ts`

能力范围：

- 检查必须文件是否存在。
- 检查必须目录是否存在。
- `closedWorld=true` 时禁止未被 `allowedGlobs` 允许的额外文件。
- 检查 Markdown 文件必须包含指定标题。
- 检查 JSON 文件可解析并包含指定 key。
- 支持 profile 内 `--profile` 相对路径按 validator profile 文件所在目录解析，便于跨数据集拔插。

挂载方式：

```json
{
  "validatorProfiles": [
    "skill-surface/standard-hard-v1"
  ]
}
```

验证阶段建议：

- `target = layout`
- `stage = pre_blank`
- `answerAccess = none`
- `allowedAudiences` 不允许包含 `blank_agent`

已跑烟测：

```powershell
bun --check auto-evolve/scripts/validate-skill-structure-profile.ts auto-evolve/orchestrator/long-task/spec.ts auto-evolve/orchestrator/validation-engine/stage-runner.ts
bun run auto-evolve/scripts/smoke-skill-structure-profile.ts
```

覆盖场景：

- 正常 skill 通过。
- 缺必须文件失败。
- 缺 Markdown 标题失败。
- closed-world 多余文件失败。
- JSON 缺 key 失败。
- validator profile 内相对 `--profile` 路径解析成功。
- 通过 `runValidationStage` 真实平台链路运行成功。
