import type { LongTaskValidatorContract } from "../long-task/contract"
import type { ValidationStage, ValidationTargetKind } from "./contract"

function inferredStage(validator: LongTaskValidatorContract): ValidationStage {
  if (validator.validation?.stage) return validator.validation.stage
  if (validator.placement === "completion_only") return "post_blank"
  return "local_training"
}

function inferredTarget(validator: LongTaskValidatorContract): ValidationTargetKind {
  if (validator.validation?.target) return validator.validation.target
  const descriptor = [
    validator.id,
    validator.title,
    validator.type === "script" ? validator.path : validator.prompt,
  ]
    .join(" ")
    .toLowerCase()
  if (descriptor.includes("layout")) return "layout"
  if (descriptor.includes("surface") || descriptor.includes("generalization") || descriptor.includes("leak")) {
    return "surface"
  }
  if (descriptor.includes("regression")) return "regression"
  return "product"
}

export function selectValidationModules(input: {
  validators: LongTaskValidatorContract[]
  stage?: ValidationStage
  targets?: ValidationTargetKind[]
}) {
  return input.validators.filter((validator) => {
    if (input.stage && inferredStage(validator) !== input.stage) return false
    if (input.targets?.length && !input.targets.includes(inferredTarget(validator))) return false
    return true
  })
}

export function describeValidationModules(validators: LongTaskValidatorContract[]) {
  return validators.map((validator) => ({
    id: validator.id,
    title: validator.title,
    type: validator.type,
    target: inferredTarget(validator),
    stage: inferredStage(validator),
    blocking: validator.blocking === true,
    answerAccess: validator.validation?.answerAccess,
    allowedAudiences: validator.validation?.allowedAudiences ?? [],
  }))
}
