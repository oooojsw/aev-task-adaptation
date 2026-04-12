import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  createAttemptContext,
  makeRunID,
  type CaseExecutionProfile,
  type LoadedAutoEvolveConfig,
} from "../case-runtime"
import type { CaseSpec, LoadedCase } from "../schema"
import { autoEvolvePath, ensureDirectory, readTextFile, writeJsonFile } from "../fs"
import {
  experienceWorkspacePathsFromRoot,
  readExperienceWorkspace,
  resolveExperienceWorkspaceLayout,
  templateLibraryPaths,
  writeExperienceWorkspaceSnapshot,
} from "../experience-workspace"
import { resolveMethodStrategy } from "../method-strategies"
import { resolveLocalLearningRecipe } from "../local-learning-recipes"
import { executeSolveStage } from "../primitive-ops/solve-stage"
import { loadConfig } from "../schema"
import type { AcceptanceOutcome, AcceptanceRecordStatus, AcceptanceTargetKind } from "./contract"
import {
  resolveAcceptanceHarness,
  resolveAcceptancePolicy,
  resolveAcceptancePolicyStage,
  resolveAcceptanceStandard,
} from "./registry"
import { acceptanceFrameworkPaths, writeAcceptanceRecord } from "./repository"

function nowISO() {
  return new Date().toISOString()
}

