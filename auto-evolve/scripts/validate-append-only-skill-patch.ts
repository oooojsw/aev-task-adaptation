import path from "node:path"
import { readdir, readFile } from "node:fs/promises"

type Hit = { file: string; reason: string }

async function walk(root: string, rel = ""): Promise<string[]> {
  const dir = path.join(root, rel)
  const rows = await readdir(dir, { withFileTypes: true }).catch(() => [])
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
  return false
}

function canMutate(rel: string) {
  const next = rel.replace(/\\/g, "/")
  if (next === "CORE.md") return true
  if (next === "INDEX.md") return true
  if (next.startsWith("casebook/")) return true
  if (next.startsWith("patches/")) return true
  if (next === "open_observations.md") return true
  if (next === "meta.json") return true
  if (next === "surface_contract.json") return false
  return false
}

async function sameOrPrefix(base: string, draft: string, rel: string) {
  const a = await readFile(path.join(base, rel), "utf8").catch(() => "")
  const b = await readFile(path.join(draft, rel), "utf8").catch(() => "")
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
    if (!canMutate(next)) {
      const a = await readFile(path.join(base, rel)).catch(() => Buffer.alloc(0))
      const b = await readFile(path.join(draft, rel)).catch(() => Buffer.alloc(0))
      if (!a.equals(b)) hits.push({ file: rel, reason: "non-mutable file changed" })
      continue
    }
    const textLike = /\.(md|txt|json|jsonl|yaml|yml)$/i.test(rel)
    if (textLike) {
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
