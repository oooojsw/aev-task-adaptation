import path from "node:path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { runLongTaskValidator } from "../orchestrator/long-task/validators"
import { loadLongTaskSpec } from "../orchestrator/long-task/spec"
import { readJsonFile, pathExists } from "../orchestrator/fs"
import { assertAudienceCanReadValidationView } from "../orchestrator/validation-engine/permissions"
import { describeValidationModules, selectValidationModules } from "../orchestrator/validation-engine/registry"
import { runValidationStage } from "../orchestrator/validation-engine/stage-runner"
import type { AutoEvolveConfig } from "../orchestrator/schema"
import type { LongTaskSpec, LongTaskWorkUnit } from "../orchestrator/long-task/contract"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const autoEvolveRoot = path.resolve(import.meta.dir, "..")
const cwd = path.dirname(autoEvolveRoot)
const smokeRoot = path.join(autoEvolveRoot, "runtime-state", "smoke-validation-engine")

await rm(smokeRoot, { recursive: true, force: true })
await mkdir(smokeRoot, { recursive: true })

const validatorScript = path.join(smokeRoot, "validator.py")
await writeFile(
  validatorScript,
  [
    "import json, sys",
    "payload_path = sys.argv[1]",
    "with open(payload_path, encoding='utf-8') as f:",
    "    payload = json.load(f)",
    "print(json.dumps({",
    "    'passed': True,",
    "    'blocking': True,",
    "    'summary': 'smoke validator passed with answer 123.45 from private-answers/demo/answer.txt',",
    "    'details': ['private path C:/tmp/private-answers/demo/answer.txt and numeric 123.45 must be redacted'],",
    "    'payload_task': payload.get('task'),",
    "}))",
  ].join("\n"),
  "utf8",
)

const profilePath = path.join(smokeRoot, "profile.json")
const materialPath = path.join(smokeRoot, "material.txt")
await writeFile(materialPath, "smoke material", "utf8")
await writeFile(
  profilePath,
  JSON.stringify(
    {
      id: "smoke.profile",
      validators: [
        {
          id: "smoke-layout-profile",
          type: "script",
          title: "Smoke pluggable layout profile",
          path: validatorScript,
          runner: "python",
          placement: "completion_only",
          required: true,
          blocking: true,
          validation: {
            target: "layout",
            stage: "pre_blank",
            answerAccess: "none",
            allowedAudiences: ["lead", "reviewer", "dashboard", "memory", "audit"],
          },
        },
        {
          id: "smoke-post-merge-profile",
          type: "script",
          title: "Smoke pluggable post-merge profile",
          path: validatorScript,
          runner: "python",
          placement: "completion_only",
          required: true,
          blocking: true,
          validation: {
            target: "surface",
            stage: "post_merge",
            answerAccess: "none",
            allowedAudiences: ["merger", "repair_agent", "dashboard", "memory", "audit"],
          },
        },
        {
          id: "smoke-rollback-profile",
          type: "script",
          title: "Smoke pluggable rollback profile",
          path: validatorScript,
          runner: "python",
          placement: "completion_only",
          required: true,
          blocking: true,
          validation: {
            target: "transaction",
            stage: "rollback",
            answerAccess: "none",
            allowedAudiences: ["repair_agent", "reviewer", "dashboard", "audit"],
          },
        },
        {
          id: "smoke-heldout-profile",
          type: "script",
          title: "Smoke pluggable heldout test profile",
          path: validatorScript,
          runner: "python",
          placement: "completion_only",
          required: true,
          blocking: true,
          validation: {
            target: "product",
            stage: "heldout_test",
            answerAccess: "private_oracle",
            allowedAudiences: ["dashboard", "audit"],
          },
        },
      ],
    },
    null,
    2,
  ),
  "utf8",
)
const specPath = path.join(smokeRoot, "spec.json")
await writeFile(
  specPath,
  JSON.stringify(
    {
      id: "smoke-profile-spec",
      title: "Smoke profile spec",
      goal: "Verify pluggable validation profile metadata.",
      materials: [{ path: "material.txt", label: "smoke material" }],
      validatorProfiles: ["profile.json"],
      validators: [],
    },
    null,
    2,
  ),
  "utf8",
)

