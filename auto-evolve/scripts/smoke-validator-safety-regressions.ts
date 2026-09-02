import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { runLongTaskValidatorViaValidationEngine, buildPromptValidatorInput } from "../orchestrator/validation-engine/long-task-adapter"
import { readJsonFile, writeJsonFile } from "../orchestrator/fs"
import { requiredCompletionValidatorIDs, requiredWorkUnitValidatorIDs } from "../orchestrator/long-task/runner"
import type {
  LongTaskPromptValidatorContract,
  LongTaskScriptValidatorContract,
  LongTaskSpec,
  LongTaskWorkUnit,
} from "../orchestrator/long-task/contract"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const repoRoot = path.resolve(import.meta.dir, "..", "..")
const root = path.join(repoRoot, "auto-evolve", "runtime-state", "tmp-smoke-validator-safety")

async function scriptValidatorCase(input: {
  name: string
  code: string
  timeoutMs?: number
  expectedPassed: boolean
  expectedFailureKind?: string
}) {
  const dir = path.join(root, "script-validator", input.name)
  await mkdir(dir, { recursive: true })
  const scriptPath = path.join(dir, "validator.cjs")
  await writeFile(scriptPath, input.code, "utf8")
  const contract: LongTaskScriptValidatorContract = {
    id: input.name,
    type: "script",
    title: input.name,
    path: scriptPath,
    runner: "node",
    inputMode: "json_file",
    timeoutMs: input.timeoutMs ?? 3000,
  }
  const spec: LongTaskSpec = {
    id: "smoke-task",
    title: "Smoke Task",
    goal: "Exercise script validator infrastructure gate.",
    materials: [],
    validators: [contract],
  }
  const unit: LongTaskWorkUnit = {
    id: "unit",
    title: "Unit",
    goal: "Run validator",
    inputs: [],
    dependsOn: [],
    expectedArtifacts: [],
    claim: "done",
    checkPlan: "validate",
    validatorIDs: [contract.id],
    retryBudget: 1,
    status: "planned",
  }
  const out = await runLongTaskValidatorViaValidationEngine({
    cwd: repoRoot,
    config: {} as any,
    contract,
    spec,
    unit,
    runID: "smoke-run",
    attempt: 1,
    validatorDir: path.join(dir, "result"),
    bundlePath: path.join(dir, "bundle.json"),
    payload: { ok: true },
  })
  assert(out.result.passed === input.expectedPassed, `${input.name}: passed mismatch`)
  assert(out.result.failureKind === input.expectedFailureKind, `${input.name}: failureKind mismatch: ${out.result.failureKind}`)
}

async function smokeScriptValidatorInfraGate() {
  await scriptValidatorCase({
    name: "exit0-json-true",
    code: 'console.log(JSON.stringify({ passed: true, summary: "ok" })); process.exit(0)\n',
    expectedPassed: true,
  })
  await scriptValidatorCase({
    name: "exit1-json-true",
    code: 'console.log(JSON.stringify({ passed: true, summary: "business says ok but process failed" })); process.exit(1)\n',
    expectedPassed: false,
    expectedFailureKind: "validator_infrastructure",
  })
  await scriptValidatorCase({
    name: "timeout-json-true",
    code: 'console.log(JSON.stringify({ passed: true, summary: "printed before timeout" })); setTimeout(() => {}, 10000)\n',
    timeoutMs: 250,
    expectedPassed: false,
    expectedFailureKind: "validator_infrastructure",
  })
  await scriptValidatorCase({
    name: "exit0-json-false",
    code: 'console.log(JSON.stringify({ passed: false, summary: "answer wrong" })); process.exit(0)\n',
    expectedPassed: false,
    expectedFailureKind: "product_failure",
  })
  await scriptValidatorCase({
    name: "exit1-json-false",
    code: 'console.log(JSON.stringify({ passed: false, score: 0, summary: "answer mismatch" })); process.exit(1)\n',
    expectedPassed: false,
    expectedFailureKind: "product_failure",
  })
}

