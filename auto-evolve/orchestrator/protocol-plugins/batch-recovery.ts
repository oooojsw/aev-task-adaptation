import path from "node:path"
import { readFile, mkdir, rename, realpath, lstat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { identifyProcessOwner } from "../process-identity"
import { canonical, fingerprint } from "./identity"
import { writeJsonAtomic } from "../atomic-write"

export async function recoverBatchLease(input: { runRoot: string; expectedNonce: string },
  identify: typeof identifyProcessOwner = identifyProcessOwner) {
  if (!path.isAbsolute(input.runRoot) || typeof input.expectedNonce !== "string" || !input.expectedNonce.trim()) {
    throw new Error("Explicit batch root and inspected owner nonce required")
  }
  const root = path.resolve(input.runRoot)
  if (await realpath(root) !== root) throw new Error("Batch recovery root link rejected")
  const leasePath = path.join(root, "project-batch.invocation.claim")
  if ((await lstat(leasePath)).isSymbolicLink()) throw new Error("Batch recovery lease link rejected")
  const bytes = await readFile(leasePath)
  const lease = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))
  if (lease.nonce !== input.expectedNonce || !Number.isSafeInteger(lease.pid) || lease.pid < 1 ||
      typeof lease.startedAt !== "string" || !Number.isFinite(Date.parse(lease.startedAt))) {
    throw new Error("Inspected batch lease identity mismatch")
  }
  const stopped = async () => {
    const result = await identify({ pid: lease.pid,
      ...(typeof lease.ownerCreationTick === "string" ? { expectedCreationTick: lease.ownerCreationTick } : {}) })
    // wrong_owner可能来自弱提示，只有明确创建时间不同才证明PID复用。
    const reusedPID = result.alive && typeof lease.ownerCreationTick === "string" &&
      typeof result.creationTick === "string" && result.creationTick !== lease.ownerCreationTick
    if (result.ownership !== "dead" && !reusedPID) throw new Error("Batch owner live or unverified; recovery blocked")
    return result
  }
  const first = await stopped()
  const recoveryRoot = path.join(root, "batch-recovery")
  await mkdir(recoveryRoot, { recursive: true })
  if (await realpath(recoveryRoot) !== recoveryRoot) throw new Error("Batch recovery evidence root link rejected")
  const evidence = path.join(recoveryRoot, randomUUID())
  await mkdir(evidence)
  await writeJsonAtomic(path.join(evidence, "inspection.json"), { schema: "aev.batch-recovery.v1",
    lease, leaseFingerprint: fingerprint(lease), observedOwner: first, requestedAt: new Date().toISOString(),
    action: "archive stopped owner lease only; no process termination or model invocation" })
  // 移动前再次核验身份和文件，避免检查期间换锁。
  await stopped()
  const current = JSON.parse((await readFile(leasePath, "utf8")).replace(/^\uFEFF/, ""))
  if (canonical(current) !== canonical(lease)) throw new Error("Batch lease changed during recovery")
  await rename(leasePath, path.join(evidence, "original-lease.json"))
  await writeJsonAtomic(path.join(evidence, "completed.json"), { leaseFingerprint: fingerprint(lease),
    action: "lease_archived", callsStarted: 0 })
  return { recoveryRoot: evidence, callsStarted: 0, protocolChanged: false }
}
