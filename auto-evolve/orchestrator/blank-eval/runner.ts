import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { cp, lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
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
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${p(now.getMilliseconds(), 3)}-${randomUUID().slice(0, 8)}-${tag}`
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

function safeName(input: string, fallback: string) {
  return (
    input
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || fallback
  )
}

function resolveFromSpecDir(specPath: string, value: string) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(path.dirname(specPath), value)
}

async function copyNoLinks(source: string, target: string, relativePath = path.basename(source)) {
  if (isSensitiveSandboxInputPath(source) || isSensitiveSandboxInputPath(relativePath)) {
    throw new Error(`Blank Eval sandbox refuses sensitive input path: ${source}`)
  }
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    throw new Error(`Blank Eval sandbox refuses symlink/junction input: ${source}`)
  }
  if (info.isDirectory()) {
    await ensureDirectory(target)
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".opencode" || entry.name === "node_modules") continue
      const childSource = path.join(source, entry.name)
      const childTarget = path.join(target, entry.name)
      await copyNoLinks(childSource, childTarget, path.join(relativePath, entry.name))
    }
    return
  }
  if (!info.isFile()) {
    throw new Error(`Blank Eval sandbox can only copy files/directories: ${source}`)
  }
  await ensureDirectory(path.dirname(target))
  await cp(source, target, { force: true })
}

async function copySandboxInput(input: {
  source: string
  targetRoot: string
  index: number
  specPath: string
  required: boolean
}) {
  const source = resolveFromSpecDir(input.specPath, input.source)
  if (!(await pathExists(source))) {
    if (input.required) throw new Error(`Blank Eval required input missing before sandbox copy: ${source}`)
    return undefined
  }
  const name = `${String(input.index + 1).padStart(2, "0")}-${safeName(path.basename(source), "input")}`
  const target = path.join(input.targetRoot, name)
  await copyNoLinks(source, target)
  return target
}

async function copyPathRefsToSandbox(
  refs: { path: string; label?: string; role?: string }[] | undefined,
  targetRoot: string,
  specPath: string,
  required: boolean,
) {
  const out: { path: string; label?: string; role?: string }[] = []
  for (const [index, ref] of (refs ?? []).entries()) {
    const copied = await copySandboxInput({ source: ref.path, targetRoot, index, specPath, required })
    if (copied) out.push({ ...ref, path: copied })
  }
  return out
}

async function materializeSpreadsheetRefsForBlankEval(
  refs: { path: string; label?: string; role?: string }[],
  cwd: string,
) {
  const out: { path: string; label?: string; role?: string }[] = []
  const scriptPath = autoEvolvePath(cwd, "scripts", "materialize-xlsx-for-direct-chat.py")
  if (!(await pathExists(scriptPath))) return out

  for (const ref of refs) {
    const ext = path.extname(ref.path).toLowerCase()
    if (ext !== ".xlsx" && ext !== ".xlsm") continue
    const target = path.join(path.dirname(ref.path), `${path.basename(ref.path)}.readable.json`)
    const child = Bun.spawn(
      [
        "python",
        scriptPath,
        "--xlsx",
        ref.path,
        "--max-sheets",
        "12",
        "--max-rows",
        "120",
        "--max-cols",
        "80",
      ],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0 || !stdout.trim()) {
      const detail = stderr.trim() || `exit code ${code}`
      throw new Error(`Blank Eval could not materialize spreadsheet input ${ref.path}: ${detail}`)
    }
    await writeFile(target, stdout.trim() + "\n", "utf8")
    out.push({
      path: target,
      label: `${ref.label ?? path.basename(ref.path)} readable workbook extraction`,
      role: "derived-source-artifact",
    })
  }
  return out
}

async function copyStringPathsToSandbox(paths: string[], targetRoot: string, specPath: string, required: boolean) {
  const out: string[] = []
  for (const [index, item] of unique(paths).entries()) {
    const copied = await copySandboxInput({ source: item, targetRoot, index, specPath, required })
    if (copied) out.push(copied)
  }
  return unique(out)
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

function resolvedPathKey(specPath: string, value: string) {
  return path.resolve(resolveFromSpecDir(specPath, value)).toLowerCase()
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

function isSandboxExcludedPath(item: string, sandboxRoot: string): boolean {
  const resolved = path.resolve(item)
  const resolvedRoot = path.resolve(sandboxRoot)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false
  const firstSegment = relative.split(path.sep)[0]
  return ["preexisting", "validators", "internal", ".runtime"].includes(firstSegment)
}

function filterSandboxExcludedPaths(items: string[], sandboxRoot: string): string[] {
  return items.filter((item) => !isSandboxExcludedPath(item, sandboxRoot))
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
  const resetRoot = path.resolve(root)
  const dirs = unique(raw.map((item) => path.resolve(item))).sort((a, b) => a.length - b.length)
  const targets: string[] = []
  for (const dir of dirs) {
    const relative = path.relative(resetRoot, dir)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Blank Eval reset refused path outside sandbox: ${dir}`)
    }
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
    "Output isolation rule:",
    "- The required output targets above are the only authoritative output locations for this evaluation.",
    "- Do not write to similarly named workspaces near the original task pack unless that exact path is listed above.",
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
    "- If an Office or spreadsheet binary has a matching readable extraction material, use the readable extraction first and treat it as derived from the original material.",
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

