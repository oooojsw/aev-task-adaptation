import path from "node:path"
import { mkdir, open, readFile } from "node:fs/promises"
import { loadLongTaskSpec } from "../long-task/spec"
import { loadPack } from "./project-pack"
import { readCandidate } from "./candidate"
import { canonical, fingerprint } from "./identity"
import { writeJsonAtomic } from "../atomic-write"
import type { InstanceState } from "../multi-instance/contract"
import { prepareEntry } from "./entry"
import { selectedRuntime } from "./selected-runtime"
import type { Runtime } from "./runtime"

export async function initialReplayJournal(input: { runRoot: string; candidateRoot: string;
  eligible: InstanceState[]; config: unknown; cwd: string; runtime?: Runtime }) {
  if (!input.eligible.length || input.eligible.some((row) => row.engine !== "protocol_project")) return undefined
  const group = [...new Set(input.eligible.map((row) => row.role))].sort().join("-")
  const root = path.join(input.runRoot, "protocol-validation-journal", group)
  const inventory = input.eligible.map((row) => ({ id: row.id, role: row.role,
    sourceTaskRoot: row.sourceTaskRoot, campaignDir: row.campaignDir ?? null,
    sourceReceipt: row.harvestedProtocolReceiptPath ?? null })).sort((a, b) => a.id.localeCompare(b.id))
  const identities = []
  for (const [index, row] of input.eligible.entries()) {
    const { spec } = await loadLongTaskSpec(path.join(row.sourceTaskRoot, "spec.json"), { allowMissingInitialExpertContextPaths: true })
    if (!spec.protocolPlugins) throw new Error("Protocol validation journal requires explicit entry")
    const runtime = input.runtime ?? await selectedRuntime(path.join(root, "backends"), input.cwd, spec.protocolPlugins)
    const frozen = await prepareEntry(path.join(root, "entries", String(index)), spec.protocolPlugins, runtime)
    if (!frozen) throw new Error("Frozen validation identity required")
    identities.push({ id: row.id, project: frozen.project.fingerprint, protocol: frozen.protocol.fingerprint })
  }
  const binding = fingerprint({ inventory, identities, config: input.config })
  const { spec } = await loadLongTaskSpec(path.join(input.eligible[0].sourceTaskRoot, "spec.json"), { allowMissingInitialExpertContextPaths: true })
  if (!spec.protocolPlugins) throw new Error("Protocol validation journal requires explicit entry")
  const pack = await loadPack(spec.protocolPlugins.projectManifestPath)
  await mkdir(root, { recursive: true })
  const snapshotPath = path.join(root, "initial.snapshot.json")
  let snapshot: { binding: string; candidateRoot: string; candidate: string }
  try {
    const claim = await open(path.join(root, "initial.started.claim"), "wx")
    await claim.close()
    snapshot = { binding, candidateRoot: input.candidateRoot,
      candidate: (await readCandidate(input.candidateRoot, pack.pack.skill)).fingerprint }
    await writeJsonAtomic(snapshotPath, snapshot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    snapshot = JSON.parse((await readFile(snapshotPath, "utf8")).replace(/^\uFEFF/, ""))
    if (snapshot.binding !== binding) throw new Error("Initial replay configuration drift")
  }
  // 原始回放始终绑定修补前版本，不能被当前晋级正文覆盖。
  if ((await readCandidate(snapshot.candidateRoot, pack.pack.skill)).fingerprint !== snapshot.candidate) {
    throw new Error("Initial replay candidate drift")
  }
  const completedPath = path.join(root, "initial.completed.json")
  let completed: { binding: string; result: unknown; rows: Array<{ id: string; status: InstanceState["validateStatus"];
    runRoot: string; receiptHash: string }> } | undefined
  let readCompleted = false
  try {
    const stored = JSON.parse((await readFile(completedPath, "utf8")).replace(/^\uFEFF/, ""))
    readCompleted = true
    const { hash, ...body } = stored
    if (hash !== fingerprint(body) || body.binding !== fingerprint(snapshot)) throw new Error("Initial replay checkpoint drift")
    for (const row of body.rows) {
      const receipt = JSON.parse((await readFile(path.join(row.runRoot, "attempt", "protocol.receipt.json"), "utf8")).replace(/^\uFEFF/, ""))
      if (fingerprint(receipt) !== row.receiptHash) throw new Error("Initial replay receipt drift")
    }
    completed = body
  } catch (error) { if (readCompleted || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  return { candidateRoot: snapshot.candidateRoot, get completed() { return completed },
    async save(result: unknown) {
      const rows = []
      for (const row of input.eligible) {
        if (!row.validateRunRoot || !["passed", "failed"].includes(row.validateStatus!)) throw new Error("Incomplete initial replay cannot checkpoint")
        const receipt = JSON.parse((await readFile(path.join(row.validateRunRoot, "attempt", "protocol.receipt.json"), "utf8")).replace(/^\uFEFF/, ""))
        if (!["passed", "rejected"].includes(receipt.status)) throw new Error("Faulted initial replay cannot checkpoint")
        rows.push({ id: row.id, status: row.validateStatus, runRoot: row.validateRunRoot, receiptHash: fingerprint(receipt) })
      }
      const body = { binding: fingerprint(snapshot), result, rows }
      // 完成记录只写一次；原始阶段证据不能被恢复重算覆盖。
      if (completed) { if (canonical(completed) !== canonical(body)) throw new Error("Initial replay checkpoint replacement blocked"); return }
      await writeJsonAtomic(completedPath, { ...body, hash: fingerprint(body) })
      completed = body
    } }
}
