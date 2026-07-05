import path from "node:path"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { runBlankEvalPlan, type BlankEvalCaseRunner } from "../orchestrator/blank-eval/plan-runner"
import type { BlankEvalPlanInput } from "../orchestrator/blank-eval/contract"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "aev-blank-eval-plan-smoke-"))
  const calls: string[] = []
  const fakeRunner: BlankEvalCaseRunner = async ({ caseItem, runRoot }) => {
    calls.push(caseItem.id)
    const rel = path.relative(root, runRoot)
    assert(!rel.startsWith("..") && !path.isAbsolute(rel), `case runRoot escaped smoke root: ${runRoot}`)
    assert(!/[<>:"|?*\r\n]/.test(path.basename(runRoot)), `case runRoot contains unsafe filename characters: ${runRoot}`)
    return {
      id: caseItem.id,
      specPath: caseItem.specPath,
      title: caseItem.title,
      passed: !caseItem.id.includes("fail"),
      summary: `fake ${caseItem.id}`,
      runDir: runRoot,
      resultPath: path.join(runRoot, "result.json"),
    }
  }
  const base: Omit<BlankEvalPlanInput, "mode" | "cases"> = {
    cwd: process.cwd(),
    runRoot: root,
    title: "blank eval plan smoke",
    skillRoots: [path.join(root, "skill")],
    successCriterion: "all_pass",
  }

  calls.length = 0
  const single = await runBlankEvalPlan(
    {
      ...base,
      mode: "single",
      cases: [
        { id: "case-a", specPath: path.join(root, "a.json") },
        { id: "case-b", specPath: path.join(root, "b.json") },
      ],
    },
    { runner: fakeRunner },
  )
  assert(single.passed === false, "single should fail closed when more than one case is provided")
  assert(single.total === 2, "invalid single should report every provided case")
  assert(single.failedCount === 2, "invalid single should mark both cases failed")
  assert(single.caseResults.every((item) => item.failureKind === "validator_infrastructure"), "invalid single should be infrastructure failure")
  assert(calls.join(",") === "", "invalid single should not execute any case")

  calls.length = 0
  const duplicate = await runBlankEvalPlan(
    {
      ...base,
      mode: "parallel",
      cases: [
        { id: "dup", specPath: path.join(root, "dup-a.json") },
        { id: "dup", specPath: path.join(root, "dup-b.json") },
      ],
    },
    { runner: fakeRunner },
  )
  assert(duplicate.passed === false, "duplicate case IDs should fail closed")
  assert(duplicate.failedCount === 2, "duplicate IDs should mark all duplicated plan rows failed")
  assert(calls.join(",") === "", "duplicate ID plan should not execute any case")

  calls.length = 0
  const weirdNames = await runBlankEvalPlan(
    {
      ...base,
      mode: "parallel",
      concurrency: 2,
      cases: [
        { id: "../CON\r\nbad:name", specPath: path.join(root, "weird-a.json") },
        { id: "AUX. ", specPath: path.join(root, "weird-b.json") },
      ],
    },
    { runner: fakeRunner },
  )
  assert(weirdNames.passed === true, "weird-but-unique IDs should be sanitized and still run")
  assert(calls.length === 2, "weird IDs should both execute after sanitization")

  calls.length = 0
  const sequence = await runBlankEvalPlan(
    {
      ...base,
      mode: "sequence",
      stopOnFirstFailure: true,
      cases: [
        { id: "case-a", specPath: path.join(root, "a.json") },
        { id: "case-fail", specPath: path.join(root, "fail.json") },
        { id: "case-after", specPath: path.join(root, "after.json") },
      ],
    },
    { runner: fakeRunner },
  )
  assert(sequence.passed === false, "sequence should fail under all_pass")
  assert(sequence.passedCount === 1, "sequence should count previous pass")
  assert(sequence.failedCount === 1, "sequence should count the real failure")
  assert(sequence.skippedCount === 1, "sequence should mark later cases skipped")
  assert(calls.join(",") === "case-a,case-fail", "sequence should stop after first failure")

  calls.length = 0
  const partial = await runBlankEvalPlan(
    {
      ...base,
      mode: "parallel",
      concurrency: 2,
      successCriterion: "min_pass_rate",
      minPassRate: 0.5,
      cases: [
        { id: "case-a", specPath: path.join(root, "a.json") },
        { id: "case-fail", specPath: path.join(root, "fail.json") },
      ],
    },
    { runner: fakeRunner },
  )
  assert(partial.passed === true, "parallel min_pass_rate should pass at 1/2 with 0.5 threshold")
  assert(partial.passedCount === 1, "parallel should record one pass")
  assert(partial.failedCount === 1, "parallel should record one failure")

  const crashingRunner: BlankEvalCaseRunner = async ({ caseItem, runRoot }) => {
    if (caseItem.id === "case-crash") throw new Error("simulated blank eval crash")
    return {
      id: caseItem.id,
      specPath: caseItem.specPath,
      passed: true,
      summary: `fake ${caseItem.id}`,
      runDir: runRoot,
    }
  }
  const crashIsolated = await runBlankEvalPlan(
    {
      ...base,
      mode: "parallel",
      concurrency: Number.NaN,
      successCriterion: "allow_partial",
      minPassRate: 2,
      cases: [
        { id: "case-ok", specPath: path.join(root, "ok.json") },
        { id: "case-crash", specPath: path.join(root, "crash.json") },
      ],
    },
    { runner: crashingRunner },
  )
  assert(crashIsolated.passed === true, "allow_partial should pass when one case passes despite one crash")
  assert(crashIsolated.failedCount === 1, "crashing case should be recorded as one failure")
  assert(crashIsolated.caseResults.some((item) => item.failureKind === "validator_infrastructure"), "crash should become infrastructure failure")

  console.log("smoke-blank-eval-plan passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
