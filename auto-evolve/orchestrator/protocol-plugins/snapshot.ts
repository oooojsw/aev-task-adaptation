import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "../atomic-write"
import type { Snapshot } from "./contract"
import { canonical } from "./identity"
import { verify } from "./compile"
import type { Registry } from "./registry"

export async function freeze(dir: string, snapshot: Snapshot, registry: Registry) {
  if (!path.isAbsolute(dir)) throw new Error("Snapshot directory must be absolute")
  const value = verify(snapshot, registry)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "protocol.snapshot.json")
  // 独占认领防止不同配置并发覆盖；残缺认领只能核查，不能自动重建。
  let claim
  try {
    try {
      await readFile(file)
      await readFile(path.join(dir, "protocol.started.claim"))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      // 孤立快照可能来自中断或人工写入，不允许重新认领后覆盖。
      try {
        await readFile(file)
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing
        claim = await open(path.join(dir, "protocol.started.claim"), "wx")
      }
      if (!claim) throw new Error("Unclaimed protocol snapshot; audit before recovery")
    }
    if (!claim) claim = await open(path.join(dir, "protocol.started.claim"), "wx")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    let previous: Snapshot
    try {
      previous = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))
    } catch {
      throw new Error("Protocol snapshot incomplete; audit before recovery")
    }
    const checked = verify(previous, registry)
    if (canonical(checked) !== canonical(value)) throw new Error("Cannot change protocol in existing run")
    return { snapshot: checked, reused: true, file }
  }
  await claim.close()
  await writeJsonAtomic(file, value)
  return { snapshot: value, reused: false, file }
}

export async function resume(dir: string, registry: Registry) {
  if (!path.isAbsolute(dir)) throw new Error("Snapshot directory must be absolute")
  const value = JSON.parse((await readFile(path.join(dir, "protocol.snapshot.json"), "utf8")).replace(/^\uFEFF/, ""))
  return verify(value, registry)
}
