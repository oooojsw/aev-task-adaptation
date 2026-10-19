import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, lstat, readdir, mkdir, link, rename, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeFileAtomic, writeJsonAtomic } from "../../atomic-write"
import { directoryBytes, withFileTransaction } from "../../file-transaction"
import { readCandidate, saveCandidate, type ArchiveInput } from "./archive"

const sha = (value: string) => createHash("sha256").update(value).digest("hex")
async function fixture(): Promise<ArchiveInput> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-exploration-archive-"))
  const source = path.join(root, "candidate"),
    evidence = path.join(root, "evidence")
  await mkdir(source)
  await mkdir(evidence)
  await writeFileAtomic(path.join(source, "report.md"), "verified facts\r\n")
  await writeFileAtomic(path.join(evidence, "receipt.json"), '{"status":"rejected"}')
  const data = await readFile(path.join(source, "report.md")),
    receipt = await readFile(path.join(evidence, "receipt.json"))
  return {
    root: path.join(root, "archive"),
    candidateRoot: source,
    evidenceRoot: evidence,
    scope: {
      campaign: "synthetic-campaign",
      plan: sha("plan"),
      protocol: sha("protocol"),
      policy: sha("policy"),
      budget: { root: root.replaceAll("\\", "/"), scope: "same-budget" },
    },
    round: 1,
    pass: 2,
    branch: "original",
    parent: null,
    closure: sha("closed-round-1"),
    entries: [{ id: "report", path: "report.md", bytes: data.length, sha256: sha(data.toString()) }],
    feedback: { path: "receipt.json", bytes: receipt.length, sha256: sha(receipt.toString()), status: "rejected" },
    bounds: { archiveBytes: 1000000, candidateBytes: 10000 },
  }
}

test("normal rejected candidates retain exact bytes without gaining delivery qualification", async () => {
  const cfg = await fixture(),
    saved = await saveCandidate(cfg)
  expect(saved.record.feedback!.status).toBe("rejected")
  expect(saved.record.files[0].bytes).toBe(cfg.entries[0].bytes)
  expect(await readFile(path.join(cfg.root, saved.id, "files/0.bin"), "utf8")).toBe("verified facts\r\n")
  const before = await lstat(saved.path)
  expect(await saveCandidate(cfg)).toEqual(saved)
  expect((await lstat(saved.path)).mtimeMs).toBe(before.mtimeMs)
  expect(await readCandidate(cfg.root, saved.id, cfg.scope, cfg.bounds.archiveBytes)).toEqual(saved)
})

test("explicit recovery fills only missing blobs and never overwrites preserved files", async () => {
  const cfg = await fixture(),
    saved = await saveCandidate(cfg)
  const preserved = path.join(cfg.root, saved.id, "files/0.bin"),
    before = await lstat(preserved)
  await rename(saved.path, path.join(path.dirname(cfg.root), "interrupted-record.json"))
  await rename(
    path.join(cfg.root, saved.id, "feedback.bin"),
    path.join(path.dirname(cfg.root), "interrupted-feedback.bin"),
  )
  await expect(saveCandidate(cfg)).rejects.toThrow("explicit recovery")
  const recovered = await saveCandidate({ ...cfg, recover: true })
  expect(recovered).toEqual(saved)
  expect((await lstat(preserved)).ino).toBe(before.ino)
  expect((await lstat(preserved)).mtimeMs).toBe(before.mtimeMs)
})

test("source and existing archive drift block recovery rather than rewrite evidence", async () => {
  const cfg = await fixture(),
    saved = await saveCandidate(cfg)
  await writeFileAtomic(path.join(cfg.root, saved.id, "files/0.bin"), "tampered facts\r\n")
  await expect(readCandidate(cfg.root, saved.id, cfg.scope, cfg.bounds.archiveBytes)).rejects.toThrow("drift")
  await expect(saveCandidate({ ...cfg, recover: true })).rejects.toThrow("drift")
  await writeFileAtomic(path.join(cfg.candidateRoot, "report.md"), "source changed")
  await expect(saveCandidate(cfg)).rejects.toThrow("drift")
})

