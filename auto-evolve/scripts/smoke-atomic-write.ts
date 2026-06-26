import path from "node:path"
import { mkdir, readFile, readdir, rm } from "node:fs/promises"
import { writeJsonAtomic } from "../orchestrator/atomic-write"

const root = path.join(import.meta.dir, "..", "runtime-state", "smoke", "atomic-write")
const target = path.join(root, "state.json")

await rm(root, { recursive: true, force: true }).catch(() => undefined)
await mkdir(root, { recursive: true })

const writers = Array.from({ length: 20 }, (_, writer) =>
  (async () => {
    for (let step = 0; step < 50; step += 1) {
      await writeJsonAtomic(target, {
        writer,
        step,
        payload: "x".repeat(1024),
        at: new Date().toISOString(),
      }, { attempts: 10, baseDelayMs: 10, maxDelayMs: 250 })
      const raw = await readFile(target, "utf8")
      JSON.parse(raw)
    }
  })(),
)

await Promise.all(writers)

const finalRaw = await readFile(target, "utf8")
const final = JSON.parse(finalRaw) as { writer?: unknown; step?: unknown }
if (typeof final.writer !== "number" || typeof final.step !== "number") {
  throw new Error("Final atomic-write smoke file did not contain the expected JSON shape.")
}

const leftovers = (await readdir(root)).filter((name) => name.includes(".tmp-"))
if (leftovers.length > 0) {
  throw new Error(`Atomic-write temp files leaked: ${leftovers.join(", ")}`)
}

console.log(JSON.stringify({ ok: true, target, writers: 20, writesPerWriter: 50 }, null, 2))
