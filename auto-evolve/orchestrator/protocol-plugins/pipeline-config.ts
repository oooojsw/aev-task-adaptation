import path from "node:path"
import { access, readFile, mkdir, open } from "node:fs/promises"
import { writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint, immutable } from "./identity"
import type { ProtocolMergeConfig } from "./merge-stage"
import type { ProtocolRepairAuthorConfig } from "./instance-repair"

export interface PipelineConfig {
  schema: "aev.protocol-pipeline.v1"
  mergeAuthor: ProtocolMergeConfig["author"]
  repairAuthor?: ProtocolRepairAuthorConfig
}

export function validatePipeline(value: unknown): PipelineConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid protocol pipeline config")
  const cfg = structuredClone(value) as PipelineConfig
  if (cfg.schema !== "aev.protocol-pipeline.v1" || Object.keys(cfg).some((key) => !["schema", "mergeAuthor", "repairAuthor"].includes(key))) {
    throw new Error("Unknown protocol pipeline field or schema")
  }
  for (const [role, author] of [["merge", cfg.mergeAuthor], ["repair", cfg.repairAuthor]] as const) {
    if (role === "repair" && author === undefined) continue
    if (!author || typeof author !== "object" || Array.isArray(author) ||
        Object.keys(author).some((key) => !["model", "expectedModel", "timeoutMs", "maxInputBytes", ...(role === "repair" ? ["mode"] : [])].includes(key)) ||
        ![author.model, author.expectedModel].every((model) => typeof model === "string" && model.trim() && !/(agt_codex_|sk-[A-Za-z0-9]{20,})/.test(model)) ||
        ![author.timeoutMs, author.maxInputBytes].every((n) => Number.isSafeInteger(n) && n > 0) || author.timeoutMs > 43_200_000 ||
        (role === "repair" && !["append_only", "rewrite"].includes((author as ProtocolRepairAuthorConfig).mode))) {
      throw new Error("Explicit protocol author model and finite budgets required")
    }
  }
  return immutable(cfg)
}

export async function loadPipeline(file: string) {
  if (!path.isAbsolute(file)) throw new Error("Absolute protocol pipeline config path required")
  return validatePipeline(JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")))
}

export async function freezePipeline(root: string, config?: PipelineConfig) {
  if (!path.isAbsolute(root)) throw new Error("Absolute protocol pipeline run root required")
  const dir = path.join(root, "protocol-pipeline")
  if (!config) {
    try { await access(dir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    throw new Error("Protocol pipeline config removed from existing run")
  }
  const cfg = validatePipeline(config)
  const binding = { config: cfg, fingerprint: fingerprint(cfg) }
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "pipeline.snapshot.json")
  try {
    const claim = await open(path.join(dir, "pipeline.started.claim"), "wx")
    await claim.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const saved = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(binding)) throw new Error("Protocol pipeline config drift")
    return cfg
  }
  // 独占认领后再保存；半完成快照不得自动重建。
  try {
    await access(file)
    throw new Error("Unclaimed protocol pipeline snapshot")
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  await writeJsonAtomic(file, binding)
  return cfg
}