test("storage and candidate caps fail before writing a new archive intent", async () => {
  const cfg = await fixture()
  cfg.bounds.candidateBytes = 1
  await expect(saveCandidate(cfg)).rejects.toThrow("capacity")
  cfg.bounds.candidateBytes = 10000
  cfg.bounds.archiveBytes = 1000
  await expect(saveCandidate(cfg)).rejects.toThrow()
  expect((await readdir(cfg.root)).some((name) => name.endsWith(".intent.json"))).toBe(false)
  expect(await directoryBytes(cfg.root)).toBeLessThanOrEqual(cfg.bounds.archiveBytes)
})

test("other protocol, linked sources and concurrent archive writers cannot be accepted", async () => {
  const cfg = await fixture(),
    saved = await saveCandidate(cfg)
  await expect(
    readCandidate(cfg.root, saved.id, { ...cfg.scope, protocol: sha("other") }, cfg.bounds.archiveBytes),
  ).rejects.toThrow("identity")
  let release!: () => void
  const held = withFileTransaction(
    cfg.root,
    "archive",
    async () =>
      new Promise<void>((resolve) => {
        release = resolve
      }),
  )
  while (!release) await Bun.sleep(5)
  try {
    await expect(saveCandidate(cfg)).rejects.toThrow("writer active")
  } finally {
    release()
    await held
  }
  await link(path.join(cfg.candidateRoot, "report.md"), path.join(cfg.candidateRoot, "alias.md"))
  await expect(saveCandidate(cfg)).rejects.toThrow("Linked")
})

test("initial unassessed snapshot has no fabricated feedback or score", async () => {
  const cfg = await fixture()
  cfg.round = cfg.pass = 0
  cfg.closure = cfg.feedback = null
  const saved = await saveCandidate(cfg)
  expect(saved.record.feedback).toBeNull()
  expect(saved.record.metric).toBeUndefined()
  expect((await readdir(path.dirname(saved.path))).sort()).toEqual(["files", "record.json"])
  cfg.metric = 0
  await expect(saveCandidate(cfg)).rejects.toThrow("identity")
})

test("archive capacity includes the initialized mutex and all candidate records", async () => {
  const cfg = await fixture(),
    saved = await saveCandidate(cfg)
  const size = (await lstat(path.join(cfg.root, "archive.mutex.sqlite"))).size
  expect(size).toBeGreaterThan(0)
  cfg.round = 2
  cfg.closure = sha("closed-round-2")
  cfg.bounds.archiveBytes = size + (await lstat(saved.path)).size
  await expect(saveCandidate(cfg)).rejects.toThrow("storage capacity")
  expect((await readdir(cfg.root)).filter((name) => name.endsWith(".intent.json"))).toHaveLength(1)
})

async function interrupt(cfg: ArchiveInput, stage: string) {
  const file = path.join(path.dirname(cfg.root), "child-input.json")
  await writeJsonAtomic(file, cfg)
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "fixtures/archive-interruption.ts"), file, stage],
    { stdout: "pipe", stderr: "pipe" },
  )
  const reader = child.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      (async () => {
        let output = ""
        for (;;) {
          const block = await reader.read()
          if (block.done) throw new Error("Archive fixture exited before checkpoint")
          output += new TextDecoder().decode(block.value)
          if (output.includes("archive-checkpoint")) return
        }
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Archive checkpoint timeout")), 10000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    // 只终止本测试创建并持有句柄的单个子进程。
    child.kill()
    await child.exited
    reader.releaseLock()
  }
}

test("hard interruption after intent, a blob or completion recovers without new work", async () => {
  for (const stage of ["event", "intent", "0.bin", "record.json"]) {
    const cfg = await fixture()
    await interrupt(cfg, stage)
    if (stage !== "record.json") await expect(saveCandidate(cfg)).rejects.toThrow("explicit recovery")
    const saved = await saveCandidate({ ...cfg, recover: true })
    expect(saved.record.round).toBe(1)
    expect(saved.record.feedback!.status).toBe("rejected")
  }
}, 45000)

