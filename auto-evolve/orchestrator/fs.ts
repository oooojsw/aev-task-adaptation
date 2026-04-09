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

async function writeKnowledgeFileIfMissing(
  target: string,
  fallbackContent: string,
  created: string[],
  legacySource?: string,
) {
  if (await pathExists(target)) return
  const content = legacySource && (await pathExists(legacySource)) ? await readTextFile(legacySource) : fallbackContent
  await writeTextFile(target, content)
  created.push(normalizeSlash(path.relative(process.cwd(), target) || target))
}

const DEFAULT_MANIFEST = `<!-- auto-evolve-bootstrap: replaceable -->
# 知识库总览

状态：零知识模板

## 作用

- 这套知识库是 auto-evolve 的持久专家经验。
- 新的 solve agent 应把这些 Markdown 文件当成唯一的长期记忆。
- 知识库默认使用中文编写，除非某个案例明确要求其他语言。

## 加载顺序

1. \`core/expert_rules.md\`
2. \`core/output_contract.md\`
3. \`core/execution_checklist.md\`
4. \`patterns/general_rules.md\`
5. \`patterns/exceptions.md\`
6. \`lessons/failure_lessons.md\`

## scripts 目录说明

- 可复用脚本位于 \`../scripts\`。
- scripts 用来提供能力，不是真正规则的来源。
- 规则和经验应继续保存在知识库 Markdown 中。

## 当前状态

- 当前知识库已被重置为零知识起点。
- 后续运行 \`bun run auto-evolve/cli.ts bootstrap --force --method sequential-refine\` 后，系统会重新生成第一版专家经验。
`

const DEFAULT_EXPERT_RULES = `<!-- auto-evolve-bootstrap: replaceable -->
# 核心专家规则

状态：零知识模板

## 当前说明

- 这里用于存放任务级别的通用专家经验。
- 当前内容已清空，等待 bootstrap 或后续 refine 逐步补充。
- 默认使用中文编写。
`

const DEFAULT_OUTPUT_CONTRACT = `<!-- auto-evolve-bootstrap: replaceable -->
# 输出约束

状态：零知识模板

## 当前说明

- 这里用于定义输出格式和输出纪律。
- 包括但不限于：
  - 是否必须精确匹配
  - 是否只能输出 JSON
  - 是否禁止解释性文字
- 当前内容已清空，等待后续生成。
`

const DEFAULT_EXECUTION_CHECKLIST = `<!-- auto-evolve-bootstrap: replaceable -->
# 执行清单

状态：零知识模板

## 当前说明

- 这里用于存放 solve agent 的标准执行步骤。
- 比如：
  - 先读哪些文件
  - 先做哪种判断
  - 输出前做什么检查
- 当前内容已清空，等待后续生成。
`

const DEFAULT_GENERAL_RULES = `<!-- auto-evolve-bootstrap: replaceable -->
# 通用规则

状态：零知识模板

## 当前说明

- 这里用于记录可复用的通用转换规律。
- 应优先记录可泛化的规则，而不是案例死记硬背。
- 当前内容已清空，等待后续生成。
`

const DEFAULT_EXCEPTIONS = `<!-- auto-evolve-bootstrap: replaceable -->
# 特例规则

状态：零知识模板

## 当前说明

- 这里用于记录狭窄、明确、可解释的特例。
- 特例应尽量少，并且要和通用规则区分开。
- 当前内容已清空，等待后续生成。
`

const DEFAULT_FAILURE_LESSONS = `<!-- auto-evolve-bootstrap: replaceable -->
# 失败教训

状态：零知识模板

## 当前说明

- 这里用于记录稳定的失败模式和反例经验。
- 只有真正有长期价值的失败教训才应写入这里。
- 当前内容已清空，等待后续生成。
`

const DEFAULT_CHANGE_LOG = `# 变更记录

- 知识库已重置为零知识中文模板。
`

