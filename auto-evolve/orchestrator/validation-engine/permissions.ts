import type { ValidationAudience, ValidationResultViewKind } from "./contract"

const AUDIENCE_VIEW_ACCESS: Record<ValidationAudience, ValidationResultViewKind[]> = {
  executor: ["training", "sanitized", "score_only"],
  worker: ["training", "sanitized", "score_only"],
  lead: ["training", "sanitized", "score_only"],
  reviewer: ["training", "sanitized", "score_only"],
  merger: ["training", "sanitized", "score_only"],
  repair_agent: ["training", "sanitized", "score_only"],
  dashboard: ["sanitized", "score_only"],
  blank_agent: [],
  memory: ["sanitized", "score_only"],
  audit: ["private", "training", "sanitized", "score_only"],
}

export function allowedValidationViewsForAudience(audience: ValidationAudience): ValidationResultViewKind[] {
  return [...AUDIENCE_VIEW_ACCESS[audience]]
}

export function canAudienceReadValidationView(audience: ValidationAudience, view: ValidationResultViewKind) {
  return AUDIENCE_VIEW_ACCESS[audience].includes(view)
}

export function assertAudienceCanReadValidationView(audience: ValidationAudience, view: ValidationResultViewKind) {
  if (canAudienceReadValidationView(audience, view)) return
  throw new Error(`Validation result view '${view}' is not readable by audience '${audience}'.`)
}
