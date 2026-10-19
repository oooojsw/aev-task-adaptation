import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rename, readFile, lstat, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { storeVersion } from "./version-store"
import { fingerprint } from "../protocol-plugins/identity"
import { writeFileAtomic } from "../atomic-write"
import type { Version } from "./selection"
import { interrupt } from "./exploration/composition.test"
import { recoverMaterialization } from "./exploration/materialize"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aev-formal-version-"))
  const content = [Buffer.from("accepted skill\r\n"), Buffer.from("preserved facts")]
  const record: Version = {
    schema: "aev.task-version.v1",
    plan: fingerprint("plan"),
    receipt: fingerprint("receipt"),
    feedback: path.join(root, "feedback.json"),
    round: 1,
    metric: null,
    files: content.map((bytes, index) => ({
      id: `file-${index}`,
      entry: `entry-${index}.md`,
      file: `files/${index}.bin`,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  }
  return { root, record, content, cap: 1000000, recover: false }
}

test("recoverable formal storage reuses a completed immutable snapshot", async () => {
  const input = await fixture(),
    file = await storeVersion(input),
    before = await lstat(file)
  expect(await storeVersion(input)).toBe(file)
  expect((await lstat(file)).mtimeMs).toBe(before.mtimeMs)
  expect(await readFile(path.join(path.dirname(file), "files/0.bin"), "utf8")).toBe("accepted skill\r\n")
})

test("incomplete formal snapshots only recover explicitly without rewriting existing bytes", async () => {
  const input = await fixture(),
    file = await storeVersion(input)
  await rename(file, `${file}.interrupted`)
  const first = path.join(path.dirname(file), "files/0.bin"),
    before = await lstat(first)
  await rename(path.join(path.dirname(file), "files/1.bin"), path.join(input.root, "second.saved"))
  await expect(storeVersion(input)).rejects.toThrow("explicit recovery")
  expect(await storeVersion({ ...input, recover: true })).toBe(file)
  expect((await lstat(first)).ino).toBe(before.ino)
  expect((await lstat(first)).mtimeMs).toBe(before.mtimeMs)
})

test("changed version receipt bindings and bytes fail rather than overwrite the snapshot", async () => {
  const input = await fixture(),
    file = await storeVersion(input)
  await expect(storeVersion({ ...input, record: { ...input.record, round: 2 } })).rejects.toThrow("identity drift")
  await writeFileAtomic(path.join(path.dirname(file), "files/0.bin"), "corrupted")
  await expect(storeVersion({ ...input, recover: true })).rejects.toThrow("content drift")
})

test("old half-written directories without intent cannot be silently imported", async () => {
  const input = await fixture()
  await mkdir(path.join(input.root, "task-adaptation/versions", input.record.receipt), { recursive: true })
  await expect(storeVersion({ ...input, recover: true })).rejects.toThrow("Unclaimed version")
})

test("formal snapshot hard kill and recovery hard kill reuse the original accepted bytes", async () => {
  const input = await fixture(),
    file = path.join(input.root, "interrupt.json")
  await interrupt(input, file, "version")
  await expect(storeVersion(input)).rejects.toThrow("explicit recovery")
  await interrupt({ ...input, recover: true }, file, "version")
  const first = path.join(input.root, "task-adaptation/versions", input.record.receipt, "files/0.bin")
  expect(await recoverMaterialization(path.join(input.root, "task-adaptation"), first, input.record.files[0])).toEqual(input.content[0])
  const before = await lstat(first)
  await storeVersion({ ...input, recover: true })
  expect((await lstat(first)).ino).toBe(before.ino)
  expect((await lstat(first)).mtimeMs).toBe(before.mtimeMs)
  expect(await readFile(first, "utf8")).toBe("accepted skill\r\n")
}, 30000)
