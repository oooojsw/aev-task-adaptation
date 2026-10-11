/**
 * MultiInstanceCoordinator — types and persisted state contract.
 *
 * The coordinator runs the Fan-out / Fan-in design we agreed on:
 *
 *   Phase 1 (fanout):  launch N independent SkillsBench campaigns in parallel.
 *                      The OpenCodeGate caps real concurrency.
 *   Phase 2 (merge):   single skill-merger run reads all N harvested skills
 *                      and emits a unified skill (CORE.md + cases/).        [M3]
 *   Phase 3 (validate):solve-only re-run of the merged skill on every
 *                      instance to measure regression.                       [M4]
 *   Phase 4 (repair):  optional patch loop if validation regresses.          [later]
 *
 * This file only declares the shape. Behavior lives in coordinator.ts.
 */

export type InstanceStatus =
  | "queued"
  | "running"
  | "passed"      // Campaign verified_success — skill is "verified"
  | "exhausted"   // Hit round_limit_reached without success — skill is "unverified"
  | "failed"      // Crashed / aborted — skill not usable
  | "skipped"     // User-requested skip OR test-only instance not exercised in Phase 1
  | "removed"     // Removed via state edits

export type CoordinatorPhase =
  | "phase1_fanout"
  | "phase2_merge"
  | "phase3_validate"
  | "phase4_repair"
  | "completed"
  | "aborted"

export interface InstanceState {
  /** Stable identifier for this instance, e.g. "court-form-filling-1". */
  id: string
  /** Path to the source task root (under skillsbench tasks/, etc). */
  sourceTaskRoot: string
  /** Family of the underlying engine (currently always "skillsbench"). */
  engine: "skillsbench"
  /**
   * Train instances participate in Phase 1 (their skill feeds the merger).
   * Test instances skip Phase 1 entirely; they are only evaluated in Phase 3
   * with the merged skill, giving us a held-out pass-rate signal that the
   * merged skill actually generalizes.
   */
  role: "train" | "test"
  status: InstanceStatus
  /** Number of campaign rounds requested. */
  rounds: number
  /** When status entered terminal state. */
  finishedAt?: string
  /** SkillsBench campaign id once launched. */
  campaignID?: string
  /** SkillsBench run-root that owns the per-run artifacts. */
  campaignRunRoot?: string
  /** Path to the long-task-campaign directory (where pending-expert-package lives). */
  campaignDir?: string
  /** Resolved path to the per-instance skill snapshot (after fan-out). */
  harvestedSkillPath?: string
  /** Last error if status is "failed". */
  errorMessage?: string
  /** Phase 3 validation outcome (set after Phase 3 runs). */
  validateStatus?: "running" | "passed" | "failed" | "skipped"
  /** Path to the validation campaign directory, if any. */
  validateCampaignDir?: string
  /** SkillsBench run root for the validation pass. */
  validateRunRoot?: string
  /** Validation error message if validateStatus is "failed" due to a crash. */
  validateErrorMessage?: string
  /** New protocol fault blocks repair; it is not a Skill rejection. */
  validateProtocolFault?: boolean
}

export interface CoordinatorState {
  /** Coordinator run id, doubles as folder name. */
  id: string
  /** Free-form label for humans. */
  label: string
  phase: CoordinatorPhase
  createdAt: string
  updatedAt: string
  ownerPID?: number
  heartbeatAt?: string
  /** Top-level run root (where this state file lives). */
  runRoot: string
  /** Skill output directory used by phase 2/3/4. */
  mergedSkillDir?: string
  /** Post-merge validation status for the merged skill surface, if configured. */
  postMergeValidationStatus?: "passed" | "failed" | "skipped"
  postMergeValidationResultPath?: string
  postMergeValidationSummary?: string
  /** Configuration that produced this run (echoed for resume). */
  options: {
    skillsbenchRoot: string
    rounds: number
    /** Optional cap on simultaneous fan-out children. Forwarded to the gate. */
    fanoutLimit?: number
    /** Stop fan-out as soon as this many instances reach a terminal state.
     *  Default: all of them. */
    minTerminalToStop?: number
  }
  instances: InstanceState[]
  /** Reasons recorded when state transitions happen, for debugging. */
  log: Array<{ at: string; level: "info" | "warn" | "error"; message: string }>
}

export interface FanoutOutcome {
  totalInstances: number
  passed: number
  exhausted: number
  failed: number
  skipped: number
  durationMs: number
}