const DEFAULT_SEQUENTIAL_METHOD = `# Method: Sequential Refine

Status: active baseline

## Purpose

- This is the current baseline learning method for auto-evolve.
- It keeps the existing loop intact:
  - bootstrap
  - solve
  - evaluate
  - refine
  - retry

## Notes

- This method should remain available as the default control baseline.
- Prompt instructions live under \`prompts/\`.
- Future methods should be added beside this one rather than replacing it.
`

const DEFAULT_SEQUENTIAL_BOOTSTRAP_PROMPT = `You are initializing the persistent expert experience for the auto-evolve system.

Your target is a Markdown knowledge pack.

{{knowledge_pack_block}}

Also read the user baseline file:
{{baseline_block}}

You may inspect reusable helper scripts here if they are relevant:
- {{scripts_dir}}

Task:
1. Study the listed labeled training cases by reading them from their paths.
2. Distill stable, reusable expert experience from those material/result pairs.
3. Create or replace the knowledge-pack files above by using file-editing tools inside this repository.

Requirements for the knowledge pack:
- The file paths listed in this prompt are paths only. Their contents are not preloaded for you.
- You must explicitly use \`read\` and \`list\` to inspect the files and directories you need.
- Write Markdown only.
- Write the knowledge-pack content in Chinese by default unless a case explicitly requires another language.
- Keep the rules in the knowledge-pack documents, not in TypeScript and not in the scripts library.
- Do not blindly copy the baseline file into the knowledge pack; only keep ideas that survive the labeled evidence.
- Preserve a clear separation of responsibility across files:
  - \`manifest.md\` explains purpose and load order.
  - \`core/expert_rules.md\` holds mission-level reusable expert guidance.
  - \`core/output_contract.md\` defines exact output discipline.
  - \`core/execution_checklist.md\` defines repeatable solve steps.
  - \`patterns/general_rules.md\` holds reusable transformation rules.
  - \`patterns/exceptions.md\` holds narrow, justified exceptions.
  - \`lessons/failure_lessons.md\` holds stable anti-patterns and failure lessons.
- Do not merely memorize raw answers or case IDs unless that information is genuinely reusable.
- Make the output-contract file explicit enough that a future solve agent understands that exact-match cases fail if it prints any explanation or extra characters.
- Keep the guidance practical enough that a fresh future solve agent can follow it without seeing prior chats.
- Do not edit dataset files or the scripts library.

Labeled training cases by path:
{{case_blocks}}

After updating the knowledge pack, reply with 3 to 6 short bullet points summarizing what you wrote and which files you changed. Do not paste the full files into chat.
`

const DEFAULT_SEQUENTIAL_SOLVE_PROMPT = `You are the fresh solve agent for one auto-evolve case.

Before solving, read the current knowledge pack:
{{knowledge_pack_block}}

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
- Use the knowledge pack as your only persistent memory.
- You may use the baseline file as optional user-provided context, but do not treat it as guaranteed truth.
- Do not use \`bash\`, web tools, or subagents for this task.
- Do not modify any files.
- Do not update any knowledge-pack file.
- Read files by exact path if you need more detail.
- Think silently; do not print your reasoning.
- Return only the final answer content, with no explanation, no markdown fences, and no prefatory text.
- This response is checked by an exact raw-string comparator. For text_exact cases, one extra character, label, quote, or explanation is a failure.
- If the answer is "ac", your entire response must be exactly: ac
`

