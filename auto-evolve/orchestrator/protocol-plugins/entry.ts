import path from "node:path"
import { readFile, mkdir, open, access } from "node:fs/promises"
import { writeJsonAtomic } from "../atomic-write"
import type { Phase, Selection } from "./contract"
import { compile } from "./compile"
import { canonical, fingerprint, immutable } from "./identity"
import { loadPack, freezePack, resumePack, taskFromPack } from "./project-pack"
import { freeze, resume } from "./snapshot"
import type { Runtime } from "./runtime"

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

export async function runEntry(runRoot: string, entry: Entry, candidateRoot: string, attemptRoot: string, runtime: Runtime) {
  if (!path.isAbsolute(attemptRoot)) throw new Error("Absolute attempt root required")
  const prepared = await prepareEntry(runRoot, entry, runtime)
  if (!prepared) throw new Error("Explicit plugin entry required")
  const task = await taskFromPack(prepared.project, entry.taskID, entry.phase, candidateRoot)
  await mkdir(attemptRoot, { recursive: true })
  if (await exists(path.join(attemptRoot, "protocol.receipt.json")) ||
      await exists(path.join(attemptRoot, "protocol.failure.json"))) throw new Error("Existing attempt evidence; inspect before recovery")
  // 调用已认领但未完成时，不自动重发可能已计费的请求。
  const claim = await open(path.join(attemptRoot, "protocol.started.claim"), "wx")
  await claim.close()
  try {
    const receipt = await runtime.run(prepared.protocol, entry.phase, task)
    await writeJsonAtomic(path.join(attemptRoot, "protocol.receipt.json"), receipt)
    return receipt
  } catch (err) {
    await writeJsonAtomic(path.join(attemptRoot, "protocol.failure.json"), { status: "interrupted", message: String(err) })
    throw err
  }
}
