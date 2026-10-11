import path from "node:path"
import { createHash } from "node:crypto"
import { readFile, mkdir, open, access } from "node:fs/promises"
import { writeJsonAtomic, writeFileAtomic } from "../atomic-write"
import type { Phase, Selection } from "./contract"
import { compile } from "./compile"
import { canonical, fingerprint, immutable } from "./identity"
import { loadPack, freezePack, resumePack, taskFromPack } from "./project-pack"
import { freeze, resume } from "./snapshot"
import type { Runtime } from "./runtime"
import { productEvidenceName } from "./runtime"
import { attemptAccounting } from "./attempt-accounting"

export interface Entry {
  schema: "aev.protocol-entry.v1"
  selectionPath: string
  projectManifestPath: string
  taskID: string
  phase: Phase
}

export function validateEntry(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid protocol entry")
  const entry = value as Entry
  if (Object.keys(entry).some((key) => !["schema", "selectionPath", "projectManifestPath", "taskID", "phase"].includes(key)) ||
      entry.schema !== "aev.protocol-entry.v1" || typeof entry.taskID !== "string" || !entry.taskID.trim() ||
      !["source", "merge", "replay", "test"].includes(entry.phase) ||
      ![entry.selectionPath, entry.projectManifestPath].every((file) => typeof file === "string" && path.isAbsolute(file))) {
    throw new Error("Explicit absolute protocol entry required")
  }
  return immutable(entry)
}

async function exists(file: string) {
  try { await access(file); return true } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false
    throw err
  }
}

