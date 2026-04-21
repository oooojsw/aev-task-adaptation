import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { cp, lstat, rm, mkdir } from "node:fs/promises"
import { resolveModelSelection } from "../model-selection"
import { runOpencodeTask } from "../opencode"
import { loadConfig } from "../schema"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import { writeTaskArtifacts } from "../task-artifacts"
import { loadLongTaskSpec } from "../long-task/spec"
import { resolveLongTaskEditablePaths } from "../long-task/repository"
import { runLongTaskValidator } from "../long-task/validators"
import type { LongTaskSpec, LongTaskWorkUnit, LongTaskValidatorResult } from "../long-task/contract"
import { recordAcceptanceResult } from "./run"
import { experienceWorkspacePathsFromRoot, resolveExperienceWorkspaceLayout } from "../experience-workspace"
import { cleanupRuntimeProcessScope } from "../runtime-process-registry"

function hasNonAsciiChars(str: string) {
  return /[^\x00-\x7F]/.test(str)
}

async function writePartialArtifactSnapshot(runDir: string, spec: LongTaskSpec, timedOut: boolean) {
  const snapshotRoot = path.join(runDir, "partial-artifacts")
  await mkdir(snapshotRoot, { recursive: true })

  const entries: { path: string; exists: boolean; sizeBytes?: number; error?: string }[] = []

  for (const ref of spec.targetPaths ?? []) {
    try {
      const exists = await pathExists(ref.path)
      if (exists) {
        const stats = await lstat(ref.path)
        entries.push({ path: ref.path, exists: true, sizeBytes: Number(stats.size) })
      } else {
        entries.push({ path: ref.path, exists: false })
      }
    } catch (err) {
      entries.push({ path: ref.path, exists: false, error: String(err) })
    }
  }

  await writeJsonFile(path.join(snapshotRoot, "stall-summary.json"), {
    snapshotAt: nowISO(),
    timedOut,
    entries,
  })

  for (const ref of spec.targetPaths ?? []) {
    if (!(await pathExists(ref.path))) continue
    try {
      const targetBase = path.join(snapshotRoot, path.basename(ref.path))
      await cp(ref.path, targetBase, { force: true })
    } catch {}
  }
}

async function normalizePathForWindows(input: string): Promise<string> {
  if (process.platform !== "win32") return input
  if (!hasNonAsciiChars(input)) return input
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
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (exitCode === 0) return stdout.trim()
  return input
}

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

function bullet(items: string[]) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none"
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
}

function describePathRefs(refs: { path: string; label?: string; role?: string }[]) {
  if (!refs.length) return "- none"
  return refs
    .map((item) => {
      const labels = [item.label, item.role].filter(Boolean).join(", ")
      return labels ? `- ${item.path} (${labels})` : `- ${item.path}`
    })
    .join("\n")
}

