import { mock } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import * as atomic from "../../../atomic-write"

const write = atomic.writeFileAtomic,
  json = atomic.writeJsonAtomic
const timer = setInterval(() => {}, 1000)
async function checkpoint(file: string) {
  const stage = process.argv[3],
    name = path.basename(file)
  if (
    (stage === "intent" && name.endsWith(".intent.json")) ||
    (stage === "event" && name.endsWith(".event.json")) ||
    stage === name
  ) {
    // 只在真实写入后暂停，保留真实进程锁和恢复实现。
    process.stdout.write("archive-checkpoint\n")
    await new Promise(() => {})
  }
}
mock.module("../../../atomic-write", () => ({
  ...atomic,
  writeFileAtomic: async (...args: Parameters<typeof write>) => {
    await write(...args)
    await checkpoint(args[0])
  },
  writeJsonAtomic: async (...args: Parameters<typeof json>) => {
    await json(...args)
    await checkpoint(args[0])
  },
}))
const { saveCandidate } = await import("../archive")
await saveCandidate(JSON.parse((await readFile(process.argv[2], "utf8")).replace(/^\uFEFF/, "")))
clearInterval(timer)
