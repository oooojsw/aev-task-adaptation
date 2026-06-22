import path from "node:path"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { readAdaptiveModelRuntime, recordAdaptiveModelOutcome } from "../orchestrator/adaptive-concurrency"
import { readJsonFile, writeJsonFile } from "../orchestrator/fs"

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const testRoot = path.join(repoRoot, "auto-evolve", ".tmp-adaptive-concurrency-tests", randomUUID())
const statePath = path.join(testRoot, "state.json")
const model = "alibaba-coding-plan-cn/qwen3.7-plus"
process.env.AUTO_EVOLVE_MODEL_CONCURRENCY_STATE_ROOT = testRoot

let failures = 0
function assert(condition: boolean, message: string) {
  if (condition) console.log(`ok   ${message}`)
  else {
    console.error(`FAIL ${message}`)
    failures += 1
  }
}

async function seed(openCode = 2, tasks = 1, spacing = 20_000) {
  await writeJsonFile(statePath, {
    version: 1,
    models: {
      [model]: {
        profile: "alibaba-low-concurrency",
        safeOpenCodeConcurrency: openCode,
        safeTaskConcurrency: tasks,
        safeRequestSpacingMs: spacing,
        successStreak: 0,
        failureStreak: 0,
        cooldownUntil: null,
        lastFailureClass: null,
      },
    },
  })
}

async function clearCooldown() {
  const state = await readJsonFile<any>(statePath)
  state.models[model].cooldownUntil = null
  await writeJsonFile(statePath, state)
}

async function success(times: number) {
  for (let i = 0; i < times; i += 1) {
    await recordAdaptiveModelOutcome({ cwd: repoRoot, model, exitCode: 0, text: "ok", source: `success-${i}` })
  }
}

async function main() {
  try {
    await seed()
    await recordAdaptiveModelOutcome({
      cwd: repoRoot,
      model,
      exitCode: 1,
      text: "429 Too Many Requests rate limit",
      source: "synthetic-rate-limit",
    })
    let runtime = await readAdaptiveModelRuntime(repoRoot, model)
    assert(runtime?.safeOpenCodeConcurrency === 1, "429 halves OpenCode concurrency")
    assert(runtime?.safeTaskConcurrency === 1, "429 keeps task concurrency at minimum")
    assert(runtime?.safeRequestSpacingMs === 40_000, "429 doubles request spacing")
    assert(Boolean(runtime?.cooldownUntil), "429 starts cooldown")

    await clearCooldown()
    await success(3)
    runtime = await readAdaptiveModelRuntime(repoRoot, model)
    assert(runtime?.safeOpenCodeConcurrency === 2, "three transport successes add one OpenCode slot")
    assert(runtime?.safeTaskConcurrency === 1, "task concurrency remains conservative below OpenCode concurrency 3")

    await success(3)
    runtime = await readAdaptiveModelRuntime(repoRoot, model)
    assert(runtime?.safeOpenCodeConcurrency === 3, "next success window adds another OpenCode slot")
    assert(runtime?.safeTaskConcurrency === 2, "OpenCode concurrency 3 raises task concurrency to 2")

    const beforeUnknown = JSON.stringify(await readJsonFile<any>(statePath))
    await recordAdaptiveModelOutcome({ cwd: repoRoot, model, exitCode: 1, text: "validator answer mismatch", source: "task-failure" })
    const afterUnknown = JSON.stringify(await readJsonFile<any>(statePath))
    assert(beforeUnknown === afterUnknown, "task/validator failures do not change provider concurrency")

    await recordAdaptiveModelOutcome({ cwd: repoRoot, model, exitCode: 1, text: "401 unauthorized", source: "auth" })
    runtime = await readAdaptiveModelRuntime(repoRoot, model)
    assert(runtime?.safeOpenCodeConcurrency === 0, "auth error blocks OpenCode concurrency")
    assert(runtime?.safeTaskConcurrency === 0, "auth error blocks task concurrency")
    await success(1)
    runtime = await readAdaptiveModelRuntime(repoRoot, model)
    assert(runtime?.safeOpenCodeConcurrency === 0, "one late success does not immediately clear an auth block")
    assert(runtime?.safeTaskConcurrency === 0, "one late success does not reopen task fan-out")

    if (failures > 0) throw new Error(`${failures} adaptive concurrency assertion(s) failed`)
    console.log("All adaptive concurrency assertions passed.")
  } finally {
    delete process.env.AUTO_EVOLVE_MODEL_CONCURRENCY_STATE_ROOT
    await rm(testRoot, { recursive: true, force: true })
  }
}

await main()
