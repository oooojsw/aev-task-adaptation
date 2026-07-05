# Blank Eval Plan Runner 实现记录

日期：2026-07-03

## 本次目标

把原来只能验单个 case 的 Blank Eval，扩展成可编排的一组闭卷验收。这样以后合并后的 skill、merge-as-long-task、训练集回撤、测试集批量验收，都可以复用同一个 blank agent 基座，而不是每个地方重新写一套循环。

## 已实现

- 新增 `auto-evolve/orchestrator/blank-eval/plan-runner.ts`。
- 扩展 `auto-evolve/orchestrator/blank-eval/contract.ts`，新增 `BlankEvalPlanInput / Result / Case` 等类型。
- 新增长程任务 validator 类型：`blank_eval_plan`。
- 接入位置：
  - `auto-evolve/orchestrator/long-task/contract.ts`
  - `auto-evolve/orchestrator/long-task/spec.ts`
  - `auto-evolve/orchestrator/long-task/repository.ts`
  - `auto-evolve/orchestrator/long-task/prompts.ts`
  - `auto-evolve/orchestrator/long-task/validate.ts`
  - `auto-evolve/orchestrator/validation-engine/contract.ts`
  - `auto-evolve/orchestrator/validation-engine/registry.ts`
  - `auto-evolve/orchestrator/validation-engine/long-task-adapter.ts`
  - `auto-evolve/orchestrator/long-task-campaign/runner.ts`

## 支持的模式

- `single`：只跑第一条 case，保持旧单题 Blank Eval 语义。
- `sequence`：按顺序跑多题，可设置失败即停。
- `parallel`：并行跑多题，可设置并发数和通过率门槛。

## 输出文件

每次 plan 运行会输出：

- `plan-input.json`
- `plan-result.json`
- `evidence-bundle.json`
- `summary.md`
- 每个 case 独立子目录和独立 Blank Eval 结果。

## 可挂载示例

```json
{
  "id": "merged-skill-replay",
  "type": "blank_eval_plan",
  "placement": "completion_only",
  "planPath": "materials/replay-plan.json",
  "skillRootPath": "workspace/merged-skill",
  "mode": "parallel",
  "concurrency": 3,
  "successCriterion": "all_pass"
}
```

## 安全边界

Plan Runner 自己可以读 replay plan，但不会把 replay plan 直接交给 blank agent。每个 blank agent 仍然走原来的物理闭卷 sandbox，只看到当前 case 的材料、clean skill 和自己的 workspace。

也就是说：这次改造是“多考场调度器”，不是放宽闭卷权限。

## 已测试

```powershell
bun --check auto-evolve/orchestrator/blank-eval/contract.ts auto-evolve/orchestrator/blank-eval/plan-runner.ts auto-evolve/orchestrator/long-task/contract.ts auto-evolve/orchestrator/long-task/spec.ts auto-evolve/orchestrator/long-task/repository.ts auto-evolve/orchestrator/long-task/prompts.ts auto-evolve/orchestrator/long-task/validate.ts auto-evolve/orchestrator/validation-engine/contract.ts auto-evolve/orchestrator/validation-engine/registry.ts auto-evolve/orchestrator/validation-engine/long-task-adapter.ts auto-evolve/orchestrator/long-task-campaign/runner.ts auto-evolve/scripts/smoke-blank-eval-plan.ts
bun run auto-evolve/scripts/smoke-blank-eval-plan.ts
```

烟测覆盖：

- `single` 只跑第一条。
- `sequence` 失败即停并标记后续 skipped。
- `parallel` 能按 `min_pass_rate` 汇总判定。

## 核查补丁

复查时发现 adapter 层对 replay plan 的 case 行过于宽松：如果某一行漏写 `specPath/spec`，旧逻辑会把空字符串解析成 plan 所在目录。已修复为先过滤空 specPath，避免误跑目录路径。

## 鲁棒性补强（2026-07-03）

继续补了三类防护：

- 单个 case 的 blank eval 如果抛异常，不再拖垮整个 plan；该 case 会被记录为 `validator_infrastructure` 失败，其他 case 继续汇总。
- `blank_eval_plan` adapter 现在能把坏 JSON、空 case 列表、缺失 case spec 路径转成明确的 validator infrastructure failure，而不是让外层直接崩掉。
- `concurrency` 和 `minPassRate` 做了归一化：非法并发回退到 1，通过率被限制在 0 到 1 之间。

补充烟测：

- fake runner 抛异常时，plan 仍然产生 `plan-result.json` 风格结果。
- `allow_partial` 在一题通过、一题崩溃时能按规则通过。
- 崩溃 case 会被标记成基础设施失败。

验证命令：

```powershell
bun --check auto-evolve/orchestrator/blank-eval/plan-runner.ts auto-evolve/orchestrator/validation-engine/long-task-adapter.ts auto-evolve/scripts/smoke-blank-eval-plan.ts
bun run auto-evolve/scripts/smoke-blank-eval-plan.ts
```

## 后续可做

- 把合并任务数据集整理成一个真正的 merge-as-long-task task-pack。
- 让最终 validator 用 `blank_eval_plan` 对 `workspace/merged-skill` 做多 case 回撤。
- 后续如果需要，可以继续扩展 `cascade` 或 `matrix` 模式。

## 充分烟测记录（2026-07-03）

新增并通过 `scripts/smoke-blank-eval-plan-spec.ts`：验证 `blank_eval_plan` 能被 long-task spec 正常加载，且 `planPath` / `skillRootPath` 会按 spec 所在目录解析成绝对路径。

本轮烟测命令：

```powershell
bun --check auto-evolve/orchestrator/blank-eval/contract.ts auto-evolve/orchestrator/blank-eval/plan-runner.ts auto-evolve/orchestrator/long-task/contract.ts auto-evolve/orchestrator/long-task/spec.ts auto-evolve/orchestrator/long-task/repository.ts auto-evolve/orchestrator/long-task/prompts.ts auto-evolve/orchestrator/long-task/validate.ts auto-evolve/orchestrator/validation-engine/contract.ts auto-evolve/orchestrator/validation-engine/registry.ts auto-evolve/orchestrator/validation-engine/long-task-adapter.ts auto-evolve/orchestrator/long-task-campaign/runner.ts auto-evolve/scripts/smoke-blank-eval-plan.ts auto-evolve/scripts/smoke-blank-eval-plan-spec.ts
bun run auto-evolve/scripts/smoke-blank-eval-plan-spec.ts
bun run auto-evolve/scripts/smoke-blank-eval-plan.ts
bun run auto-evolve/scripts/smoke-validation-engine.ts
bun run auto-evolve/scripts/smoke-blank-eval-reset-sandbox-guard.ts
bun run auto-evolve/scripts/smoke-blank-eval-sensitive-material-guard.ts
bun run auto-evolve/scripts/smoke-validator-blank-agent-audience-guard.ts
```

通过结果：

- `smoke-blank-eval-plan-spec passed`
- `smoke-blank-eval-plan passed`
- `smoke-validation-engine` 返回 `passed: true`
- `smoke-blank-eval-reset-sandbox-guard` 返回 `passed: true`
- `smoke-blank-eval-sensitive-material-guard` 返回 `passed: true`
- `smoke-validator-blank-agent-audience-guard` 返回 `passed: true`

说明：本轮烟测没有启动真实训练；其中 `smoke-blank-eval-module` 会跑一个本地小样例 blank eval，但不是 benchmark 训练任务。
