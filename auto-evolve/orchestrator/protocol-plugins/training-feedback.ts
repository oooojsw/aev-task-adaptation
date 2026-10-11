import type { Snapshot, Phase, Outcome, Target } from "./contract"

export function trainingCheckMessage(snapshot: Snapshot, phase: Phase,
  result: { name: string; target: Target; status: Outcome; message: string }) {
  const check = snapshot.selection.protocol.phases[phase]?.checks.find((item) => item.name === result.name)
  if (!check || check.target !== result.target) throw new Error("Training feedback check identity mismatch")
  // 原始评分文字可能含私有答案，仅显式授权才给训练侧。
  if (check.feedback === "checker_message" && ["passed", "rejected"].includes(result.status)) return result.message
  return `Declared ${check.target} check ${check.name}: ${result.status}`
}