function isSensitiveSandboxInputPath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase()
  const parts = normalized.split("/").filter(Boolean)
  const blockedExact = new Set([
    "node_modules",
    "__pycache__",
    "temp",
    "tmp",
    "cache",
    "private-answers",
    "private-answer",
    "answer-key",
    "answer-keys",
    "ground-truth",
    "ground-truths",
    "validators",
    ".opencode",
    ".runtime",
  ])
  if (parts.some((part) => part.startsWith(".") || blockedExact.has(part))) return true
  if (parts.some((part) => part.includes(".opencode") || part.includes(".runtime"))) return true
  if (parts.some((part) => part.includes("private-answer") || part.includes("answer-key"))) return true
  if (parts.some((part) => part.includes("ground-truth") || part.includes("ground_truth"))) return true
  if (parts.some((part) => part.includes("validator_input") || part.includes("result.private"))) return true
  if (parts.some((part) => part.includes("cache") || part.includes("temp"))) return true
  const base = parts.at(-1) ?? ""
  if (base === "validator_input.json" || base === "result.private.json" || base === "result.json") return true
  return false
}

function shouldCopySkillEntry(name: string, relativePath = name) {
  if (!name) return false
  if (isSensitiveSandboxInputPath(relativePath)) return false
  return true
}

async function copyCleanSkillRoot(sourceRoot: string, targetRoot: string, relativeRoot = "") {
  await ensureDirectory(targetRoot)
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  for (const entry of entries) {
    const relativePath = relativeRoot ? path.join(relativeRoot, entry.name) : entry.name
    if (!shouldCopySkillEntry(entry.name, relativePath)) continue
    if (entry.isSymbolicLink()) continue
    const source = path.join(sourceRoot, entry.name)
    const target = path.join(targetRoot, entry.name)
    if (entry.isDirectory()) {
      await copyCleanSkillRoot(source, target, relativePath)
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
  const sandboxRoot = path.join(runDir, "sandbox")
  const sandboxMaterialsRoot = path.join(sandboxRoot, "materials")
  const sandboxGuidanceRoot = path.join(sandboxRoot, "guidance")
  const sandboxCapabilityRoot = path.join(sandboxRoot, "capabilities")
  const sandboxWorkspaceRoot = path.join(sandboxRoot, "workspace")
  const baseRuntimeSpec = isolateLongTaskRuntimePaths({
    spec: loaded.spec,
    sourceSpecPath: loaded.specPath,
    runtimeRoot: sandboxRoot,
  })
  const bundlePath = path.join(sandboxRoot, "bundle.json")
  const validatorRoot = path.join(runDir, "validators")
  const sessionDir = path.join(runDir, "session")
  const cleanSkillRoot = path.join(sandboxRoot, "skill")
  const resultPath = path.join(runDir, "blank_eval_result.json")
  const scope = input.runtimeScope ?? `blank-eval:${runID}`

  try {
    await ensureDirectory(runDir)
    await ensureDirectory(sandboxRoot)
    await ensureDirectory(sandboxMaterialsRoot)
    await ensureDirectory(sandboxGuidanceRoot)
    await ensureDirectory(sandboxCapabilityRoot)
    await ensureDirectory(sandboxWorkspaceRoot)
    await ensureDirectory(validatorRoot)

    const sourceSkillRoots = unique(input.skillRoots.map((item) => path.resolve(item)))
    const skillRoots = await prepareCleanSkillRoots(sourceSkillRoots, cleanSkillRoot)
    const copiedSandboxMaterials = await copyPathRefsToSandbox(
      baseRuntimeSpec.materials,
      sandboxMaterialsRoot,
      loaded.specPath,
      true,
    )
    const derivedSandboxMaterials = await materializeSpreadsheetRefsForBlankEval(copiedSandboxMaterials, input.cwd)
    const sandboxMaterials = [...copiedSandboxMaterials, ...derivedSandboxMaterials]
    const sandboxGuides = await copyStringPathsToSandbox(
      [...(input.promptInlinePaths ?? []), ...guidance(loaded.spec, loaded.specPath)],
      sandboxGuidanceRoot,
      loaded.specPath,
      false,
    )
    const capabilityRefSources = capRefs(baseRuntimeSpec)
    const capabilityFileSources = capFiles(baseRuntimeSpec)
    const sandboxCapabilityRefs = await copyStringPathsToSandbox(capabilityRefSources, sandboxCapabilityRoot, loaded.specPath, false)
    const sandboxCapabilityFiles = await copyStringPathsToSandbox(capabilityFileSources, sandboxCapabilityRoot, loaded.specPath, false)
    const capabilityRefMap = new Map<string, string>()
    for (const [index, source] of capabilityRefSources.entries()) {
      const copied = sandboxCapabilityRefs[index]
      if (copied) capabilityRefMap.set(resolvedPathKey(loaded.specPath, source), copied)
    }
    const capabilityFileMap = new Map<string, string>()
    for (const [index, source] of capabilityFileSources.entries()) {
      const copied = sandboxCapabilityFiles[index]
      if (copied) capabilityFileMap.set(resolvedPathKey(loaded.specPath, source), copied)
    }
    const spec: LongTaskSpec = {
      ...baseRuntimeSpec,
      materials: sandboxMaterials,
      capabilities: baseRuntimeSpec.capabilities?.map((item) => ({
        ...item,
        referencePaths: item.referencePaths
          ?.map((ref) => capabilityRefMap.get(resolvedPathKey(loaded.specPath, ref)))
          .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0),
        attachedFiles: item.attachedFiles
          ?.map((ref) => capabilityFileMap.get(resolvedPathKey(loaded.specPath, ref)))
          .filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0),
      })),
    }
    const entries = await entrypoints(skillRoots)
    const cRefs = capRefs(spec)
    const cFiles = capFiles(spec)
    const edits = unique([...resolveLongTaskEditablePaths(spec), ...(spec.targetPaths ?? []).map((item) => item.path)])
    const derivedMaterialPaths = derivedSandboxMaterials.map((item) => item.path)
    const inlineFiles = unique([...sandboxGuides, ...derivedMaterialPaths])
    const reads = unique([
      bundlePath,
      ...skillRoots,
      ...entries,
      ...spec.materials.map((item) => item.path),
      ...sandboxGuides,
      ...cRefs,
      ...cFiles,
      ...edits,
    ])
    const permissionReads = filterSandboxExcludedPaths(reads, sandboxRoot)
    const norm = new Map<string, string>()
    for (const item of reads) {
      const got = await winpath(item)
      if (got !== item) norm.set(item, got)
    }
    const fix = (item: string) => norm.get(item) ?? item

    if (input.resetEditablePaths !== false) await reset(sandboxRoot, spec)

    await writeJsonFile(bundlePath, {
      schema: "blank-eval/v1",
      runID,
      sourceID: input.sourceID,
      mode: input.mode ?? "deployment",
      skillRoots,
      skillEntryPoints: entries,
      materials: spec.materials,
      targetPaths: spec.targetPaths ?? [],
      editablePaths: edits,
      sandboxRoot,
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
    const task = await (async () => {
      try {
        return await runOpencodeTask({
          cwd: input.cwd,
          workDir: sandboxRoot,
          config,
          title: `Blank Eval ${title}`,
          prompt: prompt({
            spec,
            skillRoots: skillRoots.map(fix),
            entries: entries.map(fix),
            bundlePath: fix(bundlePath),
            mode: input.mode ?? "deployment",
            inline: inlineFiles.map(fix),
            unicode: norm.size > 0,
          }),
          referencePaths: reads.map(fix),
          attachedFiles: cFiles.map(fix),
          promptInlineFiles: inlineFiles.map(fix),
          permissionReadPaths: permissionReads.map(fix),
          permissionEditPaths: edits.map(fix),
          allowShell: false,
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
        })
      } finally {
        // Do not call cleanupRuntimeProcessScope while the blank agent is running.
        // runOpencodeTask registers its own OpenCode child process in this scope;
        // cleanupRuntimeProcessScope is a destructive terminator, not a liveness probe.
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
    const sessionInfrastructureFailure =
      (task.result.exitCode ?? 0) !== 0 || (task.result as { timedOut?: boolean }).timedOut === true
    const validatorInfrastructureFailure = required.some(
      (item) => !item.passed && item.failureKind === "validator_infrastructure",
    )
    const validatorDatasetFailure = required.some((item) => !item.passed && item.failureKind === "dataset_failure")
    const failureKind = passed
      ? undefined
      : validatorDatasetFailure
        ? ("dataset_failure" as const)
      : sessionInfrastructureFailure || validatorInfrastructureFailure
        ? ("validator_infrastructure" as const)
        : ("product_failure" as const)
    const summary = passed
      ? "Blank eval passed."
      : sessionInfrastructureFailure
        ? short(`Blank agent session infrastructure failed with exit code ${task.result.exitCode}. ${task.result.stderr ?? ""}`)
        : short(required.filter((item) => !item.passed).map((item) => item.summary).join(" | "))
    const result = {
      schema: "blank-eval-result/v1",
      runID,
      sourceID: input.sourceID,
      mode: input.mode ?? "deployment",
      passed,
      failureKind,
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
      failureKind,
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
      failureKind,
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
