import path from "node:path"
import type { AttemptSummary, RunCaseResult } from "./case-runtime"
import type { KnowledgeMaintainerSessionReportRef } from "./knowledge-maintainer/contract"
import { ensureDirectory, writeJsonFile, writeTextFile } from "./fs"
import { buildSessionRecordRef } from "./method-strategy-helpers"
import type { LoadedCase } from "./schema"

export interface BatchShardLearningRecord {
  caseID: string
  caseDir: string
  casePath: string
  compareMode: LoadedCase["spec"]["expected"]["mode"]
  materialPaths: string[]
  expectedPath: string
  runDir: string
  passed: boolean
  summary: string
  judgeShouldStartMaintainer: boolean
  actualOutputPath?: string
  evaluationPath?: string
  actionTracePath?: string
  routingPath?: string
  judgeSummaryPath?: string
  judgeReportPath?: string
  solveSessionReportPath?: string
  judgeSessionReportPath?: string
}

export interface BatchLearningPacket {
  methodID: string
  maintenanceMethodID: string
  packetizationPolicyID: string
  batchIndex: number
  split: string
  mode: "learn" | "eval"
  totalCases: number
  passedCases: number
  failedCases: number
  maintenanceCandidateCaseIDs: string[]
  judgeSkippedCaseIDs: string[]
  shardCases: BatchShardLearningRecord[]
}

export interface BatchLearningPacketArtifacts {
  packet: BatchLearningPacket
  packetPath: string
  summaryPath: string
  sessionReports: KnowledgeMaintainerSessionReportRef[]
}

function normalizeSlash(input: string) {
  return input.replace(/\\/g, "/")
}

function solveDirForAttempt(runDir: string, attempt: number) {
  return path.join(runDir, `attempt-${String(attempt).padStart(2, "0")}`, "solve")
}

function judgeDirForAttempt(runDir: string, attempt: number) {
  return path.join(runDir, `attempt-${String(attempt).padStart(2, "0")}`, "judge")
}

function maintainInputDirForAttempt(runDir: string, attempt: number) {
  return path.join(runDir, `attempt-${String(attempt).padStart(2, "0")}`, "maintain-input")
}

function acceptanceDirForAttempt(runDir: string, attempt: number) {
  return path.join(runDir, `attempt-${String(attempt).padStart(2, "0")}`, "acceptance")
}

function buildShardSessionReports(runDir: string, attempt: AttemptSummary) {
  const reports: KnowledgeMaintainerSessionReportRef[] = []

  if (attempt.solveSessionExecutionReportPath) {
    reports.push(
      buildSessionRecordRef({
        label: `batch_shard_solve_${attempt.attempt}`,
        absolutePath: attempt.solveSessionExecutionReportPath,
        relativePath: normalizeSlash(path.relative(runDir, attempt.solveSessionExecutionReportPath)),
        phase: "solve",
        attempt: attempt.attempt,
        sessionID: attempt.solveSessionID,
      }),
    )
  }

  if (attempt.judgeSessionExecutionReportPath) {
    reports.push(
      buildSessionRecordRef({
        label: `batch_shard_judge_${attempt.attempt}`,
        absolutePath: attempt.judgeSessionExecutionReportPath,
        relativePath: normalizeSlash(path.relative(runDir, attempt.judgeSessionExecutionReportPath)),
        phase: "judge",
        attempt: attempt.attempt,
        sessionID: attempt.judgeSessionID,
      }),
    )
  }

  return reports
}

