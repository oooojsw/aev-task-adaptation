import path from "node:path"
import { loadConfig } from "../schema"
import { pathExists, readJsonFile, writeJsonFile } from "../fs"
import { loadLongTaskSpec } from "../long-task/spec"
import { recordAcceptanceResult } from "./run"
import { experienceWorkspacePathsFromRoot, resolveExperienceWorkspaceLayout } from "../experience-workspace"
import { runBlankEval } from "../blank-eval/runner"

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

function uniqueStrings(items: string[]) {
  return Array.from(new Set(items.filter((item) => item.trim().length > 0)))
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
  const runSeed = deploymentRunID(spec.title)
  const resolvedInitialExpertContextPaths = await deriveFormalSurfaceEntryPoints(input.formalSurfaceRoots)
  const result = await runBlankEval({
    cwd: input.cwd,
    specPath,
    skillRoots: input.formalSurfaceRoots,
    runRoot: input.harnessRoot,
    sourceID: input.targetID,
    mode: "deployment",
    runtimeScope: `deployment:${runSeed}`,
    resetEditablePaths: true,
  })
  const failed = result.validatorResults.filter((item) => !item.passed)
  const reason = result.passed
    ? "All required deployment validators passed."
    : (failed[0]?.summary ?? "Deployment validators failed.")
  const reasons = result.passed
    ? []
    : uniqueStrings(
        failed
          .flatMap((item) => [item.summary, ...item.details])
          .map((item) => short(item, 200)),
      ).slice(0, 10)
  const responsePath = path.join(result.runDir, "session", "response.txt")
  const record = await recordAcceptanceResult({
    cwd: input.cwd,
    config,
    sourceRunID: input.sourceRunID,
    mode: "deployment",
    policyID: input.policyID ?? "blank-agent-single-session-task-gate",
    stageID: "deployment_guard",
    targetKind: input.targetKind,
    targetID: input.targetID,
    passed: result.passed,
    outcome: result.passed ? "promote" : "hold",
    summary: result.summary,
    reason,
    reasons,
    evidenceRefs: uniqueStrings([
      result.sessionExecutionReportPath,
      result.resultPath,
      responsePath,
      ...result.validatorResults.flatMap((item) => item.evidenceRefs),
    ]),
    details: {
      deploymentSpecPath: specPath,
      resolvedInitialExpertContextPaths,
      missingInitialExpertContextPaths,
      validatorCount: result.validatorResults.length,
      validators: result.validatorResults.map((item) => ({
        validatorID: item.validatorID,
        passed: item.passed,
        summary: item.summary,
      })),
    },
    notes: [
      "This deployment harness exposed only the formal expert surface, registered capability assets, and task materials.",
      "It did not expose runtime-state, shadow memory, candidate packages, or maintenance-request traces.",
    ],
    mirrorPath: path.join(result.runDir, "deployment_acceptance.json"),
  })
  await writeJsonFile(path.join(result.runDir, "deployment_bundle.json"), {
    runID: result.runID,
    sourceRunID: input.sourceRunID,
    deploymentSpecPath: specPath,
    formalSurfaceRoots: input.formalSurfaceRoots,
    resolvedInitialExpertContextPaths,
    missingInitialExpertContextPaths,
    targetKind: input.targetKind,
    targetID: input.targetID,
    mode: "deployment",
    createdAt: nowISO(),
  })
  await writeJsonFile(path.join(result.runDir, "deployment_run.json"), {
    runID: result.runID,
    sourceRunID: input.sourceRunID,
    targetKind: input.targetKind,
    targetID: input.targetID,
    deploymentSpecPath: specPath,
    formalSurfaceRoots: input.formalSurfaceRoots,
    resolvedInitialExpertContextPaths,
    missingInitialExpertContextPaths,
    passed: result.passed,
    summary: result.summary,
    validatorResults: result.validatorResults,
    acceptanceRecordPath: record.path,
    sessionExecutionReportPath: result.sessionExecutionReportPath,
    createdAt: nowISO(),
  })
  return {
    runID: result.runID,
    runDir: result.runDir,
    passed: result.passed,
    summary: result.summary,
    validatorResults: result.validatorResults,
    acceptanceRecordPath: record.path,
    sessionExecutionReportPath: result.sessionExecutionReportPath,
  }
}

export async function readValidatorPayload(target: string) {
  return readJsonFile<Record<string, unknown>>(target)
}
