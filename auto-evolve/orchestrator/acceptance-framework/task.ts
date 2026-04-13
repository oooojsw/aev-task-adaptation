import path from "node:path"
import { randomUUID } from "node:crypto"
import { cp, lstat, rm } from "node:fs/promises"
import { resolveModelSelection } from "../model-selection"
import { runOpencodeTask } from "../opencode"
import { loadConfig } from "../schema"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile, writeTextFile } from "../fs"
import { writeTaskArtifacts } from "../task-artifacts"
import { loadLongTaskSpec } from "../long-task/spec"
import { runLongTaskValidator } from "../long-task/validators"
import type { LongTaskSpec, LongTaskWorkUnit, LongTaskValidatorResult } from "../long-task/contract"
import { recordAcceptanceResult } from "./run"

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

function capabilityReferencePaths(spec: LongTaskSpec) {
  return uniqueStrings((spec.capabilities ?? []).flatMap((capability) => capability.referencePaths ?? []))
}

function capabilityAttachedFiles(spec: LongTaskSpec) {
  return uniqueStrings((spec.capabilities ?? []).flatMap((capability) => capability.attachedFiles ?? []))
}

function deploymentRunID(title: string) {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "deployment"
  return `${stamp}-${slug}`
}

async function resetEditablePaths(runDir: string, spec: LongTaskSpec) {
  const editablePaths = uniqueStrings([...(spec.editablePaths ?? []), ...(spec.targetPaths ?? []).map((item) => item.path)])
  const archiveRoot = path.join(runDir, "preexisting")
  await ensureDirectory(archiveRoot)

  for (const [index, editablePath] of editablePaths.entries()) {
    if (!(await pathExists(editablePath))) {
      const parent = path.dirname(editablePath)
      if (parent && parent !== editablePath) await ensureDirectory(parent)
      continue
    }

    const archivePath = path.join(archiveRoot, `${String(index + 1).padStart(2, "0")}-${path.basename(editablePath) || "editable"}`)
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

function buildBlankAgentTaskPrompt(input: { spec: LongTaskSpec; formalSurfaceRoots: string[]; bundlePath: string }) {
  return [
    "You are running a highest-level blank-agent deployment acceptance task.",
    "",
    "Global goal:",
    input.spec.goal.trim(),
    "",
    "Formal expert surface roots:",
    bullet(input.formalSurfaceRoots),
    "",
    "Initial expert context entry points:",
    bullet(input.spec.initialExpertContextPaths ?? []),
    "",
    "Task materials:",
    describePathRefs(input.spec.materials),
    "",
    "Target output paths:",
    describePathRefs(input.spec.targetPaths ?? []),
    "",
    "Editable paths:",
    bullet(input.spec.editablePaths ?? []),
    "",
    "Registered capabilities:",
    describeCapabilities(input.spec),
    "",
    "Deployment rules:",
    "- Treat yourself as a blank agent. You may only use the formal expert surface, the provided materials, and the attached capability assets.",
    "- Do not assume access to runtime-state, shadow memory, maintenance requests, candidate packages, previous run artifacts, or hidden system memory.",
    "- Start from the declared expert entry points and read only what you actually need.",
    "- If the formal expert surface includes failure lessons, exception modules, task routers, or execution checklists, treat them as first-class operational guidance rather than optional notes.",
    "- You may use helper scripts or skill assets only if they are part of the declared formal surface or registered capabilities.",
    "- If a registered external skill or capability asset cannot be loaded directly because of runtime or tooling issues, you may create a task-local fallback only inside the allowed editable surface by copying the minimal permitted instructions/scripts you actually need, or by authoring an equivalent local helper.",
    "- Do not modify any user-wide or hidden global skill stores, runtime registries, or external installations.",
    "- You must finish in one uninterrupted session.",
    "- Leave validator-ready outputs at the declared target paths.",
    "- External acceptance validators exist, but their hidden criteria, reference data, and internal configurations are not available to you during deployment execution.",
    "- Before returning, run only local self-checks that you can derive from the formal expert surface, the provided materials, and the declared capability assets.",
    "- If you are blocked, say so explicitly instead of claiming success.",
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
  ].join("\n")
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
  const { spec, specPath } = await loadLongTaskSpec(input.deploymentSpecPath)
  const runID = `deployment-${deploymentRunID(spec.title)}`
  const runDir = path.join(input.harnessRoot, runID)
  const bundlePath = path.join(runDir, "deployment_bundle.json")
  const validatorBundleDir = path.join(runDir, "validators")
  const executeDir = path.join(runDir, "session")
  const selection = resolveModelSelection(config, "solve", spec.execution)
  const capabilityPaths = capabilityReferencePaths(spec)
  const capabilityFiles = capabilityAttachedFiles(spec)

  await ensureDirectory(runDir)
  await ensureDirectory(validatorBundleDir)
  await resetEditablePaths(runDir, spec)

  await writeJsonFile(bundlePath, {
    runID,
    sourceRunID: input.sourceRunID,
    deploymentSpecPath: specPath,
    formalSurfaceRoots: input.formalSurfaceRoots,
    targetKind: input.targetKind,
    targetID: input.targetID,
    createdAt: nowISO(),
  })

  const prompt = buildBlankAgentTaskPrompt({
    spec,
    formalSurfaceRoots: input.formalSurfaceRoots,
    bundlePath,
  })

  const task = await runOpencodeTask({
    cwd: input.cwd,
    config,
    title: `Blank Agent Deployment ${spec.title}`,
    prompt,
    referencePaths: uniqueStrings([
      ...input.formalSurfaceRoots,
      ...(spec.initialExpertContextPaths ?? []),
      ...spec.materials.map((item) => item.path),
      ...(spec.targetPaths ?? []).map((item) => item.path),
      ...capabilityPaths,
    ]),
    attachedFiles: capabilityFiles,
    permissionReadPaths: uniqueStrings([
      ...input.formalSurfaceRoots,
      ...(spec.initialExpertContextPaths ?? []),
      ...spec.materials.map((item) => item.path),
      ...(spec.targetPaths ?? []).map((item) => item.path),
      ...capabilityPaths,
    ]),
    permissionEditPaths: spec.editablePaths ?? [],
    model: selection.model,
    agent: selection.agent,
    variant: selection.variant,
  })

  const artifactPaths = await writeTaskArtifacts(executeDir, task, {
    phase: "deployment_acceptance",
    taskKind: "deployment_acceptance",
    methodID: spec.reversePropagation?.recipeID,
  })

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
    editablePaths: spec.editablePaths ?? [],
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
    })
    validatorResults.push(result)
  }

  const passed = validatorResults.every((item) => item.passed)
  const summary = passed
    ? "Blank-agent task deployment acceptance passed."
    : short(validatorResults.filter((item) => !item.passed).map((item) => item.summary).join(" | "), 260)
  const reason = passed
    ? "All required deployment validators passed."
    : validatorResults.find((item) => !item.passed)?.summary ?? "Deployment validators failed."
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
}

export async function readValidatorPayload(target: string) {
  return readJsonFile<Record<string, unknown>>(target)
}
