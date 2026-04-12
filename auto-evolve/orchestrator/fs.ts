import path from "node:path"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import type { AutoEvolveConfig } from "./schema"

export interface LayoutResult {
  autoEvolveRoot: string
  created: string[]
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

export function autoEvolvePath(cwd: string, ...segments: string[]) {
  return path.join(cwd, "auto-evolve", ...segments)
}

export function caseMetadataPath(caseDir: string) {
  return path.join(caseDir, "case.json")
}

export async function pathExists(target: string) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

export async function ensureDirectory(target: string) {
  await mkdir(target, { recursive: true })
}

export async function readTextFile(target: string) {
  return readFile(target, "utf8")
}

export async function readJsonFile<T = any>(target: string): Promise<T> {
  const raw = await readTextFile(target)
  return JSON.parse(raw) as T
}

export async function writeTextFile(target: string, content: string) {
  await ensureDirectory(path.dirname(target))
  await writeFile(target, content, "utf8")
}

export async function writeJsonFile(target: string, value: unknown) {
  await writeTextFile(target, JSON.stringify(value, null, 2) + "\n")
}

async function writeIfMissing(target: string, content: string, created: string[]) {
  if (await pathExists(target)) return
  await writeTextFile(target, content)
  created.push(normalizeSlash(path.relative(process.cwd(), target) || target))
}

const DEFAULT_TEMPLATE_LIBRARY_README = `# 经验模板库

这个目录只存放“结构参考模板”，供 bootstrap 和经修 agent 在设计经验工作区时参考。

- 模板库不是最终专家经验。
- 最终经验工作区里不应该机械复制整份模板库。
- 模板的作用是帮助 agent 选择合适的结构，而不是规定唯一结构。
- 当经验体系变大时，agent 可以参考这些模板决定是否拆分分区、增加工具说明、建立任务路由等。
`

const DEFAULT_TEMPLATE_ENTRY = `<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->
# 模板：入口文件

用途：

- 作为经验工作区唯一入口
- 告诉空白 solve agent 应该先读什么，再按什么顺序继续读

建议包含：

- 任务总目标
- 读取顺序
- 文件导航
- 任务路由
- 工具/脚本说明索引
`

const DEFAULT_TEMPLATE_RULE_MODULE = `<!-- auto-evolve-role: rule_module -->
# 模板：规则模块

用途：

- 存放某一类任务的可复用规则
- 当经验体系增大时，将规则拆成多个模块

建议包含：

- 适用范围
- 稳定规则
- 边界条件
- 例子
- 相关模块
`

const DEFAULT_TEMPLATE_EXCEPTION_MODULE = `<!-- auto-evolve-role: exception_module -->
# 模板：特例模块

用途：

- 存放少量、明确、可解释的例外情况

建议包含：

- 什么时候适用
- 为什么不是通用规则
- 与通用规则的关系
- 示例
`

const DEFAULT_TEMPLATE_OUTPUT_CONTRACT = `<!-- auto-evolve-role: output_contract -->
# 模板：输出契约

用途：

- 约束 solve agent 的最终输出格式

建议包含：

- 比较模式
- 是否必须精确匹配
- 禁止的额外内容
- 常见输出失败模式
`

const DEFAULT_TEMPLATE_EXECUTION_CHECKLIST = `<!-- auto-evolve-role: execution_checklist -->
# 模板：执行清单

用途：

- 规定 solve agent 的标准执行顺序

建议包含：

- 先读什么
- 先做什么判断
- 输出前检查什么
- 常见漏项
`

const DEFAULT_TEMPLATE_FAILURE_LESSONS = `<!-- auto-evolve-role: failure_lessons -->
# 模板：失败教训

用途：

- 保存反复出现、且对长期表现有价值的失败经验

建议包含：

- 失败模式
- 原因
- 后续 agent 应如何避免
`

const DEFAULT_TEMPLATE_TOOL_GUIDE = `<!-- auto-evolve-role: tool_guide -->
# 模板：工具使用说明

用途：

- 当某类任务依赖特定脚本或工具时，告诉 agent 什么时候、怎么用

建议包含：

- 什么时候用
- 必需输入
- 操作步骤
- 常见错误
- 预期输出
`

const DEFAULT_TEMPLATE_PARTITION_INDEX = `<!-- auto-evolve-role: partition_index -->
# 模板：分区索引

用途：

- 当经验工作区很大时，为某个分区建立局部入口

建议包含：

- 分区目的
- 什么时候读这个分区
- 相关文件
- 局部读取顺序
`

const DEFAULT_TEMPLATE_TASK_ROUTER = `<!-- auto-evolve-role: task_router -->
# 模板：任务路由

用途：

- 告诉空白 solve agent 遇到不同任务时应该读哪一类模块

建议包含：

- 任务类型
- 首选读取文件
- 相关工具说明
- 不该读的无关分区
`

const DEFAULT_DIRECT_REWRITE_MODULE = `# Reverse Propagation Module: Direct Rewrite

Status: active baseline module

## Purpose

- This is the current baseline reverse-propagation module.
- It directly revises the current canonical experience workspace.

## Working Style

- Prefer durable Markdown edits over extra indirection.
- Keep one coherent canonical workspace rather than creating competing internal versions.
- Improve future solve behavior without memorizing one local answer more than necessary.

## Structural Guidance

- You may rewrite existing modules.
- You may create new Markdown modules if they improve long-term maintainability.
- You may create or update workspace-local helper assets under \`tools/\` or \`skills/\` when future solve agents genuinely need reusable local tooling or skill definitions.
- You may split or merge modules if the current structure is overloaded or duplicated.
- You may rewrite the entry navigation when the downstream structure changes.

## Cautions

- Do not preserve placeholder structure only because it already exists.
- Do not copy template files mechanically into the final workspace.
- Do not turn one local mismatch into an oversized global rewrite unless the evidence supports it.
`

const DEFAULT_ADD_ONLY_MEMORY_MODULE = `# Reverse Propagation Module: Add-Only Memory

Status: active secondary module

## Purpose

- Preserve existing experience and repair failures through additive maintenance.
- Prefer appending clarifications, adding lessons, adding tool guides, or creating small focused helper modules.

## Working Style

- Keep existing still-useful experience intact whenever possible.
- Prefer local addenda over broad rewrites.
- Use the smallest additive memory that improves future solve behavior.

## Structural Guidance

- You may append to existing Markdown modules.
- You may create a new small Markdown module when append-only changes would become messy.
- You may add or update narrow helper assets under \`tools/\` or \`skills/\` if a future solve agent needs reusable local tooling without broad workspace rewrites.
- You may lightly update the entry navigation so future agents can discover the new additive memory.
- You should avoid deleting, replacing, or broadly rewriting the existing canonical rule chain unless another method explicitly permits it.

## Cautions

- Do not silently overwrite core knowledge when a narrower additive memory is enough.
- Do not create duplicate clutter if one focused addendum or lesson would suffice.
- If a failure appears to require structural repair rather than additive memory, keep the new note narrow and explicit.
`

const DEFAULT_MANIFEST = `<!-- auto-evolve-bootstrap: replaceable -->
<!-- auto-evolve-entry: true -->
<!-- auto-evolve-role: entry -->
# 经验工作区入口

状态：最小种子

## 当前说明

- 这是经验工作区唯一入口文件。
- 当前还没有正式展开最终专家经验结构。
- 第一次 bootstrap 应该先阅读训练案例和模板库，再决定最终结构。

## 必须长期保持的共同点

- 始终保留一个且仅一个入口文件。
- 最终工作区只保存最终专家经验，不直接并入模板库。
- 空白 solve agent 必须先从本文件开始，再按需选择性读取下游文件。
- 工作区内只保留 Markdown 专家经验文件。

## 当前状态

- 结构未展开
- 规则未提炼
- 后续 bootstrap 或经修 agent 需要生成正式结构
`

const DEFAULT_CHANGE_LOG = `<!-- auto-evolve-role: change_log -->
# 变更记录

- 经验工作区已初始化为最小种子。
`

const DEFAULT_SEQUENTIAL_METHOD = `# Method: Sequential Refine

Status: active baseline

## Purpose

- This is the current baseline learning method for auto-evolve.
- It keeps the existing loop intact:
  - bootstrap
  - solve
  - evaluate
  - maintain experience
  - retry

## Notes

- This method should remain available as the default control baseline.
- Prompt instructions live under \`prompts/\`.
- Future methods should be added beside this one rather than replacing it.
`

const DEFAULT_ADD_ONLY_METHOD = `# Method: Add Only

Status: active additive alternative

## Purpose

- This method preserves the current canonical experience workspace and tries to repair failures by adding new memory instead of broadly rewriting existing memory.
- It is the second baseline reverse-propagation route beside sequential-refine.

## Notes

- Prompt instructions live under \`prompts/\`.
- This method should act conservatively and prefer additive maintenance rounds before giving up on a case.
`

const DEFAULT_SEQUENTIAL_FLOW = `# Flow: Sequential Refine

## Primitive Ops

- solve_case
- finish_if_passed
- finish_if_eval_mode
- finish_if_max_retries_reached
- prepare_feedback_packet
- run_regression_before_maintenance
- invoke_knowledge_maintainer
- reject_if_maintenance_failed
- reject_if_no_experience_change
- reject_if_out_of_policy_files
- verify_current_case
- reject_if_current_case_not_fixed
- run_regression_after_maintenance
- accept_or_reject_change
- finish_after_accept
`

const DEFAULT_ADD_ONLY_FLOW = `# Flow: Add Only

## Primitive Ops

- solve_case
- finish_if_passed
- finish_if_eval_mode
- finish_if_max_retries_reached
- prepare_feedback_packet
- run_regression_before_maintenance
- run_pre_judge
- finish_if_judge_skipped_maintenance
- invoke_knowledge_maintainer
- reject_if_maintenance_failed
- reject_if_no_experience_change
- reject_if_out_of_policy_files
- verify_current_case
- reject_if_current_case_not_fixed
- run_regression_after_maintenance
- accept_or_reject_change
- finish_after_accept
`

const DEFAULT_SEQUENTIAL_BOOTSTRAP_PROMPT = `You are initializing the persistent expert experience for the auto-evolve system.

Your target is an experience workspace of Markdown documents.

{{experience_workspace_block}}

You may also inspect the reference template library:
{{template_library_block}}

Also read the user baseline file:
{{baseline_block}}

You may inspect reusable helper scripts here if they are relevant:
- {{scripts_dir}}

Task:
1. Study the listed labeled training cases by reading them from their paths.
2. Distill stable, reusable expert experience from those material/result pairs.
3. Replace the minimal seed with a final experience workspace structure that you judge to be appropriate.

Requirements for the experience workspace:
- The file paths listed in this prompt are paths only. Their contents are not preloaded for you.
- You must explicitly use \`read\` and \`list\` to inspect the files and directories you need.
- The main expert experience should live in Markdown.
- Write the experience workspace in Chinese by default unless a case explicitly requires another language.
- The workspace must have one single entry file. The current entry path is shown above.
- A future blank solve agent should start from the entry file, then selectively read downstream files instead of reading every file blindly.
- You are free to replace the minimal seed layout. Do not preserve old placeholder structure just because it already exists.
- You may create rule modules, output-contract files, execution guides, exception modules, partition indexes, task routers, and tool guides only if they help the final structure.
- If future solve behavior would benefit from local reusable helper assets, you may create text-based helper assets under \`tools/\` or \`skills/\`.
- Every expert-experience Markdown file outside \`tools/\` or \`skills/\` should include an \`auto-evolve-role\` marker near the top.
- The template library is only a reference source. Do not copy it mechanically into the final workspace.
- Keep the actual rules and expert experience in Markdown documents, not in TypeScript and not in the shared scripts library.
- Do not blindly copy the baseline file into the workspace; only keep ideas that survive the labeled evidence.
- Do not merely memorize raw answers or case IDs unless that information is genuinely reusable.
- Make the output-discipline guidance explicit enough that a future solve agent understands exact-match tasks fail if it prints explanations or extra characters.
- Keep the guidance practical enough that a fresh future solve agent can follow it without seeing prior chats.
- Do not edit dataset files or the shared scripts library.

Labeled training cases by path:
{{case_blocks}}

After updating the experience workspace, reply with 3 to 6 short bullet points summarizing what you wrote, how you organized the workspace, and which files you changed. Do not paste the full files into chat.
`

const DEFAULT_SEQUENTIAL_SOLVE_PROMPT = `You are the fresh solve agent for one auto-evolve case.

Before solving, read the current experience workspace:
{{experience_workspace_block}}

Also read the user baseline file:
{{baseline_block}}

You may inspect reusable scripts here if helpful:
- {{scripts_dir}}

{{execution_guidance}}Current case:
- case id: {{case_id}}
- expected compare mode: {{compare_mode}}
- instruction: {{instruction}}
- materials:
{{material_list}}

Rules for this solve round:
- Only file paths are provided in this prompt. File contents are not preloaded.
- You must explicitly use \`read\` and \`list\` on the paths above before solving.
- Use the experience workspace as your only persistent memory.
- Start from the single entry file shown above.
- Do not blindly read every workspace file. Follow the entry file and selectively read only the most relevant downstream files.
- The experience workspace may also contain workspace-local helper assets under \`tools/\` or \`skills/\`; read them only if the entry file or a linked guide indicates they are relevant.
- You may use the baseline file as optional user-provided context, but do not treat it as guaranteed truth.
- Do not use \`bash\`, web tools, or subagents for this task.
- Do not modify any files.
- Do not update any experience workspace file.
- Read files by exact path if you need more detail.
- Think silently; do not print your reasoning.
- Return only the final answer content, with no explanation, no markdown fences, and no prefatory text.
- This response is checked by an exact raw-string comparator. For text_exact cases, one extra character, label, quote, or explanation is a failure.
- If the answer is "ac", your entire response must be exactly: ac
`

const DEFAULT_SEQUENTIAL_REFINE_PROMPT = `You are the knowledge maintainer agent for the auto-evolve system.

Your target is the persistent experience workspace:
{{experience_workspace_block}}

You may also inspect the reference template library:
{{template_library_block}}

Also read the user baseline file:
{{baseline_block}}

You may inspect reusable helper scripts here if relevant:
- {{scripts_dir}}

Failure context for attempt {{attempt}}:
- case id: {{case_id}}
- instruction: {{instruction}}
- materials:
{{material_list}}
- expected output: {{expected_path}}
- actual failed output: {{actual_path}}
- structured evaluation summary: {{evaluation_path}}
- simplified solve action trace: {{action_trace_path}}

Method-specific maintenance contract:
{{method_contract_block}}

Task:
1. Read the current experience workspace.
2. Read the failure context and action trace.
3. If helpful, read the template library as a reference for structure ideas.
4. Update the experience workspace by editing Markdown files inside the workspace.

Maintenance rules:
- Only file paths are provided in this prompt. File contents are not preloaded.
- You must explicitly use \`read\` and \`list\` to inspect the files and directories you need.
- Keep the experience workspace in Chinese by default unless the task explicitly requires another language.
- Preserve still-useful knowledge.
- Improve the workspace so a future blank solve agent can solve similar tasks with stronger generalization.
- The workspace must keep one single entry file. The current entry path is shown above.
- You may split files, merge files, add partitions, add task routers, add task/tool guides, or simplify layout if that helps long-term maintainability.
- Every Markdown file you keep in the workspace should include an \`auto-evolve-role\` marker near the top.
- The template library is only a reference source. The final experience workspace should contain only the resulting expert experience, not copied template clutter.
- Treat the baseline file as user-provided context, not as proof.
- Prefer small, generalizable corrections over case-specific memorization.
- Use the action trace to capture the solve agent's real behavior, not just the final mismatch.
- Do not use \`bash\`, web tools, or subagents for this task.
- Do not edit dataset files or the scripts library.

After updating the experience workspace, reply with 3 to 6 short bullet points summarizing:
- what failure pattern you addressed
- how you changed the workspace structure or files
- what a future solve agent should do differently
`

const DEFAULT_ADVERSARIAL_METHOD = `# Method: Adversarial Test

Status: scaffold only

## Purpose

- This method will be used as the second learning route beside the baseline sequential method.
- Its role is to actively probe the current experience workspace, expose weak spots, and turn those weak spots into stronger maintenance signals.

## Intended Flow

- solve
- evaluate
- adversarial probe
- maintain experience
- retry

## Current Status

- This method is documented here so the project can grow without rewriting the main system.
- Runtime support is not wired yet.
`

const DEFAULT_ADVERSARIAL_FLOW = `# Flow: Adversarial Test

## Primitive Ops

- solve_case
- finish_if_passed
- finish_if_eval_mode
- finish_if_max_retries_reached
`

const DEFAULT_ADVERSARIAL_PROMPT = `# Prompt Placeholder

Status: scaffold only

- This prompt file exists so the method structure is visible in-repo.
- Runtime support for this method has not been connected yet.
`

const DEFAULT_BASELINE = `# 用户基线文件

状态：用户可编辑

## 作用

- 这里用于写用户自己的起始思路、额外要求、直觉假设或尝试方向。
- 这个文件会作为上下文材料提供给系统读取。
- 这个文件不是系统控制逻辑，不决定 phase 顺序、评估方式或文件写入权限。

## 当前状态

- 当前为空白基线。
- 你后续可以自由填写任何内容。
- 默认建议使用中文。
`

const DEFAULT_SPLIT = `# Dataset Split

## Train Cases

- case-001
- case-002
- case-003
- case-004
- case-005

## Test Cases

- case-006
- case-007
- case-008
- case-009
- case-010
`

const DEFAULT_CONFIG_JSON = `{
  "version": 1,
  "datasetDir": "dataset/cases",
  "knowledgeDir": "experience/workspace",
  "experienceArchiveDir": "experience/archive",
  "maintenanceGatewayDir": "runtime-state/maintenance-gateway",
  "experienceTransactionDir": "runtime-state/experience-transaction",
  "acceptanceFrameworkDir": "runtime-state/acceptance-framework",
  "experienceEntryFile": "manifest.md",
  "templateLibraryDir": "experience/templates",
  "reversePropagationModulesDir": "methods/reverse-propagation-modules",
  "maintenanceOpsDir": "methods/maintenance-ops",
  "judgeSkillsDir": "judge-skills",
  "systemPromptsDir": "prompts",
  "methodsDir": "methods/recipes",
  "propagationDir": "runtime-state/propagation",
  "propagationMethodsDir": "methods/propagation",
  "optimizationDir": "runtime-state/optimization",
  "baselineFile": "baseline.md",
  "splitFile": "dataset/SPLIT.md",
  "scriptsDir": "scripts",
  "runsDir": "runtime-state/runs",
  "modelConfigFile": "model-config.json",
  "judgeConfigFile": "judge-config.json",
  "permissionConfigFile": "permission-config.json",
  "monitorConfigFile": "monitor-config.json",
  "defaultMethod": "sequential-refine",
  "defaultPropagationMethod": "single-branch-baseline",
  "maxRetriesPerCase": 3,
  "maxMaintenanceRoundsPerAttempt": 3,
  "roundCaseLimit": 5,
  "regressionSampleSize": 3
}
`

const DEFAULT_PROPAGATION_METHOD_SINGLE_BRANCH_BASELINE = `# Propagation Method: Single Branch Baseline

Status: initial third-layer method

## Purpose

- Create one experimental branch from an existing experience commit.
- Reuse one second-layer maintenance method on that branch.
- Evaluate the resulting branch without touching the live canonical workspace.

## What It Proves

- Third-layer experiments can contain second-layer methods instead of replacing them.
- The system can snapshot canonical experience, materialize a branch workspace, run a delegated maintenance route, and store the resulting candidate commit.

## Current Scope

- One source ref
- One branch
- One delegated second-layer maintenance method
- No merge
- No promotion
- No multi-branch comparison yet
`

const DEFAULT_MODEL_CONFIG_JSON = `{
  "version": 1,
  "defaults": {
    "model": "minimax-cn-coding-plan/MiniMax-M2.7"
  },
  "limits": {
    "requestsPerMinute": 14
  },
  "phases": {
    "bootstrap": {},
    "solve": {},
    "refine": {},
    "verify": {},
    "regression": {}
  }
}
`

const DEFAULT_CASE_EXAMPLE = `{
  "id": "case-001",
  "instruction": "Read the attached material and return the target result in valid JSON only.",
  "materials": [
    {
      "path": "material/input.txt",
      "label": "primary material"
    }
  ],
  "expected": {
    "path": "expected/output.json",
    "mode": "json_exact"
  },
  "tags": ["baseline"]
}
`

const DEFAULT_LONG_TASK_EXAMPLE = `{
  "title": "example-long-task",
  "goal": "Use the provided materials and validators to complete the long task and leave validator-backed outputs in the target paths.",
  "taskFamily": "example-domain",
  "domainTags": ["demo"],
  "materials": [
    {
      "path": "../../dataset/cases/case-001/material/input.txt",
      "label": "source material"
    }
  ],
  "targetPaths": [
    {
      "path": "../../runtime-state/tmp-output/example-result.txt",
      "label": "target output"
    }
  ],
  "editablePaths": [
    "../../runtime-state/tmp-output/example-result.txt"
  ],
  "initialExpertContextPaths": [
    "../../experience/workspace/manifest.md"
  ],
  "validators": [
    {
      "id": "result-exists",
      "type": "script",
      "title": "Result file exists",
      "path": "../../../scripts/long-task-validator.example.py",
      "required": true
    },
    {
      "id": "goal-review",
      "type": "prompt_json",
      "title": "Goal-level review",
      "required": true,
      "prompt": "Inspect the current target files and judge whether they satisfy the stated long-task goal. Return JSON with passed, summary, details, and blocking."
    }
  ],
  "budgets": {
    "maxAttemptsPerUnit": 2,
    "maxTotalUnitAttempts": 8,
    "maxGraphReplans": 2,
    "maxValidatorCalls": 20,
    "maxNoProgressCycles": 3,
    "maxUnitsPerGraph": 8
  },
  "shadowMemoryScope": {
    "namespace": "example-domain",
    "tags": ["demo"],
    "retrievalMode": "isolated"
  }
}
`

const DEFAULT_LONG_TASK_VALIDATOR_EXAMPLE = `import json
import os
import sys

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "passed": False,
            "summary": "Missing validator input path.",
            "details": ["The validator expected a JSON input path as argv[1]."],
            "blocking": True,
        }))
        return 1

    payload_path = sys.argv[1]
    with open(payload_path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)

    target_paths = payload.get("targetPaths", [])
    existing = []
    missing = []
    for item in target_paths:
        path_value = item.get("path") if isinstance(item, dict) else None
        if isinstance(path_value, str) and os.path.exists(path_value):
            existing.append(path_value)
        elif isinstance(path_value, str):
            missing.append(path_value)

    passed = len(existing) > 0 and len(missing) == 0
    print(json.dumps({
        "passed": passed,
        "summary": "All target files exist." if passed else "Some target files are missing.",
        "details": [
            f"existing: {len(existing)}",
            f"missing: {len(missing)}",
        ] + [f"missing_path: {item}" for item in missing],
        "blocking": False,
    }, ensure_ascii=False))
    return 0 if passed else 1

if __name__ == "__main__":
    raise SystemExit(main())
`

const DEFAULT_MONITOR_CONFIG_JSON = `{
  "version": 1,
  "enabled": true,
  "autoStart": true,
  "hostname": "127.0.0.1",
  "port": 4219,
  "intervalSeconds": 2,
  "defaultLimit": 50,
  "openBrowserOnStart": true
}
`

const DEFAULT_JUDGE_CONFIG_JSON = `{
  "version": 1,
  "mode": "soft_plus_hard",
  "autoRunSkillIDs": [
    "exact-output",
    "tool-failures",
    "session-behavior"
  ]
}
`

const DEFAULT_EXPERIENCE_ARCHIVE_README = `# Experience Archive

This directory stores managed pre-reset snapshots of the tracked expert experience workspace.

- Every reset writes one new history entry and never overwrites prior history.
- \`latest/\` mirrors only the newest archived version for quick restore.
- \`history/\` stores the durable archive lineage.
- \`index.json\` records the archive list.
- Only the tracked expert-experience plane is archived here.
- Runtime sidecars such as \`.opencode/\` are excluded from the archive snapshot.
- The active workspace is reset to the minimal legal seed after archiving.
`

const DEFAULT_KNOWLEDGE_MAINTAINER_CORE_PROMPT = `You are the dedicated knowledge maintainer agent for the auto-evolve system.

Your job is to maintain the final expert experience workspace, not to solve the case directly.

## Experience Workspace

{{experience_workspace_block}}

## Reference Template Library

{{template_library_block}}

## User Baseline

{{baseline_block}}

## Available Helper Scripts Directory

- {{scripts_dir}}

## Current Failure Context

- attempt: {{attempt}}
- case id: {{case_id}}
- instruction: {{instruction}}
- materials:
{{material_list}}
- expected output path: {{expected_path}}
- actual failed output path: {{actual_path}}
- structured evaluation path: {{evaluation_path}}
- raw action trace path: {{action_trace_path}}

## Judge Results

{{judge_block}}

## Selected Session Execution Reports

{{session_reports_block}}

## Method Contract

{{method_contract_block}}

## Reverse Propagation Module

{{reverse_propagation_module_block}}

## Workspace Loading Strategy

{{loading_strategy_block}}

## Maintenance Scope Level

{{maintenance_scope_block}}

## Method-Specific Maintenance Extension

{{method_extension_block}}

## Available Maintenance Operations

{{maintenance_ops_block}}

## Core Maintenance Rules

1. Only file paths are provided in this prompt. File contents are not preloaded.
2. You must explicitly use \`read\` and \`list\` to inspect any file or directory you rely on.
3. Keep the final experience workspace in Chinese by default unless the task itself requires another language.
4. Preserve still-useful knowledge. Do not rewrite the workspace from scratch unless the current structure is clearly broken.
5. The final experience workspace must keep exactly one single entry file for a blank future solve agent.
6. The final workspace may contain both final expert experience and workspace-local helper assets that directly support future solve behavior.
7. Workspace-local helper assets must stay inside controlled subtrees such as \`tools/\` or \`skills/\`. Do not scatter helper scripts across the workspace root.
8. A future blank solve agent should start from the entry file and then selectively read downstream files. Do not assume the future agent will read every file.
9. The reference template library is not part of the final workspace.
10. Only perform maintenance behaviors that are explicitly supported by the current reverse propagation module, workspace loading strategy, maintenance scope level, and available maintenance operations blocks.
11. If a behavior is not clearly granted by those blocks, do not assume it is allowed.
12. Every expert-experience Markdown document outside workspace helper-asset directories should include an \`auto-evolve-role\` marker near the top.
13. Helper-asset Markdown files inside \`tools/\` or \`skills/\` do not need an \`auto-evolve-role\` marker, but they should remain discoverable from the workspace entry or a linked guide.
14. Treat the user baseline as optional user context, not as proof.
11. Use the selected session execution reports to understand real prior behavior:
    - which tools were used
    - which tools failed
    - where exploration was empty or repetitive
    - where output discipline broke
16. Prefer generalizable fixes over memorizing the current answer.
17. Do not edit dataset files or the shared scripts library.
18. Do not use \`bash\`, web tools, or subagents for this task.

## Output Requirement

After you finish updating the experience workspace, reply with 3 to 6 short bullet points describing:

- what behavior or failure pattern you corrected
- what files or structure you changed
- what a future solve agent should do differently
`

const DEFAULT_SOFT_JUDGE_CORE_PROMPT = `You are the soft judge agent for the auto-evolve system.

You do not solve the case and you do not edit the experience workspace.

Your job is to read session records, failure context, and optional hard-check results, then decide whether the knowledge maintainer should run.

## Judge Mode

{{judge_mode_block}}

## Experience Workspace

{{experience_workspace_block}}

## User Baseline

{{baseline_block}}

## Failure Context

- attempt: {{attempt}}
- case id: {{case_id}}
- instruction: {{instruction}}
- expected output path: {{expected_path}}
- actual failed output path: {{actual_path}}
- evaluation path: {{evaluation_path}}
- action trace path: {{action_trace_path}}
- routing path: {{routing_path}}

## Selected Session Execution Reports

{{session_reports_block}}

## Judge Skill Toolkit

{{judge_skills_block}}

## Auto-Run Hard Check Results

{{hard_check_results_block}}

## Method Judge Extension

{{judge_extension_block}}

## Required Output Files

- judge summary JSON path: {{judge_summary_path}}
- judge report Markdown path: {{judge_report_path}}

## Core Judge Rules

1. Only file paths are provided in this prompt. File contents are not preloaded.
2. You must explicitly use \`read\` and \`list\` to inspect files and directories.
3. If the current judge mode is \`soft_only\`, you may decide whether any local judge skill scripts need to be used.
4. If the current judge mode is \`soft_plus_hard\`, review the prepared hard-check outputs first before doing your own deeper analysis.
5. You may inspect the local judge-skill index and individual skill folders. These skills are local to this project and are not global tools.
6. If you run a local judge skill script, do it only to improve the quality of your judgment.
7. Do not edit dataset files, scripts library files, or experience workspace files.
8. Do not use web tools or subagents.
9. You must write both required output files before finishing:
   - a machine-readable \`judge_summary.json\`
   - a human-readable \`judge_report.md\`
10. In \`judge_summary.json\`, include at least:
   - judgeMode
   - shouldStartMaintainer
   - failureClass
   - keyIssues
   - toolIssues
   - behaviorIssues
   - suggestedWorkspaceTargets
   - recommendedSessionReports
   - hardChecksUsed
   - hardCheckResultPaths
   - riskLevel

## Final Chat Response

After writing the judge files, reply with 3 to 5 short bullet points summarizing:

- whether the maintainer should start
- the main failure causes
- the most important behavior/tool issues
`

const DEFAULT_SEQUENTIAL_JUDGE_EXTENSION_PROMPT = `This judge round follows the sequential-refine baseline.

Sequential-refine judge priorities:

- classification: {{routing_classification}}
- preferred files: {{preferred_files}}
- suggested roles: {{suggested_roles}}
- routing reasons: {{routing_reasons}}

Judge guidance:

- Be conservative about starting maintenance if the failure looks like transient noise only.
- Be strict about starting maintenance if the failure is stable, repeatable, or obviously reflects missing experience guidance.
- Pay special attention to whether the failed solve session shows repetitive useless exploration, repeated empty reads, or obvious tool misuse.
- Preserve already-working behavior: regression-before-maintain reports are strong evidence that some existing structure is worth protecting.
`

const DEFAULT_JUDGE_SKILL_EXACT_OUTPUT_SCRIPT = `import json
import sys
from pathlib import Path


def read_optional_text(target: Path) -> str:
    if not target.exists():
        return ""
    return target.read_text(encoding="utf-8").strip()


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: run.py <input-json> <output-json>")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    evaluation_path = Path(payload["solveEvaluationPath"])
    actual_path = Path(payload["solveActualOutputPath"])
    expected_path = Path(payload["solveExpectedPath"])

    evaluation = json.loads(evaluation_path.read_text(encoding="utf-8"))
    actual_text = read_optional_text(actual_path)
    expected_text = read_optional_text(expected_path)

    result = {
        "skill": "exact-output",
        "passed": evaluation.get("passed"),
        "summary": evaluation.get("summary"),
        "mismatches": evaluation.get("mismatches", []),
        "actualPreview": actual_text[:240],
        "expectedPreview": expected_text[:240],
        "actualPathExists": actual_path.exists(),
        "expectedPathExists": expected_path.exists(),
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")


if __name__ == "__main__":
    main()
`

const DEFAULT_JUDGE_SKILL_TOOL_FAILURES_SCRIPT = `import json
import sys
from collections import Counter
from pathlib import Path


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: run.py <input-json> <output-json>")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    tool_failures_path = Path(payload["solveToolFailuresPath"])
    tool_failures = json.loads(tool_failures_path.read_text(encoding="utf-8")) if tool_failures_path.exists() else []
    tool_counts = Counter(item.get("tool", "unknown") for item in tool_failures)
    result = {
        "skill": "tool-failures",
        "count": len(tool_failures),
        "tools": dict(tool_counts),
        "failures": tool_failures,
        "toolFailuresPathExists": tool_failures_path.exists(),
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")


if __name__ == "__main__":
    main()
`

const DEFAULT_JUDGE_SKILL_SESSION_BEHAVIOR_SCRIPT = `import json
import sys
from collections import Counter
from pathlib import Path


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: run.py <input-json> <output-json>")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    events_path = Path(payload["solveEventsPath"])
    events = json.loads(events_path.read_text(encoding="utf-8")) if events_path.exists() else []

    tool_counter = Counter()
    read_counter = 0
    empty_output_signals = 0

    for event in events:
        if event.get("type") == "tool_call":
            tool_name = str(event.get("tool") or "unknown")
            tool_counter[tool_name] += 1
            if tool_name == "read":
                read_counter += 1
            output = event.get("output")
            if isinstance(output, str) and not output.strip():
                empty_output_signals += 1

    result = {
        "skill": "session-behavior",
        "toolCounts": dict(tool_counter),
        "readCount": read_counter,
        "emptyOutputSignals": empty_output_signals,
        "repeatedReadSignal": read_counter >= 5,
        "eventsPathExists": events_path.exists(),
    }
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\\n", encoding="utf-8")


if __name__ == "__main__":
    main()
`

export async function ensureLayout(cwd: string): Promise<LayoutResult> {
  const created: string[] = []
  const root = autoEvolvePath(cwd)
  const experienceRoot = autoEvolvePath(cwd, "experience")
  const knowledgePackRoot = autoEvolvePath(cwd, "experience", "workspace")
  const experienceArchiveRoot = autoEvolvePath(cwd, "experience", "archive")
  const experienceTemplatesRoot = autoEvolvePath(cwd, "experience", "templates")
  const legacyKnowledgeRoot = autoEvolvePath(cwd, "experience", "legacy-knowledge")
  const methodsRoot = autoEvolvePath(cwd, "methods")
  const methodRecipesRoot = autoEvolvePath(cwd, "methods", "recipes")
  const reversePropagationModulesRoot = autoEvolvePath(cwd, "methods", "reverse-propagation-modules")
  const maintenanceOpsRoot = autoEvolvePath(cwd, "methods", "maintenance-ops")
  const propagationMethodsRoot = autoEvolvePath(cwd, "methods", "propagation")
  const runtimeStateRoot = autoEvolvePath(cwd, "runtime-state")
  const runsRoot = autoEvolvePath(cwd, "runtime-state", "runs")
  const maintenanceGatewayRoot = autoEvolvePath(cwd, "runtime-state", "maintenance-gateway")
  const experienceTransactionRoot = autoEvolvePath(cwd, "runtime-state", "experience-transaction")
  const acceptanceFrameworkRoot = autoEvolvePath(cwd, "runtime-state", "acceptance-framework")
  const propagationRoot = autoEvolvePath(cwd, "runtime-state", "propagation")
  const optimizationRoot = autoEvolvePath(cwd, "runtime-state", "optimization")
  const longTaskRoot = autoEvolvePath(cwd, "runtime-state", "long-task")
  const tmpOutputRoot = autoEvolvePath(cwd, "runtime-state", "tmp-output")
  const taskPacksRoot = autoEvolvePath(cwd, "task-packs")
  const templatesRoot = autoEvolvePath(cwd, "task-packs", "templates")
  const realLongTasksRoot = autoEvolvePath(cwd, "task-packs", "real-long-tasks")

  const directories = [
    root,
    autoEvolvePath(cwd, "dataset"),
    autoEvolvePath(cwd, "dataset", "cases"),
    experienceRoot,
    knowledgePackRoot,
    experienceArchiveRoot,
    autoEvolvePath(cwd, "experience", "archive", "history"),
    autoEvolvePath(cwd, "experience", "archive", "latest"),
    experienceTemplatesRoot,
    legacyKnowledgeRoot,
    autoEvolvePath(cwd, "prompts"),
    runtimeStateRoot,
    runsRoot,
    maintenanceGatewayRoot,
    experienceTransactionRoot,
    acceptanceFrameworkRoot,
    autoEvolvePath(cwd, "runtime-state", "maintenance-gateway", "requests"),
    autoEvolvePath(cwd, "runtime-state", "experience-transaction", "records"),
    autoEvolvePath(cwd, "runtime-state", "acceptance-framework", "records"),
    autoEvolvePath(cwd, "scripts"),
    autoEvolvePath(cwd, "judge-skills"),
    autoEvolvePath(cwd, "judge-skills", "exact-output"),
    autoEvolvePath(cwd, "judge-skills", "exact-output", "scripts"),
    autoEvolvePath(cwd, "judge-skills", "tool-failures"),
    autoEvolvePath(cwd, "judge-skills", "tool-failures", "scripts"),
    autoEvolvePath(cwd, "judge-skills", "session-behavior"),
    autoEvolvePath(cwd, "judge-skills", "session-behavior", "scripts"),
    methodsRoot,
    methodRecipesRoot,
    reversePropagationModulesRoot,
    maintenanceOpsRoot,
    propagationMethodsRoot,
    propagationRoot,
    optimizationRoot,
    autoEvolvePath(cwd, "runtime-state", "optimization", "candidates"),
    autoEvolvePath(cwd, "runtime-state", "optimization", "outcomes"),
    autoEvolvePath(cwd, "runtime-state", "optimization", "memory"),
    longTaskRoot,
    autoEvolvePath(cwd, "runtime-state", "long-task", "runs"),
    autoEvolvePath(cwd, "runtime-state", "long-task", "archive"),
    autoEvolvePath(cwd, "runtime-state", "long-task", "shadow-memory"),
    autoEvolvePath(cwd, "runtime-state", "long-task", "candidates"),
    tmpOutputRoot,
    path.join(methodRecipesRoot, "sequential-refine"),
    path.join(methodRecipesRoot, "sequential-refine", "prompts"),
    path.join(methodRecipesRoot, "add-only"),
    path.join(methodRecipesRoot, "add-only", "prompts"),
    path.join(methodRecipesRoot, "adversarial-test"),
    path.join(methodRecipesRoot, "adversarial-test", "prompts"),
    path.join(methodRecipesRoot, "parallel-batch-5-add-only"),
    path.join(methodRecipesRoot, "parallel-batch-5-add-only", "prompts"),
    taskPacksRoot,
    templatesRoot,
    realLongTasksRoot,
  ]

  for (const directory of directories) {
    if (!(await pathExists(directory))) {
      await ensureDirectory(directory)
      created.push(normalizeSlash(path.relative(cwd, directory) || directory))
    }
  }

  await writeIfMissing(autoEvolvePath(cwd, "config.json"), DEFAULT_CONFIG_JSON, created)
  await writeIfMissing(autoEvolvePath(cwd, "model-config.json"), DEFAULT_MODEL_CONFIG_JSON, created)
  await writeIfMissing(autoEvolvePath(cwd, "judge-config.json"), DEFAULT_JUDGE_CONFIG_JSON, created)
  await writeIfMissing(autoEvolvePath(cwd, "monitor-config.json"), DEFAULT_MONITOR_CONFIG_JSON, created)
  await writeIfMissing(autoEvolvePath(cwd, "baseline.md"), DEFAULT_BASELINE, created)
  await writeIfMissing(autoEvolvePath(cwd, "dataset", "SPLIT.md"), DEFAULT_SPLIT, created)
  await writeIfMissing(
    autoEvolvePath(cwd, "prompts", "knowledge-maintainer-core.md"),
    DEFAULT_KNOWLEDGE_MAINTAINER_CORE_PROMPT,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "prompts", "soft-judge-core.md"),
    DEFAULT_SOFT_JUDGE_CORE_PROMPT,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "archive", "README.md"),
    DEFAULT_EXPERIENCE_ARCHIVE_README,
    created,
  )
  await writeIfMissing(autoEvolvePath(cwd, "experience", "archive", "history", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "experience", "archive", "latest", ".gitkeep"), "\n", created)
  await writeIfMissing(
    autoEvolvePath(cwd, "runtime-state", "propagation", "README.md"),
    `# Propagation Workspace

This directory is reserved for third-layer propagation experiments.

- snapshots, refs, branches, and campaign records are stored here
- the live canonical workspace remains outside this directory
- experimental branch workspaces may be materialized here without modifying the canonical workspace
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "propagation", "single-branch-baseline.md"),
    DEFAULT_PROPAGATION_METHOD_SINGLE_BRANCH_BASELINE,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "runtime-state", "optimization", "README.md"),
    `# Layer 4 Optimization Workspace

This directory is reserved for the fourth layer:

- optimization candidate packages
- optimization outcomes
- optimizer memory

The fourth layer may prepare candidate expert-experience versions here, and the third layer may then evaluate those candidates without directly trusting them as canonical.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "runtime-state", "optimization", "memory", "README.md"),
    `# Optimizer Memory

This directory stores the fourth-layer optimizer's own memory about:

- which anti-overfit ideas helped
- which compression ideas harmed performance
- which evaluation suites revealed useful weaknesses

These files are not part of the canonical expert experience workspace.
`,
    created,
  )
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "optimization", "candidates", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "optimization", "outcomes", ".gitkeep"), "\n", created)
  await writeIfMissing(
    autoEvolvePath(cwd, "runtime-state", "long-task", "README.md"),
    `# Long-Task Workspace

This directory stores validator-driven long-task runs.

- runs/: one directory per long-running task execution
- archive/: append-only archive index for all long-task runs
- shadow-memory/: isolated shadow-memory entries for long-task outcomes
- candidates/: future handoff area for canonical candidates

The long-task module is a first-layer sibling of the short-task module.
It is centered on:

- validator contracts
- graph bootstrap
- work-unit execution
- local retry and replan
- failure packets
- run-local scratch memory
- archive and shadow-memory handoff
`,
    created,
  )
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "long-task", "runs", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "long-task", "archive", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "long-task", "archive", "index.jsonl"), "", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "long-task", "shadow-memory", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "long-task", "shadow-memory", "index.jsonl"), "", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "long-task", "candidates", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "long-task", "candidates", "index.jsonl"), "", created)
  await writeIfMissing(
    autoEvolvePath(cwd, "runtime-state", "maintenance-gateway", "README.md"),
    `# Maintenance Gateway

This directory stores the thin boundary objects between runtime kernels and the maintainer core.

- requests/: normalized maintenance requests from short and long task runtimes
- index.jsonl: append-only request index

The maintainer core should consume normalized requests from here rather than reading raw runtime internals directly.
`,
    created,
  )
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "maintenance-gateway", "requests", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "maintenance-gateway", "index.jsonl"), "", created)
  await writeIfMissing(
    autoEvolvePath(cwd, "runtime-state", "experience-transaction", "README.md"),
    `# Experience Transaction Gate

This directory stores the thin transaction layer between maintenance output and canonical experience.

- records/: append-only transaction audit records
- index.jsonl: append-only transaction index

The maintainer should produce candidate changes, and this layer should record verification, acceptance, and rollback decisions without becoming the maintainer itself.
`,
    created,
  )
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "experience-transaction", "records", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "experience-transaction", "index.jsonl"), "", created)
  await writeIfMissing(
    autoEvolvePath(cwd, "runtime-state", "acceptance-framework", "README.md"),
    `# Acceptance Framework

This directory stores unified acceptance records across:

- local acceptance
- transaction acceptance
- candidate acceptance
- deployment acceptance

These records are higher-level than any one validator or post-judge step.
`,
    created,
  )
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "acceptance-framework", "records", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "acceptance-framework", "index.jsonl"), "", created)

  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "README.md"),
    DEFAULT_TEMPLATE_LIBRARY_README,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "entry-template.md"),
    DEFAULT_TEMPLATE_ENTRY,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "rule-module-template.md"),
    DEFAULT_TEMPLATE_RULE_MODULE,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "exception-module-template.md"),
    DEFAULT_TEMPLATE_EXCEPTION_MODULE,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "output-contract-template.md"),
    DEFAULT_TEMPLATE_OUTPUT_CONTRACT,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "execution-checklist-template.md"),
    DEFAULT_TEMPLATE_EXECUTION_CHECKLIST,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "failure-lessons-template.md"),
    DEFAULT_TEMPLATE_FAILURE_LESSONS,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "tool-guide-template.md"),
    DEFAULT_TEMPLATE_TOOL_GUIDE,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "partition-index-template.md"),
    DEFAULT_TEMPLATE_PARTITION_INDEX,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "experience", "templates", "task-router-template.md"),
    DEFAULT_TEMPLATE_TASK_ROUTER,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "reverse-propagation-modules", "direct-rewrite.md"),
    DEFAULT_DIRECT_REWRITE_MODULE,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "reverse-propagation-modules", "add-only-memory.md"),
    DEFAULT_ADD_ONLY_MEMORY_MODULE,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "inspect_workspace.md"),
    `# Maintenance Op: Inspect Workspace

Summary: Read the workspace entry and then inspect the most relevant downstream Markdown modules.

- Start from the single entry file.
- Prefer selective reading even when full access is available.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "inspect_templates.md"),
    `# Maintenance Op: Inspect Templates

