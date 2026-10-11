import crypto from "node:crypto"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { ensureDirectory } from "../orchestrator/fs"
import { estimateDirectChatTokens } from "../orchestrator/direct-chat/material-budget"

type BundleInput = { id: string; path: string; content: string; originalTokens: number; sha256: string }

function usage(): never {
  throw new Error(
    "Usage: bun run auto-evolve/scripts/create-length-matched-skill-bundles.ts --out-dir <dir> --bundle <id=path> [--bundle <id=path> ...] [--target-tokens <n>]",
  )
}

function parseArgs(argv: string[]) {
  const bundles: string[] = []
  let outDir = ""
  let targetTokens: number | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === "--bundle") {
      const value = argv[++index]
      if (!value) usage()
      bundles.push(value)
    } else if (item === "--out-dir") {
      outDir = argv[++index] || ""
    } else if (item === "--target-tokens") {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 1) usage()
      targetTokens = value
    } else {
      usage()
    }
  }
  if (!outDir || bundles.length < 2) usage()
  return { outDir: path.resolve(outDir), bundles, targetTokens }
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function parseBundle(value: string) {
  const separator = value.indexOf("=")
  if (separator <= 0 || separator === value.length - 1) usage()
  const id = value.slice(0, separator).trim()
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid bundle id: ${id}`)
  return { id, path: path.resolve(value.slice(separator + 1)) }
}

function selectHeadTail(content: string, targetTokens: number) {
  if (estimateDirectChatTokens(content) <= targetTokens) return content
  const marker = "\n\n<!-- LENGTH_MATCHED_HEAD_TAIL -->\n\n"
  let low = 0
  let high = Math.floor((content.length - marker.length) / 2)
  let best = ""
  while (low <= high) {
    const half = Math.floor((low + high) / 2)
    const candidate = `${content.slice(0, half)}${marker}${content.slice(content.length - half)}`
    if (estimateDirectChatTokens(candidate) <= targetTokens) {
      best = candidate
      low = half + 1
    } else {
      high = half - 1
    }
  }
  if (!best) throw new Error(`Cannot fit bundle into target token budget ${targetTokens}`)
  return best
}

function padToExactEstimatedTokens(content: string, targetTokens: number) {
  let padded = content
  while (estimateDirectChatTokens(padded) < targetTokens) padded += " "
  if (estimateDirectChatTokens(padded) !== targetTokens) {
    throw new Error(`Could not exactly match target token budget ${targetTokens}`)
  }
  return padded
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const parsed = args.bundles.map(parseBundle)
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) throw new Error("Bundle IDs must be unique")
  const inputs: BundleInput[] = await Promise.all(parsed.map(async (item) => {
    const content = await readFile(item.path, "utf8")
    if (!content.trim()) throw new Error(`Empty Skill bundle is not eligible for non-empty Skill length matching: ${item.id}`)
    return { id: item.id, path: item.path, content, originalTokens: estimateDirectChatTokens(content), sha256: sha256(content) }
  }))
  const targetTokens = args.targetTokens ?? Math.min(...inputs.map((item) => item.originalTokens))
  if (inputs.some((item) => item.originalTokens < targetTokens)) throw new Error("Target budget exceeds at least one input bundle")
  await ensureDirectory(args.outDir)
  const outputs = []
  for (const input of inputs) {
    const selected = selectHeadTail(input.content, targetTokens)
    const matched = padToExactEstimatedTokens(selected, targetTokens)
    const outPath = path.join(args.outDir, `${input.id}.length-matched.md`)
    await writeFile(outPath, matched, "utf8")
    outputs.push({
      id: input.id,
      sourcePath: input.path,
      sourceSha256: input.sha256,
      sourceTokens: input.originalTokens,
      outputPath: outPath,
      outputSha256: sha256(matched),
      outputTokens: estimateDirectChatTokens(matched),
      selection: input.originalTokens === targetTokens ? "full" : "deterministic-head-tail",
    })
  }
  const manifest = {
    schema: "auto-evolve/length-matched-skill-bundles/v1",
    createdAt: new Date().toISOString(),
    tokenEstimator: "estimateDirectChatTokens",
    targetTokens,
    inputs: outputs,
    invariant: "All outputTokens must equal targetTokens exactly. Original Skills remain unchanged.",
  }
  await writeFile(path.join(args.outDir, "length-match-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  console.log(JSON.stringify(manifest, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
