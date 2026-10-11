import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

function run(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)))
  })
}

const root = await mkdtemp(path.join(os.tmpdir(), "ae-paired-delta-"))
try {
  const baseline = path.join(root, "baseline.jsonl")
  const condition = path.join(root, "condition.jsonl")
  const out = path.join(root, "out")
  await writeFile(baseline, [
    JSON.stringify({ id: "A", hard: 0, soft: 0, fail_reason: "miss" }),
    JSON.stringify({ id: "B", hard: 1, soft: 1 }),
    JSON.stringify({ id: "C", hard: 0, soft: 0.5 }),
  ].join("\n"), "utf8")
  await writeFile(condition, [
    JSON.stringify({ id: "A", hard: 1, soft: 1 }),
    JSON.stringify({ id: "B", hard: 0, soft: 0, fail_reason: "regressed" }),
    JSON.stringify({ id: "C", hard: 0, soft: 0.5 }),
  ].join("\n"), "utf8")
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  await run(process.execPath, [path.join(repoRoot, "auto-evolve", "scripts", "summarize-paired-eval-delta.ts"), "--baseline", baseline, "--condition", condition, "--out-dir", out], repoRoot)
  const summary = JSON.parse(await readFile(path.join(out, "paired-delta-summary.json"), "utf8")) as { denominator: number; counts: Record<string, number> }
  if (summary.denominator !== 3 || summary.counts.gain !== 1 || summary.counts.regression !== 1 || summary.counts.both_fail !== 1) {
    throw new Error("paired delta summary mismatch")
  }
  console.log("paired-eval-delta smoke passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
