export const METHOD_PRIMITIVE_OPS = [
  "solve_case",
  "finish_if_passed",
  "finish_if_eval_mode",
  "finish_if_max_retries_reached",
  "prepare_feedback_packet",
  "run_regression_before_maintenance",
  "invoke_knowledge_maintainer",
  "reject_if_maintenance_failed",
  "reject_if_no_experience_change",
  "reject_if_out_of_policy_files",
  "verify_current_case",
  "reject_if_current_case_not_fixed",
  "run_regression_after_maintenance",
  "accept_or_reject_change",
  "finish_after_accept",
] as const

export type MethodPrimitiveOp = (typeof METHOD_PRIMITIVE_OPS)[number]

export function isMethodPrimitiveOp(input: string): input is MethodPrimitiveOp {
  return (METHOD_PRIMITIVE_OPS as readonly string[]).includes(input)
}