export async function prepareEntry(runRoot: string, config: Entry | undefined, runtime: Runtime) {
  if (!path.isAbsolute(runRoot)) throw new Error("Absolute run root required")
  const dir = path.join(runRoot, "protocol-plugins")
  if (!config) {
    // 已启用的新run不能删掉配置后伪装成旧链路续传。
    if (await exists(dir)) throw new Error("Protocol entry removed from existing plugin run")
    return undefined
  }
  const entry = validateEntry(config)
  const selection = JSON.parse((await readFile(entry.selectionPath, "utf8")).replace(/^\uFEFF/, "")) as Selection
  const protocol = compile(selection, runtime.registry)
  const project = await loadPack(entry.projectManifestPath)
  if (canonical(protocol.selection.project) !== canonical(project.pack.project) ||
      protocol.selection.run.skillFormat !== project.pack.skill.format) throw new Error("Project and protocol mismatch")
  const task = project.pack.tasks.find((item) => item.id === entry.taskID)
  if (!task || !protocol.selection.protocol.phases[entry.phase] ||
      (entry.phase === "test" ? task.split !== "test" : task.split !== "train")) throw new Error("Task/phase mismatch")
  const body = { schema: "aev.protocol-entry-snapshot.v1", entry,
    projectFingerprint: project.fingerprint, protocolFingerprint: protocol.fingerprint }
  const binding = { ...body, fingerprint: fingerprint(body) }
  await mkdir(dir, { recursive: true })
  const readyFile = path.join(dir, "entry.snapshot.json")
  if (await exists(readyFile) && !await exists(path.join(dir, "entry.started.claim"))) throw new Error("Unclaimed entry snapshot")
  let claim
  try { claim = await open(path.join(dir, "entry.started.claim"), "wx") } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    if (!await exists(readyFile)) throw new Error("Entry preparation incomplete; inspect before recovery")
    const previous = JSON.parse((await readFile(readyFile, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(previous) !== canonical(binding)) throw new Error("Cannot change plugin entry in existing run")
    const savedProtocol = await resume(dir, runtime.registry)
    const savedProject = await resumePack(dir)
    if (savedProtocol.fingerprint !== binding.protocolFingerprint || savedProject.fingerprint !== binding.projectFingerprint) {
      throw new Error("Entry snapshot linkage drift")
    }
    return { dir, entry, protocol: savedProtocol, project: savedProject }
  }
  await claim.close()
  await freeze(dir, protocol, runtime.registry)
  await freezePack(dir, project)
  await writeJsonAtomic(readyFile, binding)
  return { dir, entry, protocol, project }
}

export async function runEntry(runRoot: string, entry: Entry, candidateRoot: string, attemptRoot: string, runtime: Runtime,
  options: { reuseCompleted?: boolean } = {}) {
  if (!path.isAbsolute(attemptRoot)) throw new Error("Absolute attempt root required")
  const prepared = await prepareEntry(runRoot, entry, runtime)
  if (!prepared) throw new Error("Explicit plugin entry required")
  const task = await taskFromPack(prepared.project, entry.taskID, entry.phase, candidateRoot)
  const inputs = await Promise.all([task.skill, task.materials, task.privateInputs].map(async (files) =>
    Promise.all(files.map(async (file) => ({ ...file, sha256: createHash("sha256").update(await readFile(file.path)).digest("hex") })))))
  const binding = fingerprint({ entry, project: prepared.project.fingerprint, protocol: prepared.protocol.fingerprint, inputs })
  const matches = (receipt: Awaited<ReturnType<Runtime["run"]>>) =>
    [receipt.evidence.skill, receipt.evidence.materials, receipt.evidence.privateInputs].every((files, index) =>
      canonical(files.map(({ id, kind, sha256 }) => ({ id, kind, sha256 })).sort((a, b) => a.id.localeCompare(b.id))) ===
      canonical(inputs[index].map(({ id, kind, sha256 }) => ({ id, kind, sha256 })).sort((a, b) => a.id.localeCompare(b.id))))
  await mkdir(attemptRoot, { recursive: true })
  const receiptPath = path.join(attemptRoot, "protocol.receipt.json")
  const checkpoint = path.join(attemptRoot, "protocol.completed.json")
  const accountingPath = path.join(attemptRoot, "protocol.accounting.json")
  if (options.reuseCompleted && await exists(receiptPath)) {
    // 仅复用身份一致的完整判决，故障和半完成调用不自动重发。
    if (!await exists(path.join(attemptRoot, "protocol.started.claim")) ||
        await exists(path.join(attemptRoot, "protocol.failure.json"))) throw new Error("Incomplete attempt; inspect before recovery")
    const saved = JSON.parse((await readFile(checkpoint, "utf8")).replace(/^\uFEFF/, ""))
    const receipt = JSON.parse((await readFile(receiptPath, "utf8")).replace(/^\uFEFF/, ""))
    if (saved.receipt !== fingerprint(receipt)) throw new Error("Completed attempt identity or verdict drift")
    if (saved.product !== undefined) {
      const bytes = await readFile(path.join(attemptRoot, productEvidenceName(saved.product.kind)))
      if (!receipt.product || canonical(saved.product) !== canonical(receipt.product) ||
          bytes.length !== saved.product.length || createHash("sha256").update(bytes).digest("hex") !== saved.product.sha256) {
        throw new Error("Completed public product evidence drift")
      }
    }
    let accountingHash: string | undefined
    if (saved.accounting !== undefined) {
      const accounting = JSON.parse((await readFile(accountingPath, "utf8")).replace(/^\uFEFF/, ""))
      accountingHash = fingerprint(accounting)
      const expected = attemptAccounting(prepared.protocol, entry.phase, receipt, accounting.elapsedMs)
      if (canonical(accounting) !== canonical(expected)) throw new Error("Completed accounting evidence drift")
    }
    if (canonical(saved) !== canonical({ binding, receipt: fingerprint(receipt),
      ...(accountingHash ? { accounting: accountingHash } : {}),
      ...(saved.product !== undefined ? { product: saved.product } : {}) }) ||
        receipt.task !== task.id || receipt.phase !== entry.phase || receipt.protocolFingerprint !== prepared.protocol.fingerprint ||
        !["passed", "rejected"].includes(receipt.status) || !matches(receipt)) throw new Error("Completed attempt identity or verdict drift")
    return receipt as Awaited<ReturnType<Runtime["run"]>>
  }
  if (await exists(path.join(attemptRoot, "protocol.receipt.json")) ||
      await exists(path.join(attemptRoot, "protocol.failure.json"))) throw new Error("Existing attempt evidence; inspect before recovery")
  // 调用已认领但未完成时，不自动重发可能已计费的请求。
  const claim = await open(path.join(attemptRoot, "protocol.started.claim"), "wx")
  await claim.close()
  const started = performance.now()
  try {
    let publishedProduct: { id: string; kind: string; sha256: string; length: number } | undefined
    const receipt = await runtime.run(prepared.protocol, entry.phase, task, { async onProduct(product) {
      await writeFileAtomic(path.join(attemptRoot, productEvidenceName(product.kind)), Buffer.from(product.bytes))
      const { bytes: _, ...metadata } = product
      publishedProduct = metadata
    } })
    await writeJsonAtomic(receiptPath, receipt)
    // 读取与执行之间若输入漂移，保留回执但禁止登记为可复用。
    if (!matches(receipt)) throw new Error("Attempt inputs changed during execution")
    const accounting = attemptAccounting(prepared.protocol, entry.phase, receipt, performance.now() - started)
    await writeJsonAtomic(accountingPath, accounting)
    await writeJsonAtomic(checkpoint, { binding, receipt: fingerprint(receipt), accounting: fingerprint(accounting),
      ...(publishedProduct ? { product: publishedProduct } : {}) })
    return receipt
  } catch (err) {
    await writeJsonAtomic(path.join(attemptRoot, "protocol.failure.json"), { status: "interrupted", message: String(err) })
    throw err
  }
}