const loaded = await loadLongTaskSpec(specPath)
const preBlankLayout = selectValidationModules({
  validators: loaded.spec.validators,
  stage: "pre_blank",
  targets: ["layout"],
})
assert(preBlankLayout.length === 1, "expected one pre_blank layout validator from pluggable profile")
assert(preBlankLayout[0]?.validation?.answerAccess === "none", "layout profile should not require answer access")
const postMergeSurface = selectValidationModules({
  validators: loaded.spec.validators,
  stage: "post_merge",
  targets: ["surface"],
})
const rollbackTransaction = selectValidationModules({
  validators: loaded.spec.validators,
  stage: "rollback",
  targets: ["transaction"],
})
const heldoutProduct = selectValidationModules({
  validators: loaded.spec.validators,
  stage: "heldout_test",
  targets: ["product"],
})
assert(postMergeSurface.length === 1, "expected one post_merge surface validator from pluggable profile")
assert(rollbackTransaction.length === 1, "expected one rollback transaction validator from pluggable profile")
assert(heldoutProduct.length === 1, "expected one heldout_test product validator from pluggable profile")
const profileStageResult = await runValidationStage({
  cwd,
  config: {} as AutoEvolveConfig,
  spec: loaded.spec,
  unit: {
    id: "profile-unit",
    title: "Profile Unit",
    goal: "Run profile stage validator.",
    inputs: [],
    dependsOn: [],
    expectedArtifacts: [],
    claim: "profile validator smoke",
    checkPlan: "stage validator",
    validatorIDs: preBlankLayout.map((item) => item.id),
    retryBudget: 0,
    status: "active",
    attemptCount: 1,
  },
  stage: "pre_blank",
  targets: ["layout"],
  runID: "smoke-profile-run",
  attempt: 1,
  stageDir: path.join(smokeRoot, "profile-stage"),
  bundlePath: path.join(smokeRoot, "profile-stage-bundle.json"),
  payload: {
    task: "profile-smoke",
  },
  validators: loaded.spec.validators,
})
assert(profileStageResult.passed === true, "expected pre_blank layout validation stage to pass")
assert(await pathExists(profileStageResult.resultPath), "expected stage result path to exist")
const heldoutStageResult = await runValidationStage({
  cwd,
  config: {} as AutoEvolveConfig,
  spec: loaded.spec,
  unit: {
    id: "heldout-unit",
    title: "Heldout Unit",
    goal: "Run heldout product validator.",
    inputs: [],
    dependsOn: [],
    expectedArtifacts: [],
    claim: "heldout validator smoke",
    checkPlan: "stage validator",
    validatorIDs: heldoutProduct.map((item) => item.id),
    retryBudget: 0,
    status: "active",
    attemptCount: 1,
  },
  stage: "heldout_test",
  targets: ["product"],
  runID: "smoke-heldout-run",
  attempt: 1,
  stageDir: path.join(smokeRoot, "heldout-stage"),
  bundlePath: path.join(smokeRoot, "heldout-stage-bundle.json"),
  payload: {
    task: "heldout-smoke",
  },
  validators: loaded.spec.validators,
})
assert(heldoutStageResult.passed === true, "expected heldout_test product validation stage to pass")

const validatorDir = path.join(smokeRoot, "validator-run")
const spec: LongTaskSpec = {
  id: "smoke-validation-engine",
  title: "Smoke Validation Engine",
  goal: "Verify validation-engine long-task adapter.",
  materials: [],
  validators: [],
}
const unit: LongTaskWorkUnit = {
  id: "unit-001",
  title: "Smoke Unit",
  goal: "Run script validator.",
  inputs: [],
  dependsOn: [],
  expectedArtifacts: [],
  claim: "validator smoke",
  checkPlan: "script validator",
  validatorIDs: ["smoke-script"],
  retryBudget: 0,
  status: "active",
  attemptCount: 1,
}

const result = await runLongTaskValidator({
  cwd,
  config: {} as AutoEvolveConfig,
  contract: {
    id: "smoke-script",
    type: "script",
    title: "Smoke Script Validator",
    path: validatorScript,
    runner: "python",
    placement: "completion_only",
    blocking: true,
  },
  spec,
  unit,
  runID: "smoke-run",
  attempt: 1,
  validatorDir,
  bundlePath: path.join(validatorDir, "bundle.json"),
  payload: {
    task: "smoke",
    privateAnswerPath: "C:/tmp/private-answers/demo/answer.txt",
  },
})

assert(result.passed === true, "expected validator result to pass")
assert(result.blocking === true, "expected validator result to be blocking")

const privatePath = path.join(validatorDir, "result.private.json")
const trainingPath = path.join(validatorDir, "result.training.json")
const sanitizedPath = path.join(validatorDir, "result.sanitized.json")
const scoreOnlyPath = path.join(validatorDir, "result.score_only.json")
for (const file of [privatePath, trainingPath, sanitizedPath, scoreOnlyPath]) {
  assert(await pathExists(file), `missing validation result view: ${file}`)
}

const training = await readJsonFile<Record<string, unknown>>(trainingPath)
const sanitized = await readJsonFile<Record<string, unknown>>(sanitizedPath)
const trainingRaw = JSON.stringify(training)
const sanitizedRaw = JSON.stringify(sanitized)
assert(trainingRaw.includes("123.45"), "training view should preserve numeric literals for open-book repair agents")
assert(!trainingRaw.includes("private-answers/demo"), "training view should redact private answer paths")
assert(!sanitizedRaw.includes("123.45"), "sanitized view should redact numeric literals")
assert(!sanitizedRaw.includes("private-answers/demo"), "sanitized view should redact private answer paths")

let blockedBlankAgent = false
try {
  assertAudienceCanReadValidationView("blank_agent", "sanitized")
} catch {
  blockedBlankAgent = true
}
assert(blockedBlankAgent, "blank_agent must not be allowed to read validation result views")

console.log(
  JSON.stringify(
    {
      passed: true,
      result: {
        validatorID: result.validatorID,
        summary: result.summary,
      },
      viewPaths: {
        privatePath,
        trainingPath,
        sanitizedPath,
        scoreOnlyPath,
      },
      profileModules: describeValidationModules(loaded.spec.validators),
      profileStageResultPath: profileStageResult.resultPath,
      heldoutStageResultPath: heldoutStageResult.resultPath,
    },
    null,
    2,
  ),
)
