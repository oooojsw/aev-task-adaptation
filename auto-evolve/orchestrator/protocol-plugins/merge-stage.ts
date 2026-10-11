import path from "node:path"
import { mkdir, readFile, open, access, realpath, lstat } from "node:fs/promises"
import { mergeContext } from "./merge-context"
import { copyCandidate, readCandidate } from "./candidate"
import { prepareEntry, runEntry, type Entry } from "./entry"
import { deriveEntry } from "./derive-entry"
import { selectedRuntime } from "./selected-runtime"
import { opencodeDriver } from "./opencode-driver"
import { canonical, fingerprint } from "./identity"
import { writeJsonAtomic } from "../atomic-write"
import type { Runtime } from "./runtime"

export interface ProtocolMergeConfig {
  parentRunRoot: string
  entry: Entry
  sources: Array<{ id: string; candidateRoot: string; receiptPath: string }>
  author: { model: string; expectedModel: string; timeoutMs: number; maxInputBytes: number }
}

export async function mergeStage(input: { cwd: string; runRoot: string; config: ProtocolMergeConfig },
  dependencies?: { runtime?: Runtime; createDriver?: typeof opencodeDriver }) {
  const cfg = structuredClone(input.config)
  const author = cfg.author
  if (!author || ![author.model, author.expectedModel].every((value) => typeof value === "string" && value.trim()) ||
      ![author.timeoutMs, author.maxInputBytes].every((value) => Number.isSafeInteger(value) && value > 0) ||
      author.timeoutMs > 12 * 60 * 60 * 1000 || !path.isAbsolute(input.runRoot)) throw new Error("Explicit merge author budgets required")
  await mkdir(input.runRoot, { recursive: true })
  if (await realpath(input.runRoot) !== path.resolve(input.runRoot)) throw new Error("Merge run root link rejected")
  const runtime = dependencies?.runtime ?? await selectedRuntime(path.join(input.runRoot, "backends"), input.cwd, cfg.entry)
  const output = path.join(input.runRoot, "output")
  const context = await mergeContext({ ...cfg, outputRoot: output, runtime })
  const prepared = await prepareEntry(cfg.parentRunRoot, cfg.entry, runtime)
  if (!prepared) throw new Error("Frozen merge parent required")
  const driver = await (dependencies?.createDriver ?? opencodeDriver)({ cwd: input.cwd,
    evidenceRoot: path.join(input.runRoot, "author-backend") })
  await driver.preflight()
  const binding = { config: cfg, context: context.fingerprint, author: driver.implementation }
  await mkdir(input.runRoot, { recursive: true })
  const snapshot = path.join(input.runRoot, "merge.snapshot.json")
  const completed = path.join(input.runRoot, "merge.completed.json")
  let reused = false
  try {
    const claim = await open(path.join(input.runRoot, "merge.started.claim"), "wx")
    await claim.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const previous = JSON.parse((await readFile(snapshot, "utf8")).replace(/^\uFEFF/, ""))
    if (canonical(previous) !== canonical(binding)) throw new Error("Merge configuration or source drift")
    await access(completed)
    await access(path.join(input.runRoot, "author.started.claim"))
    const result = JSON.parse((await readFile(path.join(input.runRoot, "author.result.json"), "utf8")).replace(/^\uFEFF/, ""))
    if (!result.completed || result.actualModel !== author.expectedModel) throw new Error("Completed merge author evidence invalid")
    reused = true
  }
  if (!reused) await writeJsonAtomic(snapshot, binding)
  const entry = await deriveEntry({ parentRunRoot: cfg.parentRunRoot, parentEntry: cfg.entry,
    runRoot: path.join(input.runRoot, "acceptance"), phase: "merge", taskID: cfg.entry.taskID, runtime })
  if (!reused) {
    const sources = []
    for (const [index, source] of cfg.sources.entries()) {
      const root = path.join(input.runRoot, "sources", String(index))
      await copyCandidate(source.candidateRoot, root, prepared.project.pack.skill)
      sources.push({ ...source, candidateRoot: root })
    }
    const staged = await mergeContext({ ...cfg, sources, outputRoot: output, runtime })
    const bytes = staged.contract.sources.reduce((sum, source) => sum + source.files.reduce((n, file) => n + file.bytes, 0), 0)
    if (bytes + Buffer.byteLength(staged.prompt) > author.maxInputBytes) throw new Error("Merge author input budget exceeded")
    await mkdir(output, { recursive: true })
    if (await realpath(output) !== path.resolve(output)) throw new Error("Merge output root link rejected")
    for (const file of staged.editPaths) {
      await mkdir(path.dirname(file), { recursive: true })
      if (await realpath(path.dirname(file)) !== path.resolve(path.dirname(file))) throw new Error("Merge output parent link rejected")
      try {
        if ((await lstat(file)).isSymbolicLink()) throw new Error("Merge output file link rejected")
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    }
    // 开始标记先落盘；半完成作者调用只能核查，不能自动重发。
    const claim = await open(path.join(input.runRoot, "author.started.claim"), "wx")
    await claim.close()
    const result = await driver.invoke({ workDir: output, prompt: staged.prompt, model: author.model,
      readPaths: staged.readPaths, editPaths: staged.editPaths, allowShell: false,
      timeoutMs: author.timeoutMs, maxAttempts: 1 }, new AbortController().signal)
    await writeJsonAtomic(path.join(input.runRoot, "author.result.json"), result)
    if (!result.completed || result.actualModel !== author.expectedModel) throw new Error("Merge author incomplete or wrong model")
    if ((await mergeContext({ ...cfg, sources, outputRoot: output, runtime })).fingerprint !== staged.fingerprint) {
      throw new Error("Staged merge source changed during author invocation")
    }
    if ((await mergeContext({ ...cfg, outputRoot: output, runtime })).fingerprint !== context.fingerprint) {
      throw new Error("Merge source changed during author invocation")
    }
  }
  const candidate = await readCandidate(output, prepared.project.pack.skill)
  if (reused) {
    const saved = JSON.parse((await readFile(completed, "utf8")).replace(/^\uFEFF/, ""))
    if (saved.binding !== fingerprint(binding) || saved.candidate !== candidate.fingerprint) throw new Error("Completed merge output drift")
  }
  const receipt = await runEntry(path.join(input.runRoot, "acceptance"), entry, output,
    path.join(input.runRoot, "acceptance", "attempt"), runtime, { reuseCompleted: reused })
  if (receipt.status !== "passed") throw new Error(`Merge not accepted: ${receipt.status}`)
  if ((await readCandidate(output, prepared.project.pack.skill)).fingerprint !== candidate.fingerprint) {
    throw new Error("Merge output changed during acceptance")
  }
  if (!reused) await writeJsonAtomic(completed, { binding: fingerprint(binding), candidate: candidate.fingerprint })
  return { mergedSkillDir: output, contributingInstances: cfg.sources.map((source) => source.id),
    mergerRunDir: input.runRoot, postMergeValidationResultPath: path.join(input.runRoot, "acceptance", "attempt", "protocol.receipt.json"),
    postMergeValidationPassed: true, reused }
}
