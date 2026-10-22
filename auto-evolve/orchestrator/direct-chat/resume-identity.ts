import path from "node:path"
import { readFile, stat, lstat } from "node:fs/promises"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { fingerprint } from "../protocol-plugins/identity"
import { pathExists, readJsonFile, writeJsonFile } from "../fs"
import type { DirectChatCaseBundle } from "./contract"

export async function withEvaluationLock<T>(root: string, fn: () => Promise<T>) {
  const file = path.join(root, "evaluation.mutex.sqlite")
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const info = await lstat(file + suffix).catch(error => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (info && !info.isFile()) throw new Error("Linked evaluation mutex rejected")
  }
  const db = new Database(file, { create: true })
  let held = false
  try {
    // 系统释放硬中断事务锁，不用过期时间抢占仍在运行的评测。
    db.exec("PRAGMA busy_timeout=0")
    try { db.exec("BEGIN IMMEDIATE"); held = true }
    catch (error) { throw new Error("Direct Chat evaluation already active or mutex unavailable", { cause: error }) }
    return await fn()
  } finally {
    try { if (held) db.exec("ROLLBACK") } finally { db.close() }
  }
}

export async function dependencies(cases: DirectChatCaseBundle[]) {
  const files = new Set<string>()
  for (const task of cases) {
    const oracle = task.privateOracle
    for (const file of [oracle?.scriptPath, oracle?.answerPath, oracle?.rewardPath,
      ...task.materials.flatMap(item => [item.metadata?.imagePathInternal, item.metadata?.assetPathInternal])]) {
      if (file) files.add(path.resolve(file))
    }
    const args = oracle?.args ?? []
    for (let i = 0; i < args.length; i++) {
      // candidate是输出位置，不是冻结评分输入。
      if (i > 0 && args[i - 1] === (oracle?.candidateArgName ?? "--candidate")) continue
      if (!path.isAbsolute(args[i])) continue
      const info = await stat(args[i]).catch(error => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (info?.isFile()) files.add(path.resolve(args[i]))
    }
  }
  return Promise.all([...files].sort().map(async file => ({
    path: file.replaceAll("\\", "/"),
    sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
  })))
}

export async function freezeResume(root: string, identity: unknown) {
  const target = path.join(root, "resume-identity.json")
  const digest = fingerprint(JSON.parse(JSON.stringify(identity)))
  if (await pathExists(target)) {
    const saved = await readJsonFile<{ digest: string; identity: unknown }>(target)
    // 先核对旧记录自身，再核对本次配置；不覆盖旧快照。
    if (saved.digest !== fingerprint(saved.identity) || saved.digest !== digest) {
      throw new Error("Direct Chat resume identity changed; explicit protocol migration required")
    }
    return
  }
  if (await pathExists(path.join(root, "results"))) {
    throw new Error("Legacy Direct Chat results require audited identity migration before reuse")
  }
  await writeJsonFile(target, { schema: "direct-chat-resume/v1", digest, identity })
}
