import path from "node:path"
import { mkdir, open } from "node:fs/promises"
import { prepareEntry, runEntry, type Entry } from "./entry"
import { deriveEntry } from "./derive-entry"
import { copyCandidate, readCandidate } from "./candidate"
import { writeJsonAtomic } from "../atomic-write"
import type { Runtime } from "./runtime"
type Receipt = Awaited<ReturnType<typeof runEntry>>

export type RepairAuthor = (input: { candidateRoot: string; entries: string[];
  feedback: { status: "rejected"; checks: Array<{ name: string; target: string; message: string }> };
  mode: "append_only" | "rewrite" }) => Promise<{ completed: boolean; evidence: string[] }>

export async function mergeRepair(input: { parentRunRoot: string; parentEntry: Entry;
  repairRoot: string; candidateRoot: string; initial: Receipt; maxAttempts: number;
  mode: "append_only" | "rewrite"; runtime: Runtime; author: RepairAuthor }) {
  if (!path.isAbsolute(input.repairRoot) || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 ||
      !["append_only", "rewrite"].includes(input.mode)) throw new Error("Explicit bounded repair configuration required")
  if (input.initial.status !== "rejected" || input.parentEntry.phase === "test") throw new Error("Only ordinary non-test rejection may trigger repair")
  const parent = await prepareEntry(input.parentRunRoot, input.parentEntry, input.runtime)
  if (!parent || !parent.protocol.selection.protocol.phases.replay) throw new Error("Explicit replay protocol required for repair")
  const skill = parent.project.pack.skill
  const base = await readCandidate(input.candidateRoot, skill)
  let feedback = input.initial
  for (let attempt = 1; attempt <= input.maxAttempts; attempt++) {
    const root = path.join(input.repairRoot, `attempt-${String(attempt).padStart(2, "0")}`)
    await mkdir(root, { recursive: true })
    // 未完成的作者调用不能被循环或恢复静默重发。
    const claim = await open(path.join(root, "author.started.claim"), "wx")
    await claim.close()
    const draft = path.join(root, "candidate")
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
    if (!preserved) continue
    const runRoot = path.join(root, "replay")
    const entry = await deriveEntry({ parentRunRoot: input.parentRunRoot, parentEntry: input.parentEntry,
      runRoot, phase: "replay", taskID: input.parentEntry.taskID, runtime: input.runtime })
    feedback = await runEntry(runRoot, entry, draft, path.join(runRoot, "attempt"), input.runtime)
    if (!["passed", "rejected"].includes(feedback.status)) throw new Error("Repair replay infrastructure fault; no further author calls")
    if (feedback.status === "passed") {
      // 验收后再次核对正文，防止晋级到验收未读取的版本。
      if ((await readCandidate(draft, skill)).fingerprint !== candidate.fingerprint ||
          (await readCandidate(input.candidateRoot, skill)).fingerprint !== base.fingerprint) throw new Error("Repair candidate changed during acceptance")
      return { fixed: true, attempts: attempt, candidateRoot: draft, receipt: feedback }
    }
  }
  return { fixed: false, attempts: input.maxAttempts, candidateRoot: input.candidateRoot, receipt: feedback }
}
