import path from "node:path"
import { readFile, mkdir } from "node:fs/promises"
import { loadLongTaskSpec } from "../long-task/spec"
import { prepareEntry } from "./entry"
import { taskFromPack } from "./project-pack"
import { selectedRuntime } from "./selected-runtime"
import { opencodeDriver } from "./opencode-driver"
import { mergeRepair } from "./merge-repair"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint } from "./identity"
import { createHash } from "node:crypto"
import type { Runtime } from "./runtime"

export interface ProtocolRepairAuthorConfig {
  model: string
  expectedModel: string
  timeoutMs: number
  maxInputBytes: number
  mode: "append_only" | "rewrite"
}

export async function instanceRepair(input: { cwd: string; sourceTaskRoot: string; parentRunRoot: string;
  candidateRoot: string; initialReceiptPath: string; repairRoot: string; maxAttempts: number;
  author: ProtocolRepairAuthorConfig }, dependencies?: { runtime: Runtime; createDriver: typeof opencodeDriver }) {
  const cfg = structuredClone(input.author)
  if (!cfg || ![cfg.model, cfg.expectedModel].every((value) => typeof value === "string" && value.trim()) ||
      ![cfg.timeoutMs, cfg.maxInputBytes].every((value) => Number.isSafeInteger(value) && value > 0) ||
      cfg.timeoutMs > 12 * 60 * 60 * 1000 || !["append_only", "rewrite"].includes(cfg.mode)) {
    throw new Error("Explicit protocol repair author/model/budget required")
  }
  const { spec } = await loadLongTaskSpec(path.join(input.sourceTaskRoot, "spec.json"), { allowMissingInitialExpertContextPaths: true })
  if (!spec.protocolPlugins) throw new Error("Explicit protocol repair entry required")
  const runtime = dependencies?.runtime ?? await selectedRuntime(path.join(input.repairRoot, "protocol-backends"), input.cwd, spec.protocolPlugins)
  const prepared = await prepareEntry(input.parentRunRoot, spec.protocolPlugins, runtime)
  if (!prepared) throw new Error("Frozen protocol repair parent required")
  const task = await taskFromPack(prepared.project, spec.protocolPlugins.taskID, "replay", input.candidateRoot)
  const initial = JSON.parse((await readFile(input.initialReceiptPath, "utf8")).replace(/^\uFEFF/, ""))
  if (initial.status !== "rejected") throw new Error("Only ordinary rejection may start repair author")
  const driver = await (dependencies?.createDriver ?? opencodeDriver)({ cwd: input.cwd,
    evidenceRoot: path.join(input.repairRoot, "author-backend") })
  await driver.preflight()
  return mergeRepair({ ...input, parentEntry: spec.protocolPlugins, initial, mode: cfg.mode, runtime,
    authorIdentity: fingerprint({ config: cfg, backend: driver.implementation }),
    author: async (request) => {
      // 作者只接公开材料和声明Skill；不挂载评分私有目录。
      const folder = path.join(path.dirname(request.candidateRoot), "author-public")
      await mkdir(folder, { recursive: true })
      const materials = []
      let total = 0
      for (const [index, material] of task.materials.entries()) {
        const bytes = await readFile(material.path)
        const declared = prepared.project.pack.tasks.find((item) => item.id === task.id)!.materials[index]
        const frozen = prepared.project.artifacts.find((item) => item.path === declared.path)
        if (!frozen || createHash("sha256").update(bytes).digest("hex") !== frozen.sha256) {
          throw new Error("Repair author public material changed after preflight")
        }
        total += bytes.length
        const file = path.join(folder, `${index}.data`)
        await writeFileAtomic(file, bytes)
        materials.push({ id: material.id, kind: material.kind, path: file })
      }
      const entries = request.entries.map((entry) => path.join(request.candidateRoot, entry))
      for (const file of entries) total += (await readFile(file)).length
      const prompt = ["Revise only the declared Skill entries using public materials and rejection feedback.",
        "Do not change evaluators, fetch private answers, or claim acceptance yourself.",
        canonical({ ...request, materials })].join("\n")
      if (total + Buffer.byteLength(prompt) > cfg.maxInputBytes) throw new Error("Repair author input budget exceeded")
      await driver.preflight()
      await writeJsonAtomic(path.join(folder, "binding.json"), { backend: driver.implementation, model: cfg.model,
        expectedModel: cfg.expectedModel, timeoutMs: cfg.timeoutMs, maxInputBytes: cfg.maxInputBytes })
      const result = await driver.invoke({ workDir: request.candidateRoot, prompt, model: cfg.model,
        readPaths: [...entries, ...materials.map((item) => item.path)], editPaths: entries,
        allowShell: false, timeoutMs: cfg.timeoutMs, maxAttempts: 1 }, new AbortController().signal)
      return { completed: result.completed && result.actualModel === cfg.expectedModel, evidence: result.evidence ?? [] }
    } })
}
