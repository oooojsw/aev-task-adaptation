import type { LongTaskValidatorContract } from "../long-task/contract"
import type { ValidationAudience, ValidationStage, ValidationTargetKind } from "./contract"

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
    validator.type === "script"
      ? validator.path
      : validator.type === "prompt_json"
        ? validator.prompt
        : `${validator.planPath} ${validator.skillRootPath}`,
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

/**
 * Reject validator profiles that grant `blank_agent` access to validation result views.
 *
 * `blank_agent` is closed-book: it must never read result.private.json, result.training.json,
 * result.sanitized.json, or any oracle/private answer evidence. Profiles that list it
 * in `allowedAudiences` are misconfigured and must fail fast at load time.
 */
export function assertNoBlankAgentAudience(
  validator: LongTaskValidatorContract,
  audiences?: ValidationAudience[],
) {
  const list = audiences ?? validator.validation?.allowedAudiences ?? []
  if (list.includes("blank_agent")) {
    throw new Error(
      `Validator '${validator.id}' has allowedAudiences containing 'blank_agent'. ` +
        `blank_agent cannot read any validation result view. ` +
        `Remove 'blank_agent' from allowedAudiences; use audit / dashboard / memory for monitoring instead.`,
    )
  }
}

export function assertNoBlankAgentAudienceInList(
  validators: LongTaskValidatorContract[],
  audiencesList?: Array<ValidationAudience[] | undefined>,
) {
  for (let i = 0; i < validators.length; i += 1) {
    const audiences = audiencesList?.[i] ?? validators[i].validation?.allowedAudiences
    assertNoBlankAgentAudience(validators[i], audiences)
  }
}
