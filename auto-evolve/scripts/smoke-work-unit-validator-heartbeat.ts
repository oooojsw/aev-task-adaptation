import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { runLongTask } from "../orchestrator/long-task/runner"
import { longTaskPaths, longTaskRunPaths, readLongTaskProgressState } from "../orchestrator/long-task/repository"
import type { LongTaskSpec, LongTaskWorkUnit, LongTaskScriptValidatorContract } from "../orchestrator/long-task/contract"
import { loadConfig } from "../orchestrator/schema"
import { writeJsonFile } from "../orchestrator/fs"

const repoRoot = path.resolve(import.meta.dir, "../..")
const cwd = path.join(repoRoot, "auto-evolve")

async function main() {
  const runID = `smoke-heartbeat-${randomUUID().slice(0, 8)}`
  const taskPaths = longTaskPaths(cwd)
  const runPaths = longTaskRunPaths(taskPaths, runID)

  await mkdir(runPaths.root, { recursive: true })

  // Create a slow validator script that sleeps for 6 seconds
  const validatorScriptPath = path.join(runPaths.root, "slow_validator.py")
  await writeFile(
    validatorScriptPath,
    `import json
import sys
import time

time.sleep(6)

print(json.dumps({
  "passed": True,
  "summary": "slow validator passed",
  "details": ["slept 6 seconds to test heartbeat pulse"]
}))
`,
    "utf8"
  )

  const spec: LongTaskSpec = {
    id: "smoke-heartbeat",
    title: "Smoke test for validator heartbeat",
    goal: "Verify work-unit validators keep heartbeat fresh during long execution",
    materials: [
      {
        path: validatorScriptPath,
        role: "validator_script",
      },
    ],
    targetPaths: [],
    units: [
      {
        id: "test-unit",
        title: "Test Unit",
        goal: "Test heartbeat pulse",
        inputs: [],
        dependsOn: [],
        expectedArtifacts: [],
        claim: "Test claim",
        checkPlan: "Run slow validator",
        validatorIDs: ["slow-validator"],
        retryBudget: 0,
        status: "pending",
        attemptCount: 0,
      } as LongTaskWorkUnit,
    ],
    validators: [
      {
        id: "slow-validator",
        type: "script",
        title: "Slow Validator",
        path: validatorScriptPath,
        runner: "python",
        args: [],
        timeoutMs: 10000,
        validation: {
          target: "product",
          stage: "post_work",
          answerAccess: "none",
          allowedAudiences: ["worker"],
        },
      } as LongTaskScriptValidatorContract,
    ],
    completionCriteria: [],
    initialUnits: ["test-unit"],
    supportingKnowledge: [],
    workspaceBundling: { mode: "none" },
    learningUnits: [],
    scratchUnits: [],
  }

  // Write spec to a file so runLongTask can load it
  const specPath = path.join(runPaths.root, "spec.json")
  await writeJsonFile(specPath, spec)

  const config = await loadConfig(cwd)

  let pulseCount = 0
  const heartbeats: string[] = []

  // Run long task with pulse tracking
  await runLongTask({
    cwd,
    specPath,
    runtimeScope: `smoke-${runID}`,
    onRuntimePulse: async () => {
      pulseCount++
      const progress = await readLongTaskProgressState(runPaths)
      if (progress?.heartbeatAt) {
        heartbeats.push(progress.heartbeatAt)
      }
    },
  })

  // Wait a moment for final writes
  await sleep(500)

  // Capture heartbeat after execution
  const progressAfter = await readLongTaskProgressState(runPaths)
  if (progressAfter?.heartbeatAt) {
    heartbeats.push(progressAfter.heartbeatAt)
  }

  console.log(`Pulse count: ${pulseCount}`)
  console.log(`Heartbeats collected: ${heartbeats.length}`)

  // Verify pulse was called during validator execution
  if (pulseCount < 1) {
    throw new Error(`Expected at least 1 pulse during validator execution, got ${pulseCount}`)
  }

  // Verify heartbeat was updated during execution
  if (heartbeats.length >= 2) {
    const firstHeartbeat = Date.parse(heartbeats[0])
    const lastHeartbeat = Date.parse(heartbeats[heartbeats.length - 1])
    if (lastHeartbeat <= firstHeartbeat) {
      throw new Error("heartbeatAt did not advance during work-unit validator execution")
    }
  }

  console.log("smoke-work-unit-validator-heartbeat ok")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