async function smokePrivateAnswerInference() {
  const base = path.join(root, "private-answer")
  const cases: Array<[string, string]> = [
    ["UID001", "answer.txt"],
    ["alf-001", "answer.json"],
    ["case-md", "answer.md"],
  ]
  for (const [id, answerName] of cases) {
    const shadow = path.join(base, "test-shadow", id)
    const answerDir = path.join(base, "private-answers", id)
    const workspace = path.join(shadow, "workspace")
    const validatorDir = path.join(base, "validator", id)
    await mkdir(shadow, { recursive: true })
    await mkdir(answerDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await mkdir(validatorDir, { recursive: true })
    const humanGuidancePath = path.join(shadow, "human-guidance.md")
    const candidatePath = path.join(workspace, "answer.json")
    const contextPath = path.join(shadow, "context.json")
    await writeFile(humanGuidancePath, "guidance", "utf8")
    await writeFile(path.join(answerDir, answerName), "secret", "utf8")
    await writeFile(candidatePath, "{}", "utf8")
    await writeFile(contextPath, "{}", "utf8")
    const bundlePath = path.join(validatorDir, "bundle.json")
    await writeJsonFile(bundlePath, {
      files: [humanGuidancePath, candidatePath, contextPath, path.join(answerDir, answerName)],
    })
    const contract: LongTaskPromptValidatorContract = {
      id: "prompt",
      type: "prompt_json",
      title: "Prompt",
      prompt: "validate",
      inputFiles: { humanGuidancePath },
      attachedFiles: [humanGuidancePath, contextPath, candidatePath],
    }
    const spec: LongTaskSpec = {
      id,
      title: id,
      goal: "validate answer inference",
      materials: [],
      validators: [contract],
    }
    const unit: LongTaskWorkUnit = {
      id: "unit",
      title: "Unit",
      goal: "Run prompt validator",
      inputs: [],
      dependsOn: [],
      expectedArtifacts: [],
      claim: "done",
      checkPlan: "validate",
      validatorIDs: [contract.id],
      retryBudget: 1,
      status: "planned",
    }
    const built = await buildPromptValidatorInput({
      spec,
      unit,
      contract,
      bundlePath,
      resultPath: path.join(validatorDir, "result.json"),
      validatorDir,
    })
    const files = built.payload.files as Record<string, unknown>
    assert(String(files.answer_path).endsWith(`private-answers${path.sep}${id}${path.sep}${answerName}`), `${id}: answer path mismatch`)
    assert(files.candidate_path === candidatePath, `${id}: candidate path should be workspace answer.json`)
    assert(files.human_guidance_path === humanGuidancePath, `${id}: human guidance mismatch`)
  }
}

function smokeValidatorPlacementSplit() {
  const spec: LongTaskSpec = {
    id: "placement",
    title: "Placement",
    goal: "Split validator placement",
    materials: [],
    validators: [
      { id: "unit-a", type: "script", title: "unit-a", path: "a.py", required: true },
      { id: "unit-b", type: "script", title: "unit-b", path: "b.py", required: true, placement: "unit" },
      {
        id: "completion-a",
        type: "script",
        title: "completion-a",
        path: "c.py",
        required: true,
        placement: "completion_only",
      },
    ],
  }
  assert(JSON.stringify(requiredWorkUnitValidatorIDs(spec)) === JSON.stringify(["unit-a", "unit-b"]), "unit validator split mismatch")
  assert(JSON.stringify(requiredCompletionValidatorIDs(spec)) === JSON.stringify(["completion-a"]), "completion validator split mismatch")
  assert(requiredCompletionValidatorIDs({ ...spec, disableCompletionValidators: true }).length === 0, "disableCompletionValidators ignored")
}

async function smokeReadJsonFileStrict() {
  const dir = path.join(root, "json-strict")
  await mkdir(dir, { recursive: true })
  const forward = path.join(dir, "forward.json")
  const escaped = path.join(dir, "escaped.json")
  const bad = path.join(dir, "bad.json")
  const summary = path.join(dir, "summary.json")
  const wrapped = path.join(dir, "wrapped.json")
  await writeFile(forward, '{"targetPath":"C:/tmp/runtime/task.json"}', "utf8")
  await writeFile(escaped, '{"targetPath":"C:\\\\tmp\\\\runtime\\\\task.json"}', "utf8")
  await writeFile(bad, '{"targetPath":"C:\\tmp\\runtime\\task.json"}', "utf8")
  await writeFile(summary, '{"summary":"line1\\nline2"}', "utf8")
  await writeFile(wrapped, 'prefix {"ok":true} suffix', "utf8")
  assert((await readJsonFile<any>(forward)).targetPath === "C:/tmp/runtime/task.json", "forward path failed")
  assert((await readJsonFile<any>(escaped)).targetPath === "C:\\tmp\\runtime\\task.json", "escaped path failed")
  assert((await readJsonFile<any>(summary)).summary === "line1\nline2", "summary newline failed")
  let badFailed = false
  try {
    await readJsonFile(bad)
  } catch {
    badFailed = true
  }
  assert(badFailed, "bad Windows path should fail closed")
  let strictFailed = false
  try {
    await readJsonFile(wrapped)
  } catch {
    strictFailed = true
  }
  assert(strictFailed, "wrapped JSON should fail without explicit salvage")
  assert((await readJsonFile<any>(wrapped, { salvage: "extract-object" })).ok === true, "explicit extract-object salvage failed")
}

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await smokeScriptValidatorInfraGate()
await smokePrivateAnswerInference()
smokeValidatorPlacementSplit()
await smokeReadJsonFileStrict()

console.log("smoke-validator-safety-regressions PASS")