function buildShardLearningRecord(loaded: LoadedCase, result: RunCaseResult): BatchShardLearningRecord {
  const lastAttempt = result.attempts[result.attempts.length - 1]
  const solveDir = solveDirForAttempt(result.runDir, lastAttempt.attempt)
  const judgeDir = judgeDirForAttempt(result.runDir, lastAttempt.attempt)
  const maintainInputDir = maintainInputDirForAttempt(result.runDir, lastAttempt.attempt)
  const acceptanceDir = acceptanceDirForAttempt(result.runDir, lastAttempt.attempt)

  return {
    caseID: loaded.spec.id,
    caseDir: loaded.caseDir,
    casePath: loaded.casePath,
    compareMode: loaded.spec.expected.mode,
    materialPaths: loaded.spec.materials.map((item) => path.join(loaded.caseDir, item.path)),
    expectedPath: path.join(loaded.caseDir, loaded.spec.expected.path),
    runDir: result.runDir,
    passed: result.evaluation.passed,
    summary: result.evaluation.summary,
    judgeShouldStartMaintainer: Boolean(lastAttempt.judgeShouldStartMaintainer),
    actualOutputPath: path.join(maintainInputDir, "actual_output.txt"),
    evaluationPath: path.join(solveDir, "evaluation.json"),
    actionTracePath: path.join(solveDir, "action_trace.md"),
    routingPath: path.join(acceptanceDir, "routing.json"),
    judgeSummaryPath: lastAttempt.judgeSummaryPath ?? path.join(judgeDir, "judge_summary.json"),
    judgeReportPath: lastAttempt.judgeReportPath ?? path.join(judgeDir, "judge_report.md"),
    solveSessionReportPath: lastAttempt.solveSessionExecutionReportPath,
    judgeSessionReportPath: lastAttempt.judgeSessionExecutionReportPath,
  }
}

export async function buildBatchLearningPacket(input: {
  batchDir: string
  methodID: string
  maintenanceMethodID: string
  packetizationPolicyID: string
  batchIndex: number
  split: string
  mode: "learn" | "eval"
  shards: { loaded: LoadedCase; result: RunCaseResult }[]
}): Promise<BatchLearningPacketArtifacts> {
  await ensureDirectory(input.batchDir)

  const shardCases = input.shards.map(({ loaded, result }) => buildShardLearningRecord(loaded, result))
  const packet: BatchLearningPacket = {
    methodID: input.methodID,
    maintenanceMethodID: input.maintenanceMethodID,
    packetizationPolicyID: input.packetizationPolicyID,
    batchIndex: input.batchIndex,
    split: input.split,
    mode: input.mode,
    totalCases: shardCases.length,
    passedCases: shardCases.filter((item) => item.passed).length,
    failedCases: shardCases.filter((item) => !item.passed).length,
    maintenanceCandidateCaseIDs: shardCases
      .filter((item) => !item.passed && item.judgeShouldStartMaintainer)
      .map((item) => item.caseID),
    judgeSkippedCaseIDs: shardCases
      .filter((item) => !item.passed && !item.judgeShouldStartMaintainer)
      .map((item) => item.caseID),
    shardCases,
  }

  const sessionReports = input.shards.flatMap(({ result }) => {
    const lastAttempt = result.attempts[result.attempts.length - 1]
    return buildShardSessionReports(result.runDir, lastAttempt).map((report) => ({
      ...report,
      caseID:
        report.caseID ??
        input.shards.find((item) => item.result.runDir === result.runDir)?.loaded.spec.id,
    }))
  })

  const packetPath = path.join(input.batchDir, "batch_learning_packet.json")
  const summaryPath = path.join(input.batchDir, "batch_learning_packet.md")

  await writeJsonFile(packetPath, packet)
  await writeTextFile(
    summaryPath,
    [
      "# Batch Learning Packet",
      "",
      `- method: ${input.methodID}`,
      `- maintenance method: ${input.maintenanceMethodID}`,
      `- packetization policy: ${input.packetizationPolicyID}`,
      `- batch index: ${input.batchIndex}`,
      `- split: ${input.split}`,
      `- mode: ${input.mode}`,
      `- total cases: ${packet.totalCases}`,
      `- passed before maintenance: ${packet.passedCases}`,
      `- failed before maintenance: ${packet.failedCases}`,
      `- maintenance candidates: ${packet.maintenanceCandidateCaseIDs.length ? packet.maintenanceCandidateCaseIDs.join(", ") : "(none)"}`,
      `- judge skipped: ${packet.judgeSkippedCaseIDs.length ? packet.judgeSkippedCaseIDs.join(", ") : "(none)"}`,
      "",
      "## Shards",
      "",
      ...packet.shardCases.map((item) =>
        [
          `### ${item.caseID}`,
          `- run dir: ${item.runDir}`,
          `- compare mode: ${item.compareMode}`,
          `- passed before maintenance: ${item.passed}`,
          `- judge wants maintenance: ${item.judgeShouldStartMaintainer}`,
          `- summary: ${item.summary}`,
        ].join("\n"),
      ),
      "",
    ].join("\n"),
  )

  return {
    packet,
    packetPath,
    summaryPath,
    sessionReports,
  }
}
