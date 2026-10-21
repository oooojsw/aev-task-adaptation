import path from "node:path"
import { readFile, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import type { OpencodeRunResult } from "../opencode"
import { writeFileAtomic } from "../atomic-write"

export interface WorkerAnswer {
  file: "final-answer.txt"
  sha256: string
  status: "complete" | "unavailable"
  reason?: string
}

export function finalWorkerAnswer(result: Pick<OpencodeRunResult, "events" | "exitCode" | "sessionID">) {
  const messages = new Map<string, { summary?: boolean; role?: string }>()
  for (const event of result.events) {
    if (event.type === "assistant_message" && event.message?.id) messages.set(event.message.id, event.message)
  }
  const last = result.events.filter(event => event.type === "step_finish" &&
    (!result.sessionID || !event.sessionID || event.sessionID === result.sessionID)).at(-1)
  const id = last?.part?.messageID as string | undefined
  const message = id ? messages.get(id) : undefined
  // 只交付最后正常结束的非压缩回答，工具前言不算成果。
  if (result.exitCode !== 0 || result.events.some(event => event.type === "error")) return { reason: "worker_execution_failed" }
  if (!message || message.role !== "assistant") return { reason: "final_message_identity_missing" }
  if (message.summary) return { reason: "summary_is_not_worker_delivery" }
  if (last?.part?.reason !== "stop") return { reason: `worker_not_finished:${last?.part?.reason ?? "missing"}` }
  const parts = new Map<string, string>()
  for (const event of result.events) {
    const part = event.part
    if (event.type === "text" && part?.messageID === id && typeof part.text === "string" &&
        (!result.sessionID || event.sessionID === result.sessionID)) parts.set(part.id ?? String(parts.size), part.text)
  }
  const text = [...parts.values()].join("\n\n")
  return text.trim() ? { text } : { reason: "final_answer_empty" }
}

export async function publishWorkerAnswer(dir: string, result: OpencodeRunResult): Promise<WorkerAnswer> {
  const answer = finalWorkerAnswer(result)
  const text = answer.text ?? `Worker did not deliver a complete final answer. Reason: ${answer.reason}. Do not treat this as analysis or acceptance.`
  await writeFileAtomic(path.join(dir, "final-answer.txt"), text)
  return { file: "final-answer.txt", sha256: createHash("sha256").update(text).digest("hex"),
    status: answer.text === undefined ? "unavailable" : "complete", ...(answer.reason ? { reason: answer.reason } : {}) }
}

export async function readWorkerAnswer(dir: string, answer: WorkerAnswer) {
  if (answer.file !== "final-answer.txt" || !/^[a-f0-9]{64}$/.test(answer.sha256) ||
      !["complete", "unavailable"].includes(answer.status)) throw new Error("Invalid worker final answer identity")
  const root = await realpath(dir)
  const file = await realpath(path.join(root, answer.file))
  if (path.relative(root, file) !== answer.file) throw new Error("Linked worker final answer rejected")
  const bytes = await readFile(file)
  if (createHash("sha256").update(bytes).digest("hex") !== answer.sha256) throw new Error("Worker final answer fingerprint drift")
  return bytes.toString("utf8")
}

export async function workerDelivery(dir: string, answer?: WorkerAnswer) {
  if (answer) {
    await readWorkerAnswer(dir, answer)
    return path.join(dir, answer.file)
  }
  // 旧记录缺少最终消息身份，不把混合轨迹冒充最终答复。
  const file = path.join(dir, "final-answer-unavailable.txt")
  await writeFileAtomic(file, "Historical worker result has no verified final-answer artifact. Preserve it for audit; no automatic replay is authorized.")
  return file
}
