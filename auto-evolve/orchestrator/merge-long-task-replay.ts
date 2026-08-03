import path from "node:path"
import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "./fs"
import type {
  LongTaskBlankEvalPlanValidatorContract,
  LongTaskWorkUnit,
} from "./long-task/contract"
import { loadLongTaskSpec } from "./long-task/spec"
import { loadConfig } from "./schema"
import { runLongTaskValidatorViaValidationEngine } from "./validation-engine/long-task-adapter"
import {
  readAndValidateMergeSourceSkillIndex,
  resolveMergeSourceSkillEntryPaths,
} from "./merge-source-lineage"

export type MergeLongTaskReplayInput = {
  cwd: string
  mergeSpecPath: string
  candidateSkillRoot: string
  outDir: string
  concurrency: number
  runtimeScope?: string
  validatorRunner?: typeof runLongTaskValidatorViaValidationEngine
  reuseExisting?: boolean
}

export async function fingerprintMergeSkillRoot(skillRootInput: string) {
  const skillRoot = path.resolve(skillRootInput)
  const rows: string[] = []
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(skillRoot, absolute).replace(/\\/g, "/")
      if (entry.isSymbolicLink()) {
        throw new Error(`MSL Skill fingerprint refuses symlink/junction-like entry: ${relative}`)
      }
      if (entry.isDirectory()) {
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const contentHash = createHash("sha256").update(await readFile(absolute)).digest("hex")
      rows.push(`${relative}\0${contentHash}`)
    }
  }
  await visit(skillRoot)
  if (rows.length === 0) throw new Error(`MSL Skill fingerprint found no files under ${skillRoot}`)
  return createHash("sha256").update(rows.join("\n")).digest("hex")
}

export type MergeReplayCaseResult = {
  id: string
  passed: boolean
  skipped?: boolean
  summary?: string
  resultPath?: string
  evidenceBundlePath?: string
}

type PersistedReplayReport = {
  schema?: string
  passed?: boolean
  candidateSkillRoot?: string
  sourceIndexPath?: string
  repairTargetsPath?: string
  failedCaseIDs?: string[]
  missingResults?: string[]
  caseResults?: MergeReplayCaseResult[]
  validatorResult?: unknown
}

function normalizeCaseResults(input: unknown): MergeReplayCaseResult[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      passed: item.passed === true,
      skipped: item.skipped === true,
      summary: typeof item.summary === "string" ? item.summary : undefined,
      resultPath: typeof item.resultPath === "string" ? item.resultPath : undefined,
      evidenceBundlePath: typeof item.evidenceBundlePath === "string" ? item.evidenceBundlePath : undefined,
    }))
    .filter((item) => item.id.length > 0)
}

export async function writeMergeLongTaskRepairTargets(input: {
  mergeSpecPath: string
  candidateSkillRoot: string
  outDir: string
  caseIDs: string[]
  protectedCaseIDs?: string[]
  caseResults: MergeReplayCaseResult[]
}) {
  const mergeSpecPath = path.resolve(input.mergeSpecPath)
  const sourceIndexPath = path.join(path.dirname(mergeSpecPath), "materials", "source-skill-index.json")
  const sourceIndex = await readAndValidateMergeSourceSkillIndex(sourceIndexPath)
  const sourceByID = new Map(sourceIndex.entries.map((entry) => [entry.sourceCaseID, entry]))
  const missingSourceCases = input.caseIDs.filter((id) => !sourceByID.has(id))
  if (missingSourceCases.length) {
    throw new Error(`MSL replay case(s) have no frozen leaf Skill: ${missingSourceCases.join(", ")}`)
  }
  const protectedCaseIDs = Array.from(new Set(input.protectedCaseIDs ?? []))
  const missingProtectedCases = protectedCaseIDs.filter((id) => !sourceByID.has(id))
  if (missingProtectedCases.length) {
    throw new Error(`MSL protected case(s) have no frozen leaf Skill: ${missingProtectedCases.join(", ")}`)
  }
  const overlappingCases = protectedCaseIDs.filter((id) => input.caseIDs.includes(id))
  if (overlappingCases.length) {
    throw new Error(`MSL case(s) cannot be both repair targets and protected cases: ${overlappingCases.join(", ")}`)
  }
  const resultsByID = new Map(input.caseResults.map((item) => [item.id, item]))
  const failedCaseIDs = input.caseIDs.filter((id) => resultsByID.get(id)?.passed !== true)
  const targets = failedCaseIDs.map((id) => {
    const entry = sourceByID.get(id)!
    const resolved = resolveMergeSourceSkillEntryPaths(sourceIndexPath, entry)
    const result = resultsByID.get(id)
    return {
      caseID: id,
      sourceSkillRoot: resolved.root,
      sourceSkillFiles: resolved.readableFiles,
      sourceSpecPath: resolved.sourceSpecPath,
      replayResultPath: result?.resultPath,
      replayEvidenceBundlePath: result?.evidenceBundlePath,
      replaySummary: result?.summary,
    }
  })
  const outDir = path.resolve(input.outDir)
  await ensureDirectory(outDir)
  const repairTargetsPath = path.join(outDir, "repair-targets.json")
  const candidateSkillFingerprint = await fingerprintMergeSkillRoot(input.candidateSkillRoot)
  await writeJsonFile(repairTargetsPath, {
    schema: "merge-long-task-repair-targets/v1",
    generatedAt: new Date().toISOString(),
    candidateSkillRoot: path.resolve(input.candidateSkillRoot),
    candidateSkillFingerprint,
    sourceIndexPath,
    failedCaseIDs,
    protectedCaseIDs:
      input.protectedCaseIDs === undefined
        ? input.caseIDs.filter((id) => !failedCaseIDs.includes(id))
        : protectedCaseIDs,
    targets,
  })
  return { repairTargetsPath, failedCaseIDs, sourceIndexPath, candidateSkillFingerprint }
}

