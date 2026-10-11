import path from "node:path"
import { readFile } from "node:fs/promises"
import { canonical } from "./identity"
import type { Snapshot } from "./contract"

export async function regressionEvidence(input: { taskID: string; sourceReceiptPath?: string;
  protocol: Snapshot; replay: { status: string; claim: string; executed: boolean; evidence: unknown } }) {
  const no = (reason: string) => ({ comparable: false, regression: false, reason })
  const sourcePlan = input.protocol.selection.protocol.phases.source
  const replayPlan = input.protocol.selection.protocol.phases.replay
  // 文本检查拒绝不是能力丢失；两次执行口径不同也不能归因合并。
  if (sourcePlan?.claim !== "task_execution" || replayPlan?.claim !== "task_execution" ||
      input.replay.claim !== "task_execution" || !input.replay.executed) return no("No paired task execution")
  if (canonical(sourcePlan) !== canonical(replayPlan)) return no("Source and replay execution/checking protocols differ")
  if (!input.sourceReceiptPath) return no("Source execution receipt unavailable")
  try {
    if (path.basename(input.sourceReceiptPath) !== "protocol.receipt.json") return no("Invalid source receipt path")
    const source = JSON.parse((await readFile(input.sourceReceiptPath, "utf8")).replace(/^\uFEFF/, ""))
    if (source.schema !== "aev.protocol-receipt.v1" || source.task !== input.taskID || source.phase !== "source" ||
        source.status !== "passed" || source.claim !== "task_execution" || source.executed !== true ||
        source.protocolFingerprint !== input.protocol.fingerprint) return no("Source receipt identity mismatch")
    const replay = input.replay.evidence as { materials?: unknown; privateInputs?: unknown }
    if (!source.evidence?.materials || !source.evidence?.privateInputs ||
        canonical([source.evidence.materials, source.evidence.privateInputs]) !== canonical([replay.materials, replay.privateInputs])) {
      return no("Source and replay material/scoring inputs differ")
    }
    return { comparable: true, regression: input.replay.status === "rejected", reason: "Matched source/replay task execution" }
  } catch {
    return no("Source execution evidence unreadable")
  }
}
