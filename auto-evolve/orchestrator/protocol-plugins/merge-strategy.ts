import path from "node:path"
import { mkdir, open, readFile, access } from "node:fs/promises"
import { mergeStage, type ProtocolMergeConfig } from "./merge-stage"
import type { MergeSource } from "./merge-context"
import { canonical } from "./identity"
import { writeJsonAtomic } from "../atomic-write"
import { pathExists } from "../fs"

export type MergeStrategy = { kind: "flat" } | { kind: "hierarchical"; groupSize: number }

export function validateMergeStrategy(value: unknown): MergeStrategy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid merge strategy")
  const cfg = value as MergeStrategy
  if (cfg.kind === "flat" && Object.keys(cfg).length === 1) return { kind: "flat" }
  if (cfg.kind === "hierarchical" && Object.keys(cfg).length === 2 &&
      Number.isSafeInteger(cfg.groupSize) && cfg.groupSize >= 2 && cfg.groupSize <= 1000) {
    return { kind: "hierarchical", groupSize: cfg.groupSize }
  }
  throw new Error("Explicit supported merge strategy and group size required")
}

export async function mergeWithStrategy(input: { cwd: string; runRoot: string;
  config: ProtocolMergeConfig; strategy?: MergeStrategy }, dependencies?: Parameters<typeof mergeStage>[1]) {
  input = structuredClone(input)
  if (!input.strategy || validateMergeStrategy(input.strategy).kind === "flat") {
    // 不能通过删除策略字段把已有分层运行伪装成新平铺调用。
    if (await pathExists(path.join(input.runRoot, "hierarchy.started.claim")) ||
        await pathExists(path.join(input.runRoot, "hierarchy.snapshot.json"))) throw new Error("Hierarchical merge strategy removed or changed")
    return mergeStage(input, dependencies)
  }
  const strategy = validateMergeStrategy(input.strategy) as Extract<MergeStrategy, { kind: "hierarchical" }>
  if (!path.isAbsolute(input.runRoot)) throw new Error("Absolute hierarchical merge root required")
  if (await pathExists(path.join(input.runRoot, "merge.started.claim")) ||
      await pathExists(path.join(input.runRoot, "merge.snapshot.json"))) throw new Error("Flat merge cannot become hierarchical")
  const binding = { config: input.config, strategy }
  await mkdir(input.runRoot, { recursive: true })
  const snapshot = path.join(input.runRoot, "hierarchy.snapshot.json")
  // 固定分组顺序与配置，恢复只进入原来的逐组目录。
  try {
    const claim = await open(path.join(input.runRoot, "hierarchy.started.claim"), "wx")
    await claim.close()
    try {
      await access(snapshot)
      throw new Error("Unclaimed hierarchy snapshot")
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await writeJsonAtomic(snapshot, binding)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const saved = JSON.parse((await readFile(snapshot, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(saved) !== canonical(binding)) throw new Error("Hierarchical merge configuration drift")
  }
  let sources: MergeSource[] = input.config.sources
  if (!sources.length) throw new Error("Hierarchical merge requires sources")
  for (let level = 0; level < 32; level++) {
    const next: MergeSource[] = []
    const groups = Math.ceil(sources.length / strategy.groupSize)
    let result: Awaited<ReturnType<typeof mergeStage>> | undefined
    for (let group = 0; group < groups; group++) {
      result = await mergeStage({ cwd: input.cwd,
        runRoot: path.join(input.runRoot, `level-${level}`, `group-${group}`),
        config: { ...input.config, sources: sources.slice(group * strategy.groupSize, (group + 1) * strategy.groupSize) } }, dependencies)
      next.push({ id: `level-${level}-group-${group}`, candidateRoot: result.mergedSkillDir,
        receiptPath: result.postMergeValidationResultPath, mergeRunRoot: result.mergerRunDir })
    }
    if (groups === 1 && result) return result
    sources = next
  }
  throw new Error("Hierarchical merge depth limit reached")
}