function syntheticReplayUnit(caseIDs: string[]): LongTaskWorkUnit {
  return {
    id: "msl-supervisor-replay",
    title: "MSL Supervisor Replay",
    goal: "Run closed-book replay for the current merged skill.",
    inputs: [],
    dependsOn: [],
    expectedArtifacts: [],
    claim: `Closed-book replay completed for ${caseIDs.length} case(s).`,
    checkPlan: "Every configured replay case must produce a concrete result.",
    validatorIDs: ["msl-supervisor-blank-replay"],
    retryBudget: 1,
    status: "active",
    attemptCount: 1,
  }
}

export async function runMergeLongTaskReplay(input: MergeLongTaskReplayInput) {
  const mergeSpecPath = path.resolve(input.mergeSpecPath)
  const taskDir = path.dirname(mergeSpecPath)
  const materialsDir = path.join(taskDir, "materials")
  const planPath = path.join(materialsDir, "replay-plan.json")
  const sourceIndexPath = path.join(materialsDir, "source-skill-index.json")
  const candidateSkillRoot = path.resolve(input.candidateSkillRoot)
  const outDir = path.resolve(input.outDir)
  await ensureDirectory(outDir)

  if (!(await pathExists(candidateSkillRoot))) {
    throw new Error(`MSL replay candidate skill root does not exist: ${candidateSkillRoot}`)
  }
  const plan = await readJsonFile<{ cases?: Array<{ id?: string }> }>(planPath)
  const caseIDs = (plan.cases ?? []).map((item) => String(item.id ?? "").trim()).filter(Boolean)
  if (!caseIDs.length) throw new Error(`MSL replay plan has no cases: ${planPath}`)
  if (new Set(caseIDs).size !== caseIDs.length) throw new Error(`MSL replay plan contains duplicate case IDs: ${planPath}`)

  const sourceIndex = await readAndValidateMergeSourceSkillIndex(sourceIndexPath)
  const sourceByID = new Map(sourceIndex.entries.map((entry) => [entry.sourceCaseID, entry]))
  const missingSourceCases = caseIDs.filter((id) => !sourceByID.has(id))
  if (missingSourceCases.length) {
    throw new Error(`MSL replay case(s) have no frozen leaf Skill: ${missingSourceCases.join(", ")}`)
  }

  const reportPath = path.join(outDir, "msl-replay-report.json")
  if (input.reuseExisting !== false && (await pathExists(reportPath))) {
    const persisted = await readJsonFile<PersistedReplayReport>(reportPath)
    const persistedCaseResults = normalizeCaseResults(persisted.caseResults)
    const persistedIDs = persistedCaseResults.map((item) => item.id)
    const repairTargetsPath =
      typeof persisted.repairTargetsPath === "string" ? path.resolve(persisted.repairTargetsPath) : ""
    const reusable =
      persisted.schema === "merge-long-task-supervisor-replay-report/v1" &&
      path.resolve(String(persisted.candidateSkillRoot ?? "")) === candidateSkillRoot &&
      path.resolve(String(persisted.sourceIndexPath ?? "")) === sourceIndexPath &&
      persistedIDs.length === caseIDs.length &&
      persistedIDs.every((id, index) => id === caseIDs[index]) &&
      Boolean(repairTargetsPath) &&
      (await pathExists(repairTargetsPath))
    if (reusable) {
      return {
        passed: persisted.passed === true,
        reportPath,
        repairTargetsPath,
        failedCaseIDs: Array.isArray(persisted.failedCaseIDs) ? persisted.failedCaseIDs.map(String) : [],
        missingResults: Array.isArray(persisted.missingResults) ? persisted.missingResults.map(String) : [],
        caseResults: persistedCaseResults,
        validatorResult: persisted.validatorResult,
        reused: true,
      }
    }
  }

  const loaded = await loadLongTaskSpec(mergeSpecPath)
  const config = await loadConfig(input.cwd)
  const contract: LongTaskBlankEvalPlanValidatorContract = {
    id: "msl-supervisor-blank-replay",
    type: "blank_eval_plan",
    title: "MSL supervisor closed-book replay",
    placement: "completion_only",
    planPath,
    skillRootPath: candidateSkillRoot,
    mode: input.concurrency > 1 ? "parallel" : "sequence",
    concurrency: Math.max(1, Math.floor(input.concurrency)),
    stopOnFirstFailure: false,
    successCriterion: "all_pass",
    replayPolicy: {
      strategy: "failures_then_regression",
      // Replay policy state is part of the replay plan's control surface.
      // Keep it beside the plan so the validation engine's anti-path-escape
      // boundary remains enforceable.
      statePath: path.join(path.dirname(planPath), ".blank-eval-replay-policy", "msl-supervisor-blank-replay.json"),
    },
    required: true,
    blocking: true,
    validation: {
      target: "product",
      stage: "post_merge",
      answerAccess: "private_oracle",
      allowedAudiences: ["merger", "repair_agent", "dashboard", "memory", "audit"],
    },
  }
  const bundlePath = path.join(outDir, "supervisor-replay-bundle.json")
  await writeJsonFile(bundlePath, {
    schema: "merge-long-task-supervisor-replay-bundle/v1",
    mergeSpecPath,
    candidateSkillRoot,
    planPath,
    sourceIndexPath,
    caseIDs,
  })
  const validatorRunner = input.validatorRunner ?? runLongTaskValidatorViaValidationEngine
  const engine = await validatorRunner({
    cwd: input.cwd,
    config,
    contract,
    spec: loaded.spec,
    unit: syntheticReplayUnit(caseIDs),
    runID: `msl-replay-${path.basename(taskDir)}`,
    attempt: 1,
    validatorDir: path.join(outDir, "validator"),
    bundlePath,
    payload: {
      candidateSkillRoot,
      planPath,
      caseIDs,
    },
    runtimeScope: input.runtimeScope,
  })
  // Validation backends are allowed to omit diagnostic raw payloads. Treat
  // that as an empty result set so the replay fails closed instead of
  // crashing the supervisor before it can write a repair report.
  const raw =
    typeof engine.raw === "object" && engine.raw !== null && !Array.isArray(engine.raw)
      ? (engine.raw as Record<string, unknown>)
      : {}
  const caseResults = normalizeCaseResults(raw.caseResults)
  const seenResults = new Set(caseResults.map((item) => item.id))
  const missingResults = caseIDs.filter((id) => !seenResults.has(id))
  const failedCaseIDs = caseResults.filter((item) => !item.passed && !item.skipped).map((item) => item.id)
  const passed =
    engine.result.passed === true &&
    missingResults.length === 0 &&
    caseResults.length === caseIDs.length &&
    failedCaseIDs.length === 0

  const repairTargets = await writeMergeLongTaskRepairTargets({
    mergeSpecPath,
    candidateSkillRoot,
    outDir,
    caseIDs,
    caseResults,
  })
  const repairTargetsPath = repairTargets.repairTargetsPath
  await writeJsonFile(reportPath, {
    schema: "merge-long-task-supervisor-replay-report/v1",
    generatedAt: new Date().toISOString(),
    passed,
    validatorPassed: engine.result.passed,
    expectedCaseCount: caseIDs.length,
    actualCaseCount: caseResults.length,
    missingResults,
    failedCaseIDs,
    caseResults,
    candidateSkillRoot,
    sourceIndexPath,
    repairTargetsPath,
    validatorResult: engine.result,
    raw,
  })

  // Ensure the report is fully durable before allowing the hierarchy to promote.
  await readFile(reportPath, "utf8")
  return {
    passed,
    reportPath,
    repairTargetsPath,
    failedCaseIDs,
    missingResults,
    caseResults,
    validatorResult: engine.result,
  }
}
