import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { determineCampaignRecoveryDecision } from "../orchestrator/long-task-campaign/runner"
import { longTaskCampaignPaths } from "../orchestrator/long-task-campaign/repository"
import type { LongTaskCampaignRoundRecord, LongTaskCampaignState } from "../orchestrator/long-task-campaign/contract"
import type { LongTaskProgressState, LongTaskSpec } from "../orchestrator/long-task/contract"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const cwd = repoRoot
const title = "smoke recovery decision"
const baseSpecPath = path.join(repoRoot, "auto-evolve", "runtime-state", "tmp-smoke-recovery-decision", "spec.json")
const expectedTitle = `${title}-round-001`
const now = new Date().toISOString()

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), "utf8")
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function writeCase(input: {
  campaignID: string
  runID: string
  status?: LongTaskProgressState["status"]
  legacyRecoveryAction?: boolean
}) {
  const campaignPaths = longTaskCampaignPaths(cwd, input.campaignID)
  const runRoot = path.join(repoRoot, "auto-evolve", "runtime-state", "long-task", "runs", input.runID)
  await rm(campaignPaths.root, { recursive: true, force: true })
  await rm(runRoot, { recursive: true, force: true })
  await mkdir(path.dirname(baseSpecPath), { recursive: true })
  await writeJson(baseSpecPath, { title: "base smoke spec" })

  const state: LongTaskCampaignState = {
    id: input.campaignID,
    title,
    mode: "graph_iterative",
    baseSpecPath,
    maxRounds: 3,
    currentRound: 1,
    status: "recovery_pending",
    createdAt: now,
    updatedAt: now,
    recovery: input.legacyRecoveryAction
      ? {
          action: "resume_round_postrun" as never,
          roundNumber: 1,
          runID: input.runID,
          reason: "legacy dirty runtime marker kept for backward-compatibility smoke coverage",
          detectedAt: now,
        }
      : undefined,
  }

  const record: LongTaskCampaignRoundRecord = {
    roundNumber: 1,
    roundSpecPath: path.join(campaignPaths.roundsRoot, "round-001", "generated-spec.json"),
    sourceRunID: input.runID,
    sourceRunDir: runRoot,
    finalStatus: input.status ?? "stagnation_failure",
    summary: "inner run produced a round record before final acceptance bookkeeping finished",
    failurePacketCount: 0,
    retryLessonCount: 0,
    learningUnitCount: 0,
    roundSummaryPath: path.join(campaignPaths.roundsRoot, "round-001", "round-summary.md"),
    snapshotPaths: [],
    createdAt: now,
  }

  const task: LongTaskSpec = {
    title: expectedTitle,
    goal: "smoke",
    materials: [],
    targetPaths: [],
    editablePaths: [],
    validators: [],
    planning: {},
    execution: {},
    validation: {},
  }

  await writeJson(campaignPaths.campaignStatePath, state)
  await mkdir(path.dirname(campaignPaths.historyPath), { recursive: true })
  await writeFile(campaignPaths.historyPath, `${JSON.stringify(record)}\n`, "utf8")

  if (input.status) {
    const progress: LongTaskProgressState = {
      runID: input.runID,
      status: input.status,
      graphRevision: 1,
      completedUnitIDs: [],
      blockedUnitIDs: [],
      failedUnitIDs: [],
      nextPriorityUnitIDs: [],
      totalUnitAttempts: 0,
      validatorCalls: 0,
      graphReplanCount: 0,
      noProgressCycles: 0,
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
    }
    await writeJson(path.join(runRoot, "task.json"), task)
    await writeJson(path.join(runRoot, "progress_state.json"), progress)
  }

  return {
    state,
    record,
    campaignPaths,
    decision: await determineCampaignRecoveryDecision({
      cwd,
      campaignPaths,
      state,
      history: [record],
    }),
  }
}

const terminalCase = await writeCase({
  campaignID: "smoke-recovery-decision-terminal",
  runID: "smoke-recovery-run-terminal",
  status: "stagnation_failure",
  legacyRecoveryAction: true,
})
if (!terminalCase.decision) fail("Expected a terminal recovery decision, got undefined.")
if (terminalCase.decision.action !== "harvest_round_run") {
  fail(`Expected terminal action=harvest_round_run, got ${terminalCase.decision.action}.`)
}
if (terminalCase.decision.runID !== "smoke-recovery-run-terminal") {
  fail(`Expected terminal runID=smoke-recovery-run-terminal, got ${terminalCase.decision.runID ?? "(missing)"}.`)
}

const activeCase = await writeCase({
  campaignID: "smoke-recovery-decision-active",
  runID: "smoke-recovery-run-active",
  status: "running",
})
if (!activeCase.decision) fail("Expected an active recovery decision, got undefined.")
if (activeCase.decision.action !== "resume_round_run") {
  fail(`Expected active action=resume_round_run, got ${activeCase.decision.action}.`)
}

const missingRunCase = await writeCase({
  campaignID: "smoke-recovery-decision-missing",
  runID: "smoke-recovery-run-missing",
})
if (!missingRunCase.decision) fail("Expected a missing-run recovery decision, got undefined.")
if (missingRunCase.decision.action !== "restart_round") {
  fail(`Expected missing-run action=restart_round, got ${missingRunCase.decision.action}.`)
}

console.log(
  JSON.stringify(
    {
      passed: true,
      cases: [
        {
          name: "terminal postrun gap",
          action: terminalCase.decision.action,
          runID: terminalCase.decision.runID,
        },
        {
          name: "active postrun gap",
          action: activeCase.decision.action,
          runID: activeCase.decision.runID,
        },
        {
          name: "missing source run",
          action: missingRunCase.decision.action,
        },
      ],
    },
    null,
    2,
  ),
)
