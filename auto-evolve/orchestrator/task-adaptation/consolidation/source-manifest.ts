import path from "node:path"
import { readFile, realpath, lstat } from "node:fs/promises"
import { digest } from "./contract"

export interface SourceRow { id: string; caseID: string; path: string; sha256: string }
export interface SourceManifest { schema: "aev.consolidation-sources.v1"; sources: SourceRow[] }
const valid = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
const sha = (value: string) => /^[a-f0-9]{64}$/.test(value)

// Checks every source before model access; returns immutable, absolute read-only file locations.
export async function freezeSources(root: string, file: string, cases: string[]) {
  const dir = path.resolve(root)
  const manifestPath = path.resolve(dir, file)
  const within = (p: string) => {
    const rel = path.relative(dir, p)
    return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  }
  if (!within(manifestPath) || path.resolve(await realpath(manifestPath)) !== manifestPath) throw new Error("Source manifest must be a real file under root")
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as SourceManifest
  if (raw.schema !== "aev.consolidation-sources.v1" || !Array.isArray(raw.sources) ||
      raw.sources.length !== cases.length || new Set(cases).size !== cases.length ||
      new Set(raw.sources.map(item => item.id)).size !== raw.sources.length ||
      new Set(raw.sources.map(item => item.caseID)).size !== raw.sources.length) throw new Error("Source manifest count or identity mismatch")
  const expected = new Set(cases)
  return await Promise.all(raw.sources.map(async row => {
    if (!row || !valid(row.id) || !expected.has(row.caseID) || !sha(row.sha256) ||
        typeof row.path !== "string" || path.isAbsolute(row.path) || row.path.split(/[\\/]/).includes("..")) {
      throw new Error("Invalid source entry")
    }
    const name = path.resolve(dir, row.path)
    if (!within(name) || path.resolve(await realpath(name)) !== name || !(await lstat(name)).isFile()) {
      throw new Error("Invalid linked or out-of-root source")
    }
    const bytes = await readFile(name)
    if (digest(bytes) !== row.sha256) throw new Error(`Source hash drift: ${row.id}`)
    return Object.freeze({ id: row.id, caseID: row.caseID, path: name, sha256: row.sha256 })
  }))
}
