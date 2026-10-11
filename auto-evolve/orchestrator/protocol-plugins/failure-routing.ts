import type { Outcome, Target } from "./contract"

export interface ProtocolRepairCheck { name: string; target: Target; required: boolean; status: Outcome }

export function protocolRepairDirective(check: ProtocolRepairCheck) {
  if (!check || !check.name || !["skill", "product"].includes(check.target) || typeof check.required !== "boolean") {
    throw new Error("Explicit protocol repair object required")
  }
  if (!check.required || check.status === "passed") return undefined
  // 正常拒绝修Skill，评分/数据/接口故障交平台，不能修错对象。
  if (check.status !== "rejected") return { key: `acceptance-fault:${check.name}`,
    title: `Inspect acceptance backend fault ${check.name}`,
    actionableFix: "Stop and preserve actual evidence. Platform must inspect execution/scoring/data faults. Do not revise Skill or change scoring/private labels to hide an infrastructure fault." }
  return { key: `skill:${check.target}:${check.name}`,
    title: check.target === "product" ? `Revise Skill after product rejection ${check.name}` : `Revise Skill after constraint rejection ${check.name}`,
    actionableFix: check.target === "product"
      ? "Inspect actual answer and public materials; revise reusable Skill guidance. Host alone re-executes and scores. Do not repair the checker or launch formal acceptance."
      : "Revise the candidate Skill to satisfy the declared constraint. Host alone checks the revised candidate; do not modify the checker or private labels." }
}
