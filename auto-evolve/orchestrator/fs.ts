import path from "node:path"
import { existsSync, realpathSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import type { AutoEvolveConfig } from "./schema"
import { writeJsonAtomic } from "./atomic-write"

export interface LayoutResult {
  autoEvolveRoot: string
  created: string[]
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function normalizeComparePath(input: string) {
  const normalized = normalizeSlash(path.resolve(input)).replace(/\/+$/g, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function resolvePathTruth(target: string) {
  const absoluteTarget = path.resolve(target)
  const missingSegments: string[] = []
  let probe = absoluteTarget
  while (true) {
    if (existsSync(probe)) {
      try {
        const resolved = realpathSync.native(probe)
        return missingSegments.length ? path.join(resolved, ...missingSegments.reverse()) : resolved
      } catch {
        return absoluteTarget
      }
    }
    const parent = path.dirname(probe)
    if (parent === probe) return absoluteTarget
    missingSegments.push(path.basename(probe))
    probe = parent
  }
}

export function isPathWithinTruthRoot(root: string, candidate: string) {
  const normalizedRoot = normalizeComparePath(resolvePathTruth(root))
  const normalizedCandidate = normalizeComparePath(resolvePathTruth(candidate))
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

export function autoEvolvePath(cwd: string, ...segments: string[]) {
  const resolved = path.resolve(cwd)
  const base = path.basename(resolved).toLowerCase() === "auto-evolve" ? resolved : path.join(resolved, "auto-evolve")
  return resolvePathTruth(path.join(base, ...segments))
}

function normalizeRuntimeRootCandidate(input: string | undefined) {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return path.resolve(trimmed)
}

export function runtimeRoot(cwd: string) {
  const fromEnv = normalizeRuntimeRootCandidate(process.env.AUTO_EVOLVE_RUNTIME_ROOT)
  if (fromEnv) return resolvePathTruth(fromEnv)
  return autoEvolvePath(cwd, ".runtime")
}

export function runtimePath(cwd: string, ...segments: string[]) {
  return resolvePathTruth(path.join(runtimeRoot(cwd), ...segments))
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

export type ReadJsonFileOptions = {
  salvage?: "none" | "extract-object"
  validatePaths?: boolean
}

function looksLikePathKey(key: string) {
  const lower = key.toLowerCase()
  return (
    lower === "path" ||
    lower.endsWith("path") ||
    lower.endsWith("paths") ||
    lower.includes("dir") ||
    lower.includes("root") ||
    lower.includes("file")
  )
}

function looksLikeWindowsAbsolutePath(value: string) {
  return /(^|[\s"'`])[A-Za-z]:[\\/]/.test(value)
}

function hasControlChars(value: string) {
  return /[\r\n\t]/.test(value)
}

function assertNoSuspiciousPathControls(value: unknown, source: string, keyPath: string[] = []) {
  if (typeof value === "string") {
    const key = keyPath[keyPath.length - 1] ?? ""
    const pathish = looksLikePathKey(key) || looksLikeWindowsAbsolutePath(value)
    if (pathish && hasControlChars(value)) {
      throw new Error(
        `Cannot read ${normalizeSlash(source)}: suspicious control character in path-like field ${keyPath.join(".")}. ` +
          "Use escaped Windows paths like C:\\\\dir\\\\file.json or forward slashes like C:/dir/file.json.",
      )
    }
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSuspiciousPathControls(item, source, [...keyPath, String(index)]))
    return
  }

  if (!value || typeof value !== "object") return

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    assertNoSuspiciousPathControls(raw, source, [...keyPath, key])
  }
}

export async function readJsonFile<T = any>(target: string, options: ReadJsonFileOptions = {}): Promise<T> {
  const raw = await readTextFile(target)
  const cleaned = raw.replace(/^\uFEFF/, "").trim()
  if (!cleaned) {
    throw new Error(`Cannot read ${target}: empty or BOM-only JSON file`)
  }
  try {
    const parsed = JSON.parse(cleaned) as T
    if (options.validatePaths !== false) assertNoSuspiciousPathControls(parsed, target)
    return parsed
  } catch (parseError) {
    if (options.salvage === "extract-object") {
      const { extractJsonObject } = await import("./long-task/json-extract")
      const salvaged = extractJsonObject(cleaned)
      if (salvaged) {
        if (options.validatePaths !== false) assertNoSuspiciousPathControls(salvaged, target)
        console.warn(`[warn] ${target}: JSON corrupted (${(parseError as Error).message}), salvaged first valid object`)
        return salvaged as T
      }
    }
    // Attempt salvage 2: strip invalid escape sequences (e.g. \Ԫ, \非, or \e in paths)
    /*
    const stripped = cleaned.replace(/\\([^"\\/bfnrtu])/g, "$1")
    if (stripped !== cleaned) {
      try {
        const result = JSON.parse(stripped) as T
        console.warn(`[warn] ${target}: JSON had invalid escapes, stripped and parsed OK`)
        return result
      } catch {
        salvaged = extractJsonObject(stripped)
        if (salvaged) {
          console.warn(`[warn] ${target}: invalid escapes + extractJsonObject salvage succeeded`)
          return salvaged as T
        }
      }
    }
    // Attempt salvage 3: \r\n\t in Windows paths (LLM agents often write \path\runtime instead of \\path\\runtime)
    // Replace \r \n \t with their literal character equivalents to un-break path-like content
    const deEscaped = cleaned.replace(/\\r/g, "\r").replace(/\\n/g, "\n").replace(/\\t/g, "\t")
    if (deEscaped !== cleaned) {
      try {
        const result = JSON.parse(deEscaped) as T
        console.warn(`[warn] ${target}: JSON had literal \\r\\n\\t in paths, de-escaped and parsed OK`)
        return result
      } catch {
        salvaged = extractJsonObject(deEscaped)
        if (salvaged) {
          console.warn(`[warn] ${target}: de-escape + extractJsonObject salvage succeeded`)
          return salvaged as T
        }
      }
    }
    // If salvage also fails, throw a clear error
    */
    throw new Error(`Cannot read ${target}: ${(parseError as Error).message}`)
  }
}

export async function writeTextFile(target: string, content: string) {
  await ensureDirectory(path.dirname(target))
  await writeFile(target, content, "utf8")
}

export async function writeJsonFile(target: string, value: unknown) {
  await writeJsonAtomic(target, value)
}
function normalizeJsonStringForWindowsPath(value: string): string {
  if (looksLikeWindowsAbsolutePath(value) || /[A-Za-z]:[\/\\]/.test(value)) {
    return value.replace(/\\/g, "/")
  }
  return value
}

function normalizeJsonObjectForWindowsPaths(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeJsonStringForWindowsPath(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonObjectForWindowsPaths(item))
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = normalizeJsonObjectForWindowsPaths(val)
    }
    return result
  }
  return value
}

export async function writeValidatorInputJson(target: string, value: unknown) {
  const normalized = normalizeJsonObjectForWindowsPaths(value)
  await writeJsonAtomic(target, normalized)
}

async function writeIfMissing(target: string, content: string, created: string[]) {
  if (await pathExists(target)) return
  await writeTextFile(target, content)
  created.push(normalizeSlash(path.relative(process.cwd(), target) || target))
}

async function writeInitAssetIfMissing(cwd: string, target: string, assetRelativePath: string, created: string[]) {
  if (await pathExists(target)) return
  const source = autoEvolvePath(cwd, "init-assets", ...assetRelativePath.split("/"))
  const content = await readFile(source, "utf8")
  await writeTextFile(target, content)
  created.push(normalizeSlash(path.relative(process.cwd(), target) || target))
}


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

  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "config.json"), "config.json", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "model-config.json"), "model-config.json", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "judge-config.json"), "judge-config.json", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "monitor-config.json"), "monitor-config.json", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "baseline.md"), "baseline.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "dataset", "SPLIT.md"), "dataset/SPLIT.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "prompts", "knowledge-maintainer-core.md"), "prompts/knowledge-maintainer-core.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "prompts", "soft-judge-core.md"), "prompts/soft-judge-core.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "archive", "README.md"), "experience/archive/README.md", created)
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
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "methods", "propagation", "single-branch-baseline.md"), "methods/propagation/single-branch-baseline.md", created)
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

  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "README.md"), "experience/templates/README.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "entry-template.md"), "experience/templates/entry-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "rule-module-template.md"), "experience/templates/rule-module-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "exception-module-template.md"), "experience/templates/exception-module-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "output-contract-template.md"), "experience/templates/output-contract-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "execution-checklist-template.md"), "experience/templates/execution-checklist-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "failure-lessons-template.md"), "experience/templates/failure-lessons-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "tool-guide-template.md"), "experience/templates/tool-guide-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "partition-index-template.md"), "experience/templates/partition-index-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "experience", "templates", "task-router-template.md"), "experience/templates/task-router-template.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "methods", "reverse-propagation-modules", "direct-rewrite.md"), "methods/reverse-propagation-modules/direct-rewrite.md", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "methods", "reverse-propagation-modules", "add-only-memory.md"), "methods/reverse-propagation-modules/add-only-memory.md", created)
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
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "judge-skills", "exact-output", "scripts", "run.py"), "judge-skills/exact-output/scripts/run.py", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "judge-skills", "tool-failures", "scripts", "run.py"), "judge-skills/tool-failures/scripts/run.py", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "judge-skills", "session-behavior", "scripts", "run.py"), "judge-skills/session-behavior/scripts/run.py", created)

  await writeInitAssetIfMissing(cwd, path.join(knowledgePackRoot, "manifest.md"), "experience/workspace/manifest.md", created)
  await writeInitAssetIfMissing(cwd, path.join(knowledgePackRoot, "change_log.md"), "experience/workspace/change_log.md", created)

  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "sequential-refine", "METHOD.md"), "methods/recipes/sequential-refine/METHOD.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "sequential-refine", "FLOW.md"), "methods/recipes/sequential-refine/FLOW.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "sequential-refine", "prompts", "bootstrap.md"), "methods/recipes/sequential-refine/prompts/bootstrap.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "sequential-refine", "prompts", "solve.md"), "methods/recipes/sequential-refine/prompts/solve.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "sequential-refine", "prompts", "maintain_extension.md"), "methods/recipes/sequential-refine/prompts/maintain_extension.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "sequential-refine", "prompts", "judge_extension.md"), "methods/recipes/sequential-refine/prompts/judge_extension.md", created)

  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "add-only", "METHOD.md"), "methods/recipes/add-only/METHOD.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "add-only", "FLOW.md"), "methods/recipes/add-only/FLOW.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "add-only", "prompts", "bootstrap.md"), "methods/recipes/add-only/prompts/bootstrap.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "add-only", "prompts", "solve.md"), "methods/recipes/add-only/prompts/solve.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "add-only", "prompts", "maintain_extension.md"), "methods/recipes/add-only/prompts/maintain_extension.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "add-only", "prompts", "judge_extension.md"), "methods/recipes/add-only/prompts/judge_extension.md", created)

  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "adversarial-test", "METHOD.md"), "methods/recipes/adversarial-test/METHOD.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "adversarial-test", "FLOW.md"), "methods/recipes/adversarial-test/FLOW.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "adversarial-test", "prompts", "bootstrap.md"), "methods/recipes/adversarial-test/prompts/bootstrap.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "adversarial-test", "prompts", "solve.md"), "methods/recipes/adversarial-test/prompts/solve.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "adversarial-test", "prompts", "adversarial_probe.md"), "methods/recipes/adversarial-test/prompts/adversarial_probe.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "adversarial-test", "prompts", "maintain_extension.md"), "methods/recipes/adversarial-test/prompts/maintain_extension.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "adversarial-test", "prompts", "judge_extension.md"), "methods/recipes/adversarial-test/prompts/judge_extension.md", created)
  await writeInitAssetIfMissing(cwd, path.join(methodRecipesRoot, "adversarial-test", "prompts", "select.md"), "methods/recipes/adversarial-test/prompts/select.md", created)

  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "task-packs", "templates", "case.example.json"), "task-packs/templates/case.example.json", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "task-packs", "templates", "long-task.example.json"), "task-packs/templates/long-task.example.json", created)
  await writeInitAssetIfMissing(cwd, autoEvolvePath(cwd, "scripts", "long-task-validator.example.py"), "scripts/long-task-validator.example.py", created)
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
