import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { cp, lstat, mkdir, readdir, rm, stat } from "node:fs/promises"
import { resolveModelSelection } from "../model-selection"
import { runOpencodeTask } from "../opencode"
import { loadConfig } from "../schema"
import { autoEvolvePath, ensureDirectory, pathExists, writeJsonFile } from "../fs"
import { writeTaskArtifacts } from "../task-artifacts"
import { loadLongTaskSpec } from "../long-task/spec"
import { isolateLongTaskRuntimePaths, resolveLongTaskEditablePaths } from "../long-task/repository"
import { runValidationStage } from "../validation-engine/stage-runner"
import type { LongTaskSpec, LongTaskWorkUnit } from "../long-task/contract"
import { experienceWorkspacePathsFromRoot, resolveExperienceWorkspaceLayout } from "../experience-workspace"
import { cleanupRuntimeProcessScope } from "../runtime-process-registry"
import type { BlankEvalInput, BlankEvalResult } from "./contract"

function nowISO() {
  return new Date().toISOString()
}

function stamp(title: string) {
  const now = new Date()
  const p = (value: number, width = 2) => String(value).padStart(width, "0")
  const tag =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "blank-eval"
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${p(now.getMilliseconds(), 3)}-${tag}`
}

function short(text: string, limit = 260) {
  const norm = text.replace(/\s+/g, " ").trim()
  if (norm.length <= limit) return norm
  return norm.slice(0, limit - 3) + "..."
}

function bullet(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none"
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

function refs(refs: { path: string; label?: string; role?: string }[]) {
  if (!refs.length) return "- none"
  return refs
    .map((item) => {
      const label = [item.label, item.role].filter(Boolean).join(", ")
      return label ? `- ${item.path} (${label})` : `- ${item.path}`
    })
    .join("\n")
}

function caps(spec: LongTaskSpec) {
  if (!spec.capabilities?.length) return "- none"
  return spec.capabilities
    .map((item) =>
      [
        `- id: ${item.id}`,
        `  title: ${item.title}`,
        `  kind: ${item.kind}`,
        `  description: ${item.description.trim()}`,
        item.referencePaths?.length ? `  reference_paths: ${item.referencePaths.join(", ")}` : "",
        item.attachedFiles?.length ? `  attached_files: ${item.attachedFiles.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n")
}

function capRefs(spec: LongTaskSpec) {
  return unique((spec.capabilities ?? []).flatMap((item) => item.referencePaths ?? []))
}

function capFiles(spec: LongTaskSpec) {
  return unique((spec.capabilities ?? []).flatMap((item) => item.attachedFiles ?? []))
}

function guidance(spec: LongTaskSpec, specPath: string) {
  const dir = path.dirname(specPath)
  const names = new Set(["human-guidance.md", "instruction.md"])
  return unique([
    ...spec.materials.map((item) => item.path).filter((item) => names.has(path.basename(item).toLowerCase())),
    path.join(dir, "human-guidance.md"),
    path.join(dir, "instruction.md"),
  ])
}

async function existing(items: string[]) {
  const out: string[] = []
  for (const item of unique(items)) {
    if (await pathExists(item)) out.push(item)
  }
  return out
}

async function entrypoints(roots: string[]) {
  const out: string[] = []
  for (const root of unique(roots)) {
    if (!(await pathExists(root))) continue
    try {
      const layout = await resolveExperienceWorkspaceLayout(experienceWorkspacePathsFromRoot(root, "manifest.md"))
      out.push(layout.entryPath, ...layout.documents.map((item) => item.absolutePath))
    } catch {
      continue
    }
  }
  return unique(out)
}

async function reset(root: string, spec: LongTaskSpec) {
  const raw = [...(spec.editablePaths ?? []), ...(spec.targetPaths ?? []).map((item) => item.path)]
  const dirs = unique(raw.map((item) => path.resolve(item))).sort((a, b) => a.length - b.length)
  const targets: string[] = []
  for (const dir of dirs) {
    if (targets.some((item) => dir === item || dir.startsWith(item + path.sep))) continue
    targets.push(dir)
  }
  const archive = path.join(root, "preexisting")
  await ensureDirectory(archive)
  for (const [index, target] of targets.entries()) {
    if (!(await pathExists(target))) {
      await ensureDirectory(path.extname(target) ? path.dirname(target) : target)
      continue
    }
    const dst = path.join(archive, `${String(index + 1).padStart(2, "0")}-${path.basename(target) || "editable"}`)
    const info = await lstat(target)
    await cp(target, dst, { recursive: info.isDirectory(), force: true })
    if (info.isDirectory()) {
      await rm(target, { recursive: true, force: true })
      await ensureDirectory(target)
      continue
    }
    await rm(target, { force: true })
    await ensureDirectory(path.dirname(target))
  }
}

function hasUnicode(text: string) {
  return /[^\x00-\x7F]/.test(text)
}

async function winpath(input: string) {
  if (process.platform !== "win32") return input
  if (!hasUnicode(input)) return input
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = '${input.replace(/'/g, "''")}'`,
    "if (Test-Path -LiteralPath $p) {",
    "(Get-Item -LiteralPath $p).FullName",
    "} else {",
    "$p",
    "}",
  ].join("; ")
  const child = Bun.spawn(["powershell", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code === 0) return stdout.trim()
  return input
}

