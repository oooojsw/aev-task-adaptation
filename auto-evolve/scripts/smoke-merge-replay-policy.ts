import path from "node:path"
import { rm } from "node:fs/promises"
import { ensureDirectory, readJsonFile } from "../orchestrator/fs"
import { runBlankEvalPlanWithReplayPolicy } from "../orchestrator/validation-engine/long-task-adapter"
import type { BlankEvalCaseRunner } from "../orchestrator/blank-eval/plan-runner"
import type { LongTaskBlankEvalPlanValidatorContract, LongTaskSpec } from "../orchestrator/long-task/contract"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const cwd = path.resolve(import.meta.dir, "..", "..")
  const root = path.join(cwd, "auto-evolve", ".tmp-smoke", "merge-replay-policy-中文 路径")
  await rm(root, { recursive: true, force: true })
  await ensureDirectory(root)
  const statePath = path.join(root, "policy-state.json")
  const validatorDir = path.join(root, "validator")
  const cases = ["case-a", "case-b", "case-c"].map((id) => ({
    id,
    specPath: path.join(root, id, "spec.json"),
  }))
  const contract: LongTaskBlankEvalPlanValidatorContract = {
    id: "merged-skill-blank-eval-plan",
    type: "blank_eval_plan",
    title: "Smoke merge replay policy",
    placement: "completion_only",
    planPath: path.join(root, "replay-plan.json"),
    skillRootPath: path.join(root, "skill"),
    mode: "parallel",
    concurrency: 3,
    successCriterion: "all_pass",
    replayPolicy: {
      strategy: "failures_then_regression",
      statePath,
    },
  }
  const spec = {
    id: "smoke-merge-policy",
    title: "Smoke merge policy",
    goal: "Smoke.",
    materials: [],
    validators: [],
  } as LongTaskSpec

  const outcomes = new Map<string, boolean>()
  const calls: string[] = []
  const runner: BlankEvalCaseRunner = async (input) => {
    const passed = outcomes.get(input.caseItem.id) === true
    return {
      id: input.caseItem.id,
      specPath: input.caseItem.specPath,
      passed,
      summary: passed ? "pass" : "fail",
    }
  }
  const run = async () => {
    const result = await runBlankEvalPlanWithReplayPolicy({
      cwd,
      contract,
      spec,
      cases,
      mode: "parallel",
      concurrency: 3,
      successCriterion: "all_pass",
      validatorDir,
      caseRunner: async (input) => {
        calls.push(`${input.plan.title ?? "untitled"}:${input.caseItem.id}`)
        return await runner(input)
      },
    })
    return result
  }

  outcomes.set("case-a", true)
  outcomes.set("case-b", true)
  outcomes.set("case-c", false)
  const first = await run()
  assert(first.passed === false, "initial full replay should fail")
  assert(
    calls.filter((item) => item.includes("(initial-full):")).map((item) => item.split(":").at(-1)).join(",") ===
      "case-a,case-b,case-c",
    "initial call should be full",
  )
  let state = await readJsonFile<any>(statePath)
  assert(state.failedCaseIDs.join(",") === "case-c", "state should remember failed case-c")
  assert(state.protectedCaseIDs.join(",") === "case-a,case-b", "state should protect initial passed cases")

  outcomes.set("case-c", true)
  outcomes.set("case-b", false)
  const second = await run()
  assert(second.passed === false, "focused pass plus protected regression failure should fail")
  assert(
    calls.filter((item) => item.includes("(focused-failures):")).map((item) => item.split(":").at(-1)).join(",") ===
      "case-c",
    "second focused call should only test failed case",
  )
  assert(
    calls.filter((item) => item.includes("(protected-regression):")).map((item) => item.split(":").at(-1)).join(",") ===
      "case-a,case-b",
    "second regression should test protected cases",
  )
  state = await readJsonFile<any>(statePath)
  assert(state.failedCaseIDs.join(",") === "case-b", "regressed protected case should become new failed set")

  outcomes.set("case-b", true)
  const third = await run()
  assert(third.passed === true, "focused repair plus protected regression should pass")
  assert(
    calls.filter((item) => item.includes("(focused-failures):")).map((item) => item.split(":").at(-1)).join(",") ===
      "case-c,case-b",
    "focused calls should test original failed case then regressed case",
  )
  assert(
    calls.filter((item) => item.includes("(protected-regression):")).map((item) => item.split(":").at(-1)).join(",") ===
      "case-a,case-b,case-a,case-c",
    "regression calls should test previous protected cases",
  )
  state = await readJsonFile<any>(statePath)
  assert(state.phase === "stable", "state should become stable")
  assert(state.failedCaseIDs.length === 0, "stable state should have no failed cases")

  const unsafeContract: LongTaskBlankEvalPlanValidatorContract = {
    ...contract,
    replayPolicy: {
      strategy: "failures_then_regression",
      statePath: path.join(root, "..", "outside-policy-state.json"),
    },
  }
  let unsafeRejected = false
  try {
    await runBlankEvalPlanWithReplayPolicy({
      cwd,
      contract: unsafeContract,
      spec,
      cases,
      mode: "parallel",
      concurrency: 3,
      successCriterion: "all_pass",
      validatorDir,
      caseRunner: runner,
    })
  } catch (error) {
    unsafeRejected = String(error instanceof Error ? error.message : error).includes("Unsafe blank eval replayPolicy.statePath")
  }
  assert(unsafeRejected, "unsafe replayPolicy.statePath outside the plan directory should be rejected")

  console.log(JSON.stringify({ ok: true, calls, state }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