function describeCapabilities(spec: LongTaskSpec) {
  if (!spec.capabilities?.length) return "- none"
  return spec.capabilities
    .map((capability) =>
      [
        `- id: ${capability.id}`,
        `  title: ${capability.title}`,
        `  kind: ${capability.kind}`,
        `  description: ${capability.description.trim()}`,
        capability.referencePaths?.length ? `  reference_paths: ${capability.referencePaths.join(", ")}` : "",
        capability.attachedFiles?.length ? `  attached_files: ${capability.attachedFiles.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n")
}

function describeEditablePaths(spec: LongTaskSpec) {
  return bullet(resolveLongTaskEditablePaths(spec))
}

function capabilityReferencePaths(spec: LongTaskSpec) {
  return uniqueStrings((spec.capabilities ?? []).flatMap((capability) => capability.referencePaths ?? []))
}

function capabilityAttachedFiles(spec: LongTaskSpec) {
  return uniqueStrings((spec.capabilities ?? []).flatMap((capability) => capability.attachedFiles ?? []))
}

function deploymentRunID(title: string) {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "deployment"
  return `${stamp}-${slug}`
}

async function resetEditablePaths(runDir: string, spec: LongTaskSpec) {
  const editablePaths = resolveLongTaskEditablePaths(spec)
  const archiveRoot = path.join(runDir, "preexisting")
  await ensureDirectory(archiveRoot)

  for (const [index, editablePath] of editablePaths.entries()) {
    if (!(await pathExists(editablePath))) {
      const parent = path.dirname(editablePath)
      if (parent && parent !== editablePath) await ensureDirectory(parent)
      continue
    }

    const archivePath = path.join(
      archiveRoot,
      `${String(index + 1).padStart(2, "0")}-${path.basename(editablePath) || "editable"}`,
    )
    const stats = await lstat(editablePath)
    await cp(editablePath, archivePath, { recursive: stats.isDirectory(), force: true })
    if (stats.isDirectory()) {
      await rm(editablePath, { recursive: true, force: true })
      await ensureDirectory(editablePath)
    } else {
      await rm(editablePath, { force: true })
    }
  }
}

async function deriveFormalSurfaceEntryPoints(formalSurfaceRoots: string[]) {
  const entryPoints: string[] = []

  for (const root of uniqueStrings(formalSurfaceRoots)) {
    if (!(await pathExists(root))) continue
    try {
      const layout = await resolveExperienceWorkspaceLayout(experienceWorkspacePathsFromRoot(root, "manifest.md"))
      entryPoints.push(layout.entryPath, ...layout.documents.map((item) => item.absolutePath))
    } catch {
      continue
    }
  }

  return uniqueStrings(entryPoints)
}

function buildBlankAgentTaskPrompt(input: {
  spec: LongTaskSpec
  formalSurfaceRoots: string[]
  resolvedInitialExpertContextPaths: string[]
  bundlePath: string
  hasNonAscii?: boolean
}) {
  const lines = [
    "You are running a highest-level blank-agent deployment acceptance task.",
    "",
    "Global goal:",
    input.spec.goal.trim(),
    "",
    "Formal expert surface roots:",
    bullet(input.formalSurfaceRoots),
    "",
    "Resolved expert context entry points:",
    bullet(input.resolvedInitialExpertContextPaths),
    "",
    "Task materials:",
    describePathRefs(input.spec.materials),
    "",
    "Target output paths:",
    describePathRefs(input.spec.targetPaths ?? []),
    "",
    "Editable paths:",
    describeEditablePaths(input.spec),
    "",
    "Registered capabilities:",
    describeCapabilities(input.spec),
    "",
    "Deployment rules:",
    "- Treat yourself as a blank agent. You may only use the formal expert surface, the provided materials, and the attached capability assets.",
    "- Do not assume access to runtime-state, shadow memory, maintenance requests, candidate packages, previous run artifacts, or hidden system memory.",
    "- Start from the resolved expert entry points and the formal surface contract, then read only what you actually need.",
    "- If the formal expert surface includes failure lessons, exception modules, task routers, or execution checklists, treat them as first-class operational guidance rather than optional notes.",
    "- You may use helper scripts or skill assets only if they are part of the declared formal surface or registered capabilities.",
    "- If a registered external skill or capability asset cannot be loaded directly because of runtime or tooling issues, you may create a task-local fallback only inside the allowed editable surface by copying the minimal permitted instructions/scripts you actually need, or by authoring an equivalent local helper.",
    "- Do not modify any user-wide or hidden global skill stores, runtime registries, or external installations.",
    "- Document, spreadsheet, and template handling must be headless-only. Do not launch Word, Excel, Explorer, or any other desktop GUI application.",
    "- Do not use Start-Process, Invoke-Item, file association opens, explorer.exe, WINWORD, EXCEL, or equivalent GUI-launch paths.",
    "- You must finish in one uninterrupted session.",
    "- Leave validator-ready outputs at the declared target paths.",
    "- External acceptance validators exist, but their hidden criteria, reference data, and internal configurations are not available to you during deployment execution.",
    "- Before returning, run only local self-checks that you can derive from the formal expert surface, the provided materials, and the declared capability assets.",
    "- If you are blocked, say so explicitly instead of claiming success.",
  ]

  if (input.hasNonAscii) {
    lines.push(
      "",
      "IMPORTANT — Non-ASCII path encoding:",
      "- One or more file paths contain non-ASCII characters (Chinese, Unicode).",
      "- When using ADM-ZIP (or any ZIP library) to read/write DOCX files on Windows, always use UTF-8 encoding explicitly.",
      "- For Node.js fs operations, use Buffer.from(encodedPath, 'utf-8') or ensure the path is passed as a Buffer for non-ASCII segments.",
      "- Do NOT rely on the platform default codepage (CP437/CP1252) for file paths with Chinese characters.",
      "- If a path looks corrupted in logs, re-encode it as UTF-8 before passing to ZIP operations.",
    )
  }

  lines.push(
    "",
    "Return JSON only, with this shape:",
    "```json",
    JSON.stringify(
      {
        claim_statement: "one short sentence describing the deployment result",
        claimed_success: true,
        blockers: ["optional blocker"],
        self_checks_run: ["validator or local check you ran"],
        updated_files: ["absolute/path/you/changed"],
      },
      null,
      2,
    ),
    "```",
  )

  return lines.join("\n")
}

function syntheticDeploymentUnit(spec: LongTaskSpec): LongTaskWorkUnit {
  return {
    id: "deployment-run",
    title: "Blank-Agent Deployment Run",
    goal: spec.goal,
    inputs: spec.materials.map((item) => item.path),
    dependsOn: [],
    expectedArtifacts: (spec.targetPaths ?? []).map((item) => item.path),
    claim: "The blank-agent deployment run completed and left validator-ready outputs.",
    checkPlan: "Run all required deployment validators against the current outputs.",
    validatorIDs: spec.validators.filter((item) => item.required !== false).map((item) => item.id),
    retryBudget: 1,
    status: "active",
    attemptCount: 1,
  }
}

export async function runBlankAgentSingleSessionTaskAcceptance(input: {
  cwd: string
  sourceRunID: string
  targetKind: "deployment_run" | "candidate_experience" | "canonical_experience"
  targetID: string
  deploymentSpecPath: string
  formalSurfaceRoots: string[]
  harnessRoot: string
  policyID?: string
}) {
  const config = await loadConfig(input.cwd)
  const { spec, specPath, missingInitialExpertContextPaths } = await loadLongTaskSpec(input.deploymentSpecPath, {
    allowMissingInitialExpertContextPaths: true,
  })
  const runID = `deployment-${deploymentRunID(spec.title)}`
  const runtimeScope = `deployment:${runID}`
  const runDir = path.join(input.harnessRoot, runID)
  const bundlePath = path.join(runDir, "deployment_bundle.json")
  const validatorBundleDir = path.join(runDir, "validators")
  const executeDir = path.join(runDir, "session")
  try {
    const selection = resolveModelSelection(config, "solve", spec.execution)
    const capabilityPaths = capabilityReferencePaths(spec)
    const capabilityFiles = capabilityAttachedFiles(spec)

    const derivedEntryPoints = await deriveFormalSurfaceEntryPoints(input.formalSurfaceRoots)
    const resolvedInitialExpertContextPaths = uniqueStrings([
      ...(spec.initialExpertContextPaths ?? []),
      ...derivedEntryPoints,
    ])

    await ensureDirectory(runDir)
    await ensureDirectory(validatorBundleDir)
    await resetEditablePaths(runDir, spec)

    await writeJsonFile(bundlePath, {
      runID,
      sourceRunID: input.sourceRunID,
      deploymentSpecPath: specPath,
      formalSurfaceRoots: input.formalSurfaceRoots,
      resolvedInitialExpertContextPaths,
      missingInitialExpertContextPaths,
      targetKind: input.targetKind,
      targetID: input.targetID,
      createdAt: nowISO(),
    })

    const editablePaths = resolveLongTaskEditablePaths(spec)

    const allPathsForNorm = uniqueStrings([
      ...input.formalSurfaceRoots,
      ...resolvedInitialExpertContextPaths,
      ...spec.materials.map((item) => item.path),
      ...(spec.targetPaths ?? []).map((item) => item.path),
      ...capabilityPaths,
    ])
    const normalizedPathsMap: Map<string, string> = new Map()
    for (const p of allPathsForNorm) {
      const normalized = await normalizePathForWindows(p)
      if (normalized !== p) normalizedPathsMap.set(p, normalized)
    }
    function normPath(p: string) {
      return normalizedPathsMap.get(p) ?? p
    }

    const hasNonAscii = normalizedPathsMap.size > 0
    const prompt = buildBlankAgentTaskPrompt({
      spec,
      formalSurfaceRoots: input.formalSurfaceRoots,
      resolvedInitialExpertContextPaths,
      bundlePath,
      hasNonAscii,
    })

    const abortController = new AbortController()
    const pollIntervalMs = 10_000
    const pollPromise = (async () => {
      while (!abortController.signal.aborted) {
        await sleep(pollIntervalMs)
        if (abortController.signal.aborted) break
        const cleanup = await cleanupRuntimeProcessScope(runtimeScope)
        if (cleanup.killedCount > 0) {
          abortController.abort()
          break
        }
      }
    })()

    let task: Awaited<ReturnType<typeof runOpencodeTask>>
    let taskTimedOut = false

    try {
      task = await runOpencodeTask({
        cwd: input.cwd,
        config,
        title: `Blank Agent Deployment ${spec.title}`,
        prompt,
        referencePaths: uniqueStrings(allPathsForNorm.map(normPath)),
        attachedFiles: capabilityFiles,
        permissionReadPaths: uniqueStrings(allPathsForNorm.map(normPath)),
        permissionEditPaths: editablePaths,
        model: selection.model,
        agent: selection.agent,
        variant: selection.variant,
        runtimeScope,
        live: {
          stageDir: executeDir,
          phase: "deployment_acceptance",
          taskKind: "deployment_acceptance",
          methodID: spec.reversePropagation?.recipeID,
        },
        signal: abortController.signal,
      })
    } catch (err) {
      abortController.abort()
      await pollPromise.catch(() => {})
      throw err
    }
    taskTimedOut = (task.result as { timedOut?: boolean }).timedOut ?? false
    abortController.abort()
    await pollPromise.catch(() => {})

    const artifactPaths = await writeTaskArtifacts(executeDir, task, {
      phase: "deployment_acceptance",
      taskKind: "deployment_acceptance",
      methodID: spec.reversePropagation?.recipeID,
    })

    if (taskTimedOut) {
      await writePartialArtifactSnapshot(runDir, spec, taskTimedOut)
    }

    const unit = syntheticDeploymentUnit(spec)
    const validatorPayload = {
      runID,
      unitID: unit.id,
      attempt: 1,
      goal: spec.goal,
      claim: unit.claim,
      checkPlan: unit.checkPlan,
      materials: spec.materials,
      targetPaths: spec.targetPaths ?? [],
      expectedArtifacts: unit.expectedArtifacts,
      editablePaths,
      bundlePath,
    }

    const validatorResults: LongTaskValidatorResult[] = []
    for (const validator of spec.validators) {
      const result = await runLongTaskValidator({
        cwd: input.cwd,
        config,
        contract: validator,
        spec,
        unit,
        runID,
        attempt: 1,
        validatorDir: path.join(validatorBundleDir, validator.id),
        bundlePath,
        payload: validatorPayload,
        runtimeScope,
      })
      validatorResults.push(result)
    }

    const passed = validatorResults.every((item) => item.passed)
    const summary = passed
      ? "Blank-agent task deployment acceptance passed."
      : short(
          validatorResults
            .filter((item) => !item.passed)
            .map((item) => item.summary)
            .join(" | "),
          260,
        )
    const reason = passed
      ? "All required deployment validators passed."
      : (validatorResults.find((item) => !item.passed)?.summary ?? "Deployment validators failed.")
    const reasons = passed
      ? []
      : uniqueStrings(
          validatorResults
            .filter((item) => !item.passed)
            .flatMap((item) => [item.summary, ...item.details])
            .map((item) => short(item, 200)),
        ).slice(0, 10)

    const record = await recordAcceptanceResult({
      cwd: input.cwd,
      config,
      sourceRunID: input.sourceRunID,
      mode: "deployment",
      policyID: input.policyID ?? "blank-agent-single-session-task-gate",
      stageID: "deployment_guard",
      targetKind: input.targetKind,
      targetID: input.targetID,
      passed,
      outcome: passed ? "promote" : "hold",
      summary,
      reason,
      reasons,
      evidenceRefs: uniqueStrings([
        artifactPaths.sessionExecutionReportPath,
        artifactPaths.responsePath,
        ...validatorResults.flatMap((item) => item.evidenceRefs),
      ]),
      details: {
        deploymentSpecPath: specPath,
        resolvedInitialExpertContextPaths,
        missingInitialExpertContextPaths,
        validatorCount: validatorResults.length,
        toolFailureCount: task.result.toolFailures.length,
        exitCode: task.result.exitCode,
        validators: validatorResults.map((item) => ({
          validatorID: item.validatorID,
          passed: item.passed,
          summary: item.summary,
        })),
      },
      notes: [
        "This deployment harness exposed only the formal expert surface, registered capability assets, and task materials.",
        "It did not expose runtime-state, shadow memory, candidate packages, or maintenance-request traces.",
      ],
      mirrorPath: path.join(runDir, "deployment_acceptance.json"),
    })

    await writeJsonFile(path.join(runDir, "deployment_run.json"), {
      runID,
      sourceRunID: input.sourceRunID,
      targetKind: input.targetKind,
      targetID: input.targetID,
      deploymentSpecPath: specPath,
      formalSurfaceRoots: input.formalSurfaceRoots,
      resolvedInitialExpertContextPaths,
      missingInitialExpertContextPaths,
      passed,
      summary,
      validatorResults,
      acceptanceRecordPath: record.path,
      createdAt: nowISO(),
    })

    return {
      runID,
      runDir,
      passed,
      summary,
      validatorResults,
      acceptanceRecordPath: record.path,
      sessionExecutionReportPath: artifactPaths.sessionExecutionReportPath,
    }
  } finally {
    const cleanup = await cleanupRuntimeProcessScope(runtimeScope)
    if (cleanup.remainingCount > 0) {
      await cleanupRuntimeProcessScope(runtimeScope)
    }
  }
}

export async function readValidatorPayload(target: string) {
  return readJsonFile<Record<string, unknown>>(target)
}
