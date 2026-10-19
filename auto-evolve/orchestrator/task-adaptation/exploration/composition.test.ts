import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rename, lstat, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeFileAtomic, writeJsonAtomic } from "../../atomic-write"
import { bindPlan } from "../binding"
import { withFileTransaction, directoryBytes } from "../../file-transaction"
import { saveCandidate, type ArchiveInput } from "./archive"
import { compose } from "./composition"
import { explorationIdentity } from "./policy"
import { plan, policy } from "./policy.test"

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex")

export async function fixture(
  options: {
    report?: string
    facts?: string
    source?: string
    bounds?: Partial<ReturnType<typeof policy>["bounds"]>
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-composition-"))
  const source = path.join(root, "source"),
    evidence = path.join(root, "evidence")
  await mkdir(source)
  await mkdir(evidence)
  for (const [name, value] of Object.entries({
    "report.md": options.report ?? "initial report\r\n",
    "facts.md": "old fact",
    "source.txt": options.source ?? "frozen source",
    "private.txt": "private",
  }))
    await writeFileAtomic(path.join(source, name), value)
  const cfg = policy(),
    bound = await bindPlan(source, plan(), [])
  Object.assign(cfg.bounds, options.bounds)
  const scope = {
    campaign: "fixture",
    plan: bound.fingerprint,
    protocol: sha("protocol"),
    policy: explorationIdentity(cfg, bound.plan)!,
    budget: { root: root.replaceAll("\\", "/"), scope: "same" },
  }
  async function snapshot(round: number, parent: string | null): Promise<ArchiveInput> {
    const feedback = '{"status":"rejected"}'
    await writeFileAtomic(path.join(evidence, "receipt.json"), feedback)
    const entries = []
    for (const id of ["report", "facts"]) {
      const relative = `${id}.md`,
        data = await readFile(path.join(source, relative))
      entries.push({ id, path: relative, bytes: data.length, sha256: sha(data) })
    }
    return {
      root: path.join(root, "archive"),
      candidateRoot: source,
      evidenceRoot: evidence,
      scope,
      round,
      pass: round ? 1 : 0,
      branch: "original",
      parent,
      closure: round ? sha(`round-${round}`) : null,
      entries,
      feedback: round
        ? { path: "receipt.json", bytes: Buffer.byteLength(feedback), sha256: sha(feedback), status: "rejected" }
        : null,
      bounds: cfg.bounds,
    }
  }
  const origin = await saveCandidate(await snapshot(0, null))
  await writeFileAtomic(path.join(source, "report.md"), "failed current report")
  await writeFileAtomic(path.join(source, "facts.md"), options.facts ?? "latest preserved fact")
  const current = await saveCandidate(await snapshot(1, origin.id))
  return {
    root: path.join(root, "composition"),
    archive: path.join(root, "archive"),
    scope,
    bound,
    policy: cfg,
    origin: origin.id,
    current: current.id,
  }
}

test("composition replaces only declared entries and preserves current facts with frozen dependencies", async () => {
  const input = await fixture(),
    result = await compose(input)
  expect(await readFile(path.join(result.view, "report.md"), "utf8")).toBe("initial report\r\n")
  expect(await readFile(path.join(result.view, "facts.md"), "utf8")).toBe("latest preserved fact")
  expect(await readFile(path.join(result.view, "source.txt"), "utf8")).toBe("frozen source")
  expect(result.record.files.map((item) => item.source.id)).toEqual([input.origin, input.current])
  expect(await readFile(path.join(input.bound.root, "report.md"), "utf8")).toBe("failed current report")
  expect(await compose(input)).toEqual(result)
})

test("composition explicit recovery preserves completed bytes and fills missing local files", async () => {
  const input = await fixture(),
    result = await compose(input)
  const file = path.join(result.view, "report.md"),
    before = await lstat(file)
  await rename(result.path, `${result.path}.saved`)
  await rename(path.join(result.view, "facts.md"), path.join(input.root, "interrupted-facts"))
  await expect(compose(input)).rejects.toThrow("explicit recovery")
  expect(await compose({ ...input, recover: true })).toEqual(result)
  expect((await lstat(file)).ino).toBe(before.ino)
  expect((await lstat(file)).mtimeMs).toBe(before.mtimeMs)
})

test("composition rejects changed dependencies, identity and different historical origin", async () => {
  const input = await fixture()
  await expect(compose({ ...input, scope: { ...input.scope, plan: sha("different") } })).rejects.toThrow("binding")
  await expect(compose({ ...input, origin: input.current })).rejects.toThrow("eligible")
  await writeFileAtomic(path.join(input.bound.root, "source.txt"), "changed")
  await expect(compose(input)).rejects.toThrow("resource drift")
})

test("composition rejects extra old files, modified content and missing completed files", async () => {
  const input = await fixture(),
    result = await compose(input)
  await writeFileAtomic(path.join(result.view, "old.md"), "stale private context")
  await expect(compose(input)).rejects.toThrow("Unexpected composition file")
  await rename(path.join(result.view, "old.md"), path.join(input.root, "old.saved"))
  await writeFileAtomic(path.join(result.view, "report.md"), "tampered")
  await expect(compose(input)).rejects.toThrow("drift")
  await rename(path.join(result.view, "report.md"), path.join(input.root, "tampered.saved"))
  await expect(compose(input)).rejects.toThrow("content missing")
})

test("composition refuses unclaimed preexisting view and recovery without intent", async () => {
  const input = await fixture()
  await expect(compose({ ...input, recover: true })).rejects.toThrow("intent missing")
  await mkdir(path.join(input.root, "view"))
  await expect(compose(input)).rejects.toThrow("Unclaimed")
})

test("composition content quota and changed retry intent block rather than truncate", async () => {
  const input = await fixture({ report: "a".repeat(6000), facts: "b".repeat(6000) })
  await expect(compose(input)).rejects.toThrow("Composition content capacity exceeded")
  const dependency = await fixture({ source: "s".repeat(10001) })
  await expect(compose(dependency)).rejects.toThrow("Composition content capacity exceeded")
  const storage = await fixture({
    report: "a".repeat(20000),
    facts: "b".repeat(20000),
    bounds: { candidateBytes: 50000, archiveBytes: 80000 },
  })
  await mkdir(storage.root)
  await withFileTransaction(storage.root, "composition", async () => {}, 80000)
  await writeFileAtomic(path.join(storage.root, "preserved-diagnostics.txt"), "x".repeat(30000))
  await expect(compose(storage)).rejects.toThrow("Composition storage capacity exceeded")
  const second = await fixture()
  const result = await compose(second)
  await rename(result.path, `${result.path}.saved`)
  await writeFileAtomic(path.join(second.root, "composition.intent.json"), "{}")
  await expect(compose({ ...second, recover: true })).rejects.toThrow("intent drift")
})

export async function interrupt(input: object, file: string, mode: "composition" | "activation") {
  await writeJsonAtomic(file, input)
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/view-interruption.ts"), file, mode], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = child.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        let output = ""
        for (;;) {
          const part = await reader.read()
          if (part.done) throw new Error(`Interrupted fixture exited: ${await new Response(child.stderr).text()}`)
          output += new TextDecoder().decode(part.value)
          if (output.includes("view-checkpoint")) return
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("View checkpoint timeout")), 10000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    child.kill()
    await child.exited
    reader.releaseLock()
  }
}

