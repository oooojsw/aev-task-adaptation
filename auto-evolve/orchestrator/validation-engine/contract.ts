import type { OpencodeTaskInput } from "../opencode"

export type ValidationTargetKind = "surface" | "product" | "behavior" | "regression" | "transaction" | "layout"

export type ValidationMechanism = "hard_script" | "soft_llm"

export type ValidationStage =
  | "local_training"
  | "pre_blank"
  | "post_blank"
  | "post_merge"
  | "rollback"
  | "train_replay"
  | "heldout_test"
  | "judge"

export type ValidationAudience =
  | "executor"
  | "worker"
  | "lead"
  | "reviewer"
  | "merger"
  | "repair_agent"
  | "dashboard"
  | "blank_agent"
  | "memory"
  | "audit"

export type ValidationAnswerAccess = "none" | "private_oracle" | "full_training"

export type ValidationResultViewKind = "private" | "training" | "sanitized" | "score_only"

/**
 * Validation result views semantics:
 *
 * - `private` (result.private.json):
 *     Full open-book oracle/diagnostic view for non-Blank working nodes.
 *     Readable by: executor, worker, lead, reviewer, merger, repair_agent, audit.
 *     NOT readable by: blank_agent, dashboard, memory.
 *     Contains: full validator payload, raw output, evidence refs, exact private answer paths.
 *
 * - `training` (result.training.json):
 *     Lightweight training view for non-Blank working nodes.
 *     Readable by: same audiences as `private` (above).
 *     Contains: numeric literals preserved for open-book learning/repair.
 *     Redacted: private answer paths → `<PRIVATE_ANSWER_PATH>`.
 *     NOT redacted (object-key level): answer/ground/private field names.
 *
 * - `sanitized` (result.sanitized.json):
 *     Public monitoring view.
 *     Readable by: dashboard, memory, and the same non-Blank audiences.
 *     Strongly redacted: answer/ground/private fields, raw output, stdout/stderr.
 *
 * - `score_only` (result.score_only.json):
 *     Statistical view.
 *     Readable by: dashboard, memory, and the same non-Blank audiences.
 *     Contains: passed/score/blocking only.
 *
 * - `blank_agent`:
 *     NOT allowed to read any validation result view.
 *     NOT allowed to read private-answers, ground-truth, answer-key, or hidden validator files.
 *
 * Core principle:
 *   Non-Blank nodes can see the oracle so they can do open-book learning and repair.
 *   Red-team / Surface / Generalization validators prevent answer/cheat/case-specific literal /
 *     private path / validator-only truth from entering the pending expert package or merged skill.
 *   Blue-team / Blank Eval proves the final skill can guide a blank agent to complete the task.
 */

export interface ValidationModuleDescriptor {
  id: string
  title: string
  target: ValidationTargetKind
  mechanism: ValidationMechanism
  stage: ValidationStage
  blocking: boolean
  answerAccess: ValidationAnswerAccess
  allowedAudiences: ValidationAudience[]
  notes?: string[]
}

export interface ValidationContext {
  cwd: string
  runID: string
  unitID: string
  attempt: number
  validatorDir: string
  runtimeScope?: string
  onActivation?: OpencodeTaskInput["onSpawn"]
  onPulse?: OpencodeTaskInput["onPulse"]
  payload: Record<string, unknown>
  bundlePath?: string
  task?: {
    id?: string
    title?: string
    family?: string
    goal?: string
  }
  resultRouting?: {
    audiences?: ValidationAudience[]
    writeViews?: boolean
  }
}

export interface ValidationResult {
  id: string
  runID: string
  unitID: string
  attempt: number
  validatorID: string
  validatorType: "script" | "prompt_json" | "engine"
  createdAt: string
  passed: boolean
  blocking: boolean
  summary: string
  details: string[]
  evidenceRefs: string[]
  rawOutputPath?: string
}

export interface ValidationResultViews {
  private: Record<string, unknown>
  training: Record<string, unknown>
  sanitized: Record<string, unknown>
  score_only: Record<string, unknown>
}

export interface ValidationEngineResult {
  descriptor: ValidationModuleDescriptor
  result: ValidationResult
  views: ValidationResultViews
  viewPaths?: Partial<Record<ValidationResultViewKind, string>>
}