Summary: Inspect template-library files for structural ideas without copying them mechanically.

- Treat templates as references, not as final workspace content.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "inspect_failure_context.md"),
    `# Maintenance Op: Inspect Failure Context

Summary: Read expected output, actual output, evaluation, and related failure-context files before changing experience.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "inspect_session_records.md"),
    `# Maintenance Op: Inspect Session Records

Summary: Read selected session execution reports and related run records to understand prior behavior.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "rewrite_module.md"),
    `# Maintenance Op: Rewrite Module

Summary: Revise an existing Markdown module in place.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "create_module.md"),
    `# Maintenance Op: Create Module

Summary: Add a new Markdown module when the workspace genuinely needs it.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "append_to_existing_module.md"),
    `# Maintenance Op: Append To Existing Module

Summary: Append a focused additive patch to an existing Markdown module without replacing its main body.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "create_helper_asset.md"),
    `# Maintenance Op: Create Helper Asset

Summary: Create a workspace-local helper asset under \`tools/\` or \`skills/\` when a future solve agent would benefit from reusable local tooling.

- Keep helper assets inside \`tools/\` or \`skills/\` only.
- Prefer text-based assets such as \`SKILL.md\`, Python scripts, and JSON/TOML/YAML manifests.
- Make sure the workspace entry or a linked guide tells future agents when the asset should be used.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "update_helper_asset.md"),
    `# Maintenance Op: Update Helper Asset