test("composition survives kill during atomic temp write and a second kill during recovery", async () => {
  const input = await fixture(),
    file = path.join(path.dirname(input.root), "interrupt.json")
  await interrupt(input, file, "composition")
  expect((await readdir(path.join(input.root, "staging"))).some((name) => name.includes(".tmp-"))).toBe(true)
  await interrupt({ ...input, recover: true }, file, "composition")
  const result = await compose({ ...input, recover: true })
  expect(await readFile(path.join(result.view, "report.md"), "utf8")).toBe("initial report\r\n")
  expect((await readdir(result.view)).sort()).toEqual(["facts.md", "report.md", "source.txt"])
}, 30000)

test("composition rejects nested roots before creating files inside frozen sources", async () => {
  const input = await fixture(),
    before = await readdir(input.bound.root)
  await expect(compose({ ...input, root: path.join(input.bound.root, "bad") })).rejects.toThrow("binding")
  expect(await readdir(input.bound.root)).toEqual(before)
})

test("near-cap interrupted staging is reused without counting the same bytes twice", async () => {
  const input = await fixture({
    report: "x".repeat(20000),
    facts: "y".repeat(20000),
    bounds: { candidateBytes: 50000, archiveBytes: 80000 },
  })
  const file = path.join(path.dirname(input.root), "near-cap.json")
  await interrupt(input, file, "composition")
  await interrupt({ ...input, recover: true }, file, "composition")
  const result = await compose({ ...input, recover: true })
  expect((await readFile(path.join(result.view, "report.md"))).length).toBe(20000)
  expect(await directoryBytes(input.root)).toBeLessThanOrEqual(80000)
}, 30000)