function unit(spec: LongTaskSpec): LongTaskWorkUnit {
  return {
    id: "blank-eval-run",
    title: "Blank Agent Evaluation Run",
    goal: spec.goal,
    inputs: spec.materials.map((item) => item.path),
    dependsOn: [],
    expectedArtifacts: (spec.targetPaths ?? []).map((item) => item.path),
    claim: "The blank agent completed the declared task outputs.",
    checkPlan: "Run validators against the declared output contract.",
    validatorIDs: spec.validators.filter((item) => item.required !== false).map((item) => item.id),
    retryBudget: 1,
    status: "active",
    attemptCount: 1,
  }
}

function prompt(input: {
  spec: LongTaskSpec
  skillRoots: string[]
  entries: string[]
  bundlePath: string
  mode: string
  inline: string[]
  unicode: boolean
}) {
  const lines = [
    "You are completing a task in a clean workspace.",
    "",
    "Task instructions:",
    input.spec.goal.trim(),
    "",
    "Reference guidance folders:",
    bullet(input.skillRoots),
    "",
    "Suggested guidance entry files:",
    bullet(input.entries),
    "",
    "Task materials:",
    refs(input.spec.materials),
    "",
    "Required output targets:",
    refs(input.spec.targetPaths ?? []),
    "",
    "Editable paths:",
    bullet(resolveLongTaskEditablePaths(input.spec)),
    "",
    "Registered helper capabilities:",
    caps(input.spec),
    "",
    "Working rules:",
    "- Use the listed reference guidance, materials, helper assets, and declared workspace/output paths to complete the task.",
    "- Do not browse unrelated project, runtime, cache, history, private answer, or old output folders.",
    "- Do not create or repair the reference guidance unless the requested output explicitly asks for that.",
    "- Treat the reference guidance as practical task guidance. It may be incomplete, so use the materials to resolve details.",
    "- Materials can be large. Read only what is useful, but cite concrete source locations when the task calls for evidence.",
    "- Write final artifacts only to the declared output targets or editable paths.",
    "- Before returning, perform reasonable self-checks derived only from the listed inputs.",
    "",
    "Task metadata path:",
    input.bundlePath,
  ]

  if (input.inline.length) {
    lines.push("", "Files already inlined into this startup prompt:", bullet(input.inline))
  }
  if (input.unicode) {
    lines.push(
      "",
      "Windows path note:",
      "- Some paths contain non-ASCII characters. Preserve paths exactly and use UTF-8 aware tools when reading archives or Office files.",
    )
  }

  lines.push(
    "",
    "Return JSON only:",
    "```json",
    JSON.stringify(
      {
        claim_statement: "short description of completed task outputs",
        claimed_success: true,
        blockers: [],
        self_checks_run: [],
        updated_files: [],
      },
      null,
      2,
    ),
    "```",
  )

  return lines.join("\n")
}

async function snapshot(root: string, spec: LongTaskSpec, timedOut: boolean) {
  const dir = path.join(root, "partial-artifacts")
  await mkdir(dir, { recursive: true })
  const entries: { path: string; exists: boolean; sizeBytes?: number; error?: string }[] = []
  for (const ref of spec.targetPaths ?? []) {
    try {
      const exists = await pathExists(ref.path)
      entries.push(exists ? { path: ref.path, exists, sizeBytes: Number((await stat(ref.path)).size) } : { path: ref.path, exists })
    } catch (err) {
      entries.push({ path: ref.path, exists: false, error: String(err) })
    }
  }
  await writeJsonFile(path.join(dir, "stall-summary.json"), { snapshotAt: nowISO(), timedOut, entries })
}

