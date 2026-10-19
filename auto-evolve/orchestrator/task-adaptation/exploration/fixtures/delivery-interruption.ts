import { mock } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"

const rename = fs.rename, stage = process.argv[3]
// 子进程停在真实写入与rename之间，父进程硬杀而非模拟抛错。
mock.module("node:fs/promises", () => ({ ...fs, rename: async (source: string, target: string) => {
  if (stage === "temporary" && target.includes(`${path.sep}staging${path.sep}`)) {
    process.stdout.write("delivery-checkpoint\n")
    await new Promise(() => {})
  }
  await rename(source, target)
  if (path.basename(target) === stage) {
    process.stdout.write("delivery-checkpoint\n")
    await new Promise(() => {})
  }
} }))
const timer = setInterval(() => {}, 1000)
const { exportTaskDelivery } = await import("../../delivery")
const input = JSON.parse((await fs.readFile(process.argv[2], "utf8")).replace(/^\uFEFF/, ""))
await exportTaskDelivery(input.spec, input.input)
clearInterval(timer)
