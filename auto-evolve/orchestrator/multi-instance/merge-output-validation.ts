import path from "node:path"
import { readdir, readFile } from "node:fs/promises"

type SourceItem = {
  id: string
  sourceKind?: string
  skillPath?: string
}

export type MergeOutputAudit = {
  passed: boolean
  files: string[]
  missing: string[]
  empty: string[]
  invalidJson: string[]
  missingSourceIDs: string[]
}

async function filesUnder(root: string, rel = ""): Promise<string[]> {
  const rows = await readdir(path.join(root, rel), { withFileTypes: true })
  const files: string[] = []
  for (const row of rows) {
    if (row.isSymbolicLink()) throw new Error(`Merge output contains symlink: ${path.join(root, rel, row.name)}`)
    const child = rel ? path.join(rel, row.name) : row.name
    if (row.isDirectory()) files.push(...(await filesUnder(root, child)))
    else if (row.isFile()) files.push(child.replaceAll("\\", "/"))
  }
  return files.sort()
}

export async function leafSourceIDs(items: SourceItem[], seen = new Set<string>()): Promise<string[]> {
  const ids = new Set<string>()
  for (const item of items) {
    if (item.sourceKind !== "merged_group") {
      if (!item.id) throw new Error("Merge input has no source ID")
      ids.add(item.id)
      continue
    }
    if (!item.skillPath) throw new Error(`Merged group ${item.id} has no Skill path`)
    const manifestPath = path.join(path.dirname(item.skillPath), "input-manifest.json")
    if (seen.has(manifestPath)) throw new Error(`Cyclic merge provenance: ${manifestPath}`)
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { inputs?: SourceItem[] }
    if (!Array.isArray(manifest.inputs) || !manifest.inputs.length) {
      throw new Error(`Merged group has no provenance inputs: ${manifestPath}`)
    }
    const nested = await leafSourceIDs(manifest.inputs, new Set([...seen, manifestPath]))
    for (const id of nested) ids.add(id)
  }
  return [...ids].sort()
}

export async function auditMergeOutput(input: {
  outputDir: string
  contractPath?: string
  expectedSourceIDs?: string[]
}): Promise<MergeOutputAudit> {
  const files = await filesUnder(input.outputDir)
  const fileSet = new Set(files)
  const contract = input.contractPath
    ? (JSON.parse(await readFile(input.contractPath, "utf8")) as {
        requiredFiles?: string[]
        provenanceRequirements?: Record<string, boolean>
      })
    : undefined
  const required = contract?.requiredFiles ?? ["INDEX.md", "CORE.md", "meta.json"]
  const missing = required.filter((requiredPath) => {
    const normalized = requiredPath.replaceAll("\\", "/")
    return normalized.endsWith("/")
      ? !files.some((file) => file.startsWith(normalized))
      : !fileSet.has(normalized)
  })
  const empty: string[] = []
  const invalidJson: string[] = []
  for (const file of files) {
    const contents = await readFile(path.join(input.outputDir, file), "utf8")
    if (!contents.trim()) empty.push(file)
    if (file.toLowerCase().endsWith(".json")) {
      try {
        JSON.parse(contents.replace(/^\uFEFF/, ""))
      } catch {
        invalidJson.push(file)
      }
    }
  }
  const missingSourceIDs: string[] = []
  if (contract?.provenanceRequirements && (input.expectedSourceIDs?.length ?? 0) > 0) {
    const provenancePath = path.join(input.outputDir, "PROVENANCE.json")
    if (fileSet.has("PROVENANCE.json") && !invalidJson.includes("PROVENANCE.json")) {
      const provenance = JSON.parse(await readFile(provenancePath, "utf8"))
      const text = JSON.stringify(provenance)
      for (const id of input.expectedSourceIDs ?? []) {
        if (!text.includes(id)) missingSourceIDs.push(id)
      }
    } else {
      missingSourceIDs.push(...(input.expectedSourceIDs ?? []))
    }
  }
  return {
    passed: files.length > 0 && missing.length === 0 && empty.length === 0 && invalidJson.length === 0 && missingSourceIDs.length === 0,
    files,
    missing,
    empty,
    invalidJson,
    missingSourceIDs,
  }
}
