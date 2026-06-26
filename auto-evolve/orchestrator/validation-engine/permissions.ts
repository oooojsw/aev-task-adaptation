import type { ValidationAudience, ValidationResultViewKind } from "./contract"

/**
 * Audiences that can read the full open-book oracle view (result.private.json).
 * These are non-Blank working nodes that need oracle evidence for open-book
 * learning, diagnosis, repair, and generalization.
 */
const FULL_ORACLE_VIEWS: ValidationResultViewKind[] = [
  "private",
  "training",
  "sanitized",
  "score_only",
]

/**
 * Audiences that can only read public monitoring views.
 * Dashboard, memory, and long-term persistence must not see oracle/private data.
 */
const PUBLIC_MONITORING_VIEWS: ValidationResultViewKind[] = [
  "sanitized",
  "score_only",
]

const AUDIENCE_VIEW_ACCESS: Record<ValidationAudience, ValidationResultViewKind[]> = {
  executor: FULL_ORACLE_VIEWS,
  worker: FULL_ORACLE_VIEWS,
  lead: FULL_ORACLE_VIEWS,
  reviewer: FULL_ORACLE_VIEWS,
  merger: FULL_ORACLE_VIEWS,
  repair_agent: FULL_ORACLE_VIEWS,

  dashboard: PUBLIC_MONITORING_VIEWS,
  memory: PUBLIC_MONITORING_VIEWS,

  blank_agent: [],

  audit: FULL_ORACLE_VIEWS,
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
