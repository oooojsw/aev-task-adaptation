import path from "node:path"
import { mkdir, open, readFile } from "node:fs/promises"
import { prepareEntry, runEntry, type Entry } from "./entry"
import { deriveEntry } from "./derive-entry"
import { copyCandidate, readCandidate } from "./candidate"
import { writeJsonAtomic } from "../atomic-write"
import type { Runtime } from "./runtime"
import { canonical, fingerprint } from "./identity"
type Receipt = Awaited<ReturnType<typeof runEntry>>

export type RepairAuthor = (input: { candidateRoot: string; entries: string[];
  feedback: { status: "rejected"; checks: Array<{ name: string; target: string; message: string }> };
  mode: "append_only" | "rewrite" }) => Promise<{ completed: boolean; evidence: string[] }>

export async function mergeRepair(input: { parentRunRoot: string; parentEntry: Entry;
  repairRoot: string; candidateRoot: string; initial: Receipt; initialReceiptPath: string; maxAttempts: number;
  mode: "append_only" | "rewrite"; runtime: Runtime; author: RepairAuthor; authorIdentity: string }) {
  if (!path.isAbsolute(input.repairRoot) || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 ||
      !["append_only", "rewrite"].includes(input.mode) || !/^[a-f0-9]{64}$/.test(input.authorIdentity)) throw new Error("Explicit bounded repair configuration required")
  if (input.initial.status !== "rejected" || input.parentEntry.phase === "test") throw new Error("Only ordinary non-test rejection may trigger repair")
  const parent = await prepareEntry(input.parentRunRoot, input.parentEntry, input.runtime)
  if (!parent || !parent.protocol.selection.protocol.phases.replay) throw new Error("Explicit replay protocol required for repair")
  const skill = parent.project.pack.skill
  const base = await readCandidate(input.candidateRoot, skill)
  if (!path.isAbsolute(input.initialReceiptPath) || path.basename(input.initialReceiptPath) !== "protocol.receipt.json") {
    throw new Error("Persisted rejection receipt required")
  }
  await readFile(path.join(path.dirname(input.initialReceiptPath), "protocol.started.claim"))
  const saved = JSON.parse((await readFile(input.initialReceiptPath, "utf8")).replace(/^\uFEFF/, ""))
  if (canonical(saved) !== canonical(input.initial) || saved.schema !== "aev.protocol-receipt.v1" ||
      saved.protocolFingerprint !== parent.protocol.fingerprint || saved.task !== input.parentEntry.taskID ||
      saved.phase === "test" || !parent.protocol.selection.protocol.phases[saved.phase as "source" | "merge" | "replay"] ||
      !saved.checks.some((check: { required: boolean; status: string }) => check.required && check.status === "rejected")) {
    throw new Error("Repair rejection receipt identity mismatch")
  }
  const actual = base.metadata.map((item) => ({ id: item.id, kind: item.kind, sha256: item.sha256, length: item.bytes }))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (canonical(saved.evidence.skill) !== canonical(actual)) throw new Error("Rejected Skill differs from repair candidate")
  const task = parent.project.pack.tasks.find((item) => item.id === saved.task)
  if (!task || task.split !== "train") throw new Error("Repair requires frozen training task")
  for (const role of ["materials", "privateInputs"] as const) {
    const expected = task[role].map((item) => {
      const file = parent.project.artifacts.find((artifact) => artifact.path === item.path)
      if (!file) throw new Error("Missing frozen repair input")
      return { id: item.id, kind: item.kind, sha256: file.sha256, length: file.bytes }
    }).sort((a, b) => a.id.localeCompare(b.id))
    if (canonical(saved.evidence[role]) !== canonical(expected)) throw new Error("Repair task input receipt mismatch")
  }
  const binding = { parentRunRoot: input.parentRunRoot, entry: input.parentEntry,
    protocol: parent.protocol.fingerprint, project: parent.project.fingerprint, candidate: base.fingerprint,
    rejection: fingerprint(saved), mode: input.mode, maxAttempts: input.maxAttempts, author: input.authorIdentity }
  await mkdir(input.repairRoot, { recursive: true })
  try {
    const claim = await open(path.join(input.repairRoot, "repair.started.claim"), "wx")
    await claim.close()
    await writeJsonAtomic(path.join(input.repairRoot, "repair.snapshot.json"), binding)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const previous = JSON.parse((await readFile(path.join(input.repairRoot, "repair.snapshot.json"), "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(previous) !== canonical(binding)) throw new Error("Frozen repair configuration changed")
  }
  let feedback = input.initial
  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const root = path.join(input.repairRoot, `attempt-${String(attempt).padStart(2, "0")}`)
    await mkdir(root, { recursive: true })
    const draft = path.join(root, "candidate")
    try {
      const completed = JSON.parse((await readFile(path.join(root, "completed.json"), "utf8")).replace(/^\uFEFF/, ""))
      await readFile(path.join(root, "author.started.claim"))
      const { hash, ...body } = completed
      // 恢复同时核对作者输入与回执，避免仅凭候选误认完成。
      const request = JSON.parse((await readFile(path.join(root, "author.request.json"), "utf8")).replace(/^\uFEFF/, ""))
      const author = JSON.parse((await readFile(path.join(root, "author.result.json"), "utf8")).replace(/^\uFEFF/, ""))
      if (hash !== fingerprint(body) || body.binding !== fingerprint(binding) ||
          body.authorRequest !== fingerprint(request) || body.authorResult !== fingerprint(author) || author.completed !== true ||
          !["edit_rejected", "rejected", "passed"].includes(body.outcome) ||
          (await readCandidate(draft, skill)).fingerprint !== body.candidate) throw new Error("Repair checkpoint identity changed")
      if (body.outcome === "edit_rejected") continue
      const receipt = JSON.parse((await readFile(path.join(root, "replay", "attempt", "protocol.receipt.json"), "utf8")).replace(/^\uFEFF/, "")) as Receipt
      if (fingerprint(receipt) !== body.receipt || receipt.status !== body.outcome || receipt.protocolFingerprint !== parent.protocol.fingerprint) {
        throw new Error("Repair checkpoint receipt changed")
      }
      feedback = receipt
      if (body.outcome === "passed") return { fixed: true, attempts: attempt, candidateRoot: draft, receipt }
      continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    // 未完成的作者调用不能被循环或恢复静默重发。
    const claim = await open(path.join(root, "author.started.claim"), "wx")
    await claim.close()
    await copyCandidate(input.candidateRoot, draft, skill)
    const request: Parameters<RepairAuthor>[0] = { candidateRoot: draft,
      entries: skill.entries.map((item) => item.path), mode: input.mode,
      feedback: { status: "rejected", checks: feedback.checks.filter((item) => item.required && item.status === "rejected")
        .map((item) => ({ name: item.name, target: item.target, message: item.message })) } }
    await writeJsonAtomic(path.join(root, "author.request.json"), request)
    const author = await input.author(request)
    await writeJsonAtomic(path.join(root, "author.result.json"), author)
    if (!author.completed) throw new Error("Repair author incomplete; inspect before retry")
    const candidate = await readCandidate(draft, skill)
    // 只检查声明入口，不依赖INDEX/CORE等固定文件名。
    const preserved = input.mode === "rewrite" || base.files.every((file, index) =>
      candidate.files[index].data.subarray(0, file.data.length).equals(file.data))
    await writeJsonAtomic(path.join(root, "edit-check.json"), { mode: input.mode, preserved,
      before: base.fingerprint, after: candidate.fingerprint })
    const checkpoint = async (outcome: "edit_rejected" | "rejected" | "passed", receipt?: Receipt) => {
      const body = { binding: fingerprint(binding), candidate: candidate.fingerprint, outcome,
        authorRequest: fingerprint(request), authorResult: fingerprint(author),
        ...(receipt ? { receipt: fingerprint(receipt) } : {}) }
      await writeJsonAtomic(path.join(root, "completed.json"), { ...body, hash: fingerprint(body) })
    }
    if (!preserved) { await checkpoint("edit_rejected"); continue }
    const runRoot = path.join(root, "replay")
    const entry = await deriveEntry({ parentRunRoot: input.parentRunRoot, parentEntry: input.parentEntry,
      runRoot, phase: "replay", taskID: input.parentEntry.taskID, runtime: input.runtime })
    feedback = await runEntry(runRoot, entry, draft, path.join(runRoot, "attempt"), input.runtime)
    if (!["passed", "rejected"].includes(feedback.status)) throw new Error("Repair replay infrastructure fault; no further author calls")
    // 拒绝证据也必须对应稳定候选，否则不能继续修订。
    if ((await readCandidate(draft, skill)).fingerprint !== candidate.fingerprint ||
        (await readCandidate(input.candidateRoot, skill)).fingerprint !== base.fingerprint) throw new Error("Repair candidate changed during acceptance")
    if (feedback.status === "passed") {
      await checkpoint("passed", feedback)
      return { fixed: true, attempts: attempt, candidateRoot: draft, receipt: feedback }
    }
    await checkpoint("rejected", feedback)
  }
  return { fixed: false, attempts: input.maxAttempts, candidateRoot: input.candidateRoot, receipt: feedback }
}