function shouldCopySkillEntry(name: string) {
  const lower = name.toLowerCase()
  if (!name || name.startsWith(".")) return false
  if (lower === "node_modules" || lower === "__pycache__") return false
  if (lower === "temp" || lower === "tmp" || lower === "cache") return false
  if (lower.includes(".opencode") || lower.includes(".runtime")) return false
  if (lower.includes("cache") || lower.includes("temp")) return false
  return true
}

async function copyCleanSkillRoot(sourceRoot: string, targetRoot: string) {
  await ensureDirectory(targetRoot)
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!shouldCopySkillEntry(entry.name)) continue
    if (entry.isSymbolicLink()) continue
    const source = path.join(sourceRoot, entry.name)
    const target = path.join(targetRoot, entry.name)
    if (entry.isDirectory()) {
      await copyCleanSkillRoot(source, target)
      continue
    }
    if (entry.isFile()) {
      await ensureDirectory(path.dirname(target))
      await cp(source, target, { force: true })
    }
  }
}

async function prepareCleanSkillRoots(sourceRoots: string[], cleanRoot: string) {
  const out: string[] = []
  await ensureDirectory(cleanRoot)
  for (const [index, sourceRoot] of unique(sourceRoots).entries()) {
    if (!(await pathExists(sourceRoot))) continue
    const safeName =
      path.basename(sourceRoot)
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "skill-root"
    const targetRoot = path.join(cleanRoot, `${String(index + 1).padStart(2, "0")}-${safeName}`)
    await copyCleanSkillRoot(sourceRoot, targetRoot)
    out.push(targetRoot)
  }
  return unique(out)
}

