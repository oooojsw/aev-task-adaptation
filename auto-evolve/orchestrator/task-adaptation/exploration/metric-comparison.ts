import { fingerprint } from "../../protocol-plugins/identity"

export function metricComparison(input: {
  plan: string; protocol: string; phase: string; task: string
  materials: unknown; privateInputs: unknown; selection: unknown
  executor?: string; product?: unknown
}) {
  const { executor, product, ...fixed } = input
  let dependencies: string | undefined
  if (executor === "consolidation-direct-chat") {
    const value = product as Record<string, unknown> | undefined
    if (value?.schema !== "aev.consolidation-eval.v1" ||
      typeof value.dependencies_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.dependencies_sha256)) {
      throw new Error("Metric comparison requires verified consolidation dependency identity")
    }
    dependencies = value.dependencies_sha256
  }
  // 间接评分依赖也属考试条件；候选和本次答卷不参与可比身份。
  return fingerprint({ schema: "aev.exploration-metric-comparison.v1", ...fixed,
    ...(dependencies ? { dependencies } : {}) })
}