const DEFAULT_SEQUENTIAL_REFINE_PROMPT = `You are updating the persistent expert experience after a failed solve attempt.

Your target is the Markdown knowledge pack:
{{knowledge_pack_block}}

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

{{refine_routing_block}}

Task:
1. Read the current knowledge pack files.
2. Read the failure context.
3. Read the simplified solve action trace so you understand what the agent actually tried.
4. Update one or more knowledge-pack files in place by using file-editing tools.

Refinement rules:
- Only file paths are provided in this prompt. File contents are not preloaded.
- You must explicitly use \`read\` and \`list\` to inspect the files and directories you need.
- Preserve still-useful knowledge.
- Keep the knowledge-pack content in Chinese by default unless the task explicitly requires another language.
- Treat the baseline file as user-provided context, not as proof.
- Add or revise only the lessons that help a fresh future solve agent avoid this failure.
- Prefer small, generalizable corrections over case-specific memorization.
- If the previous knowledge pack already contains the right rule, strengthen or clarify it instead of duplicating it.
- If the failure happened because the solve agent printed explanations instead of only the answer, strengthen the output-discipline section so exact-match cases return only the bare answer.
- Use the action trace to capture the solve agent's real behavior, not just the final mismatch.
- Prefer targeted file updates:
  - mission-level reusable guidance -> \`core/expert_rules.md\`
  - exact output discipline -> \`core/output_contract.md\`
  - repeatable procedure -> \`core/execution_checklist.md\`
  - reusable transformation rules -> \`patterns/general_rules.md\`
  - justified narrow special cases -> \`patterns/exceptions.md\`
  - recurring anti-patterns and lessons -> \`lessons/failure_lessons.md\`
- Update \`manifest.md\` only if the structure, load order, or file responsibilities need clarification.
- Do not use \`bash\`, web tools, or subagents for this task.
- Do not edit dataset files or the scripts library.

After updating the knowledge pack, reply with 3 to 6 short bullet points summarizing the failure lesson you added or revised and which files you changed. Do not paste the full files into chat.
`

const DEFAULT_ADVERSARIAL_METHOD = `# Method: Adversarial Test

Status: scaffold only

## Purpose

- This method will be used as the second learning route beside the baseline sequential method.
- Its role is to actively probe the current knowledge pack, expose weak spots, and turn those weak spots into stronger refinement signals.

## Intended Flow

- solve
- evaluate
- adversarial probe
- refine
- retry

## Current Status

- This method is documented here so the project can grow without rewriting the main system.
- Runtime support is not wired yet.
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
  "knowledgeDir": "knowledge-pack",
  "methodsDir": "methods",
  "baselineFile": "baseline.md",
  "splitFile": "dataset/SPLIT.md",
  "scriptsDir": "scripts",
  "runsDir": "runs",
  "modelConfigFile": "model-config.json",
  "permissionConfigFile": "permission-config.json",
  "monitorConfigFile": "monitor-config.json",
  "defaultMethod": "sequential-refine",
  "maxRetriesPerCase": 3,
  "roundCaseLimit": 5,
  "regressionSampleSize": 3
}
`

