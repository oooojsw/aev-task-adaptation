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
