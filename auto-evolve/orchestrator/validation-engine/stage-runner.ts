import path from "node:path"
import type {
  LongTaskSpec,
  LongTaskValidatorContract,
  LongTaskValidatorResult,
  LongTaskWorkUnit,
} from "../long-task/contract"
import type { AutoEvolveConfig } from "../schema"
import { ensureDirectory, pathExists, readJsonFile, writeJsonFile } from "../fs"
import type { OpencodeTaskInput } from "../opencode"
import { runLongTaskValidator } from "../long-task/validators"
import { selectValidationModules } from "./registry"
import type { ValidationResultViewKind, ValidationStage, ValidationTargetKind } from "./contract"

export interface ValidationStageRunResult {
  stage: ValidationStage
  targets?: ValidationTargetKind[]
  passed: boolean
  summary: string
  validatorResults: LongTaskValidatorResult[]
  resultPath: string
  trainingViewPaths: string[]
  sanitizedViewPaths: string[]
  scoreOnlyViewPaths: string[]
}

function short(text: string, limit = 260) {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= limit) return normalized
  return normalized.slice(0, limit - 3) + "..."
}

async function existingViewPath(validatorDir: string, view: ValidationResultViewKind) {
  const p = path.join(validatorDir, `result.${view}.json`)
  return (await pathExists(p)) ? p : undefined
}

async function readOptionalView(pathValue: string | undefined) {
  if (!pathValue) return undefined
  return readJsonFile<Record<string, unknown>>(pathValue).catch(() => undefined)
}

export async function runValidationStage(input: {
  cwd: string
  config: AutoEvolveConfig
  spec: LongTaskSpec
  unit: LongTaskWorkUnit
  stage: ValidationStage
  targets?: ValidationTargetKind[]
  runID: string
  attempt: number
  stageDir: string
  bundlePath: string
  payload: Record<string, unknown>
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
  validators?: LongTaskValidatorContract[]
}) {
  await ensureDirectory(input.stageDir)
  const candidates = input.validators ?? input.spec.validators
  const validators = selectValidationModules({
    validators: candidates,
    stage: input.stage,
    targets: input.targets,
  })
  const validatorResults: LongTaskValidatorResult[] = []
  const trainingViewPaths: string[] = []
  const sanitizedViewPaths: string[] = []
  const scoreOnlyViewPaths: string[] = []

  for (const validator of validators) {
    const validatorDir = path.join(input.stageDir, validator.id)
    const result = await runLongTaskValidator({
      cwd: input.cwd,
      config: input.config,
      contract: validator,
      spec: input.spec,
      unit: input.unit,
      runID: input.runID,
      attempt: input.attempt,
      validatorDir,
      bundlePath: input.bundlePath,
      payload: input.payload,
      runtimeScope: input.runtimeScope,
      onActivation: input.onActivation,
      onPulse: input.onPulse,
    })
    validatorResults.push(result)
    const training = await existingViewPath(validatorDir, "training")
    const sanitized = await existingViewPath(validatorDir, "sanitized")
    const scoreOnly = await existingViewPath(validatorDir, "score_only")
    if (training) trainingViewPaths.push(training)
    if (sanitized) sanitizedViewPaths.push(sanitized)
    if (scoreOnly) scoreOnlyViewPaths.push(scoreOnly)
  }

  const required = validatorResults.filter(
    (item) => validators.find((validator) => validator.id === item.validatorID)?.required !== false,
  )
  const passed = required.every((item) => item.passed)
  const summary = validators.length
    ? passed
      ? `Validation stage ${input.stage} passed (${validators.length} validator(s)).`
      : short(
          required
            .filter((item) => !item.passed)
            .map((item) => `${item.validatorID}: ${item.summary}`)
            .join(" | "),
        )
    : `Validation stage ${input.stage} had no matching validators.`
  const trainingViews = await Promise.all(trainingViewPaths.map(readOptionalView))
  const sanitizedViews = await Promise.all(sanitizedViewPaths.map(readOptionalView))
  const resultPath = path.join(input.stageDir, "stage-result.json")
  const stageResult: ValidationStageRunResult = {
    stage: input.stage,
    targets: input.targets,
    passed,
    summary,
    validatorResults,
    resultPath,
    trainingViewPaths,
    sanitizedViewPaths,
    scoreOnlyViewPaths,
  }
  await writeJsonFile(resultPath, {
    ...stageResult,
    validatorIDs: validators.map((item) => item.id),
    trainingViews: trainingViews.filter(Boolean),
    sanitizedViews: sanitizedViews.filter(Boolean),
  })
  return stageResult
}
