import { mock } from "bun:test"
import * as fs from "node:fs/promises"
const write = fs.writeFile
const timer = setInterval(() => {}, 1000)
mock.module("node:fs/promises", () => ({
  ...fs,
  writeFile: async (...args: Parameters<typeof write>) => {
    await write(...args)
    const file = String(args[0]).replaceAll("\\", "/")
    if (file.includes("/staging/.") && file.includes(".tmp-")) {
      process.stdout.write("view-checkpoint\n")
      await new Promise(() => {})
    }
  },
}))
const input = JSON.parse((await fs.readFile(process.argv[2], "utf8")).replace(/^\uFEFF/, ""))
if (process.argv[3] === "composition") await (await import("../composition")).compose(input)
else if (process.argv[3] === "version") {
  input.content = input.content.map((item: { data: number[] }) => Buffer.from(item.data))
  await (await import("../../version-store")).storeVersion(input)
} else await (await import("../activation")).activate(input)
clearInterval(timer)
