import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { freezePipeline, loadPipeline, validatePipeline, type PipelineConfig } from "./pipeline-config"
import { parseBenchmarkConfig } from "../../scripts/run-benchmark-orchestrator"

const config: PipelineConfig = { schema: "aev.protocol-pipeline.v1", mergeAuthor: {
  model: "fixture/author", expectedModel: "fixture/author", timeoutMs: 1000, maxInputBytes: 100000 } }
const root = () => path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())

test("pipeline absent leaves legacy untouched and frozen configuration resumes exactly", async () => {
  const dir = root()
  expect(await freezePipeline(dir)).toBeUndefined()
  expect(await freezePipeline(dir, config)).toEqual(config)
  expect(await freezePipeline(dir, config)).toEqual(config)
  await expect(freezePipeline(dir)).rejects.toThrow("removed")
  await expect(freezePipeline(dir, { ...config, mergeAuthor: { ...config.mergeAuthor, maxInputBytes: 200000 } })).rejects.toThrow("drift")
})

test("pipeline rejects unknown fields nonfinite budgets and malformed optional repair", () => {
  for (const value of [{ ...config, fallback: "opencode" }, { ...config, mergeAuthor: { ...config.mergeAuthor, maxInputBytes: NaN } },
    { ...config, mergeAuthor: { ...config.mergeAuthor, apiKey: "not-a-real-key" } }, { ...config, repairAuthor: null },
    { ...config, repairAuthor: { ...config.mergeAuthor } }]) expect(() => validatePipeline(value)).toThrow()
  expect(validatePipeline({ ...config, repairAuthor: { ...config.mergeAuthor, mode: "append_only" } }).repairAuthor?.mode).toBe("append_only")
})

test("pipeline partial claim and orphan snapshot block rather than recreate", async () => {
  for (const name of ["pipeline.started.claim", "pipeline.snapshot.json"]) {
    const dir = root()
    await mkdir(path.join(dir, "protocol-pipeline"), { recursive: true })
    await writeFile(path.join(dir, "protocol-pipeline", name), "{}")
    await expect(freezePipeline(dir, config)).rejects.toThrow()
  }
})

test("pipeline freezes explicit hierarchy and rejects unknown or nonshrinking groups", async () => {
  const dir = root()
  const cfg: PipelineConfig = { ...config, mergeStrategy: { kind: "hierarchical", groupSize: 2 } }
  expect((await freezePipeline(dir, cfg))?.mergeStrategy).toEqual(cfg.mergeStrategy)
  await expect(freezePipeline(dir, { ...cfg, mergeStrategy: { kind: "hierarchical", groupSize: 3 } })).rejects.toThrow("drift")
  for (const strategy of [{ kind: "hierarchical", groupSize: 1 }, { kind: "hierarchical", groupSize: Infinity },
    { kind: "flat", groupSize: 2 }, { kind: "guess" }, null]) {
    expect(() => validatePipeline({ ...config, mergeStrategy: strategy })).toThrow()
  }
})

test("pipeline file uses explicit path and reads UTF8 BOM without defaults", async () => {
  const dir = root()
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "pipeline.json")
  await writeFile(file, "\uFEFF" + JSON.stringify(config))
  expect(await loadPipeline(file)).toEqual(config)
  await expect(loadPipeline("relative.json")).rejects.toThrow("Absolute")
})

test("actual benchmark parser preserves explicit protocol config and rejects missing value", async () => {
  const dir = root()
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "pipeline.json")
  await writeFile(file, JSON.stringify(config))
  const args = ["--task-pack-root", dir, "--out", path.join(dir, "run"), "--repair-attempts", "0", "--stop-after", "training", "--dry-run"]
  const parsed = await parseBenchmarkConfig([...args, "--protocol-run-config", file])
  expect(parsed.protocolRun).toEqual(config)
  expect(parsed.stopAfter).toBe("training")
  expect((await parseBenchmarkConfig(args)).protocolRun).toBeUndefined()
  await expect(parseBenchmarkConfig([...args, "--protocol-run-config"])).rejects.toThrow("Missing value")
})