Summary: Update an existing workspace-local helper asset under \`tools/\` or \`skills/\` without breaking its discoverability.

- Keep the update narrow and tied to a real solve-time need.
- If usage changes, update the entry navigation or related tool guide so future agents can still find the asset correctly.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "split_module.md"),
    `# Maintenance Op: Split Module

Summary: Split an overloaded module into smaller modules when selective reading would improve.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "merge_modules.md"),
    `# Maintenance Op: Merge Modules

Summary: Merge duplicate or overlapping modules to keep the workspace coherent.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "deprecate_module.md"),
    `# Maintenance Op: Deprecate Module

Summary: Mark a module as deprecated when it should no longer drive future solve behavior.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "create_partition.md"),
    `# Maintenance Op: Create Partition

Summary: Create or extend a navigable partition when the workspace becomes large enough to justify one.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "rewrite_entry_navigation.md"),
    `# Maintenance Op: Rewrite Entry Navigation

Summary: Update the single workspace entry so a blank future solve agent knows what to read first.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "add_tool_guide.md"),
    `# Maintenance Op: Add Tool Guide

Summary: Add or refine task-specific tool-usage guidance for future solve agents.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "add_failure_lesson.md"),
    `# Maintenance Op: Add Failure Lesson

Summary: Record a durable failure lesson that future agents should avoid repeating.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "methods", "maintenance-ops", "record_change.md"),
    `# Maintenance Op: Record Change

Summary: Update the change log so the evolution remains understandable.
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "judge-skills", "INDEX.md"),
    `# Judge Skill Toolkit

