import path from "node:path"
import { readdir, readFile } from "node:fs/promises"

type Hit = { file: string; reason: string }
type Policy = "append_only" | "rewrite_allowed" | "immutable"

async function walk(root: string, rel = ""): Promise<string[]> {
  const dir = path.join(root, rel)
  const rows = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const row of rows) {
    const child = rel ? path.join(rel, row.name) : row.name
    if (row.isDirectory()) {
      out.push(...(await walk(root, child)))
      continue
    }
    if (row.isFile()) out.push(child)
  }
  return out
}

function allowedNew(rel: string) {
  const next = rel.replace(/\\/g, "/")
  if (next.startsWith("patches/")) return true
  if (next.startsWith("casebook/")) return true
  if (next === "open_observations.md") return true
  if (next === "meta.json") return true
  if (next === "surface_contract.json") return true
  return false
}

function policyFor(rel: string): Policy {
  const next = rel.replace(/\\/g, "/")
  if (next === "CORE.md") return "append_only"
  if (next === "INDEX.md") return "append_only"
  if (next === "open_observations.md") return "append_only"
  if (next.startsWith("patches/")) return "append_only"
  if (next.startsWith("casebook/")) return "rewrite_allowed"
  if (next === "meta.json") return "rewrite_allowed"
  if (next === "surface_contract.json") return "rewrite_allowed"
  return "immutable"
}

async function sameOrPrefix(base: string, draft: string, rel: string) {
  // 仅统一换行；不得掩盖文字删改或读取故障。
  const a = (await readFile(path.join(base, rel), "utf8")).replace(/\r\n/g, "\n")
  const b = (await readFile(path.join(draft, rel), "utf8")).replace(/\r\n/g, "\n")
  if (b === a) return true
  return b.startsWith(a)
}

async function main() {
  const base = process.argv[2]
  const draft = process.argv[3]
  if (!base || !draft) {
    console.error("Usage: bun run scripts/validate-append-only-skill-patch.ts <baseDir> <draftDir>")
    process.exit(1)
  }

  const baseFiles = await walk(base)
  const draftFiles = await walk(draft)
  const draftSet = new Set(draftFiles)
  const hits: Hit[] = []

  for (const rel of baseFiles) {
    if (!draftSet.has(rel)) {
      hits.push({ file: rel, reason: "base file missing in draft" })
      continue
    }
    const next = rel.replace(/\\/g, "/")
    const policy = policyFor(next)
    if (policy === "immutable") {
      const a = await readFile(path.join(base, rel))
      const b = await readFile(path.join(draft, rel))
      if (!a.equals(b)) hits.push({ file: rel, reason: "non-mutable file changed" })
      continue
    }
    if (policy === "append_only") {
      const textLike = /\.(md|txt|json|jsonl|yaml|yml)$/i.test(rel)
      if (!textLike) {
        hits.push({ file: rel, reason: "append-only file is not text-like" })
        continue
      }
      const ok = await sameOrPrefix(base, draft, rel)
      if (!ok) hits.push({ file: rel, reason: "text file is not append-only" })
    }
  }

  for (const rel of draftFiles) {
    if (baseFiles.includes(rel)) continue
    if (!allowedNew(rel)) hits.push({ file: rel, reason: "new file outside allowed append-only zones" })
  }

  const out = {
    passed: hits.length === 0,
    totalBaseFiles: baseFiles.length,
    totalDraftFiles: draftFiles.length,
    violations: hits,
  }
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.passed ? 0 : 1)
}

await main()
