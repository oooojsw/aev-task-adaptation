import path from "node:path"
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { loadPack, verifyPack } from "./project-pack"
import { compile } from "./compile"
import { canonical, fingerprint } from "./identity"
import { prepareEntry, type Entry } from "./entry"
import type { Runtime } from "./runtime"
import { validateTraining, type TrainingConfig } from "./training"

export async function prepareProjectTasks(input: { manifestPath: string; selectionPath: string;
  destination: string; trainingGoal: string; training?: TrainingConfig }, runtime: Runtime) {
  if (![input.manifestPath, input.selectionPath, input.destination].every((value) => typeof value === "string" && path.isAbsolute(value)) ||
      typeof input.trainingGoal !== "string" || !input.trainingGoal.trim()) throw new Error("Explicit project task paths and training goal required")
  const project = await loadPack(input.manifestPath)
  const training = input.training ? validateTraining(input.training) : undefined
  const protocol = compile(JSON.parse((await readFile(input.selectionPath, "utf8")).replace(/^\uFEFF/, "")), runtime.registry)
  if (canonical(project.pack.project) !== canonical(protocol.selection.project) ||
      project.pack.skill.format !== protocol.selection.run.skillFormat) throw new Error("Project task protocol mismatch")
  const tasks = project.pack.tasks.filter((task) => task.split !== "validation")
  if (!tasks.some((task) => task.split === "train")) throw new Error("Project requires training tasks")
  for (const task of tasks) if (!protocol.selection.protocol.phases[task.split === "test" ? "test" : "source"]) {
    throw new Error("Project task phase missing from protocol")
  }
  const parent = await realpath(path.dirname(input.destination))
  const target = path.join(parent, path.basename(input.destination))
  const relative = path.relative(project.root, target)
  if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error("Project task output must be outside project materials")
  }
  // 新目录独占；半完成配置不得覆盖原任务或被视作可恢复运行。
  await mkdir(target)
  const rows = []
  for (const [index, task] of tasks.entries()) {
    const taskRoot = path.join(target, "tasks", String(index).padStart(6, "0"))
    const entry: Entry = { schema: "aev.protocol-entry.v1", projectManifestPath: input.manifestPath,
      selectionPath: input.selectionPath, taskID: task.id, phase: task.split === "test" ? "test" : "source" }
    await prepareEntry(path.join(taskRoot, "preflight"), entry, runtime)
    const spec = { id: task.id, taskFamily: project.pack.project.id, title: `${project.pack.project.id}: ${task.id}`, goal: input.trainingGoal,
      materials: task.materials.map((file) => ({ label: file.id, path: path.join(project.root, file.path) })),
      validators: [], protocolPlugins: entry, ...(training && task.split === "train" ? { protocolTraining: training } : {}) }
    const specPath = path.join(taskRoot, "spec.json")
    await writeFile(specPath, JSON.stringify(spec, null, 2), { flag: "wx" })
    rows.push({ id: task.id, role: task.split, sourceTaskRoot: taskRoot, specPath,
      specFingerprint: fingerprint(spec) })
  }
  await verifyPack(project)
  const result = { schema: "aev.project-tasks.v1", projectFingerprint: project.fingerprint,
    protocolFingerprint: protocol.fingerprint, trainingGoal: input.trainingGoal, tasks: rows,
    ...(training ? { training } : {}),
    excludedValidationUIDs: project.pack.tasks.filter((task) => task.split === "validation").map((task) => task.id) }
  await writeFile(path.join(target, "project-tasks.json"), JSON.stringify(result, null, 2), { flag: "wx" })
  return result
}
