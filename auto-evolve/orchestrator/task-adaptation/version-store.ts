import { createHash } from "node:crypto"
import { mkdir, readFile, lstat } from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "../atomic-write"
import { checkedPath, directoryBytes, withFileTransaction } from "../file-transaction"
import { canonical, fingerprint } from "../protocol-plugins/identity"
import { materialize, materialization } from "./exploration/materialize"
import type { Version } from "./selection"

export async function storeVersion(input: {
  root: string
  record: Version
  content: Buffer[]
  cap: number
  recover: boolean
}) {
  const record = input.record
  if (
    !path.isAbsolute(input.root) ||
    !/^[a-f0-9]{64}$/.test(record.receipt) ||
    record.schema !== "aev.task-version.v1" ||
    !Number.isSafeInteger(input.cap) ||
    input.cap < 1 ||
    record.files.length !== input.content.length ||
    record.files.some(
      (item, index) =>
        item.file !== `files/${index}.bin` ||
        item.bytes !== input.content[index].length ||
        createHash("sha256").update(input.content[index]).digest("hex") !== item.sha256,
    )
  )
    throw new Error("Invalid recoverable version snapshot")
  const root = path.join(input.root, "task-adaptation")
  await checkedPath(input.root, "directory")
  await mkdir(root, { recursive: true })
  return withFileTransaction(
    root,
    "versions",
    async () => {
      const folder = path.join(root, "versions", record.receipt)
      const intent = path.join(root, "version-intents", `${record.receipt}.json`)
      const completed = path.join(folder, "record.json")
      const encoded = { ...record, fingerprint: fingerprint(record) }
      async function present(file: string) {
        try {
          return await checkedPath(file, "file")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        }
      }
      async function matches(file: string) {
        if (
          (await checkedPath(file, "file")).size > input.cap ||
          canonical(JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""))) !== canonical(encoded)
        )
          throw new Error("Recoverable version identity drift")
      }
      const prior = await present(intent),
        done = await present(completed)
      if (prior) await matches(intent)
      else {
        try {
          await lstat(folder)
          throw new Error("Unclaimed version directory; explicit audit required")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
        if (input.recover) throw new Error("Version recovery intent missing")
      }
      if (done) await matches(completed)
      if (prior && !done && !input.recover) throw new Error("Incomplete version requires explicit recovery")
      const missing: number[] = []
      let increment = 0
      for (const [index, item] of record.files.entries()) {
        const file = path.join(folder, item.file)
        if (await present(file)) {
          const bytes = await readFile(file)
          if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256)
            throw new Error("Recoverable version content drift")
        } else {
          if (done) throw new Error("Completed version content missing")
          missing.push(index)
          increment += (await materialization(root, file, input.content[index])).required
        }
      }
      const size = Buffer.byteLength(JSON.stringify(encoded, null, 2) + "\n")
      if ((await directoryBytes(root)) + increment + size * (prior ? (done ? 0 : 1) : 2) > input.cap)
        throw new Error("Version snapshot storage capacity exceeded")
      // 正式资格仍由选择器核验；这里只修复已验收快照的本地半写入。
      if (!prior) {
        await mkdir(path.dirname(intent), { recursive: true })
        await checkedPath(path.dirname(intent), "directory")
        await writeJsonAtomic(intent, encoded)
      }
      await mkdir(folder, { recursive: true })
      await checkedPath(folder, "directory")
      for (const index of missing)
        await materialize(root, path.join(folder, record.files[index].file), input.content[index])
      if (!done) await writeJsonAtomic(completed, encoded)
      return completed.replaceAll("\\", "/")
    },
    input.cap,
  )
}