const DEFAULT_MODEL_CONFIG_JSON = `{
  "version": 1,
  "defaults": {
    "model": "google/gemma-3-4b-it"
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

export async function ensureLayout(cwd: string): Promise<LayoutResult> {
  const created: string[] = []
  const root = autoEvolvePath(cwd)
  const knowledgePackRoot = autoEvolvePath(cwd, "knowledge-pack")
  const methodsRoot = autoEvolvePath(cwd, "methods")

  const directories = [
    root,
    autoEvolvePath(cwd, "dataset"),
    autoEvolvePath(cwd, "dataset", "cases"),
    knowledgePackRoot,
    path.join(knowledgePackRoot, "core"),
    path.join(knowledgePackRoot, "patterns"),
    path.join(knowledgePackRoot, "lessons"),
    autoEvolvePath(cwd, "runs"),
    autoEvolvePath(cwd, "scripts"),
    methodsRoot,
    path.join(methodsRoot, "sequential-refine"),
    path.join(methodsRoot, "sequential-refine", "prompts"),
    path.join(methodsRoot, "adversarial-test"),
    path.join(methodsRoot, "adversarial-test", "prompts"),
    autoEvolvePath(cwd, "templates"),
  ]

  for (const directory of directories) {
    if (!(await pathExists(directory))) {
      await ensureDirectory(directory)
      created.push(normalizeSlash(path.relative(cwd, directory) || directory))
    }
  }

  await writeIfMissing(autoEvolvePath(cwd, "config.json"), DEFAULT_CONFIG_JSON, created)
  await writeIfMissing(autoEvolvePath(cwd, "model-config.json"), DEFAULT_MODEL_CONFIG_JSON, created)
  await writeIfMissing(autoEvolvePath(cwd, "monitor-config.json"), DEFAULT_MONITOR_CONFIG_JSON, created)
  await writeIfMissing(autoEvolvePath(cwd, "baseline.md"), DEFAULT_BASELINE, created)
  await writeIfMissing(autoEvolvePath(cwd, "dataset", "SPLIT.md"), DEFAULT_SPLIT, created)
  await writeKnowledgeFileIfMissing(path.join(knowledgePackRoot, "manifest.md"), DEFAULT_MANIFEST, created)
  await writeKnowledgeFileIfMissing(
    path.join(knowledgePackRoot, "core", "expert_rules.md"),
    DEFAULT_EXPERT_RULES,
    created,
    autoEvolvePath(cwd, "knowledge", "expert_rules.md"),
  )
  await writeKnowledgeFileIfMissing(
    path.join(knowledgePackRoot, "core", "output_contract.md"),
    DEFAULT_OUTPUT_CONTRACT,
    created,
  )
  await writeKnowledgeFileIfMissing(
    path.join(knowledgePackRoot, "core", "execution_checklist.md"),
    DEFAULT_EXECUTION_CHECKLIST,
    created,
  )
  await writeKnowledgeFileIfMissing(
    path.join(knowledgePackRoot, "patterns", "general_rules.md"),
    DEFAULT_GENERAL_RULES,
    created,
  )
  await writeKnowledgeFileIfMissing(
    path.join(knowledgePackRoot, "patterns", "exceptions.md"),
    DEFAULT_EXCEPTIONS,
    created,
  )
  await writeKnowledgeFileIfMissing(
    path.join(knowledgePackRoot, "lessons", "failure_lessons.md"),
    DEFAULT_FAILURE_LESSONS,
    created,
    autoEvolvePath(cwd, "knowledge", "failure_notes.md"),
  )
  await writeKnowledgeFileIfMissing(
    path.join(knowledgePackRoot, "change_log.md"),
    DEFAULT_CHANGE_LOG,
    created,
    autoEvolvePath(cwd, "knowledge", "change_log.md"),
  )
  await writeIfMissing(path.join(methodsRoot, "sequential-refine", "METHOD.md"), DEFAULT_SEQUENTIAL_METHOD, created)
  await writeIfMissing(
    path.join(methodsRoot, "sequential-refine", "prompts", "bootstrap.md"),
    DEFAULT_SEQUENTIAL_BOOTSTRAP_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodsRoot, "sequential-refine", "prompts", "solve.md"),
    DEFAULT_SEQUENTIAL_SOLVE_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodsRoot, "sequential-refine", "prompts", "refine.md"),
    DEFAULT_SEQUENTIAL_REFINE_PROMPT,
    created,
  )
  await writeIfMissing(path.join(methodsRoot, "adversarial-test", "METHOD.md"), DEFAULT_ADVERSARIAL_METHOD, created)
  await writeIfMissing(
    path.join(methodsRoot, "adversarial-test", "prompts", "bootstrap.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodsRoot, "adversarial-test", "prompts", "solve.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodsRoot, "adversarial-test", "prompts", "adversarial_probe.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodsRoot, "adversarial-test", "prompts", "refine.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(
    path.join(methodsRoot, "adversarial-test", "prompts", "select.md"),
    DEFAULT_ADVERSARIAL_PROMPT,
    created,
  )
  await writeIfMissing(autoEvolvePath(cwd, "templates", "case.example.json"), DEFAULT_CASE_EXAMPLE, created)
  await writeIfMissing(autoEvolvePath(cwd, "dataset", "cases", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "scripts", ".gitkeep"), "\n", created)
  await writeIfMissing(autoEvolvePath(cwd, "runs", ".gitkeep"), "\n", created)

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