function short(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

function deriveAcceptanceStatus(input: { passed?: boolean; outcome: AcceptanceOutcome }): AcceptanceRecordStatus {
  if (input.outcome === "hold" || input.outcome === "archive_only") return "held"
  if (input.outcome === "observe") return "observed"
  if (input.passed === true) return "passed"
  if (input.passed === false) return "failed"
  if (input.outcome === "accept" || input.outcome === "promote") return "passed"
  return "failed"
}

export async function recordAcceptanceResult(input: {
  cwd: string
  config: Pick<LoadedAutoEvolveConfig, "acceptanceFrameworkDir">
  sourceRunID: string
  mode?: "short" | "long" | "batch" | "governance" | "deployment"
  policyID: string
  stageID: string
  targetKind: AcceptanceTargetKind
  targetID: string
  passed?: boolean
  outcome: AcceptanceOutcome
  summary: string
  reason: string
  reasons: string[]
  evidenceRefs?: string[]
  details?: Record<string, unknown> | null
  notes?: string[]
  mirrorPath?: string
}) {
  const policy = resolveAcceptancePolicy(input.policyID)
  const stage = resolveAcceptancePolicyStage(input.policyID, input.stageID)

  for (const standardID of stage.standardIDs) resolveAcceptanceStandard(standardID)
  for (const harnessID of stage.harnessIDs) resolveAcceptanceHarness(harnessID)
  return writeAcceptanceRecord(acceptanceFrameworkPaths(input.cwd, input.config), {
    id: `acceptance-${randomUUID().slice(0, 10)}`,
    sourceRunID: input.sourceRunID,
    mode: input.mode,
    policyID: policy.id,
    stageID: stage.id,
    level: stage.level,
    targetKind: input.targetKind,
    targetID: input.targetID,
    status: deriveAcceptanceStatus({ passed: input.passed, outcome: input.outcome }),
    outcome: input.outcome,
    summary: short(input.summary, 260),
    reason: short(input.reason, 220),
    reasons: input.reasons.map((item) => short(item, 220)).slice(0, 12),
    standardIDs: [...stage.standardIDs],
    harnessIDs: [...stage.harnessIDs],
    evidenceRefs: (input.evidenceRefs ?? []).filter((item) => item.trim().length > 0),
    details: input.details ?? null,
    notes: input.notes ?? [],
    mirrorPath: input.mirrorPath,
  })
}

export async function runBlankAgentSingleSessionCaseAcceptance(input: {
  cwd: string
  sourceRunID: string
  targetKind: AcceptanceTargetKind
  targetID: string
  workspaceRoot: string
  caseDir: string
  caseSpec: CaseSpec
  methodID?: string
  policyID?: string
  harnessRoot: string
  executionProfile?: CaseExecutionProfile
}) {
  const config = (await loadConfig(input.cwd)) as LoadedAutoEvolveConfig
  const recipe = resolveLocalLearningRecipe(input.methodID ?? config.defaultMethod)
  const strategy = resolveMethodStrategy(input.cwd, config, recipe.caseMethodID)
  const workspacePaths = experienceWorkspacePathsFromRoot(input.workspaceRoot, config.experienceEntryFile)
  const workspace = await resolveExperienceWorkspaceLayout(workspacePaths)
  const templateLibrary = await templateLibraryPaths(input.cwd, config)
  const baselinePath = autoEvolvePath(input.cwd, config.baselineFile)
  const scriptsDir = autoEvolvePath(input.cwd, config.scriptsDir)
  const expectedPath = path.join(input.caseDir, input.caseSpec.expected.path)
  const expectedText = await readTextFile(expectedPath)
  const loaded: LoadedCase = {
    caseDir: input.caseDir,
    casePath: path.join(input.caseDir, "case.json"),
    spec: input.caseSpec,
  }

  const runID = `deployment-${makeRunID(input.caseSpec.id)}`
  const runDir = path.join(input.harnessRoot, runID)
  await ensureDirectory(runDir)
  await ensureDirectory(path.join(runDir, "workspace_snapshot"))
  await writeExperienceWorkspaceSnapshot(path.join(runDir, "workspace_snapshot"), await readExperienceWorkspace(workspace))

  const attempts = []
  const context = createAttemptContext({
    cwd: input.cwd,
    config,
    methodID: recipe.caseMethodID,
    strategy,
    loaded,
    expectedPath,
    expectedText,
    workspacePaths,
    workspace,
    templateLibrary,
    baselinePath,
    scriptsDir,
    datasetSplit: {
      splitPath: "(deployment-harness)",
      train: [],
      test: [],
    },
    allCases: [loaded],
    mode: "eval",
    split: "all",
    executionProfile: input.executionProfile ?? "full",
    runDir,
    attempt: 1,
    attempts,
  })

  const solveStage = await executeSolveStage({
    context,
    stageDir: context.solveDir,
    title: `auto-evolve blank-agent deployment ${input.caseSpec.id}`,
    phase: "solve",
  })
  context.finalEvaluation = solveStage.evaluation

  const recordResult = await recordAcceptanceResult({
    cwd: input.cwd,
    config,
    sourceRunID: input.sourceRunID,
    mode: "deployment",
    policyID: input.policyID ?? "blank-agent-single-session-gate",
    stageID: "deployment_guard",
    targetKind: input.targetKind,
    targetID: input.targetID,
    passed: solveStage.evaluation.passed,
    outcome: solveStage.evaluation.passed ? "promote" : "hold",
    summary: solveStage.evaluation.summary,
    reason: solveStage.evaluation.passed
      ? "Blank-agent single-session harness passed."
      : solveStage.evaluation.mismatches[0] ?? "Blank-agent single-session harness failed.",
    reasons: solveStage.evaluation.passed ? [] : solveStage.evaluation.mismatches.slice(0, 8),
    evidenceRefs: [solveStage.sessionExecutionReportPath, path.join(context.solveDir, "evaluation.json")],
    details: {
      caseID: input.caseSpec.id,
      expectedMode: input.caseSpec.expected.mode,
      exitCode: solveStage.task.result.exitCode,
      toolFailureCount: solveStage.task.result.toolFailures.length,
    },
    notes: [
      "Blank-agent deployment harness used only the tracked expert workspace plus task materials.",
      "This harness did not invoke maintainer, judge, or transaction repair loops.",
    ],
    mirrorPath: path.join(runDir, "deployment_acceptance.json"),
  })

  await writeJsonFile(path.join(runDir, "deployment_run.json"), {
    runID,
    sourceRunID: input.sourceRunID,
    targetKind: input.targetKind,
    targetID: input.targetID,
    policyID: input.policyID ?? "blank-agent-single-session-gate",
    harnessID: "blank-agent-single-session-case",
    passed: solveStage.evaluation.passed,
    evaluation: solveStage.evaluation,
    sessionExecutionReportPath: solveStage.sessionExecutionReportPath,
    acceptanceRecordPath: recordResult.path,
    createdAt: nowISO(),
  })

  return {
    runID,
    runDir,
    evaluation: solveStage.evaluation,
    acceptanceRecordPath: recordResult.path,
    sessionExecutionReportPath: solveStage.sessionExecutionReportPath,
  }
}
