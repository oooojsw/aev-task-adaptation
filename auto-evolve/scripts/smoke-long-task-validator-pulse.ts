import { readFileSync } from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")
const runnerPath = path.join(repoRoot, "auto-evolve", "orchestrator", "long-task", "runner.ts")
const source = readFileSync(runnerPath, "utf8")

const unitValidatorCall = source.match(
  /const validatorContracts = input\.spec\.validators\.filter[\s\S]*?const result = await runLongTaskValidator\(\{[\s\S]*?payload: \{/,
)

if (!unitValidatorCall) {
  throw new Error("Could not locate the work-unit runLongTaskValidator call block.")
}

if (!unitValidatorCall[0].includes("onActivation: input.onActivation")) {
  throw new Error("Work-unit validator no longer forwards onActivation.")
}

if (!unitValidatorCall[0].includes("onPulse: input.onPulse")) {
  throw new Error("Work-unit validator must forward onPulse so long validators keep heartbeat fresh.")
}

console.log("smoke-long-task-validator-pulse ok")