This directory contains project-local judge skills for the Soft Judge Agent.

These judge skills are not globally exposed.
They are only referenced by path inside judge runs.

## Available Skills

- exact-output
  - purpose: summarize exact output comparison and mismatch evidence
  - folder: judge-skills/exact-output
- tool-failures
  - purpose: summarize observed tool failures
  - folder: judge-skills/tool-failures
- session-behavior
  - purpose: summarize session behavior patterns from events and execution reports
  - folder: judge-skills/session-behavior
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "judge-skills", "exact-output", "SKILL.md"),
    `---
name: exact-output
description: Summarize output-comparison evidence for judge runs.
---

# When To Use

Use this skill when the judge needs a compact structured summary of expected vs actual output comparison.

# Script

- scripts/run.py

# Expected Input

Provide an input JSON path and an output JSON path:

- python scripts/run.py <input-json> <output-json>
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "judge-skills", "tool-failures", "SKILL.md"),
    `---
name: tool-failures
description: Summarize tool-failure evidence for judge runs.
---

# When To Use

Use this skill when the judge needs a compact summary of failed tool calls.

# Script

- scripts/run.py

# Expected Input

Provide an input JSON path and an output JSON path:

- python scripts/run.py <input-json> <output-json>
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "judge-skills", "session-behavior", "SKILL.md"),
    `---
name: session-behavior
description: Summarize session behavior patterns from events and execution reports.
---

# When To Use

Use this skill when the judge needs a structured behavior summary instead of reading the entire session record raw.

# Script

- scripts/run.py

# Expected Input

Provide an input JSON path and an output JSON path:

- python scripts/run.py <input-json> <output-json>
`,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "judge-skills", "exact-output", "scripts", "run.py"),
    DEFAULT_JUDGE_SKILL_EXACT_OUTPUT_SCRIPT,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "judge-skills", "tool-failures", "scripts", "run.py"),
    DEFAULT_JUDGE_SKILL_TOOL_FAILURES_SCRIPT,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "judge-skills", "session-behavior", "scripts", "run.py"),
    DEFAULT_JUDGE_SKILL_SESSION_BEHAVIOR_SCRIPT,
    created,
  )

  await writeIfMissing(path.join(knowledgePackRoot, "manifest.md"), DEFAULT_MANIFEST, created)
  await writeIfMissing(path.join(knowledgePackRoot, "change_log.md"), DEFAULT_CHANGE_LOG, created)

  await writeIfMissing(path.join(methodRecipesRoot, "sequential-refine", "METHOD.md"), DEFAULT_SEQUENTIAL_METHOD, created)
  await writeIfMissing(path.join(methodRecipesRoot, "sequential-refine", "FLOW.md"), DEFAULT_SEQUENTIAL_FLOW, created)
  await writeIfMissing(
    path.join(methodRecipesRoot, "sequential-refine", "prompts", "bootstrap.md"),
    DEFAULT_SEQUENTIAL_BOOTSTRAP_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "sequential-refine", "prompts", "solve.md"),
    DEFAULT_SEQUENTIAL_SOLVE_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "sequential-refine", "prompts", "maintain_extension.md"),
    `This maintenance round follows the sequential-refine baseline.

Use the selected session execution reports in this order:

1. Read the current failed solve session report first.
2. Read the regression-before-maintain session reports as guardrails so you do not damage already-working behavior.
3. If previous attempts exist, read the previous maintain and verify reports to avoid repeating the same bad repair pattern.

Sequential-refine expectations:

- classification: {{routing_classification}}
- preferred files: {{preferred_files}}
- suggested roles: {{suggested_roles}}
- routing reasons: {{routing_reasons}}

Specific behavioral guidance:

- Prefer the smallest durable correction that fixes the current failure pattern.
- Avoid converting one local mistake into a global rule rewrite unless the evidence clearly supports it.
- If previous reports show repeated useless exploration or repeated wrong tool habits, encode an explicit warning or execution rule so future solve agents avoid that path.
- If regression-before-maintain reports show existing successful behavior, preserve the structure that supports those successes.
- Do not create multiple competing versions of the same expert knowledge inside the workspace for this baseline method.
`,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "sequential-refine", "prompts", "judge_extension.md"),
    DEFAULT_SEQUENTIAL_JUDGE_EXTENSION_PROMPT,
    created,
  )

  await writeIfMissing(path.join(methodRecipesRoot, "add-only", "METHOD.md"), DEFAULT_ADD_ONLY_METHOD, created)
  await writeIfMissing(path.join(methodRecipesRoot, "add-only", "FLOW.md"), DEFAULT_ADD_ONLY_FLOW, created)
  await writeIfMissing(
    path.join(methodRecipesRoot, "add-only", "prompts", "bootstrap.md"),
    `You are initializing the persistent expert experience for the auto-evolve system.

Your target is an experience workspace of Markdown documents.

{{experience_workspace_block}}

You may also inspect the reference template library:
{{template_library_block}}

Also read the user baseline file:
{{baseline_block}}

You may inspect reusable helper scripts here if they are relevant:
- {{scripts_dir}}

Task:
1. Study the listed labeled training cases by reading them from their paths.
2. Distill stable, reusable expert experience from those material/result pairs.
3. Build an initial experience workspace that is friendly to future additive maintenance.

Requirements for the experience workspace:
- The file paths listed in this prompt are paths only. File contents are not preloaded for you.
- You must explicitly use \`read\` and \`list\` to inspect the files and directories you need.
- The main expert experience should live in Markdown.
- Write the experience workspace in Chinese by default unless a case explicitly requires another language.
- The workspace must have one single entry file.
- The final workspace must still be a valid auto-evolve experience workspace after you finish, not just a useful note collection.
- A future blank solve agent should start from the entry file, then selectively read downstream files.
- Organize the initial workspace so future additive maintenance can append lessons, local patches, or tool guidance without broad rewrites.
- If future solve behavior would benefit from local reusable helper assets, you may create text-based helper assets under \`tools/\` or \`skills/\`.
- Every expert-experience Markdown file outside \`tools/\` or \`skills/\` should include an \`auto-evolve-role\` marker near the top.
- The workspace must keep a \`change_log.md\` expert Markdown file with \`auto-evolve-role: change_log\`.
- Do not create new hidden expert-content directories or scratch/test-record folders inside the tracked expert workspace.
- If root-level \`.opencode/\` already exists, treat it as runtime sidecar state rather than expert experience.
- Do not create Markdown files outside the expert workspace structure unless they are intentional expert documents with a clear \`auto-evolve-role\` marker.
- Do not create helper assets anywhere except \`tools/\` or \`skills/\`.
- If you create helper assets, the entry file or a linked guide must explain when a future solve agent should use them.
- The template library is only a reference source. Do not copy it mechanically into the final workspace.
- Keep the actual rules and expert experience in Markdown documents, not in TypeScript and not in the shared scripts library.
- Do not edit dataset files or the shared scripts library.
- Before finishing, self-check that the final workspace keeps exactly one entry file, keeps the change log, and would pass the workspace layout validation rules above.

Labeled training cases by path:
{{case_blocks}}

After updating the experience workspace, reply with 3 to 6 short bullet points summarizing what you wrote, how you organized the workspace for additive maintenance, and which files you changed. Do not paste the full files into chat.
`,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "add-only", "prompts", "solve.md"),
    DEFAULT_SEQUENTIAL_SOLVE_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "add-only", "prompts", "maintain_extension.md"),
    `This maintenance round follows the add-only method.

Routing hints:

- classification: {{routing_classification}}
- preferred files: {{preferred_files}}
- suggested roles: {{suggested_roles}}
- routing reasons: {{routing_reasons}}
- maintenance round: {{maintenance_round}}

Add-only expectations:

- Preserve still-useful existing knowledge whenever possible.
- Prefer additive maintenance over replacement.
- First choice: append a focused addendum to an existing relevant module.
- Second choice: create a small new Markdown module for a lesson, exception, note, or tool guide.
- Only lightly update entry navigation so future agents can discover the new additive memory.
- Avoid deleting, broadly rewriting, splitting, or merging existing canonical modules in this method.
- If the previous round was rejected, use that rejection feedback to make the next change narrower and safer.

Previous maintenance-round feedback:
{{maintenance_retry_feedback}}
`,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "add-only", "prompts", "judge_extension.md"),
    `This judge run supports the add-only method.

Routing hints:

- classification: {{routing_classification}}
- preferred files: {{preferred_files}}
- suggested roles: {{suggested_roles}}
- routing reasons: {{routing_reasons}}

Add-only judge expectations:

- Prefer add-only maintenance when the failure looks like a missing lesson, missing exception, missing tool note, missing execution reminder, or missing output-discipline reminder.
- Be cautious about starting add-only maintenance when the core rule chain appears fundamentally wrong or structurally broken.
- If add-only maintenance is recommended, guide it toward narrow additive targets such as lessons, local addenda, exceptions, notes, or tool guides.
- If the evidence suggests that only broad rewrites would help, you may recommend not starting the maintainer in this method.
`,
    created,
  )

  await writeIfMissing(path.join(methodRecipesRoot, "adversarial-test", "METHOD.md"), DEFAULT_ADVERSARIAL_METHOD, created)
  await writeIfMissing(path.join(methodRecipesRoot, "adversarial-test", "FLOW.md"), DEFAULT_ADVERSARIAL_FLOW, created)
  await writeIfMissing(
    path.join(methodRecipesRoot, "adversarial-test", "prompts", "bootstrap.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "adversarial-test", "prompts", "solve.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "adversarial-test", "prompts", "adversarial_probe.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "adversarial-test", "prompts", "maintain_extension.md"),
    `# Adversarial-Test Maintenance Extension

Status: scaffold only

- This method-specific maintenance extension is reserved for the future adversarial-test strategy.
- When the runtime for this method is implemented, it should decide which session execution reports and probe reports are most useful to provide to the knowledge maintainer agent.
`,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "adversarial-test", "prompts", "judge_extension.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodRecipesRoot, "adversarial-test", "prompts", "select.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )

  await writeIfMissing(autoEvolvePath(cwd, "task-packs", "templates", "case.example.json"), DEFAULT_CASE_EXAMPLE, created)
  await writeIfMissing(
    autoEvolvePath(cwd, "task-packs", "templates", "long-task.example.json"),
    DEFAULT_LONG_TASK_EXAMPLE,
    created,
  )
  await writeIfMissing(
    autoEvolvePath(cwd, "scripts", "long-task-validator.example.py"),
    DEFAULT_LONG_TASK_VALIDATOR_EXAMPLE,
    created,
  )
  await writeIfMissing(autoEvolvePath(cwd, "dataset", "cases", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "scripts", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runtime-state", "runs", ".gitkeep"), "\n", created)

  return {
    autoEvolveRoot: root,
    created,
  }
}

export async function listCaseDirectories(cwd: string, config: AutoEvolveConfig) {
  const root = autoEvolvePath(cwd, config.datasetDir)
  if (!(await pathExists(root))) return []

  const entries = await readdir(root, { withFileTypes: true })
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
  const results: string[] = []

  for (const directory of directories) {
    if (await pathExists(caseMetadataPath(directory))) results.push(directory)
  }

  return results
}

export function runDirectory(cwd: string, config: AutoEvolveConfig, runID: string) {
  return autoEvolvePath(cwd, config.runsDir, runID)
}
