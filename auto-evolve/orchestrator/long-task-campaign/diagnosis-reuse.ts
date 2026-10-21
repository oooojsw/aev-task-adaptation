import path from "node:path"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, readdir, readFile, mkdir, open } from "node:fs/promises"
import { fingerprint } from "../protocol-plugins/identity"
import { writeJsonAtomic } from "../atomic-write"

export async function diagnosisIdentity(context: unknown, paths: string[]) {
  const entries: unknown[] = []
  async function visit(file: string): Promise<void> {
    const stat = await lstat(file).catch(error => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) { entries.push([file, "missing"]); return }
    if (stat.isSymbolicLink()) throw new Error("Linked diagnosis reuse input rejected")
    if (stat.isDirectory()) {
      entries.push([file, "directory"])
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name))
      return
    }
    if (!stat.isFile()) throw new Error("Unsupported diagnosis reuse input")
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    entries.push([file, hash.digest("hex")])
  }
  for (const file of [...new Set(paths.map(file => path.resolve(file)))].sort()) await visit(file)
  return fingerprint(JSON.parse(JSON.stringify({ context, entries })))
}

export async function claimDiagnosis(dir: string, identity: string) {
  await mkdir(dir, { recursive: true })
  const claimed = await lstat(path.join(dir, "diagnosis.started.claim")).catch(error => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!claimed && await lstat(path.join(dir, "suggestion.json")).catch(error => {
    if (error.code === "ENOENT") return undefined
    throw error
  })) throw new Error("Historical diagnosis lacks reuse identity; inspect before retry")
  try {
    const claim = await open(path.join(dir, "diagnosis.started.claim"), "wx")
    await claim.close()
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  // 同阶段仅复用完整交付；中断和输入变化都不自动重发。
  const saved = JSON.parse((await readFile(path.join(dir, "diagnosis.completed.json"), "utf8")
    .catch(() => { throw new Error("Prior diagnosis incomplete; inspect before retry") })).replace(/^\uFEFF/, ""))
  if (saved.schema !== "aev.diagnosis-reuse.v1" || saved.identity !== identity) throw new Error("Diagnosis inputs changed; inspect before retry")
  if (saved.resultSHA256 !== createHash("sha256").update(await readFile(path.join(dir, "suggestion.json"))).digest("hex")) {
    throw new Error("Diagnosis result fingerprint drift")
  }
  return true
}

export async function completeDiagnosis(dir: string, identity: string) {
  await writeJsonAtomic(path.join(dir, "diagnosis.completed.json"), { schema: "aev.diagnosis-reuse.v1", identity,
    resultSHA256: createHash("sha256").update(await readFile(path.join(dir, "suggestion.json"))).digest("hex") })
}
