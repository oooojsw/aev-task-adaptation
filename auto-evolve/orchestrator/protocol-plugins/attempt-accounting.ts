import type { Snapshot, Phase } from "./contract"
import type { Runtime } from "./runtime"
import { fingerprint } from "./identity"

type Usage = { inputTokens?: number; outputTokens?: number }
type Receipt = Awaited<ReturnType<Runtime["run"]>>

function tokens(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

export function attemptAccounting(snapshot: Snapshot, phase: Phase, receipt: Receipt, elapsedMs: number) {
  const plan = snapshot.selection.protocol.phases[phase]
  if (!plan || receipt.phase !== phase || receipt.protocolFingerprint !== snapshot.fingerprint ||
      !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Accounting protocol identity mismatch")
  const rows: Array<{ role: string; plugin: string; status: string; reused: boolean;
    reportedInputTokens: number | null; reportedOutputTokens: number | null;
    newInputTokens: number | null; newOutputTokens: number | null }> = []
  const add = (role: string, plugin: string, status: string, reused: boolean, usage?: Usage) => {
    const input = tokens(usage?.inputTokens)
    const output = tokens(usage?.outputTokens)
    // 复用保留历史用量但新增为零；未报告用量不能猜成零。
    rows.push({ role, plugin, status, reused, reportedInputTokens: input, reportedOutputTokens: output,
      newInputTokens: reused ? 0 : input, newOutputTokens: reused ? 0 : output })
  }
  if (receipt.executionAttempted) {
    if (!plan.executor) throw new Error("Accounting executor binding missing")
    add("executor", `${plan.executor.id}@${plan.executor.version}`, receipt.executed ? "completed" : receipt.status,
      receipt.executionReused, receipt.usage)
  }
  for (const result of receipt.checks) {
    const check = plan.checks.find((item) => item.name === result.name)
    if (!check || check.target !== result.target) throw new Error("Accounting checker binding mismatch")
    add(`checker:${check.name}`, `${check.id}@${check.version}`, result.status, result.reused === true, result.usage)
  }
  const sum = (field: "newInputTokens" | "newOutputTokens") => ({
    knownTokens: rows.reduce((total, row) => total + (row[field] ?? 0), 0),
    unreportedInvocations: rows.filter((row) => row[field] === null).length,
  })
  return { schema: "aev.attempt-accounting.v1", task: receipt.task, phase,
    protocolFingerprint: snapshot.fingerprint, receiptFingerprint: fingerprint(receipt),
    elapsedMs, invocations: rows, input: sum("newInputTokens"), output: sum("newOutputTokens"),
    fee: null, feeStatus: "unpriced", scope: "acceptance adapters only; not training or merge authors; adapter invocations are not API request counts" }
}
