export type ProposedOperation = "author_work" | "protocol_check" | "independent_execution" | "host_acceptance" | "wait_host"

export function permitsAuthorOperation(raw: Record<string, unknown>, trustedProvided = false) {
  // 模型声明的正式步骤不交作者执行，显式配置旧工作单元可按作者任务接入。
  return raw.operation === "author_work" || trustedProvided && raw.operation === undefined
}
