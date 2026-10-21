import path from "node:path"
import { createHash } from "node:crypto"
import { readFile, mkdir, open, lstat } from "node:fs/promises"
import { withFileLock } from "../jsonl"
import { writeFileAtomic, writeJsonAtomic } from "../atomic-write"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import { inspectBudget, type RequestBudget } from "./request-budget"

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

// 仅Host显式授权迁移；不改历史调用、用量或未知请求状态。
export async function migrateBudgetToMeterOnly(config: RequestBudget, approval: { expectedSHA256: string; reason: string }) {
  if (config.mode || !/^[a-f0-9]{64}$/.test(approval.expectedSHA256) || !approval.reason.trim()) throw new Error("Explicit bounded-to-meter-only approval required")
  const file = path.join(config.root, "budget.json")
  const dir = path.join(config.root, "meter-only-migration")
  const target = { ...config, mode: "meter_only" as const }
  const before = fingerprint(config), after = fingerprint(target)
  return withFileLock(`${file}.lock`, async () => {
    const regular = async (name: string) => {
      const info = await lstat(name)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Migration file link rejected")
      return readFile(name)
    }
    await mkdir(dir, { recursive: true })
    const intent = path.join(dir, "intent.json")
    let body: { schema: string; from: string; to: string; original: string; approval: typeof approval; result: string }
    try { body = JSON.parse((await regular(intent)).toString("utf8").replace(/^\uFEFF/, "")) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const bytes = await regular(file)
      const state = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""))
      if (hash(bytes) !== approval.expectedSHA256 || state.binding !== before ||
          !Array.isArray(state.attempts) || state.gates || state.intakePrefix ||
          state.attempts.some((item: { status: string }) => !["settled", "overrun"].includes(item.status)) ||
          (await regular(`${file}.started.claim`)).toString("utf8") !== before) throw new Error("Migration source is changed, active, staged or unresolved")
      const original = bytes.toString("base64")
      const result = JSON.stringify({ ...state, binding: after }, null, 2) + "\n"
      body = { schema: "aev.meter-only-migration.v1", from: before, to: after, original, approval, result }
      const handle = await open(intent, "wx")
      try { await handle.writeFile(JSON.stringify(body, null, 2)) } finally { await handle.close() }
    }
    const original = Buffer.from(body.original, "base64")
    const state = JSON.parse(original.toString("utf8").replace(/^\uFEFF/, ""))
    if (body.schema !== "aev.meter-only-migration.v1" || body.from !== before || body.to !== after ||
        canonical(body.approval) !== canonical(approval) || hash(original) !== approval.expectedSHA256 ||
        body.result !== JSON.stringify({ ...state, binding: after }, null, 2) + "\n") throw new Error("Migration intent drift")
    const bytes = await regular(file)
    if (hash(bytes) !== approval.expectedSHA256 && bytes.toString("utf8") !== body.result) throw new Error("Migration ledger drift")
    const claim = (await regular(`${file}.started.claim`)).toString("utf8")
    if (![before, after].includes(claim) || claim === after && bytes.toString("utf8") !== body.result) throw new Error("Migration initialization drift")
    // 先落不可变意图，再更新两文件；中断后只完成同一意图。
    if (bytes.toString("utf8") !== body.result) await writeFileAtomic(file, body.result)
    if (claim !== after) await writeFileAtomic(`${file}.started.claim`, after)
    await writeJsonAtomic(path.join(dir, "completed.json"), { schema: body.schema, from: before, to: after,
      originalSHA256: approval.expectedSHA256, resultSHA256: hash(Buffer.from(body.result)), reason: approval.reason })
    return target
  }, { staleMs: 600000, timeoutMs: 60000 }).then(async value => { await inspectBudget(value); return value })
}