test("recovery interrupted again retains the same candidate and existing blob identity", async () => {
  const cfg = await fixture()
  await interrupt(cfg, "intent")
  cfg.recover = true
  await interrupt(cfg, "0.bin")
  const intent = (await readdir(cfg.root)).find((name) => name.endsWith(".intent.json"))!
  const id = intent.slice(0, -".intent.json".length),
    file = path.join(cfg.root, id, "files/0.bin")
  const before = await lstat(file)
  const saved = await saveCandidate(cfg)
  expect(saved.id).toBe(id)
  expect((await lstat(file)).ino).toBe(before.ino)
  expect((await lstat(file)).mtimeMs).toBe(before.mtimeMs)
}, 30000)

test("recovery cannot fork a closed event by changing source bytes and their declared hashes", async () => {
  const cfg = await fixture()
  await interrupt(cfg, "intent")
  const before = (await readdir(cfg.root)).sort()
  const text = "new and different content"
  await writeFileAtomic(path.join(cfg.candidateRoot, "report.md"), text)
  cfg.entries[0] = { ...cfg.entries[0], bytes: Buffer.byteLength(text), sha256: sha(text) }
  await expect(saveCandidate({ ...cfg, recover: true })).rejects.toThrow("event input drift")
  expect((await readdir(cfg.root)).sort()).toEqual(before)
}, 15000)

test("dangling mutex links are rejected before creating an external target", async () => {
  const cfg = await fixture()
  await mkdir(cfg.root)
  const external = path.join(path.dirname(cfg.root), "must-not-be-created.sqlite")
  await symlink(external, path.join(cfg.root, "archive.mutex.sqlite"), "file")
  let invoked = false
  await expect(
    withFileTransaction(cfg.root, "archive", async () => {
      invoked = true
    }),
  ).rejects.toThrow("Linked")
  expect(invoked).toBe(false)
  await expect(lstat(external)).rejects.toThrow()
})

test("archive reads verify the stable event mapping rather than only the content hash", async () => {
  const cfg = await fixture(),
    saved = await saveCandidate(cfg)
  const file = path.join(cfg.root, (await readdir(cfg.root)).find((name) => name.endsWith(".event.json"))!)
  const event = JSON.parse(await readFile(file, "utf8"))
  await writeJsonAtomic(file, { ...event, candidate: sha("different-candidate") })
  await expect(readCandidate(cfg.root, saved.id, cfg.scope, cfg.bounds.archiveBytes)).rejects.toThrow("event identity")
})

test("entry and feedback metadata project to the same write and read contract", async () => {
  const cfg = await fixture()
  const entry = { ...cfg.entries[0], note: "not part of frozen entry" }
  const feedback = { ...cfg.feedback!, note: "not part of frozen feedback" }
  cfg.entries = [entry]
  cfg.feedback = feedback
  const first = await saveCandidate(cfg)
  expect(first.record.files[0]).not.toHaveProperty("note")
  expect(first.record.feedback).not.toHaveProperty("note")
  expect(await saveCandidate(cfg)).toEqual(first)
  expect(await saveCandidate({ ...cfg, recover: true })).toEqual(first)
  expect(await readCandidate(cfg.root, first.id, cfg.scope, cfg.bounds.archiveBytes)).toEqual(first)
})

test("parent lineage must refer to an existing earlier snapshot in the same scope", async () => {
  const cfg = await fixture()
  const initial = await saveCandidate({ ...cfg, round: 0, pass: 0, closure: null, feedback: null })
  cfg.parent = initial.id
  const child = await saveCandidate(cfg)
  expect(child.record.parent).toBe(initial.id)
  const later = { ...cfg, round: 2, closure: sha("closed-round-2"), parent: sha("missing-parent") }
  await expect(saveCandidate(later)).rejects.toThrow()
  later.parent = child.id
  const saved = await saveCandidate(later)
  await expect(saveCandidate({ ...cfg, parent: saved.id })).rejects.toThrow("precede")
})
