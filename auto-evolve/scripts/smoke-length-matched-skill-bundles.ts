import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { estimateDirectChatTokens } from "../orchestrator/direct-chat/material-budget"

function run(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" })
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)))
  })
}

const root = await mkdtemp(path.join(os.tmpdir(), "ae-length-match-"))
try {
  const left = path.join(root, "left.md")
  const right = path.join(root, "right.md")
  const out = path.join(root, "out")
  await writeFile(left, "A".repeat(900), "utf8")
  await writeFile(right, `START-${"B".repeat(2400)}-END`, "utf8")
  const repoRoot = path.resolve(import.meta.dir, "..", "..")
  await run(process.execPath, [
    path.join(repoRoot, "auto-evolve", "scripts", "create-length-matched-skill-bundles.ts"),
    "--out-dir", out,
    "--bundle", `left=${left}`,
    "--bundle", `right=${right}`,
  ], repoRoot)
  const manifest = JSON.parse(await readFile(path.join(out, "length-match-manifest.json"), "utf8")) as {
    targetTokens: number
    inputs: Array<{ outputPath: string; outputTokens: number }>
  }
  if (manifest.inputs.length !== 2) throw new Error("expected two matched bundles")
  for (const item of manifest.inputs) {
    const output = await readFile(item.outputPath, "utf8")
    if (item.outputTokens !== manifest.targetTokens || estimateDirectChatTokens(output) !== manifest.targetTokens) {
      throw new Error("matched bundle token invariant failed")
    }
  }
  console.log("length-matched-skill-bundles smoke passed")
} finally {
  await rm(root, { recursive: true, force: true })
}
