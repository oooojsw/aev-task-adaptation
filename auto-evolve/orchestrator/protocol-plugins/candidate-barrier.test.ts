import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { synchronizeProtocolLeadCandidate } from "../long-task-campaign/runner"
import { copyCandidate, readCandidate } from "./candidate"

const skill = { format: "text" as const, entries: [
  { id: "a", kind: "text", path: "a.txt" }, { id: "b", kind: "text", path: "nested/b.txt" },
] }
async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const currentRoot = path.join(root, "current")
  const draftRoot = path.join(root, "draft")
  await mkdir(path.join(currentRoot, "nested"), { recursive: true })
  await writeFile(path.join(currentRoot, "a.txt"), "original A")
  await writeFile(path.join(currentRoot, "nested/b.txt"), "original B")
  await copyCandidate(currentRoot, draftRoot, skill)
  return { root, currentRoot, draftRoot, skill, enabled: true }
}

test("barrier preserves executor A and partial Lead B through promotion and next pass", async () => {
  const input = await fixture()
  await writeFile(path.join(input.currentRoot, "a.txt"), "executor A")
  await synchronizeProtocolLeadCandidate(input)
  expect((await readCandidate(input.draftRoot, skill)).fingerprint).toBe((await readCandidate(input.currentRoot, skill)).fingerprint)
  await writeFile(path.join(input.draftRoot, "nested/b.txt"), "Lead B")
  await copyCandidate(input.draftRoot, input.currentRoot, skill)
  await synchronizeProtocolLeadCandidate(input)
  expect(await readFile(path.join(input.draftRoot, "a.txt"), "utf8")).toBe("executor A")
  expect(await readFile(path.join(input.draftRoot, "nested/b.txt"), "utf8")).toBe("Lead B")
})

test("barrier leaves newly harvested tree and routing drafts byte-identical", async () => {
  const input = await fixture()
  const tree = path.join(input.draftRoot, "exploration-tree.json")
  const routing = path.join(input.draftRoot, "routing-control.json")
  await writeFile(tree, '{"newFinding":"this-round"}')
  await writeFile(routing, '{"requiredNextRegions":["new-region"]}')
  const before = [await readFile(tree), await readFile(routing)]
  await synchronizeProtocolLeadCandidate(input)
  await synchronizeProtocolLeadCandidate(input)
  expect(await readFile(tree)).toEqual(before[0])
  expect(await readFile(routing)).toEqual(before[1])
})

test("missing current cannot silently reuse a complete stale draft", async () => {
  const input = await fixture()
  await expect(synchronizeProtocolLeadCandidate({ ...input, currentRoot: path.join(input.root, "missing") }))
    .rejects.toThrow("stale Lead draft reuse blocked")
  expect(await readFile(path.join(input.draftRoot, "a.txt"), "utf8")).toBe("original A")
})

test("fresh empty candidate remains allowed for initial Lead creation", async () => {
  const input = await fixture()
  await synchronizeProtocolLeadCandidate({ ...input, currentRoot: path.join(input.root, "fresh-current"),
    draftRoot: path.join(input.root, "fresh-draft") })
  await expect(readFile(path.join(input.root, "fresh-draft/a.txt"))).rejects.toThrow()
})

test("legacy branch is a no-op even with different current and draft", async () => {
  const input = await fixture()
  await writeFile(path.join(input.currentRoot, "a.txt"), "new A")
  const before = (await readCandidate(input.draftRoot, skill)).fingerprint
  await synchronizeProtocolLeadCandidate({ ...input, enabled: false, skill: undefined })
  expect((await readCandidate(input.draftRoot, skill)).fingerprint).toBe(before)
})

test("enabled branch requires declared Skill entries before touching files", async () => {
  const input = await fixture()
  await expect(synchronizeProtocolLeadCandidate({ ...input, skill: undefined })).rejects.toThrow("declared Skill binding")
  expect(await readFile(path.join(input.draftRoot, "a.txt"), "utf8")).toBe("original A")
})