export async function runBlankEval(input: BlankEvalInput): Promise<BlankEvalResult> {
  const config = await loadConfig(input.cwd)
  const loaded = await loadLongTaskSpec(input.specPath, { allowMissingInitialExpertContextPaths: true })
  const title = input.title ?? loaded.spec.title
  const runID = `blank-eval-${stamp(title)}`
  const root = input.runRoot ?? autoEvolvePath(input.cwd, "runtime-state", "blank-eval-runs")
  const runDir = path.join(root, runID)
  const spec = isolateLongTaskRuntimePaths({
    spec: loaded.spec,
    sourceSpecPath: loaded.specPath,
    runtimeRoot: path.join(runDir, "task-workspace"),
  })
  const bundlePath = path.join(runDir, "blank_eval_bundle.json")
  const validatorRoot = path.join(runDir, "validators")
  const sessionDir = path.join(runDir, "session")
  const cleanSkillRoot = path.join(runDir, "clean-skill-roots")
  const resultPath = path.join(runDir, "blank_eval_result.json")
  const scope = input.runtimeScope ?? `blank-eval:${runID}`

  try {
    await ensureDirectory(runDir)
    await ensureDirectory(validatorRoot)

    const sourceSkillRoots = unique(input.skillRoots.map((item) => path.resolve(item)))
    const skillRoots = await prepareCleanSkillRoots(sourceSkillRoots, cleanSkillRoot)
    const entries = await entrypoints(skillRoots)
    const guides = await existing([...(input.promptInlinePaths ?? []), ...guidance(spec, loaded.specPath)])
    const cRefs = capRefs(spec)
    const cFiles = capFiles(spec)
    const edits = unique([...resolveLongTaskEditablePaths(spec), ...(spec.targetPaths ?? []).map((item) => item.path)])
    const reads = unique([
      ...skillRoots,
      ...entries,
      ...spec.materials.map((item) => item.path),
      ...guides,
      ...cRefs,
      ...cFiles,
      ...edits,
    ])
    const norm = new Map<string, string>()
    for (const item of reads) {
      const got = await winpath(item)
      if (got !== item) norm.set(item, got)
    }
    const fix = (item: string) => norm.get(item) ?? item

    if (input.resetEditablePaths !== false) await reset(runDir, spec)

    await writeJsonFile(bundlePath, {
      schema: "blank-eval/v1",
      runID,
      sourceID: input.sourceID,
      mode: input.mode ?? "deployment",
      specPath: loaded.specPath,
      sourceSkillRoots,
      skillRoots,
      skillEntryPoints: entries,
      materials: spec.materials,
      targetPaths: spec.targetPaths ?? [],
      editablePaths: edits,
      createdAt: nowISO(),
      forbiddenRuntimeInputs: [
        "campaign-working-memory.json",
        "routing-control.json",
        "exploration-tree.json",
        "retry_input_bundle.json",
        "coordinator-state.json",
        "validator_input.json",
        "result.json",
        "answer/answer.md",
        "private-answers",
      ],
    })

    const selection = resolveModelSelection(config, "solve", spec.execution)
    const abort = new AbortController()
    const poll = (async () => {
      while (!abort.signal.aborted) {
        await sleep(10_000)
        if (abort.signal.aborted) break
        const clean = await cleanupRuntimeProcessScope(scope)
        if (clean.killedCount > 0) abort.abort()
      }
    })()

    const task = await (async () => {
      try {
        return await runOpencodeTask({
          cwd: input.cwd,
          config,
          title: `Blank Eval ${title}`,
          prompt: prompt({
            spec,
            skillRoots: skillRoots.map(fix),
            entries: entries.map(fix),
            bundlePath: fix(bundlePath),
            mode: input.mode ?? "deployment",
            inline: guides.map(fix),
            unicode: norm.size > 0,
          }),
          referencePaths: reads.map(fix),
          attachedFiles: cFiles.map(fix),
          promptInlineFiles: guides.map(fix),
          permissionReadPaths: reads.map(fix),
          permissionEditPaths: edits.map(fix),
          model: selection.model,
          agent: selection.agent,
          variant: selection.variant,
          injectPlatformSafetyRules: false,
          runtimeScope: scope,
          concurrencyScope: input.concurrencyScope,
          live: {
            stageDir: sessionDir,
            phase: "blank_eval",
            taskKind: "blank_eval",
            methodID: spec.reversePropagation?.recipeID,
          },
          signal: abort.signal,
        })
      } finally {
        abort.abort()
        await poll.catch(() => undefined)
      }
    })()

    const artifacts = await writeTaskArtifacts(sessionDir, task, {
      phase: "blank_eval",
      taskKind: "blank_eval",
      methodID: spec.reversePropagation?.recipeID,
    })
    if ((task.result as { timedOut?: boolean }).timedOut) await snapshot(runDir, spec, true)

    const work = unit(spec)
    const payload = {
      runID,
      unitID: work.id,
      attempt: 1,
      goal: spec.goal,
      claim: work.claim,
      checkPlan: work.checkPlan,
      materials: spec.materials,
      targetPaths: spec.targetPaths ?? [],
      expectedArtifacts: work.expectedArtifacts,
      editablePaths: edits,
      bundlePath,
    }

    const postBlankValidators = spec.validators.map((validator) => ({
      ...validator,
      validation: {
        ...validator.validation,
        stage: validator.validation?.stage ?? "post_blank",
        target: validator.validation?.target ?? "product",
      },
    }))
    const validationStage = await runValidationStage({
      cwd: input.cwd,
      config,
      spec,
      unit: work,
      stage: "post_blank",
      targets: ["product", "behavior", "regression"],
      runID,
      attempt: 1,
      stageDir: validatorRoot,
      bundlePath,
      payload,
      runtimeScope: scope,
      validators: postBlankValidators,
    })
    const validators: BlankEvalResult["validatorResults"] = validationStage.validatorResults

    const required = validators.filter((item) => spec.validators.find((v) => v.id === item.validatorID)?.required !== false)
    const passed = required.every((item) => item.passed)
    const summary = passed
      ? "Blank eval passed."
      : short(required.filter((item) => !item.passed).map((item) => item.summary).join(" | "))
    const result = {
      schema: "blank-eval-result/v1",
      runID,
      sourceID: input.sourceID,
      mode: input.mode ?? "deployment",
      passed,
      summary,
      validatorResults: validators,
      validationStageResultPath: validationStage.resultPath,
      sessionExecutionReportPath: artifacts.sessionExecutionReportPath,
      createdAt: nowISO(),
    }
    await writeJsonFile(resultPath, result)
    await ensureDirectory(path.join(runDir, "final-acceptance"))
    await writeJsonFile(path.join(runDir, "final-acceptance", "result.json"), result)
    await writeJsonFile(path.join(runDir, "run.json"), {
      runID,
      status: passed ? "passed" : "failed",
      passed,
      specPath: loaded.specPath,
      skillRoots,
      resultPath,
      sessionDir,
      validatorRoot,
      validationStageResultPath: validationStage.resultPath,
      createdAt: nowISO(),
    })

    return {
      runID,
      runDir,
      passed,
      summary,
      validatorResults: validators,
      sessionExecutionReportPath: artifacts.sessionExecutionReportPath,
      resultPath,
      validationStageResultPath: validationStage.resultPath,
    }
  } finally {
    const clean = await cleanupRuntimeProcessScope(scope)
    if (clean.remainingCount > 0) await cleanupRuntimeProcessScope(scope)
  }
}
