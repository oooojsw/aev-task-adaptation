import { expect, test } from "bun:test"
import { mkdir, readFile, writeFile, access, symlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { copyCandidate, readCandidate, hasCandidate, type SkillBinding } from "./candidate"

async function fixture() {
  const root = path.join("E:/project/AEV-protocol-plugins-20261011/test-evidence", randomUUID())
  const source = path.join(root, "source")
  await mkdir(path.join(source, "nested"), { recursive: true })
  await writeFile(path.join(source, "rules.txt"), "Rules")
  await writeFile(path.join(source, "nested", "helper.py"), "print('public helper')")
  await writeFile(path.join(source, "private.json"), "Not a declared Skill entry")
  const skill: SkillBinding = { format: "package", entries: [{ id: "rules", kind: "text", path: "rules.txt" },
    { id: "helper", kind: "text", path: "nested/helper.py" }] }
  return { root, source, target: path.join(root, "target"), skill }
}

test("candidate copies arbitrary declared files and omits unrelated private/internal files", async () => {
  const f = await fixture()
  const before = await readCandidate(f.source, f.skill)
  expect(await copyCandidate(f.source, f.target, f.skill)).toBe(before.fingerprint)
  expect(await readFile(path.join(f.target, "rules.txt"), "utf8")).toBe("Rules")
  expect(await hasCandidate(f.target, f.skill)).toBe(true)
  await expect(access(path.join(f.target, "private.json"))).rejects.toThrow()
})

test("missing declared entry does not create partial destination", async () => {
  const f = await fixture()
  f.skill.entries.push({ id: "missing", kind: "text", path: "missing.txt" })
  expect(await hasCandidate(f.source, f.skill)).toBe(false)
  await expect(copyCandidate(f.source, f.target, f.skill)).rejects.toThrow()
  await expect(access(f.target)).rejects.toThrow()
})

test("empty and escaping entries fail closed, not treated as usable Skill", async () => {
  const f = await fixture()
  await writeFile(path.join(f.source, "rules.txt"), "")
  await expect(hasCandidate(f.source, f.skill)).rejects.toThrow("Empty")
  f.skill.entries[0].path = "../private.txt"
  await expect(readCandidate(f.source, f.skill)).rejects.toThrow("Invalid")
})

test("target directory junction cannot redirect copy outside candidate root", async () => {
  const f = await fixture()
  await mkdir(f.target)
  await mkdir(path.join(f.root, "outside"))
  await symlink(path.join(f.root, "outside"), path.join(f.target, "nested"), "junction")
  await expect(copyCandidate(f.source, f.target, f.skill)).rejects.toThrow("escape")
  await expect(access(path.join(f.target, "rules.txt"))).rejects.toThrow()
  await expect(access(path.join(f.root, "outside", "helper.py"))).rejects.toThrow()
})
