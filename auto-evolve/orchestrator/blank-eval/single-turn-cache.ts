import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import { writeJsonAtomic } from "../atomic-write"
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

export async function claimSingleTurnReply(root: string, wire: string) {
  if (!path.isAbsolute(root)) throw new Error("Single-turn reply cache must be absolute")
  const dir = path.join(root, sha(wire))
  await mkdir(dir, { recursive: true })
  // 相同完整请求仅付费一次；残缺尝试必须审计，不能自动重发。
  try { const fd = await open(path.join(dir, "started.claim"), "wx"); await fd.close(); return { dir } }
  catch (e: any) { if (e.code !== "EEXIST") throw e }
  let cached: any
  try { cached = JSON.parse((await readFile(path.join(dir, "completed.json"), "utf8")).replace(/^\uFEFF/, "")) }
  catch { throw new Error("Prior identical request incomplete; audit before reuse or retry") }
  if (cached.requestSHA256 !== sha(wire) || sha(cached.raw) !== cached.rawSHA256 || cached.status !== 200) throw new Error("Cached receipt drift")
  return { dir, cached }
}

export async function saveSingleTurnReply(dir: string, wire: string, raw: string, sessionDir: string) {
  await writeJsonAtomic(path.join(dir, "completed.json"), { requestSHA256: sha(wire), raw,
    rawSHA256: sha(raw), status: 200, originalSessionDir: sessionDir })
}
